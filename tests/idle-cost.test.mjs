/**
 * Idle run-cost semantics (live-rail defect on the fullscreen shell).
 *
 * A fresh session that never started a run still samples the Parent usage. For a
 * session with no assistant usage entry, Pi's sampler reports an all-zero
 * cumulative bucket (`{ totalTokens: 0, cost: 0 }`). That zero is not an
 * observation: treating it as one fabricates a `$0.00` on the rail at IDLE.
 *
 * The run store is the source of truth for observed versus unknown, so the state
 * built through the real appliers (`createState` + `applyRunUsage` / `applyRunStart`
 * + `toSnapshot`) must keep every unobserved cost `null`, and `renderRightRail`
 * must render `—`. A genuinely observed zero cost always arrives with a nonzero
 * token count and still renders `$0.00`.
 *
 * Construction mirrors the runtime's `uiSnapshot()` (`toSnapshot` + the ephemeral
 * `agents` projection). No Pi runtime, no terminal, no timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRunStart,
  applyRunUsage,
  createState,
  fromSnapshot,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderRightRail } from "../extensions/aies-ui/right-rail.ts";

const T0 = 1_700_000_000_000;

/**
 * The exact cumulative sample `parentUsageOf()` returns for a session whose entry
 * list holds no assistant usage record: the incremental cache is seeded
 * `{ cost: 0, costKnown: true }` and reduced over zero entries.
 */
const EMPTY_PARENT_SAMPLE = { totalTokens: 0, cost: 0 };

/** The runtime's `uiSnapshot()`: the persisted projection plus the live records. */
function snapOf(state) {
  return { ...toSnapshot(state), agents: state.agents };
}

/** A boxed row with its frame and trailing padding stripped. */
function cleanRow(line) {
  return line.replace(/^│\s*/u, "").replace(/\s*│\s*$/u, "").trimEnd();
}

/** One bucket value inside a section, e.g. `Agents` under `Coste`. */
function railSectionValue(text, section, label) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => cleanRow(line) === section);
  assert.ok(start >= 0, `no "${section}" section:\n${text}`);
  for (let index = start + 1; index < lines.length; index += 1) {
    const row = cleanRow(lines[index]);
    if (["Status", "Tokens", "Coste", "Agents", "Todos"].includes(row)) break;
    const match = row.match(new RegExp(`^\\s*${label}\\s+(\\S+)$`, "u"));
    if (match) return match[1];
  }
  assert.fail(`no "${label}" bucket under "${section}":\n${text}`);
}

describe("idle run cost (fresh session, no run started)", () => {
  it("keeps Main/Agents/Total unknown for the empty Parent sample the sampler reports", () => {
    const state = applyRunUsage(createState(T0), EMPTY_PARENT_SAMPLE, [], T0);

    assert.equal(state.runUsage.main.cost, null, "an all-zero sample is not an observed cost");
    assert.equal(state.runUsage.agents.cost, null);
    assert.equal(state.runUsage.total.cost, null);
  });

  it("renders no fabricated $0.00 and omits the usage block at IDLE", () => {
    const state = applyRunUsage(createState(T0), EMPTY_PARENT_SAMPLE, [], T0);
    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");

    assert.equal(text.includes("$0.00"), false, `a fabricated zero leaked:\n${text}`);
    // Shipped semantics: with nothing measured, neither usage section is drawn.
    assert.equal(text.includes("Coste"), false, text);
    assert.equal(text.includes("Tokens"), false, text);
  });

  it("keeps the empty sample unknown during an active run, showing a dash per row", () => {
    const state = applyRunUsage(applyRunStart(createState(T0), T0), EMPTY_PARENT_SAMPLE, [], T0);
    assert.equal(state.runUsage.main.cost, null);

    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");
    assert.match(text, /Coste/u);
    assert.equal(railSectionValue(text, "Coste", "Main"), "—");
    assert.equal(railSectionValue(text, "Coste", "Agents"), "—");
    assert.equal(railSectionValue(text, "Coste", "Total"), "—");
    assert.equal(text.includes("$0.00"), false, text);
  });

  it("never persists the fabricated idle zero into the snapshot", () => {
    const state = applyRunUsage(createState(T0), EMPTY_PARENT_SAMPLE, [], T0);

    assert.equal(toSnapshot(state).runUsage.main.cost, null);
    const restored = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(state))), T0);
    assert.equal(restored.runUsage.main.cost, null);
    assert.equal(restored.runUsage.total.cost, null);
  });

  it("still renders a genuinely observed zero cost as $0.00", () => {
    // A free model that really spent tokens but reports cost 0.
    const state = applyRunUsage(createState(T0), { totalTokens: 500, cost: 0 }, [], T0);
    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");

    assert.match(text, /Coste/u);
    assert.equal(railSectionValue(text, "Coste", "Main"), "$0.00");
    assert.equal(railSectionValue(text, "Coste", "Agents"), "—");
    assert.equal(railSectionValue(text, "Coste", "Total"), "$0.00");
  });
});
