/**
 * Verification record, invalidation and repair policy (AIES-005).
 *
 * Verify proves; the parent decides. This module is the parent's side of that
 * bargain, and it is pure: no Pi import, no I/O, no timers. `index.ts` feeds it
 * the events it already handles, and the same functions drive the tests.
 *
 * Three rules live here, and nowhere else:
 *
 * - **Independence of the verdict.** A PASS is tied to the revision it verified.
 *   Any parent edit or completed Worker run moves the revision, so an old PASS
 *   stops being valid the moment the artifact changes.
 * - **Bounded repair.** A FAIL can be repaired twice, and a failure that repeats
 *   its own signature without progress stops the loop early.
 * - **When verification is required at all.** A behaviour-bearing change needs
 *   independent verification; a documentation-only change does not.
 */

import { verifyFailureSignature, type VerifyHandoff } from "./handoff.ts";

export type VerificationStatus = "none" | "running" | "pass" | "fail" | "blocked";

/** What the parent should do next, according to the policy. */
export type VerificationAction = "verify" | "repair" | "done" | "stop" | "wait" | "none";

/** Repair cycles a FAIL may spend. Two repairs means at most three verifications. */
export const MAX_REPAIR_CYCLES = 2;

/** Hard ceiling on verification runs, so a parent cannot loop by re-verifying. */
export const MAX_VERIFY_ATTEMPTS = 4;

export interface VerificationState {
  status: VerificationStatus;
  /** Verification runs started. */
  attempts: number;
  /** Worker runs started while a FAIL was awaiting repair. */
  repairs: number;
  /** Monotonic work-unit revision: one per parent mutation or Worker run. */
  revision: number;
  /** Revision the last PASS verified, when there is one. */
  verifiedRevision: number | undefined;
  /** Last verdict reported by Verify, kept across superseding worker runs. */
  lastStatus: "pass" | "fail" | "blocked" | undefined;
  lastDurationMs: number | undefined;
  lastFailureSignature: string | undefined;
  /** Consecutive verifications that reported the same failure signature. */
  repeatedFailures: number;
  /** True when a behaviour-bearing change is waiting for verification. */
  awaitingVerification: boolean;
  startedAt: number | undefined;
  lastChange: string | undefined;
}

export interface VerificationDecision {
  action: VerificationAction;
  attempt: number;
  repair: number;
  maxRepairs: number;
  maxAttempts: number;
  reason: string;
}

/** The compact, parent- and observer-facing projection of the record. */
export interface VerificationReport {
  status: VerificationStatus;
  attempts: number;
  repairs: number;
  maxRepairs: number;
  maxAttempts: number;
  valid: boolean;
  awaitingVerification: boolean;
  decision: VerificationAction;
  reason: string;
}

export function createVerificationState(): VerificationState {
  return {
    status: "none",
    attempts: 0,
    repairs: 0,
    revision: 0,
    verifiedRevision: undefined,
    lastStatus: undefined,
    lastDurationMs: undefined,
    lastFailureSignature: undefined,
    repeatedFailures: 0,
    awaitingVerification: false,
    startedAt: undefined,
    lastChange: undefined,
  };
}

/** A PASS is only valid while it still describes the current revision. */
export function isVerificationValid(state: VerificationState): boolean {
  return state.status === "pass" && state.verifiedRevision === state.revision;
}

/**
 * Record a change to the work unit. This is the invalidation rule: an old PASS
 * never survives a new revision, because `verifiedRevision` lags behind.
 */
export function applyWorkUnitChange(
  state: VerificationState,
  note: string,
): VerificationState {
  return {
    ...state,
    revision: state.revision + 1,
    status: state.status === "pass" ? "none" : state.status,
    verifiedRevision: state.status === "pass" ? undefined : state.verifiedRevision,
    lastChange: note,
  };
}

/**
 * Record a completed Worker run: the artifact changed, whatever the Worker said
 * about it. A pending FAIL is superseded, and the requirement rule decides
 * whether the new revision waits for verification.
 */
export function applyWorkerResult(
  state: VerificationState,
  changedPaths: string[],
): VerificationState {
  const requirement = requiresVerification(changedPaths);
  return {
    ...applyWorkUnitChange(state, requirement.reason),
    status: "none",
    awaitingVerification: requirement.required,
  };
}

/** Record a Worker run that the parent launched to repair a FAIL. */
export function applyWorkerRepairStart(state: VerificationState): VerificationState {
  if (state.status !== "fail") return state;
  return { ...state, repairs: state.repairs + 1 };
}

/** Record the start of a verification run. */
export function applyVerifyStart(state: VerificationState, now: number): VerificationState {
  return {
    ...state,
    status: "running",
    attempts: state.attempts + 1,
    startedAt: now,
  };
}

/** Record the verdict, the failure signature and the repair-loop bookkeeping. */
export function applyVerifyResult(
  state: VerificationState,
  handoff: VerifyHandoff,
  now: number,
): VerificationState {
  const duration =
    state.startedAt === undefined ? undefined : Math.max(0, now - state.startedAt);

  const next: VerificationState = {
    ...state,
    status: handoff.status,
    lastStatus: handoff.status,
    lastDurationMs: duration,
    startedAt: undefined,
  };

  if (handoff.status === "pass") {
    return { ...next, verifiedRevision: state.revision, awaitingVerification: false };
  }

  if (handoff.status === "fail") {
    const signature = verifyFailureSignature(handoff);
    const repeated = state.lastStatus === "fail" && signature === state.lastFailureSignature;
    return {
      ...next,
      lastFailureSignature: signature,
      repeatedFailures: repeated ? state.repeatedFailures + 1 : 1,
      awaitingVerification: true,
    };
  }

  // Blocked: a cause external to the change. It is not a defect to repair.
  return { ...next, awaitingVerification: true };
}

/**
 * The single place that decides what happens after a verdict: repair, stop, or
 * consider the work unit verified.
 */
export function planVerification(state: VerificationState): VerificationDecision {
  const base = {
    attempt: state.attempts,
    repair: state.repairs,
    maxRepairs: MAX_REPAIR_CYCLES,
    maxAttempts: MAX_VERIFY_ATTEMPTS,
  };

  if (state.status === "running") {
    return { ...base, action: "wait", reason: "verification in progress" };
  }

  if (state.status === "pass") {
    return isVerificationValid(state)
      ? {
          ...base,
          action: "done",
          reason: `verified at revision ${state.revision}`,
        }
      : {
          ...base,
          action: "verify",
          reason: "the work unit changed after the PASS; that verdict is no longer valid",
        };
  }

  if (state.status === "fail") {
    if (state.repeatedFailures >= 2) {
      return {
        ...base,
        action: "stop",
        reason: "the same failure signature repeated without material progress",
      };
    }
    if (state.repairs >= MAX_REPAIR_CYCLES) {
      return {
        ...base,
        action: "stop",
        reason: `repair budget exhausted (${MAX_REPAIR_CYCLES} cycles)`,
      };
    }
    if (state.attempts >= MAX_VERIFY_ATTEMPTS) {
      return {
        ...base,
        action: "stop",
        reason: `verification budget exhausted (${MAX_VERIFY_ATTEMPTS} runs)`,
      };
    }
    return {
      ...base,
      repair: state.repairs + 1,
      action: "repair",
      reason: `repair cycle ${state.repairs + 1} of ${MAX_REPAIR_CYCLES} is allowed`,
    };
  }

  if (state.status === "blocked") {
    return {
      ...base,
      action: "stop",
      reason: "blocked for a cause external to the change; repair is not the answer",
    };
  }

  if (state.awaitingVerification) {
    return {
      ...base,
      attempt: state.attempts + 1,
      action: "verify",
      reason: "a behaviour-bearing change requires independent verification",
    };
  }

  return { ...base, action: "none", reason: "no verification is required yet" };
}

export function toVerificationReport(state: VerificationState): VerificationReport {
  const decision = planVerification(state);
  return {
    status: state.status,
    attempts: state.attempts,
    repairs: state.repairs,
    maxRepairs: MAX_REPAIR_CYCLES,
    maxAttempts: MAX_VERIFY_ATTEMPTS,
    valid: isVerificationValid(state),
    awaitingVerification: state.awaitingVerification,
    decision: decision.action,
    reason: decision.reason,
  };
}

/**
 * Paths that carry no behaviour: markdown and plain documentation. Everything
 * else - code, tests, configuration - counts as behaviour-bearing, which is the
 * conservative direction for a rule whose job is to refuse untested claims.
 */
const DOCUMENTATION_PATTERNS: readonly RegExp[] = [
  /\.mdx?$/u,
  /\.txt$/u,
  /^docs\//u,
  /^LICENSE/u,
  /^CHANGELOG/u,
  /^NOTICE/u,
];

export function isDocumentationPath(rawPath: string): boolean {
  const path = rawPath.trim().replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/^\/+/u, "");
  if (!path) return false;
  return DOCUMENTATION_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Does this change need independent verification? A change that can alter
 * behaviour does; a documentation-only change does not.
 */
export function requiresVerification(changedPaths: string[]): {
  required: boolean;
  reason: string;
} {
  const paths = [...new Set(changedPaths.map((entry) => entry.trim()).filter(Boolean))];
  if (paths.length === 0) {
    return { required: false, reason: "no changed paths were reported" };
  }

  const bearing = paths.filter((path) => !isDocumentationPath(path));
  if (bearing.length === 0) {
    return { required: false, reason: `documentation-only change (${paths.join(", ")})` };
  }

  const sample = bearing.slice(0, 3).join(", ");
  const suffix = bearing.length > 3 ? `, +${bearing.length - 3} more` : "";
  return { required: true, reason: `behaviour-bearing change (${sample}${suffix})` };
}

function numberedList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function bulletList(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

export interface VerifyTaskInput {
  task: string;
  criteria: string[];
  changedPaths?: string[];
  baseRef?: string;
  checks?: string[];
}

/**
 * The exact context a Verify child receives: the work unit, the acceptance
 * criteria, and the facts needed to reproduce the checks. There is no path for a
 * Worker transcript, a Worker conclusion or any other free-form claim, because
 * there is no field to put one in.
 */
export function buildVerifyTaskInput(input: VerifyTaskInput): string {
  const blocks: string[] = [`WORK UNIT: ${input.task.trim()}`];

  blocks.push(`ACCEPTANCE CRITERIA:\n${numberedList(input.criteria.map((c) => c.trim()))}`);

  const changedPaths = (input.changedPaths ?? []).map((entry) => entry.trim()).filter(Boolean);
  blocks.push(
    changedPaths.length > 0
      ? `CHANGED PATHS:\n${bulletList(changedPaths)}`
      : "CHANGED PATHS: not reported; inspect the repository state yourself",
  );

  blocks.push(
    input.baseRef && input.baseRef.trim()
      ? `BASE REF: ${input.baseRef.trim()} (inspect it with read-only git commands)`
      : "BASE REF: the uncommitted working tree (inspect it with git status and git diff)",
  );

  const checks = (input.checks ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (checks.length > 0) {
    blocks.push(`SUGGESTED CHECKS (run them or better ones):\n${bulletList(checks)}`);
  }

  blocks.push(
    "Report the real repository state. Do not trust any claim about this change; only what you observed counts.",
  );

  return blocks.join("\n\n");
}

export interface RepairContextInput {
  task: string;
  criteria: string[];
  changedPaths?: string[];
  brief: string;
}

/**
 * The exact context a repair Worker receives: the original work unit, the
 * acceptance criteria and the concrete defects. It carries no verify transcript.
 */
export function buildRepairContext(input: RepairContextInput): string {
  const blocks: string[] = [`WORK UNIT: ${input.task.trim()}`];

  blocks.push(`ACCEPTANCE CRITERIA:\n${numberedList(input.criteria.map((c) => c.trim()))}`);

  blocks.push(`DEFECTS TO FIX (reported by independent verification):\n${input.brief.trim()}`);

  const changedPaths = (input.changedPaths ?? []).map((entry) => entry.trim()).filter(Boolean);
  if (changedPaths.length > 0) {
    blocks.push(`RELEVANT PATHS:\n${bulletList(changedPaths)}`);
  }

  blocks.push("Fix these defects and nothing else. Independent verification will run again.");

  return blocks.join("\n\n");
}

/** One compact line telling the parent what the policy expects next. */
export function formatVerificationNote(report: VerificationReport): string {
  return [
    `*Verification policy*: status ${report.status.toUpperCase()}`,
    `attempts ${report.attempts}/${report.maxAttempts}`,
    `repairs ${report.repairs}/${report.maxRepairs}`,
    `next: ${report.decision} — ${report.reason}`,
  ].join(" · ");
}
