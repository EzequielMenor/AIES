/**
 * AIES-010C run telemetry checks (T3 wiring).
 *
 * Two layers, both deterministic:
 *
 * 1. The pure `state.ts` transitions (`applyRunStart`, `applyRunUsage`,
 *    `applyAgents`) are driven with plain objects: run baseline subtraction,
 *    Main excluding children, Agents summing the registry, Total counted once and
 *    unknown-cost propagation.
 * 2. The extension is driven through a fake `ExtensionAPI` with fake timers: the
 *    Parent usage is sampled from real assistant entries, a child event repaints
 *    once, the registry is reset per session and the single observer timer stays
 *    a single timer.
 *
 * No Pi runtime, no model, no terminal.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  applyAgents,
  applyRunStart,
  applyRunUsage,
  createState,
  fromSnapshot,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import aiesRuntime from "../extensions/aies-runtime/index.ts";
import { AgentObservatory, observatory } from "../extensions/aies-agents/observatory.ts";
import { publishObservatoryOn } from "../extensions/aies-agents/index.ts";
import {
  ContinuationController,
  setActiveContinuationController,
} from "../extensions/aies-agents/autonomy/controller.ts";

const ROOT = "/repo";
const T0 = 1_700_000_000_000;

const bucket = (totalTokens, cost) => ({ totalTokens, cost });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !≈ ${expected}`);

/** Observers opened by this suite's hosts, detached between tests. */
const bridges = [];

/**
 * A minimal, well-behaved `pi.events` bus for the harness. Pi loads each
 * extension through its own module registry, so the runtime does not share the
 * observatory singleton; the bus is the documented wire between them.
 */
function createBus() {
  const listeners = new Map();
  return {
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel, data) {
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
  };
}

/** Fake timers and a frozen clock: the runtime uses the globals, so we swap them. */
function installFakes() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;

  let now = T0;
  const intervals = [];
  const cleared = [];

  globalThis.setInterval = (fn, ms) => {
    const handle = { fn, ms, unref() {} };
    intervals.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    cleared.push(handle);
  };
  Date.now = () => now;

  return {
    intervals,
    cleared,
    advance(ms) {
      now += ms;
    },
    active() {
      return intervals.filter((handle) => !cleared.includes(handle));
    },
    lastInterval() {
      return intervals.at(-1);
    },
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      Date.now = realNow;
    },
  };
}

function assistantEntry(totalTokens, cost) {
  return { type: "message", message: { role: "assistant", usage: { totalTokens, cost: { total: cost } } } };
}

/**
 * A session entry list that counts how many times the runtime reads an indexed
 * entry. The observer must reduce each appended entry exactly once, so the count
 * is the observable proof that no sample rescans the whole session.
 */
function countingEntries(initial = []) {
  const target = [...initial];
  const reads = { total: 0 };
  const entries = new Proxy(target, {
    get(list, prop, receiver) {
      if (typeof prop === "string" && /^(0|[1-9]\d*)$/.test(prop)) reads.total += 1;
      return Reflect.get(list, prop, receiver);
    },
  });
  return {
    entries,
    reads,
    push(entry) {
      target.push(entry);
    },
  };
}

function createHost(overrides = {}) {
  const options = {
    mode: "tui",
    hasUI: true,
    cwd: ROOT,
    contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
    entries: [],
    activeTools: ["read", "bash"],
    sessionId: "session-1",
    sessionFile: "/profile/sessions/session-1.jsonl",
    model: { id: "model-a", provider: "anthropic", name: "Model A" },
    ...overrides,
  };

  const handlers = new Map();
  const commands = new Map();
  const appended = [];
  const footers = [];
  const headers = [];
  const renderRequests = { footer: 0 };
  const bus = createBus();

  const pi = {
    events: bus,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getActiveTools() {
      return options.activeTools;
    },
    appendEntry(type, data) {
      appended.push({ type, data });
    },
    registerEntryRenderer() {},
  };

  aiesRuntime(pi);
  // The runtime subscribes to the bus at `session_start`; the agents bridge is the
  // publisher that carries each registry mutation across the extension boundary.
  bridges.push(publishObservatoryOn(bus));

  const ctx = {
    mode: options.mode,
    hasUI: options.hasUI,
    cwd: options.cwd,
    get model() {
      return options.model;
    },
    getContextUsage() {
      return options.contextUsage;
    },
    sessionManager: {
      getSessionId: () => options.sessionId,
      getSessionFile: () => options.sessionFile,
      getEntries: () => options.entries,
    },
    ui: {
      theme: { fg: (_color, text) => text },
      setFooter(factory) {
        footers.push(factory);
      },
      setHeader(factory) {
        headers.push(factory);
      },
      setWidget() {},
      notify() {},
    },
  };

  async function emit(event, payload = {}) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...payload }, ctx));
    }
    return results;
  }

  /** Mount the installed footer so `requestRender` becomes observable. */
  function mountFooter() {
    const factory = footers.at(-1);
    assert.ok(typeof factory === "function", "no custom footer installed");
    const tui = { requestRender() { renderRequests.footer += 1; } };
    return factory(tui, { fg: (_color, text) => text }, {});
  }

  return { handlers, commands, appended, footers, renderRequests, ctx, options, emit, mountFooter };
}

describe("AIES-010C run usage (pure)", () => {
  it("subtracts the run baseline from the Parent lifetime usage", () => {
    let s = applyRunStart(createState(T0), T0);
    s = applyRunUsage(s, bucket(1_000, 0.5), [], T0 + 1);
    assert.equal(s.runUsage.active, true);
    assert.equal(s.runUsage.baseline.totalTokens, 1_000);
    assert.equal(s.runUsage.main.totalTokens, 0, "the baseline sample is the run's zero");
    assert.equal(s.runUsage.main.cost, 0);

    s = applyRunUsage(s, bucket(1_600, 0.9), [], T0 + 2);
    assert.equal(s.runUsage.main.totalTokens, 600);
    near(s.runUsage.main.cost, 0.4);
    assert.equal(s.runUsage.total.totalTokens, 600);
  });

  it("starts a fresh run and records its start time", () => {
    let s = applyRunUsage(createState(T0), bucket(1_000, 0.5), [bucket(10, 0.1)], T0);
    s = applyRunStart(s, T0 + 50);

    assert.equal(s.runUsage.active, true);
    assert.equal(s.runUsage.startedAt, T0 + 50);
    assert.equal(s.runUsage.baseline, null, "the next sample becomes the new baseline");
    assert.equal(s.runUsage.main.totalTokens, 0);
    assert.equal(s.runUsage.agents.totalTokens, 0);
    assert.equal(s.runUsage.total.totalTokens, 0);
  });

  it("keeps Main as the Parent-only bucket and Agents as the registry sum", () => {
    const s = applyRunUsage(createState(T0), bucket(1_000, 0.5), [bucket(200, 0.1), bucket(300, 0.2)], T0);

    assert.deepEqual(s.runUsage.main, { totalTokens: 1_000, cost: 0.5 }, "no child token ever enters Main");
    assert.equal(s.runUsage.agents.totalTokens, 500);
    near(s.runUsage.agents.cost, 0.30000000000000004);
  });

  it("keeps Main as the Parent usage even when the Parent already equals the children", () => {
    const s = applyRunUsage(createState(T0), bucket(400, 0.2), [bucket(400, 0.2)], T0);

    assert.equal(s.runUsage.main.totalTokens, 400);
    assert.equal(s.runUsage.agents.totalTokens, 400);
    assert.equal(s.runUsage.total.totalTokens, 800);
  });

  it("counts Total exactly once", () => {
    const s = applyRunUsage(createState(T0), bucket(1_000, 1), [bucket(200, 0.25), bucket(300, 0.25)], T0);

    assert.equal(s.runUsage.total.totalTokens, 1_500);
    assert.equal(s.runUsage.total.cost, 1.5);
    assert.notEqual(s.runUsage.total.totalTokens, 1_000 + 200 + 200 + 300 + 300);
  });

  it("propagates an unknown Parent cost to Main and Total", () => {
    const s = applyRunUsage(createState(T0), bucket(10, null), [bucket(5, 0.5)], T0);

    assert.equal(s.runUsage.main.cost, null);
    assert.equal(s.runUsage.total.cost, null);
  });

  it("keeps the last known Main when Pi cannot return a Parent sample", () => {
    let s = applyRunStart(createState(T0), T0);
    s = applyRunUsage(s, bucket(1_000, 0.5), [], T0);
    s = applyRunUsage(s, bucket(1_200, 0.6), [], T0 + 1);
    assert.equal(s.runUsage.main.totalTokens, 200);

    s = applyRunUsage(s, undefined, [bucket(50, 0.05)], T0 + 2);
    assert.equal(s.runUsage.main.totalTokens, 200, "a missing sample never zeroes Main");
    assert.equal(s.runUsage.agents.totalTokens, 50);
    assert.equal(s.runUsage.total.totalTokens, 250);
  });

  it("propagates an unknown child cost to Agents and Total", () => {
    const s = applyRunUsage(createState(T0), bucket(10, 1), [bucket(5, 0.5), bucket(2, null)], T0);

    assert.equal(s.runUsage.agents.cost, null);
    assert.equal(s.runUsage.total.cost, null);
  });

  it("never lowers a run number when the cumulative Parent usage floors", () => {
    let s = applyRunStart(createState(T0), T0);
    s = applyRunUsage(s, bucket(1_000, 0.5), [], T0);
    s = applyRunUsage(s, bucket(900, 0.4), [], T0 + 1);

    assert.equal(s.runUsage.main.totalTokens, 0);
    assert.equal(s.runUsage.main.cost, 0);
  });

  it("stores the immutable observatory projection without a transcript", () => {
    const obs = new AgentObservatory();
    obs.begin({ role: "worker", at: T0 });
    obs.observe("worker-1", "read", { path: "src/a.ts" }, T0);
    const snapshot = obs.snapshot();

    const s = applyAgents(createState(T0), snapshot);
    assert.deepEqual(s.agents.map((record) => record.id), ["worker-1"]);
    assert.deepEqual(s.agents, snapshot);
    assert.equal("usage" in s.runUsage, false, "run usage carries no raw transcript");
  });

  it("clears the projection for an empty or hostile snapshot", () => {
    assert.deepEqual(applyAgents(createState(T0), []).agents, []);
    assert.deepEqual(applyAgents(createState(T0), null).agents, []);
    assert.deepEqual(applyAgents(createState(T0), "not an array").agents, []);
  });

  it("never resurrects child records through a snapshot", () => {
    const obs = new AgentObservatory();
    obs.begin({ role: "worker", at: T0 });
    obs.finish("worker-1", { status: "completed", at: T0 + 1 });
    const s = applyAgents(createState(T0), obs.snapshot());

    const restored = fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(s))), T0);
    assert.deepEqual(restored.agents, [], "a resumed session must not resurrect a finished child");

    // Even a payload that explicitly carries agents is ignored on restore.
    const forced = fromSnapshot({ agents: [{ id: "worker-1", status: "running" }] }, T0);
    assert.deepEqual(forced.agents, []);
  });

  it("never persists the ephemeral agent projection", () => {
    const obs = new AgentObservatory();
    obs.begin({ role: "worker", at: T0 });
    obs.finish("worker-1", { status: "completed", at: T0 + 1 });

    const payload = toSnapshot(applyAgents(createState(T0), obs.snapshot()));
    assert.equal("agents" in payload, false, "the persisted snapshot never carries child records");
  });

  it("round-trips run usage through a snapshot", () => {
    let s = applyRunStart(createState(T0), T0);
    s = applyRunUsage(s, bucket(1_000, 0.5), [bucket(200, 0.1)], T0 + 1);
    s = applyRunUsage(s, bucket(1_500, 0.8), [bucket(200, 0.1)], T0 + 2);

    const original = toSnapshot(s).runUsage;
    const restored = toSnapshot(fromSnapshot(JSON.parse(JSON.stringify(toSnapshot(s))), T0)).runUsage;

    assert.deepEqual(restored, original);
    assert.equal(restored.active, true);
  });

  it("defaults to an inactive run for an old snapshot", () => {
    const restored = toSnapshot(fromSnapshot({ toolCalls: 3 }, T0)).runUsage;

    assert.equal(restored.active, false);
    assert.equal(restored.startedAt, undefined);
    assert.equal(restored.main.totalTokens, 0);
    assert.equal(restored.total.totalTokens, 0);
  });
});

describe("AIES-010C run telemetry wiring", () => {
  let timers;

  beforeEach(() => {
    timers = installFakes();
  });

  afterEach(() => {
    for (const detach of bridges.splice(0)) detach();
    timers.restore();
    setActiveContinuationController(undefined);
    observatory.reset();
  });

  it("keeps exactly one live interval through a child edge and many samples", async () => {
    const host = createHost();
    await host.emit("session_start", { reason: "startup" });
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.active().length, 1);

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement it" } });
    assert.equal(timers.intervals.length, 2, "the child edge re-arms the single interval");
    assert.equal(timers.cleared.includes(timers.intervals[0]), true);
    assert.equal(timers.active().length, 1, "never two live timers");

    for (let index = 0; index < 4; index += 1) {
      await host.emit("tool_result", { toolName: "read", content: "x" });
    }
    assert.equal(timers.active().length, 1, "sampling usage adds no timer");

    await host.emit("session_shutdown", { reason: "quit" });
    assert.equal(timers.active().length, 0);
  });

  it("records a run start when autonomy starts a ticket run", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const host = createHost();
    await host.emit("session_start", { reason: "startup" });

    controller.enable("EZE-1");
    await host.emit("tool_result", { toolName: "read", content: "x" });
    await host.emit("session_shutdown", { reason: "quit" });
    const runUsage = persisted(host).runUsage;
    assert.equal(runUsage.active, true);
    assert.equal(runUsage.startedAt, T0);
  });

  it("shows Parent usage since the run baseline, never the whole session", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const host = createHost({ entries: [assistantEntry(900, 0.4)] });
    await host.emit("session_start", { reason: "startup" });

    // The run starts while the Parent has already spent 900 tokens.
    controller.enable("EZE-2");
    await host.emit("tool_result", { toolName: "read", content: "x" });

    // The Parent keeps working after the baseline sample (one more turn's usage).
    host.options.entries.push(assistantEntry(500, 0.3));
    await host.emit("tool_result", { toolName: "read", content: "y" });
    await host.emit("session_shutdown", { reason: "quit" });

    const runUsage = persisted(host).runUsage;
    assert.equal(runUsage.baseline.totalTokens, 900, "the baseline is the run's zero");
    assert.equal(runUsage.main.totalTokens, 500, "only usage since the baseline counts");
    near(runUsage.main.cost, 0.3);
    assert.equal(runUsage.total.totalTokens, 500);
  });

  it("keeps child usage out of Main, puts it in Agents and counts Total once", async () => {
    const host = createHost({ entries: [assistantEntry(1_000, 0.5)] });
    await host.emit("session_start", { reason: "startup" });

    observatory.begin({ role: "worker", at: T0 });
    observatory.updateUsage("worker-1", { totalTokens: 400, cost: 0.2 });
    await host.emit("tool_result", { toolName: "read", content: "x" });
    await host.emit("session_shutdown", { reason: "quit" });

    const runUsage = persisted(host).runUsage;
    assert.equal(runUsage.main.totalTokens, 1_000, "Main is Parent-only");
    assert.equal(runUsage.agents.totalTokens, 400);
    assert.equal(runUsage.total.totalTokens, 1_400, "Total counted once");
    near(runUsage.total.cost, 0.7);
  });

  it("repaints once per child observatory event and unsubscribes on shutdown", async () => {
    const host = createHost();
    await host.emit("session_start", { reason: "startup" });
    host.mountFooter();
    const before = host.renderRequests.footer;

    observatory.begin({ role: "worker", at: T0 });
    assert.equal(host.renderRequests.footer, before + 1, "one child event, one repaint");

    await host.emit("session_shutdown", { reason: "quit" });
    const after = host.renderRequests.footer;
    observatory.finish("worker-1", { status: "completed", at: T0 + 1 });
    assert.equal(host.renderRequests.footer, after, "no repaint after unsubscribe");
  });

  it("starts a new session from an empty projection", async () => {
    const host = createHost();
    await host.emit("session_start", { reason: "startup" });
    observatory.begin({ role: "worker", at: T0 });
    observatory.updateUsage("worker-1", { totalTokens: 400, cost: 0.2 });
    await host.emit("tool_result", { toolName: "read", content: "x" });

    await host.emit("session_start", { reason: "new" });
    // The registry is owned by the agents extension and may still hold the old
    // record; the runtime's projection must not, so nothing leaks across sessions.
    await host.emit("tool_result", { toolName: "read", content: "y" });
    await host.emit("session_shutdown", { reason: "quit" });

    const runUsage = persisted(host).runUsage;
    assert.equal(runUsage.agents.totalTokens, 0, "a new session starts from an empty projection");
  });

  it("reduces each appended entry exactly once across repeated samples", async () => {
    const log = countingEntries();
    const host = createHost({ entries: log.entries });
    await host.emit("session_start", { reason: "new" });
    log.reads.total = 0;

    log.push(assistantEntry(100, 0.1));
    await host.emit("tool_result", { toolName: "read", content: "a" });
    assert.equal(log.reads.total, 1, "the first sample reads the single entry once");

    log.push(assistantEntry(200, 0.2));
    await host.emit("tool_result", { toolName: "read", content: "b" });
    assert.equal(log.reads.total, 2, "a later sample reduces only the appended entry, never rescanning");

    log.push(assistantEntry(300, 0.3));
    await host.emit("tool_result", { toolName: "read", content: "c" });
    assert.equal(log.reads.total, 3, "each entry is read exactly once across all samples");

    // A skipped (non-message) entry still advances the cursor exactly once, and an
    // unknown cost must keep propagating once it is seen.
    log.push({ type: "custom", customType: "aies-note", data: {} });
    await host.emit("tool_result", { toolName: "read", content: "d" });
    assert.equal(log.reads.total, 4, "a skipped entry is still reduced exactly once");

    log.push(assistantEntry(50, undefined));
    await host.emit("tool_result", { toolName: "read", content: "e" });
    assert.equal(log.reads.total, 5, "an unknown-cost entry is read exactly once");

    await host.emit("session_shutdown", { reason: "quit" });
    const runUsage = persisted(host).runUsage;
    assert.equal(runUsage.main.totalTokens, 650, "incremental reduction keeps the cumulative total");
    assert.equal(runUsage.main.cost, null, "one unknown cost keeps Main cost unknown");
  });

  it("resets the usage cache on a session start so a new session starts from zero", async () => {
    const host = createHost({ entries: [assistantEntry(500, 0.5)] });
    await host.emit("session_start", { reason: "startup" });
    await host.emit("tool_result", { toolName: "read", content: "x" });

    // A new session replaces the entry list with its own lifetime usage.
    host.options.entries = [assistantEntry(700, 0.7)];
    await host.emit("session_start", { reason: "new" });
    await host.emit("tool_result", { toolName: "read", content: "y" });
    await host.emit("session_shutdown", { reason: "quit" });

    const runUsage = persisted(host).runUsage;
    assert.equal(runUsage.main.totalTokens, 700, "the new session's entries are counted, not inherited");
    near(runUsage.main.cost, 0.7);
    assert.equal(runUsage.baseline, null, "no run baseline crosses a session start");
  });

  it("degrades to silence when the session entries cannot answer", async () => {
    const host = createHost({
      entries: () => {
        throw new Error("no entries yet");
      },
    });
    await host.emit("session_start", { reason: "startup" });
    assert.deepEqual(await host.emit("tool_result", { toolName: "read", content: "x" }), [undefined]);
  });
});

/** The run usage a host persisted on its last shutdown, defensively. */
function persisted(host) {
  const entries = host.appended.filter((entry) => entry.type === "aies-metrics");
  assert.ok(entries.length, "no metrics snapshot was persisted");
  return entries.at(-1).data;
}
