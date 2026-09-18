/**
 * Permission ASK presentation.
 *
 * The policy decision is not made here: this only turns a structured request
 * into the title and message Pi's `confirm` dialog shows. A missing part is
 * omitted rather than labelled; a justification the policy does not know is
 * never invented.
 */

import { singleLine } from "./format.ts";

/** What the approval gate knows about the request. */
export interface ApprovalRequest {
  action: string;
  /** The concrete command, e.g. `pnpm add zod`. */
  detail?: string;
  /** The side effect, when the policy can name one. */
  effect?: string;
  /** Why it is being requested, when the policy can name one. */
  reason?: string;
}

/**
 * Build the dialog copy. `title` is fixed; `message` is a short multi-line block
 * with only the parts that have a value. The allow/deny choices belong to Pi's
 * `confirm`, so they are not repeated here.
 */
export function renderApprovalPrompt(request: ApprovalRequest): { title: string; message: string } {
  const lines: string[] = [];

  const action = singleLine(request.action ?? "");
  if (action) lines.push(action);

  const detail = singleLine(request.detail ?? "");
  if (detail) lines.push(`  ${detail}`);

  const effect = singleLine(request.effect ?? "");
  if (effect) {
    if (lines.length) lines.push("");
    lines.push("Efecto");
    lines.push(`  ${effect}`);
  }

  const reason = singleLine(request.reason ?? "");
  if (reason) {
    if (lines.length) lines.push("");
    lines.push("Necesario para");
    lines.push(`  ${reason}`);
  }

  return { title: "AIES necesita permiso", message: lines.join("\n") };
}
