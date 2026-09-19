/**
 * The single workflow vocabulary of AIES: one stage dimension plus a handful of
 * independent indicators. Everything here is a pure reading of the snapshot; no
 * renderer invents state.
 */

import type { AiesSnapshot } from "../aies-runtime/state.ts";

/** Where the work is. Answer exactly one of these; never a second dimension. */
export type Stage = "IDLE" | "EXPLORE" | "WORK" | "VERIFY" | "REPAIR" | "WAIT" | "BLOCKED" | "DONE";

/**
 * Autonomy stop reasons that mean the workflow stopped on a real blocker. The
 * list is deliberately explicit: an unrecognised reason is not a blocker.
 */
const BLOCKED_STOP_REASONS: ReadonlySet<string> = new Set([
  "blocked",
  "linear_conflict",
  "linear_sync_failed",
  "permission_denied",
  "sandbox_unavailable",
  "no_progress",
  "verification_failed",
  "verification_protocol_error",
  "repair_limit",
  "context_failure",
]);

/** Context Governor zones that mean the window is no longer comfortable. */
const PRESSURE_ZONES: ReadonlySet<string> = new Set(["pressure", "compact", "ceiling"]);

/** True while the context governor is holding pressure, compacting or at the ceiling. */
export function isContextPressure(snapshot: AiesSnapshot): boolean {
  const zone = snapshot.contextGovernor?.zone;
  return typeof zone === "string" && PRESSURE_ZONES.has(zone);
}

/** True while a compaction is in flight. */
export function isCompacting(snapshot: AiesSnapshot): boolean {
  return snapshot.contextGovernor?.compacting === true;
}

/**
 * The verification indicator, or `undefined` when it would add nothing. A blocked
 * verification and a verification that never ran are `undefined` because the
 * stage already carries that information, but a protocol error is its own fact
 * and shows as `V:ERROR`.
 */
export function verificationIndicator(snapshot: AiesSnapshot): "V:PASS" | "V:FAIL" | "V:STALE" | "V:ERROR" | undefined {
  const verification = snapshot.verification;
  if (!verification) return undefined;
  switch (verification.status) {
    case "pass":
      if (verification.valid) return "V:PASS";
      return verification.attempts > 0 ? "V:STALE" : undefined;
    case "fail":
      return "V:FAIL";
    case "protocol_error":
      return "V:ERROR";
    default:
      return undefined;
  }
}

/**
 * Spanish human label for a verification status. Raw internal codes (including
 * `protocol_error`) are never shown; a protocol fault reads as its own fact.
 */
export function verificationStatusLabel(status: string | undefined): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "fail":
      return "FAIL";
    case "blocked":
      return "BLOCKED";
    case "protocol_error":
      return "error de protocolo";
    case "running":
      return "en curso";
    default:
      return "sin verificar";
  }
}

/** The stage of the work, evaluated in the documented order; first match wins. */
export function deriveStage(snapshot: AiesSnapshot): Stage {
  const stopReason = snapshot.autonomy?.stopReason ?? undefined;
  const verification = snapshot.verification;

  if ((typeof stopReason === "string" && BLOCKED_STOP_REASONS.has(stopReason)) || verification?.status === "blocked" || verification?.status === "protocol_error") {
    return "BLOCKED";
  }
  if (stopReason === "user_required") return "WAIT";

  const activeRole = snapshot.delegations?.activeRole;
  if (stopReason === "completed") return "DONE";
  if (verification?.status === "pass" && verification.valid && !activeRole) return "DONE";

  if (activeRole === "verify") return "VERIFY";
  if (activeRole === "worker") return verification?.status === "fail" ? "REPAIR" : "WORK";
  if (activeRole === "explore") return "EXPLORE";
  return "IDLE";
}
