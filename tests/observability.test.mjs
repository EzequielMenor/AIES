/**
 * AIES-002 observability checks.
 *
 * Two layers, both deterministic and offline:
 *
 * 1. The pure modules (`state.ts`, `status.ts`) are driven with plain objects, so
 *    every metric rule has a direct assertion.
 * 2. The extension (`index.ts`) is driven through a fake `ExtensionAPI`: the
 *    handlers it registers are invoked with simulated Pi events. No model, no
 *    credentials and no Pi runtime are involved.
 *
 * The suite also pins the contract of this phase: observing never changes what
 * Pi does with a tool call or a tool result.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyCompaction,
  applyContextUsage,
  applyToolCall,
  applyToolResult,
  createState,
  fromSnapshot,
  isInspectionCommand,
  normalizePath,
  shellHeadWord,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import {
  formatDuration,
  formatTokens,
  renderFooter,
  renderStatusReport,
} from "../extensions/aies-runtime/status.ts";
import aiesRuntime from "../extensions/aies-runtime/index.ts";

const ROOT = "/repo";
const T0 = 1_700_000_000_000;

/** One value out of the `/aies-status` report, by its label. */
function field(report, label) {
  const pattern = new RegExp(`^ {2}${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} +(.*)$`, "mu");
  const match = report.match(pattern);
  assert.ok(match, `report has no "${label}" row:\n${report}`);
  return match[1].trim();
}

function stateFrom(now = T0) {
  return createState(now);
}

function toolCall(toolName, input) {
  return { type: "tool_call", toolName, input };
}

function readCall(path) {
  return toolCall("read", { path });
}

function shell(command) {
  return toolCall("bash", { command });
}

function usage(tokens, contextWindow = 200_000, percent = tokens / (contextWindow / 100)) {
  return { tokens, contextWindow, percent };
}

describe("observability state", () => {
  it("starts empty", () => {
    const s = toSnapshot(stateFrom());

    assert.equal(s.version, 1);
    assert.equal(s.startedAt, T0);
    assert.equal(s.toolCalls, 0);
    assert.equal(s.toolResults, 0);
    assert.equal(s.toolErrors, 0);
    assert.deepEqual(s.toolCallsByName, {});
    assert.equal(s.sourceReads, 0);
    assert.equal(s.searchCalls, 0);
    assert.equal(s.shellInspections, 0);
    assert.deepEqual(s.filesInspected, []);
    assert.equal(s.outputChars, 0);
    assert.equal(s.largestOutputChars, 0);
    assert.equal(s.contextTokens, null);
    assert.equal(s.peakContextTokens, 0);
    assert.equal(s.contextWindow, 0);
    assert.equal(s.compactionCount, 0);
    assert.equal(s.activeToolCount, 0);
    assert.equal(s.model, undefined);
    assert.equal(s.stopReason, undefined);
    assert.equal(s.resumedAt, undefined);
  });

  it("counts one tool call", () => {
    const s = toSnapshot(applyToolCall(stateFrom(), shell("npm test"), T0, ROOT));

    assert.equal(s.toolCalls, 1);
    assert.deepEqual(s.toolCallsByName, { bash: 1 });
    assert.equal(s.shellInspections, 0, "npm test is work, not exploration");
  });

  it("accumulates several calls", () => {
    let s = stateFrom();
    for (const call of [
      readCall("docs/a.md"),
      shell("ls"),
      toolCall("edit", { path: "docs/a.md" }),
      shell("npm test"),
      toolCall("grep", { pattern: "x" }),
    ]) {
      s = applyToolCall(s, call, T0, ROOT);
    }

    const snap = toSnapshot(s);
    assert.equal(snap.toolCalls, 5);
    assert.deepEqual(snap.toolCallsByName, { read: 1, bash: 2, edit: 1, grep: 1 });
  });

  it("counts a recognized read and records the file", () => {
    const s = toSnapshot(applyToolCall(stateFrom(), readCall("docs/ARCHITECTURE.md"), T0, ROOT));

    assert.equal(s.sourceReads, 1);
    assert.equal(s.searchCalls, 0);
    assert.deepEqual(s.filesInspected, ["docs/ARCHITECTURE.md"]);
  });

  it("counts view_file as a source read too", () => {
    const s = toSnapshot(applyToolCall(stateFrom(), toolCall("view_file", { path: "src/x.ts" }), T0, ROOT));

    assert.equal(s.sourceReads, 1);
    assert.deepEqual(s.filesInspected, ["src/x.ts"]);
  });

  it("does not count the same file twice", () => {
    let s = stateFrom();
    for (const path of ["docs/a.md", "./docs/a.md", `${ROOT}/docs/a.md`, `${ROOT}/./docs/a.md`]) {
      s = applyToolCall(s, readCall(path), T0, ROOT);
    }

    const snap = toSnapshot(s);
    assert.deepEqual(snap.filesInspected, ["docs/a.md"]);
    assert.equal(snap.sourceReads, 4, "the reads happened, the file did not repeat");
  });

  it("keeps paths outside the repository as absolute keys", () => {
    const s = toSnapshot(applyToolCall(stateFrom(), readCall("/etc/hosts"), T0, ROOT));
    assert.deepEqual(s.filesInspected, ["/etc/hosts"]);
  });

  it("records no file for a tool that has none", () => {
    const s = toSnapshot(applyToolCall(stateFrom(), toolCall("read", {}), T0, ROOT));

    assert.equal(s.sourceReads, 1);
    assert.deepEqual(s.filesInspected, []);
  });

  it("separates searching from reading", () => {
    let s = stateFrom();
    for (const call of [
      toolCall("grep", { pattern: "foo", path: "src" }),
      toolCall("find", { pattern: "*.ts" }),
      toolCall("ls", {}),
    ]) {
      s = applyToolCall(s, call, T0, ROOT);
    }

    const snap = toSnapshot(s);
    assert.equal(snap.searchCalls, 3);
    assert.equal(snap.sourceReads, 0);
    assert.deepEqual(snap.filesInspected, [], "a search does not inspect a file");
  });

  it("classifies obvious shell inspection only", () => {
    let s = stateFrom();
    for (const command of ["grep -r TODO src", "cd docs && sed -n '1,20p' x.md", "git status --short"]) {
      s = applyToolCall(s, shell(command), T0, ROOT);
    }
    assert.equal(toSnapshot(s).shellInspections, 3);

    for (const command of ["npm test", "rm -rf build", "node script.js", "echo $(ls)", "git commit -m x", ""]) {
      const snap = toSnapshot(applyToolCall(stateFrom(), shell(command), T0, ROOT));
      assert.equal(snap.shellInspections, 0, `not inspection: ${command || "(empty)"}`);
    }
  });

  it("accumulates tool result size and tracks the largest", () => {
    let s = stateFrom();
    s = applyToolResult(s, { content: [{ type: "text", text: "a".repeat(100) }] }, T0);
    s = applyToolResult(s, { content: [{ type: "text", text: "b".repeat(40) }] }, T0);
    s = applyToolResult(s, { content: "short", isError: true }, T0);

    const snap = toSnapshot(s);
    assert.equal(snap.toolResults, 3);
    assert.equal(snap.toolErrors, 1);
    assert.equal(snap.outputChars, 145);
    assert.equal(snap.largestOutputChars, 100);
  });

  it("measures image payload in the same unit", () => {
    const s = toSnapshot(applyToolResult(stateFrom(), { content: [{ type: "image", data: "AAAA" }] }, T0));

    assert.equal(s.outputChars, 4);
    assert.equal(s.largestOutputChars, 4);
  });

  it("never lowers the peak when the current usage drops", () => {
    let s = stateFrom();
    s = applyContextUsage(s, usage(40_000));
    s = applyContextUsage(s, usage(58_000));
    s = applyContextUsage(s, usage(12_000));

    const snap = toSnapshot(s);
    assert.equal(snap.contextTokens, 12_000);
    assert.equal(snap.peakContextTokens, 58_000);
    assert.equal(snap.usagePercent, 6);
  });

  it("keeps the peak while usage is temporarily unknown", () => {
    let s = applyContextUsage(stateFrom(), usage(50_000));
    s = applyContextUsage(s, { tokens: null, contextWindow: 200_000, percent: null });

    const snap = toSnapshot(s);
    assert.equal(snap.contextTokens, null);
    assert.equal(snap.peakContextTokens, 50_000);
  });

  it("keeps the peak across a context window change and says where it came from", () => {
    let s = applyContextUsage(stateFrom(), usage(150_000, 200_000));
    s = applyContextUsage(s, usage(30_000, 128_000));

    const snap = toSnapshot(s);
    assert.equal(snap.contextWindow, 128_000);
    assert.equal(snap.peakContextTokens, 150_000, "a peak never disappears");
    assert.equal(snap.peakContextWindow, 200_000, "but it keeps the window it belongs to");

    const report = renderStatusReport(snap, T0);
    assert.equal(field(report, "pico"), "150k (ventana 200k)");
  });

  it("ignores an unusable usage sample", () => {
    for (const value of [undefined, null, {}, { tokens: "many" }, { tokens: Number.NaN }]) {
      const snap = toSnapshot(applyContextUsage(stateFrom(), value));
      assert.equal(snap.contextTokens, null);
      assert.equal(snap.peakContextTokens, 0);
    }
  });

  it("annotates a peak only when its window differs from the current one", () => {
    const same = applyContextUsage(stateFrom(), usage(150_000, 200_000));
    assert.equal(field(renderStatusReport(toSnapshot(same), T0), "pico"), "150k");

    let switched = same;
    switched = applyContextUsage(switched, { tokens: null, contextWindow: 128_000, percent: null });
    assert.equal(field(renderStatusReport(toSnapshot(switched), T0), "pico"), "150k (ventana 200k)");
  });

  it("counts compactions", () => {
    let s = applyCompaction(stateFrom(), T0);
    s = applyCompaction(s, T0 + 1);

    const snap = toSnapshot(s);
    assert.equal(snap.compactionCount, 2);
    assert.equal(snap.lastEventAt, T0 + 1);
  });

  it("round-trips through a snapshot", () => {
    let s = stateFrom();
    s = applyToolCall(s, readCall("docs/a.md"), T0, ROOT);
    s = applyToolCall(s, shell("ls"), T0, ROOT);
    s = applyToolResult(s, { content: [{ type: "text", text: "x".repeat(30) }] }, T0);
    s = applyContextUsage(s, usage(42_000));
    s = applyCompaction(s, T0);

    const original = toSnapshot(s);
    const restored = toSnapshot(fromSnapshot(JSON.parse(JSON.stringify(original)), T0));

    assert.deepEqual({ ...restored, resumedAt: undefined }, original);
    assert.equal(restored.resumedAt, undefined, "seeding is what stamps the resume");
  });

  it("falls back to an empty state for an unreadable snapshot", () => {
    for (const value of [undefined, null, "x", 42, [], {}]) {
      const snap = toSnapshot(fromSnapshot(value, T0));
      assert.equal(snap.version, 1);
      assert.equal(snap.toolCalls, 0);
      assert.equal(snap.startedAt, T0);
    }
  });

  it("keeps only the understood parts of a snapshot", () => {
    const snap = toSnapshot(fromSnapshot({
      toolCalls: 7,
      toolCallsByName: { read: 3, bash: -1, mystery: "many" },
      filesInspected: ["a.ts", 1, null, ""],
      peakContextTokens: 90_000,
      contextWindow: 200_000,
      compactionCount: 2,
      model: { id: "m" },
      futureField: { nested: true },
    }, T0));

    assert.equal(snap.toolCalls, 7);
    assert.deepEqual(snap.toolCallsByName, { read: 3 });
    assert.deepEqual(snap.filesInspected, ["a.ts"]);
    assert.equal(snap.peakContextTokens, 90_000);
    assert.equal(snap.compactionCount, 2);
    assert.deepEqual(snap.model, { id: "m", provider: "unknown", label: "m" });
    assert.equal("futureField" in snap, false);
  });

  it("normalizes paths without a shell parser", () => {
    assert.equal(normalizePath("./docs/x.md", ROOT), "docs/x.md");
    assert.equal(normalizePath(`${ROOT}/docs/x.md`, ROOT), "docs/x.md");
    assert.equal(normalizePath(`${ROOT}/docs//./x.md`, ROOT), "docs/x.md");
    assert.equal(normalizePath("docs/../docs/x.md", ROOT), "docs/x.md");
    assert.equal(normalizePath("../outside/x.md", ROOT), "../outside/x.md");
    assert.equal(normalizePath("~/x.md", ROOT), "x.md");
    assert.equal(normalizePath(`${ROOT}/`, ROOT), "");
    assert.equal(normalizePath("   ", ROOT), "");
  });

  it("finds the leading word of a command", () => {
    assert.equal(shellHeadWord("grep -r x ."), "grep");
    assert.equal(shellHeadWord("LC_ALL=C rg x"), "rg");
    assert.equal(shellHeadWord("cd docs && sed -n 1p x.md"), "sed");
    assert.equal(shellHeadWord("npm run build | tee log"), "npm");
    assert.equal(shellHeadWord("   "), "");
  });

  it("keeps the shell heuristic small and explicit", () => {
    assert.equal(isInspectionCommand("/usr/bin/head -5 x"), true);
    assert.equal(isInspectionCommand("git log -1"), true);
    assert.equal(isInspectionCommand("git commit -m x"), false);
    assert.equal(isInspectionCommand("git push"), false);
    assert.equal(isInspectionCommand("python train.py"), false);
  });
});

describe("observability rendering", () => {
  function filled() {
    let s = stateFrom(T0);
    s = applyToolCall(s, readCall("docs/x.md"), T0, ROOT);
    s = applyToolResult(s, { content: [{ type: "text", text: "y".repeat(120) }] }, T0);
    s = applyContextUsage(s, usage(34_000));
    return s;
  }

  it("formats tokens and durations compactly", () => {
    assert.equal(formatTokens(820), "820");
    assert.equal(formatTokens(34_000), "34k");
    assert.equal(formatTokens(123_400), "123k");
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(null), "?");
    assert.equal(formatTokens(undefined), "?");
    assert.equal(formatDuration(0), "00:00");
    assert.equal(formatDuration(134_000), "02:14");
    assert.equal(formatDuration(3_846_000), "1:04:06");
    assert.equal(formatDuration(-5_000), "00:00");
  });

  it("renders one compact footer line", () => {
    const footer = renderFooter(toSnapshot(filled()), T0 + 134_000);

    assert.equal(footer.split("\n").length, 1);
    assert.equal(footer, "❈ AIES · listo · ctx 34k");
  });

  it("never puts counters, peak or the compaction count in the footer", () => {
    const without = renderFooter(toSnapshot(filled()), T0);
    const withOne = renderFooter(toSnapshot(applyCompaction(filled(), T0)), T0);

    for (const footer of [without, withOne]) {
      assert.ok(!footer.includes("cmp"), footer);
      assert.ok(!footer.includes("peak"), footer);
      assert.ok(!footer.includes("tools"), footer);
      assert.ok(!footer.includes("files"), footer);
      assert.ok(!footer.includes("02:14"), footer);
    }
  });

  it("renders the report with the same numbers", () => {
    let s = filled();
    s = applyToolCall(s, shell("grep -r x ."), T0, ROOT);
    s = applyToolResult(s, { content: [{ type: "text", text: "z".repeat(80) }] }, T0);
    const report = renderStatusReport(toSnapshot(s), T0 + 60_000);

    assert.equal(report.split("\n")[0], "AIES — estado de la sesión");
    assert.equal(field(report, "actual"), "34k / 200k (17.0%)");
    assert.equal(field(report, "pico"), "34k");
    assert.equal(field(report, "compactaciones"), "0");
    assert.equal(field(report, "llamadas"), "2");
    assert.equal(field(report, "lecturas"), "1");
    assert.equal(field(report, "búsquedas"), "0");
    assert.equal(field(report, "shell inspección"), "1");
    assert.equal(field(report, "archivos"), "1");
    assert.equal(field(report, "devueltos"), "2");
    assert.equal(field(report, "caracteres"), "200");
    assert.equal(field(report, "mayor"), "120 caracteres");
    assert.equal(field(report, "activa"), "01:00");
    assert.match(report, /Mide, no gobierna/u);
  });

  it("shows which tools the parent used most", () => {
    let s = stateFrom();
    for (const call of [readCall("a.ts"), readCall("b.ts"), shell("ls"), toolCall("grep", {})]) {
      s = applyToolCall(s, call, T0, ROOT);
    }
    const report = renderStatusReport(toSnapshot(s), T0);

    assert.equal(field(report, "más usadas"), "read 2 · bash 1 · grep 1");
  });

  it("keeps unknown values readable", () => {
    const report = renderStatusReport(toSnapshot(stateFrom()), T0);

    assert.equal(field(report, "actual"), "?");
    assert.equal(field(report, "pico"), "0");
    assert.equal(field(report, "modelo"), "-");
    assert.equal(field(report, "más usadas"), "-");
    assert.equal(field(report, "motivo de parada"), "-");
  });
});

/**
 * Minimal stand-in for Pi's extension host: records what the extension registers,
 * exposes a fake context, and lets a test dispatch events. No Pi runtime, no
 * model, no terminal.
 */
function createHost(overrides = {}) {
  const options = {
    mode: "tui",
    hasUI: true,
    cwd: ROOT,
    contextUsage: usage(10_000),
    entries: [],
    activeTools: ["read", "bash", "edit", "write"],
    sessionId: "session-1",
    sessionFile: "/profile/sessions/session-1.jsonl",
    model: undefined,
    ...overrides,
  };

  const handlers = new Map();
  const commands = new Map();
  const appended = [];
  const footers = [];
  const headers = [];
  const notifications = [];

  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    getActiveTools() {
      if (typeof options.activeTools === "function") return options.activeTools();
      return options.activeTools;
    },
    appendEntry(type, data) {
      appended.push({ type, data });
      if (typeof options.appendEntry === "function") options.appendEntry(type, data);
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
      if (typeof options.contextUsage === "function") return options.contextUsage();
      return options.contextUsage;
    },
    sessionManager: {
      getSessionId: () => options.sessionId,
      getSessionFile: () => options.sessionFile,
      getEntries() {
        if (typeof options.entries === "function") return options.entries();
        return options.entries;
      },
    },
    ui: {
      setFooter: (factory) => {
        footers.push(factory);
      },
      setHeader: (factory) => {
        headers.push(factory);
      },
      notify: (message, type) => {
        notifications.push({ message, type });
      },
    },
  };

  async function emit(event, payload = {}) {
    const results = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...payload }, ctx));
    }
    return results;
  }

  /** Render the installed custom footer, or `undefined` when none was installed. */
  function footerText(width = 29) {
    const factory = footers.at(-1);
    if (typeof factory !== "function") return undefined;
    const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {});
    return component.render(width).join("\n");
  }

  async function start(reason = "startup") {
    await emit("session_start", { reason });
    return { footer: { key: "aies", text: footerText() } };
  }

  async function report() {
    const command = commands.get("aies-status");
    assert.ok(command, "aies-status is not registered");
    notifications.length = 0;
    await command.handler("detalle", ctx);
    assert.equal(notifications.length, 1, "the command reports exactly once");
    return notifications[0].message;
  }

  async function overview() {
    const command = commands.get("aies-status");
    assert.ok(command, "aies-status is not registered");
    notifications.length = 0;
    await command.handler("", ctx);
    assert.equal(notifications.length, 1, "the command reports exactly once");
    return notifications[0].message;
  }

  return { emit, start, report, overview, handlers, commands, appended, footers, headers, footerText, notifications, ctx, options };
}

describe("verification observability (AIES-005)", () => {
  const verifyResult = (verification) => ({
    toolName: "aies_delegate",
    input: { role: "verify" },
    content: [{ type: "text", text: "### Verify Result" }],
    isError: false,
    details: { verification },
  });

  it("keeps the footer quiet until something was verified", () => {
    const footer = renderFooter(toSnapshot(createState(T0)), T0);

    assert.equal(footer.includes("V:"), false, footer);
    assert.equal(footer.includes("VERIFY"), false, footer);
  });

  it("names an in-flight verification and settles to DONE on a valid pass", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", toolCall("aies_delegate", { role: "verify" }));
    assert.match(host.footerText(), /· VERIFY ·/u);
    assert.equal(host.footerText().includes("V:"), false, host.footerText());

    await host.emit("tool_result", verifyResult({ status: "pass", attempts: 1, repairs: 0, maxRepairs: 2, valid: true }));

    const footer = host.footerText();
    assert.match(footer, /· DONE ·/u);
    assert.equal(footer.includes("V:PASS"), false, footer);
    assert.equal(footer.includes("VERIFY"), false);
  });

  it("marks an old PASS as stale once the artifact changes", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", toolCall("aies_delegate", { role: "verify" }));
    await host.emit("tool_result", verifyResult({ status: "pass", attempts: 1, repairs: 0, maxRepairs: 2, valid: true }));
    assert.match(host.footerText(), /· DONE ·/u);

    await host.emit("tool_call", toolCall("edit", { path: "config.js" }));

    assert.match(host.footerText(), /V:STALE/u);
    const report = await host.report();
    assert.equal(field(report, "estado"), "PASS");
    assert.equal(field(report, "válido"), "no");
    assert.equal(field(report, "intentos"), "1");
    assert.equal(field(report, "reparaciones"), "0 / 2");
    assert.equal(field(report, "cambios tras PASS"), "1");
    assert.match(field(report, "última duración"), /^\d{2}:\d{2}$/u);
  });

  it("distinguishes FAIL and BLOCKED from an absent verdict", async () => {
    const failed = createHost();
    await failed.start();
    await failed.emit("tool_call", toolCall("aies_delegate", { role: "verify" }));
    await failed.emit("tool_result", verifyResult({ status: "fail", attempts: 1, repairs: 0, maxRepairs: 2, valid: false }));
    assert.match(failed.footerText(), /V:FAIL/u);
    assert.equal(field(await failed.report(), "estado"), "FAIL");

    const blocked = createHost();
    await blocked.start();
    await blocked.emit("tool_call", toolCall("aies_delegate", { role: "verify" }));
    await blocked.emit("tool_result", verifyResult({ status: "blocked", attempts: 1, repairs: 0, maxRepairs: 2, valid: false }));
    assert.match(blocked.footerText(), /· BLOCKED ·/u);
    assert.equal(blocked.footerText().includes("V:BLOCKED"), false, blocked.footerText());
    assert.equal(field(await blocked.report(), "estado"), "BLOCKED");
  });

  it("shows a protocol error distinctly, never as a domain verdict", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", toolCall("aies_delegate", { role: "verify" }));
    await host.emit("tool_result", verifyResult({ status: "protocol_error", attempts: 1, repairs: 0, maxRepairs: 2, valid: false, awaitingVerification: true }));

    const footer = host.footerText();
    assert.match(footer, /V:ERROR/u);
    assert.equal(footer.includes("V:FAIL"), false, footer);
    assert.equal(footer.includes("V:BLOCKED"), false, footer);
    const report = await host.report();
    assert.equal(field(report, "estado"), "error de protocolo");
    assert.equal(report.includes("PROTOCOL_ERROR"), false, "a raw internal code leaked into the report");
  });

  it("survives a hostile or absent report without changing what it observes", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", toolCall("aies_delegate", { role: "verify" }));
    await host.emit("tool_result", { toolName: "aies_delegate", input: { role: "verify" }, content: "x", details: { verification: "not an object" } });
    await host.emit("tool_result", { toolName: "aies_delegate", input: { role: "verify" }, content: "x", details: null });

    assert.match(await host.report(), /Mide, no gobierna/u);
    assert.equal(field(await host.report(), "intentos"), "1");
  });

  it("restores the verification counters from a persisted snapshot", async () => {
    const host = createHost({
      entries: [
        {
          type: "custom",
          customType: "aies-metrics",
          data: {
            version: 1,
            startedAt: T0 - 1000,
            toolCalls: 4,
            verification: { status: "fail", attempts: 2, repairs: 1, maxRepairs: 2, valid: false, mutationsSincePass: 0 },
          },
        },
      ],
    });
    await host.start("resume");

    assert.match(host.footerText(), /V:FAIL/u);
    assert.equal(field(await host.report(), "intentos"), "2");
    assert.equal(field(await host.report(), "reparaciones"), "1 / 2");

    await host.emit("session_shutdown", { reason: "quit" });
    assert.equal(host.appended.at(-1).data.verification.status, "fail");
  });
});

describe("observability extension", () => {
  it("registers observation, and nothing that intervenes", () => {
    const host = createHost();

    assert.deepEqual(
      [...host.handlers.keys()].sort(),
      [
        "agent_settled",
        "model_select",
        "session_compact",
        "session_shutdown",
        "session_start",
        "tool_call",
        "tool_result",
        "turn_end",
      ],
    );
    assert.deepEqual([...host.commands.keys()], ["aies-status"]);
    assert.match(host.commands.get("aies-status").description, /solo medición/u);
  });

  it("shows a footer line at session start", async () => {
    const host = createHost();
    const { footer } = await host.start();

    assert.equal(footer.key, "aies");
    assert.match(footer.text, /^❈ AIES · listo · ctx 10k$/u);
  });

  it("counts a tool call and leaves the call untouched", async () => {
    const host = createHost();
    await host.start();

    const event = { type: "tool_call", toolCallId: "c1", toolName: "read", input: { path: "docs/x.md" } };
    const before = structuredClone(event);
    const results = await host.emit("tool_call", event);

    assert.deepEqual(results, [undefined], "an observer must not answer a tool_call");
    assert.deepEqual(event, before, "the event must not be mutated");
    assert.equal(field(await host.report(), "llamadas"), "1");
    assert.equal(field(await host.report(), "archivos"), "1");
  });

  it("accumulates calls of every kind", async () => {
    const host = createHost();
    await host.start();

    for (const event of [readCall("docs/a.md"), readCall("docs/a.md"), shell("ls"), toolCall("grep", { pattern: "x" })]) {
      await host.emit("tool_call", event);
    }

    const report = await host.report();
    assert.equal(field(report, "llamadas"), "4");
    assert.equal(field(report, "lecturas"), "2");
    assert.equal(field(report, "búsquedas"), "1");
    assert.equal(field(report, "shell inspección"), "1");
    assert.equal(field(report, "archivos"), "1");
  });

  it("accumulates result size without changing the result", async () => {
    const host = createHost();
    await host.start();

    const event = {
      type: "tool_result",
      toolCallId: "c1",
      toolName: "read",
      input: { path: "docs/x.md" },
      content: [{ type: "text", text: "hello" }],
      isError: false,
    };
    const before = structuredClone(event);
    const results = await host.emit("tool_result", event);

    assert.deepEqual(results, [undefined], "an observer must not patch a tool_result");
    assert.deepEqual(event, before, "the result must reach the model untouched");

    const report = await host.report();
    assert.equal(field(report, "devueltos"), "1");
    assert.equal(field(report, "caracteres"), "5");
    assert.equal(field(report, "mayor"), "5 caracteres");
  });

  it("keeps the peak across a drop and stamps a compaction", async () => {
    const host = createHost();
    await host.start();

    host.options.contextUsage = usage(120_000);
    await host.emit("tool_result", { toolName: "bash", content: [{ type: "text", text: "x" }] });
    host.options.contextUsage = usage(20_000);
    await host.emit("session_compact", { reason: "threshold", willRetry: false });

    const report = await host.report();
    assert.equal(field(report, "actual"), "20k / 200k (10.0%)");
    assert.equal(field(report, "pico"), "120k");
    assert.equal(field(report, "compactaciones"), "1");
    assert.equal(host.footerText().includes("cmp"), false, host.footerText());
  });

  it("tracks model, tool surface and final state", async () => {
    const host = createHost({ model: { id: "model-a", provider: "anthropic", name: "Model A" } });
    await host.start();

    await host.emit("turn_end", { turnIndex: 0, message: { role: "assistant", stopReason: "toolUse", content: [] }, toolResults: [] });
    host.options.model = { id: "model-b", provider: "openai", name: "Model B" };
    await host.emit("model_select", { model: host.options.model });

    const report = await host.report();
    assert.equal(field(report, "modelo"), "model-b (openai)");
    assert.equal(field(report, "herramientas activas"), "4");
    assert.equal(field(report, "motivo de parada"), "toolUse");
    assert.equal(field(report, "sesión"), "session-1");
  });

  it("reflects the current state in /aies-status", async () => {
    const host = createHost();
    await host.start();

    await host.emit("tool_call", readCall("docs/x.md"));
    assert.equal(field(await host.report(), "llamadas"), "1");

    await host.emit("tool_call", shell("sed -n '1,2p' docs/x.md"));
    const report = await host.report();
    assert.equal(field(report, "llamadas"), "2");
    assert.equal(field(report, "shell inspección"), "1");
    assert.equal(host.notifications.every((entry) => entry.type === "info"), true);
  });

  it("makes the human overview the default and keeps the full report one argument away", async () => {
    const host = createHost();
    await host.start();
    await host.emit("tool_call", readCall("docs/x.md"));

    const overview = await host.overview();
    assert.equal(overview.split("\n")[0], "AIES");
    assert.match(overview, /^Contexto$/mu);
    assert.equal(overview.includes("más usadas"), false);
    assert.equal(overview.includes("caracteres"), false);
    assert.equal(overview.includes("stop reason"), false);

    const report = await host.report();
    assert.equal(report.split("\n")[0], "AIES — estado de la sesión");
    assert.equal(field(report, "más usadas"), "read 1");
    assert.match(report, /Mide, no gobierna/u);
  });

  it("never blocks or rewrites, whatever it observes", async () => {
    const host = createHost();
    await host.start();

    const hostile = [
      ["tool_call", { toolName: "read", input: null }],
      ["tool_call", { toolName: "mystery" }],
      ["tool_call", { toolName: "bash", input: { command: 42 } }],
      ["tool_result", { toolName: "read", content: undefined }],
      ["tool_result", { toolName: "read", content: [{ type: "text" }, null, 7, "raw"] }],
      ["turn_end", { message: { role: "user" } }],
      ["turn_end", {}],
      ["session_compact", {}],
      ["model_select", { model: undefined }],
      ["agent_settled", {}],
    ];

    for (const [event, payload] of hostile) {
      assert.deepEqual(await host.emit(event, payload), [undefined], `${event} must not answer to Pi`);
    }

    assert.match(await host.report(), /Mide, no gobierna/u);
  });

  it("degrades to silence when the host itself fails", async () => {
    const host = createHost({
      contextUsage: () => {
        throw new Error("no usage yet");
      },
      activeTools: () => {
        throw new Error("no surface yet");
      },
      entries: () => {
        throw new Error("no entries yet");
      },
    });

    await host.start("resume");
    assert.deepEqual(await host.emit("tool_call", readCall("x.ts")), [undefined]);

    const report = await host.report();
    assert.equal(field(report, "llamadas"), "1");
    assert.equal(field(report, "actual"), "?");
    assert.equal(field(report, "archivos"), "1");
    assert.deepEqual(host.appended, [], "a failed resume lookup never writes a snapshot");
  });

  it("stays quiet outside the interactive TUI", async () => {
    const host = createHost({ mode: "print", hasUI: false });
    await host.start();
    await host.emit("tool_call", readCall("docs/x.md"));

    assert.equal(host.footerText(), undefined, "no footer where there is no TUI");
    assert.equal(host.headers.length, 0, "no header where there is no TUI");
    assert.equal(field(await host.report(), "llamadas"), "1", "the metrics still accumulate");
  });

  it("persists one snapshot when the session is torn down", async () => {
    const host = createHost();
    await host.start();
    await host.emit("tool_call", readCall("docs/x.md"));
    await host.emit("session_shutdown", { reason: "quit" });

    assert.equal(host.appended.length, 1);
    assert.equal(host.appended[0].type, "aies-metrics");
    assert.equal(host.appended[0].data.toolCalls, 1);
    assert.deepEqual(host.appended[0].data.filesInspected, ["docs/x.md"]);
    assert.ok(JSON.stringify(host.appended[0].data).length < 4000, "the snapshot stays small");
  });

  it("resumes cumulative counters from the persisted snapshot", async () => {
    const previous = {
      version: 1,
      startedAt: T0 - 600_000,
      toolCalls: 9,
      sourceReads: 4,
      filesInspected: ["a.ts", "b.ts"],
      peakContextTokens: 70_000,
      contextWindow: 200_000,
      compactionCount: 2,
    };
    const host = createHost({ entries: [{ type: "custom", customType: "aies-metrics", data: previous }] });
    await host.start("resume");

    const report = await host.report();
    assert.equal(field(report, "llamadas"), "9");
    assert.equal(field(report, "compactaciones"), "2");
    assert.equal(field(report, "pico"), "70k");
    assert.equal(field(report, "archivos"), "2");
    assert.ok(field(report, "esta ejecución"), "the resume is visible");

    await host.emit("tool_call", readCall("c.ts"));
    const after = await host.report();
    assert.equal(field(after, "llamadas"), "10");
    assert.equal(field(after, "archivos"), "3");

    await host.emit("session_shutdown", { reason: "resume" });
    assert.equal(host.appended.at(-1).data.toolCalls, 10, "the next session continues from here");
  });

  it("starts from zero when the session has no snapshot", async () => {
    const host = createHost({ entries: [{ type: "message", message: { role: "user" } }] });
    await host.start("resume");

    assert.equal(field(await host.report(), "llamadas"), "0");
  });

  it("restarts the counters when a new session starts in the same process", async () => {
    const host = createHost();
    await host.start();
    await host.emit("tool_call", readCall("docs/x.md"));
    await host.emit("session_compact", {});
    assert.equal(field(await host.report(), "llamadas"), "1");

    await host.emit("session_shutdown", { reason: "new" });
    await host.start("new");

    const report = await host.report();
    assert.equal(field(report, "llamadas"), "0");
    assert.equal(field(report, "compactaciones"), "0");
    assert.equal(field(report, "archivos"), "0");
  });
});
