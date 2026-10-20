/**
 * Verify requires OS sandbox enforcement before its child starts (AIES-006).
 *
 * Without the sandbox, `executeSandboxedCommand` refuses every Verify bash command,
 * but a Verify child started anyway would still inspect with read/grep/find/ls and
 * could emit PASS from static reading alone. `aies_delegate` therefore refuses the
 * verify role before any child session, observation or model call exists:
 *
 * 1. With the sandbox disabled, a verify request ends BLOCKED for an infrastructure
 *    cause, in Spanish, and no Verify child is started.
 * 2. That block is not an attempt and never marks the revision verified; a repeated
 *    request with the cause unchanged is still rejected by the existing BLOCKED rule.
 * 3. With the sandbox active (a stub), Verify runs as before.
 * 4. The Worker still starts with the sandbox disabled (degraded, not blocked).
 *
 * The sandbox state is set through AIES_SANDBOX or an injected stub, never by
 * inspecting the host, so these tests hold on a nested sandbox too.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";
import { observatory } from "../extensions/aies-agents/observatory.ts";
import { isSandboxSupported } from "../extensions/aies-agents/sandbox.ts";
import { VERIFY_COMPLETE_TOOL } from "../extensions/aies-agents/verify.ts";
import { createVerificationState, isVerificationValid } from "../extensions/aies-agents/verification.ts";

const VERIFY_REQUEST = { role: "verify", task: "Verify app", criteria: ["npm run check passes"] };

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "aies-verify-sandbox-"));
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

/** A valid PASS completion for VERIFY_REQUEST, so a child that runs would pass. */
function passCompletion(id) {
  return fauxAssistantMessage([
    fauxToolCall(
      VERIFY_COMPLETE_TOOL,
      {
        status: "pass",
        summary: "Checked the repository state.",
        criteria: [{ index: 1, criterion: "npm run check passes", status: "pass", evidence: "exit 0" }],
        checks: [{ check: "npm run check", result: "passed" }],
        defects: [],
        next: [],
      },
      id,
    ),
  ]);
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

/** Verify observations currently open or closed in the shared observatory. */
function verifyRecords() {
  return observatory.snapshot().filter((record) => record.role === "verify");
}

describe("Verify requires OS sandbox enforcement before the child starts (AIES-006)", () => {
  it("returns BLOCKED for the sandbox cause and starts no Verify child when AIES_SANDBOX=0", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([passCompletion("c1")]);
      const { store } = stateStore();
      const tool = createDelegateTool({ verification: store });
      const recordsBefore = verifyRecords().length;

      const result = await withSandboxEnv("0", () =>
        tool.execute("call-1", VERIFY_REQUEST, undefined, undefined, ctxFor(dir, model, runtime)),
      );

      assert.equal(result.isError, true, "a sandbox block must be visible as an error");
      assert.equal(result.details.status, "blocked");
      assert.equal(result.details.error, "verify_sandbox_unavailable");
      const text = textOf(result);
      assert.match(text, /Verificación bloqueada por infraestructura/u);
      assert.match(text, /Verify exige sandbox del SO y no está activo/u);
      assert.match(text, /AIES_SANDBOX=0 lo desactiva/u);
      assert.match(text, /No se ha lanzado ningún agente Verify/u);

      assert.equal(faux.state.callCount, 0, "no model call: the Verify child never started");
      assert.equal(faux.getPendingResponseCount(), 1, "the scripted completion was never consumed");
      assert.equal(verifyRecords().length, recordsBefore, "no Verify observation was opened");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not spend a Verify attempt nor mark the revision verified", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const { store, read } = stateStore({ ...createVerificationState(), attempts: 2 });
      const tool = createDelegateTool({ verification: store });

      const result = await withSandboxEnv("0", () =>
        tool.execute("call-1", VERIFY_REQUEST, undefined, undefined, ctxFor(dir, model, runtime)),
      );

      const after = read();
      assert.equal(after.attempts, 2, "a sandbox block is not a verification attempt");
      assert.equal(after.verifiedRevision, undefined, "the revision must not be verified");
      assert.equal(after.status, "blocked");
      assert.equal(isVerificationValid(after), false);
      assert.match(after.blockedReason ?? "", /sandbox del SO/u);
      assert.equal(result.details.verification.valid, false);
      assert.equal(result.details.verification.attempts, 2);

      // The existing BLOCKED rule still governs a repeated request with the cause unchanged.
      const repeated = await withSandboxEnv("0", () =>
        tool.execute("call-2", VERIFY_REQUEST, undefined, undefined, ctxFor(dir, model, runtime)),
      );
      assert.equal(repeated.isError, true);
      assert.equal(repeated.details.error, "verification_blocked_conditions_unchanged");
      assert.match(textOf(repeated), /Conditions have not changed/u);
      assert.equal(faux.state.callCount, 0, "a repeated block still starts no child");
      assert.equal(read().attempts, 2, "a repeated block still spends no attempt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps Verify running when the sandbox is active (injected stub)", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([passCompletion("c1")]);
      const { store, read } = stateStore();
      const tool = createDelegateTool({ verification: store, isSandboxActive: () => true });

      const result = await withSandboxEnv(undefined, () =>
        tool.execute("call-1", VERIFY_REQUEST, undefined, undefined, ctxFor(dir, model, runtime)),
      );

      assert.equal(result.isError, undefined, "an active sandbox must not block Verify");
      assert.equal(result.details.status, "pass");
      assert.ok(faux.state.callCount > 0, "the Verify child must start");
      assert.equal(read().status, "pass");
      assert.equal(read().attempts, 1);
      assert.equal(read().verifiedRevision, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses the real sandbox detection by default when the host supports it", async (t) => {
    const supported = await withSandboxEnv(undefined, () => isSandboxSupported());
    if (!supported) {
      t.skip("host without OS sandbox support: the real detection path cannot run here");
      return;
    }
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([passCompletion("c1")]);
      const { store } = stateStore();
      const tool = createDelegateTool({ verification: store });

      const result = await withSandboxEnv(undefined, () =>
        tool.execute("call-1", VERIFY_REQUEST, undefined, undefined, ctxFor(dir, model, runtime)),
      );

      assert.equal(result.isError, undefined);
      assert.equal(result.details.status, "pass");
      assert.ok(faux.state.callCount > 0, "the Verify child must start with the sandbox active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still starts the Worker with the sandbox disabled (degraded, not blocked)", async () => {
    const dir = fixtureDir({ "sample.txt": "initial content\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([
        fauxAssistantMessage([
          {
            type: "text",
            text: `\`\`\`json
{"status":"done","summary":"Read the sample.","changes":[],"checks":[],"issues":[],"next":[]}
\`\`\``,
          },
        ]),
      ]);
      const tool = createDelegateTool();

      const result = await withSandboxEnv("0", async () => {
        assert.equal(isSandboxSupported(), false, "the sandbox must be disabled for this case");
        return tool.execute(
          "call-1",
          { role: "worker", task: "Read the sample" },
          undefined,
          undefined,
          ctxFor(dir, model, runtime),
        );
      });

      assert.ok(faux.state.callCount > 0, "the Worker child must start");
      assert.notEqual(result.details?.error, "verify_sandbox_unavailable");
      assert.notEqual(result.isError, true);
      assert.equal(result.details.status, "done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
