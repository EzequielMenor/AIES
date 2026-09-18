/**
 * Permission policy model and taxonomy for AIES (AIES-006).
 *
 * Separates the three layers:
 * 1. Capability surface: tool availability per role.
 * 2. Permission policy: semantic ALLOW / ASK / DENY evaluation.
 * 3. OS/runtime boundary: OS sandbox containment.
 *
 * Taxonomy:
 * - ALLOW: Safe, local, reversible development work (reads, workspace edits,
 *   tests, linters, builds, git inspection).
 * - ASK: Deliberate actions that cross a boundary (dependency installation/modification,
 *   non-routine network, privileged configuration changes).
 *   * If UI is available: prompts user for approval.
 *   * If UI is not available (headless, automated, child session): ASK -> DENY.
 *   * Child agents cannot self-approve.
 * - DENY: Dangerous or irreversible operations (sudo, secrets reading,
 *   destructive git, remote push/deploy/publish, mass deletion, writes outside
 *   authorized roots).
 */

import { renderApprovalPrompt, type ApprovalRequest } from "../aies-ui/approval.ts";

export type PermissionAction = "allow" | "ask" | "deny";

export interface PermissionEvaluation {
  action: PermissionAction;
  reason?: string;
  prompt?: string;
  /** Structured copy for the ASK dialog. The policy decision is still `action`. */
  approval?: ApprovalRequest;
}

export interface PermissionTelemetry {
  denials: number;
  approvals: number;
  sandboxFailures: number;
}

const telemetryState: PermissionTelemetry = {
  denials: 0,
  approvals: 0,
  sandboxFailures: 0,
};

export function getPermissionTelemetry(): Readonly<PermissionTelemetry> {
  return { ...telemetryState };
}

export function recordPermissionDenial(): void {
  telemetryState.denials++;
}

export function recordApprovalRequest(): void {
  telemetryState.approvals++;
}

export function recordSandboxFailure(): void {
  telemetryState.sandboxFailures++;
}

export function resetPermissionTelemetry(): void {
  telemetryState.denials = 0;
  telemetryState.approvals = 0;
  telemetryState.sandboxFailures = 0;
}

export interface PermissionGateContext {
  hasUI?: boolean;
  ui?: {
    confirm: (title: string, message: string) => Promise<boolean>;
    notify?: (message: string, type: string) => void;
  };
}

/**
 * Handle an ASK evaluation through the Parent/UI approval gate.
 * In non-UI environments or child sessions, ASK automatically becomes DENY.
 */
export async function handlePermissionGate(
  evaluation: PermissionEvaluation,
  ctx?: PermissionGateContext,
): Promise<{ allowed: boolean; reason?: string }> {
  if (evaluation.action === "allow") {
    return { allowed: true };
  }

  if (evaluation.action === "deny") {
    recordPermissionDenial();
    return { allowed: false, reason: evaluation.reason ?? "Action denied by permission policy" };
  }

  // Action is "ask"
  recordApprovalRequest();

  if (!ctx?.hasUI || !ctx?.ui?.confirm) {
    recordPermissionDenial();
    return {
      allowed: false,
      reason: `Action requires user approval (${evaluation.prompt ?? evaluation.reason ?? "boundary crossing"}), but no interactive UI is available. In automated/child mode: ASK -> DENY`,
    };
  }

  try {
    const prompt = renderApprovalPrompt(
      evaluation.approval ?? { action: "Confirmar la operación", reason: evaluation.prompt ?? evaluation.reason },
    );
    const approved = await ctx.ui.confirm(prompt.title, prompt.message);

    if (approved) {
      return { allowed: true };
    }

    recordPermissionDenial();
    return { allowed: false, reason: "Operation rejected by user." };
  } catch (err: any) {
    recordPermissionDenial();
    return { allowed: false, reason: `Approval dialog failed: ${err?.message ?? String(err)}` };
  }
}
