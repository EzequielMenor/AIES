/**
 * AIES-010D right-rail visual hierarchy checks (T5).
 *
 * The rail is pure: a snapshot in, boxed lines out. These tests assert the
 * semantic tones the rail names through the injected `Paint` — labels muted,
 * values in their own tone, the `Etapa` value and each agent row painted per
 * state — and that the label/value columns stay aligned.
 *
 * They record `paint.fg` calls instead of snapshotting whole framed lines, and
 * the recording stub returns the text unchanged so layout can still be measured
 * on plain output. No Pi runtime, no terminal, no timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyAgents,
  applyAutonomySync,
  applyContextUsage,
  applyDelegationStart,
  applyModel,
  applyRunStart,
  applyRunUsage,
  applyTicketObservationSync,
  applyVerificationReport,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { PLAIN_PAINT } from "../extensions/aies-ui/paint.ts";
import { renderRightRail } from "../extensions/aies-ui/right-rail.ts";
import { STAGE_TONE } from "../extensions/aies-ui/vocabulary.ts";

const T0 = 1_700_000_000_000;

/** The value column the longest Status label (`Proveedor`) fixes. */
const VALUE_COLUMN = 10;

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

/** A `Paint` that records every `fg(color, text)` call and returns the text plain. */
function recordingPaint() {
  const calls = [];
  return {
    calls,
    fg(color, text) {
      calls.push({ color, text });
      return text;
    },
  };
}

function callsWith(paint, color, predicate = () => true) {
  return paint.calls.filter((call) => call.color === color && predicate(call.text));
}

/** Strip the `│ ` / ` │` frame from a content row, preserving its inner spacing. */
function cellOf(line) {
  assert.ok(line.startsWith("│ ") && line.endsWith(" │"), `not a content row: ${JSON.stringify(line)}`);
  return line.slice(2, -2);
}

function richState() {
  let state = createState(T0);
  state = applyTicketObservationSync(state, { active: true, identifier: "EZE-417", status: "In Progress" });
  state = applyContextUsage(state, { tokens: 42_000, contextWindow: 200_000 });
  state = applyModel(state, { id: "qwen3.8-flash", provider: "openrouter", name: "Qwen 3.8 Flash" });
  state = applyDelegationStart(state, "worker", T0);
  state = applyAgents(state, [record()]);
  state = applyRunStart(state, T0);
  return state;
}

/** One representative snapshot per workflow stage. */
function stageStates() {
  const repairing = applyDelegationStart(
    applyVerificationReport(createState(T0), { status: "fail", valid: false, attempts: 1 }),
    "worker",
    T0,
  );
  return {
    IDLE: createState(T0),
    EXPLORE: applyDelegationStart(createState(T0), "explore", T0),
    WORK: applyDelegationStart(createState(T0), "worker", T0),
    VERIFY: applyDelegationStart(createState(T0), "verify", T0),
    REPAIR: repairing,
    WAIT: applyAutonomySync(createState(T0), { enabled: true, stopReason: "user_required" }),
    BLOCKED: applyAutonomySync(createState(T0), { enabled: true, stopReason: "blocked" }),
    DONE: applyVerificationReport(createState(T0), { status: "pass", valid: true, attempts: 1 }),
  };
}

describe("right rail hierarchy: titles and tones", () => {
  it("keeps the section titles accent-colored", () => {
    const paint = recordingPaint();
    renderRightRail(snapOf(richState()), T0 + 31_000, { width: 46, paint, project: "/repo/AIES", branch: "main" });

    for (const title of ["Status", "Agents", "Todos"]) {
      assert.ok(
        callsWith(paint, "accent", (text) => text.trim() === title).length > 0,
        `section title "${title}" is not painted with the accent tone`,
      );
    }
  });

  it("paints every Status label muted and every value outside muted", () => {
    const paint = recordingPaint();
    renderRightRail(snapOf(richState()), T0 + 31_000, { width: 46, paint, project: "/repo/AIES", branch: "main" });

    const labels = ["Proyecto", "Rama", "Ticket", "Etapa", "Modelo", "Proveedor", "Contexto", "Tiempo"];
    for (const label of labels) {
      assert.ok(
        callsWith(paint, "muted", (text) => text.trim() === label).length > 0,
        `label "${label}" is not painted with the muted tone`,
      );
    }

    // Values keep their own tone: a representative value is never muted.
    for (const value of ["AIES", "main", "EZE-417", "Qwen 3.8 Flash", "openrouter", "42k", "00:31", "◆ WORK"]) {
      assert.equal(
        callsWith(paint, "muted", (text) => text === value).length,
        0,
        `value "${value}" must not be painted muted`,
      );
    }
  });

  it("paints the Etapa value with its stage tone and glyph for every stage", () => {
    for (const [stage, state] of Object.entries(stageStates())) {
      const paint = recordingPaint();
      renderRightRail(snapOf(state), T0, { width: 46, paint });

      const tone = STAGE_TONE[stage];
      const value = callsWith(paint, tone, (text) => text.endsWith(` ${stage}`));
      assert.ok(value.length > 0, `stage ${stage} is not painted with ${tone}`);
      assert.match(value[0].text, /^\S+ .+$/u, `stage ${stage} value is missing its glyph: ${value[0].text}`);
    }
  });

  it("paints the ticket as the one accented identity value", () => {
    const paint = recordingPaint();
    renderRightRail(snapOf(richState()), T0 + 31_000, { width: 46, paint, project: "/repo/AIES", branch: "main" });

    assert.ok(
      callsWith(paint, "accent", (text) => text === "EZE-417").length > 0,
      "the ticket value is not painted with the accent tone",
    );
  });

  it("paints each agent row with the tone of its lifecycle state", () => {
    let state = applyDelegationStart(createState(T0), "worker", T0);
    state = applyAgents(state, [
      record({ id: "worker-1", role: "worker", status: "running" }),
      record({ id: "explore-1", role: "explore", status: "completed", startedAt: T0 + 1, finishedAt: T0 + 5_000 }),
      record({ id: "verify-1", role: "verify", status: "failed", startedAt: T0 + 2, finishedAt: T0 + 6_000 }),
    ]);

    const paint = recordingPaint();
    renderRightRail(snapOf(state), T0 + 31_000, { width: 46, paint });

    assert.ok(callsWith(paint, "running", (text) => text.includes("activo")).length > 0, "running agent not painted running");
    assert.ok(callsWith(paint, "success", (text) => text.includes("completado")).length > 0, "completed agent not painted success");
    assert.ok(callsWith(paint, "error", (text) => text.includes("falló")).length > 0, "failed agent not painted error");
  });

  it("paints a blocked agent with the warning tone", () => {
    let state = applyDelegationStart(createState(T0), "worker", T0);
    state = applyAgents(state, [record({ id: "worker-1", role: "worker", status: "blocked" })]);

    const paint = recordingPaint();
    renderRightRail(snapOf(state), T0, { width: 46, paint });
    assert.ok(callsWith(paint, "warning", (text) => text.includes("bloqueado")).length > 0, "blocked agent not painted warning");
  });
});

describe("right rail hierarchy: alignment and layout invariance", () => {
  it("aligns every Status value in the longest-label column", () => {
    const cell = renderRightRail(snapOf(richState()), T0 + 31_000, {
      width: 46,
      project: "/repo/AIES",
      branch: "main",
    })
      .filter((line) => line.startsWith("│ "))
      .map(cellOf);

    for (const label of ["Proyecto", "Rama", "Ticket", "Etapa", "Modelo", "Proveedor", "Contexto", "Tiempo"]) {
      const row = cell.find((line) => line.startsWith(label));
      assert.ok(row, `no "${label}" row`);
      const valueStart = label.length + row.slice(label.length).search(/\S/u);
      assert.equal(valueStart, VALUE_COLUMN, `"${label}" value starts at ${valueStart}, not ${VALUE_COLUMN}: ${JSON.stringify(row)}`);
    }
  });

  it("aligns the token and cost buckets in the same value column", () => {
    let state = applyRunStart(createState(T0), T0);
    state = applyRunUsage(state, { totalTokens: 1_000, cost: 0.01 }, [], T0);
    state = applyRunUsage(state, { totalTokens: 13_000, cost: 0.05 }, [record({ totalTokens: 4_000, cost: 0.02 })], T0 + 31_000);

    const cells = renderRightRail(snapOf(state), T0 + 31_000, { width: 46 })
      .filter((line) => line.startsWith("│ "))
      .map(cellOf);
    for (const name of ["Main", "Agents", "Total"]) {
      const row = cells.find((line) => line.trimStart().startsWith(name) && line.startsWith("  "));
      assert.ok(row, `no "${name}" bucket row`);
      const nameIndex = row.indexOf(name);
      const start = nameIndex + name.length + row.slice(nameIndex + name.length).search(/\S/u);
      assert.equal(start, VALUE_COLUMN, `"${name}" bucket value starts at ${start}, not ${VALUE_COLUMN}: ${JSON.stringify(row)}`);
    }
  });

  it("never lets color change the layout", () => {
    const snap = snapOf(richState());
    const plain = renderRightRail(snap, T0 + 31_000, { width: 46, paint: PLAIN_PAINT, project: "/repo/AIES", branch: "main" });
    const painted = renderRightRail(snap, T0 + 31_000, { width: 46, paint: recordingPaint(), project: "/repo/AIES", branch: "main" });
    assert.deepEqual(painted, plain);
  });

  it("never emits a raw ANSI escape", () => {
    const text = renderRightRail(snapOf(richState()), T0 + 31_000, {
      width: 46,
      paint: recordingPaint(),
      project: "/repo/AIES",
      branch: "main",
    }).join("\n");
    assert.equal(text.includes("\u001b"), false, "the pure renderer must not hardcode ANSI");
  });
});
