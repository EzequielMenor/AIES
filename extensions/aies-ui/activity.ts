/**
 * Agent activity presentation: the live card for one child and the durable
 * one-line entry that survives the widget.
 *
 * Facts are reported numbers only. A fact that is undefined is omitted, never
 * shown as `0` or `—`; a broken record degrades to silence, never a guess.
 */

import { clip, formatDuration, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import type { Stage } from "./vocabulary.ts";

/** How long a finished card lingers on the widget before it clears itself. */
export const ACTIVITY_TTL_MS = 60_000;

/** One child delegation as the UI reads it. Fields are optional and unreadable input is ignored. */
export interface ActivityRecord {
  role: "explore" | "worker" | "verify" | (string & {});
  task: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: "done" | "blocked" | "failed" | "interrupted";
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

/** True while a child is running, or for the TTL after it finished. */
export function isActivityVisible(activity: ActivityRecord, now: number): boolean {
  if (!activity) return false;
  if (typeof activity.finishedAt !== "number") return true;
  return now - activity.finishedAt < ACTIVITY_TTL_MS;
}

/**
 * The card for the widget: `[]` when nothing should show, otherwise the live
 * three-line card or the finished one/two-line card.
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

  const live = typeof activity.finishedAt !== "number";
  if (live) {
    const head = paint.fg("accent", `◆ ${roleLabel(activity.role)}`);

    const rawSubtitle = liveSubtitle(activity, stage, options.ticketTitle);
    const shownSubtitle = width !== undefined ? clip(rawSubtitle, width - 2) : singleLine(rawSubtitle);
    const subtitle = shownSubtitle ? paint.fg("muted", `  ${shownSubtitle}`) : "";

    const elapsed = formatDuration(now - activity.startedAt);
    const elapsedText = options.showModel && activity.model ? `${elapsed} · ${activity.model}` : elapsed;
    const elapsedLine = paint.fg("dim", `  ${elapsedText}`);

    return [head, subtitle, elapsedLine].filter((line) => line !== "");
  }

  const color = outcomeColor(activity.outcome);
  const verdict = verdictFor(activity.role, activity.outcome);
  const duration = durationOf(activity);

  let head = `${outcomeGlyph(activity.outcome)} ${roleLabel(activity.role)}`;
  if (verdict) head += ` · ${verdict}`;
  if (duration) head += ` · ${duration}`;

  const lines = [paint.fg(color, head)];
  const factList = facts(activity);
  if (factList.length) {
    let factText = factList.join(" · ");
    if (width !== undefined) factText = clip(factText, width - 2);
    if (factText) lines.push(paint.fg("muted", `  ${factText}`));
  }
  return lines;
}

/** The durable transcript line for a finished child. */
export function renderActivityEntry(activity: ActivityRecord, options: { paint?: Paint } = {}): string {
  const paint = options.paint ?? PLAIN_PAINT;
  const parts = [`${outcomeGlyph(activity.outcome)} ${roleLabel(activity.role)}`];
  const verdict = verdictFor(activity.role, activity.outcome);
  if (verdict) parts.push(verdict);
  const duration = durationOf(activity);
  if (duration) parts.push(duration);

  let line = parts.join(" · ");
  const factList = facts(activity);
  if (factList.length) line += ` · ${factList.join(" · ")}`;
  return paint.fg(outcomeColor(activity.outcome), line);
}
