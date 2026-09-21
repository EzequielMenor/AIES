/**
 * AIES-010C / T4a status-panel checks.
 *
 * The panel is pure: a snapshot in, boxed lines out. Every test drives real
 * runtime state (built through the actual appliers) so the fields the panel
 * reads are exercised for real. Assertions target structural facts (tiers, box
 * width, line budget, which facts appear) rather than full-string snapshots.
 *
 * No Pi runtime, no terminal, no timers, `PLAIN_PAINT`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAgents,
  applyContextGovernorSync,
  applyContextUsage,
  applyDelegationStart,
  applyModel,
  applyRunStart,
  applyRunUsage,
  applyTicketObservationSync,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderFooter } from "../extensions/aies-ui/footer.ts";
import { formatCost } from "../extensions/aies-ui/format.ts";
import { PANEL_MIN_WIDTH, PANEL_WIDE_WIDTH, renderStatusPanel } from "../extensions/aies-ui/panel.ts";

const T0 = 1_700_000_000_000;

/** A minimal `AgentRecord` the observatory would produce. */
function record(overrides = {}) {
  return {
    id: "worker-1",
    role: "worker",
    status: "running",
    startedAt: T0,
    finishedAt: null,
    modelId: "qwen3.8-flash",
    modelLabel: "Qwen 3.8 Flash",
    providerId: "openrouter",
    providerLabel: "openrouter",
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

/** Snapshot plus the observatory records the panel renders. */
function snapOf(state) {
  return { ...toSnapshot(state), agents: state.agents };
}

/** A state with a ticket, a worker, two agents and known run usage. */
function richState() {
  let state = createState(T0);
  state = applyTicketObservationSync(state, { active: true, identifier: "EZE-417", status: "In Progress" });
  state = applyContextUsage(state, { tokens: 42_000, contextWindow: 200_000 });
  state = applyModel(state, { id: "qwen3.8-flash", provider: "openrouter", name: "Qwen 3.8 Flash" });
  state = applyDelegationStart(state, "worker", T0);
  state = applyAgents(state, [
    record({ id: "worker-1", role: "worker", totalTokens: 4_000, cost: 0.02 }),
    record({ id: "explore-1", role: "explore", status: "completed", finishedAt: T0 + 18_000 }),
  ]);
  state = applyRunStart(state, T0);
  state = applyRunUsage(state, { totalTokens: 1_000, cost: 0.01 }, [], T0);
  state = applyRunUsage(
    state,
    { totalTokens: 13_000, cost: 0.05 },
    [record({ totalTokens: 4_000, cost: 0.02 })],
    T0 + 31_000,
  );
  return state;
}

const boxWidthOf = (lines) => Math.max(...lines.map((line) => line.length));

describe("formatCost", () => {
  it("formats dollars with two decimals and an em dash for an unknown value", () => {
    assert.equal(formatCost(0.08), "$0.08");
    assert.equal(formatCost(0.1), "$0.10");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(1.239), "$1.24");
    assert.equal(formatCost(null), "—");
    assert.equal(formatCost(undefined), "—");
    assert.equal(formatCost(Number.NaN), "—");
    assert.equal(formatCost(Number.POSITIVE_INFINITY), "—");
    assert.equal(formatCost(-1), "—");
  });
});

describe("status panel", () => {
  it("renders nothing below the minimum width or without a width", () => {
    const snap = snapOf(createState(T0));
    assert.deepEqual(renderStatusPanel(snap, T0, { width: PANEL_MIN_WIDTH - 1 }), []);
    assert.deepEqual(renderStatusPanel(snap, T0, { width: 12 }), []);
    assert.deepEqual(renderStatusPanel(snap, T0, { width: undefined }), []);
  });

  it("renders a restrained product panel at the full tier", () => {
    const lines = renderStatusPanel(snapOf(richState()), T0 + 31_000, { width: 140 });
    assert.ok(lines.length <= 6, `full panel has ${lines.length} lines:
${lines.join("\n")}`);
    assert.ok(lines.length >= 5, `full panel lost its hierarchy:
${lines.join("\n")}`);
    assert.ok(lines[0].startsWith("╭─ ✧ AIES · EZE-417 · WORK"), lines[0]);
    assert.ok(lines.at(-1).startsWith("╰"), lines.at(-1));
    assert.ok(lines.every((line) => line.length <= 96), lines.join("\n"));

    const text = lines.join("\n");
    assert.match(text, /Qwen 3\.8 Flash · openrouter/u);
    assert.match(text, /ctx 42k/u);
    assert.match(text, /00:31/u);
    assert.match(text, /Tokens/u);
    assert.match(text, /Main 12k/u);
    assert.match(text, /Agents 4000/u);
    assert.match(text, /Total 16k/u);
    assert.match(text, /Coste/u);
    assert.match(text, /Agentes/u);
    assert.match(text, /◆ Worker activo/u);
    assert.match(text, /✓ Explore completado/u);
  });

  it("shows the ticket placeholder at IDLE and always carries the stage", () => {
    const lines = renderStatusPanel(snapOf(createState(T0)), T0, { width: 120 });
    assert.match(lines.join("\n"), /✧ AIES · listo · IDLE/u);
  });

  it("keeps an idle full panel intentional but quiet", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });
    state = applyModel(state, { id: "qwen3.8-flash", provider: "openrouter", name: "Qwen 3.8 Flash" });
    const lines = renderStatusPanel(snapOf(state), T0, { width: 140 });
    assert.ok(lines.length <= 5, lines.join("\n"));
    assert.ok(lines[0].startsWith("╭─ ✧ AIES · listo · IDLE"), lines[0]);

    const text = lines.join("\n");
    assert.match(text, /Qwen 3\.8 Flash · openrouter/u);
    assert.match(text, /ctx 31k/u);
    assert.equal(text.includes("00:00"), false, `an idle panel must not time the session:\n${text}`);
    assert.equal(text.includes("Agentes"), false, text);
    assert.equal(text.includes("Tokens"), false, text);
    assert.equal(text.includes("Coste"), false, text);
    assert.equal(text.includes("$0.00"), false, text);
  });

  it("omits every fact it cannot read", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });
    const text = renderStatusPanel(snapOf(state), T0, { width: 120 }).join("\n");

    assert.equal(text.includes("Modelo"), false, text);
    assert.equal(text.includes("Coste"), false, text);
    assert.equal(text.includes("Agentes"), false, text);
    assert.equal(text.includes("$0.00"), false, text);
    assert.match(text, /ctx 31k/u);
    assert.equal(text.includes("00:00"), false, `no run, no clock:\n${text}`);
  });

  it("times the active run and never the session", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });

    const idle = renderStatusPanel(snapOf(state), T0 + 90_000, { width: 140 }).join("\n");
    assert.equal(idle.includes("01:30"), false, `the session elapsed leaked into the panel:\n${idle}`);

    state = applyRunStart(state, T0 + 60_000);
    const running = renderStatusPanel(snapOf(state), T0 + 90_000, { width: 140 }).join("\n");
    assert.match(running, /00:30/u);
    assert.equal(running.includes("01:30"), false, running);

    const compact = renderStatusPanel(snapOf(state), T0 + 90_000, { width: 90 }).join("\n");
    assert.match(compact, /Tiempo 00:30/u);
  });

  it("omits the Agentes row when the registry is empty, even while a role is active", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });
    state = applyDelegationStart(state, "verify", T0);

    const wide = renderStatusPanel(snapOf(state), T0, { width: 140 }).join("\n");
    assert.equal(wide.includes("Agentes"), false, wide);
    assert.equal(wide.includes("0 ·"), false, `a zero count leaked: ${wide}`);
    assert.equal(wide.includes("0 · Verify"), false, wide);

    const mid = renderStatusPanel(snapOf(state), T0, { width: 80 }).join("\n");
    assert.equal(mid.includes("Agentes"), false, mid);
    assert.equal(mid.includes("0 ·"), false, `a zero count leaked: ${mid}`);
  });

  it("omits the tokens row when the run measured nothing", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });
    state = applyRunStart(state, T0);
    state = applyRunUsage(state, { totalTokens: 0, cost: null }, [], T0);
    const text = renderStatusPanel(snapOf(state), T0, { width: 140 }).join("\n");
    assert.equal(text.includes("Tokens"), false, text);
  });

  it("omits the cost row when there are no agents and the run cost is zero", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });
    state = applyRunStart(state, T0);
    state = applyRunUsage(state, { totalTokens: 2_000, cost: 0 }, [], T0);
    state = applyRunUsage(state, { totalTokens: 4_000, cost: 0 }, [], T0 + 1_000);
    const lines = renderStatusPanel(snapOf(state), T0 + 1_000, { width: 140 });
    const text = lines.join("\n");
    assert.match(text, /Tokens/u);
    assert.equal(text.includes("Coste"), false, text);
    assert.equal(text.includes("$0.00"), false, text);
  });

  it("marks context pressure and compaction", () => {
    let state = applyContextUsage(createState(T0), { tokens: 104_000, contextWindow: 200_000 });
    state = applyContextGovernorSync(state, { zone: "pressure", currentTokens: 104_000 });
    assert.match(renderStatusPanel(snapOf(state), T0, { width: 120 }).join("\n"), /104k !/u);

    state = applyContextGovernorSync(state, { compacting: true });
    assert.match(renderStatusPanel(snapOf(state), T0, { width: 120 }).join("\n"), /compactando…/u);
  });

  it("renders an em dash for an unknown cost instead of a zero", () => {
    let state = createState(T0);
    state = applyRunStart(state, T0);
    state = applyRunUsage(state, { totalTokens: 1_000, cost: 0.01 }, [], T0);
    state = applyRunUsage(
      state,
      { totalTokens: 13_000, cost: 0.05 },
      [record({ totalTokens: 4_000, cost: null })],
      T0 + 31_000,
    );

    const text = renderStatusPanel(snapOf(state), T0 + 31_000, { width: 120 }).join("\n");
    assert.match(text, /Coste/u);
    assert.match(text, /—/u);
    assert.equal(text.includes("$0.00"), false, text);
  });

  it("collapses to a bounded compact product panel from 80 to 119 columns", () => {
    const lines = renderStatusPanel(snapOf(richState()), T0 + 31_000, { width: 80 });
    assert.ok(lines.length <= 7, `compact panel has ${lines.length} lines:
${lines.join("\n")}`);
    assert.ok(lines[0].startsWith("╭"), lines[0]);
    assert.ok(lines.at(-1).startsWith("╰"), lines.at(-1));
    assert.ok(boxWidthOf(lines) <= 72, `box is ${boxWidthOf(lines)} wide`);

    const text = lines.join("\n");
    assert.match(text, /Contexto/u);
    assert.match(text, /Tiempo/u);
    assert.match(text, /Agentes/u);
    assert.match(text, /Main 12k/u);
    assert.match(text, /Agents 4000/u);
    assert.match(text, /Total 16k/u);
  });

  it("uses the rich one-line footer as the below-80 fallback", () => {
    const text = renderFooter(toSnapshot(richState()), T0 + 31_000, { width: 79, panelVisible: false });
    assert.match(text, /^✧ AIES · EZE-417 · WORK/u);
    assert.match(text, /qwen3\.8-flash\/openrouter/u);
    assert.match(text, /ctx 42k/u);
    assert.match(text, /00:31/u);
    assert.match(text, /\$0\.06/u);
    assert.ok(text.length <= 79, text);
  });

  it("keeps every line inside its own width budget across the tiers", () => {
    for (const width of [PANEL_MIN_WIDTH, 100, PANEL_WIDE_WIDTH, 160]) {
      const lines = renderStatusPanel(snapOf(richState()), T0, { width });
      assert.ok(lines.length > 0, `no panel at ${width}`);
      assert.ok(lines.length <= 7, `width ${width}: ${lines.length} lines`);
      for (const line of lines) {
        assert.ok(line.length <= width, `width ${width}: "${line}"`);
        assert.ok(line.length <= 96, `width ${width}: "${line}" exceeds the 96 max`);
      }
    }
  });
});
