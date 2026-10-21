/**
 * Standing prohibitions do not hold the last step, and a hold the user never asked for can be cancelled.
 *
 * The defects this file pins:
 * 1. A bare prohibition ("no hagas commits ni pushes en los repositorios reales") is a standing rule. It
 *    defers nothing and waits for no later authorisation, so it must not create a `pending_final_action`
 *    hold. A deferral ("no commit todavía", "hasta que revise") still holds.
 * 2. The user alone can drop a hold that should not exist, with `/aies-ticket cancel-pending`. Cancelling
 *    clears only the hold: verification, changed paths, the ticket, the work state and the Done Gate keep
 *    their meaning, nothing is sent to the tracker, and nothing is approved. The model has no way to call it.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import aiesAgents, { getActiveTicketManager, resetSessionState } from "../extensions/aies-agents/index.ts";
import { setActiveContinuationController } from "../extensions/aies-agents/autonomy/controller.ts";
import { registerTicketCommand } from "../extensions/aies-agents/linear/command.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { readFinalActionDirective } from "../extensions/aies-agents/linear/pending-action.ts";
import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import { FakeLinearTransport } from "../extensions/aies-agents/linear/transport.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
} from "../extensions/aies-agents/verification.ts";
import { useTrustedProfileEnv } from "./helpers/mcp-profile.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const CODE_PATHS = ["extensions/aies-agents/linear/manager.ts"];
const TICKET = "EZE-600";

/** Standing prohibitions: negated, with no deferral marker. Nothing waits for a later authorisation. */
const PROHIBITIONS = [
  "No hagas commits ni pushes en los repositorios reales",
  "no hagas commits",
  "no commits",
  "nunca hagas push",
  "do not commit or push",
  "don't commit or push to the real repos",
  "no pushes",
  "never push",
  "sin commits ni pushes en los repos reales",
  "sin commitear",
  // A negated "commit and push" must not read as the release phrase "commit and push".
  "No hagas commits y pushes en los repositorios reales",
  "no hagas commit y push",
  "don't commit and push",
  "never commit and push to the real repos",
];

/** Deferrals: the same negated step with a marker that keeps it for later. Each one must still hold. */
const DEFERRALS = [
  "no commit todavía",
  "no hagas commit todavía",
  "no hagas commit hasta que revise",
  "don't commit yet",
  "commit todavía no",
  "no commitear por ahora",
  "no hagas push de momento",
  "no pushes until I review",
  "not yet, don't commit",
  "no hagas commits, lo dejo",
  "no hagas commit antes de que lo revise",
  "sin commitear todavía",
  "no hagas commit sin mi aprobación",
  "don't commit before I review",
  "no commit por el momento",
  "no commitees mientras tanto",
  "no commit hasta nuevo aviso",
  "no commit hasta mañana",
  "not now, don't commit",
  "for the time being, don't commit",
];

function sampleIssue() {
  return {
    id: "issue-eze-600",
    identifier: TICKET,
    title: "Standing prohibitions are not holds",
    description: "The user forbade commits and pushes on the real repositories.",
    status: "Todo",
    statusType: "unstarted",
    url: "https://linear.app/issue/EZE-600",
  };
}

/** A verification record with a fresh, valid PASS over a behaviour-bearing change. */
function freshPass(revision = 1) {
  let state = createVerificationState();
  state = applyWorkUnitChange(state, CODE_PATHS, "worker implemented the fix");
  state = { ...state, revision };
  state = applyVerifyStart(state, 1_700_000_000_000);
  return applyVerifyResult(state, { status: "pass", criteria: [] }, 1_700_000_000_100);
}

/** A snapshot without its wall-clock stamp, so two snapshots can be compared exactly. */
function withoutStamp(snapshot) {
  const { persistedAt: _stamp, ...rest } = snapshot;
  return rest;
}

/** A started ticket with its changes recorded and a verification record the test controls. */
async function loadedManager(verification = () => freshPass()) {
  const transport = new FakeLinearTransport([sampleIssue()]);
  const verificationRef = { state: createVerificationState() };
  const manager = new TicketManager({ transport, getVerification: () => verificationRef.state });
  await manager.loadTicket(TICKET);
  await manager.startWork();
  manager.recordChangedPaths(CODE_PATHS);
  verificationRef.state = verification();
  return { manager, transport, verificationRef };
}

/** A manager restored from a stored snapshot, as a resumed session does it. */
function resumedManager(snapshot, transport, verificationRef) {
  const resumed = new TicketManager({ transport, getVerification: () => verificationRef.state });
  resumed.restoreFromSnapshot(snapshot);
  return resumed;
}

/**
 * The Parent-side slash command, wired to a real manager. `pi` records what the command registers and
 * what it persists; `run` returns the notifications one invocation raised.
 */
function createCommandHost(manager) {
  const commands = new Map();
  const entries = [];
  const pi = {
    registerCommand: (name, definition) => commands.set(name, definition),
    appendEntry: (type, data) => entries.push({ type, data }),
  };
  registerTicketCommand(pi, manager);

  return {
    entries,
    async run(args) {
      const notifications = [];
      const ctx = {
        mode: "tui",
        hasUI: false,
        ui: { notify: (message, type) => notifications.push({ message, type }) },
      };
      await commands.get("aies-ticket").handler(args, ctx);
      return notifications;
    },
  };
}

/**
 * The real agents extension with its hooks, its commands and its appended entries captured. No Pi
 * runtime, no model, no tracker: the ticket is seeded in the extension's own manager.
 */
function createExtensionHost() {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    getAllTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    getActiveTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    sendUserMessage() {},
  };
  aiesAgents(pi);

  return {
    entries,
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
    async runCommand(args) {
      const notifications = [];
      const ctx = {
        mode: "tui",
        hasUI: false,
        ui: { notify: (message, type) => notifications.push({ message, type }) },
      };
      await commands.get("aies-ticket").handler(args, ctx);
      return notifications;
    },
  };
}

/** Load the ticket into the extension's own manager, as a resumed session would have it. */
function seedExtensionTicket(manager) {
  manager.restoreFromSnapshot({
    ticketId: TICKET,
    activeTicket: {
      id: "issue-eze-600",
      identifier: TICKET,
      title: "Standing prohibitions are not holds",
      description: "",
      acceptanceCriteria: ["a standing prohibition never holds the last step"],
      status: "In Progress",
      statusType: "started",
      loadedAt: 1_700_000_000_000,
    },
    workState: "working",
    lastKnownLinearStatus: "In Progress",
    changedPaths: CODE_PATHS,
    persistedAt: 1_700_000_000_000,
  });
}

describe("standing prohibitions and cancel-pending", () => {
  // The real hook reads the MCP profile from the environment: a trusted one for the whole file (D38).
  let restoreProfileEnv;
  beforeEach(() => {
    restoreProfileEnv = useTrustedProfileEnv();
  });
  afterEach(() => {
    resetSessionState();
    restoreProfileEnv();
  });

  describe("1. a bare prohibition is not a hold", () => {
    it("reads no finalization directive from standing prohibitions", () => {
      for (const text of PROHIBITIONS) {
        assert.equal(readFinalActionDirective(text), null, `${text} must not hold or release anything`);
      }
    });

    it("lets a Verify PASS complete the ticket when the user only prohibited commits and pushes", async () => {
      for (const text of PROHIBITIONS) {
        const { manager } = await loadedManager();
        manager.recordUserInput(text);

        assert.equal(manager.getPendingFinalAction(), null, `${text} must not create a hold`);
        const done = await manager.completeTicket({ evidence: "verified PASS" });
        assert.equal(done.ok, true, `${text}: completion must not be refused as pending`);
        assert.equal(manager.getWorkState(), "complete");
      }
    });

    it("neither clears a standing hold nor counts as a release", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("quiero revisarlo antes");
      manager.recordUserInput("No hagas commits ni pushes en los repositorios reales");

      assert.equal(manager.getPendingFinalAction()?.kind, "review", "the review hold stands");
      assert.equal((await manager.completeTicket()).error, "pending_final_action");
    });

    // "commit and push" is also a release phrase when it is affirmative. Negated, it must not lift a hold.
    for (const prohibition of ["No hagas commits y pushes", "don't commit and push"]) {
      for (const holdText of ["quiero revisarlo antes", "no commit todavía"]) {
        it(`keeps the hold "${holdText}" after the prohibition "${prohibition}"`, async () => {
          const { manager } = await loadedManager();
          const held = manager.recordUserInput(holdText);
          assert.ok(held, "a real hold exists before the prohibition");

          manager.recordUserInput(prohibition);

          assert.deepEqual(manager.getPendingFinalAction(), held, "the same hold stands, unchanged");
          assert.equal((await manager.completeTicket()).error, "pending_final_action");
          assert.notEqual(manager.getWorkState(), "complete");
        });
      }
    }
  });

  describe("2. a deferral still holds", () => {
    it("reads every deferral as a commit hold quoting the user's words", () => {
      for (const text of DEFERRALS) {
        const directive = readFinalActionDirective(text);
        assert.equal(directive?.kind, "hold", `${text} must hold finalization`);
        assert.equal(directive.pending.kind, "commit", `${text} holds the commit`);
        assert.equal(directive.pending.quote, text, `${text} is kept verbatim as evidence`);
      }
    });

    it("refuses completion with pending_final_action while a deferral stands", async () => {
      for (const text of DEFERRALS) {
        const { manager } = await loadedManager();
        manager.recordUserInput(text);

        const result = await manager.completeTicket({ evidence: "verified PASS" });
        assert.equal(result.ok, false, `${text} must keep the ticket open`);
        assert.equal(result.error, "pending_final_action");
        assert.match(result.message ?? "", /Done Gate HELD/u);
      }
    });
  });

  describe("3. affirmative requests still need the user's authorisation", () => {
    it("holds a review request and the refusal quotes it", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("quiero revisarlo antes");

      const result = await manager.completeTicket();
      assert.equal(result.error, "pending_final_action");
      assert.match(result.message ?? "", /quiero revisarlo antes/u);
    });

    it("lifts the hold on a release phrase and then completes", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      assert.equal((await manager.completeTicket()).ok, false);

      manager.recordUserInput("ya lo revisé, podés commitear");

      assert.equal(manager.getPendingFinalAction(), null);
      assert.equal((await manager.completeTicket()).ok, true);
    });

    it("lets a release that follows a hold in the same message win (last clause wins)", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("no commit todavía. ya lo revisé, podés commitear");

      assert.equal(manager.getPendingFinalAction(), null);
      assert.equal((await manager.completeTicket()).ok, true);
    });

    it("still lets force: true through as the user's confirmation", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("no commit todavía");

      const done = await manager.completeTicket({ force: true });
      assert.equal(done.ok, true);
      assert.equal(manager.getWorkState(), "complete");
    });
  });

  describe("4. cancelPendingFinalAction clears only the hold", () => {
    it("drops the hold and returns what it held, once", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("no commit todavía");

      const cancelled = manager.cancelPendingFinalAction();
      assert.equal(cancelled?.kind, "commit");
      assert.equal(cancelled?.quote, "no commit todavía");
      assert.equal(manager.getPendingFinalAction(), null);
      assert.equal(manager.cancelPendingFinalAction(), null, "a second cancel finds nothing");
    });

    it("touches nothing else: verification, changed paths, ticket, work state and remote stay", async () => {
      const { manager, transport, verificationRef } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      const verificationBefore = verificationRef.state;
      const snapshotBefore = withoutStamp(manager.toSnapshot());
      const remoteBefore = JSON.stringify(await transport.getIssue(TICKET));
      const writesBefore = [transport.updatedIssues.length, transport.addedComments.length];

      manager.cancelPendingFinalAction();

      assert.equal(verificationRef.state, verificationBefore, "the verification record is the same object");
      assert.deepEqual(manager.getChangedPaths(), CODE_PATHS);
      assert.equal(manager.getWorkState(), "working");
      assert.deepEqual(withoutStamp(manager.toSnapshot()), { ...snapshotBefore, pendingFinalAction: null });
      assert.equal(JSON.stringify(await transport.getIssue(TICKET)), remoteBefore, "the tracker is not touched");
      assert.deepEqual([transport.updatedIssues.length, transport.addedComments.length], writesBefore);
    });

    it("keeps the Done Gate refusing a change set without a PASS after the cancel", async () => {
      const { manager, verificationRef } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      manager.cancelPendingFinalAction();
      verificationRef.state = createVerificationState();

      const result = await manager.completeTicket();
      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_gate_denied");
      assert.match(result.message ?? "", /Done Gate DENIED/u);
      assert.equal(manager.getWorkState(), "working");
    });

    it("still allows the completion with a valid fresh PASS after the cancel", async () => {
      const { manager, verificationRef } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      manager.cancelPendingFinalAction();
      verificationRef.state = freshPass();

      const result = await manager.completeTicket({ evidence: "verified PASS" });
      assert.equal(result.ok, true);
      assert.equal(manager.getWorkState(), "complete");
    });

    it("is a no-op when nothing is pending", async () => {
      const { manager } = await loadedManager();
      const snapshotBefore = withoutStamp(manager.toSnapshot());

      assert.equal(manager.cancelPendingFinalAction(), null);
      assert.deepEqual(withoutStamp(manager.toSnapshot()), snapshotBefore);
    });

    it("is a no-op on a manager without any ticket", () => {
      const manager = new TicketManager({ getVerification: () => createVerificationState() });
      assert.equal(manager.cancelPendingFinalAction(), null);
      assert.equal(manager.getActiveTicket(), null);
    });

    it("cancels a hold restored from a stored snapshot", async () => {
      const { manager, transport, verificationRef } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      const snapshot = manager.toSnapshot();
      assert.equal(snapshot.pendingFinalAction?.kind, "commit");

      const resumed = resumedManager(snapshot, transport, verificationRef);
      const cancelled = resumed.cancelPendingFinalAction();

      assert.equal(cancelled?.quote, "no commit todavía");
      assert.equal(resumed.getPendingFinalAction(), null);
      assert.equal((await resumed.completeTicket()).ok, true);
    });
  });

  describe("5. the slash command is the user's only way to cancel", () => {
    it("notifies what was cancelled, quoting the held request, and persists the cleared snapshot", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      const host = createCommandHost(manager);

      const notifications = await host.run("cancel-pending");

      assert.equal(notifications.length, 1);
      assert.match(notifications[0].message, /no commit todavía/u);
      assert.equal(manager.getPendingFinalAction(), null);
      assert.equal(host.entries.length, 1, "the cleared snapshot is written once");
      assert.equal(host.entries[0].type, "aies-ticket");
      assert.equal(host.entries[0].data.pendingFinalAction, null);
      assert.equal(host.entries[0].data.ticketId, TICKET);
      assert.deepEqual(host.entries[0].data.changedPaths, CODE_PATHS);
      assert.equal(host.entries[0].data.workState, "working");
    });

    it("accepts the exact token with surrounding spaces", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("quiero revisarlo antes");
      const host = createCommandHost(manager);

      await host.run("  cancel-pending  ");

      assert.equal(manager.getPendingFinalAction(), null);
    });

    it("reports that nothing was pending and writes nothing", async () => {
      const { manager } = await loadedManager();
      const host = createCommandHost(manager);

      const notifications = await host.run("cancel-pending");

      assert.match(notifications[0].message, /No pending final action/u);
      assert.equal(host.entries.length, 0, "no snapshot is written when nothing changed");
    });

    it("does not call the tracker and does not approve the ticket", async () => {
      const { manager, transport } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      const writesBefore = [transport.updatedIssues.length, transport.addedComments.length];

      await createCommandHost(manager).run("cancel-pending");

      assert.deepEqual([transport.updatedIssues.length, transport.addedComments.length], writesBefore);
      assert.notEqual(manager.getWorkState(), "complete");
    });
  });

  describe("6. the model has no way to cancel", () => {
    it("is not an aies_ticket action or a schema field", async () => {
      const { manager } = await loadedManager();
      const tool = createTicketTool(manager);

      assert.doesNotMatch(JSON.stringify(tool.parameters), /cancel/iu);
    });

    it("does not clear the hold when the tool is asked to cancel it", async () => {
      const { manager } = await loadedManager();
      manager.recordUserInput("no commit todavía");
      const tool = createTicketTool(manager);

      await tool
        .execute("call-cancel", { action: "cancel-pending" }, undefined, undefined, { mode: "print" })
        .catch(() => {});

      assert.equal(manager.getPendingFinalAction()?.kind, "commit", "only the user's slash command cancels");
    });
  });

  describe("7. the real extension reads the command text as no directive", () => {
    it("keeps the hold through the typed command text and lets the slash command cancel it", async () => {
      resetSessionState();
      setActiveContinuationController(undefined);
      const host = createExtensionHost();
      seedExtensionTicket(getActiveTicketManager());

      await host.input("no commit todavía");
      await host.input("/aies-ticket cancel-pending");
      assert.equal(getActiveTicketManager().getPendingFinalAction()?.kind, "commit", "the text is no directive");

      const notifications = await host.runCommand("cancel-pending");
      assert.match(notifications[0].message, /no commit todavía/u);
      assert.equal(getActiveTicketManager().getPendingFinalAction(), null);
      assert.equal(host.entries.at(-1)?.type, "aies-ticket");
      assert.equal(host.entries.at(-1)?.data.pendingFinalAction, null);
    });

    it("does not read the command text or the token as a directive", () => {
      assert.equal(readFinalActionDirective("/aies-ticket cancel-pending"), null);
      assert.equal(readFinalActionDirective("cancel-pending"), null);
    });

    it("after the cancel the Done Gate still refuses a direct Linear Done without a PASS", async () => {
      resetSessionState();
      setActiveContinuationController(undefined);
      const host = createExtensionHost();
      seedExtensionTicket(getActiveTicketManager());

      await host.input("no commit todavía");
      await host.runCommand("cancel-pending");
      const blocked = await host.blockOf("mcp", {
        server: "linear",
        tool: "save_issue",
        args: { id: TICKET, state: "Done" },
      });

      assert.ok(blocked?.block, "the Done Gate still blocks the direct write");
      assert.doesNotMatch(blocked.reason, /HELD|no commit todavía/u, "the hold itself is gone");
      assert.match(blocked.reason, /Verification required/u);
    });
  });
});

describe("D46: /aies-ticket no-code is a user-only declaration", () => {
  it("records the exception, persists it and refuses an empty reason", async () => {
    const { manager } = await loadedManager();
    const host = createCommandHost(manager);

    const refused = await host.run("no-code");
    assert.equal(refused[0].type, "warning");
    assert.equal(manager.toSnapshot().noCodeException, undefined);
    assert.equal(host.entries.length, 0);

    const accepted = await host.run("no-code research ticket, nothing to build");
    assert.equal(accepted[0].type, "info");
    assert.equal(manager.toSnapshot().noCodeException.reason, "research ticket, nothing to build");
    assert.equal(host.entries.at(-1).data.noCodeException.reason, "research ticket, nothing to build");
  });

  it("is not an aies_ticket action the model can call", () => {
    const manager = new TicketManager({ transport: undefined, getVerification: () => createVerificationState() });
    const tool = createTicketTool(manager);
    assert.equal(JSON.stringify(tool.parameters).includes("no-code"), false);
  });
});
