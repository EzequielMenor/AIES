/**
 * AIES-010D active agent card checks.
 *
 * During execution a small fixed card above the input must show the active child
 * agent: it appears while a delegation runs, ticks its live elapsed time on the
 * 1s clock, and disappears the moment the child finishes. The card is the wide
 * rail's *sibling*, not its replacement, so it stays visible above the editor
 * even while the physical right rail owns the status dock.
 *
 * These tests drive the real `extensions/aies-runtime/index.ts` through a fake
 * `ExtensionAPI` and fake context, plus the pure `aies-ui` renderer. No Pi
 * runtime, no model, no terminal.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesRuntime from "../extensions/aies-runtime/index.ts";
import { isActivityVisible, renderActivityCard, renderActivityEntry } from "../extensions/aies-ui/activity.ts";
import { LAYOUT_NODE } from "../extensions/aies-ui/right-rail.ts";

const ROOT = "/repo";
const T0 = 1_700_000_000_000;

/** Fake timers and a frozen clock: the runtime uses the globals, so we swap them. */
function installFakes() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realNow = Date.now;
  const realColumns = process.stdout.columns;

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
  const appended = [];
  const notifications = [];
  const widgets = [];

  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    registerTool() {},
    getActiveTools() {
      return options.activeTools;
    },
    appendEntry(type, data) {
      appended.push({ type, data });
    },
    registerEntryRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
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
      setFooter() {},
      setHeader() {},
      setStatus() {
        throw new Error("the runtime must not use setStatus anymore");
      },
      setWidget(key, content, widgetOptions) {
        widgets.push(content === undefined ? { key, cleared: true, options: widgetOptions } : { key, factory: content, options: widgetOptions });
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
      select: async () => undefined,
      confirm: async () => false,
    },
  };

  function widget(key) {
    return [...widgets].reverse().find((entry) => entry.key === key && entry.factory);
  }

  function mountWidget(key, width = 120, tuiOverride = undefined) {
    const entry = widget(key);
    assert.ok(entry, `no ${key} widget mounted`);
    const tui = tuiOverride ?? { requestRender() {} };
    const component = entry.factory(tui, plainTheme);
    return { entry, component, lines: () => component.render(width), text: () => component.render(width).join("\n") };
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

  return { pi, ctx, options, emit, start, appended, notifications, widgets, widget, mountWidget };
}

const plainTheme = { fg: (_color, text) => text };

describe("active agent card content", () => {
  const running = {
    role: "worker",
    task: "Implementar el cambio",
    startedAt: T0,
    currentActivity: "Editando calculator.js",
    changedPaths: ["src/calculator.js"],
    modelLabel: "Qwen 3.8 Flash",
  };

  it("shows the role, the activity line and the live elapsed time", () => {
    const text = renderActivityCard(running, "WORK", T0 + 12_000, { width: 60 }).join("\n");
    assert.match(text, /◆ Worker/u);
    assert.match(text, /Editando calculator\.js/u);
    assert.match(text, /00:12/u);
  });

  it("reports tokens only when the child reported them and cost only when observed", () => {
    const bare = renderActivityCard({ ...running, totalTokens: 0, cost: null }, "WORK", T0 + 12_000, { width: 60 }).join("\n");
    assert.equal(bare.includes("tokens"), false, bare);
    assert.equal(bare.includes("$"), false, bare);
    assert.equal(bare.includes("—"), false, bare);

    const reported = renderActivityCard({ ...running, totalTokens: 34_000, cost: 0.03 }, "WORK", T0 + 12_000, { width: 60 }).join("\n");
    assert.match(reported, /34k tokens/u);
    assert.match(reported, /\$0\.03/u);
    assert.equal(reported.includes("$0.00"), false, reported);
  });

  it("keeps the boxed card capped at 72 and the narrow form plain", () => {
    const wide = renderActivityCard({ ...running, totalTokens: 34_000, cost: 0.03 }, "WORK", T0 + 31_000, { width: 140 });
    assert.match(wide[0], /^╭─ ◆ Worker/u);
    for (const line of wide) assert.ok(line.length <= 72, `wide card line ${line.length}: ${line}`);

    const narrow = renderActivityCard(running, "WORK", T0 + 12_000, { width: 40 });
    assert.equal(narrow.length, 3, narrow.join("\n"));
    assert.equal(narrow[0], "◆ Worker");
    assert.equal(narrow.at(-1), "  00:12");
  });

  it("renders nothing for a finished child and leaves the durable entry as the trace", () => {
    const finished = { ...running, finishedAt: T0 + 16_000, outcome: "done", changedFiles: 2, checksPassed: 2, checksTotal: 2, totalTokens: 34_000, cost: 0.04 };
    assert.equal(isActivityVisible(finished, T0 + 16_000), false);
    assert.deepEqual(renderActivityCard(finished, "IDLE", T0 + 16_000), []);
    assert.equal(
      renderActivityEntry(finished),
      "✓ Worker · 00:16 · 34k · $0.04 · 2 archivos modificados · checks aprobados",
    );
  });
});

describe("active agent card lifecycle", () => {
  let timers;

  beforeEach(() => {
    timers = installFakes();
  });

  afterEach(() => {
    timers.restore();
  });

  it("shows the card above the input even while the physical rail owns the status dock", async () => {
    const original = () => ({ type: "vstack", entries: [] });
    const root = { [LAYOUT_NODE]: original };
    const tui = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
    const host = createHost();
    timers.setColumns(160);
    await host.start();

    await host.emit("tool_result", {
      toolName: "aies_ticket",
      content: [{ type: "text", text: "ok" }],
      // The active ticket title is what the live card prefers over the task text.
      details: { ticket: { identifier: "EZE-500", title: "Implement the card", status: "In Progress" } },
    });

    const panel = host.mountWidget("aies-panel", 160, tui);
    root[LAYOUT_NODE](); // the host layout pass makes the rail report itself as showing
    assert.deepEqual(panel.lines(), [], "the rail owns the below-editor status dock");

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement the card" } });

    const card = host.widget("aies-activity");
    assert.ok(card, "the live child card must register even while the rail is showing");
    assert.equal(card.options?.placement, undefined, "the card stays above the input");

    const component = card.factory({ requestRender() {} }, plainTheme);
    const lines = component.render(80);
    assert.match(lines[0], /^╭─ ◆ Worker/u);
    assert.match(lines.join("\n"), /Implement the card/u);

    await host.emit("session_shutdown", { reason: "quit" });
  });

  it("disappears immediately when the child finishes and leaves the durable entry", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement" } });
    const card = host.widget("aies-activity");
    assert.ok(card, "the card must register while the child runs");
    const component = card.factory({ requestRender() {} }, plainTheme);
    assert.ok(component.render(80).length > 0, "the card renders while the child runs");

    await host.emit("tool_result", {
      toolName: "aies_delegate",
      input: { role: "worker" },
      details: { status: "done", summary: "ok", changes: [{ file: "a.ts" }], checks: [{ check: "t", result: "passed" }] },
    });

    assert.deepEqual(component.render(80), [], "the finished card must vanish");
    assert.equal(
      host.widgets.some((entry) => entry.key === "aies-activity" && entry.cleared === true),
      true,
      "the widget must be cleared on finish",
    );
    assert.equal(
      host.appended.some((entry) => entry.type === "aies-agent"),
      true,
      "the durable entry is the single remaining trace",
    );
  });

  it("repaints the live elapsed time on the 1s clock tick", async () => {
    const host = createHost();
    await host.start();
    await host.emit("tool_call", { toolName: "aies_delegate", input: { role: "worker", task: "Implement" } });

    let renders = 0;
    const tui = { requestRender() { renders += 1; } };
    const card = host.widget("aies-activity");
    assert.ok(card, "the card must register while the child runs");
    const component = card.factory(tui, plainTheme);

    assert.match(component.render(60).join("\n"), /00:00/u);
    assert.equal(timers.lastInterval().ms, 1000, "a running child keeps the fast cadence");

    const before = renders;
    timers.advance(3000);
    timers.lastInterval().fn();
    assert.ok(renders > before, "the clock tick must repaint the card");
    assert.match(component.render(60).join("\n"), /00:03/u);
  });
});
