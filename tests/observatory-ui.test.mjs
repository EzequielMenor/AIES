/**
 * AIES-010C / T4b observatory UI wiring checks.
 *
 * Drive the real `extensions/aies-runtime/index.ts` through a fake
 * `ExtensionAPI`/`ctx` to pin what the pure renderer tests cannot: the status
 * panel band in the header, the minimal footer while the panel is present, the
 * absence of a standalone duplicate `aies-agents` widget while `/agents` stays
 * functional, the `/agents` component and its keys, the compact
 * DONE projection and the "one durable entry per child" invariant.
 *
 * No Pi runtime, no model, no terminal beyond a stubbed `process.stdout.columns`.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesRuntime from "../extensions/aies-runtime/index.ts";
import { publishObservatoryOn } from "../extensions/aies-agents/index.ts";
import { observatory } from "../extensions/aies-agents/observatory.ts";
import {
  ContinuationController,
  setActiveContinuationController,
} from "../extensions/aies-agents/autonomy/controller.ts";
import { applyAgents, createState, toSnapshot } from "../extensions/aies-runtime/state.ts";
import { renderDoneSummary } from "../extensions/aies-ui/summary.ts";

const ROOT = "/repo";
const START_MS = 1_700_000_000_000;
const plainTheme = { fg: (_color, text) => text };

/** Every bridge subscription opened by `createHost`, detached after each test. */
const bridges = [];

/** A minimal, well-behaved `pi.events` bus for the harness. */
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
    // A partial host may not expose entry renderers at all; the summary then has
    // no card surface and must fall back to a single notify headline.
    entryRenderers: true,
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
    ...(options.entryRenderers === false
      ? {}
      : {
          registerEntryRenderer(type, renderer) {
            renderers.set(type, renderer);
          },
        }),
    sendMessage(...args) {
      sendMessages.push(args);
    },
    sendUserMessage(...args) {
      sendMessages.push(args);
    },
  };

  aiesRuntime(pi);

  // The runtime no longer reads the registry singleton directly: the agents
  // extension re-publishes every mutation on the shared bus. Wire that bridge
  // here so a singleton mutation still reaches the runtime, exactly as in Pi.
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
      setWidget(key, content, options) {
        widgets.push(content === undefined ? { key, cleared: true, options } : { key, factory: content, options });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      select: async () => undefined,
      confirm: async () => false,
      custom(factory, customOptions) {
        return new Promise((resolve) => {
          // A per-overlay request counter, so a closed overlay can be proven to
          // stop repainting even while the shared counter keeps moving.
          const requests = { count: 0 };
          const tui = {
            requestRender() {
              requests.count += 1;
              renderRequests.custom += 1;
            },
          };
          const component = factory(tui, plainTheme, keybindings, (result) => resolve(result));
          customComponents.push({ component, tui, options: customOptions, requests });
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
    for (const detach of bridges.splice(0)) detach();
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

  it("renders the status panel as a belowEditor widget and never duplicates it in the header", async () => {
    const host = createHost();
    await host.start();
    await observeTicket(host);

    timers.setColumns(120);
    await host.emit("tool_result", { toolName: "read", content: "x" });

    const registered = host.widgets.filter((widget) => widget.key === "aies-panel" && widget.factory);
    assert.ok(registered.length >= 1, "the persistent panel widget must be registered");
    assert.equal(registered.at(-1).options?.placement, "belowEditor", "the panel must live below the editor");

    const panel = host.mountWidget("aies-panel", 120);
    const wide = panel.text();
    assert.match(wide, /✧ AIES · EZE-422/u, wide);
    assert.match(wide, /IDLE/u);
    assert.ok(wide.startsWith("╭"), wide);
    assert.ok(panel.lines().length <= 6, `wide panel has ${panel.lines().length} lines:\n${wide}`);
    assert.ok(panel.lines().every((line) => line.length <= 96), wide);

    assert.deepEqual(host.mountHeader(120).lines(), [], "the panel replaces the header band");

    timers.setColumns(60);
    await host.emit("tool_result", { toolName: "read", content: "y" });
    assert.equal(host.widgets.at(-1).key, "aies-panel");
    assert.equal(host.widgets.at(-1).cleared, true, "below the breakpoint the panel widget is cleared");

    const narrow = host.mountHeader(60).text();
    assert.match(narrow, /╭─ ✧ EZE-422/u, narrow);
    assert.equal(narrow.includes("✧ AIES · EZE-422"), false, "the panel must not render below its minimum width");
  });

  it("clears the panel widget on shutdown", async () => {
    const host = createHost();
    await host.start();
    await observeTicket(host);

    timers.setColumns(120);
    await host.emit("tool_result", { toolName: "read", content: "x" });
    assert.equal(host.widgets.at(-1).key, "aies-panel");
    assert.equal(typeof host.widgets.at(-1).factory, "function");

    await host.emit("session_shutdown", { reason: "quit" });
    assert.equal(host.widgets.at(-1).key, "aies-panel");
    assert.equal(host.widgets.at(-1).cleared, true, "shutdown must clear the persistent panel");
  });

  it("renders the footer minimal exactly when the panel is visible", async () => {
    const host = createHost();
    await host.start();

    timers.setColumns(120);
    await host.emit("tool_result", { toolName: "read", content: "x" });
    const minimal = host.mountFooter(200).text();
    assert.equal(minimal, "✧ AIES · listo · ctx 10k");
    for (const hidden of ["model-a", "anthropic", "00:00"]) {
      assert.equal(minimal.includes(hidden), false, minimal);
    }

    timers.setColumns(79);
    await host.emit("tool_result", { toolName: "read", content: "y" });
    const rich = host.mountFooter(79).text();
    assert.match(rich, /model-a\/anthropic/u, rich);
    assert.match(rich, /00:00/u, rich);
    assert.equal(rich.includes("repo"), false, rich);
  });

  it("keeps the agents mini-overview inside the status panel without a duplicate widget", async () => {
    const host = createHost();
    timers.setColumns(120);
    await host.start();

    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", providerLabel: "openrouter", at: START_MS });

    const panel = host.mountWidget("aies-panel", 120);
    assert.match(panel.text(), /Agentes/u);
    assert.match(panel.text(), /◆ Worker activo/u);
    assert.equal(host.widgets.some((widget) => widget.key === "aies-agents"), false, "the panel is the one mini-overview");

    observatory.finish("worker-1", { status: "completed", at: START_MS + 20_000, result: "1 archivo modificado" });
    assert.match(panel.text(), /✓ Worker completado/u, panel.text());
  });

  it("opens /agents as a centered, larger, bounded overlay", async () => {
    const host = createHost();
    await host.start();
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: START_MS });

    const pending = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();

    const overlay = host.customComponents.at(-1);
    assert.ok(overlay, "the /agents command must open a custom component");
    assert.equal(overlay.options?.overlay, true, "the modal must be an overlay");
    assert.equal(overlay.options?.overlayOptions?.anchor, "center", "the modal must be centered");
    assert.equal(typeof overlay.options?.overlayOptions?.width, "number", "a bounded numeric width");
    assert.ok(overlay.options.overlayOptions.width > 60, "larger than the tight /aies-models surface");
    assert.equal(typeof overlay.options?.overlayOptions?.minWidth, "number", "a bounded numeric min width");
    assert.ok(overlay.options.overlayOptions.maxHeight, "a bounded height Pi can clamp on a short terminal");

    overlay.component.handleInput("\x1b");
    await pending;
  });

  it("moves the /agents selection with ↑↓ and j/k and never acts on Enter", async () => {
    const host = createHost();
    await host.start();
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: START_MS });
    observatory.begin({ role: "verify", modelLabel: "Claude 4", at: START_MS + 1_000 });

    const pending = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();
    const { component } = host.customComponents.at(-1);

    assert.match(component.render(100).join("\n"), /Qwen 3\.8 Flash/u);

    component.handleInput("\x1b[B"); // down arrow -> verify
    assert.match(component.render(100).join("\n"), /Claude 4/u);

    component.handleInput("k"); // vim up -> worker
    assert.match(component.render(100).join("\n"), /Qwen 3\.8 Flash/u);

    component.handleInput("j"); // vim down -> verify
    assert.match(component.render(100).join("\n"), /Claude 4/u);

    component.handleInput("\x1b[A"); // up arrow -> worker
    assert.match(component.render(100).join("\n"), /Qwen 3\.8 Flash/u);

    component.handleInput("\r"); // Enter is not an action
    assert.match(component.render(100).join("\n"), /Qwen 3\.8 Flash/u);
    assert.equal(host.customComponents.length, 1, "Enter must not settle the modal");

    component.handleInput("\x1b");
    await pending;
  });

  it("closes /agents on Esc and q, clears the repaint handle and reopens cleanly", async () => {
    const host = createHost();
    await host.start();
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: START_MS });
    observatory.begin({ role: "verify", modelLabel: "Claude 4", at: START_MS + 1_000 });

    const first = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();
    const firstOverlay = host.customComponents.at(-1);
    firstOverlay.component.handleInput("j"); // select verify
    assert.match(firstOverlay.component.render(100).join("\n"), /Claude 4/u);
    firstOverlay.component.handleInput("\x1b"); // Esc
    await first;

    const closedRequests = firstOverlay.requests.count;
    observatory.observe("worker-1", "edit", { path: "src/app.ts" }, START_MS + 5);
    assert.equal(firstOverlay.requests.count, closedRequests, "a closed overlay must not repaint");

    const second = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();
    const secondOverlay = host.customComponents.at(-1);
    assert.notEqual(secondOverlay, firstOverlay, "a reopen is a fresh overlay, not the closed one");
    assert.match(secondOverlay.component.render(100).join("\n"), /Qwen 3\.8 Flash/u, "reopen starts at the first record");
    secondOverlay.component.handleInput("q"); // q closes too
    await second;
  });

  it("repaints the open /agents overlay from the event flow without losing the selection", async () => {
    const host = createHost();
    await host.start();
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: START_MS });
    observatory.begin({ role: "verify", modelLabel: "Claude 4", at: START_MS + 1_000 });

    const pending = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();
    const overlay = host.customComponents.at(-1);
    overlay.component.handleInput("j"); // select verify
    assert.match(overlay.component.render(100).join("\n"), /Claude 4/u);

    const before = overlay.requests.count;
    observatory.observe("worker-1", "edit", { path: "src/app.ts" }, START_MS + 5);
    assert.ok(overlay.requests.count > before, "the open overlay repaints on AGENTS_CHANNEL");

    const view = overlay.component.render(100).join("\n");
    assert.match(view, /Claude 4/u, "the selection survives the update");
    assert.equal(view.includes("Qwen 3.8 Flash"), false, "the selected detail did not change");

    overlay.component.handleInput("\x1b");
    await pending;
  });

  it("shows the empty state inside the /agents modal", async () => {
    const host = createHost();
    await host.start();

    const pending = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();
    const overlay = host.customComponents.at(-1);
    assert.match(overlay.component.render(100).join("\n"), /sin agentes en esta sesión/u);
    overlay.component.handleInput("\x1b");
    await pending;
  });

  it("keeps a completed agent's retained activity and result in /agents", async () => {
    const host = createHost();
    await host.start();
    observatory.begin({ role: "worker", modelLabel: "Qwen 3.8 Flash", at: START_MS });
    observatory.observe("worker-1", "edit", { path: "src/app.ts" }, START_MS + 1);
    observatory.finish("worker-1", { status: "completed", result: "1 archivo modificado", at: START_MS + 2 });

    const pending = host.commands.get("agents").handler("", host.ctx);
    await Promise.resolve();
    const overlay = host.customComponents.at(-1);
    const view = overlay.component.render(100).join("\n");
    assert.match(view, /src\/app\.ts/u);
    assert.match(view, /1 archivo modificado/u);
    overlay.component.handleInput("\x1b");
    await pending;
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
    assert.equal(text.includes("Tokens"), false, `detailed tokens stay out of the compact DONE card:\n${text}`);
    assert.equal(text.includes("Coste"), false, `detailed cost stays out of the compact DONE card:\n${text}`);
    assert.match(text, /Tiempo/u);
  });

  it("emits exactly one DONE card when the observed ticket completes, with no autonomy stop reason", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-424", title: "Fix clamp", status: "Done", statusType: "completed" },
        workState: "complete",
      },
    });

    const done = host.appended.filter((entry) => entry.type === "aies-summary");
    assert.equal(done.length, 1, "a completed ticket must emit the DONE card exactly once");
    assert.equal(done[0].data.kind, "done");
    assert.equal(done[0].data.ticket, "EZE-424");
    assert.equal(done[0].data.linear, "Done");
    assert.equal("commit" in done[0].data, false);

    // A later render must not append a second card for the same completion.
    await host.emit("tool_result", { toolName: "read", content: "x" });
    await host.emit("tool_result", { toolName: "read", content: "y" });
    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 1);

    // The TUI draws the card; duplicating its headline through notify would print
    // the completed row twice in one transcript.
    const cardHeadline = renderDoneSummary(done[0].data, { paint: plainTheme, width: 120 })[0];
    assert.equal(
      host.notifications.some((item) => cardHeadline.startsWith(item.message)),
      false,
      `the TUI card must not duplicate its headline through notify: ${JSON.stringify(host.notifications)}`,
    );
  });

  it("uses exactly one summary surface per host: the TUI card or a headless notify", async () => {
    // A TUI that accepted the entry renderer draws the card and stays silent.
    const tui = createHost();
    await tui.start();
    await tui.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-425", title: "Polish", status: "Done", statusType: "completed" },
        workState: "complete",
      },
    });

    const tuiCard = tui.appended.find((entry) => entry.type === "aies-summary");
    assert.ok(tuiCard, "the TUI host still appends the durable record");
    const tuiHeadline = renderDoneSummary(tuiCard.data, { paint: plainTheme, width: 120 })[0];
    assert.equal(
      tui.notifications.filter((item) => tuiHeadline.startsWith(item.message)).length,
      0,
      `the drawn card is the only surface: ${JSON.stringify(tui.notifications)}`,
    );

    // A host without a TUI cannot draw the card: the headline notify is the only
    // surface, and it must appear exactly once.
    const headless = createHost({ mode: "print", hasUI: true });
    await headless.start();
    await headless.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-425", title: "Polish", status: "Done", statusType: "completed" },
        workState: "complete",
      },
    });

    const headlessCard = headless.appended.find((entry) => entry.type === "aies-summary");
    assert.ok(headlessCard, "the durable record exists even where it is not drawn");
    const headlessHeadline = renderDoneSummary(headlessCard.data, { paint: plainTheme, width: 120 })[0];
    assert.equal(
      headless.notifications.filter((item) => headlessHeadline.startsWith(item.message)).length,
      1,
      `headless mode surfaces the headline once: ${JSON.stringify(headless.notifications)}`,
    );

    // A TUI host without entry renderers cannot draw the card either: notify again.
    const partial = createHost({ entryRenderers: false });
    await partial.start();
    await partial.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-425", title: "Polish", status: "Done", statusType: "completed" },
        workState: "complete",
      },
    });

    const partialCard = partial.appended.find((entry) => entry.type === "aies-summary");
    assert.ok(partialCard, "the durable record exists even where it is not drawn");
    const partialHeadline = renderDoneSummary(partialCard.data, { paint: plainTheme, width: 120 })[0];
    assert.equal(
      partial.notifications.filter((item) => partialHeadline.startsWith(item.message)).length,
      1,
      `a TUI without entry renderers falls back to notify: ${JSON.stringify(partial.notifications)}`,
    );
  });

  it("applies the one-surface rule to the BLOCKED summary too", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const tui = createHost();
    await tui.start();
    await controller.enable("EZE-426");
    await tui.emit("tool_result", { toolName: "read", content: "x" });
    await controller.stop("linear_sync_failed");
    await tui.emit("tool_result", { toolName: "read", content: "y" });

    const tuiBlocked = tui.appended.find((entry) => entry.type === "aies-summary");
    assert.ok(tuiBlocked, "the TUI host still appends the durable BLOCKED card");
    assert.equal(tuiBlocked.data.kind, "blocked");
    assert.equal(
      tui.notifications.some((item) => item.message.includes("bloqueado")),
      false,
      `the drawn BLOCKED card is the only surface: ${JSON.stringify(tui.notifications)}`,
    );

    const headlessController = new ContinuationController();
    setActiveContinuationController(headlessController);
    const headless = createHost({ mode: "print", hasUI: true });
    await headless.start();
    await headlessController.enable("EZE-426");
    await headless.emit("tool_result", { toolName: "read", content: "x" });
    await headlessController.stop("linear_sync_failed");
    await headless.emit("tool_result", { toolName: "read", content: "y" });

    const headlessBlocked = headless.appended.find((entry) => entry.type === "aies-summary");
    assert.ok(headlessBlocked, "the durable BLOCKED record exists where it is not drawn");
    assert.equal(headlessBlocked.data.kind, "blocked");
    assert.equal(
      headless.notifications.filter((item) => item.message.includes("bloqueado")).length,
      1,
      `headless mode surfaces the BLOCKED headline once: ${JSON.stringify(headless.notifications)}`,
    );
  });

  it("detects completion from a Linear statusType even when the status name is not Done", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-500", title: "x", status: "Completed", statusType: "completed" },
        workState: "working",
      },
    });

    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 1);
  });

  it("does not duplicate the DONE card when the autonomy stop also reports completed", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const host = createHost();
    await host.start();
    await controller.enable("EZE-424");
    await host.emit("tool_result", { toolName: "read", content: "x" });

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-424", title: "Fix clamp", status: "Done", statusType: "completed" },
        workState: "complete",
      },
    });
    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 1);

    await controller.stop("completed");
    await host.emit("tool_result", { toolName: "read", content: "y" });
    assert.equal(
      host.appended.filter((entry) => entry.type === "aies-summary").length,
      1,
      "the two completion paths must share one latch",
    );
  });

  it("re-arms the DONE latch so a later run can emit again", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const host = createHost();
    await host.start();

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-424", title: "a", status: "Done", statusType: "completed" },
        workState: "complete",
      },
    });
    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 1);

    // A new ticket run starts: the completed ticket of the previous run must not
    // re-fire, but this run's own completion must.
    await controller.enable("EZE-425");
    await host.emit("tool_result", { toolName: "read", content: "x" });
    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 1);

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-425", title: "b", status: "In Progress", statusType: "started" },
        workState: "working",
      },
    });
    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: {
        ticket: { identifier: "EZE-425", title: "b", status: "Done", statusType: "completed" },
        workState: "complete",
      },
    });
    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 2);
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
    const overlay = host.customComponents.at(-1).component;
    overlay.handleInput("j");
    overlay.handleInput("k");
    overlay.handleInput("q");
    await pendingAgents;
    await host.emit("session_shutdown", { reason: "quit" });

    assert.deepEqual(host.sendMessages, []);
    assert.deepEqual(host.setStatusCalls, []);
  });
});
