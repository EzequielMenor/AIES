/**
 * EZE-436 Smoke regressions suite.
 *
 * Covers the 7 visual/state inconsistencies observed in the real smoke test video:
 * 1. Active Agent Card: Tokens of child displayed, no clutter.
 * 2. Active Agent Card: Human Spanish task descriptions, no prompt leakage.
 * 3. Cost semantics: Known cost = $, free = $0.00, subscription/plan/unknown = —, no data = —.
 * 4. DONE vs WORKING lifecycle: VERIFY -> FINALIZING -> DONE.
 * 5. Todos N/A: Freeform hides ticket and linear sync steps.
 * 6. /agents humanized activity: Translates raw commands into safe categories.
 * 7. /agents known metadata: Uses existing structured file counts/paths instead of "archivos —".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentObservatory,
  classifyBashCommand,
  describeActivity,
} from "../extensions/aies-agents/observatory.ts";
import {
  applyAgents,
  applyDelegationEnd,
  applyDelegationStart,
  applyModel,
  applyRunStart,
  applyRunUsage,
  applyStopReason,
  applyTicketObservationSync,
  applyVerificationReport,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import {
  humanizeTask,
  renderActivityCard,
} from "../extensions/aies-ui/activity.ts";
import { renderAgentsView } from "../extensions/aies-ui/agents.ts";
import { formatCost, isFreeModel, isSubscriptionOrPlan, observableCost } from "../extensions/aies-ui/format.ts";
import { renderRightRail } from "../extensions/aies-ui/right-rail.ts";
import { deriveTodos, renderTodos } from "../extensions/aies-ui/todos.ts";
import { deriveStage } from "../extensions/aies-ui/vocabulary.ts";

const T0 = 1_700_000_000_000;

describe("EZE-436: 1. Active Agent Card Tokens", () => {
  it("renders live child tokens cleanly on the card without model or path clutter", () => {
    const activity = {
      role: "worker",
      task: "Implementando el fixture y sus tests",
      startedAt: T0,
      totalTokens: 42_000,
      cost: null,
    };

    const lines = renderActivityCard(activity, "WORK", T0 + 72_000, { width: 60 });
    const text = lines.join("\n");

    assert.match(text, /◆ Worker/u);
    assert.match(text, /Implementando el fixture y sus tests/u);
    assert.match(text, /01:12 · 42k tokens/u);

    // No extra noise: no file path line, no model name
    assert.equal(lines.length, 4, `expected exactly 4 boxed lines (top, 2 content, bottom), got: ${text}`);
    assert.equal(text.includes("Qwen"), false);
  });
});

describe("EZE-436: 2. Active Agent Card Human Description", () => {
  it("filters internal LLM child prompts and humanizes by role and target", () => {
    // Leaked English prompt in Explore
    const explorePrompt = "Investigate the environment to plan a minimal implementation of clamp(value, min, max)";
    assert.equal(
      humanizeTask("explore", explorePrompt, undefined, "EXPLORE"),
      "Revisando el proyecto y preparando el cambio",
    );

    // Leaked English prompt in Worker with clamp target
    const workerPrompt = "Plan a minimal implementation of clamp(value, min, max) and write 3 tests";
    assert.equal(
      humanizeTask("worker", workerPrompt, undefined, "WORK"),
      "Implementando clamp() y sus tests",
    );

    // Leaked English prompt in Verify
    const verifyPrompt = "Investigate the environment to plan verification of clamp implementation";
    assert.equal(
      humanizeTask("verify", verifyPrompt, undefined, "VERIFY"),
      "Verificando el cambio y ejecutando tests",
    );

    // Clean Spanish task is preserved
    assert.equal(
      humanizeTask("worker", "Implementando el fixture y sus tests", undefined, "WORK"),
      "Implementando el fixture y sus tests",
    );
  });
});

describe("EZE-436: 3. Cost Semantics", () => {
  it("never shows $0.00 for unknown or subscription providers", () => {
    // Subscription or token plan -> null (renders as —)
    assert.equal(observableCost(0, "qwen-2.5-coder", "qwen-token-plan"), null);
    assert.equal(formatCost(observableCost(0, "qwen-2.5-coder", "qwen-token-plan")), "—");
    assert.equal(isSubscriptionOrPlan("qwen-token-plan"), true);

    // Known cost > 0 -> dollar formatted
    assert.equal(observableCost(0.042, "claude-3-5-sonnet", "anthropic"), 0.042);
    assert.equal(formatCost(observableCost(0.042, "claude-3-5-sonnet", "anthropic")), "$0.04");

    // Free model -> $0.00
    assert.equal(observableCost(0, "deepseek-r1:free", "openrouter"), 0);
    assert.equal(formatCost(observableCost(0, "deepseek-r1:free", "openrouter")), "$0.00");
    assert.equal(observableCost(0, "llama3", "ollama"), 0);
    assert.equal(formatCost(observableCost(0, "llama3", "ollama")), "$0.00");

    // Missing data -> —
    assert.equal(observableCost(null), null);
    assert.equal(formatCost(null), "—");
    assert.equal(formatCost(undefined), "—");
  });

  it("renders — in rail when cost is not observable", () => {
    let state = createState(T0);
    state = applyModel(state, { id: "qwen", provider: "qwen-token-plan", name: "Qwen" });
    state = applyRunStart(state, T0);
    // Simulating parent and child under qwen-token-plan
    state = applyRunUsage(
      state,
      { totalTokens: 10_000, cost: 0 },
      [
        {
          id: "worker-1",
          role: "worker",
          status: "completed",
          startedAt: T0,
          finishedAt: T0 + 10_000,
          totalTokens: 15_000,
          cost: null,
          modelId: "qwen",
          providerId: "qwen-token-plan",
          currentActivity: null,
          toolCount: 1,
          changedPaths: [],
          activities: [],
          result: "done",
        },
      ],
      T0 + 10_000,
    );

    const snapshot = { ...toSnapshot(state), agents: state.agents };
    const railText = renderRightRail(snapshot, T0 + 10_000, { width: 46 }).join("\n");
    // Should NOT show $0.00 for unknown costs
    assert.equal(railText.includes("$0.00"), false, `Rail should not show $0.00: ${railText}`);
  });
});

describe("EZE-436: 4. DONE vs WORKING Lifecycle", () => {
  it("transitions VERIFY -> FINALIZING -> DONE without simultaneous DONE + Working", () => {
    let state = createState(T0);
    state = applyDelegationStart(state, "verify", T0);

    // While verifying
    let snap = { ...toSnapshot(state), agents: state.agents };
    assert.equal(deriveStage(snap), "VERIFY");

    // Verify passes, child finishes, parent turn still in flight
    state = applyDelegationEnd(state, "done", T0 + 5_000);
    state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });
    snap = { ...toSnapshot(state), agents: state.agents };

    // Stage MUST be FINALIZING, not DONE yet
    assert.equal(deriveStage(snap), "FINALIZING");

    // Todos must show Finalizar as running, not pending or prematurely done
    const todos = deriveTodos(snap);
    const finalizar = todos.items.find((item) => item.key === "done");
    assert.ok(finalizar);
    assert.equal(finalizar.state, "running");

    // Parent turn ends -> doneEmitted latched
    snap = { ...snap, doneEmitted: true, runEndedAt: T0 + 6_000 };
    assert.equal(deriveStage(snap), "DONE");

    const finishedTodos = deriveTodos(snap);
    const finishedFinalizar = finishedTodos.items.find((item) => item.key === "done");
    assert.equal(finishedFinalizar.state, "done");
  });
});

describe("EZE-436: 5. Todos N/A in Freeform", () => {
  it("hides Cargar ticket and Sincronizar Linear in freeform runs", () => {
    let state = createState(T0);
    state = applyDelegationStart(state, "explore", T0);
    state = applyDelegationEnd(state, "done", T0 + 1_000);
    state = applyDelegationStart(state, "worker", T0 + 1_000);

    const snap = { ...toSnapshot(state), agents: state.agents };
    const todos = deriveTodos(snap);

    const labels = todos.items.map((item) => item.label);
    assert.deepEqual(labels, ["Explorar", "Implementar", "Verificar", "Finalizar"]);
    assert.equal(labels.includes("Cargar ticket"), false);
    assert.equal(labels.includes("Sincronizar Linear"), false);
  });
});

describe("EZE-436: 6. /agents Humanized Activity", () => {
  it("translates raw bash commands into human Spanish categories", () => {
    assert.equal(classifyBashCommand("npm test"), "Ejecutando tests");
    assert.equal(classifyBashCommand("node --test tests/clamp.test.js"), "Ejecutando tests");
    assert.equal(classifyBashCommand("git status"), "Comprobando estado Git");
    assert.equal(classifyBashCommand("git diff"), "Comprobando estado Git");
    assert.equal(classifyBashCommand("mkdir -p fixtures && touch fixtures/data.json"), "Preparando fixture");
    assert.equal(classifyBashCommand("sed -i 's/foo/bar/' index.js"), "Modificando archivos");
    assert.equal(classifyBashCommand("echo 'const x = 1;' > src/clamp.js"), "Modificando archivos");
    assert.equal(classifyBashCommand("cat package.json"), "Leyendo archivos");
    assert.equal(classifyBashCommand("grep -rn 'clamp' src/"), "Buscando referencias");
    assert.equal(classifyBashCommand("cd src && ls"), "Ejecutando comando");
  });

  it("humanizes activities in describeActivity", () => {
    assert.equal(describeActivity("bash", { command: "npm test" }), "Ejecutando tests");
    assert.equal(describeActivity("read", { path: "src/clamp.js" }), "Leyendo src/clamp.js");
    assert.equal(describeActivity("edit", { filePath: "src/clamp.js" }), "Editando src/clamp.js");
    assert.equal(describeActivity("ls", {}), "Consultando archivo");
    assert.equal(describeActivity("unknown_tool", {}), "Ejecutando comando");
  });
});

describe("EZE-436: 7. /agents Known Metadata", () => {
  it("uses existing structured changedPaths or result metadata in modal", () => {
    const recordWithPaths = {
      id: "worker-1",
      role: "worker",
      status: "completed",
      startedAt: T0,
      finishedAt: T0 + 10_000,
      totalTokens: 25_000,
      cost: null,
      toolCount: 4,
      changedPaths: ["src/clamp.js", "tests/clamp.test.js"],
      activities: [],
      result: "2 archivos modificados",
    };

    const modalText = renderAgentsView([recordWithPaths], 0, T0 + 10_000, { width: 80 }).join("\n");
    assert.match(modalText, /archivos\s+src\/clamp\.js/u);

    // Record without paths but with structured result
    const recordWithResult = {
      id: "explore-1",
      role: "explore",
      status: "completed",
      startedAt: T0,
      finishedAt: T0 + 5_000,
      totalTokens: 10_000,
      cost: null,
      toolCount: 3,
      changedPaths: [],
      activities: [],
      result: "5 archivos relevantes",
    };

    const modalExplore = renderAgentsView([recordWithResult], 0, T0 + 5_000, { width: 80 }).join("\n");
    assert.match(modalExplore, /archivos\s+5 archivos relevantes/u);
  });
});
