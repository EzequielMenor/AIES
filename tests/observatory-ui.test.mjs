/**
 * AIES-010C / T4b observatory UI wiring checks.
 *
 * Drive the real `extensions/aies-runtime/index.ts` through a fake
 * `ExtensionAPI`/`ctx` to pin what the pure renderer tests cannot: the status
 * panel band in the header, the minimal footer while the panel is present, the
 * `aies-agents` mini widget, the `/agents` component and its keys, the compact
 * DONE projection and the "one durable entry per child" invariant.
 *
 * No Pi runtime, no model, no terminal beyond a stubbed `process.stdout.columns`.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesRuntime from "../extensions/aies-runtime/index.ts";
import { observatory } from "../extensions/aies-agents/observatory.ts";
import {
  ContinuationController,
  setActiveContinuationController,
} from "../extensions/aies-agents/autonomy/controller.ts";
import { applyAgents, createState, toSnapshot } from "../extensions/aies-runtime/state.ts";

const ROOT = "/repo";
const START_MS = 1_700_000_000_000;
const plainTheme = { fg: (_color, text) => text };

/** Fake timers and a frozen clock: the runtime uses the globals, so we swap them. */
function installFakes() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;
  const realColumns = process.stdout.columns;

  let now = START_MS;
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
    setColumns(value) {
      process.stdout.columns = value;
    },
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      Date.now = realNow;
      process.stdout.columns = realColumns;
    },
  };
}

/** Injected keybindings: the component must use these instead of raw guesses. */
const keybindings = {
  matches(data, binding) {
    switch (binding) {
      case "tui.select.up":
        return data === "\x1b[A";
      case "tui.select.down":
        return data === "\x1b[B";
      case "tui.editor.cursorLeft":
        return data === "\x1b[D";
      case "tui.editor.cursorRight":
        return data === "\x1b[C";
      case "tui.select.cancel":
        return data === "\x1b";
      default:
        return false;
    }
  },
};

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
  const notifications = [];
  const widgets = [];
  const renderers = new Map();
  const sendMessages = [];
  const footers = [];
  const headers = [];
  const customComponents = [];
  const setStatusCalls = [];
  const renderRequests = { footer: 0, header: 0, custom: 0 };

  const pi = {
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
    registerEntryRenderer(type, renderer) {
      renderers.set(type, renderer);
    },
    sendMessage(...args) {
      sendMessages.push(args);
    },
    sendUserMessage(...args) {
      sendMessages.push(args);
    },
  };

  aiesRuntime(pi);

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
      theme: plainTheme,
      setFooter(factory) {
        footers.push(factory);
      },
      setHeader(factory) {
        headers.push(factory);
      },
      setStatus(key, text) {
        setStatusCalls.push({ key, text });
      },
      setWidget(key, content) {
        widgets.push(content === undefined ? { key, cleared: true } : { key, factory: content });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      select: async () => undefined,
      confirm: async () => false,
      custom(factory) {
        return new Promise((resolve) => {
          const tui = { requestRender() { renderRequests.custom += 1; } };
          const component = factory(tui, plainTheme, keybindings, (result) => resolve(result));
          customComponents.push({ component, tui });
        });
      },
    },
  };

  function mountFooter(width = 200) {
    const factory = footers.at(-1);
    assert.ok(typeof factory === "function", "no custom footer installed");
    const tui = { requestRender() { renderRequests.footer += 1; } };
    const component = factory(tui, plainTheme, {});
    return { component, text: () => component.render(width).join("\n") };
  }

  function mountHeader(width = 120) {
    const factory = headers.at(-1);
    assert.ok(typeof factory === "function", "no custom header installed");
    const tui = { requestRender() { renderRequests.header += 1; } };
    const component = factory(tui, plainTheme);
    return { component, lines: () => component.render(width), text: () => component.render(width).join("\n") };
  }

  function mountWidget(key, width = 80) {
    const entry = [...widgets].reverse().find((widget) => widget.key === key && widget.factory);
    assert.ok(entry, `no ${key} widget mounted`);
    const component = entry.factory({ requestRender() {} }, plainTheme);
    return { component, text: () => component.render(width).join("\n"), lines: () => component.render(width) };
  }

  async function emit(event, payload = {}) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...payload }, ctx));
    }
    return results;
  }

  async function start(reason = "startup") {
    await emit("session_start", { reason });
  }

  return {
    pi,
    ctx,
    options,
    emit,
    start,
    handlers,
    commands,
    appended,
    notifications,
    widgets,
    renderers,
    sendMessages,
    footers,
    headers,
    customComponents,
    setStatusCalls,
    renderRequests,
    mountFooter,
    mountHeader,
    mountWidget,
  };
}

/** A ticket observation arrives through the real tool result handler. */
async function observeTicket(host, identifier = "EZE-422", status = "In Progress") {
  await host.emit("tool_result", {
    toolName: "aies_ticket",
    content: [{ type: "text", text: "ok" }],
    details: { ticket: { identifier, title: "Implement first-run guidance", status } },
  });
}

describe("observatory UI seam", () => {
  let timers;

  beforeEach(() => {
    timers = installFakes();
  });

  afterEach(() => {
    timers.restore();
    observatory.reset();
    setActiveContinuationController(undefined);
  });

  it("keeps an ephemeral UI projection while the persisted snapshot omits agents", () => {
    const record = {
      id: "worker-1",
      role: "worker",
      status: "completed",
      startedAt: START_MS,
      finishedAt: START_MS + 1_000,
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
    };
    const state = applyAgents(createState(START_MS), [record]);
    const snapshot = toSnapshot(state);
    assert.equal("agents" in snapshot, false, "the persisted snapshot must never carry agents");
    const projection = { ...snapshot, agents: state.agents };
    assert.equal(projection.agents.length, 1);
  });

  it("renders the status panel in the header band and never both header and panel", async () => {
    const host = createHost();
    await host.start();
    await observeTicket(host);

    timers.setColumns(120);
    const wide = host.mountHeader(120).text();
    assert.ok(wide.startsWith("╭"), wide);
    assert.match(wide, /✧ AIES · EZE-422/u, wide);
    assert.equal(wide.includes("╭─ ✧ EZE-422"), false, "the ticket header must not also render in the panel band");
    assert.match(wide, /IDLE/u);

    timers.setColumns(60);
    const narrow = host.mountHeader(60).text();
    assert.match(narrow, /╭─ ✧ EZE-422/u, narrow);
    assert.equal(narrow.includes("✧ AIES · EZE-422"), false, "the panel must not render below its minimum width");
  });

  it("renders the footer minimal exactly when the panel is visible", async () => {
    const host = createHost();
    await host.start();

    timers.setColumns(120);
    host.mountHeader(120).text();
    const minimal = host.mountFooter(200).text();
    assert.equal(minimal, "✧ AIES · listo · ctx 10k");
    for (const hidden of ["model-a", "repo"]) {
      assert.equal(minimal.includes(hidden), false, minimal);
    }

    timers.setColumns(60);
    host.mountHeader(60).text();
    const rich = host.mountFooter(200).text();
    assert.match(rich, /model-a/u, rich);
    assert.match(rich, /repo/u, rich);
  });

  it("registers the aies-agents widget, renders records and clears when empty", async () => {
    const host = createHost();
    await host.start();

    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", providerLabel: "openrouter", at: START_MS });

    const widget = host.mountWidget("aies-agents");
    assert.match(widget.text(), /Worker/u);
    assert.match(widget.text(), /Qwen 3\.8 Flash|esperando/u, widget.text());

    observatory.finish("worker-1", { status: "completed", at: START_MS + 20_000, result: "1 archivo modificado" });
    assert.match(widget.text(), /✓ Worker/u, widget.text());

    observatory.reset();
    const last = host.widgets.at(-1);
    assert.equal(last.key, "aies-agents");
    assert.equal(last.cleared, true, "an empty registry must clear the widget");
  });

  it("navigates /agents with the injected keybindings and closes on Escape", async () => {
    const host = createHost();
    await host.start();
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: START_MS });
    observatory.begin({ role: "verify", modelLabel: "Claude 4", at: START_MS + 1_000 });

    assert.ok(host.commands.has("agents"), "/agents is not registered");
    const pending = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();

    const { component } = host.customComponents.at(-1);
    assert.match(component.render(80).join("\n"), /Qwen 3\.8 Flash/u);

    component.handleInput("\x1b[A"); // up wraps to the last record
    assert.match(component.render(80).join("\n"), /Claude 4/u);
    assert.equal(component.render(80).join("\n").includes("Qwen 3.8 Flash"), false);

    component.handleInput("\x1b[B"); // down wraps back to the first record
    assert.match(component.render(80).join("\n"), /Qwen 3\.8 Flash/u);

    assert.ok(host.renderRequests.custom > 0, "navigation must request a render");

    component.handleInput("\x1b"); // escape closes
    await pending;
    assert.equal(host.customComponents.length, 1);
  });

  it("falls back to text for /agents outside the TUI without touching custom or widgets", async () => {
    const host = createHost({ mode: "print", hasUI: true });
    await host.start();
    observatory.begin({ role: "worker", at: START_MS });

    await host.commands.get("agents").handler("", host.ctx);

    assert.equal(host.customComponents.length, 0, "print mode must not open a custom component");
    assert.equal(host.widgets.some((widget) => widget.key === "aies-agents"), false);
    assert.ok(host.notifications.length >= 1, "print mode still answers through notify");
    assert.match(host.notifications.at(-1).message, /Worker/u);
  });

  it("appends exactly one aies-agent entry per finished delegation and one Verify trace", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "verify", task: "Check the seam" } });
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "verify" },
      details: {
        status: "pass",
        criteria: [{ criterion: "a", status: "pass" }],
        checks: [{ check: "test", result: "passed" }],
        verification: { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 },
      },
    });
    await host.emit("agent_settled", {});

    const entries = host.appended.filter((entry) => entry.type === "aies-agent");
    assert.equal(entries.length, 1, "one verify run, exactly one durable trace");
    assert.equal(entries[0].data.activity.role, "verify");
    assert.equal(entries[0].data.activity.outcome, "done");

    await host.emit("agent_settled", {});
    assert.equal(host.appended.filter((entry) => entry.type === "aies-agent").length, 1);
  });

  it("carries tokens, cost and agent rows in the compact DONE summary", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const host = createHost();
    await host.start();

    host.options.entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 12_000, cost: { total: 0.04 } } } });
    await controller.enable("EZE-417");
    await host.emit("tool_result", { toolName: "read", content: "x" });

    host.options.entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 5_000, cost: { total: 0.01 } } } });
    observatory.begin({ role: "worker", at: START_MS });
    observatory.updateUsage("worker-1", { totalTokens: 4_000, cost: 0.02 });
    observatory.finish("worker-1", { status: "completed", result: "1 archivo modificado", at: START_MS + 20_000 });
    await host.emit("tool_result", { toolName: "read", content: "y" });

    await controller.stop("completed");
    await host.emit("tool_result", { toolName: "read", content: "z" });

    const done = host.appended.find((entry) => entry.type === "aies-summary");
    assert.ok(done, "no DONE summary appended");
    assert.equal(done.data.kind, "done");
    assert.deepEqual(done.data.tokens, { total: 9_000, main: 5_000, agents: 4_000 });
    assert.equal(done.data.cost.toFixed(2), "0.03");
    assert.equal(done.data.agents.length, 1);
    assert.equal(done.data.agents[0].role, "Worker");
    assert.equal(done.data.agents[0].glyph, "✓");
    assert.equal(done.data.agents[0].text, "1 archivo modificado");
    assert.equal("commit" in done.data, false, "the DONE summary must never invent a commit");

    const renderer = host.renderers.get("aies-summary");
    const text = renderer(done, {}, plainTheme).render(120).join("\n");
    assert.match(text, /Worker ✓ 1 archivo modificado/u);
    assert.match(text, /Tokens 9000 \(main 5000 · agents 4000\)/u);
    assert.match(text, /Coste \$0\.03/u);
    assert.match(text, /Tiempo/u);
  });

  it("keeps the observatory detail in /aies-status detalle only", async () => {
    const host = createHost();
    await host.start();
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: START_MS });
    observatory.observe("worker-1", "edit", { path: "src/app.ts" }, START_MS + 1);
    observatory.updateUsage("worker-1", { totalTokens: 4_000, cost: 0.02 });
    observatory.finish("worker-1", { status: "completed", result: "hecho", at: START_MS + 2 });

    await host.commands.get("aies-status").handler("", host.ctx);
    const overview = host.notifications.at(-1).message;
    assert.equal(overview.includes("Observatorio"), false, overview);
    assert.equal(overview.includes("worker-1"), false, overview);
    assert.equal(overview.includes("Uso del run"), false, overview);

    await host.commands.get("aies-status").handler("detalle", host.ctx);
    const detail = host.notifications.at(-1).message;
    assert.match(detail, /Observatorio:/u);
    assert.match(detail, /worker-1/u);
    assert.match(detail, /1 herramientas/u);
    assert.match(detail, /src\/app\.ts/u);
    assert.match(detail, /Editando src\/app\.ts/u);
    assert.match(detail, /Uso del run:/u);
    assert.match(detail, /^  main /mu);
  });

  it("never reaches sendMessage or the retired setStatus from a UI path", async () => {
    const host = createHost();
    await host.start();
    await observeTicket(host);
    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement it" } });
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "worker" },
      details: { status: "done", changes: [], checks: [] },
    });
    observatory.begin({ role: "worker", at: START_MS });
    await host.emit("agent_settled", {});
    await host.commands.get("aies-status").handler("", host.ctx);
    const pendingAgents = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();
    host.customComponents.at(-1).component.handleInput("\x1b");
    await pendingAgents;
    await host.emit("session_shutdown", { reason: "quit" });

    assert.deepEqual(host.sendMessages, []);
    assert.deepEqual(host.setStatusCalls, []);
  });
});
