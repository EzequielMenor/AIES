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
import { RIGHT_RAIL_MIN_WIDTH } from "../extensions/aies-ui/right-rail.ts";
import {
  ContinuationController,
  setActiveContinuationController,
} from "../extensions/aies-agents/autonomy/controller.ts";

const ROOT = "/repo";
const START_MS = 1_700_000_000_000;
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

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
    lastInterval() {
      return intervals.at(-1);
    },
    restore() {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
      Date.now = realNow;
      process.stdout.columns = realColumns;
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
  const tools = [];

  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool(tool) {
      tools.push(tool);
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
      setWidget(key, content, options) {
        widgets.push(content === undefined ? { key, cleared: true, options } : { key, factory: content, options });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      select: async () => undefined,
      confirm: async () => false,
    },
  };

  /** Mount the installed footer/header factory and expose a rendered snapshot. */
  function mountFooter(width = 200, footerData = {}) {
    const factory = footers.at(-1);
    assert.ok(typeof factory === "function", "no custom footer installed");
    const tui = { requestRender() { renderRequests.footer += 1; } };
    const component = factory(tui, plainTheme, footerData);
    return { component, text: () => component.render(width).join("\n") };
  }

  function mountHeader(width = 200) {
    const factory = headers.at(-1);
    assert.ok(typeof factory === "function", "no custom header installed");
    const tui = { requestRender() { renderRequests.header += 1; } };
    const component = factory(tui, plainTheme);
    return { component, lines: () => component.render(width) };
  }

  function mountWidget(key, width = 120, tuiOverride = undefined) {
    const entry = [...widgets].reverse().find((widget) => widget.key === key && widget.factory);
    assert.ok(entry, `no ${key} widget mounted`);
    const tui = tuiOverride ?? { requestRender() {} };
    const component = entry.factory(tui, plainTheme);
    return { component, lines: () => component.render(width), text: () => component.render(width).join("\n") };
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

  return { pi, ctx, options, emit, start, handlers, commands, appended, notifications, widgets, renderers, sendMessages, footers, headers, renderRequests, tools, mountFooter, mountHeader, mountWidget };
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

    // The six quiet generic tools register at session start, and none of them
    // reaches the conversation: rendering is a pure projection.
    assert.deepEqual(
      host.tools.map((tool) => tool.name),
      ["read", "bash", "grep", "find", "edit", "write"],
      "the quiet surface owns exactly the six generic tools",
    );

    for (const tool of host.tools) {
      assert.equal(typeof tool.renderCall, "function", tool.name);
      assert.equal(typeof tool.renderResult, "function", tool.name);

      const theme = { fg: (_color, value) => value, bold: (value) => value };
      const context = {
        args: {},
        executionStarted: true,
        isPartial: true,
        expanded: false,
        isError: false,
      };
      tool.renderCall({}, theme, context).render(120);
      tool
        .renderResult({ content: [{ type: "text", text: "raw" }], details: {} }, { expanded: false, isPartial: false }, theme, context)
        .render(120);
    }

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

  it("registers the status panel as a persistent belowEditor widget, exclusive with the header", async () => {
    const host = createHost();
    timers.setColumns(140);
    await host.start();
    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: { ticket: { identifier: "EZE-424", title: "Fix clamp", status: "In Progress" } },
    });

    const panelWidget = [...host.widgets].reverse().find((entry) => entry.key === "aies-panel" && entry.factory);
    assert.ok(panelWidget, "the persistent panel must be registered");
    assert.equal(panelWidget.options?.placement, "belowEditor", "the panel lives below the editor");

    const panel = host.mountWidget("aies-panel", 140);
    const lines = panel.lines();
    assert.ok(lines.length <= 6, `panel has ${lines.length} lines:\n${panel.text()}`);
    assert.ok(lines.every((line) => line.length <= 96), panel.text());
    assert.match(panel.text(), /✧ AIES · EZE-424/u);
    assert.ok(panel.text().startsWith("╭"), "the fixed fullscreen dock must read as a separate surface");
    assert.deepEqual(host.mountHeader(140).lines(), [], "the panel owns the band; the header stays quiet");

    // Below the breakpoint the panel widget is cleared and the header identity returns.
    timers.setColumns(79);
    await host.emit("tool_result", { toolName: "read", content: "x" });
    assert.equal(host.widgets.at(-1).key, "aies-panel");
    assert.equal(host.widgets.at(-1).cleared, true, "below the breakpoint the panel is cleared");
    assert.match(host.mountHeader(79).lines().join("\n"), /╭─ ✧ EZE-424/u);

    await host.emit("session_shutdown", { reason: "quit" });
    assert.equal(host.widgets.at(-1).cleared, true, "shutdown clears the persistent panel");
  });

  it("mounts the private fullscreen rail when available and keeps the below-editor fallback", async () => {
    const original = () => ({ type: "vstack", entries: [] });
    const root = { [LAYOUT_NODE]: original };
    const tui = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
    const host = createHost();
    timers.setColumns(160);
    await host.start();

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: { ticket: { identifier: "EZE-424", title: "Rail", status: "In Progress" } },
    });

    // The footer factory is what hands AIES the host's git branch.
    host.mountFooter(160, {
      getGitBranch: () => "feat/aies-010d-fullscreen-shell",
      getExtensionStatuses: () => new Map(),
      getAvailableProviderCount: () => 0,
      onBranchChange: () => () => {},
    });

    const panel = host.mountWidget("aies-panel", 160, tui);
    assert.notEqual(root[LAYOUT_NODE], original, "the rail must wrap the private layout node");

    const node = root[LAYOUT_NODE]();
    assert.equal(node.type, "hstack");
    const railText = node.entries.at(-1).component.render(60).join("\n");
    assert.match(railText, /Proyecto/u, railText);
    assert.match(railText, /Rama\s+feat\/aies-010d-fullscreen-sh…/u, railText);
    assert.match(railText, /✧ AIES · EZE-424/u, railText);
    assert.match(railText, /Status/u, railText);
    assert.match(railText, /Agents/u, railText);

    // While the physical rail owns the status, the below-editor widget yields.
    assert.deepEqual(panel.lines(), []);

    await host.emit("session_shutdown", { reason: "quit" });
    assert.equal(root[LAYOUT_NODE], original, "shutdown restores the host layout");
  });

  it("yields the below-editor dock to a showing wide rail at any post-layout widget width", async () => {
    const original = () => ({ type: "vstack", entries: [] });
    const root = { [LAYOUT_NODE]: original };
    const tui = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
    const host = createHost();
    timers.setColumns(160);
    await host.start();

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: { ticket: { identifier: "EZE-424", title: "Rail", status: "In Progress" } },
    });

    // Pi hands the below-editor widget its post-layout width, already reduced by
    // the physical rail. It is well below the rail breakpoint even though the
    // outer terminal is wide, which is exactly the overlap this test pins.
    const RENDERED_WIDGET_WIDTH = 112;
    const panel = host.mountWidget("aies-panel", RENDERED_WIDGET_WIDTH, tui);

    // The host layout pass evaluates the rail wrapper before the dock renders.
    const node = root[LAYOUT_NODE]();
    assert.equal(node.type, "hstack", "the supported rail presents at the wide outer terminal");
    assert.deepEqual(
      panel.lines(),
      [],
      "a showing wide rail must make the dock yield regardless of the widget's own width",
    );

    // Below the outer rail breakpoint the physical rail steps aside and the dock
    // is the fallback again, at the very same reduced widget width.
    tui.terminal.columns = RIGHT_RAIL_MIN_WIDTH - 1;
    assert.deepEqual(root[LAYOUT_NODE](), original(), "below the breakpoint the host layout is untouched");
    assert.ok(panel.lines().length > 0, "the dock returns as the fallback below the rail breakpoint");
    assert.match(panel.text(), /╭─/u, "the fallback still reads as the status dock");
  });

  it("keeps the below-editor panel when the host has no private layout node", async () => {
    const host = createHost();
    timers.setColumns(140);
    await host.start();
    const panel = host.mountWidget("aies-panel", 140, { requestRender() {} });
    assert.ok(panel.lines().length > 0, "without the private hook the panel still renders");
    assert.match(panel.text(), /╭─/u);
  });

  it("renders an idle persistent panel with model and context only", async () => {
    const host = createHost();
    timers.setColumns(140);
    await host.start();

    const text = host.mountWidget("aies-panel", 140).text();
    assert.match(text, /✧ AIES · listo · IDLE/u);
    assert.match(text, /Model A · anthropic/u);
    assert.match(text, /ctx 10k/u);
    assert.equal(text.includes("Agentes"), false, text);
    assert.equal(text.includes("Tokens"), false, text);
    assert.equal(text.includes("Coste"), false, text);
    assert.equal(text.includes("$0.00"), false, text);
  });

  it("emits one DONE card on ticket completion and never duplicates it", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);
    const host = createHost();
    await host.start();
    await controller.enable("EZE-424");
    await host.emit("tool_result", { toolName: "read", content: "x" });

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: { ticket: { identifier: "EZE-424", status: "Done", statusType: "completed" }, workState: "complete" },
    });
    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 1);

    await controller.stop("completed");
    await host.emit("tool_result", { toolName: "read", content: "y" });
    assert.equal(host.appended.filter((entry) => entry.type === "aies-summary").length, 1);
  });

  it("keeps durable DONE telemetry while the compact card and the notify stay quiet", async () => {
    const controller = new ContinuationController();
    setActiveContinuationController(controller);

    // Parent usage comes only from real session entries. The first sample after the
    // run starts fixes the baseline; the second, after the run spends tokens,
    // yields the run's own delta.
    const entries = [];
    const host = createHost({ entries });
    await host.start();
    await controller.enable("EZE-424");
    await host.emit("tool_result", { toolName: "read", content: "baseline" });

    entries.push({ type: "message", message: { role: "assistant", usage: { totalTokens: 16_000, cost: { total: 0.06 } } } });
    await host.emit("tool_result", { toolName: "read", content: "spent" });

    await controller.stop("completed");
    await host.emit("tool_result", { toolName: "read", content: "done" });

    const done = host.appended.filter((entry) => entry.type === "aies-summary");
    assert.equal(done.length, 1);

    // The durable entry preserves the run telemetry even though the card omits it.
    assert.deepEqual(done[0].data.tokens, { total: 16_000, main: 16_000, agents: 0 });
    assert.equal(done[0].data.cost, 0.06);

    const card = host.renderers.get("aies-summary")(done[0], { expanded: false }, plainTheme).render(80).join("\n");
    for (const omitted of ["Tokens", "Coste", "16k", "0.06"]) {
      assert.equal(card.includes(omitted), false, `compact DONE leaked telemetry ${omitted}:\n${card}`);
    }

    // The renderer owns the visual, so the headline never also travels through notify.
    assert.equal(
      host.notifications.some((item) => item.message.includes("completado")),
      false,
      `a drawn DONE card must not also notify: ${JSON.stringify(host.notifications)}`,
    );
  });

  it("registers the aies-activity widget and renders the role and task", async () => {
    const host = createHost();
    await host.start();
    assert.deepEqual(host.widgets.map((entry) => entry.key), ["aies-empty-state"]);

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement the seam" } });

    const widget = [...host.widgets].reverse().find((entry) => entry.key === "aies-activity" && entry.factory);
    assert.ok(widget, "the activity widget must be registered");
    assert.equal(typeof widget.factory, "function");
    assert.equal(
      host.widgets.some((entry) => entry.key === "aies-empty-state" && entry.cleared === true),
      true,
      "a started run must clear the idle empty state",
    );

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

  it("passes the public TUI height into the idle empty state widget", async () => {
    const host = createHost();
    await host.start();

    const baseline = host.mountWidget("aies-empty-state", 80).lines();
    const tall = host.mountWidget("aies-empty-state", 80, { terminal: { rows: 48 }, requestRender() {} }).lines();
    const short = host.mountWidget("aies-empty-state", 80, { terminal: { rows: 14 }, requestRender() {} }).lines();

    assert.ok(tall.length > baseline.length, "a tall terminal must add bounded flow spacing");
    assert.deepEqual(short, baseline, "a short terminal must keep the compact card");
    assert.deepEqual(tall.slice(0, baseline.length), baseline, "the card body is unchanged by the trailing spacer");
    for (const line of tall.slice(baseline.length)) assert.equal(line, "", "the spacer is blank flow space");
  });

  it("re-reads the terminal height on every render so a resize reflows", async () => {
    const host = createHost();
    await host.start();

    const tui = { terminal: { rows: 48 }, requestRender() {} };
    const widget = host.mountWidget("aies-empty-state", 80, tui);
    const tall = widget.lines().length;

    tui.terminal.rows = 14;
    assert.ok(tall > widget.lines().length, "a shrink must reflow the spacer away");
  });

  it("shows the inline card above the input even while the physical rail owns the status dock", async () => {
    const original = () => ({ type: "vstack", entries: [] });
    const root = { [LAYOUT_NODE]: original };
    const tui = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
    const host = createHost();
    timers.setColumns(160);
    await host.start();
    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      details: { ticket: { identifier: "EZE-424", title: "Rail", status: "In Progress" } },
    });

    const panel = host.mountWidget("aies-panel", 160, tui);
    root[LAYOUT_NODE](); // the host layout pass makes the rail report itself as showing

    // The rail owns the status dock: the below-editor panel yields to it.
    assert.deepEqual(panel.lines(), [], "the rail owns the status dock; the card is a separate surface");

    // The live child card is not the dock: it renders above the input regardless.
    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement" } });
    assert.ok(
      host.widgets.some((widget) => widget.key === "aies-activity" && widget.factory),
      "the live child card must render above the input even while the rail is showing",
    );

    // Below the rail breakpoint the same inline card remains the fallback.
    tui.terminal.columns = RIGHT_RAIL_MIN_WIDTH - 20;
    root[LAYOUT_NODE]();
    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement again" } });
    assert.ok(
      host.widgets.some((widget) => widget.key === "aies-activity" && widget.factory),
      "without the rail the inline activity card remains",
    );

    await host.emit("session_shutdown", { reason: "quit" });
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

    assert.equal(host.mountFooter(29).text(), "✧ AIES · FINALIZING · ctx 10k");
    assert.equal(host.widgets.some((widget) => widget.cleared === true), true, "the finished card must not linger");

    await host.emit("turn_end", { message: { role: "assistant" } });
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
    assert.equal(
      host.notifications.some((item) => item.message.includes("◆ AUTO")),
      false,
      `autonomy activation is carried by the AUTO badge, not a duplicated notification: ${JSON.stringify(host.notifications)}`,
    );

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
