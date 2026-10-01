/**
 * AIES live-rail metrics checks (right-rail polish).
 *
 * The rail must report REAL live telemetry:
 *
 * - Tiempo total is the run's elapsed time, independent of delegation stages,
 *   frozen at the run's end, and `—` when nothing is in flight.
 * - Coste is rendered only from observed data: an unobserved bucket is `—`, a
 *   genuinely observed `0` is `$0.00`, and Total sums only observed buckets.
 * - Tokens are `—` before any sample and real values once observed.
 *
 * Every snapshot is built through the real appliers (`createState` + `apply*` +
 * `toSnapshot`), so the fields the rail reads are exercised for real. No Pi
 * runtime, no terminal, no timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyDelegationEnd,
  applyDelegationStart,
  applyRunStart,
  applyRunUsage,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderRightRail } from "../extensions/aies-ui/right-rail.ts";

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

/** Snapshot plus the observatory records the rail renders. */
function snapOf(state) {
  return { ...toSnapshot(state), agents: state.agents };
}

/** The rail section headings, used to bound a section lookup. */
const HEADINGS = ["Status", "Tokens", "Coste", "Agents", "Todos"];

/** A boxed row with its frame and trailing padding stripped. */
function cleanRow(line) {
  return line.replace(/^│\s*/u, "").replace(/\s*│\s*$/u, "").trimEnd();
}

/** One `label value` status fact, e.g. `Tiempo 00:31`. */
function railStatusValue(text, label) {
  const line = text.split("\n").find((row) => new RegExp(`^\\s*${label}\\s+`, "u").test(cleanRow(row)));
  assert.ok(line, `no "${label}" row:\n${text}`);
  return cleanRow(line).replace(new RegExp(`^${label}\\s+`, "u"), "").trim();
}

/** One bucket value inside a section, e.g. `Agents` under `Coste`. */
function railSectionValue(text, section, label) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => cleanRow(line) === section);
  assert.ok(start >= 0, `no "${section}" section:\n${text}`);
  for (let index = start + 1; index < lines.length; index += 1) {
    const row = cleanRow(lines[index]);
    if (HEADINGS.includes(row)) break;
    const match = row.match(new RegExp(`^\\s*${label}\\s+(\\S+)$`, "u"));
    if (match) return match[1];
  }
  assert.fail(`no "${label}" bucket under "${section}":\n${text}`);
}

describe("run usage observed-cost semantics", () => {
  it("treats 'no children' as an unknown Agents cost, never a fake zero", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 100, cost: 0.5 }, [], T0);
    state = applyRunUsage(state, { totalTokens: 200, cost: 0.7 }, [], T0 + 1);
    assert.equal(state.runUsage.agents.cost, null, "an empty registry has no observed cost");
    assert.equal(state.runUsage.agents.totalTokens, 0);
  });

  it("keeps a genuinely observed zero child cost as zero", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 100, cost: 0.5 }, [record({ totalTokens: 5, cost: 0 })], T0);
    assert.equal(state.runUsage.agents.cost, 0, "an observed 0 is a real value, not unknown");
  });

  it("sums only observed buckets into Total and excludes the unknown ones", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 100, cost: null }, [record({ totalTokens: 5, cost: 0.25 })], T0);
    assert.equal(state.runUsage.main.cost, null);
    assert.equal(state.runUsage.agents.cost, 0.25);
    assert.equal(state.runUsage.total.cost, 0.25, "Total sums the one observed bucket");
  });

  it("renders Total unknown only when neither bucket was observed", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 100, cost: null }, [], T0);
    assert.equal(state.runUsage.total.cost, null, "no observed cost anywhere keeps Total unknown");
  });
});

describe("right rail live time (Tiempo)", () => {
  it("does not mistake a delegation start for a total run start", () => {
    const state = applyDelegationStart(createState(T0), "worker", T0);
    const text = renderRightRail(snapOf(state), T0 + 31_000, { width: 46 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "—");
  });

  it("uses the run start rather than the active stage start", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyDelegationStart(state, "worker", T0 + 20_000);
    const text = renderRightRail(snapOf(state), T0 + 31_000, { width: 46 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "00:31", "the total measures the entire run");
  });

  it("keeps total elapsed across Explore → Worker → Verify and child completion", () => {
    let state = applyRunStart(createState(T0 - 60_000), T0);
    const totalAt = (now) => railStatusValue(renderRightRail(snapOf(state), now, { width: 46 }).join("\n"), "Tiempo total");
    assert.equal(totalAt(T0), "00:00");
    state = applyDelegationStart(state, "explore", T0 + 5_000);
    assert.equal(totalAt(T0 + 15_000), "00:15");
    state = applyDelegationEnd(state, "done", T0 + 20_000);
    assert.equal(totalAt(T0 + 20_000), "00:20");
    state = applyDelegationStart(state, "worker", T0 + 25_000);
    assert.equal(totalAt(T0 + 35_000), "00:35");
    state = applyDelegationEnd(state, "done", T0 + 40_000);
    assert.equal(totalAt(T0 + 40_000), "00:40");
    state = applyDelegationStart(state, "verify", T0 + 45_000);
    assert.equal(totalAt(T0 + 55_000), "00:55");
    state = applyDelegationEnd(state, "done", T0 + 60_000);
    assert.equal(totalAt(T0 + 65_000), "01:05");
    assert.equal(state.runUsage.startedAt, T0);
  });

  it("distinguishes child time from the total and freezes a finished child's duration", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyDelegationStart(state, "worker", T0 + 20_000);
    state = { ...state, agents: [record({ startedAt: T0 + 20_000, currentActivity: "Editing" })] };
    let text = renderRightRail(snapOf(state), T0 + 31_000, { width: 46 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "00:31");
    assert.match(text, /Worker activo · agente 00:11/u);
    state = applyDelegationEnd(state, "done", T0 + 35_000);
    state = { ...state, agents: [record({ startedAt: T0 + 20_000, finishedAt: T0 + 35_000, status: "completed" })] };
    text = renderRightRail(snapOf(state), T0 + 50_000, { width: 46 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "00:50");
    assert.match(text, /Worker completado · agente 00:15/u);
  });

  it("falls back to the run start while the run is active without a stage", () => {
    const state = applyRunStart(createState(T0), T0 + 60_000);
    const text = renderRightRail(snapOf(state), T0 + 90_000, { width: 46 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "00:30");
  });

  it("freezes the run time at the DONE moment", () => {
    const state = applyRunStart(createState(T0), T0);
    const text = renderRightRail(snapOf(state), T0 + 120_000, { width: 46, runEndedAt: T0 + 60_000 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "01:00");
  });

  it("shows a dash at IDLE and never a fake 00:00", () => {
    const text = renderRightRail(snapOf(createState(T0)), T0 + 90_000, { width: 46 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "—");
    assert.equal(text.includes("00:00"), false, text);
  });

  it("does not keep a finished stage's time once the delegation ends", () => {
    let state = applyDelegationStart(createState(T0), "worker", T0);
    state = applyDelegationEnd(state, "done", T0 + 5_000);
    const text = renderRightRail(snapOf(state), T0 + 90_000, { width: 46 }).join("\n");
    assert.equal(railStatusValue(text, "Tiempo total"), "—");
    assert.equal(text.includes("00:05"), false, text);
  });
});

describe("right rail live cost (Coste)", () => {
  it("never renders a fake $0.00 for an unobserved Agents bucket", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 1_000, cost: 0.1 }, [], T0);
    state = applyRunUsage(state, { totalTokens: 2_000, cost: 0.3 }, [], T0 + 1_000);

    const text = renderRightRail(snapOf(state), T0 + 1_000, { width: 46 }).join("\n");
    assert.match(text, /Coste/u);
    assert.equal(railSectionValue(text, "Coste", "Agents"), "—", "no children means an unknown Agents cost");
    assert.equal(text.includes("$0.00"), false, `a fabricated zero leaked:\n${text}`);
  });

  it("renders a genuinely observed zero cost as $0.00", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 1_000, cost: null }, [record({ totalTokens: 5, cost: 0 })], T0);
    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");
    assert.match(text, /Coste/u);
    assert.equal(railSectionValue(text, "Coste", "Agents"), "$0.00");
  });

  it("sums only observed buckets into Total and excludes unknown ones", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 1_000, cost: null }, [record({ totalTokens: 5, cost: 0.25 })], T0);
    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");
    assert.equal(railSectionValue(text, "Coste", "Main"), "—");
    assert.equal(railSectionValue(text, "Coste", "Agents"), "$0.25");
    assert.equal(railSectionValue(text, "Coste", "Total"), "$0.25");
  });

  it("keeps Total unknown when neither bucket was observed", () => {
    const state = applyRunStart(createState(T0), T0);
    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");
    assert.match(text, /Coste/u);
    assert.equal(railSectionValue(text, "Coste", "Main"), "—");
    assert.equal(railSectionValue(text, "Coste", "Agents"), "—");
    assert.equal(railSectionValue(text, "Coste", "Total"), "—");
    assert.equal(text.includes("$0.00"), false, text);
  });

  it("omits the cost and token sections when nothing is in flight and nothing was measured", () => {
    const text = renderRightRail(snapOf(createState(T0)), T0, { width: 46 }).join("\n");
    assert.equal(text.includes("Coste"), false, text);
    assert.equal(text.includes("Tokens"), false, text);
  });
});

describe("right rail live tokens", () => {
  it("renders dashes before any run sample and real values once observed", () => {
    let state = applyRunStart(createState(T0), T0);

    const before = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");
    assert.match(before, /Tokens/u);
    assert.equal(railSectionValue(before, "Tokens", "Main"), "—");
    assert.equal(railSectionValue(before, "Tokens", "Agents"), "—");
    assert.equal(railSectionValue(before, "Tokens", "Total"), "—");

    state = applyRunUsage(state, { totalTokens: 1_000, cost: null }, [], T0 + 1_000);
    state = applyRunUsage(state, { totalTokens: 13_000, cost: null }, [record({ totalTokens: 4_000, cost: null })], T0 + 31_000);

    const after = renderRightRail(snapOf(state), T0 + 31_000, { width: 46 }).join("\n");
    assert.equal(railSectionValue(after, "Tokens", "Main"), "12k");
    assert.equal(railSectionValue(after, "Tokens", "Agents"), "4k");
    assert.equal(railSectionValue(after, "Tokens", "Total"), "16k");
  });

  it("shows the updated token value after a later sample", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 1_000, cost: null }, [], T0);
    state = applyRunUsage(state, { totalTokens: 6_000, cost: null }, [], T0 + 1_000);

    const first = renderRightRail(snapOf(state), T0 + 1_000, { width: 46 }).join("\n");
    assert.equal(railSectionValue(first, "Tokens", "Main"), "5k");

    state = applyRunUsage(state, { totalTokens: 11_000, cost: null }, [], T0 + 2_000);
    const second = renderRightRail(snapOf(state), T0 + 2_000, { width: 46 }).join("\n");
    assert.equal(railSectionValue(second, "Tokens", "Main"), "10k");
  });
});
