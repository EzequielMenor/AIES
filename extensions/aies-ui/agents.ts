/**
 * Agent Observatory renderers (AIES-010C / T4a).
 *
 * Two pure surfaces and one navigation helper:
 *
 * - `renderAgentsMini` is the compact `Agents` widget: one row per child, capped.
 * - `renderAgentsView` is the `/agents` screen: a selectable list plus the
 *   selected record's structured detail.
 * - `selectAgent` is the wrap-around index math T4b binds keys to.
 *
 * Records are the observatory's immutable projection. A renderer never invents a
 * fact: a missing model, token count or cost is omitted. There is no transcript,
 * no reasoning and no child prose beyond the mechanical activity wording already
 * carried by the record.
 */

import { shortPath, type AgentRecord } from "../aies-agents/observatory.ts";
import type { AiesSnapshot } from "../aies-runtime/state.ts";
import { formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint } from "./paint.ts";

/** Below this width the mini widget renders nothing. */
export const AGENTS_MINI_MIN_WIDTH = 48;

/**
 * The runtime snapshot plus the observatory records the UI renders. The snapshot
 * projects run telemetry but not `agents` (which lives on `AiesState`), so the UI
 * types its parameter as the snapshot augmented with the records it reads.
 */
export type AgentsSnapshot = AiesSnapshot & { readonly agents?: readonly AgentRecord[] };

/** Rows the mini widget shows before it collapses the rest into `… N más`. */
const MAX_MINI_ROWS = 4;

/** Mechanical activity entries the detail block shows. */
const MAX_RECENT = 5;

/** Paths the `/agents` detail row lists before it collapses the rest into `… N más`. */
const MAX_DETAIL_PATHS = 3;

const ROLE_WIDTH = 9;
const DETAIL_WIDTH = 18;
const VIEW_LABEL_WIDTH = 13;

export type AgentDirection = "left" | "right" | "up" | "down" | (string & {});

export interface AgentsOptions {
  width?: number;
  paint?: Paint;
}

function positiveWidth(width: number | undefined): number | undefined {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return undefined;
  return Math.floor(width);
}

/** A non-collapsing clip: the rows keep their column alignment spacing. */
function hardClip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function capitalize(value: string): string {
  const trimmed = singleLine(value);
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function hasActivity(record: AgentRecord): boolean {
  return Boolean(record.currentActivity) || (Array.isArray(record.changedPaths) && record.changedPaths.length > 0);
}

function lastPath(record: AgentRecord): string | undefined {
  const paths = Array.isArray(record.changedPaths) ? record.changedPaths : [];
  const last = singleLine(String(paths[paths.length - 1] ?? ""));
  return last || undefined;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/** The status glyph: a running child is live once it reports activity, queued before. */
function statusGlyph(record: AgentRecord): string {
  switch (record.status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "blocked":
      return "!";
    default:
      return hasActivity(record) ? "◆" : "◇";
  }
}

function detailOf(record: AgentRecord): string {
  if (record.status === "running") {
    const path = lastPath(record);
    if (path) return basename(path);
    if (record.currentActivity) return singleLine(record.currentActivity);
    return "esperando";
  }
  const count = Array.isArray(record.changedPaths) ? record.changedPaths.length : 0;
  if (count > 0) return count === 1 ? "1 archivo" : `${count} archivos`;
  if (record.result) return singleLine(record.result);
  return "";
}

function elapsedBetween(record: AgentRecord, now: number): string | undefined {
  if (typeof record.startedAt !== "number") return undefined;
  const end = typeof record.finishedAt === "number" ? record.finishedAt : now;
  return formatDuration(Math.max(0, end - record.startedAt));
}

/** Elapsed time, omitted for a running child that has not reported activity yet. */
function miniElapsed(record: AgentRecord, now: number): string {
  if (record.status === "running" && !hasActivity(record)) return "";
  return elapsedBetween(record, now) ?? "";
}

function miniRow(record: AgentRecord, now: number, width: number): string {
  const head = `${statusGlyph(record)} ${capitalize(record.role).padEnd(ROLE_WIDTH)}`;
  const detail = detailOf(record);
  const elapsed = miniElapsed(record, now);
  const tail = detail ? `${hardClip(detail, DETAIL_WIDTH - 1).padEnd(DETAIL_WIDTH)}${elapsed}` : elapsed;
  return hardClip(`${head}${tail}`, width);
}

/**
 * The compact `Agents` widget. `[]` with no records or below `AGENTS_MINI_MIN_WIDTH`;
 * otherwise at most four rows plus a `… N más` line.
 */
export function renderAgentsMini(snapshot: AgentsSnapshot, now: number, options: AgentsOptions = {}): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const width = positiveWidth(options.width);
  const records = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (records.length === 0) return [];
  if (width === undefined || width < AGENTS_MINI_MIN_WIDTH) return [];

  const lines = records.slice(0, MAX_MINI_ROWS).map((record) => paint.fg("text", miniRow(record, now, width)));
  if (records.length > MAX_MINI_ROWS) {
    lines.push(paint.fg("dim", hardClip(`… ${records.length - MAX_MINI_ROWS} más`, width)));
  }
  return lines;
}

function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  const truncated = Math.trunc(index);
  return ((truncated % count) + count) % count;
}

/**
 * Wrap-around navigation for the `/agents` list. `left`/`up` go back, `right`/`down`
 * go forward, an unknown direction keeps the current selection and an out-of-range
 * index is clamped first. Pure, so T4b can bind keys without logic in the component.
 */
export function selectAgent(
  records: readonly AgentRecord[],
  selectedIndex: number,
  direction: AgentDirection,
): number {
  const list = Array.isArray(records) ? records : [];
  const count = list.length;
  if (count === 0) return 0;

  const current = clampIndex(selectedIndex, count);
  switch (direction) {
    case "left":
    case "up":
      return (current - 1 + count) % count;
    case "right":
    case "down":
      return (current + 1) % count;
    default:
      return current;
  }
}

/** `Worker #1`: the role plus the observatory's per-role ordinal. */
function agentLabel(record: AgentRecord, index: number): string {
  const id = singleLine(record.id ?? "");
  const match = /^(.+)-(\d+)$/u.exec(id);
  if (match) return `${capitalize(match[1])} #${match[2]}`;
  return `${capitalize(record.role)} #${index + 1}`;
}

/**
 * The `/agents` detail `archivos` value: bounded short paths on one line. It
 * reuses the same two-segment `shortPath` form as the rest of the UI, so an
 * absolute home prefix never reaches the screen, and collapses the tail into
 * `… N más` once the list grows past a few entries.
 */
function changedPathsValue(paths: readonly unknown[]): string {
  const short = paths.map((path) => shortPath(path)).filter(Boolean);
  if (short.length === 0) return "";
  const shown = short.slice(0, MAX_DETAIL_PATHS).join(", ");
  const remaining = short.length - MAX_DETAIL_PATHS;
  return remaining > 0 ? `${shown}, … ${remaining} más` : shown;
}

function detailRows(record: AgentRecord, now: number, width: number): string[] {
  const rows: string[] = [];
  const add = (label: string, value: string | null | undefined): void => {
    const text = singleLine(String(value ?? ""));
    if (text) rows.push(`  ${label.padEnd(VIEW_LABEL_WIDTH)}${text}`);
  };

  add("modelo", record.modelLabel);
  add("proveedor", record.providerLabel);
  const elapsed = elapsedBetween(record, now);
  if (elapsed) add("tiempo", elapsed);
  if (typeof record.totalTokens === "number" && record.totalTokens > 0) add("tokens", formatTokens(record.totalTokens));
  if (typeof record.cost === "number") add("coste", formatCost(record.cost));
  if (typeof record.toolCount === "number" && record.toolCount > 0) add("herramientas", String(record.toolCount));

  const paths = Array.isArray(record.changedPaths) ? record.changedPaths : [];
  const changed = changedPathsValue(paths);
  if (changed) add("archivos", changed);

  const activities = Array.isArray(record.activities) ? record.activities.slice(0, MAX_RECENT) : [];
  if (activities.length) {
    rows.push("  actividad reciente");
    for (const activity of activities) {
      const text = singleLine(activity?.text ?? "");
      if (text) rows.push(`    ${text}`);
    }
  }

  add("resultado", record.result);
  return rows.map((row) => hardClip(row, width));
}

/**
 * The `/agents` screen: a selectable list of records followed by the selected
 * record's structured detail. Every line is clipped to the width. An empty run
 * still answers with the title and the key hint.
 */
export function renderAgentsView(
  records: readonly AgentRecord[],
  selectedIndex: number,
  now: number,
  options: AgentsOptions = {},
): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const width = positiveWidth(options.width) ?? 80;
  const list = Array.isArray(records) ? records : [];

  const lines: string[] = [paint.fg("text", hardClip("AIES Agents", width))];
  const hint = paint.fg("dim", hardClip("← → agente · esc cerrar", width));

  if (list.length === 0) {
    lines.push(paint.fg("dim", hardClip("  sin agentes en esta sesión", width)));
    lines.push(hint);
    return lines;
  }

  const index = clampIndex(selectedIndex, list.length);
  list.forEach((record, position) => {
    const row = hardClip(`${position === index ? "▸" : " "} ${statusGlyph(record)} ${agentLabel(record, position)}  ${record.status}`, width);
    lines.push(paint.fg(position === index ? "accent" : "dim", row));
  });

  lines.push("");
  lines.push(...detailRows(list[index], now, width).map((row) => paint.fg("text", row)));
  lines.push(hint);
  return lines;
}
