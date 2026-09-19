/**
 * Agent activity presentation: the live card for one child and the durable
 * one-line entry that survives the widget.
 *
 * Facts are reported numbers only. A fact that is undefined is omitted, never
 * shown as `0` or `—`; a broken record degrades to silence, never a guess.
 */

import { clip, formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import type { Stage } from "./vocabulary.ts";

/** At or above this width the live card is boxed; below it stays three plain lines. */
const BOXED_ACTIVITY_MIN_WIDTH = 48;

/** One child delegation as the UI reads it. Fields are optional and unreadable input is ignored. */
export interface ActivityRecord {
  role: "explore" | "worker" | "verify" | (string & {});
  task: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: "done" | "blocked" | "failed" | "interrupted" | "protocol_error";
  summary?: string;
  /** explore: relevant paths. */
  evidenceCount?: number;
  /** worker: modified files. */
  changedFiles?: number;
  /** worker/verify: checks that passed. */
  checksPassed?: number;
  checksTotal?: number;
  /** verify: criteria passed. */
  criteriaPassed?: number;
  criteriaTotal?: number;
  /** verify: blocking defects. */
  blockingDefects?: number;
  model?: string;
  /** The resolved child model label, when the observatory reported one. */
  modelLabel?: string;
  /** The resolved child provider label, when the observatory reported one. */
  providerLabel?: string;
  /** Tokens the child reported; a missing count is omitted, never shown as zero. */
  totalTokens?: number;
  /** Child cost; `null`/undefined is unknown and renders as an em dash only where a value is expected. */
  cost?: number | null;
  /** Mechanical, already-Spanish activity text (`Editando main.ts`). */
  currentActivity?: string | null;
  /** Paths the child changed, when it reported any. */
  changedPaths?: string[];
}

function isPositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveWidth(width: number | undefined): number | undefined {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return undefined;
  return Math.floor(width);
}

function roleLabel(role: string): string {
  const trimmed = singleLine(role ?? "");
  if (!trimmed) return "Agente";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function outcomeColor(outcome: string | undefined): SemanticColor {
  switch (outcome) {
    case "done":
      return "success";
    case "failed":
    case "protocol_error":
      return "error";
    case "blocked":
      return "warning";
    default:
      return "dim";
  }
}

function outcomeGlyph(outcome: string | undefined): string {
  switch (outcome) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "protocol_error":
      return "⚠";
    case "blocked":
      return "!";
    default:
      return "–";
  }
}

function verdictFor(role: string, outcome: string | undefined): string | undefined {
  if (role !== "verify") return undefined;
  switch (outcome) {
    case "done":
      return "PASS";
    case "failed":
      return "FAIL";
    case "blocked":
      return "BLOCKED";
    case "protocol_error":
      return "ERROR";
    default:
      return undefined;
  }
}

function durationOf(activity: ActivityRecord): string | undefined {
  if (typeof activity.startedAt !== "number" || typeof activity.finishedAt !== "number") return undefined;
  return formatDuration(activity.finishedAt - activity.startedAt);
}

function checksFact(activity: ActivityRecord): string | undefined {
  const total = activity.checksTotal;
  const passed = activity.checksPassed;
  if (typeof total === "number" && Number.isFinite(total) && total > 0) {
    if (typeof passed === "number" && Number.isFinite(passed)) {
      return passed >= total ? "checks aprobados" : `${passed}/${total} checks`;
    }
    return `${total} checks`;
  }
  return isPositive(passed) ? "checks aprobados" : undefined;
}

/** `1 archivo`, `3 archivos`: a count of one is not a plural in Spanish. */
function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The muted fact line: the numbers the delegation actually reported. */
function facts(activity: ActivityRecord): string[] {
  const out: string[] = [];
  if (activity.role === "explore") {
    if (isPositive(activity.evidenceCount)) {
      out.push(countLabel(activity.evidenceCount, "archivo relevante", "archivos relevantes"));
    }
  } else if (activity.role === "worker") {
    if (isPositive(activity.changedFiles)) {
      out.push(countLabel(activity.changedFiles, "archivo modificado", "archivos modificados"));
    }
    const checks = checksFact(activity);
    if (checks) out.push(checks);
  } else if (activity.role === "verify") {
    if (activity.outcome === "protocol_error") {
      out.push("error de protocolo");
      return out;
    }
    if (typeof activity.criteriaTotal === "number" && activity.criteriaTotal > 0 && typeof activity.criteriaPassed === "number" && Number.isFinite(activity.criteriaPassed)) {
      const noun = activity.criteriaTotal === 1 ? "criterio" : "criterios";
      out.push(`${activity.criteriaPassed}/${activity.criteriaTotal} ${noun}`);
    }
    if (isPositive(activity.blockingDefects)) {
      out.push(countLabel(activity.blockingDefects, "defecto bloqueante", "defectos bloqueantes"));
    }
    if (!out.length && activity.outcome === "blocked") out.push("la verificación no pudo concluir");
  }

  // No structured facts means no fact line: the raw child summary stays in the
  // internal handoff and is never re-rendered as a default card or entry fact.
  return out;
}

/** The "what it is doing" subtitle for a live child. */
function liveSubtitle(activity: ActivityRecord, stage: Stage, ticketTitle: string | undefined): string {
  // Verify reports the criterion count, which is its own authority, not the task.
  if (activity.role === "verify" && typeof activity.criteriaTotal === "number" && activity.criteriaTotal >= 1) {
    const noun = activity.criteriaTotal === 1 ? "criterio" : "criterios";
    return `Comprobando ${activity.criteriaTotal} ${noun}…`;
  }

  // Prefer the active ticket title so a Parent-authored English task prompt never
  // leaks into the default UI; fall back to the delegation's own task text.
  const title = singleLine(ticketTitle ?? "");
  const task = title || singleLine(activity.task);
  if (activity.role === "worker" && stage === "REPAIR") {
    return task ? `reparando · ${task}` : "reparando";
  }
  if (task) return task;

  switch (activity.role) {
    case "explore":
      return "Explorando el repositorio…";
    case "worker":
      return "Implementando el work unit…";
    case "verify":
      return "Comprobando criterios…";
    default:
      return "Trabajando…";
  }
}

/**
 * True while a child is running. A finished child is not a live surface: the
 * durable transcript entry is its single remaining trace, so the widget never
 * lingers with a stale card.
 */
export function isActivityVisible(activity: ActivityRecord, now: number): boolean {
  void now;
  if (!activity) return false;
  return typeof activity.finishedAt !== "number";
}

/** The "what it is doing" line: the mechanical activity wins over the task text. */
function activityLine(activity: ActivityRecord, stage: Stage, ticketTitle: string | undefined): string {
  const mechanical = singleLine(activity.currentActivity ?? "");
  if (mechanical) return mechanical;
  return liveSubtitle(activity, stage, ticketTitle);
}

/** The current file or command line: the last changed path, when the child reported one. */
function currentFileLine(activity: ActivityRecord): string | undefined {
  const paths = activity.changedPaths;
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  const last = singleLine(String(paths[paths.length - 1] ?? ""));
  return last || undefined;
}

/** The metric line: elapsed always, then each fact only when the child reported it. */
function metricsLine(activity: ActivityRecord, elapsed: string): string {
  const parts = [elapsed];
  const model = singleLine(activity.modelLabel ?? activity.model ?? "");
  if (model) parts.push(model);
  if (isPositive(activity.totalTokens)) parts.push(`${formatTokens(activity.totalTokens)} tokens`);
  if (typeof activity.cost === "number") parts.push(formatCost(activity.cost));
  return parts.join(" · ");
}

/** A boxed card: role on the top border, one content line per fact, nothing invented. */
function boxedCard(role: string, content: string[], width: number, paint: Paint): string[] {
  const inner = Math.max(1, width - 4);
  const label = ` ◆ ${role} `;
  const dashes = Math.max(0, width - 3 - label.length);
  const lines = [paint.fg("accent", `╭─${label}${"─".repeat(dashes)}╮`)];
  for (const line of content) {
    lines.push(`│ ${clip(line, inner).padEnd(inner)} │`);
  }
  lines.push(paint.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`));
  return lines;
}

/**
 * The card for the widget while a child runs: the boxed card at width 48 and
 * above, otherwise the plain three lines. A finished child renders nothing.
 */
export function renderActivityCard(
  activity: ActivityRecord,
  stage: Stage,
  now: number,
  options: { width?: number; paint?: Paint; showModel?: boolean; ticketTitle?: string } = {},
): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const width = positiveWidth(options.width);
  if (!isActivityVisible(activity, now)) return [];

  const role = roleLabel(activity.role);
  const line = activityLine(activity, stage, options.ticketTitle);
  const elapsed = formatDuration(now - activity.startedAt);

  if (width !== undefined && width >= BOXED_ACTIVITY_MIN_WIDTH) {
    const content = [line, currentFileLine(activity), metricsLine(activity, elapsed)].filter(
      (entry): entry is string => Boolean(entry),
    );
    return boxedCard(role, content, width, paint);
  }

  const head = paint.fg("accent", `◆ ${role}`);
  const shownLine = width !== undefined ? clip(line, width - 2) : singleLine(line);
  const subtitle = shownLine ? paint.fg("muted", `  ${shownLine}`) : "";
  const model = singleLine(activity.modelLabel ?? activity.model ?? "");
  const elapsedText = options.showModel && model ? `${elapsed} · ${model}` : elapsed;
  const elapsedLine = paint.fg("dim", `  ${elapsedText}`);
  return [head, subtitle, elapsedLine].filter((entry) => entry !== "");
}

/** The durable transcript line for a finished child: one line, tokens and cost included. */
export function renderActivityEntry(activity: ActivityRecord, options: { paint?: Paint } = {}): string {
  const paint = options.paint ?? PLAIN_PAINT;
  const parts = [`${outcomeGlyph(activity.outcome)} ${roleLabel(activity.role)}`];
  const verdict = verdictFor(activity.role, activity.outcome);
  if (verdict) parts.push(verdict);
  const duration = durationOf(activity);
  if (duration) parts.push(duration);
  if (isPositive(activity.totalTokens)) parts.push(formatTokens(activity.totalTokens));
  if (typeof activity.cost === "number") parts.push(formatCost(activity.cost));

  let line = parts.join(" · ");
  const factList = facts(activity);
  if (factList.length) line += ` · ${factList.join(" · ")}`;
  return paint.fg(outcomeColor(activity.outcome), line);
}
