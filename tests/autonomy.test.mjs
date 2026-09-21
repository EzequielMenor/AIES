/**
 * Test suite for AIES-009: Bounded Task Autonomy & Continuation Controller.
 *
 * Covers all 29 mandatory test specifications:
 *
 * 1. Sin ticket activo: handleSettled no dispara continuación ni emite follow-up; estado permanece idle.
 * 2. Autonomía desactivada: ticket activo con trabajo pendiente pero enabled = false -> no dispara continuación.
 * 3. Activación explícita: /aies-run <ticket> o API activa autonomía, inicia workflow y registra telemetría.
 * 4. Exactamente un follow-up por settle: handleSettled genera a lo sumo una llamada de instrucción oculta; nunca duplica.
 * 5. Explore -> continuación: Explorer finaliza handoff -> controller detecta siguiente paso natural y continúa.
 * 6. Worker -> Verify: Worker finaliza mutación -> controller detecta Verify mandatorio y continúa.
 * 7. FAIL -> repair: Verify retorna FAIL con budget disponible -> controller continúa hacia Worker repair.
 * 8. Repair -> fresh Verify: Worker completa reparación -> controller continúa hacia Verify fresco (no reutiliza verdict).
 * 9. PASS -> Linear complete: Verify PASS válido y sin mutaciones posteriores -> controller continúa hacia cierre en Linear.
 * 10. Ticket completed -> STOP limpio: Linear confirma Done -> controller detiene autonomía (stopReason = "completed").
 * 11. Ticket BLOCKED -> STOP seguro: Worker o Verify reporta BLOCKED -> controller detiene autonomía (stopReason = "blocked").
 * 12. Permisos ASK -> PAUSE: acción pide confirmación humana (ask) -> controller pausa sin continuar automáticamente.
 * 13. Permisos DENY -> STOP: operación denegada por boundary -> controller detiene autonomía (stopReason = "permission_denied").
 * 14. Linear conflict -> STOP: fetch remoto detecta ticket divergente -> controller detiene (stopReason = "linear_conflict").
 * 15. Linear failure post-PASS -> STOP: fallo al sincronizar cierre -> controller detiene sin reintentar código en bucle.
 * 16. Compaction ordering: compact pendiente corre y espera compaction ANTES de que el controller decida.
 * 17. Compaction asíncrona no se adelanta: mientras compaction está en vuelo, controller espera onComplete.
 * 18. Compaction ceiling / failure -> STOP: fallo de compaction en ceiling detiene autonomía (stopReason = "context_failure").
 * 19. Detección no-progress: 3 estados consecutivos con mismo fingerprint -> STOP (stopReason = "no_progress").
 * 20. Límite de continuaciones (circuit breaker): tras 20 continuaciones -> STOP (stopReason = "continuation_limit").
 * 21. Comando STOP manual: /aies-run stop detiene inmediatamente la autonomía sin matar la sesión.
 * 22. Resume safety: tras /resume el ticket persiste pero la autonomía queda pausada (enabled = false).
 * 23. Follow-up prompt mínimo: prompt inyectado es conciso (< 200 chars / ~50 tokens), no inyecta dumps masivos.
 * 24. No afecta routing (AIES-004): guardrails, roles y budgets intactos.
 * 25. No afecta verify (AIES-005): independencia de Verify, read-only y unicity de PASS preservados.
 * 26. No afecta permissions (AIES-006): sandbox isolation y confirmaciones preservadas.
 * 27. No afecta context governor (AIES-007): presupuestos y compactions mandatorias prioritarias sobre autonomía.
 * 28. No afecta linear gate (AIES-008): imposible cerrar ticket en Linear sin Verify PASS válido y fresco.
 * 29. Test suite existente pasa al 100%.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

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
  applyWorkUnitChange,
  applyWorkerResult,
  applyVerifyStart,
  applyVerifyResult,
} from "../extensions/aies-agents/verification.ts";
import {
  ContinuationController,
  setActiveContinuationController,
  getActiveContinuationController,
} from "../extensions/aies-agents/autonomy/controller.ts";
import {
  AIES_CONTINUATION_PROMPT,
  computeStateFingerprint,
  evaluateContinuation,
  MAX_AUTO_CONTINUATIONS,
  MAX_CONSECUTIVE_SAME_FINGERPRINT,
} from "../extensions/aies-agents/autonomy/policy.ts";
import { registerAutonomyCommand } from "../extensions/aies-agents/autonomy/command.ts";

function createMockPi() {
  const messages = [];
  const hidden = [];
  const commands = new Map();
  return {
    messages,
    hidden,
    commands,
    // Pi 0.86.1 public hidden custom-message path. Records both the raw call and a
    // normalized message so existing length/text assertions keep working.
    sendMessage(message, options) {
      hidden.push({ message, options });
      messages.push({ text: message?.content, options, display: message?.display });
    },
    sendUserMessage(text, options) {
      messages.push({ text, options });
    },
    registerCommand(name, def) {
      commands.set(name, def);
    },
  };
}

function sampleIssue(overrides = {}) {
  return {
    id: "issue-eze-101",
    identifier: "EZE-101",
    title: "Implement timeout retry in client",
    description: "Timeout should retry up to 3 times.\n\nCriteria:\n- Retry count is 3",
    status: "Todo",
    statusType: "unstarted",
    priority: 1,
    url: "https://linear.app/issue/EZE-101",
    updatedAt: "2026-09-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("AIES-009 Bounded Task Autonomy & Continuation Controller", () => {
  let pi;
  let transport;
  let ticketManager;
  let governor;
  let controller;
  let verification;
  let routing;

  beforeEach(async () => {
    pi = createMockPi();
    transport = new FakeLinearTransport([sampleIssue()]);
    ticketManager = new TicketManager({
      transport,
      getVerification: () => verification,
    });
    governor = new ContextGovernor({
      compactAtTokens: 100_000,
      ceilingTokens: 120_000,
    });
    verification = createVerificationState();
    routing = createRoutingState();

    controller = new ContinuationController({
      pi,
      getRouting: () => routing,
      getVerification: () => verification,
      getGovernor: () => governor,
      getTicketManager: () => ticketManager,
    });
    setActiveContinuationController(controller);
  });

  // --------------------------------------------------------------------------
  // Category 1: Base Invariants & Activation
  // --------------------------------------------------------------------------
  describe("Category 1: Base Invariants & Activation", () => {
    it("Caso 1 — Sin ticket activo: handleSettled no dispara continuación ni emite follow-up", async () => {
      controller.activate("EZE-NONE"); // Ticket doesn't exist yet
      ticketManager.reset();

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "blocked");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 2 — Autonomía desactivada: ticket activo con trabajo pendiente pero enabled = false", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      // Notice: controller.activate() is NOT called, so enabled is false

      assert.equal(controller.isEnabled(), false);
      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "wait");
      assert.equal(pi.messages.length, 0);
      assert.equal(controller.isPending(), false);
    });

    it("Caso 3 — Activación explícita: activa autonomía, inicia workflow y registra telemetría", async () => {
      registerAutonomyCommand(pi, controller, ticketManager);
      const runCommand = pi.commands.get("aies-run");
      assert.ok(runCommand, "aies-run command must be registered");

      const uiNotifications = [];
      const fakeCtx = {
        ui: {
          notify: (msg, type) => uiNotifications.push({ msg, type }),
        },
      };

      await runCommand.handler("EZE-101", fakeCtx);

      assert.equal(controller.isEnabled(), true);
      assert.equal(controller.getState().ticketId, "EZE-101");
      assert.equal(controller.getTelemetry().activations, 1);
      assert.equal(
        uiNotifications.some((n) => n.msg.includes("Autonomía activada")),
        false,
        "activation is carried by the AUTO badge, not a duplicated notification",
      );
    });

    it("Caso 4 — Exactamente un follow-up por settle: deduplica si no ha corrido nuevo turno", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // First settle: fires follow-up
      const d1 = await controller.handleSettled();
      assert.equal(d1.decision, "continue");
      assert.equal(pi.messages.length, 1);
      assert.equal(controller.isPending(), true);

      // Duplicate settle before any turn runs: ignored!
      const d2 = await controller.handleSettled();
      assert.equal(d2.decision, "wait");
      assert.match(d2.reason, /already in flight/i);
      assert.equal(pi.messages.length, 1, "Must never duplicate follow-up");

      // Now notify that the continuation turn ran:
      controller.notifyTurnStart();
      controller.notifyTurnEnd();

      // Subsequent settle can now continue
      const d3 = await controller.handleSettled();
      assert.equal(d3.decision, "continue");
      assert.equal(pi.messages.length, 2);
    });
  });

  // --------------------------------------------------------------------------
  // Category 2: Linear Ticket Workflow State Progression
  // --------------------------------------------------------------------------
  describe("Category 2: Linear Ticket Workflow State Progression", () => {
    it("Caso 5 — Explore -> continuación hacia Worker", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Simulate Explore handoff completed
      routing = applyRoutingDelegationStart(routing, "explore", Date.now());
      routing = applyRoutingDelegationEnd(routing, "explore", "done", Date.now());

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      assert.equal(pi.messages.length, 1);
      assert.match(pi.messages[0].text, /AIES ticket workflow/);
    });

    it("Caso 6 — Worker -> Verify: mutación requiere verificación mandatoria", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Simulate Worker mutation
      routing = applyRoutingDelegationStart(routing, "worker", Date.now());
      routing = applyRoutingDelegationEnd(routing, "worker", "done", Date.now());
      verification = applyWorkerResult(verification, ["src/client.js"]);
      ticketManager.recordChangedPaths(["src/client.js"]);

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      assert.match(decision.reason, /awaiting verification/i);
      assert.equal(pi.messages.length, 1);
    });

    it("Caso 7 — FAIL -> repair: Verify retorna FAIL con budget disponible", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Simulate Worker mutation + Verify FAIL
      verification = applyWorkerResult(verification, ["src/client.js"]);
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(
        verification,
        {
          status: "fail",
          summary: "retry count was 2, expected 3",
          defects: [{ description: "retry count was 2, expected 3", severity: "blocking" }],
          criteria: [],
        },
        Date.now(),
      );

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      assert.match(decision.reason, /repair permitted/i);
      assert.equal(pi.messages.length, 1);
    });

    it("Caso 8 — Repair -> fresh Verify: Worker completa reparación y requiere Verify fresco", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Initial FAIL
      verification = applyWorkerResult(verification, ["src/client.js"]);
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(
        verification,
        {
          status: "fail",
          summary: "bug in retry logic",
          defects: [{ description: "bug in retry logic", severity: "blocking" }],
          criteria: [],
        },
        Date.now(),
      );

      // Worker repairs
      routing = applyRoutingDelegationStart(routing, "worker", Date.now());
      routing = applyRoutingDelegationEnd(routing, "worker", "done", Date.now());
      verification = applyWorkerResult(verification, ["src/client.js"]);

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      assert.match(decision.reason, /awaiting verification/i);
    });

    it("Caso 9 — PASS -> Linear complete: Verify PASS válido continúa a cierre", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Worker + Verify PASS
      verification = applyWorkUnitChange(verification, ["src/client.js"], "initial");
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(verification, { status: "pass", criteria: [] }, Date.now());

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      assert.match(decision.reason, /verified PASS; ready for Linear completion/i);
    });

    it("Caso 10 — Ticket completed -> STOP limpio", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Verify PASS
      verification = applyWorkUnitChange(verification, ["src/client.js"], "initial");
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(verification, { status: "pass", criteria: [] }, Date.now());

      // Parent completes Linear ticket
      const completeRes = await ticketManager.completeTicket({
        evidence: "Verified and completed successfully",
      });
      assert.equal(completeRes.ok, true);

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "complete");
      assert.equal(decision.stopReason, "completed");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0, "No follow-up after ticket completed");
    });

    it("Caso 11 — Ticket BLOCKED -> STOP seguro y cede control al humano", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Verify returns BLOCKED
      verification = applyWorkUnitChange(verification, ["src/client.js"], "initial");
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(verification, { status: "blocked", criteria: [] }, Date.now());

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "blocked");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 11b — Protocol error -> STOP distinto sin reparación ni follow-up", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      verification = applyWorkUnitChange(verification, ["src/client.js"], "initial");
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(
        verification,
        { kind: "protocol_error", code: "missing_completion", message: "the verify child produced no completion" },
        Date.now(),
      );
      assert.equal(verification.status, "protocol_error");
      assert.equal(verification.repairs, 0);

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "verification_protocol_error");
      assert.equal(decision.followUpPrompt, undefined, "a protocol error must never auto-continue");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0, "no follow-up prompt on a protocol error");
    });
  });

  // --------------------------------------------------------------------------
  // Category 3: Safety, Permissions & Conflicts
  // --------------------------------------------------------------------------
  describe("Category 3: Safety, Permissions & Conflicts", () => {
    it("Caso 12 — Permisos ASK -> PAUSE (espera intervención humana)", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      controller.setPendingPermissionAsk(true);

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "user_required");
      assert.equal(decision.stopReason, "user_required");
      assert.equal(controller.isEnabled(), false);
      assert.equal(controller.getTelemetry().userRequiredPauses, 1);
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 13 — Permisos DENY -> STOP seguro", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      controller.setPermissionDenied(true);

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "permission_denied");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 14 — Linear conflict -> STOP", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      controller.setLinearError("remote_conflict");

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "linear_conflict");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 15 — Linear failure post-PASS -> STOP sin bucle de código", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Verify PASS already achieved
      verification = applyWorkUnitChange(verification, ["src/client.js"], "initial");
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(verification, { status: "pass", criteria: [] }, Date.now());

      // Network sync failed during complete
      controller.setLinearError("network_failure");

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "linear_sync_failed");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // Category 4: Context Governor Coordination
  // --------------------------------------------------------------------------
  describe("Category 4: Context Governor Coordination", () => {
    it("Caso 16 — Compaction ordering: compact pendiente espera a finalizar", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      governor.updateUsage({ tokens: 90_000, contextWindow: 128_000 });
      assert.equal(governor.isCompactPending(), true);

      // In evaluateContinuation, pending compaction forces "wait"
      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "wait");
      assert.match(decision.reason, /compaction in progress or pending/i);
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 17 — Compaction asíncrona no se adelanta antes de onComplete", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Mock compaction in flight
      let compactionFinished = false;
      const fakeCtx = {
        compact: (options) => {
          setTimeout(() => {
            compactionFinished = true;
            options.onComplete?.({ ok: true });
          }, 50);
        },
      };

      governor.updateUsage({ tokens: 90_000, contextWindow: 128_000 });
      // In extensions/aies-agents/index.ts, governor.handleSettled is awaited before controller.handleSettled
      await governor.handleSettled(fakeCtx);
      assert.equal(compactionFinished, true);

      // After compaction completes, governor is healthy and controller can continue
      governor.onCompactionSuccess();
      governor.updateUsage({ tokens: 40_000, contextWindow: 128_000 });

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      assert.equal(pi.messages.length, 1);
    });

    it("Caso 18 — Compaction ceiling / failure -> STOP para preservar contexto", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Push to ceiling
      governor.updateUsage({ tokens: 122_000, contextWindow: 128_000 });
      governor.onCompactionFailure("Compaction aborted: token count exceeded ceiling");

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "context_failure");
      assert.equal(controller.isEnabled(), false);
      assert.equal(pi.messages.length, 0);
    });
  });

  // --------------------------------------------------------------------------
  // Category 5: Loop Prevention & Circuit Breakers
  // --------------------------------------------------------------------------
  describe("Category 5: Loop Prevention & Circuit Breakers", () => {
    it("Caso 19 — Detección no-progress: 3 estados consecutivos idénticos -> STOP", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Step 1: settled
      const d1 = await controller.handleSettled();
      assert.equal(d1.decision, "continue");
      controller.notifyTurnStart();
      controller.notifyTurnEnd();

      // Step 2: same exact state
      const d2 = await controller.handleSettled();
      assert.equal(d2.decision, "continue");
      controller.notifyTurnStart();
      controller.notifyTurnEnd();

      // Step 3: same exact state -> stops on 3rd identical fingerprint
      const d3 = await controller.handleSettled();
      assert.equal(d3.decision, "blocked");
      assert.equal(d3.stopReason, "no_progress");
      assert.equal(controller.isEnabled(), false);
      assert.equal(controller.getTelemetry().noProgressStops, 1);
    });

    it("Caso 20 — Límite de continuaciones (circuit breaker a 20)", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Simulate reaching limit 20 with varied state (changing revision)
      for (let i = 1; i <= MAX_AUTO_CONTINUATIONS; i++) {
        verification = applyWorkUnitChange(verification, [`src/file_${i}.js`], `change ${i}`);
        const d = await controller.handleSettled();
        if (i < MAX_AUTO_CONTINUATIONS) {
          assert.equal(d.decision, "continue");
          controller.notifyTurnStart();
          controller.notifyTurnEnd();
        } else {
          // At 20 continuations
          controller.notifyTurnStart();
          controller.notifyTurnEnd();
        }
      }

      // 21st attempt hits circuit breaker
      verification = applyWorkUnitChange(verification, ["src/file_21.js"], "change 21");
      const dOver = await controller.handleSettled();
      assert.equal(dOver.decision, "blocked");
      assert.equal(dOver.stopReason, "continuation_limit");
      assert.equal(controller.isEnabled(), false);
      assert.equal(controller.getTelemetry().limitStops, 1);
    });

    it("Caso 21 — Comando STOP manual: /aies-run stop detiene autonomía inmediatamente", async () => {
      registerAutonomyCommand(pi, controller, ticketManager);
      const runCommand = pi.commands.get("aies-run");

      controller.activate("EZE-101");
      assert.equal(controller.isEnabled(), true);

      const uiNotifications = [];
      const fakeCtx = {
        ui: { notify: (msg, type) => uiNotifications.push({ msg, type }) },
      };

      await runCommand.handler("stop", fakeCtx);
      assert.equal(controller.isEnabled(), false);
      assert.equal(controller.getState().stopReason, "user_stopped");
      assert.ok(uiNotifications.some((n) => n.msg.includes("detenida")));

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "wait");
    });
  });

  // --------------------------------------------------------------------------
  // Category 6: Session & Prompt Bounds
  // --------------------------------------------------------------------------
  describe("Category 6: Session & Prompt Bounds", () => {
    it("Caso 22 — Resume safety: sesión restaurada NO reactiva autonomía automáticamente", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Trigger one continuation
      await controller.handleSettled();
      const snapshot = controller.toSnapshot();
      assert.ok(snapshot);
      assert.equal(snapshot.continuationCount, 1);

      // Create a fresh controller representing resumed session
      const resumedController = new ContinuationController({
        pi,
        getTicketManager: () => ticketManager,
        getVerification: () => verification,
        getRouting: () => routing,
        getGovernor: () => governor,
      });

      resumedController.restoreFromSnapshot(snapshot);

      // Preserves ticket and metrics, but enabled MUST BE FALSE
      assert.equal(resumedController.isEnabled(), false);
      assert.equal(resumedController.getState().ticketId, "EZE-101");
      assert.equal(resumedController.getState().continuationCount, 1);

      // When settled fires in restored session without user command: waits!
      const decision = await resumedController.handleSettled();
      assert.equal(decision.decision, "wait");
    });

    it("Caso 23 — Follow-up prompt mínimo (< 200 chars / ~50 tokens)", async () => {
      assert.ok(AIES_CONTINUATION_PROMPT.length < 200, "Continuation prompt must be concise");
      assert.match(AIES_CONTINUATION_PROMPT, /Continue the active AIES ticket workflow/);
      assert.match(AIES_CONTINUATION_PROMPT, /Do not redo completed work/);
    });
  });

  // --------------------------------------------------------------------------
  // Category 7: Non-Interference with Existing AIES Invariants
  // --------------------------------------------------------------------------
  describe("Category 7: Non-Interference with Existing AIES Invariants", () => {
    it("Caso 24 — No afecta routing (AIES-004): activeRole en vuelo pausa continuación", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Child delegation currently active
      routing = applyRoutingDelegationStart(routing, "worker", Date.now());

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "wait");
      assert.match(decision.reason, /Child delegation.*in flight/i);
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 25 — No afecta verify (AIES-005): unicity e invalidación de PASS preservadas", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Valid PASS
      verification = applyWorkUnitChange(verification, ["src/client.js"], "mutation");
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(verification, { status: "pass", criteria: [] }, Date.now());

      // Parent mutates code after PASS -> becomes STALE
      verification = applyWorkUnitChange(verification, ["src/client.js"], "subsequent mutation");

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      // Ready for Verify, NOT ready for completion!
      assert.match(decision.reason, /awaiting verification/i);
    });

    it("Caso 26 — No afecta permissions (AIES-006): sandbox no disponible para verify bloquea", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      verification = applyWorkUnitChange(verification, ["src/client.js"], "mutation");
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(verification, { status: "blocked", criteria: [] }, Date.now());

      controller.setSandboxAvailable(false);

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "blocked");
      assert.equal(decision.stopReason, "sandbox_unavailable");
    });

    it("Caso 27 — No afecta context governor (AIES-007): zona compact prioritaria", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      governor.updateUsage({ tokens: 90_000, contextWindow: 128_000 });
      assert.equal(governor.getZone(), "compact");

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "wait");
      assert.equal(pi.messages.length, 0);
    });

    it("Caso 28 — No afecta linear gate (AIES-008): imposible cerrar sin Verify PASS fresco", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      // Work unit exists without verify
      verification = applyWorkerResult(verification, ["src/client.js"]);
      ticketManager.recordChangedPaths(["src/client.js"]);

      const completeResult = await ticketManager.completeTicket({
        evidence: "Premature complete",
      });

      assert.equal(completeResult.ok, false);
      assert.equal(completeResult.error, "verify_gate_denied");

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");
      assert.match(decision.reason, /awaiting verification/i);
    });

    it("Caso 29 — Fingerprint computation preserves all state variables", () => {
      const fp1 = computeStateFingerprint({
        ticketId: "EZE-101",
        workState: "started",
        linearStatus: "In Progress",
        revision: 1,
        verifiedRevision: undefined,
        verificationStatus: "none",
        verificationAttempts: 0,
        verificationRepairs: 0,
        lastDelegationRole: "worker",
        lastDelegationOutcome: "done",
      });

      const fp2 = computeStateFingerprint({
        ticketId: "EZE-101",
        workState: "started",
        linearStatus: "In Progress",
        revision: 2, // Modified revision
        verifiedRevision: undefined,
        verificationStatus: "none",
        verificationAttempts: 0,
        verificationRepairs: 0,
        lastDelegationRole: "worker",
        lastDelegationOutcome: "done",
      });

      assert.notEqual(fp1, fp2);
    });
  });

  // --------------------------------------------------------------------------
  // Category 8: Transcript ownership (AIES-010D T10)
  // --------------------------------------------------------------------------
  describe("Category 8: Transcript ownership", () => {
    it("Caso 30 — handleSettled entrega la continuación como mensaje oculto, no como input visible", async () => {
      await ticketManager.loadTicket("EZE-101");
      await ticketManager.startWork();
      controller.activate("EZE-101");

      const decision = await controller.handleSettled();
      assert.equal(decision.decision, "continue");

      assert.equal(pi.hidden.length, 1, "la continuación debe usar el camino oculto de Pi");
      const { message, options } = pi.hidden[0];
      assert.equal(message.customType, "aies-instruction");
      assert.equal(message.display, false, "una instrucción interna nunca se dibuja como input del usuario");
      assert.equal(typeof message.content, "string");
      assert.ok(message.content.length > 0, "el modelo sigue recibiendo la instrucción");
      assert.equal(options.triggerTurn, true, "la continuación debe seguir disparando un turno real");
      assert.equal(options.deliverAs, "followUp");
    });

    it("Caso 31 — /aies-run entrega su instrucción interna por el camino oculto", async () => {
      registerAutonomyCommand(pi, controller, ticketManager);
      const runCommand = pi.commands.get("aies-run");
      assert.ok(runCommand);

      const fakeCtx = { ui: { notify: () => {} } };
      await runCommand.handler("EZE-101", fakeCtx);

      assert.equal(controller.isEnabled(), true);
      assert.equal(pi.hidden.length, 1);
      assert.equal(pi.hidden[0].message.display, false);
      assert.equal(pi.hidden[0].options.triggerTurn, true);
      assert.equal(pi.hidden[0].options.deliverAs, "followUp");
    });
  });
});
