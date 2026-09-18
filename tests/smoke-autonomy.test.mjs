/**
 * Deterministic Smoke Tests for AIES-009: Bounded Task Autonomy & Continuation Controller.
 *
 * Scenarios:
 * 1. Happy Path E2E:
 *    Ticket EZE-TEST load -> start -> Explore -> Worker -> Verify FAIL -> Worker repair ->
 *    Verify PASS -> Linear refresh -> Done complete -> Clean STOP (0 continuations after complete).
 * 2. Blocker Smoke:
 *    Critical boundary or permission ASK triggers safe PAUSE / STOP with 0 further continuations.
 * 3. Compaction Race Smoke:
 *    Compaction pending at settled boundary is awaited to onComplete before any continuation follow-up.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ContextGovernor } from "../extensions/aies-agents/context-governor.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { FakeLinearTransport } from "../extensions/aies-agents/linear/transport.ts";
import {
  createRoutingState,
  applyRoutingDelegationStart,
  applyRoutingDelegationEnd,
} from "../extensions/aies-agents/routing.ts";
import {
  createVerificationState,
  applyWorkerResult,
  applyVerifyStart,
  applyVerifyResult,
} from "../extensions/aies-agents/verification.ts";
import { ContinuationController } from "../extensions/aies-agents/autonomy/controller.ts";
import { registerAutonomyCommand } from "../extensions/aies-agents/autonomy/command.ts";

function createMockPi() {
  const messages = [];
  const commands = new Map();
  return {
    messages,
    commands,
    sendUserMessage(text, options) {
      messages.push({ text, options });
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
  };
}

describe("AIES-009 Real Smoke: Deterministic Autonomy Workflows", () => {
  it("Scenario 1: Happy path E2E: Explore -> Worker -> FAIL -> repair -> PASS -> Done -> STOP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-smoke-autonomy-"));

    try {
      const targetFile = join(dir, "config.js");
      writeFileSync(targetFile, "export const TIMEOUT_MS = 1000;\n");

      const pi = createMockPi();
      const transport = new FakeLinearTransport([
        {
          id: "issue-eze-test",
          identifier: "EZE-TEST",
          title: "Update timeout configuration",
          description: "Update timeout to 2000ms.\n\nCriteria:\n- TIMEOUT_MS is 2000",
          state: { id: "state-todo", name: "Todo", type: "unstarted" },
          project: { id: "proj-1", name: "AIES" },
          updatedAt: new Date().toISOString(),
        },
      ]);

      let verification = createVerificationState();
      const ticketManager = new TicketManager({
        transport,
        getVerification: () => verification,
      });

      let routing = createRoutingState();
      const governor = new ContextGovernor({
        compactAtTokens: 80_000,
        ceilingTokens: 100_000,
      });

      const controller = new ContinuationController({
        pi,
        getRouting: () => routing,
        getVerification: () => verification,
        getGovernor: () => governor,
        getTicketManager: () => ticketManager,
      });

      registerAutonomyCommand(pi, controller, ticketManager);
      const runCommand = pi.commands.get("aies-run");

      // Step 1: User runs `/aies-run EZE-TEST`
      const fakeCtx = {
        ui: { notify: () => {} },
      };
      await runCommand.handler("EZE-TEST", fakeCtx);

      assert.equal(controller.isEnabled(), true);
      assert.equal(ticketManager.getWorkState(), "working");
      assert.equal(pi.messages.length, 1); // Initial follow-up dispatched by /aies-run

      // Turn 1 executes: Parent decides to delegate to Explore
      controller.notifyTurnStart();
      routing = applyRoutingDelegationStart(routing, "explore", Date.now());
      routing = applyRoutingDelegationEnd(routing, "explore", "done", Date.now());
      controller.notifyTurnEnd();

      // Settle 1: Explorer finished; controller continues workflow towards Worker
      const d1 = await controller.handleSettled();
      assert.equal(d1.decision, "continue");
      assert.equal(pi.messages.length, 2);

      // Turn 2 executes: Worker performs initial code mutation (with defect)
      controller.notifyTurnStart();
      routing = applyRoutingDelegationStart(routing, "worker", Date.now());
      writeFileSync(targetFile, "export const TIMEOUT_MS = 1500;\n"); // Defective value
      routing = applyRoutingDelegationEnd(routing, "worker", "done", Date.now());
      verification = applyWorkerResult(verification, ["config.js"]);
      ticketManager.recordChangedPaths(["config.js"]);
      controller.notifyTurnEnd();

      // Settle 2: Controller detects work unit awaiting verification -> continues towards Verify
      const d2 = await controller.handleSettled();
      assert.equal(d2.decision, "continue");
      assert.match(d2.reason, /awaiting verification/i);
      assert.equal(pi.messages.length, 3);

      // Turn 3 executes: Verify runs and reports FAIL
      controller.notifyTurnStart();
      routing = applyRoutingDelegationStart(routing, "verify", Date.now());
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(
        verification,
        {
          status: "fail",
          summary: "TIMEOUT_MS was 1500, expected 2000",
          defects: [{ description: "TIMEOUT_MS was 1500, expected 2000", severity: "blocking", file: "config.js" }],
          criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "fail" }],
        },
        Date.now(),
      );
      routing = applyRoutingDelegationEnd(routing, "verify", "done", Date.now());
      controller.notifyTurnEnd();

      // Settle 3: Controller detects FAIL with repair budget available -> continues towards Worker repair
      const d3 = await controller.handleSettled();
      assert.equal(d3.decision, "continue");
      assert.match(d3.reason, /repair permitted/i);
      assert.equal(pi.messages.length, 4);

      // Turn 4 executes: Worker repairs the defect
      controller.notifyTurnStart();
      routing = applyRoutingDelegationStart(routing, "worker", Date.now());
      writeFileSync(targetFile, "export const TIMEOUT_MS = 2000;\n"); // Corrected value
      routing = applyRoutingDelegationEnd(routing, "worker", "done", Date.now());
      verification = applyWorkerResult(verification, ["config.js"]);
      ticketManager.recordChangedPaths(["config.js"]);
      controller.notifyTurnEnd();

      // Settle 4: Controller detects repaired work unit -> continues towards fresh Verify
      const d4 = await controller.handleSettled();
      assert.equal(d4.decision, "continue");
      assert.match(d4.reason, /awaiting verification/i);
      assert.equal(pi.messages.length, 5);

      // Turn 5 executes: Verify runs and reports PASS
      controller.notifyTurnStart();
      routing = applyRoutingDelegationStart(routing, "verify", Date.now());
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(
        verification,
        {
          status: "pass",
          summary: "All criteria verified",
          criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }],
          defects: [],
        },
        Date.now(),
      );
      routing = applyRoutingDelegationEnd(routing, "verify", "done", Date.now());
      controller.notifyTurnEnd();

      // Settle 5: Controller evaluates valid PASS -> continues towards Linear completion
      const d5 = await controller.handleSettled();
      assert.equal(d5.decision, "continue");
      assert.match(d5.reason, /verified PASS; ready for Linear completion/i);
      assert.equal(pi.messages.length, 6);

      // Turn 6 executes: Parent closes ticket in Linear through Done Gate
      controller.notifyTurnStart();
      const completeRes = await ticketManager.completeTicket({
        evidence: "Verified PASS at revision 2",
        comment: "Implementation verified and complete",
      });
      assert.equal(completeRes.ok, true);
      assert.equal(ticketManager.getWorkState(), "complete");
      controller.notifyTurnEnd();

      // Settle 6: Controller detects ticket complete -> STOP limpio!
      const d6 = await controller.handleSettled();
      assert.equal(d6.decision, "complete");
      assert.equal(d6.stopReason, "completed");
      assert.equal(controller.isEnabled(), false);
      assert.equal(controller.getState().stopReason, "completed");
      // CRITICAL: Exactly 0 new follow-ups after complete
      assert.equal(pi.messages.length, 6);

      // Duplicate settle after completion: remains complete, no follow-up
      const d7 = await controller.handleSettled();
      assert.equal(d7.decision, "wait");
      assert.equal(pi.messages.length, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Scenario 2: Blocker smoke: Permission ASK pauses autonomy safely with 0 continuations", async () => {
    const pi = createMockPi();
    const transport = new FakeLinearTransport([
      {
        id: "issue-eze-block",
        identifier: "EZE-BLOCK",
        title: "Blocker test",
        description: "Task requiring restricted boundary operation",
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        project: { id: "proj-1", name: "AIES" },
        updatedAt: new Date().toISOString(),
      },
    ]);

    let verification = createVerificationState();
    const ticketManager = new TicketManager({
      transport,
      getVerification: () => verification,
    });
    await ticketManager.loadTicket("EZE-BLOCK");
    await ticketManager.startWork();

    const routing = createRoutingState();
    const governor = new ContextGovernor();
    const controller = new ContinuationController({
      pi,
      getRouting: () => routing,
      getVerification: () => verification,
      getGovernor: () => governor,
      getTicketManager: () => ticketManager,
    });

    controller.enable("EZE-BLOCK");
    assert.equal(controller.isEnabled(), true);

    // Turn runs: worker requests an out-of-boundary tool requiring user authorization
    controller.notifyTurnStart();
    controller.setPendingPermissionAsk(true);
    controller.notifyTurnEnd();

    // Settle occurs: controller detects pending human authorization -> PAUSES safely
    const decision = await controller.handleSettled();
    assert.equal(decision.decision, "user_required");
    assert.equal(decision.stopReason, "user_required");
    assert.equal(controller.isEnabled(), false);
    assert.equal(controller.isPending(), false);
    assert.equal(controller.getTelemetry().userRequiredPauses, 1);
    assert.equal(pi.messages.length, 0, "Must never emit follow-up when user interaction is required");
  });

  it("Scenario 3: Compaction race smoke: compaction awaits onComplete before continuation follow-up", async () => {
    const pi = createMockPi();
    const transport = new FakeLinearTransport([
      {
        id: "issue-eze-cmp",
        identifier: "EZE-CMP",
        title: "Compaction race test",
        description: "Testing strict ordering between compaction and continuation",
        state: { id: "state-todo", name: "Todo", type: "unstarted" },
        project: { id: "proj-1", name: "AIES" },
        updatedAt: new Date().toISOString(),
      },
    ]);

    let verification = createVerificationState();
    const ticketManager = new TicketManager({
      transport,
      getVerification: () => verification,
    });
    await ticketManager.loadTicket("EZE-CMP");
    await ticketManager.startWork();

    const routing = createRoutingState();
    const governor = new ContextGovernor({
      compactAtTokens: 80_000,
      ceilingTokens: 100_000,
    });

    const controller = new ContinuationController({
      pi,
      getRouting: () => routing,
      getVerification: () => verification,
      getGovernor: () => governor,
      getTicketManager: () => ticketManager,
    });

    controller.enable("EZE-CMP");

    // Turn pushes tokens into compact zone (90k out of 128k window)
    controller.notifyTurnStart();
    governor.updateUsage({ tokens: 90_000, contextWindow: 128_000 });
    assert.equal(governor.getZone(), "compact");
    assert.equal(governor.isCompactPending(), true);
    controller.notifyTurnEnd();

    // Emulate Pi async compaction hook:
    let compactionPhase = "pending";
    const fakeCtx = {
      compact: (options) => {
        compactionPhase = "in_flight";
        setTimeout(() => {
          compactionPhase = "completed";
          options.onComplete?.({ ok: true });
        }, 30);
      },
    };

    // If controller evaluated right now while compaction is pending, it MUST wait
    const preCompactionDecision = await controller.handleSettled();
    assert.equal(preCompactionDecision.decision, "wait");
    assert.match(preCompactionDecision.reason, /compaction in progress or pending/i);
    assert.equal(pi.messages.length, 0);

    // In aies-agents/index.ts, governor.handleSettled is strictly awaited first:
    await governor.handleSettled(fakeCtx);
    assert.equal(compactionPhase, "completed");

    // Compaction succeeded; token pressure relieved
    governor.onCompactionSuccess();
    governor.updateUsage({ tokens: 35_000, contextWindow: 128_000 });
    assert.equal(governor.getZone(), "green");
    assert.equal(governor.isCompactPending(), false);

    // Now controller evaluates after onComplete: successfully continues with exactly one follow-up
    const postCompactionDecision = await controller.handleSettled();
    assert.equal(postCompactionDecision.decision, "continue");
    assert.equal(pi.messages.length, 1);
  });
});
