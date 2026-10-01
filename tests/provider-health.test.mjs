/**
 * Provider credential health (`extensions/aies-providers`).
 *
 * Everything here is offline, deterministic and profile-free: classification is
 * pure, the store writes only into a temp agent dir, and the `turn_end` wiring
 * is driven with a fake `pi`/`ctx`. No request, no model call and no network is
 * ever involved, and the real or ambient profile is never touched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  FINGERPRINT_LENGTH,
  classifyCredentialRejection,
  credentialFingerprint,
  parseProviderHealth,
  recordApplies,
  rejectionLabel,
} from "../extensions/aies-providers/health.ts";
import {
  AIES_CONFIG_FILE,
  PROVIDER_HEALTH_KEY,
  readProviderHealth,
  recordRejection,
  writeProviderHealth,
} from "../extensions/aies-providers/store.ts";
import aiesProviders from "../extensions/aies-providers/index.ts";

/** The exact Anthropic 401 payload captured from a real failed turn. */
const ANTHROPIC_401 =
  '401 {"type":"error","error":{"type":"authentication_error","message":"API key is invalid."},"request_id":null}';

/** A short, obviously fake secret used to build fingerprints in tests. */
const SECRET = "sk-ant-super-secret-value";

const tempDirs = [];

function makeAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "aies-provider-health-"));
  tempDirs.push(dir);
  return dir;
}

function recordFor(secret = SECRET, overrides = {}) {
  return {
    provider: "anthropic",
    fingerprint: credentialFingerprint(secret),
    status: 401,
    reason: "authentication_error",
    observedAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function withAgentDir(dir, fn) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("classifyCredentialRejection", () => {
  it("classifies the exact real Anthropic 401 payload", () => {
    const result = classifyCredentialRejection({ stopReason: "error", errorMessage: ANTHROPIC_401 });
    assert.ok(result, "the real 401 payload must classify");
    assert.equal(result.status, 401);
    assert.equal(result.reason, "authentication_error");
  });

  it("classifies the AccessDenied.Unpurchased 403", () => {
    const result = classifyCredentialRejection({
      stopReason: "error",
      errorMessage: '403 {"error":{"code":"AccessDenied.Unpurchased"}}',
    });
    assert.ok(result, "403 AccessDenied must classify");
    assert.equal(result.status, 403);
    assert.equal(result.reason, "accessdenied");
  });

  it("classifies OpenAI-style invalid credentials", () => {
    const invalidKey = classifyCredentialRejection({
      stopReason: "error",
      errorMessage: '401 {"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}',
    });
    assert.ok(invalidKey);
    assert.equal(invalidKey.reason, "invalid_api_key");

    const incorrect = classifyCredentialRejection({
      stopReason: "error",
      errorMessage: "Incorrect API key provided",
    });
    assert.ok(incorrect);
    assert.equal(incorrect.reason, "incorrect api key");
    assert.equal(incorrect.status, undefined);
  });

  it("never classifies rate limits", () => {
    assert.equal(
      classifyCredentialRejection({
        stopReason: "error",
        errorMessage: '429 {"error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
      }),
      undefined,
    );
  });

  it("never classifies server errors", () => {
    assert.equal(
      classifyCredentialRejection({ stopReason: "error", errorMessage: '500 {"error":{"type":"overloaded_error"}}' }),
      undefined,
    );
    assert.equal(
      classifyCredentialRejection({ stopReason: "error", errorMessage: '503 {"error":{"type":"overloaded_error"}}' }),
      undefined,
    );
  });

  it("never classifies network or abort failures", () => {
    for (const message of ["fetch failed", "ECONNREFUSED 127.0.0.1:443", "timeout", "aborted", "socket hang up"]) {
      assert.equal(
        classifyCredentialRejection({ stopReason: "error", errorMessage: message }),
        undefined,
        `${message} must not classify as a credential rejection`,
      );
    }
  });

  it("requires stopReason to be exactly \"error\"", () => {
    assert.equal(
      classifyCredentialRejection({ stopReason: "stop", errorMessage: ANTHROPIC_401 }),
      undefined,
    );
  });

  it("requires a non-empty string errorMessage", () => {
    for (const errorMessage of [undefined, null, 42, "", "   "]) {
      assert.equal(
        classifyCredentialRejection({ stopReason: "error", errorMessage }),
        undefined,
        `${String(errorMessage)} must not classify`,
      );
    }
  });

  it("bounds the reason to at most 48 characters", () => {
    const result = classifyCredentialRejection({
      stopReason: "error",
      errorMessage: `403 ${"x".repeat(500)} forbidden`,
    });
    assert.ok(result);
    assert.ok(result.reason.length <= 48, `reason too long: ${result.reason.length}`);
    assert.ok(!result.reason.includes("x".repeat(60)), "reason must never echo the raw body");
  });
});

describe("credentialFingerprint", () => {
  it("is stable, truncated lowercase hex", () => {
    const digest = credentialFingerprint(SECRET);
    assert.equal(digest, credentialFingerprint(SECRET), "must be stable across calls");
    assert.equal(digest.length, FINGERPRINT_LENGTH);
    assert.match(digest, /^[0-9a-f]{16}$/);
  });

  it("differs for different secrets", () => {
    assert.notEqual(credentialFingerprint("one"), credentialFingerprint("two"));
  });

  it("is undefined for anything that is not a usable secret", () => {
    for (const value of [undefined, null, "", "   ", 42, {}, []]) {
      assert.equal(credentialFingerprint(value), undefined, `${String(value)} must have no fingerprint`);
    }
  });

  it("never equals nor contains the secret", () => {
    const digest = credentialFingerprint(SECRET);
    assert.notEqual(digest, SECRET);
    assert.ok(!digest.includes(SECRET));
  });
});

describe("recordApplies", () => {
  it("applies only to a matching fingerprint on a well-formed record", () => {
    const record = recordFor();
    assert.equal(recordApplies(record, record.fingerprint), true);
    assert.equal(recordApplies(record, credentialFingerprint("a-different-secret")), false);
  });

  it("fails open when the current fingerprint is unknown", () => {
    const record = recordFor();
    assert.equal(recordApplies(record, undefined), false);
    assert.equal(recordApplies(record, ""), false);
  });

  it("rejects a missing or malformed record", () => {
    assert.equal(recordApplies(undefined, credentialFingerprint(SECRET)), false);
    assert.equal(recordApplies({}, credentialFingerprint(SECRET)), false);
    assert.equal(recordApplies({ fingerprint: 42 }, credentialFingerprint(SECRET)), false);
  });
});

describe("rejectionLabel", () => {
  it("renders status and reason as a bounded Spanish label", () => {
    const label = rejectionLabel(recordFor());
    assert.ok(label.includes("401"));
    assert.ok(label.includes("authentication_error"));
    assert.ok(label.length <= 96, `label too long: ${label.length}`);
    assert.match(label, /^credencial rechazada/);
  });

  it("never contains the fingerprint or the secret", () => {
    const record = recordFor(SECRET);
    const label = rejectionLabel(record);
    assert.ok(!label.includes(record.fingerprint));
    assert.ok(!label.includes(SECRET));
  });

  it("does not duplicate a status already carried by the reason", () => {
    const label = rejectionLabel(recordFor(SECRET, { status: 401, reason: "HTTP 401" }));
    assert.equal(label, "credencial rechazada · HTTP 401");
  });

  it("renders a reason-only record", () => {
    const label = rejectionLabel(recordFor(SECRET, { status: undefined, reason: "accessdenied" }));
    assert.equal(label, "credencial rechazada · accessdenied");
  });
});

describe("parseProviderHealth", () => {
  it("rejects non-object inputs", () => {
    for (const value of [null, undefined, 42, "nope", true, []]) {
      assert.deepEqual(parseProviderHealth(value), {});
    }
  });

  it("keeps only well-formed entries, keyed by provider", () => {
    const good = recordFor();
    const parsed = parseProviderHealth({
      slot: good,
      "missing-observedAt": {
        provider: "missing",
        fingerprint: "0123456789abcdef",
        reason: "authentication_error",
      },
      "non-finite-observedAt": {
        provider: "infinite",
        fingerprint: "0123456789abcdef",
        reason: "authentication_error",
        observedAt: Number.POSITIVE_INFINITY,
      },
      "empty-reason": {
        provider: "empty",
        fingerprint: "0123456789abcdef",
        reason: "",
        observedAt: 1,
      },
      "not-an-object": "nope",
    });

    assert.deepEqual(Object.keys(parsed), ["anthropic"]);
    assert.deepEqual(parsed.anthropic, good);
  });

  it("drops a present but non-finite status", () => {
    const parsed = parseProviderHealth({
      bad: {
        provider: "bad",
        fingerprint: "0123456789abcdef",
        reason: "authentication_error",
        observedAt: 1,
        status: Number.NaN,
      },
    });
    assert.deepEqual(parsed, {});
  });
});

describe("provider health store", () => {
  it("round-trips a rejection record through recordRejection", () => {
    const dir = makeAgentDir();
    const record = recordFor();
    assert.deepEqual(recordRejection(dir, record), { ok: true });
    assert.deepEqual(readProviderHealth(dir), { anthropic: record });
  });

  it("preserves unrelated top-level keys", () => {
    const dir = makeAgentDir();
    writeFileSync(
      join(dir, AIES_CONFIG_FILE),
      JSON.stringify({ agents: { worker: { model: "x" } } }),
      "utf8",
    );

    const record = recordFor();
    assert.deepEqual(writeProviderHealth(dir, { anthropic: record }), { ok: true });

    const raw = JSON.parse(readFileSync(join(dir, AIES_CONFIG_FILE), "utf8"));
    assert.deepEqual(raw.agents, { worker: { model: "x" } });
    assert.deepEqual(raw[PROVIDER_HEALTH_KEY], { anthropic: record });
  });

  it("refuses to overwrite a malformed config and leaves the bytes untouched", () => {
    const dir = makeAgentDir();
    const path = join(dir, AIES_CONFIG_FILE);
    writeFileSync(path, "{ not json", "utf8");
    const before = readFileSync(path);

    assert.deepEqual(readProviderHealth(dir), {});
    const result = writeProviderHealth(dir, { anthropic: recordFor() });
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, "string");
    assert.deepEqual(readFileSync(path), before, "a malformed file must not be modified");
  });

  it("fails closed when the agent dir is absent", () => {
    assert.deepEqual(readProviderHealth(undefined), {});
    assert.equal(writeProviderHealth(undefined, { anthropic: recordFor() }).ok, false);
    assert.equal(recordRejection(undefined, recordFor()).ok, false);
  });

  it("persists the file as 0o600", () => {
    const dir = makeAgentDir();
    recordRejection(dir, recordFor());
    const mode = statSync(join(dir, AIES_CONFIG_FILE)).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("never persists the raw secret, only the digest", () => {
    const dir = makeAgentDir();
    recordRejection(dir, recordFor());

    const contents = readFileSync(join(dir, AIES_CONFIG_FILE), "utf8");
    const digest = credentialFingerprint(SECRET);
    assert.ok(!contents.includes(SECRET), "the raw secret must never be written");
    assert.ok(contents.includes(digest), "the truncated digest must be present");
    assert.equal(digest.length, FINGERPRINT_LENGTH);
  });
});

describe("aies-providers turn_end wiring", () => {
  function fakePi() {
    const handlers = [];
    return {
      handlers,
      on(event, handler) {
        handlers.push({ event, handler });
      },
    };
  }

  function fakeCtx({ secret = SECRET, reject = false, notifyThrows = false, provider = "anthropic" } = {}) {
    const notifications = [];
    return {
      notifications,
      model: { provider },
      modelRegistry: {
        async getApiKeyForProvider() {
          if (reject) throw new Error("registry unavailable");
          return secret;
        },
      },
      ui: {
        notify(message, type) {
          if (notifyThrows) throw new Error("ui unavailable");
          notifications.push({ message, type });
        },
      },
    };
  }

  function turnEnd(overrides = {}) {
    return {
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        stopReason: "error",
        errorMessage: ANTHROPIC_401,
        ...overrides,
      },
    };
  }

  function handler() {
    const pi = fakePi();
    aiesProviders(pi);
    return pi;
  }

  it("registers exactly one handler and it is turn_end", () => {
    const pi = handler();
    assert.equal(pi.handlers.length, 1);
    assert.equal(pi.handlers[0].event, "turn_end");
  });

  it("records nothing and notifies nothing on a successful turn", async () => {
    const dir = makeAgentDir();
    const ctx = fakeCtx();
    await withAgentDir(dir, async () => {
      await handler().handlers[0].handler(turnEnd({ stopReason: "stop", errorMessage: "" }), ctx);
    });
    assert.deepEqual(readProviderHealth(dir), {});
    assert.equal(ctx.notifications.length, 0);
  });

  it("records one entry and warns once on a 401 turn", async () => {
    const dir = makeAgentDir();
    const ctx = fakeCtx();
    await withAgentDir(dir, async () => {
      await handler().handlers[0].handler(turnEnd(), ctx);
    });

    const health = readProviderHealth(dir);
    assert.deepEqual(Object.keys(health), ["anthropic"]);
    assert.equal(health.anthropic.status, 401);
    assert.equal(health.anthropic.reason, "authentication_error");
    assert.equal(health.anthropic.fingerprint, credentialFingerprint(SECRET));

    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0].type, "warning");
    assert.ok(ctx.notifications[0].message.includes("anthropic"));
    assert.ok(ctx.notifications[0].message.includes("authentication_error"));
    assert.ok(ctx.notifications[0].message.includes("/aies-models"));
  });

  it("does not spam a second identical 401 turn", async () => {
    const dir = makeAgentDir();
    await withAgentDir(dir, async () => {
      const pi = handler();
      await pi.handlers[0].handler(turnEnd(), fakeCtx());
      const second = fakeCtx();
      await pi.handlers[0].handler(turnEnd(), second);
      assert.equal(second.notifications.length, 0, "a repeated identical rejection must stay silent");
    });
    assert.equal(Object.keys(readProviderHealth(dir)).length, 1);
  });

  it("updates the record and warns again when the credential changes", async () => {
    const dir = makeAgentDir();
    await withAgentDir(dir, async () => {
      const pi = handler();
      await pi.handlers[0].handler(turnEnd(), fakeCtx({ secret: "first-credential" }));
      const second = fakeCtx({ secret: "second-credential" });
      await pi.handlers[0].handler(turnEnd(), second);
      assert.equal(second.notifications.length, 1);
      assert.equal(readProviderHealth(dir).anthropic.fingerprint, credentialFingerprint("second-credential"));
    });
  });

  it("records nothing when resolving the credential fails", async () => {
    const dir = makeAgentDir();
    const ctx = fakeCtx({ reject: true });
    await withAgentDir(dir, async () => {
      await assert.doesNotReject(() =>
        handler().handlers[0].handler(turnEnd(), ctx),
      );
    });
    assert.deepEqual(readProviderHealth(dir), {});
    assert.equal(ctx.notifications.length, 0);
  });

  it("writes nothing and stays silent when PI_CODING_AGENT_DIR is unset", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    delete process.env.PI_CODING_AGENT_DIR;
    try {
      const ctx = fakeCtx();
      await assert.doesNotReject(() => handler().handlers[0].handler(turnEnd(), ctx));
      assert.equal(ctx.notifications.length, 0);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });

  it("swallows a throwing ui.notify and still records", async () => {
    const dir = makeAgentDir();
    const ctx = fakeCtx({ notifyThrows: true });
    await withAgentDir(dir, async () => {
      await assert.doesNotReject(() => handler().handlers[0].handler(turnEnd(), ctx));
    });
    assert.equal(Object.keys(readProviderHealth(dir)).length, 1);
  });

  it("never leaks the secret or the fingerprint into the notification", async () => {
    const dir = makeAgentDir();
    const ctx = fakeCtx();
    await withAgentDir(dir, async () => {
      await handler().handlers[0].handler(turnEnd(), ctx);
    });

    const message = ctx.notifications[0].message;
    assert.ok(!message.includes(SECRET));
    assert.ok(!message.includes(credentialFingerprint(SECRET)));
    assert.ok(!message.includes("API key is invalid"), "must not echo the raw provider body");
  });
});
