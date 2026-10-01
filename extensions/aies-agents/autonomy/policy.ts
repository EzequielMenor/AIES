/**
 * Pure policy evaluation and fingerprint computation for AIES-009.
 */

import type { VerificationState } from "../verification.ts";
import { isVerificationValid, planVerification } from "../verification.ts";
import type { RoutingState } from "../routing.ts";
import type { ContextGovernor } from "../context-governor.ts";
import type { TicketManager } from "../linear/manager.ts";
import type {
  AutonomyState,
  AutonomyStopReason,
  ContinuationDecision,
} from "./types.ts";

export const MAX_AUTO_CONTINUATIONS = 20;
export const MAX_CONSECUTIVE_SAME_FINGERPRINT = 3;

export const AIES_CONTINUATION_PROMPT = `
Continue the active AIES ticket workflow from the current state.
Respect routing, verification, permissions, context and Linear gates.
Do not redo completed work.
`.trim();

export interface FingerprintParams {
  ticketId: string;
  workState: string;
  linearStatus: string;
  revision: number;
  verifiedRevision?: number;
  verificationStatus: string;
  verificationAttempts: number;
  verificationRepairs: number;
  lastDelegationRole?: string;
  lastDelegationOutcome?: string;
}

export function computeStateFingerprint(params: FingerprintParams): string {
  return [
    params.ticketId,
    params.workState,
    params.linearStatus,
    `rev:${params.revision}`,
    `vRev:${params.verifiedRevision ?? "none"}`,
    `vStat:${params.verificationStatus}`,
    `att:${params.verificationAttempts}`,
    `rep:${params.verificationRepairs}`,
    `del:${params.lastDelegationRole ?? "none"}:${params.lastDelegationOutcome ?? "none"}`,
  ].join("|");
}

export interface EvaluateContinuationOptions {
  autonomy: AutonomyState;
  ticketManager: TicketManager;
  verification: VerificationState;
  routing: RoutingState;
  governor: ContextGovernor;
  hasPendingPermissionAsk?: boolean;
  isPermissionDenied?: boolean;
  isSandboxAvailable?: boolean;
  linearError?: string;
  scopeChanged?: boolean;
}

export function evaluateContinuation(options: EvaluateContinuationOptions): ContinuationDecision {
  const {
    autonomy,
    ticketManager,
    verification,
    routing,
    governor,
    hasPendingPermissionAsk,
    isPermissionDenied,
    isSandboxAvailable = true,
    linearError,
    scopeChanged,
  } = options;

  // 1. If autonomy is disabled, do nothing
  if (!autonomy.enabled) {
    return { decision: "wait", reason: "Autonomy is not enabled" };
  }

  // 2. User stop requested
  if (autonomy.stopRequested) {
    return { decision: "blocked", reason: "User requested autonomy stop", stopReason: "user_stopped" };
  }

  // 3. Active ticket check
  const activeTicket = ticketManager.getActiveTicket();
  if (!activeTicket) {
    return { decision: "blocked", reason: "No active ticket loaded in session", stopReason: "blocked" };
  }

  // 4. Ticket already completed
  const workState = ticketManager.getWorkState();
  if (workState === "complete" || activeTicket.statusType === "completed") {
    return { decision: "complete", reason: `Ticket ${activeTicket.identifier} is completed in Linear`, stopReason: "completed" };
  }

  // 5. Ticket explicitly blocked
  if (workState === "blocked") {
    return { decision: "blocked", reason: `Ticket ${activeTicket.identifier} is marked blocked`, stopReason: "blocked" };
  }

  // 6. Permission ASK / User required
  if (hasPendingPermissionAsk) {
    return { decision: "user_required", reason: "Boundary-crossing action requires user authorization", stopReason: "user_required" };
  }

  // 7. Permission DENIED
  if (isPermissionDenied) {
    return { decision: "blocked", reason: "Required operation was denied by permission policy", stopReason: "permission_denied" };
  }

  // 8. Scope change
  if (scopeChanged) {
    return { decision: "user_required", reason: "Task scope changed substantially; human decision required", stopReason: "scope_change" };
  }

  // 9. Sandbox unavailable
  if (!isSandboxAvailable && verification.status === "blocked") {
    return { decision: "blocked", reason: "OS sandbox is unavailable for verification", stopReason: "sandbox_unavailable" };
  }

  // 10. Linear remote conflict
  if (linearError === "remote_conflict") {
    return { decision: "blocked", reason: "Remote conflict detected in Linear ticket; stopping to avoid overwrite", stopReason: "linear_conflict" };
  }

  // 11. Linear sync failed after valid PASS
  if (linearError === "network_failure" || linearError === "auth_unavailable" || linearError === "sync_error") {
    return { decision: "blocked", reason: "Implementation verified PASS but Linear sync failed; stopping without re-running code", stopReason: "linear_sync_failed" };
  }

  // 12. Context Governor ceiling and compaction failure
  if (governor.getZone() === "ceiling" && governor.getTelemetry().consecutiveCompactionFailures > 0) {
    return { decision: "blocked", reason: "Parent context ceiling reached and compaction failed", stopReason: "context_failure" };
  }

  // 13. Context compaction pending or in-flight
  if (governor.isCompactPending() || governor.isCompacting()) {
    return { decision: "wait", reason: "Context compaction in progress or pending" };
  }

  // 14. Active child delegation in flight
  if (routing.currentMode === "delegated") {
    return { decision: "wait", reason: "Child delegation currently in flight" };
  }

  // 15. Circuit breaker: maximum continuations
  if (autonomy.continuationCount >= MAX_AUTO_CONTINUATIONS) {
    return {
      decision: "blocked",
      reason: `Autonomy circuit breaker triggered: reached maximum continuations (${MAX_AUTO_CONTINUATIONS})`,
      stopReason: "continuation_limit",
    };
  }

  // 16. Verification authority inspection (AIES-005)
  const vPlan = planVerification(verification);
  if (vPlan.action === "stop") {
    let stopReason: AutonomyStopReason = "verification_failed";
    if (verification.status === "protocol_error") {
      stopReason = "verification_protocol_error";
    } else if (verification.repairs >= vPlan.maxRepairs) {
      stopReason = "repair_limit";
    } else if (verification.status === "blocked") {
      stopReason = "blocked";
    } else if (verification.repeatedFailures >= 2) {
      stopReason = "no_progress";
    }
    return {
      decision: "blocked",
      reason: `Verification policy stopped: ${vPlan.reason}`,
      stopReason,
    };
  }

  if (vPlan.action === "wait") {
    return { decision: "wait", reason: `Verification: ${vPlan.reason}` };
  }

  // 17. Progress detection via fingerprint
  const currentFingerprint = computeStateFingerprint({
    ticketId: activeTicket.identifier,
    workState,
    linearStatus: activeTicket.status,
    revision: verification.revision,
    verifiedRevision: verification.verifiedRevision,
    verificationStatus: verification.status,
    verificationAttempts: verification.attempts,
    verificationRepairs: verification.repairs,
    lastDelegationRole: routing.lastDelegation?.role,
    lastDelegationOutcome: routing.lastDelegation?.outcome,
  });

  if (autonomy.lastFingerprint && autonomy.lastFingerprint === currentFingerprint) {
    if (autonomy.consecutiveSameFingerprint >= MAX_CONSECUTIVE_SAME_FINGERPRINT) {
      return {
        decision: "blocked",
        reason: `No material progress detected across ${MAX_CONSECUTIVE_SAME_FINGERPRINT} consecutive settled runs`,
        stopReason: "no_progress",
      };
    }
  }

  // 18. Normal progression cases:
  // - Verified PASS, ready for Linear completion
  if (vPlan.action === "done") {
    return {
      decision: "continue",
      reason: "Artifact verified PASS; ready for Linear completion",
      followUpPrompt: AIES_CONTINUATION_PROMPT,
    };
  }

  // - Verify FAIL with repair allowed
  if (vPlan.action === "repair") {
    return {
      decision: "continue",
      reason: `Verify FAIL; repair permitted (${vPlan.repair} of ${vPlan.maxRepairs}); continuing to Worker repair`,
      followUpPrompt: AIES_CONTINUATION_PROMPT,
    };
  }

  // - Verification required (behaviour changed, awaiting verification)
  if (vPlan.action === "verify") {
    return {
      decision: "continue",
      reason: "Work unit awaiting verification; continuing to Verify child",
      followUpPrompt: AIES_CONTINUATION_PROMPT,
    };
  }

  // - In progress implementation or exploration
  return {
    decision: "continue",
    reason: `Ticket ${activeTicket.identifier} in progress (${workState}); continuing workflow`,
    followUpPrompt: AIES_CONTINUATION_PROMPT,
  };
}
