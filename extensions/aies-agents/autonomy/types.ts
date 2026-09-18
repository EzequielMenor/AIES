/**
 * AIES-009: Bounded Task Autonomy & Continuation Controller Types.
 */

export type ContinuationDecisionType =
  | "continue"
  | "wait"
  | "complete"
  | "blocked"
  | "user_required";

export type AutonomyStopReason =
  | "completed"
  | "user_stopped"
  | "user_required"
  | "blocked"
  | "verification_failed"
  | "repair_limit"
  | "no_progress"
  | "continuation_limit"
  | "permission_denied"
  | "sandbox_unavailable"
  | "context_failure"
  | "linear_conflict"
  | "linear_sync_failed"
  | "scope_change";

export interface AutonomyState {
  enabled: boolean;
  ticketId: string | null;
  continuationCount: number;
  lastDecision: ContinuationDecisionType | null;
  stopReason: AutonomyStopReason | null;
  lastFingerprint: string | null;
  consecutiveSameFingerprint: number;
  pending: boolean;
  lastStepDescription?: string;
  lastTriggeredAt?: number;
  stopRequested?: boolean;
}

export interface ContinuationDecision {
  decision: ContinuationDecisionType;
  reason: string;
  stopReason?: AutonomyStopReason;
  followUpPrompt?: string;
}

export interface AutonomyTelemetry {
  enabled: boolean;
  ticketId: string | null;
  continuationCount: number;
  stopReason: AutonomyStopReason | null;
  activations: number;
  noProgressStops: number;
  limitStops: number;
  userRequiredPauses: number;
  totalAutonomousDurationMs: number;
  lastStepDescription?: string;
}

export interface AutonomySnapshot {
  enabled: boolean;
  ticketId: string | null;
  continuationCount: number;
  lastDecision: ContinuationDecisionType | null;
  stopReason: AutonomyStopReason | null;
  lastStepDescription?: string;
  persistedAt: number;
}
