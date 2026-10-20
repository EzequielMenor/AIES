/**
 * Recovery from a sandbox BLOCKED verdict (AIES-006, follow-up to verify-sandbox-gate).
 *
 * A Verify request refused because the OS sandbox was inactive ends BLOCKED and
 * records its cause. The cause decides what the next request may do:
 *
 * 1. A sandbox BLOCKED is not "conditions unchanged" once the sandbox is active
 *    again: the next request runs a normal Verify, and its PASS registers the revision.
 * 2. While the sandbox stays inactive, the repeated request is still refused without
 *    starting a child or a model call.
 * 3. No path makes an earlier PASS valid again: a sandbox BLOCKED never leaves a
 *    verified revision behind, and the Done Gate keeps denying until a new PASS.
 * 4. A BLOCKED without the sandbox cause (a Verify verdict, or a record from before
 *    the cause existed) keeps the "conditions unchanged" rule even with the sandbox active.
 * 5. Neither the block nor its release spends a verification attempt.
 * 6. A record without `blockedCause` loads and behaves as it did before the field.
 *
 * The sandbox state is an injected stub, so these tests hold on a nested sandbox too.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";
import { checkDoneGate } from "../extensions/aies-agents/linear/policy.ts";
import { VERIFY_COMPLETE_TOOL } from "../extensions/aies-agents/verify.ts";
import { createVerificationState, isVerificationValid } from "../extensions/aies-agents/verification.ts";

const CHANGED_PATHS = ["src/app.js"];
const VERIFY_REQUEST = {
  role: "verify",
  task: "Verify app",
  criteria: ["npm run check passes"],
  changedPaths: CHANGED_PATHS,
};

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "aies-verify-recovery-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

async function fauxRuntime() {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create();
  runtime.registerNativeProvider(faux.provider);
  return { faux, runtime, model: faux.models[0] };
}

function ctxFor(dir, model, runtime) {
  return { cwd: dir, model, modelRegistry: runtime };
}

function textOf(result) {
  return result.content.map((block) => block.text ?? "").join("\n");
}

function completion(id, verdict) {
  return fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, verdict, id)]);
}

/** A valid PASS completion for VERIFY_REQUEST. */
function passCompletion(id) {
  return completion(id, {
    status: "pass",
    summary: "Checked the repository state.",
    criteria: [{ index: 1, criterion: "npm run check passes", status: "pass", evidence: "exit 0" }],
    checks: [{ check: "npm run check", result: "passed" }],
    defects: [],
    next: [],
  });
}

/** A valid FAIL completion with one blocking defect. */
function failCompletion(id) {
  return completion(id, {
    status: "fail",
    summary: "The check still fails.",
    criteria: [{ index: 1, criterion: "npm run check passes", status: "fail", evidence: "exit 1" }],
    checks: [{ check: "npm run check", result: "exit 1" }],
    defects: [{ severity: "blocking", file: "src/app.js", description: "app exports 1", evidence: "src/app.js:1" }],
    next: [],
  });
}

/** A valid BLOCKED completion for a cause external to the change (not the sandbox). */
function blockedCompletion(id) {
  return completion(id, {
    status: "blocked",
    summary: "The check runner could not start: the package registry is unreachable from this host.",
    criteria: [{ index: 1, criterion: "npm run check passes", status: "blocked", evidence: "check did not start" }],
    checks: [{ check: "npm run check", result: "not run" }],
    defects: [],
    next: [],
  });
}

/** Runs `fn` with AIES_SANDBOX set to `value` (undefined = unset), then restores it. */
async function withSandboxEnv(value, fn) {
  const prev = process.env.AIES_SANDBOX;
  try {
    if (value === undefined) delete process.env.AIES_SANDBOX;
    else process.env.AIES_SANDBOX = value;
    return await fn();
  } finally {
    if (prev !== undefined) process.env.AIES_SANDBOX = prev;
    else delete process.env.AIES_SANDBOX;
  }
}

/** In-memory verification record, the same shape the extension owns. */
function stateStore(initial = createVerificationState()) {
  let current = initial;
  return {
    store: {
      get: () => current,
      set: (next) => {
        current = next;
      },
    },
    read: () => current,
  };
}

/** A Verify request through the delegation tool, with the sandbox stubbed. */
function verifyCall(tool, id, ctx) {
  return withSandboxEnv(undefined, () => tool.execute(id, VERIFY_REQUEST, undefined, undefined, ctx));
}

describe("A sandbox BLOCKED is recoverable once the sandbox is active again (AIES-006)", () => {
  it("runs a new Verify after the sandbox returns, and its PASS registers the revision", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([passCompletion("c1")]);
      const { store, read } = stateStore();
      let sandboxOn = false;
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => sandboxOn });
      const ctx = ctxFor(dir, model, runtime);

      const blocked = await verifyCall(tool, "call-1", ctx);
      assert.equal(blocked.details.error, "verify_sandbox_unavailable");
      assert.equal(read().status, "blocked");
      assert.equal(read().blockedCause, "sandbox_unavailable", "the block records its cause");
      assert.equal(faux.state.callCount, 0);

      sandboxOn = true;
      const retried = await verifyCall(tool, "call-2", ctx);

      assert.equal(retried.isError, undefined, "an active sandbox must let the retry run");
      assert.notEqual(retried.details.error, "verification_blocked_conditions_unchanged");
      assert.equal(retried.details.status, "pass");
      assert.ok(faux.state.callCount > 0, "the Verify child must start after the release");
      const after = read();
      assert.equal(after.status, "pass");
      assert.equal(after.verifiedRevision, after.revision, "the PASS registers the current revision");
      assert.equal(isVerificationValid(after), true);
      assert.equal(after.blockedCause, undefined, "a verdict replaces the block cause");
      assert.equal(retried.details.verification.valid, true);
      assert.equal(checkDoneGate(after, CHANGED_PATHS).allowed, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps refusing the repeated request, without a model call, while the sandbox stays inactive", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const { store, read } = stateStore();
      let sandboxOn = false;
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => sandboxOn });
      const ctx = ctxFor(dir, model, runtime);

      await verifyCall(tool, "call-1", ctx);
      const repeated = await verifyCall(tool, "call-2", ctx);

      assert.equal(repeated.isError, true);
      assert.equal(repeated.details.error, "verification_blocked_conditions_unchanged");
      assert.match(textOf(repeated), /Conditions have not changed/u);
      assert.equal(faux.state.callCount, 0, "no Verify child and no model call");
      assert.equal(read().status, "blocked");
      assert.equal(read().attempts, 0, "the refusal spends no attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never makes an earlier PASS of the same revision valid again across block, release and a FAIL", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const { store, read } = stateStore();
      let sandboxOn = true;
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => sandboxOn });
      const ctx = ctxFor(dir, model, runtime);

      faux.setResponses([passCompletion("c1")]);
      await verifyCall(tool, "call-1", ctx);
      assert.equal(isVerificationValid(read()), true, "precondition: a valid PASS at this revision");
      assert.equal(checkDoneGate(read(), CHANGED_PATHS).allowed, true);

      sandboxOn = false;
      const blocked = await verifyCall(tool, "call-2", ctx);
      assert.equal(blocked.details.error, "verify_sandbox_unavailable");
      assert.equal(isVerificationValid(read()), false, "the block invalidates the PASS");
      assert.notEqual(read().verifiedRevision, read().revision, "the block drops the verified revision");
      const deniedBlocked = checkDoneGate(read(), CHANGED_PATHS);
      assert.equal(deniedBlocked.allowed, false);
      assert.match(deniedBlocked.reason, /blocked/u);

      // Released guard: the next run is a real Verify, and it reports a FAIL.
      sandboxOn = true;
      faux.setResponses([failCompletion("c2")]);
      const failed = await verifyCall(tool, "call-3", ctx);
      assert.equal(failed.details.status, "fail", "the released request runs Verify and gets its own verdict");
      assert.equal(read().status, "fail");
      assert.equal(isVerificationValid(read()), false, "after the release, the old PASS stays invalid");
      const deniedFail = checkDoneGate(read(), CHANGED_PATHS);
      assert.equal(deniedFail.allowed, false);

      // Only a new PASS, from a real Verify run, allows the Done Gate again.
      faux.setResponses([passCompletion("c3")]);
      const passed = await verifyCall(tool, "call-4", ctx);
      assert.equal(passed.details.status, "pass");
      assert.equal(isVerificationValid(read()), true);
      assert.equal(checkDoneGate(read(), CHANGED_PATHS).allowed, true);
      assert.ok(faux.state.callCount > 0, "the new PASS came from real Verify runs");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the 'conditions unchanged' rule for a BLOCKED with another cause, even with the sandbox active", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([blockedCompletion("c1")]);
      const { store, read } = stateStore();
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => true });
      const ctx = ctxFor(dir, model, runtime);

      const first = await verifyCall(tool, "call-1", ctx);
      assert.equal(first.details.status, "blocked", "the Verify child reported BLOCKED");
      assert.equal(read().status, "blocked");
      assert.equal(read().blockedCause, undefined, "a Verify verdict carries no sandbox cause");
      const callsAfterFirst = faux.state.callCount;

      const repeated = await verifyCall(tool, "call-2", ctx);
      assert.equal(repeated.isError, true);
      assert.equal(repeated.details.error, "verification_blocked_conditions_unchanged");
      assert.equal(faux.state.callCount, callsAfterFirst, "the repeated request starts no child");
      assert.equal(read().attempts, 1, "the refusal spends no attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the 'conditions unchanged' rule for a BLOCKED record that has no cause at all", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const legacy = {
        ...createVerificationState(),
        status: "blocked",
        attempts: 1,
        awaitingVerification: true,
        blockedRevision: 0,
        blockedReason: "external registry outage",
      };
      const { store } = stateStore(legacy);
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => true });

      const result = await verifyCall(tool, "call-1", ctxFor(dir, model, runtime));

      assert.equal(result.isError, true);
      assert.equal(result.details.error, "verification_blocked_conditions_unchanged");
      assert.equal(faux.state.callCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("spends exactly one attempt for the run after the release, none for the block or the release", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([passCompletion("c1")]);
      const { store, read } = stateStore({ ...createVerificationState(), attempts: 2 });
      let sandboxOn = false;
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => sandboxOn });
      const ctx = ctxFor(dir, model, runtime);

      await verifyCall(tool, "call-1", ctx);
      assert.equal(read().attempts, 2, "the block spends no attempt");
      await verifyCall(tool, "call-2", ctx);
      assert.equal(read().attempts, 2, "the refused repeat spends no attempt");

      sandboxOn = true;
      const result = await verifyCall(tool, "call-3", ctx);
      assert.equal(result.details.status, "pass");
      assert.equal(read().attempts, 3, "only the Verify run that follows the release is counted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a record written without blockedCause and behaves as before the field existed", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      // A record serialized before `blockedCause` existed: JSON round-trip drops the undefined key.
      const persisted = JSON.stringify({
        ...createVerificationState(),
        status: "blocked",
        attempts: 1,
        revision: 0,
        blockedRevision: 0,
        blockedReason: "registry outage",
      });
      const loaded = JSON.parse(persisted);
      assert.equal("blockedCause" in loaded, false, "the old shape carries no cause");
      const { store, read } = stateStore(loaded);
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => true });

      const result = await verifyCall(tool, "call-1", ctxFor(dir, model, runtime));

      assert.equal(result.details.error, "verification_blocked_conditions_unchanged");
      assert.equal(faux.state.callCount, 0);
      assert.equal(read().status, "blocked");
      assert.deepEqual(result.details.verification, {
        status: "blocked",
        attempts: 1,
        repairs: 0,
        maxRepairs: 2,
        maxAttempts: 4,
        valid: false,
        awaitingVerification: false,
        decision: "stop",
        reason: "blocked for a cause external to the change; repair is not the answer",
        protocolError: undefined,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
