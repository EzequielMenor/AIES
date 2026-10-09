/**
 * EZE-503 regression: a pending final action the user asked for outranks Verify PASS.
 *
 * The defect (sessions EZE-492 and EZE-493): `Verify PASS` was read as an
 * unconditional completion signal. The Parent ran `aies_ticket complete` — or a
 * direct `mcp save_issue` into `Done` — while it had still been told "no commit
 * todavía" / "quiero revisarlo antes", so Linear moved ahead of reality with an
 * uncommitted, unreviewed working tree.
 *
 * These tests pin the corrected completion path:
 * 1. Explicit user wording is the only thing that creates a hold, and it is read
 *    from the user's own input (report-shaped and interrogative text never holds).
 * 2. The Done Gate refuses while a hold stands, for behaviour-bearing AND
 *    docs-only changes, quoting the user's words.
 * 3. A refusal sends nothing to Linear, keeps the ticket open and leaves the
 *    verification record untouched; `force: true` is the user's confirmation.
 * 4. Absent an explicit hold, completion works exactly as before: a commit is
 *    never universally required.
 * 5. The hold survives later work and a session resume, is lifted only by an
 *    explicit user confirmation, and belongs to the ticket it was asked for.
 * 6. Bounded autonomy pauses for the human instead of continuing toward Done.
 * 7. The raw `mcp save_issue` -> Done bypass is blocked while the hold stands.
 * 8. The collapsed tool row stays Spanish and never leaks the internal code.
 * 9. The runtime shell shows no DONE while the completion is held, and reaches it
 *    once the user confirms and Linear really moved.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import aiesAgents, { getActiveTicketManager, resetSessionState } from "../extensions/aies-agents/index.ts";
import aiesRuntime from "../extensions/aies-runtime/index.ts";
import { setActiveContinuationController, ContinuationController } from "../extensions/aies-agents/autonomy/controller.ts";
import { ContextGovernor } from "../extensions/aies-agents/context-governor.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { checkDoneGate } from "../extensions/aies-agents/linear/policy.ts";
import {
  isDirectLinearCompletion,
  linearCompletionBypassReason,
  readFinalActionDirective,
} from "../extensions/aies-agents/linear/pending-action.ts";
import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import { FakeLinearTransport } from "../extensions/aies-agents/linear/transport.ts";
import { createRoutingState } from "../extensions/aies-agents/routing.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
  isVerificationValid,
  toVerificationReport,
} from "../extensions/aies-agents/verification.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const CODE_PATHS = ["extensions/aies-agents/linear/manager.ts"];
const DOCS_PATHS = ["docs/DECISIONS.md"];

/** The wording that was live in the EZE-492 / EZE-493 sessions. */
const PENDING_REQUESTS = [
  "no commit todavía",
  "no hagas commit todavía",
  "sin commitear",
  "don't commit yet",
  "quiero revisarlo antes",
  "déjalo pendiente de review",
  "queda pendiente de revisión",
  "detente para revisión",
  "no lo marques Done todavía",
];

function sampleIssue(overrides = {}) {
  return {
    id: "issue-eze-503",
    identifier: "EZE-503",
    title: "Verify PASS must not imply Done while a final action is pending",
    description: "Keep the ticket open when the user asked to review first.",
    status: "Todo",
    statusType: "unstarted",
    url: "https://linear.app/issue/EZE-503",
    ...overrides,
  };
}

/**
 * A verification record with a fresh, valid PASS over a behaviour-bearing change:
 * the exact state in which EZE-503 closed the ticket anyway.
 */
function freshPass(revision = 1) {
  let state = createVerificationState();
  state = applyWorkUnitChange(state, CODE_PATHS, "worker implemented the fix");
  state = { ...state, revision };
  state = applyVerifyStart(state, 1_700_000_000_000);
  return applyVerifyResult(state, { status: "pass", criteria: [] }, 1_700_000_000_100);
}

function createManager(transport, verificationRef) {
  return new TicketManager({
    transport,
    getVerification: () => verificationRef.state,
  });
}

/** Drives the real agents extension and reads what its handlers answer. */
function createAgentsHost() {
  const handlers = new Map();
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    getActiveTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    appendEntry() {},
    sendUserMessage() {},
  };
  aiesAgents(pi);

  return {
    pi,
    async input(text, source = "interactive") {
      for (const handler of handlers.get("input") ?? []) {
        await handler({ type: "input", text, source }, { cwd: REPO, mode: "print", hasUI: false });
      }
    },
    async blockOf(toolName, input) {
      const results = [];
      for (const handler of handlers.get("tool_call") ?? []) {
        results.push(await handler({ type: "tool_call", toolName, input }, { cwd: REPO, mode: "print", hasUI: false }));
      }
      return results.find((result) => result && result.block) ?? null;
    },
  };
}

/**
 * Drives the real runtime observer over the real tool payloads: records the
 * durable entries it appends, the notifications it raises and the footer text it
 * asks the shell to draw. No Pi runtime, no model, no credentials.
 */
function createRuntimeHost() {
  const handlers = new Map();
  const appended = [];
  const footers = [];
  const notifications = [];

  const pi = {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
    getActiveTools() {
      return ["read", "bash", "edit", "write"];
    },
    appendEntry(type, data) {
      appended.push({ type, data });
    },
  };
  aiesRuntime(pi);

  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: REPO,
    model: undefined,
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionId: () => "session-eze-503",
      getSessionFile: () => "/profile/sessions/session-eze-503.jsonl",
      getEntries: () => [],
    },
    ui: {
      setFooter: (factory) => {
        footers.push(factory);
      },
      setHeader: () => {},
      notify: (message, type) => {
        notifications.push({ message, type });
      },
    },
  };

  return {
    appended,
    notifications,
    async emit(event, payload = {}) {
      for (const handler of handlers.get(event) ?? []) {
        await handler({ type: event, ...payload }, ctx);
      }
    },
    /** The footer the observer asked for, or `undefined` when none was installed. */
    footerText(width = 29) {
      const factory = footers.at(-1);
      if (typeof factory !== "function") return undefined;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {});
      return component.render(width).join("\n");
    },
    summaries() {
      return appended.filter((entry) => entry.type === "aies-summary");
    },
  };
}

/** A ticket already loaded in the extension's own manager (no remote, no project). */function seedActiveTicket(manager, workState = "working") {
  manager.restoreFromSnapshot({
    ticketId: "EZE-503",
    activeTicket: {
      id: "issue-eze-503",
      identifier: "EZE-503",
      title: "Verify PASS must not imply Done",
      description: "",
      acceptanceCriteria: ["completion is refused while the user kept the last step"],
      status: "In Progress",
      statusType: "started",
      loadedAt: 1_700_000_000_000,
    },
    workState,
    lastKnownLinearStatus: "In Progress",
    changedPaths: CODE_PATHS,
    persistedAt: 1_700_000_000_000,
  });
}

const plainTheme = { fg: (_color, value) => value, bold: (value) => value };

function renderContext(args, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

describe("EZE-503 pending final action", () => {
  describe("1. only explicit user wording holds the last step", () => {
    it("records the pending requests raised in the EZE-492/EZE-493 sessions", () => {
      for (const text of PENDING_REQUESTS) {
        const directive = readFinalActionDirective(text);
        assert.equal(directive?.kind, "hold", `${text} must hold finalization`);
        assert.equal(directive.pending.quote, text, `${text} must be kept verbatim as evidence`);
      }
    });

    it("classifies what is being held", () => {
      assert.equal(readFinalActionDirective("no commit todavía")?.pending.kind, "commit");
      assert.equal(readFinalActionDirective("quiero revisarlo antes")?.pending.kind, "review");
      assert.equal(readFinalActionDirective("no lo marques Done todavía")?.pending.kind, "completion");
    });

    it("says nothing about finalization for ordinary work wording", () => {
      for (const text of [
        "implementá el fix y corré npm test",
        "revisá la implementación del loader y pasá los tests",
        "arreglá el bug en manager.ts, no toques el launcher",
        "documentá la regla en docs/DECISIONS.md",
        "",
      ]) {
        assert.equal(readFinalActionDirective(text), null, `${text} must not hold anything`);
      }
    });

    it("never holds on wording that only reports state or asks a question", () => {
      assert.equal(readFinalActionDirective("el worker reportó que no hay commits nuevos"), null);
      assert.equal(readFinalActionDirective("there are no commits yet"), null);
      assert.equal(readFinalActionDirective("¿puedo commitear?"), null);
    });

    it("reads an explicit confirmation as releasing the held step", () => {
      assert.equal(readFinalActionDirective("ya lo revisé, podés commitear y cerrar")?.kind, "release");
      assert.equal(readFinalActionDirective("lgtm, you can close it")?.kind, "release");
    });

    it("lets the last decisive clause win, so a hold stated afterwards still holds", () => {
      const held = readFinalActionDirective("podés commitear más adelante, ahora no commit todavía");
      assert.equal(held?.kind, "hold");
    });
  });

  describe("2-4. the Done Gate", () => {
    it("refuses a fresh valid PASS while the user kept a step, quoting their words", () => {
      const pending = readFinalActionDirective("no commit todavía").pending;
      const gate = checkDoneGate(freshPass(), CODE_PATHS, pending);

      assert.equal(gate.allowed, false);
      assert.equal(gate.code, "pending_final_action");
      assert.match(gate.reason, /no commit todavía/u);
      assert.match(gate.reason, /hold the commit/iu);
    });

    it("refuses even a docs-only change, because the hold is not about verification", () => {
      const pending = readFinalActionDirective("déjalo pendiente de review").pending;
      assert.equal(checkDoneGate(freshPass(), DOCS_PATHS).allowed, true, "docs-only completes with no hold");
      assert.equal(checkDoneGate(freshPass(), DOCS_PATHS, pending).allowed, false);
    });

    it("allows the same gate when nothing was ever held (no commit is universally required)", () => {
      assert.equal(checkDoneGate(freshPass(), CODE_PATHS, null).allowed, true);
      assert.equal(checkDoneGate(freshPass(), CODE_PATHS, undefined).allowed, true);
      assert.equal(checkDoneGate(freshPass(), []).allowed, true, "an empty changed set still completes");
    });

    it("keeps reporting verification refusals as verification", () => {
      const failed = { ...freshPass(), status: "fail", verifiedRevision: undefined };
      const gate = checkDoneGate(failed, CODE_PATHS, null);
      assert.equal(gate.allowed, false);
      assert.equal(gate.code, "verify_gate_denied");
    });
  });

  describe("5. the completion path with a real transport", () => {
    let transport;
    let verificationRef;
    let manager;

    beforeEach(async () => {
      transport = new FakeLinearTransport([sampleIssue()]);
      verificationRef = { state: createVerificationState() };
      manager = createManager(transport, verificationRef);
      await manager.loadTicket("EZE-503");
      await manager.startWork();
      manager.recordChangedPaths(CODE_PATHS);
      verificationRef.state = freshPass();
    });

    it("refuses complete, sends nothing to Linear and keeps the ticket open", async () => {
      manager.recordUserInput("no commit todavía");

      const result = await manager.completeTicket({ evidence: "verified PASS" });

      assert.equal(result.ok, false);
      assert.equal(result.error, "pending_final_action");
      assert.match(result.message ?? "", /Done Gate HELD/iu);
      assert.match(result.message ?? "", /no commit todavía/u);
      assert.match(result.message ?? "", /force: true/u);

      assert.notEqual(manager.getWorkState(), "complete", "the work unit must not reach DONE");
      assert.equal(manager.getWorkState(), "working");
      assert.equal(
        transport.updatedIssues.some((entry) => entry.update.statusId === "status-done"),
        false,
        "no Linear completion write may be attempted",
      );
      assert.deepEqual(transport.addedComments, [], "no completion comment may be posted");
      const remote = await transport.getIssue("EZE-503");
      assert.notEqual(remote?.state?.type, "completed", "Linear must still be open");
    });

    it("leaves the verify evidence intact across the refusal", async () => {
      manager.recordUserInput("quiero revisarlo antes");
      const before = verificationRef.state;

      await manager.completeTicket();

      assert.equal(verificationRef.state, before, "the verification record is not rewritten");
      assert.equal(verificationRef.state.status, "pass");
      assert.ok(isVerificationValid(verificationRef.state), "the PASS is still valid for the same revision");
      assert.deepEqual(manager.getPendingFinalAction()?.kind, "review");
    });

    it("completes when force stands for the user's confirmation", async () => {
      manager.recordUserInput("no commit todavía");

      const held = await manager.completeTicket();
      assert.equal(held.ok, false);

      const done = await manager.completeTicket({ force: true });
      assert.equal(done.ok, true);
      assert.equal(manager.getWorkState(), "complete");
      assert.equal(manager.getPendingFinalAction(), null);
      const remote = await transport.getIssue("EZE-503");
      assert.equal(remote?.state?.type, "completed");
    });

    it("still completes normally when the user never asked to hold anything", async () => {
      manager.recordUserInput("corré npm test y pasame el resultado");

      const done = await manager.completeTicket();

      assert.equal(done.ok, true);
      assert.equal(manager.getWorkState(), "complete");
      assert.equal(manager.getPendingFinalAction(), null);
    });

    it("keeps the hold across the work that follows and an unrelated input", async () => {
      manager.recordUserInput("déjalo pendiente de review");

      // A behaviour-bearing change and a Verify PASS arrive afterwards, plus a
      // continuation-style message that says nothing about the held step.
      verificationRef.state = applyWorkUnitChange(verificationRef.state, CODE_PATHS, "repair");
      verificationRef.state = applyVerifyStart(verificationRef.state, 1_700_000_000_500);
      verificationRef.state = applyVerifyResult(verificationRef.state, { status: "pass", criteria: [] }, 1_700_000_000_600);
      manager.recordUserInput("seguí");

      assert.equal(manager.getPendingFinalAction()?.kind, "review");
      const result = await manager.completeTicket();
      assert.equal(result.ok, false);
      assert.equal(result.error, "pending_final_action");
    });

    it("lifts the hold on the user's explicit confirmation and then completes", async () => {
      manager.recordUserInput("no commit todavía");
      assert.equal((await manager.completeTicket()).ok, false);

      manager.recordUserInput("ya lo revisé, podés commitear");

      assert.equal(manager.getPendingFinalAction(), null);
      assert.equal((await manager.completeTicket()).ok, true);
    });

    it("carries the hold through a session resume", async () => {
      manager.recordUserInput("no commit todavía");
      const snapshot = manager.toSnapshot();
      assert.equal(snapshot.pendingFinalAction?.kind, "commit");

      const resumed = createManager(transport, verificationRef);
      resumed.restoreFromSnapshot(snapshot);

      assert.equal(resumed.getPendingFinalAction()?.kind, "commit");
      const result = await resumed.completeTicket();
      assert.equal(result.ok, false);
      assert.equal(result.error, "pending_final_action");
    });

    it("does not carry the hold onto the next ticket", async () => {
      manager.recordUserInput("no commit todavía");
      transport.seedIssue({ identifier: "EZE-504", title: "Next work unit" });

      await manager.loadTicket("EZE-504", { force: true });

      assert.equal(manager.getPendingFinalAction(), null);
    });

    it("clears the hold on a session reset", () => {
      manager.recordUserInput("no commit todavía");
      manager.reset();
      assert.equal(manager.getPendingFinalAction(), null);
    });
  });

  describe("6. bounded autonomy waits for the human", () => {
    let transport;
    let verification;
    let manager;
    let governor;
    let routing;
    let pi;
    let controller;

    beforeEach(async () => {
      transport = new FakeLinearTransport([sampleIssue()]);
      verification = createVerificationState();
      manager = new TicketManager({ transport, getVerification: () => verification });
      governor = new ContextGovernor({ compactAtTokens: 100_000, ceilingTokens: 120_000 });
      routing = createRoutingState();
      pi = {
        messages: [],
        sendMessage(message, options) {
          pi.messages.push({ text: message?.content, options });
        },
      };
      controller = new ContinuationController({
        pi,
        getRouting: () => routing,
        getVerification: () => verification,
        getGovernor: () => governor,
        getTicketManager: () => manager,
      });
      setActiveContinuationController(controller);
    });

    afterEach(() => {
      setActiveContinuationController(undefined);
    });

    /** A work unit verified PASS, with bounded autonomy armed by the user's turn. */
    async function prepare() {
      await manager.loadTicket("EZE-503");
      await manager.startWork();
      manager.recordChangedPaths(CODE_PATHS);
      verification = freshPass();
      controller.activate("EZE-503");
    }

    it("continues toward Linear completion when nothing is held", async () => {
      await prepare();

      const decision = await controller.handleSettled();

      assert.equal(decision.decision, "continue");
      assert.match(decision.reason, /verified PASS; ready for Linear completion/iu);
    });

    it("pauses for the user instead of closing the ticket on a PASS", async () => {
      await prepare();
      manager.recordUserInput("quiero revisarlo antes");

      const decision = await controller.handleSettled();

      assert.equal(decision.decision, "user_required");
      assert.equal(decision.stopReason, "user_required");
      assert.match(decision.reason, /held for the user/iu);
      assert.match(decision.reason, /quiero revisarlo antes/u);
      assert.equal(controller.isEnabled(), false, "autonomy yields the floor to the human");
      assert.deepEqual(pi.messages, [], "no continuation instruction is delivered over the pending step");
      assert.notEqual(manager.getWorkState(), "complete");
    });

    it("resumes the completion path once the user confirms", async () => {
      await prepare();
      manager.recordUserInput("quiero revisarlo antes");
      assert.equal((await controller.handleSettled()).decision, "user_required");

      manager.recordUserInput("lgtm");
      controller.activate("EZE-503");
      const decision = await controller.handleSettled();

      assert.equal(decision.decision, "continue");
      assert.match(decision.reason, /ready for Linear completion/iu);
      assert.equal((await manager.completeTicket()).ok, true);
    });
  });

  describe("7. the direct mcp save_issue -> Done bypass", () => {
    const active = { identifier: "EZE-503", id: "issue-eze-503" };
    const pending = { kind: "review", quote: "quiero revisarlo antes" };

    it("recognises a raw completion of the active ticket", () => {
      assert.equal(
        isDirectLinearCompletion("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-503", state: "Done" } }, active),
        true,
      );
      assert.equal(
        isDirectLinearCompletion("mcp", { server: "linear", tool: "save_issue", args: { id: "eze-503", state: "Completed" } }, active),
        true,
      );
    });

    it("leaves anything else alone", () => {
      assert.equal(
        isDirectLinearCompletion("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-503", state: "In Progress" } }, active),
        false,
        "a non-completion state is not the final step",
      );
      assert.equal(
        isDirectLinearCompletion("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-999", state: "Done" } }, active),
        false,
        "another ticket is none of this hold",
      );
      assert.equal(
        isDirectLinearCompletion("mcp", { server: "linear", tool: "save_comment", args: { issueId: "EZE-503", body: "note" } }, active),
        false,
      );
      assert.equal(isDirectLinearCompletion("bash", { command: "git commit -m x" }, active), false);
      assert.equal(
        isDirectLinearCompletion("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-503", state: "01a0f665-status-uuid" } }, active),
        false,
        "an opaque status id is never guessed at",
      );
    });

    it("answers with a Spanish reason that keeps the ticket open", () => {
      const reason = linearCompletionBypassReason(
        "mcp",
        { server: "linear", tool: "save_issue", args: { id: "EZE-503", state: "Done" } },
        active,
        pending,
      );
      assert.match(reason ?? "", /Bloqueado/u);
      assert.match(reason ?? "", /quiero revisarlo antes/u);
      assert.match(reason ?? "", /sigue abierto/u);
      assert.match(reason ?? "", /aies_ticket/u);
    });

    it("is enforced by the real extension while the user input created the hold", async () => {
      resetSessionState();
      setActiveContinuationController(undefined);
      const host = createAgentsHost();
      seedActiveTicket(getActiveTicketManager());

      await host.input("no hagas commit todavía, lo reviso yo", "interactive");
      const blocked = await host.blockOf("mcp", {
        server: "linear",
        tool: "save_issue",
        args: { id: "EZE-503", state: "Done" },
      });
      assert.ok(blocked?.block, "the bypass must be blocked while the hold stands");
      assert.match(blocked.reason, /no hagas commit todavía/u);

      const stillOpen = await host.blockOf("mcp", {
        server: "linear",
        tool: "save_issue",
        args: { id: "EZE-503", state: "In Progress" },
      });
      assert.equal(stillOpen, null, "ordinary Linear writes are untouched");

      await host.input("ya lo revisé, podés commitear y cerrar", "interactive");
      const released = await host.blockOf("mcp", {
        server: "linear",
        tool: "save_issue",
        args: { id: "EZE-503", state: "Done" },
      });
      assert.equal(released, null, "the user's confirmation opens the path again");
      resetSessionState();
    });

    it("ignores AIES' own hidden instructions as a source of user intent", async () => {
      resetSessionState();
      setActiveContinuationController(undefined);
      const host = createAgentsHost();
      seedActiveTicket(getActiveTicketManager());

      await host.input("Continue the active AIES ticket workflow from the current state.", "extension");
      assert.equal(getActiveTicketManager().getPendingFinalAction(), null);

      await host.input("no commit todavía", "extension");
      assert.equal(
        getActiveTicketManager().getPendingFinalAction(),
        null,
        "a continuation turn never speaks for the user",
      );
      resetSessionState();
    });
  });

  describe("8. the refusal stays presentable", () => {
    let transport;
    let verificationRef;
    let manager;
    let tool;

    beforeEach(async () => {
      transport = new FakeLinearTransport([sampleIssue()]);
      verificationRef = { state: createVerificationState() };
      manager = new TicketManager({ transport, getVerification: () => verificationRef.state });
      await manager.loadTicket("EZE-503");
      await manager.startWork();
      manager.recordChangedPaths(CODE_PATHS);
      verificationRef.state = freshPass();
      manager.recordUserInput("no commit todavía");
      tool = createTicketTool(manager);
    });

    it("shows one Spanish row for a held completion and never the internal code", async () => {
      const held = await tool.execute("call-1", { action: "complete", ticketId: "EZE-503" }, undefined, undefined, {
        mode: "print",
      });
      const row = tool
        .renderResult(held, { expanded: false, isPartial: false }, plainTheme, renderContext({ action: "complete", ticketId: "EZE-503" }))
        .render(120)
        .join("\n");

      assert.match(row, /✗ EZE-503 ·/u);
      assert.match(row, /pendiente/u);
      assert.equal(row.includes("pending_final_action"), false, `the raw code must not leak: ${row}`);
    });

    it("tells the Parent to wait, and never appends the DONE stop instruction on a refusal", async () => {
      const held = await tool.execute("call-1", { action: "complete", ticketId: "EZE-503" }, undefined, undefined, {
        mode: "print",
      });
      const text = held.content.map((part) => part.text).join("\n");

      assert.equal(held.isError, true);
      assert.match(text, /Done Gate HELD/iu);
      assert.match(text, /Pending final action/iu);
      assert.match(text, /no commit todavía/u);
      assert.equal(text.includes("End the turn now"), false, "a refusal is not a terminal DONE");
      assert.equal(text.includes("pending_final_action"), false, "the model-facing text stays human");
      assert.equal(held.details.workState, "working", "the observed ticket never reaches the DONE state");
    });

    it("reports the held step on show, so the Parent can see what is waiting", async () => {
      const shown = await tool.execute("call-1", { action: "show" }, undefined, undefined, { mode: "print" });
      const text = shown.content.map((part) => part.text).join("\n");

      assert.match(text, /Pending final action/iu);
      assert.match(text, /no commit todavía/u);
      assert.equal(shown.details.pendingFinalAction.kind, "commit");
    });
  });

  describe("9. the runtime shell holds with the ticket", () => {
    let transport;
    let verificationRef;
    let manager;
    let tool;
    let runtime;

    /** One real `aies_ticket` result exactly as Pi hands it to the observer. */
    function ticketResult(result) {
      return { toolName: "aies_ticket", content: result.content, isError: result.isError, details: result.details };
    }

    beforeEach(async () => {
      transport = new FakeLinearTransport([sampleIssue()]);
      verificationRef = { state: createVerificationState() };
      manager = new TicketManager({ transport, getVerification: () => verificationRef.state });
      await manager.loadTicket("EZE-503");
      await manager.startWork();
      manager.recordChangedPaths(CODE_PATHS);
      verificationRef.state = freshPass();
      tool = createTicketTool(manager);

      runtime = createRuntimeHost();
      await runtime.emit("session_start", { reason: "startup" });

      // The observer reads the open ticket and then a fresh, valid Verify PASS.
      const shown = await tool.execute("call-1", { action: "show" }, undefined, undefined, { mode: "print" });
      await runtime.emit("tool_result", ticketResult(shown));
      await runtime.emit("tool_call", { toolName: "aies_delegate", input: { role: "verify" } });
      await runtime.emit("tool_result", {
        toolName: "aies_delegate",
        input: { role: "verify" },
        content: [{ type: "text", text: "### Verify Result" }],
        isError: false,
        details: { status: "pass", verification: toVerificationReport(verificationRef.state) },
      });
      await runtime.emit("agent_settled", {});
    });

    it("shows no DONE and touches no Linear while the user keeps the last step", async () => {
      manager.recordUserInput("no commit todavía");

      const held = await tool.execute("call-2", { action: "complete", ticketId: "EZE-503" }, undefined, undefined, {
        mode: "print",
      });
      await runtime.emit("tool_result", ticketResult(held));
      await runtime.emit("turn_end", { message: { role: "assistant" } });

      assert.equal(held.isError, true, "the Done Gate still refuses");
      assert.equal(
        transport.updatedIssues.some((entry) => entry.update.statusId === "status-done"),
        false,
        "no Linear completion write may be attempted",
      );
      assert.deepEqual(transport.addedComments, [], "no completion comment may be posted");
      assert.deepEqual(runtime.summaries(), [], "a held run appends no completion card");
      assert.equal(
        runtime.notifications.some((item) => /completad|tarea completada/iu.test(item.message)),
        false,
        `no completion headline may reach the user: ${JSON.stringify(runtime.notifications)}`,
      );

      const footer = runtime.footerText();
      assert.equal(footer.includes("DONE"), false, footer);
      assert.match(footer, /FINALIZING$/u, footer);
    });

    it("reaches DONE once the user confirms and Linear really moved", async () => {
      manager.recordUserInput("no commit todavía");
      const held = await tool.execute("call-2", { action: "complete", ticketId: "EZE-503" }, undefined, undefined, {
        mode: "print",
      });
      await runtime.emit("tool_result", ticketResult(held));
      await runtime.emit("turn_end", { message: { role: "assistant" } });
      assert.deepEqual(runtime.summaries(), []);

      manager.recordUserInput("ya lo revisé, podés commitear");
      const done = await tool.execute("call-3", { action: "complete", ticketId: "EZE-503" }, undefined, undefined, {
        mode: "print",
      });
      await runtime.emit("tool_result", ticketResult(done));

      assert.equal(done.isError, false, "the released completion succeeds");
      assert.ok(
        transport.updatedIssues.some((entry) => entry.update.statusId === "status-done"),
        "the permitted completion is the one that moves Linear",
      );

      const cards = runtime.summaries();
      assert.equal(cards.length, 1, "exactly one DONE card, on the real completion");
      assert.equal(cards[0].data.kind, "done");
      assert.equal(cards[0].data.linear, "Done", "the row reports the observed Linear status");
      assert.match(runtime.footerText(), /DONE$/u);
    });
  });
});
