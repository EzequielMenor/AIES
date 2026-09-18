/**
 * AIES-008: Linear Workflow Policy & Done Gate.
 *
 * Rules:
 * 1. Single active ticket per session.
 * 2. Start transition only when concrete work begins.
 * 3. Done Gate: Behavior-bearing changes REQUIRE a valid fresh Verify PASS.
 *    Stale PASS, none, fail, or blocked DENY completion.
 *    Docs-only changes complete without Verify child when requiresVerification is false.
 * 4. Remote freshness & conflict check before completion.
 */

import { isVerificationValid, requiresVerification, type VerificationState } from "../verification.ts";
import type { ActiveTicket, LinearIssueRaw, LinearStatus, TicketWorkState } from "./types.ts";

export interface DoneGateResult {
  allowed: boolean;
  reason: string;
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

/**
 * Programmatic Done Gate enforcement.
 *
 * Request Linear completed
 *         ↓
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
): DoneGateResult {
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
    return {
      allowed: false,
      reason: "Verification required: no verification run has been executed (status: none)",
    };
  }

  if (verification.status === "fail") {
    return {
      allowed: false,
      reason: "Verification failed: cannot complete ticket with failing verification (status: fail)",
    };
  }

  if (verification.status === "blocked") {
    return {
      allowed: false,
      reason: "Verification blocked: cannot complete ticket while verification is blocked (status: blocked)",
    };
  }

  if (verification.status === "running") {
    return {
      allowed: false,
      reason: "Verification in progress: cannot complete ticket while verification is running",
    };
  }

  if (verification.status === "pass") {
    if (!isVerificationValid(verification)) {
      return {
        allowed: false,
        reason: `Verification is stale: verified revision ${verification.verifiedRevision ?? "none"} does not match current revision ${verification.revision}`,
      };
    }
    return {
      allowed: true,
      reason: `Verified PASS on revision ${verification.revision}`,
    };
  }

  return {
    allowed: false,
    reason: `Cannot complete ticket: unknown verification status "${verification.status}"`,
  };
}

/**
 * Resolve target Linear status without hardcoding names.
 * Prioritizes status `type` category ("started", "completed", etc.), then matches name.
 */
export function resolveTargetStatus(
  statuses: LinearStatus[],
  targetType: "started" | "completed" | "unstarted",
): LinearStatus | undefined {
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
  const freshStatusType = fresh.state?.type || fresh.status?.type;
  const freshStatusName = fresh.state?.name || fresh.status?.name || "Unknown";

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
