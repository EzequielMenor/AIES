/**
 * Agent Observatory renderers (AIES-010C / T4a).
 *
 * One pure surface and one navigation helper:
 *
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
import { capitalize, formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint } from "./paint.ts";
import { sectionHeading } from "./panel.ts";
import { GLYPH } from "./vocabulary.ts";

/** Mechanical activity entries the detail block shows. */
const MAX_RECENT = 5;

/** Paths the `/agents` detail row lists before it collapses the rest into `… N más`. */
const MAX_DETAIL_PATHS = 3;

const VIEW_LABEL_WIDTH = 13;

export type AgentsSnapshot = AiesSnapshot & { readonly agents?: readonly AgentRecord[] };
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

function hasActivity(record: AgentRecord): boolean {
  return Boolean(record.currentActivity) || (Array.isArray(record.changedPaths) && record.changedPaths.length > 0);
}

/** The status glyph: a running child is live once it reports activity, queued before. */
function statusGlyph(record: AgentRecord): string {
  switch (record.status) {
    case "completed":
      return GLYPH.done;
    case "failed":
      return GLYPH.failed;
    case "blocked":
      return GLYPH.blocked;
    default:
      return hasActivity(record) ? GLYPH.running : GLYPH.pending;
  }
}

function elapsedBetween(record: AgentRecord, now: number): string | undefined {
  if (typeof record.startedAt !== "number") return undefined;
  const end = typeof record.finishedAt === "number" ? record.finishedAt : now;
  return formatDuration(Math.max(0, end - record.startedAt));
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

  const lines: string[] = [sectionHeading(hardClip("AIES Agents", width), paint, "accent")];
  const hint = paint.fg("dim", hardClip("← → agente · esc cerrar", width));

  if (list.length === 0) {
    lines.push(paint.fg("dim", hardClip("  sin agentes en esta sesión", width)));
    lines.push(hint);
    return lines;
  }

  const index = clampIndex(selectedIndex, list.length);
  list.forEach((record, position) => {
    const row = hardClip(`${position === index ? "▸" : " "} ${statusGlyph(record)} ${agentLabel(record, position)}  ${record.status}`, width);
    lines.push(paint.fg(position === index ? "selection" : "dim", row));
  });

  lines.push("");
  lines.push(...detailRows(list[index], now, width).map((row) => paint.fg("text", row)));
  lines.push(hint);
  return lines;
}
