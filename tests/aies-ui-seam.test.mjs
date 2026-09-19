/**
 * AIES-010 UI seam checks.
 *
 * Drive the real `extensions/aies-runtime/index.ts` through a fake
 * `ExtensionAPI` and fake context, and pin the wiring the pure `aies-ui` tests
 * cannot: the footer, the single activity widget, the single timer, the durable
 * entries, the autonomy transitions and the headless degradation. No Pi runtime,
 * no model, no terminal.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesRuntime from "../extensions/aies-runtime/index.ts";
import {
  ContinuationController,
  setActiveContinuationController,
} from "../extensions/aies-agents/autonomy/controller.ts";

const ROOT = "/repo";
const START_MS = 1_700_000_000_000;

/** Fake timers and a frozen clock: the runtime uses the globals, so we swap them. */
function installFakes() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;

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
  const renderRequests = { footer: 0, header: 0 };

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
      theme: { fg: (_color, text) => text },
      setFooter(factory) {
        footers.push(factory);
      },
      setHeader(factory) {
        headers.push(factory);
      },
      setStatus(_key, _text) {
        throw new Error("the runtime must not use setStatus anymore");
      },
      setWidget(key, content) {
        widgets.push(content === undefined ? { key, cleared: true } : { key, factory: content });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      select: async () => undefined,
      confirm: async () => false,
    },
  };

  /** Mount the installed footer/header factory and expose a rendered snapshot. */
  function mountFooter(width = 200) {
    const factory = footers.at(-1);
    assert.ok(typeof factory === "function", "no custom footer installed");
    const tui = { requestRender() { renderRequests.footer += 1; } };
    const component = factory(tui, plainTheme, {});
    return { component, text: () => component.render(width).join("\n") };
  }

  function mountHeader(width = 200) {
    const factory = headers.at(-1);
    assert.ok(typeof factory === "function", "no custom header installed");
    const tui = { requestRender() { renderRequests.header += 1; } };
    const component = factory(tui, plainTheme);
    return { component, lines: () => component.render(width) };
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

  return { pi, ctx, options, emit, start, handlers, commands, appended, notifications, widgets, renderers, sendMessages, footers, headers, renderRequests, mountFooter, mountHeader };
}

const plainTheme = { fg: (_color, text) => text };

describe("AIES UI seam", () => {
  let timers;

  beforeEach(() => {
    timers = installFakes();
  });

  afterEach(() => {
    timers.restore();
    setActiveContinuationController(undefined);
  });

  it("never uses sendMessage or sendUserMessage for UI", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement it" } });
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "worker" },
      content: "x",
      details: { status: "done", summary: "ok", changes: [], checks: [] },
    });
    await host.emit("session_shutdown", { reason: "quit" });

    assert.deepEqual(host.sendMessages, [], "UI must never reach the conversation");
  });

  it("installs a full custom footer with the AIES identity and no telemetry", async () => {
    const host = createHost();
    await host.start();

    assert.equal(host.footers.length, 1, "one custom footer for the session");
    const footer = host.mountFooter(29);
    assert.equal(footer.text(), "✧ AIES · listo · ctx 10k");
    assert.match(footer.text(), /^✧ AIES ·/u);
    for (const banned of ["peak", "tools", "cmp", "files"]) {
      assert.equal(footer.text().includes(banned), false, footer.text());
    }
    assert.equal(/\d{2}:\d{2}/u.test(footer.text()), false, `elapsed clock in footer: ${footer.text()}`);
  });

  it("requests a footer render only when the rendered text changes", async () => {
    const host = createHost();
    await host.start();
    host.mountFooter();
    assert.equal(host.renderRequests.footer, 0);

    await host.emit("tool_result", { toolName: "read", content: [{ type: "text", text: "x" }] });
    await host.emit("tool_result", { toolName: "read", content: [{ type: "text", text: "y" }] });
    assert.equal(host.renderRequests.footer, 0, "identical state must not repaint the footer");

    host.options.contextUsage = { tokens: 20_000, contextWindow: 200_000, percent: 10 };
    await host.emit("tool_result", { toolName: "read", content: [{ type: "text", text: "z" }] });
    assert.equal(host.renderRequests.footer, 1);
    assert.equal(host.mountFooter(29).text(), "✧ AIES · listo · ctx 20k");
  });

  it("installs a ticket header and requests a render when the ticket appears", async () => {
    const host = createHost();
    await host.start();
    assert.equal(host.headers.length, 1, "one custom header for the session");
    assert.deepEqual(host.mountHeader().lines(), [], "no ticket, no header lines");

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: { ticket: { identifier: "EZE-422", title: "Implement first-run guidance", status: "In Progress" } },
    });

    assert.equal(host.renderRequests.header, 1, "a new ticket must repaint the header");
    const lines = host.mountHeader(80).lines();
    const text = lines.join("\n");
    assert.match(text, /✧ EZE-422/u);
    assert.match(text, /Implement first-run guidance/u);
    assert.match(text, /In Progress/u);

    assert.deepEqual(host.mountHeader(40).lines(), ["EZE-422 · In Progress"]);
  });

  it("registers the aies-activity widget and renders the role and task", async () => {
    const host = createHost();
    await host.start();
    assert.deepEqual(host.widgets, []);

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement the seam" } });

    const widget = host.widgets.at(-1);
    assert.equal(widget.key, "aies-activity");
    assert.equal(typeof widget.factory, "function");

    const component = widget.factory({ requestRender() {} }, plainTheme);
    const lines = component.render(80);
    assert.match(lines[0], /╭─ ◆ Worker/u);
    assert.match(lines.join("\n"), /Worker/u);
    assert.match(lines.join("\n"), /Implement the seam/u);
    assert.match(lines.at(-1), /^╰/u);

    // The finished child leaves the widget immediately; the durable entry is the trace.
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "worker" },
      details: { status: "done", summary: "ok", changes: [{ file: "a.ts" }], checks: [{ check: "test", result: "passed" }] },
    });
    assert.deepEqual(component.render(80), []);
  });

  it("appends one durable entry, clears the widget at once and shows the finished state", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "verify", task: "Check the seam" } });
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "verify" },
      isError: false,
      details: {
        status: "pass",
        summary: "Verificado",
        criteria: [{ criterion: "a", status: "pass" }],
        checks: [{ check: "test", result: "passed" }],
        defects: [],
        verification: { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 },
      },
    });

    const entries = host.appended.filter((entry) => entry.type === "aies-agent");
    assert.equal(entries.length, 1, "one finished child, one durable entry");
    assert.equal(entries[0].data.activity.role, "verify");
    assert.equal(entries[0].data.activity.outcome, "done");

    assert.equal(host.mountFooter(29).text(), "✧ AIES · DONE · ctx 10k");
    assert.equal(host.widgets.some((widget) => widget.cleared === true), true, "the finished card must not linger");
    assert.equal(host.mountFooter(29).text(), "✧ AIES · DONE · ctx 10k");
  });

  it("renders the durable entry renderers for a finished child", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "explore", task: "Investigar" } });
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "explore" },
      details: { status: "done", summary: "Encontré el handoff", evidence: [{ file: "a.ts" }, { file: "b.ts" }] },
    });

    const entry = host.appended.find((item) => item.type === "aies-agent");
    const render = host.renderers.get("aies-agent");
    assert.equal(typeof render, "function");

    const collapsed = render(entry, { expanded: false }, plainTheme).render(80);
    assert.deepEqual(collapsed, ["✓ Explore · 00:00 · 2 archivos relevantes"]);

    const expanded = render(entry, { expanded: true }, plainTheme).render(80);
    assert.deepEqual(expanded, ["✓ Explore · 00:00 · 2 archivos relevantes"], "the durable entry never leaks the raw child summary");
  });

  it("appends exactly one summary on autonomy transitions and none on user_required", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const host = createHost();
    await host.start();

    await controller.enable("EZE-417");
    await host.emit("tool_result", { toolName: "read", content: "x" });
    assert.equal(host.notifications.some((item) => item.message === "◆ AUTO · EZE-417"), true);

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement it" } });
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "worker" },
      details: { status: "done", summary: "Implementación lista", changes: [{ file: "a.ts" }], checks: [{ check: "t", result: "passed" }] },
    });

    await controller.stop("completed");
    await host.emit("tool_result", { toolName: "read", content: "y" });

    const done = host.appended.filter((item) => item.type === "aies-summary");
    assert.equal(done.length, 1);
    assert.equal(done[0].data.kind, "done");
    assert.equal(done[0].data.ticket, "EZE-417");
    assert.equal("changes" in done[0].data, false, "the durable DONE summary never carries a change list");
    assert.equal(
      JSON.stringify(done[0].data).includes("Implementación lista"),
      false,
      "the durable DONE summary never projects the raw child summary",
    );
    assert.equal(done[0].data.linear, "Done");

    // A second identical event must not fire the transition again.
    await host.emit("tool_result", { toolName: "read", content: "z" });
    assert.equal(host.appended.filter((item) => item.type === "aies-summary").length, 1);

    const blockedController = new ContinuationController();
    setActiveContinuationController(blockedController);
    const blockedHost = createHost();
    await blockedHost.start();
    await blockedController.enable("EZE-8");
    await blockedHost.emit("tool_result", { toolName: "read", content: "x" });
    await blockedController.stop("linear_sync_failed");
    await blockedHost.emit("tool_result", { toolName: "read", content: "y" });

    const blocked = blockedHost.appended.filter((item) => item.type === "aies-summary");
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].data.kind, "blocked");
    assert.equal(blocked[0].data.happened, "Linear no pudo sincronizarse.");
    assert.equal(blocked[0].data.pending, "El código está verificado y no se volverá a ejecutar.");
    assert.equal("needs" in blocked[0].data, false);
    assert.equal(JSON.stringify(blocked[0].data).includes("linear_sync_failed"), false, "never a raw reason code");

    const userController = new ContinuationController();
    setActiveContinuationController(userController);
    const userHost = createHost();
    await userHost.start();
    await userController.enable("EZE-9");
    await userHost.emit("tool_result", { toolName: "read", content: "x" });
    await userController.stop("user_required");
    await userHost.emit("tool_result", { toolName: "read", content: "y" });

    assert.equal(userHost.appended.filter((item) => item.type === "aies-summary").length, 0);
    assert.equal(
      userHost.notifications.some((item) => item.type === "warning" && item.message.includes("Autonomía en pausa")),
      true,
    );
  });

  it("stays silent outside the TUI and still records the delegation", async () => {
    const host = createHost({ mode: "print", hasUI: false });
    await host.start();

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement it" } });
    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "worker" },
      details: { status: "done", summary: "ok", changes: [], checks: [] },
    });

    assert.equal(host.footers.length, 0, "no custom footer where there is no TUI");
    assert.equal(host.headers.length, 0, "no custom header where there is no TUI");
    assert.deepEqual(host.widgets, []);
    assert.deepEqual(host.notifications, []);
    assert.equal(host.appended.filter((item) => item.type === "aies-agent").length, 1);
  });

  it("uses one interval, re-arms it on the child edge and clears it on shutdown", async () => {
    const host = createHost();
    await host.start();
    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, 5000);

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement it" } });
    assert.equal(timers.lastInterval().ms, 1000);
    assert.equal(timers.cleared.includes(timers.intervals[0]), true);

    await host.emit("tool_result", { toolName: "read", content: "x" });
    assert.equal(timers.intervals.length, 2, "the timer must not be reset on every event");

    const active = timers.lastInterval();
    await host.emit("session_shutdown", { reason: "quit" });
    assert.equal(timers.cleared.includes(active), true);
    assert.equal(host.widgets.at(-1).cleared, true);
    assert.equal(host.footers.at(-1), undefined, "the custom footer is restored on shutdown");
    assert.equal(host.headers.at(-1), undefined, "the custom header is restored on shutdown");
  });
});
