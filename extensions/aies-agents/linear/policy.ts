/**
 * AIES-008: Linear Workflow Policy & Done Gate.
 *
 * Rules:
 * 1. Single active ticket per session.
 * 2. Start transition only when concrete work begins.
 * 3. Done Gate: Behavior-bearing changes REQUIRE a valid fresh Verify PASS.
 *    Stale PASS, none, fail, or blocked DENY completion.
 *    Docs-only changes complete without Verify child when requiresVerification is false.
 * 4. EZE-503: an explicit user request to keep the last step (review or commit)
 *    outranks any verdict: while it stands, completion is denied without touching
 *    the verification record.
 * 5. Remote freshness & conflict check before completion.
 */

import { isVerificationValid, requiresVerification, type VerificationState } from "../verification.ts";
import { readIssueState } from "./contract.ts";
import { describePendingFinalAction, type PendingFinalAction } from "./pending-action.ts";
import type { ActiveTicket, LinearIssueRaw, LinearStatus, TicketWorkState } from "./types.ts";

export interface DoneGateResult {
  allowed: boolean;
  reason: string;
  /**
   * Which rule refused. A pending final action is reported as itself instead of as
   * a Verify failure, so the Parent, the autonomy controller and the collapsed tool
   * row never claim the evidence is missing when it is not.
   */
  code?: "pending_final_action" | "verify_gate_denied";
}

export interface TicketSwitchCheck {
  allowed: boolean;
  reason?: string;
}

/**
 * Enforces 1 Linear ticket = 1 logical parent session.
 * Prevents accidental cross-ticket mixing.
 */
export function canSwitchTicket(
  activeTicket: ActiveTicket | null,
  currentWorkState: TicketWorkState,
  newTicketId: string,
  force?: boolean,
): TicketSwitchCheck {
  if (!activeTicket) {
    return { allowed: true };
  }

  if (activeTicket.identifier === newTicketId || activeTicket.id === newTicketId) {
    return { allowed: true };
  }

  if (force) {
    return { allowed: true };
  }

  if (currentWorkState === "complete" || currentWorkState === "blocked" || currentWorkState === "loaded") {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Cannot switch to ticket ${newTicketId}: ticket ${activeTicket.identifier} is currently in progress (${currentWorkState}). Complete or block it first, or use force: true.`,
  };
}

/** A refusal raised by the verification authority, named as such for the caller. */
function denied(reason: string): DoneGateResult {
  return { allowed: false, code: "verify_gate_denied", reason };
}

/**
 * Programmatic Done Gate enforcement.
 *
 * Request Linear complete
 *         │
 *         ├── explicit pending final action asked by the user? ──► DENY (PASS kept)
 *         ▼
 * requiresVerification?
 *         │
 *        yes ──► valid fresh Verify PASS?
 *         │             │          │
 *         │            no         yes
 *         │             │          │
 *         │           DENY       ALLOW
 *         │
 *        no ──► ALLOW (docs-only / trivial)
 */
export function checkDoneGate(
  verification: VerificationState,
  changedPaths: string[],
  pendingFinalAction?: PendingFinalAction | null,
): DoneGateResult {
  // EZE-503: Verify proves the work unit; only the user can authorise the last
  // step. The hold is evaluated first so it also covers a docs-only change (where
  // no Verify run is required), and it exists only while the user asked for it, so
  // a commit is never universally required.
  if (pendingFinalAction) {
    return {
      allowed: false,
      code: "pending_final_action",
      reason: `Pending final action: ${describePendingFinalAction(pendingFinalAction)}.`,
    };
  }

  const requirement = requiresVerification(changedPaths);

  // Docs-only or trivial change does not require Verify child
  if (!requirement.required) {
    return {
      allowed: true,
      reason: `Verification not required: ${requirement.reason}`,
    };
  }

  // Behavior-bearing change requires independent verification
  if (verification.status === "none") {
    return denied("Verification required: no verification run has been executed (status: none)");
  }

  if (verification.status === "fail") {
    return denied("Verification failed: cannot complete ticket with failing verification (status: fail)");
  }

  if (verification.status === "blocked") {
    return denied("Verification blocked: cannot complete ticket while verification is blocked (status: blocked)");
  }

  if (verification.status === "running") {
    return denied("Verification in progress: cannot complete ticket while verification is running");
  }

  if (verification.status === "pass") {
    if (!isVerificationValid(verification)) {
      return denied(
        `Verification is stale: verified revision ${verification.verifiedRevision ?? "none"} does not match current revision ${verification.revision}`,
      );
    }
    return {
      allowed: true,
      reason: `Verified PASS on revision ${verification.revision}`,
    };
  }

  return denied(`Cannot complete ticket: unknown verification status "${verification.status}"`);
}

/**
 * Resolve target Linear status without hardcoding names.
 * Prioritizes status `type` category ("started", "completed", etc.), then matches name.
 */
export function resolveTargetStatus(
  statuses: LinearStatus[],
  targetType: "started" | "completed" | "unstarted",
): LinearStatus | undefined {
  // Linear reports a team's started states in an order where review can precede
  // progress, so a type-only match would move a ticket into review when work
  // starts. Prefer the state that actually means in-progress.
  if (targetType === "started") {
    const inProgress = statuses.find(
      (status) => status.type === "started" && /in\s*progress|started|doing|en\s*progreso/i.test(status.name),
    );
    if (inProgress) return inProgress;
  }

  // First match by type
  const byType = statuses.find((s) => s.type === targetType);
  if (byType) return byType;

  // Fallback by name heuristics
  if (targetType === "started") {
    return statuses.find((s) => /in\s*progress|started|doing|en\s*progreso/i.test(s.name));
  }
  if (targetType === "completed") {
    return statuses.find((s) => /done|completed|closed|terminad[oa]|listo/i.test(s.name));
  }
  if (targetType === "unstarted") {
    return statuses.find((s) => /todo|por\s*hacer|unstarted|backlog/i.test(s.name));
  }

  return undefined;
}

/**
 * Detects whether remote state changed incompatibly before Done is executed.
 */
export function detectRemoteConflict(
  activeTicket: ActiveTicket,
  fresh: LinearIssueRaw,
): { conflict: boolean; reason?: string } {
  const freshState = readIssueState(fresh);
  const freshStatusType = freshState.type;
  const freshStatusName = freshState.name;

  if (freshStatusType === "completed") {
    return {
      conflict: true,
      reason: `Remote ticket was already completed externally (${freshStatusName}).`,
    };
  }

  if (freshStatusType === "canceled") {
    return {
      conflict: true,
      reason: `Remote ticket was canceled externally (${freshStatusName}).`,
    };
  }

  return { conflict: false };
}
