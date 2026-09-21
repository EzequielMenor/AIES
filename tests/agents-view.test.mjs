/**
 * AIES-010C / T4a Agent Observatory renderer checks.
 *
 * `renderAgentsView` is the `/agents` screen and `selectAgent` is the pure
 * navigation helper T4b binds keys to. Both are pure: records in, lines out,
 * no state, no Pi, `PLAIN_PAINT`.
 *
 * Assertions are structural (selection, which facts appear, clipping) so copy
 * can evolve without breaking the suite.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderAgentsView, selectAgent } from "../extensions/aies-ui/agents.ts";

const T0 = 1_700_000_000_000;

/** A minimal `AgentRecord` the observatory would produce. */
function record(overrides = {}) {
  return {
    id: "worker-1",
    role: "worker",
    status: "running",
    startedAt: T0,
    finishedAt: null,
    modelId: null,
    modelLabel: null,
    providerId: null,
    providerLabel: null,
    currentActivity: null,
    totalTokens: 0,
    cost: null,
    toolCount: 0,
    changedPaths: [],
    activities: [],
    result: null,
    ...overrides,
  };
}

describe("selectAgent", () => {
  const list = [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })];

  it("wraps around left and right with up and down as aliases", () => {
    assert.equal(selectAgent(list, 0, "left"), 2);
    assert.equal(selectAgent(list, 2, "right"), 0);
    assert.equal(selectAgent(list, 1, "up"), 0);
    assert.equal(selectAgent(list, 0, "down"), 1);
    assert.equal(selectAgent(list, 1, "left"), 0);
    assert.equal(selectAgent(list, 1, "right"), 2);
  });

  it("clamps an out-of-range index and survives an empty list", () => {
    assert.equal(selectAgent(list, 9, "right"), 1);
    assert.equal(selectAgent([], 0, "right"), 0);
    assert.equal(selectAgent([], 4, "left"), 0);
  });
});

describe("renderAgentsView", () => {
  it("renders the title, the selectable list, the detail block and the hint", () => {
    const list = [
      record({
        id: "worker-1",
        role: "worker",
        status: "running",
        changedPaths: ["src/calculator.js"],
        modelLabel: "Qwen 3.8 Flash",
        providerLabel: "openrouter",
        totalTokens: 34_000,
        cost: 0.03,
        toolCount: 4,
        activities: [{ tool: "edit", text: "Editando calculator.js", at: T0 }],
      }),
      record({ id: "verify-1", role: "verify", status: "completed", startedAt: T0, finishedAt: T0 + 18_000, result: "PASS" }),
    ];

    const lines = renderAgentsView(list, 0, T0 + 31_000, { width: 80 });
    const text = lines.join("\n");

    assert.match(lines[0], /AIES Agents/u);
    assert.match(text, /Worker #1/u);
    assert.match(text, /Verify #1/u);
    assert.match(text, /Qwen 3.8 Flash/u);
    assert.match(text, /openrouter/u);
    assert.match(text, /34k/u);
    assert.match(text, /\$0\.03/u);
    assert.match(text, /calculator\.js/u);
    assert.match(text, /actividad reciente/u);
    assert.match(text, /Editando calculator\.js/u);
    assert.match(text, /← → agente · esc cerrar/u);
    for (const line of lines) assert.ok(line.length <= 80, line);
  });

  it("bounds the archivos row to short paths with a remainder count", () => {
    const list = [
      record({
        id: "worker-1",
        role: "worker",
        status: "completed",
        startedAt: T0,
        finishedAt: T0 + 5_000,
        changedPaths: [
          "/Users/someone/Proyectos/Developer/aies-smoke/src/round.js",
          "/Users/someone/Proyectos/Developer/aies-smoke/src/app.ts",
          "/Users/someone/Proyectos/Developer/aies-smoke/src/lib/util.ts",
          "/Users/someone/Proyectos/Developer/aies-smoke/tests/a.test.ts",
          "/Users/someone/Proyectos/Developer/aies-smoke/tests/b.test.ts",
        ],
      }),
    ];

    const text = renderAgentsView(list, 0, T0 + 6_000, { width: 200 }).join("\n");
    const row = text.split("\n").find((line) => line.includes("archivos"));
    assert.ok(row, text);

    // The detail row never leaks the absolute home prefix.
    assert.equal(row.includes("/Users/"), false, row);
    assert.equal(row.includes("/home/"), false, row);
    // It keeps the same two-segment short form the rest of the UI uses.
    assert.match(row, /src\/round\.js/u);
    assert.match(row, /src\/app\.ts/u);
    // Five paths collapse to a few plus the remainder count.
    assert.match(row, /… 2 más$/u);
    // And it stays a single clipped line at a narrow width.
    for (const line of renderAgentsView(list, 0, T0 + 6_000, { width: 60 })) {
      assert.ok(line.length <= 60, line);
    }
  });

  it("moves the detail block with the selection", () => {
    const list = [
      record({ id: "worker-1", role: "worker", status: "running", modelLabel: "Qwen 3.8 Flash" }),
      record({ id: "verify-1", role: "verify", status: "completed", startedAt: T0, finishedAt: T0 + 1_000, modelLabel: "Claude 4" }),
    ];

    const first = renderAgentsView(list, 0, T0 + 5_000, { width: 80 }).join("\n");
    const second = renderAgentsView(list, 1, T0 + 5_000, { width: 80 }).join("\n");
    assert.match(first, /Qwen 3\.8 Flash/u);
    assert.equal(first.includes("Claude 4"), false, first);
    assert.match(second, /Claude 4/u);
  });

  it("clips every line and never renders a transcript or reasoning", () => {
    const list = [record({ id: "worker-1", role: "worker", status: "running", currentActivity: "Ejecutando pnpm test" })];
    const lines = renderAgentsView(list, 0, T0, { width: 20 });
    for (const line of lines) assert.ok(line.length <= 20, line);

    const text = lines.join("\n").toLowerCase();
    assert.equal(text.includes("reasoning"), false, text);
    assert.equal(text.includes("transcript"), false, text);
    assert.equal(text.includes("chain-of-thought"), false, text);
  });

  it("handles an empty list", () => {
    const lines = renderAgentsView([], 0, T0, { width: 80 });
    const text = lines.join("\n");
    assert.match(text, /AIES Agents/u);
    assert.match(text, /← → agente · esc cerrar/u);
  });
});
