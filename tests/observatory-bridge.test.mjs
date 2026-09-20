/**
 * AIES-010C observatory bridge checks (defect fix).
 *
 * The live TUI smoke proved this defect: `aies-agents` and `aies-runtime` are
 * loaded as separate Pi extensions, each with its own module registry, so the
 * `observatory` singleton the registry mutates is **not** the one the runtime
 * read. `/aies-status` said `worker terminado / verify activo` while the panel
 * said `Agentes … 0`, `Tokens Agents 0` and `/agents` said
 * `sin agentes en esta sesión`.
 *
 * The documented replacement is the shared `pi.events` bus. This suite exercises
 * that contract without a real Pi host:
 *
 * 1. Every registry mutation in the agents extension is re-published exactly once
 *    on the `aies:agents` channel and reaches the runtime projection.
 * 2. A throwing subscriber never breaks emission or the child run.
 * 3. A missing publisher (or an unreadable payload) leaves an empty registry and
 *    never crashes.
 * 4. A new session starts from an empty projection.
 * 5. The bus path never reaches `sendMessage`.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesAgents from "../extensions/aies-agents/index.ts";
import {
  setActiveContinuationController,
} from "../extensions/aies-agents/autonomy/controller.ts";
import { AGENTS_CHANNEL, observatory } from "../extensions/aies-agents/observatory.ts";
import aiesRuntime from "../extensions/aies-runtime/index.ts";

const ROOT = "/repo";
const T0 = 1_700_000_000_000;
const plainTheme = { fg: (_color, text) => text };

/** A naive bus whose `emit` propagates a throwing listener, to prove the guard. */
function createBus() {
  const listeners = new Map();
  const emissions = [];
  return {
    emissions,
    on(channel, handler) {
      const set = listeners.get(channel) ?? new Set();
      set.add(handler);
      listeners.set(channel, set);
      return () => set.delete(handler);
    },
    emit(channel, data) {
      emissions.push({ channel, data });
      for (const handler of [...(listeners.get(channel) ?? [])]) handler(data);
    },
    emitted(channel) {
      return emissions.filter((entry) => entry.channel === channel);
    },
  };
}

/** Drive the real agents extension with the shared bus as its event surface. */
function createAgentsHost(bus) {
  const tools = [];
  const commands = [];
  const pi = {
    events: bus,
    on() {},
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name) {
      commands.push(name);
    },
    getAllTools() {
      return [];
    },
    appendEntry() {},
    sendUserMessage() {},
  };
  aiesAgents(pi);
  return { pi, tools, commands };
}

/** Drive the real runtime extension in `print` mode, where `/agents` uses notify. */
function createRuntimeHost(bus) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const sendMessages = [];

  const pi = {
    events: bus,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool() {},
    getActiveTools() {
      return [];
    },
    appendEntry() {},
    registerEntryRenderer() {},
    sendMessage(...args) {
      sendMessages.push(args);
    },
    sendUserMessage(...args) {
      sendMessages.push(args);
    },
  };
  aiesRuntime(pi);

  const ctx = {
    mode: "print",
    hasUI: true,
    cwd: ROOT,
    model: { id: "model-a", provider: "anthropic", name: "Model A" },
    getContextUsage() {
      return { tokens: 10_000, contextWindow: 200_000, percent: 5 };
    },
    sessionManager: {
      getSessionId: () => "session-1",
      getSessionFile: () => "/profile/sessions/session-1.jsonl",
      getEntries: () => [],
    },
    ui: {
      theme: plainTheme,
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };

  async function emit(event, payload = {}) {
    for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
  }

  return {
    pi,
    ctx,
    commands,
    notifications,
    sendMessages,
    emit,
    start: (reason = "startup") => emit("session_start", { reason }),
    async agentsView() {
      await commands.get("agents").handler("", ctx);
      return notifications.at(-1)?.message ?? "";
    },
  };
}

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

describe("observatory inter-extension bridge", () => {
  let bus;

  beforeEach(() => {
    bus = createBus();
    observatory.reset();
  });

  afterEach(() => {
    setActiveContinuationController(undefined);
    observatory.reset();
  });

  it("re-publishes exactly one snapshot per registry mutation", () => {
    createAgentsHost(bus);

    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: T0 });
    assert.equal(bus.emitted(AGENTS_CHANNEL).length, 1, "begin is one mutation and one emit");

    observatory.observe("worker-1", "edit", { path: "src/calculator.js" }, T0 + 1);
    assert.equal(bus.emitted(AGENTS_CHANNEL).length, 2, "observe is one mutation and one emit");

    observatory.finish("worker-1", { status: "completed", at: T0 + 2 });
    assert.equal(bus.emitted(AGENTS_CHANNEL).length, 3, "finish is one mutation and one emit");
    assert.equal(bus.emitted(AGENTS_CHANNEL).at(-1).data[0].status, "completed");
  });

  it("delivers a registry mutation into the runtime projection and /agents state", async () => {
    createAgentsHost(bus);
    const runtime = createRuntimeHost(bus);
    await runtime.start();

    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", providerLabel: "openrouter", at: T0 });

    const view = await runtime.agentsView();
    assert.match(view, /Worker/u, view);
    assert.match(view, /Qwen 3\.8 Flash/u, view);
    assert.equal(view.includes("sin agentes en esta sesión"), false, view);
    assert.deepEqual(runtime.sendMessages, [], "the bus path never reaches the conversation");
  });

  it("never lets a throwing subscriber break emission or the child run", () => {
    bus.on(AGENTS_CHANNEL, () => {
      throw new Error("bad subscriber");
    });
    createAgentsHost(bus);

    assert.doesNotThrow(() => observatory.begin({ role: "worker", at: T0 }));
    assert.equal(observatory.snapshot().length, 1, "the registry still recorded the child");
    assert.equal(bus.emitted(AGENTS_CHANNEL).length, 1, "the publisher got one emit out despite the throw");
  });

  it("leaves the projection empty and never crashes when no publisher exists", async () => {
    const runtime = createRuntimeHost(bus);
    await runtime.start();

    // The registry mutates, but nothing bridges it: a missing publisher.
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: T0 });

    const view = await runtime.agentsView();
    assert.equal(view.includes("Worker"), false, view);
    assert.match(view, /sin agentes en esta sesión/u);
    assert.equal(bus.emitted(AGENTS_CHANNEL).length, 0);
  });

  it("degrades an unreadable payload to an empty projection", async () => {
    const runtime = createRuntimeHost(bus);
    await runtime.start();

    bus.emit(AGENTS_CHANNEL, { not: "an array" });
    const view = await runtime.agentsView();
    assert.match(view, /sin agentes en esta sesión/u);
  });

  it("starts a new session from an empty projection", async () => {
    createAgentsHost(bus);
    const runtime = createRuntimeHost(bus);
    await runtime.start();

    observatory.begin({ role: "worker", at: T0 });
    assert.match(await runtime.agentsView(), /Worker/u);

    await runtime.start("new");
    assert.match(await runtime.agentsView(), /sin agentes en esta sesión/u);
  });

  it("applies a raw bus snapshot even when the singleton holds nothing", async () => {
    const runtime = createRuntimeHost(bus);
    await runtime.start();

    bus.emit(AGENTS_CHANNEL, [record({ id: "verify-1", role: "verify", modelLabel: "Claude 4" })]);
    const view = await runtime.agentsView();
    assert.match(view, /Verify #1/u, view);
    assert.match(view, /Claude 4/u, view);
  });
});
