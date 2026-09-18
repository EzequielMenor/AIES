/**
 * ContinuationController for AIES-009: Bounded Task Autonomy.
 *
 * The single authority in AIES deciding whether to continue automatically
 * after an agent run settles.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ContextGovernor } from "../context-governor.ts";
import type { TicketManager } from "../linear/manager.ts";
import type { RoutingState } from "../routing.ts";
import type { VerificationState } from "../verification.ts";
import {
  AIES_CONTINUATION_PROMPT,
  computeStateFingerprint,
  evaluateContinuation,
  MAX_AUTO_CONTINUATIONS,
  MAX_CONSECUTIVE_SAME_FINGERPRINT,
} from "./policy.ts";
import type {
  AutonomySnapshot,
  AutonomyState,
  AutonomyStopReason,
  AutonomyTelemetry,
  ContinuationDecision,
} from "./types.ts";

export interface ContinuationControllerOptions {
  pi?: Pick<ExtensionAPI, "sendUserMessage">;
  getRouting?: () => RoutingState;
  getVerification?: () => VerificationState;
  getGovernor?: () => ContextGovernor;
  getTicketManager?: () => TicketManager;
}

export class ContinuationController {
  private pi?: Pick<ExtensionAPI, "sendUserMessage">;
  private getRouting?: () => RoutingState;
  private getVerification?: () => VerificationState;
  private getGovernor?: () => ContextGovernor;
  private getTicketManager?: () => TicketManager;

  private state: AutonomyState = {
    enabled: false,
    ticketId: null,
    continuationCount: 0,
    lastDecision: null,
    stopReason: null,
    lastFingerprint: null,
    consecutiveSameFingerprint: 0,
    pending: false,
    stopRequested: false,
  };

  private telemetry: AutonomyTelemetry = {
    enabled: false,
    ticketId: null,
    continuationCount: 0,
    stopReason: null,
    activations: 0,
    noProgressStops: 0,
    limitStops: 0,
    userRequiredPauses: 0,
    totalAutonomousDurationMs: 0,
  };

  private startedAt: number = 0;
  private pendingPermissionAsk: boolean = false;
  private permissionDenied: boolean = false;
  private sandboxAvailable: boolean = true;
  private linearError?: string;
  private scopeChanged: boolean = false;
  private continuationTurnExecuted: boolean = false;

  constructor(options?: ContinuationControllerOptions) {
    this.pi = options?.pi;
    this.getRouting = options?.getRouting;
    this.getVerification = options?.getVerification;
    this.getGovernor = options?.getGovernor;
    this.getTicketManager = options?.getTicketManager;
  }

  setPi(pi: Pick<ExtensionAPI, "sendUserMessage">): void {
    this.pi = pi;
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  isPending(): boolean {
    return this.state.pending;
  }

  getState(): Readonly<AutonomyState> {
    return { ...this.state };
  }

  getTelemetry(): Readonly<AutonomyTelemetry> {
    return {
      ...this.telemetry,
      enabled: this.state.enabled,
      ticketId: this.state.ticketId,
      continuationCount: this.state.continuationCount,
      stopReason: this.state.stopReason,
      lastStepDescription: this.state.lastStepDescription,
    };
  }

  enable(ticketId: string): void {
    const trimmed = ticketId.trim();
    this.state.enabled = true;
    this.state.ticketId = trimmed;
    this.state.continuationCount = 0;
    this.state.lastDecision = null;
    this.state.stopReason = null;
    this.state.lastFingerprint = null;
    this.state.consecutiveSameFingerprint = 0;
    this.state.pending = false;
    this.state.stopRequested = false;
    this.state.lastStepDescription = "Autonomy enabled";

    this.pendingPermissionAsk = false;
    this.permissionDenied = false;
    this.scopeChanged = false;
    this.continuationTurnExecuted = false;

    this.startedAt = Date.now();
    this.telemetry.activations++;
    this.telemetry.enabled = true;
    this.telemetry.ticketId = trimmed;
    this.telemetry.stopReason = null;
  }

  activate(ticketId: string): void {
    this.enable(ticketId);
  }

  stop(reason: AutonomyStopReason = "user_stopped"): void {
    this.state.enabled = false;
    this.state.stopRequested = true;
    this.state.stopReason = reason;
    this.state.pending = false;
    this.state.lastDecision = "blocked";
    this.state.lastStepDescription = `Stopped: ${reason}`;

    if (this.startedAt > 0) {
      this.telemetry.totalAutonomousDurationMs += Math.max(0, Date.now() - this.startedAt);
      this.startedAt = 0;
    }
    this.telemetry.enabled = false;
    this.telemetry.stopReason = reason;
  }

  setPendingPermissionAsk(pending: boolean): void {
    this.pendingPermissionAsk = pending;
  }

  setPermissionDenied(denied: boolean): void {
    this.permissionDenied = denied;
  }

  setSandboxAvailable(available: boolean): void {
    this.sandboxAvailable = available;
  }

  setLinearError(error?: string): void {
    this.linearError = error;
  }

  setScopeChanged(changed: boolean): void {
    this.scopeChanged = changed;
  }

  notifyTurnStart(): void {
    if (this.state.pending) {
      this.continuationTurnExecuted = true;
    }
  }

  notifyTurnEnd(): void {
    if (this.state.pending) {
      this.continuationTurnExecuted = true;
    }
  }

  async handleSettled(
    _ctx?: ExtensionContext,
    overrides?: {
      ticketManager?: TicketManager;
      verification?: VerificationState;
      routing?: RoutingState;
      governor?: ContextGovernor;
    },
  ): Promise<ContinuationDecision> {
    if (!this.state.enabled) {
      return { decision: "wait", reason: "Autonomy is not enabled" };
    }

    // Single-flight deduplication:
    // If pending is true but no turn executed yet, this is a duplicate settled event
    if (this.state.pending && !this.continuationTurnExecuted) {
      return { decision: "wait", reason: "Continuation already in flight (duplicate settled event ignored)" };
    }

    // Clear pending state for the previous continuation now that its turn has completed
    if (this.state.pending && this.continuationTurnExecuted) {
      this.state.pending = false;
      this.continuationTurnExecuted = false;
    }

    const ticketManager = overrides?.ticketManager ?? this.getTicketManager?.();
    const verification = overrides?.verification ?? this.getVerification?.();
    const routing = overrides?.routing ?? this.getRouting?.();
    const governor = overrides?.governor ?? this.getGovernor?.();

    if (!ticketManager || !verification || !routing || !governor) {
      return { decision: "wait", reason: "Required AIES state managers are not initialized" };
    }

    const activeTicket = ticketManager.getActiveTicket();
    if (activeTicket) {
      const currentFingerprint = computeStateFingerprint({
        ticketId: activeTicket.identifier,
        workState: ticketManager.getWorkState(),
        linearStatus: activeTicket.status,
        revision: verification.revision,
        verifiedRevision: verification.verifiedRevision,
        verificationStatus: verification.status,
        verificationAttempts: verification.attempts,
        verificationRepairs: verification.repairs,
        lastDelegationRole: routing.lastDelegation?.role,
        lastDelegationOutcome: routing.lastDelegation?.outcome,
      });

      if (this.state.lastFingerprint && this.state.lastFingerprint === currentFingerprint) {
        this.state.consecutiveSameFingerprint++;
      } else {
        this.state.lastFingerprint = currentFingerprint;
        this.state.consecutiveSameFingerprint = 1;
      }
    }

    const decision = evaluateContinuation({
      autonomy: this.state,
      ticketManager,
      verification,
      routing,
      governor,
      hasPendingPermissionAsk: this.pendingPermissionAsk,
      isPermissionDenied: this.permissionDenied,
      isSandboxAvailable: this.sandboxAvailable,
      linearError: this.linearError,
      scopeChanged: this.scopeChanged,
    });

    this.state.lastDecision = decision.decision;
    this.state.lastStepDescription = decision.reason;

    if (decision.decision === "continue") {
      this.state.pending = true;
      this.state.continuationCount++;
      this.state.lastTriggeredAt = Date.now();
      this.continuationTurnExecuted = false;

      const prompt = decision.followUpPrompt ?? AIES_CONTINUATION_PROMPT;
      try {
        this.pi?.sendUserMessage(prompt, { deliverAs: "followUp" });
      } catch {
        // Safe degradation if pi sender fails
      }
      return decision;
    }

    if (decision.decision === "complete") {
      this.state.enabled = false;
      this.state.stopReason = "completed";
      this.state.pending = false;
      if (this.startedAt > 0) {
        this.telemetry.totalAutonomousDurationMs += Math.max(0, Date.now() - this.startedAt);
        this.startedAt = 0;
      }
      return decision;
    }

    if (decision.decision === "blocked") {
      this.state.enabled = false;
      this.state.stopReason = decision.stopReason ?? "blocked";
      this.state.pending = false;
      if (decision.stopReason === "no_progress") {
        this.telemetry.noProgressStops++;
      } else if (decision.stopReason === "continuation_limit") {
        this.telemetry.limitStops++;
      }
      if (this.startedAt > 0) {
        this.telemetry.totalAutonomousDurationMs += Math.max(0, Date.now() - this.startedAt);
        this.startedAt = 0;
      }
      return decision;
    }

    if (decision.decision === "user_required") {
      this.state.enabled = false; // Paused until user intervenes
      this.state.stopReason = "user_required";
      this.state.pending = false;
      this.telemetry.userRequiredPauses++;
      return decision;
    }

    // decision === "wait"
    return decision;
  }

  toSnapshot(): AutonomySnapshot | null {
    if (!this.state.ticketId && !this.state.enabled && this.state.continuationCount === 0) {
      return null;
    }
    return {
      enabled: this.state.enabled,
      ticketId: this.state.ticketId,
      continuationCount: this.state.continuationCount,
      lastDecision: this.state.lastDecision,
      stopReason: this.state.stopReason,
      lastStepDescription: this.state.lastStepDescription,
      persistedAt: Date.now(),
    };
  }

  restoreFromSnapshot(snapshot: AutonomySnapshot): void {
    if (!snapshot) return;
    // CRITICAL: Session resume restores ticket and counts, but autonomy is PAUSED/OFF!
    this.state.enabled = false;
    this.state.ticketId = snapshot.ticketId;
    this.state.continuationCount = snapshot.continuationCount;
    this.state.lastDecision = snapshot.lastDecision;
    this.state.stopReason = snapshot.stopReason;
    this.state.lastStepDescription = snapshot.lastStepDescription;
    this.state.pending = false;
    this.state.stopRequested = false;
    this.continuationTurnExecuted = false;
  }

  reset(): void {
    this.state = {
      enabled: false,
      ticketId: null,
      continuationCount: 0,
      lastDecision: null,
      stopReason: null,
      lastFingerprint: null,
      consecutiveSameFingerprint: 0,
      pending: false,
      stopRequested: false,
    };
    this.pendingPermissionAsk = false;
    this.permissionDenied = false;
    this.scopeChanged = false;
    this.linearError = undefined;
    this.continuationTurnExecuted = false;
    this.startedAt = 0;
  }
}

let activeController: ContinuationController | undefined;

export function getActiveContinuationController(): ContinuationController | undefined {
  return activeController;
}

export function setActiveContinuationController(controller: ContinuationController): void {
  activeController = controller;
}
