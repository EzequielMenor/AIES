/**
 * AIES-010C Agent Observatory wiring (T3): the real child execution seam.
 *
 * The pure registry is already covered by `agent-observatory.test.mjs`. This
 * suite proves the registry is fed from the real child path without touching the
 * registry API:
 *
 * 1. One event-driven `session.subscribe(...)` listener per child, fed only on
 *    `tool_execution_start` and sampled on `turn_end` / `agent_settled` /
 *    `agent_end`. No timers, no polling.
 * 2. The last sampled usage survives a session that stops answering or throws on
 *    dispose, and a throwing observer never fails the child run.
 * 3. `runExploreAgent` / `runWorkerAgent` / `runVerifyAgent` open and close
 *    exactly one record with real usage and a compact fact line.
 * 4. The registry stays empty when no observatory is supplied.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import * as delegateModule from "../extensions/aies-agents/delegate.ts";
import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import { resolveAgentThinkingLevel } from "../extensions/aies-agents/model.ts";
import { AgentObservatory, observatory } from "../extensions/aies-agents/observatory.ts";
import * as sessionModule from "../extensions/aies-agents/session.ts";
import { runVerifyAgent, VERIFY_COMPLETE_TOOL } from "../extensions/aies-agents/verify.ts";
import { runWorkerAgent } from "../extensions/aies-agents/worker.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

async function fauxRuntime() {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create();
  runtime.registerNativeProvider(faux.provider);
  return { faux, runtime, model: faux.models[0] };
}

/**
 * A fake AgentSession: it records its subscriptions, can stop answering its
 * stats, and exposes the raw listeners so a test can emit AgentSession events.
 */
function fakeSession(stats = { tokens: { total: 0 }, cost: 0 }) {
  const listeners = [];
  let subscriptions = 0;
  let unsubscribed = 0;
  let responsive = true;

  const session = {
    subscribe(listener) {
      subscriptions += 1;
      listeners.push(listener);
      return () => {
        unsubscribed += 1;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    getSessionStats() {
      if (!responsive) throw new Error("session no longer answers");
      return stats;
    },
  };

  return {
    session,
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    goSilent() {
      responsive = false;
    },
    get subscriptions() {
      return subscriptions;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

function exploreJson(overrides = {}) {
  return `\`\`\`json
${JSON.stringify(
  {
    status: "done",
    summary: "Investigated the artifact.",
    evidence: [{ file: "extensions/aies-agents/session.ts" }],
    issues: [],
    next: [],
    ...overrides,
  },
  null,
  2,
)}
\`\`\``;
}

function workerJson(overrides = {}) {
  return `\`\`\`json
${JSON.stringify(
  {
    status: "done",
    summary: "Implemented the work unit.",
    changes: [{ file: "a.ts" }, { file: "b.ts" }],
    checks: [{ check: "npm test", result: "ok" }],
    issues: [],
    next: [],
    ...overrides,
  },
  null,
  2,
)}
\`\`\``;
}

describe("AIES-010C child session observatory seam", () => {
  it("attaches exactly one listener and samples usage only on lifecycle boundaries", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "worker", at: 1000 });
    const stats = { tokens: { total: 0 }, cost: 0 };
    const fake = fakeSession(stats);

    const unsubscribe = sessionModule.attachChildObservatory(fake.session, obs, id);
    assert.equal(typeof unsubscribe, "function");
    assert.equal(fake.subscriptions, 1, "exactly one session.subscribe listener");

    // A start event is not a lifecycle boundary: nothing is sampled yet.
    fake.emit({ type: "agent_start" });
    assert.equal(obs.snapshot()[0].totalTokens, 0);

    // A tool lifecycle start is observed mechanically with the real args.
    fake.emit({ type: "tool_execution_start", toolName: "edit", args: { path: "extensions/a/b.ts" } });
    const afterTool = obs.snapshot()[0];
    assert.equal(afterTool.toolCount, 1);
    assert.equal(afterTool.currentActivity, "Editando a/b.ts");
    assert.deepEqual(afterTool.changedPaths, ["extensions/a/b.ts"]);
    assert.equal(Number.isFinite(afterTool.activities[0].at), true);

    // Usage is sampled from the session stats on each lifecycle boundary.
    stats.tokens.total = 1234;
    stats.cost = 0.25;
    fake.emit({ type: "turn_end" });
    assert.equal(obs.snapshot()[0].totalTokens, 1234);
    assert.equal(obs.snapshot()[0].cost, 0.25);

    stats.tokens.total = 1500;
    fake.emit({ type: "agent_settled" });
    assert.equal(obs.snapshot()[0].totalTokens, 1500);

    stats.tokens.total = 1700;
    fake.emit({ type: "agent_end" });
    assert.equal(obs.snapshot()[0].totalTokens, 1700);

    unsubscribe();
    assert.equal(fake.unsubscribed, 1);
  });

  it("keeps the last sampled usage when the session stops answering or dispose throws", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "verify", at: 1000 });
    const fake = fakeSession({ tokens: { total: 500 }, cost: 0.12 });

    sessionModule.attachChildObservatory(fake.session, obs, id);
    fake.emit({ type: "turn_end" });
    assert.equal(obs.snapshot()[0].totalTokens, 500);

    // The session no longer answers getSessionStats: the guard must swallow it
    // and the last real sample must stay.
    fake.goSilent();
    assert.doesNotThrow(() => fake.emit({ type: "agent_settled" }));
    assert.equal(obs.snapshot()[0].totalTokens, 500);
    assert.equal(obs.snapshot()[0].cost, 0.12);
  });

  it("never lets a throwing observer or an unavailable subscribe fail the run", () => {
    const throwingObservatory = {
      observe() {
        throw new Error("observe exploded");
      },
      updateUsage() {
        throw new Error("updateUsage exploded");
      },
    };
    const fake = fakeSession({ tokens: { total: 5 }, cost: 0 });
    const unsubscribe = sessionModule.attachChildObservatory(fake.session, throwingObservatory, "worker-1");

    assert.doesNotThrow(() =>
      fake.emit({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } }),
    );
    assert.doesNotThrow(() => fake.emit({ type: "turn_end" }));
    assert.doesNotThrow(() => unsubscribe());

    const brokenSession = {
      subscribe() {
        throw new Error("no subscribe here");
      },
      getSessionStats() {
        return { tokens: { total: 0 }, cost: 0 };
      },
    };
    let noop;
    assert.doesNotThrow(() => {
      noop = sessionModule.attachChildObservatory(brokenSession, new AgentObservatory(), "worker-2");
    });
    assert.doesNotThrow(() => noop());
  });
});

describe("AIES-010C runner observatory wiring", () => {
  it("closes an explore record with real child usage after the session is disposed", async () => {
    const { faux, runtime, model } = await fauxRuntime();
    faux.setResponses([fauxAssistantMessage([{ type: "text", text: exploreJson() }])]);

    const obs = new AgentObservatory();
    const handoff = await runExploreAgent({
      task: "Map the observatory seam",
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      observatory: obs,
      providerLabel: "Faux Provider",
    });

    assert.equal(handoff.status, "done");
    assert.equal(obs.snapshot().length, 1, "begin and finish run exactly once");

    const [record] = obs.snapshot();
    assert.equal(record.role, "explore");
    assert.equal(record.status, "completed");
    assert.equal(record.modelId, "faux-1");
    assert.equal(record.modelLabel, "Faux Model");
    assert.equal(record.providerId, "faux");
    assert.equal(record.providerLabel, "Faux Provider");
    assert.equal(record.currentActivity, null);
    assert.equal(record.finishedAt > 0, true);
    assert.ok(record.totalTokens > 0, "real usage sampled from the child session");
    assert.equal(Number.isFinite(record.cost), true);
    assert.match(record.result, /hallazgo/u);
    assert.equal(String(record.result).includes("\n"), false);
    assert.equal(String(record.result).includes(handoff.summary), false);
  });

  it("closes a worker record with a compact changes and checks fact line", async () => {
    const { faux, runtime, model } = await fauxRuntime();
    faux.setResponses([fauxAssistantMessage([{ type: "text", text: workerJson() }])]);

    const obs = new AgentObservatory();
    const handoff = await runWorkerAgent({
      task: "Implement the work unit",
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      observatory: obs,
    });

    assert.equal(handoff.status, "done");
    const [record] = obs.snapshot();
    assert.equal(record.role, "worker");
    assert.equal(record.status, "completed");
    assert.equal(record.result, "2 archivos modificados · 1 check");
    assert.ok(record.totalTokens > 0);
  });

  it("maps a verify PASS to a completed record with an N/M criteria fact line", async () => {
    const { faux, runtime, model } = await fauxRuntime();
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(
          VERIFY_COMPLETE_TOOL,
          {
            status: "pass",
            summary: "Inspected the artifact.",
            criteria: [{ criterion: "c", status: "pass", evidence: "file.js:1 shows 2000" }],
            checks: [],
            defects: [],
            next: [],
          },
          "c1",
        ),
      ]),
      fauxAssistantMessage([{ type: "text", text: "done" }]),
    ]);

    const obs = new AgentObservatory();
    const result = await runVerifyAgent({
      task: "Verify the timeout change",
      criteria: ["c"],
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      observatory: obs,
    });

    assert.equal(result.status, "pass");
    const [record] = obs.snapshot();
    assert.equal(record.role, "verify");
    assert.equal(record.status, "completed");
    assert.equal(record.result, "1/1 criterios");
    assert.ok(record.totalTokens > 0);
  });

  it("maps a verify protocol error to a failed record with a compact Spanish fact", async () => {
    const { faux, runtime, model } = await fauxRuntime();
    faux.setResponses([fauxAssistantMessage([{ type: "text", text: "no completion here" }])]);

    const obs = new AgentObservatory();
    const result = await runVerifyAgent({
      task: "Verify the timeout change",
      criteria: ["c"],
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      observatory: obs,
    });

    assert.equal(result.kind, "protocol_error");
    const [record] = obs.snapshot();
    assert.equal(record.role, "verify");
    assert.equal(record.status, "failed");
    assert.equal(record.result, "error de protocolo");
  });

  it("still closes the record as failed when the child never runs", async () => {
    const { runtime, model } = await fauxRuntime();
    const obs = new AgentObservatory();

    const handoff = await runExploreAgent({
      task: "Explore an aborted run",
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      observatory: obs,
      signal: AbortSignal.abort(),
    });

    assert.equal(handoff.status, "failed");
    assert.equal(obs.snapshot().length, 1);
    assert.equal(obs.snapshot()[0].status, "failed");
    assert.equal(obs.snapshot()[0].finishedAt > 0, true);
  });

  it("leaves the session registry empty when no observatory is supplied", async () => {
    const { faux, runtime, model } = await fauxRuntime();
    faux.setResponses([fauxAssistantMessage([{ type: "text", text: exploreJson() }])]);

    observatory.reset();
    const handoff = await runExploreAgent({
      task: "Run without an observatory",
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
    });

    assert.equal(handoff.status, "done");
    assert.deepEqual(observatory.snapshot(), []);
  });
});

describe("AIES-010C delegate provider label resolution", () => {
  it("resolves the provider display name and degrades safely", () => {
    const { resolveProviderDisplayLabel } = delegateModule;
    assert.equal(typeof resolveProviderDisplayLabel, "function");

    const registry = { getProviderDisplayName: (provider) => (provider === "faux" ? "Faux Provider" : provider) };
    assert.equal(resolveProviderDisplayLabel(registry, { provider: "faux" }), "Faux Provider");

    // Absent registry, absent provider or a throwing registry never fail the run.
    assert.equal(resolveProviderDisplayLabel(undefined, { provider: "faux" }), undefined);
    assert.equal(resolveProviderDisplayLabel(registry, undefined), undefined);
    assert.equal(resolveProviderDisplayLabel(registry, {}), undefined);
    assert.equal(
      resolveProviderDisplayLabel(
        {
          getProviderDisplayName() {
            throw new Error("registry exploded");
          },
        },
        { provider: "faux" },
      ),
      undefined,
    );
  });

  it("passes the observatory singleton to all three child runners", () => {
    const delegateSource = new URL("../extensions/aies-agents/delegate.ts", import.meta.url);
    const text = readFileSync(delegateSource, "utf8");
    assert.match(text, /import\s*\{[^}]*observatory[^}]*\}\s*from\s*"\.\/observatory\.ts"/u);
    assert.ok(
      (text.match(/\bobservatory,/gu) ?? []).length >= 3,
      "each child runner receives the observatory singleton",
    );
  });
});

describe("AIES-010D T12 model and thinking wiring", () => {
  it("distinguishes a real session runtime from a resolution registry", () => {
    assert.equal(sessionModule.isSessionModelRuntime({ getAuth() {}, streamSimple() {} }), true);
    assert.equal(sessionModule.isSessionModelRuntime({ find() {}, getAvailable() {} }), false);
    assert.equal(sessionModule.isSessionModelRuntime(undefined), false);
    assert.equal(sessionModule.isSessionModelRuntime({ getAuth() {} }), false);
  });

  it("forwards the delegating registry as the modelRuntime resolution source", () => {
    const text = readFileSync(new URL("../extensions/aies-agents/delegate.ts", import.meta.url), "utf8");
    assert.ok(
      (text.match(/modelRuntime: ctx\.modelRegistry/gu) ?? []).length === 3,
      "explore, worker and verify each receive ctx.modelRegistry as modelRuntime",
    );
  });

  it("validates a configured thinking level against model capabilities", () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-thinking-"));
    try {
      const reasoning = { provider: "faux", id: "faux-1", reasoning: true };
      writeFileSync(join(dir, "aies.json"), JSON.stringify({ agents: { explore: { thinkingLevel: "high" } } }));
      assert.equal(resolveAgentThinkingLevel("explore", reasoning, dir), "high");

      // An unsupported configured level is dropped, never clamped to a neighbour.
      writeFileSync(join(dir, "aies.json"), JSON.stringify({ agents: { explore: { thinkingLevel: "max" } } }));
      assert.equal(resolveAgentThinkingLevel("explore", reasoning, dir), undefined);

      // A non-reasoning model can only ever run with off, so a stored level is invalid.
      assert.equal(
        resolveAgentThinkingLevel("explore", { provider: "faux", id: "plain", reasoning: false }, dir),
        undefined,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies the configured thinking level to the real child session", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-1", name: "Faux Model", reasoning: true }] });
    const runtime = await ModelRuntime.create();
    runtime.registerNativeProvider(faux.provider);
    const model = faux.models[0];

    const dir = mkdtempSync(join(tmpdir(), "aies-thinking-run-"));
    let observedReasoning;
    try {
      writeFileSync(join(dir, "aies.json"), JSON.stringify({ agents: { explore: { thinkingLevel: "high" } } }));
      faux.setResponses([
        (_context, options) => {
          observedReasoning = options?.reasoning;
          return fauxAssistantMessage([{ type: "text", text: exploreJson() }]);
        },
      ]);

      const handoff = await runExploreAgent({
        task: "Apply the configured thinking level",
        cwd: REPO_ROOT,
        agentDir: dir,
        modelRuntime: runtime,
        model,
      });

      assert.equal(handoff.status, "done");
      assert.equal(observedReasoning, "high", "the child session must run with the configured level");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
