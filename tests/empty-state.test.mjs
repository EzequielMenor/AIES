/**
 * AIES UI v1 real-bugfix / BUG 2 idle-shell checks.
 *
 * The empty state and the idle-gated Todos are both pure projections of the
 * transcript and the live run signals. These tests drive real runtime state
 * (built through the actual appliers) and the pure renderers, with no Pi runtime,
 * no terminal and `PLAIN_PAINT`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { emptyStateWanted, hasHumanTranscript, renderEmptyState } from "../extensions/aies-ui/empty-state.ts";
import { deriveTodos, renderTodos } from "../extensions/aies-ui/todos.ts";
import { PLAIN_PAINT } from "../extensions/aies-ui/paint.ts";
import {
  applyAgents,
  applyDelegationEnd,
  applyDelegationStart,
  applyTicketObservationSync,
  applyVerificationReport,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";

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

/** Snapshot plus the observatory records, exactly like the panel fixtures build it. */
function snapOf(state) {
  return { ...toSnapshot(state), agents: state.agents };
}

/** The all-clear signal set for the empty-state gate. */
const FRESH = {
  userTranscriptSeen: false,
  isIdle: true,
  hasActivity: false,
  ticketActive: false,
  activeRole: undefined,
};

describe("hasHumanTranscript", () => {
  it("detects a structural user message and nothing else", () => {
    assert.equal(
      hasHumanTranscript([{ type: "message", message: { role: "user", content: "hola" } }]),
      true,
    );
    assert.equal(hasHumanTranscript([{ type: "message", message: { role: "assistant", content: "hi" } }]), false);
  });

  it("ignores every entry that is not a user message", () => {
    const noise = [
      { type: "custom", customType: "aies-metrics", data: {} },
      { type: "label", label: "checkpoint" },
      { type: "compaction" },
      { type: "message", message: { role: "toolResult" } },
      { type: "message", message: "not an object" },
      { type: "message", message: [] },
      { type: "message" },
      "garbage",
      null,
      42,
      [],
      {},
    ];
    assert.equal(hasHumanTranscript(noise), false);
  });

  it("treats a non-array or empty transcript as no human message", () => {
    assert.equal(hasHumanTranscript([]), false);
    assert.equal(hasHumanTranscript(undefined), false);
    assert.equal(hasHumanTranscript("not an array"), false);
    assert.equal(hasHumanTranscript({}), false);
  });
});

describe("emptyStateWanted", () => {
  it("wants the empty state only for a genuinely fresh, idle session", () => {
    assert.equal(emptyStateWanted(FRESH), true);
    assert.equal(emptyStateWanted({ ...FRESH, userTranscriptSeen: true }), false);
    assert.equal(emptyStateWanted({ ...FRESH, isIdle: false }), false);
    assert.equal(emptyStateWanted({ ...FRESH, hasActivity: true }), false);
    assert.equal(emptyStateWanted({ ...FRESH, ticketActive: true }), false);
    assert.equal(emptyStateWanted({ ...FRESH, activeRole: "worker" }), false);
  });
});

describe("renderEmptyState", () => {
  it("renders the sober card with the editor hint as the last non-empty line", () => {
    const lines = renderEmptyState({ width: 80 });
    const text = lines.join("\n");

    assert.ok(text.includes("✧ AIES"), text);
    assert.ok(text.includes("¿Qué quieres hacer?"), text);
    assert.ok(text.includes("/aies-run"), text);
    assert.ok(text.includes("/agents"), text);
    assert.ok(text.includes("/aies-models"), text);
    assert.ok(text.includes("Escribe una tarea…  / para comandos"), text);

    const nonEmpty = lines.filter((line) => line.trim().length > 0);
    assert.equal(nonEmpty.at(-1).trim(), "Escribe una tarea…  / para comandos", text);

    assert.ok(lines.length <= 12, `too many rendered lines: ${lines.length}`);
    for (const line of lines) assert.ok(line.length <= 80, `line wider than 80: "${line}"`);
  });

  it("centers on wide terminals and left-aligns on narrow ones", () => {
    const wide = renderEmptyState({ width: 120 });
    const wideTitle = wide.find((line) => line.includes("✧ AIES"));
    assert.ok(wideTitle, "missing title");
    assert.ok(wideTitle.startsWith("  "), `title not centered: "${wideTitle}"`);
    assert.notEqual(wideTitle, "✧ AIES");

    const narrow = renderEmptyState({ width: 40 });
    const narrowTitle = narrow.find((line) => line.includes("✧ AIES"));
    assert.equal(narrowTitle, "✧ AIES");
    for (const line of narrow) assert.ok(line.length <= 40, `line wider than 40: "${line}"`);
  });

  it("defaults to PLAIN_PAINT and clamps tiny widths", () => {
    assert.deepEqual(renderEmptyState({ width: 80 }), renderEmptyState({ width: 80, paint: PLAIN_PAINT }));

    for (const line of renderEmptyState({ width: 5 })) {
      assert.ok(line.length <= 20, `line wider than the clamped width: "${line}"`);
    }
  });
});

describe("run-gated Todos", () => {
  it("gates the checklist until the run has a real signal", () => {
    const fresh = deriveTodos(snapOf(createState(T0)));
    assert.equal(fresh.idle, true);
    assert.deepEqual(fresh.items, []);
    assert.equal(fresh.total, 0);
    assert.equal(fresh.done, 0);
  });

  it("returns the canonical steps once a ticket is loaded", () => {
    const state = applyTicketObservationSync(createState(T0), {
      active: true,
      identifier: "EZE-417",
      status: "In Progress",
    });
    const todos = deriveTodos(snapOf(state));

    assert.equal(todos.idle, false);
    assert.deepEqual(
      todos.items.map((item) => item.label),
      ["Cargar ticket", "Implementar", "Verificar", "Sincronizar Linear", "Finalizar"],
    );
  });

  it("returns the projection as soon as one agent record exists", () => {
    const state = applyAgents(createState(T0), [record()]);
    const todos = deriveTodos(snapOf(state));

    assert.equal(todos.idle, false);
    assert.ok(todos.items.length > 0, "an agent record must lift the idle gate");
  });

  it("keeps the DONE semantics unchanged", () => {
    let state = applyTicketObservationSync(createState(T0), {
      active: true,
      identifier: "EZE-417",
      workState: "complete",
    });
    state = applyDelegationStart(state, "worker", T0);
    state = applyDelegationEnd(state, "done", T0 + 1_000);
    state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });

    const todos = deriveTodos(snapOf(state));
    assert.equal(todos.idle, false);
    assert.equal(todos.total, 5);
    assert.equal(todos.done, 5, JSON.stringify(todos.items));
  });
});

describe("renderTodos idle", () => {
  const idle = { items: [], done: 0, total: 0, idle: true };

  it("renders the heading plus the idle row at the full tier", () => {
    const lines = renderTodos(idle);
    assert.equal(lines[0], "Todos");
    assert.deepEqual(lines, ["Todos", "  — sin tarea activa"]);
  });

  it("renders the compact single-line form when the budget is tight", () => {
    assert.deepEqual(renderTodos(idle, { maxRows: 1 }), ["Todos · sin tarea activa"]);
    assert.deepEqual(renderTodos(idle, { maxRows: 0 }), []);
  });
});
