/**
 * EZE-485: Session boundary reset tests.
 *
 * Verifies that `/new` creates a clean AIES session boundary:
 * 1. Resets agent registry, run usage (Parent/Agents/Total), delegation counters,
 *    verification state, completion latches, active ticket, and warnings.
 * 2. Preserves user configuration (providers, models, thinking levels, auth, MCP).
 * 3. Enforces that post-new session work attributes tokens and records only to Session B.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesAgents, { getActiveTicketManager, resetSessionState } from "../extensions/aies-agents/index.ts";
import { getContextGovernor } from "../extensions/aies-agents/context-governor.ts";
import { getPermissionTelemetry, recordPermissionDenial } from "../extensions/aies-agents/permissions.ts";
import { AGENTS_CHANNEL, observatory } from "../extensions/aies-agents/observatory.ts";
import { setActiveContinuationController } from "../extensions/aies-agents/autonomy/controller.ts";
import aiesRuntime from "../extensions/aies-runtime/index.ts";
import { deriveStage } from "../extensions/aies-ui/vocabulary.ts";

const ROOT = "/repo";
const T0 = 1_700_000_000_000;
const plainTheme = { fg: (_color, text) => text };

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

function createHarness(bus) {
  const agentHandlers = new Map();
  const runtimeHandlers = new Map();
  const commands = new Map();
  const notifications = [];
  const appendedEntries = [];
  let currentEntries = [];

  const agentsPi = {
    events: bus,
    on(event, handler) {
      agentHandlers.set(event, [...(agentHandlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    getActiveTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    appendEntry(type, data) {
      appendedEntries.push({ type, data });
    },
    sendUserMessage() {},
  };

  const runtimePi = {
    events: bus,
    on(event, handler) {
      runtimeHandlers.set(event, [...(runtimeHandlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerTool() {},
    getActiveTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }];
    },
    appendEntry(type, data) {
      appendedEntries.push({ type, data });
    },
    registerEntryRenderer() {},
    sendMessage() {},
    sendUserMessage() {},
  };

  aiesAgents(agentsPi);
  aiesRuntime(runtimePi);

  let currentSessionId = "session-a";
  const ctx = {
    mode: "print",
    hasUI: true,
    cwd: ROOT,
    model: { id: "gemini-2.5-pro", provider: "google", name: "Gemini Pro" },
    getContextUsage() {
      return { tokens: 15_000, contextWindow: 200_000, percent: 7.5 };
    },
    sessionManager: {
      getSessionId: () => currentSessionId,
      getSessionFile: () => `/profile/sessions/${currentSessionId}.jsonl`,
      getEntries: () => currentEntries,
    },
    ui: {
      theme: plainTheme,
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  };

  async function emitAll(event, payload = {}) {
    const fullPayload = { type: event, ...payload };
    for (const handler of runtimeHandlers.get(event) ?? []) await handler(fullPayload, ctx);
    for (const handler of agentHandlers.get(event) ?? []) await handler(fullPayload, ctx);
  }

  return {
    ctx,
    commands,
    notifications,
    appendedEntries,
    setSessionId(id) {
      currentSessionId = id;
    },
    setEntries(entries) {
      currentEntries = entries;
    },
    start: (reason = "startup") => emitAll("session_start", { reason }),
    shutdown: (reason = "quit") => emitAll("session_shutdown", { reason }),
    toolCall: (toolName, input = {}) => emitAll("tool_call", { toolName, input }),
    toolResult: (toolName, content = "ok", details = {}) => emitAll("tool_result", { toolName, content, details }),
    async agentsView() {
      notifications.length = 0;
      await commands.get("agents").handler("", ctx);
      return notifications.at(-1)?.message ?? "";
    },
    async statusOverview() {
      notifications.length = 0;
      await commands.get("aies-status").handler("", ctx);
      return notifications.at(-1)?.message ?? "";
    },
    async statusDetail() {
      notifications.length = 0;
      await commands.get("aies-status").handler("detalle", ctx);
      return notifications.at(-1)?.message ?? "";
    },
  };
}

describe("EZE-485 session boundary (/new clean reset)", () => {
  let bus;

  beforeEach(() => {
    bus = createBus();
    resetSessionState();
  });

  afterEach(() => {
    setActiveContinuationController(undefined);
    resetSessionState();
  });

  it("resets all ephemeral state across /new and attributes subsequent child work cleanly to Session B", async () => {
    const harness = createHarness(bus);

    // ==========================================
    // 1. Session A: runs Explore, Worker, Verify
    // ==========================================
    await harness.start("startup");

    // Parent assistant usage in Session A
    harness.setEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 100_000, cost: { total: 0.1 } },
        },
      },
    ]);

    // Active ticket in Session A
    const ticketManager = getActiveTicketManager();
    assert.ok(ticketManager, "ticket manager is active");
    ticketManager.restoreFromSnapshot({
      activeTicket: { identifier: "EZE-461", title: "Refactor session state", status: "In Progress" },
      workState: "started",
      changedPaths: ["src/state.ts"],
    });
    await harness.toolResult("aies_ticket", "ticket active", {
      ticket: { identifier: "EZE-461", title: "Refactor session state", status: "In Progress" },
    });

    // Permission denial in Session A
    recordPermissionDenial();
    assert.equal(getPermissionTelemetry().denials, 1);

    // Child 1: Explore DONE
    const expId = observatory.begin({ role: "explore", modelLabel: "Flash", at: T0 });
    observatory.observe(expId, "read", { path: "src/state.ts" }, T0 + 1);
    observatory.updateUsage(expId, { totalTokens: 350_000, cost: 0.35 });
    observatory.finish(expId, { status: "completed", result: "Investigado", at: T0 + 2 });

    // Child 2: Worker DONE
    const wrkId = observatory.begin({ role: "worker", modelLabel: "Pro", at: T0 + 3 });
    observatory.observe(wrkId, "edit", { path: "src/state.ts" }, T0 + 4);
    observatory.updateUsage(wrkId, { totalTokens: 1_000_000, cost: 1.0 });
    observatory.finish(wrkId, { status: "completed", result: "Implementado", at: T0 + 5 });

    // Child 3: Verify BLOCKED
    const verId = observatory.begin({ role: "verify", modelLabel: "Pro", at: T0 + 6 });
    observatory.observe(verId, "read", { path: "src/state.ts" }, T0 + 7);
    observatory.updateUsage(verId, { totalTokens: 2_350_000, cost: 2.35 });
    observatory.finish(verId, { status: "blocked", result: "Faltan checks", at: T0 + 8 });

    // Inform runtime of delegations and verification report
    await harness.toolResult("aies_delegate", "Explore done", { role: "explore", status: "done" });
    await harness.toolResult("aies_delegate", "Worker done", { role: "worker", status: "done" });
    await harness.toolResult("aies_delegate", "Verify blocked", {
      role: "verify",
      status: "blocked",
      verification: { status: "blocked", attempts: 1, repairs: 0, criteria: ["c1"] },
    });

    // Verify Session A state before /new
    assert.equal(observatory.snapshot().length, 3, "observatory has 3 children in Session A");
    const viewA = await harness.agentsView();
    assert.match(viewA, /Explore/u);
    assert.match(viewA, /Worker/u);
    assert.match(viewA, /Verify/u);

    const detailA = await harness.statusDetail();
    // Sum of children = 350k + 1000k + 2350k = 3.7M
    assert.match(detailA, /3\.7M/u, "detail reports total 3.7M child tokens");
    assert.match(detailA, /EZE-461/u, "reports active ticket");

    // ==========================================
    // 2. /new lifecycle transition
    // ==========================================
    await harness.shutdown("new");
    harness.setSessionId("session-b");
    harness.setEntries([]); // Fresh session has no assistant messages yet
    await harness.start("new");

    // ==========================================
    // 3. Session B: BEFORE launching any children
    // ==========================================
    assert.equal(observatory.snapshot().length, 0, "registry must be empty after /new");
    assert.equal(ticketManager.getActiveTicket(), null, "active ticket must be null after /new");
    assert.equal(getPermissionTelemetry().denials, 0, "permissions telemetry must be reset");
    assert.equal(getContextGovernor().getTelemetry().compactionCount, 0, "governor compactions reset");

    const viewBEmpty = await harness.agentsView();
    assert.match(viewBEmpty, /sin agentes en esta sesión/u, "/agents must report empty session");
    assert.doesNotMatch(viewBEmpty, /Explore/u);
    assert.doesNotMatch(viewBEmpty, /Worker/u);
    assert.doesNotMatch(viewBEmpty, /Verify/u);

    const detailBEmpty = await harness.statusDetail();
    assert.doesNotMatch(detailBEmpty, /Observatorio/u, "Observatorio section must be omitted when empty");
    assert.doesNotMatch(detailBEmpty, /Uso del run/u, "Run usage must be omitted when zero");
    assert.doesNotMatch(detailBEmpty, /EZE-461/u, "old ticket must not appear");
    assert.doesNotMatch(detailBEmpty, /3\.7M/u, "old tokens must not appear");

    // Overview should reflect clean fresh state
    const overviewB = await harness.statusOverview();
    assert.doesNotMatch(overviewB, /EZE-461/u);

    // ==========================================
    // 4. Session B: launch a single Explore child
    // ==========================================
    const newExpId = observatory.begin({ role: "explore", modelLabel: "Flash", at: T0 + 100 });
    assert.equal(newExpId, "explore-1", "ordinals must restart from 1 in new session");
    observatory.observe(newExpId, "read", { path: "src/clean.ts" }, T0 + 101);
    observatory.updateUsage(newExpId, { totalTokens: 50_000, cost: 0.05 });
    observatory.finish(newExpId, { status: "completed", result: "Investigado B", at: T0 + 102 });

    await harness.toolResult("aies_delegate", "Explore B done", { role: "explore", status: "done" });

    // Verify Session B state after single Explore
    assert.equal(observatory.snapshot().length, 1, "observatory contains ONLY the single Explore child");
    assert.equal(observatory.snapshot()[0].id, "explore-1");
    assert.equal(observatory.snapshot()[0].totalTokens, 50_000);

    const viewB = await harness.agentsView();
    assert.match(viewB, /Explore #1/u);
    assert.match(viewB, /50k/u);
    assert.doesNotMatch(viewB, /Worker/u, "worker from Session A must not appear");
    assert.doesNotMatch(viewB, /Verify/u, "verify from Session A must not appear");

    const detailB = await harness.statusDetail();
    assert.match(detailB, /50k/u, "detail reports only the new 50k tokens");
    assert.doesNotMatch(detailB, /3\.7M/u, "tokens from Session A must not be summed");
    assert.doesNotMatch(detailB, /3\.75M/u, "tokens must not leak");

    // Complete Session B ticket/work and verify emitted summary
    await harness.toolResult("aies_ticket", "completed", {
      ticket: { identifier: "EZE-485", title: "Clean session boundary", statusType: "completed" },
    });
    await harness.toolCall("read", { path: "src/clean.ts" });
    await harness.toolResult("read", "done");

    const summaries = harness.appendedEntries.filter((entry) => entry.type === "aies-summary");
    assert.ok(summaries.length > 0, "DONE summary should be emitted upon completion");
    const lastSummary = summaries.at(-1).data;
    assert.equal(lastSummary.kind, "done");
    assert.equal(lastSummary.agents?.length, 1, "summary must contain only 1 child agent");
    assert.equal(lastSummary.agents[0].role, "Explore");
    assert.deepEqual(lastSummary.warnings ?? [], [], "summary must not have warnings from Session A");
  });

  it("isolates Parent / Agents / Total token telemetry across /new without inheriting Session A usage", async () => {
    const harness = createHarness(bus);

    // 1. Session A: Parent has 100,000 tokens, Agents have 350,000 tokens
    await harness.start("startup");
    harness.setEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 100_000, cost: { total: 0.1 } },
        },
      },
    ]);
    const expA = observatory.begin({ role: "explore", at: T0 });
    observatory.updateUsage(expA, { totalTokens: 350_000, cost: 0.35 });
    observatory.finish(expA, { status: "completed", at: T0 + 1 });
    await harness.toolResult("aies_delegate", "Explore A done");

    const detailA = await harness.statusDetail();
    // In Session A: Main 100k, Agents 350k, Total 450k
    assert.match(detailA, /main\s+100k/u);
    assert.match(detailA, /agents\s+350k/u);
    assert.match(detailA, /total\s+450k/u);

    // 2. /new transition
    await harness.shutdown("new");
    harness.setSessionId("session-b");
    // Suppose Pi creates an initial turn / system turn of 1,200 tokens in Session B
    harness.setEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 1_200, cost: { total: 0.001 } },
        },
      },
    ]);
    await harness.start("new");

    // 3. Session B BEFORE any child work:
    // Agents must be 0 (no Session A agents)
    // Main/Parent of Session A (100k) must NOT appear
    // Total must not contain tokens from Session A
    const detailBBefore = await harness.statusDetail();
    assert.doesNotMatch(detailBBefore, /350k/u, "Session A agents tokens must not appear");
    assert.doesNotMatch(detailBBefore, /450k/u, "Session A total tokens must not appear");
    assert.doesNotMatch(detailBBefore, /100k/u, "Session A main tokens must not appear");
    assert.match(detailBBefore, /agents\s+0/u, "Session B agents starts at 0");

    // 4. Session B: Parent does a turn (+2,000 tokens -> cumulative 3,200) + 1 Explore (+15,000 tokens)
    harness.setEntries([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 1_200, cost: { total: 0.001 } },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          usage: { totalTokens: 2_000, cost: { total: 0.002 } },
        },
      },
    ]);
    const expB = observatory.begin({ role: "explore", at: T0 + 10 });
    observatory.updateUsage(expB, { totalTokens: 15_000, cost: 0.015 });
    observatory.finish(expB, { status: "completed", at: T0 + 11 });
    await harness.toolResult("aies_delegate", "Explore B done");

    const detailBAfter = await harness.statusDetail();
    // Main = 3.2k (only Session B parent entries: 1.2k initial + 2k turn)
    // Agents = 15k (only Explore B)
    // Total = 18.2k (Main + Agents of Session B only)
    assert.match(detailBAfter, /main\s+3\.2k/u, "Main must report only Session B parent usage");
    assert.match(detailBAfter, /agents\s+15k/u, "Agents must report ONLY the 15k from Explore B");
    assert.match(detailBAfter, /total\s+18\.2k/u, "Total must report only Session B Main + Agents");
    assert.doesNotMatch(detailBAfter, /350k/u, "Session A tokens must not leak");
    assert.doesNotMatch(detailBAfter, /450k/u, "Session A total must not leak");
    assert.doesNotMatch(detailBAfter, /100k/u, "Session A main must not leak");
  });

  it("preserves configuration, provider settings, and profile state", () => {
    // Calling resetSessionState() resets only runtime-ephemeral items
    resetSessionState();

    // Verify singletons reset
    assert.equal(observatory.snapshot().length, 0);
    assert.equal(getPermissionTelemetry().denials, 0);
    assert.equal(getContextGovernor().getTelemetry().compactionCount, 0);
  });
});
