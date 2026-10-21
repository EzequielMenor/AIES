/**
 * Agent Observatory renderers (AIES-010C / T4a, polished in the UI final pass / T3).
 *
 * One pure surface and one navigation helper:
 *
 * - `renderAgentsView` is the `/agents` modal: a responsive, framed observatory
 *   with a selectable list and the selected record's structured detail.
 * - `selectAgent` is the wrap-around index math the runtime binds keys to.
 *
 * Records are the observatory's immutable projection. A renderer never invents a
 * fact: an unavailable model, token count, cost, context or file list renders as
 * `—`, and a value is never estimated or recalculated. There is no transcript, no
 * reasoning and no child prose beyond the mechanical activity wording already
 * carried by the record.
 *
 * The surface is pure and Pi-free. It composes content at the inner width the
 * shared modal frame will give it and hands the result to `renderModalFrame`, so
 * every line fits the host width and colors still come from the injected Paint.
 */

import { MAX_ACTIVITIES, shortPath, type AgentRecord } from "../aies-agents/observatory.ts";
import type { AiesSnapshot } from "../aies-runtime/state.ts";
import { MODAL_FRAME_CHROME, MODAL_MAX_WIDTH, renderModalFrame, type ModalLine } from "./modal.ts";
import {
  agentContextText,
  agentCostNote,
  agentCostValue,
  agentName,
  agentReason,
  agentStateView,
  agentToolText,
  CONTEXT_UNKNOWN,
  formatRelative,
} from "./agent-monitor.ts";
import { formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";

/** Mechanical activity entries the detail block shows. */
const MAX_RECENT = 5;

/** Edited paths the expanded card lists before it collapses the rest into `… N más`. */
const MAX_EXPANDED_PATHS = 8;

/** Paths the `/agents` detail row lists before it collapses the rest into `… N más`. */
const MAX_DETAIL_PATHS = 3;

const VIEW_LABEL_WIDTH = 16;

/** The left column width of the wide, side-by-side layout. */
const LIST_COLUMN_WIDTH = 30;

/** The gutter between the list and the detail columns. */
const COLUMN_GAP = 2;

/** The deliberate frame width for the observatory: larger than the model picker. */
export const AGENTS_MODAL_WIDTH = Math.min(MODAL_MAX_WIDTH, 88);

/** The inner width at which the layout switches from stacked to side by side. */
export const AGENTS_SPLIT_MIN_WIDTH = 68;

/** How many list rows the bounded window shows before it scrolls around the selection. */
export const AGENTS_VISIBLE_ROWS = 8;

const AGENTS_TITLE = "AIES Agents";
const AGENTS_HELP = "↑↓ j/k agente · enter/tab detalle · esc/q cerrar";
const AGENTS_HELP_EXPANDED = "↑↓ j/k agente · enter/tab lista · esc/q cerrar";

/** The one placeholder for telemetry the observatory did not measure. */
const UNAVAILABLE = "—";

export type AgentsSnapshot = AiesSnapshot & { readonly agents?: readonly AgentRecord[] };
export type AgentDirection = "left" | "right" | "up" | "down" | (string & {});

export interface AgentsOptions {
  width?: number;
  paint?: Paint;
  /** Show the selected agent's full card instead of the list plus summary. */
  expanded?: boolean;
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

/** The status glyph: a running child is live once it reports work, queued before. */
function statusGlyph(record: AgentRecord): string {
  return agentStateView(record).glyph;
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
 * index is clamped first. Pure, so the runtime can bind keys without logic in the
 * component.
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
  return agentName(record, index);
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

function textValue(value: unknown): string {
  return typeof value === "string" ? singleLine(value) : "";
}

/** Tokens as measured, or empty when the observatory has no positive sample. */
function tokensValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? formatTokens(value) : "";
}

function countValue(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "";
}

/**
 * The child's own context bar, only from the `getContextUsage()` reading the
 * observatory recorded. Unknown (never sampled, or null after a compaction) is
 * empty, which the row renders as `—`; it is never derived from token totals.
 */
function contextValue(record: AgentRecord): string {
  const text = agentContextText(record);
  return text === CONTEXT_UNKNOWN ? "" : text.replace(/^ctx /u, "");
}

function filesValue(record: AgentRecord): string {
  if (Array.isArray(record.changedPaths) && record.changedPaths.length > 0) {
    const formatted = changedPathsValue(record.changedPaths);
    if (formatted) return formatted;
  }
  const result = typeof record.result === "string" ? record.result : "";
  const match = result.match(/(\d+\s+archivos?\s+(?:relevantes?|modificados?))/i);
  if (match) return match[1];
  return "";
}

/**
 * The selected record's structured detail. Every telemetry row is always
 * present and an unmeasured value renders as `—`: a missing sample must not look
 * like a fact the renderer omitted.
 */
function detailLines(record: AgentRecord, now: number, width: number): ModalLine[] {
  const rows: string[] = [];
  const add = (label: string, value: string): void => {
    const text = singleLine(value);
    rows.push(`  ${label.padEnd(VIEW_LABEL_WIDTH)}${text || UNAVAILABLE}`);
  };

  add("modelo", textValue(record.modelLabel ?? record.modelId));
  add("proveedor", textValue(record.providerLabel ?? record.providerId));
  add("tiempo", elapsedBetween(record, now) ?? "");
  add("tokens", tokensValue(record.totalTokens));
  add("coste", agentCostValue(record));
  add("contexto", contextValue(record));
  add("herramientas", countValue(record.toolCount));
  add("archivos", filesValue(record));
  add("resultado final", textValue(record.result));
  const costNote = agentCostNote(record);
  if (costNote) rows.push(`  ${costNote}`);

  const activities = Array.isArray(record.activities) ? record.activities.slice(0, MAX_RECENT) : [];
  if (activities.length > 0) {
    rows.push("  actividad reciente");
    for (const activity of activities) {
      const text = textValue(activity?.text);
      if (text) rows.push(`    ${text}`);
    }
  }

  return rows.map((text) => ({ text: hardClip(text, width), color: "text" as const }));
}

/**
 * The selected agent's full card: state, current tool, token breakdown, context,
 * cost, edited paths, the recent history with relative times, and the redacted
 * result or reason. Every value is the observatory's own; an unmeasured one is `—`.
 */
function expandedLines(
  record: AgentRecord,
  index: number,
  count: number,
  now: number,
  width: number,
): ModalLine[] {
  const view = agentStateView(record);
  const rows: ModalLine[] = [];
  const push = (text: string, color: SemanticColor = "text"): void => {
    rows.push({ text: hardClip(text, width), color });
  };
  const add = (label: string, value: string): void => {
    push(`  ${label.padEnd(VIEW_LABEL_WIDTH)}${singleLine(value) || UNAVAILABLE}`);
  };
  const tokenCount = (value: unknown): string =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? formatTokens(value) : "";

  const elapsed = elapsedBetween(record, now);
  push(`${view.glyph} ${agentLabel(record, index)}  ${view.label}${elapsed ? `  ${elapsed}` : ""}  (${index + 1}/${count})`, view.tone);
  add("modelo", textValue(record.modelLabel ?? record.modelId));
  add("proveedor", textValue(record.providerLabel ?? record.providerId));
  add("herramienta", agentToolText(record));
  add("tokens", tokensValue(record.totalTokens));
  push("    el total puede incluir caché: no es entrada + salida");
  add("entrada/salida", [tokenCount(record.inputTokens), tokenCount(record.outputTokens)].every(Boolean)
    ? `${tokenCount(record.inputTokens)}↓ ${tokenCount(record.outputTokens)}↑`
    : "");
  add("caché", [tokenCount(record.cacheReadTokens), tokenCount(record.cacheWriteTokens)].every(Boolean)
    ? `lectura ${tokenCount(record.cacheReadTokens)} · escritura ${tokenCount(record.cacheWriteTokens)}`
    : "");
  add("contexto", agentContextText(record));
  add("coste", agentCostValue(record));
  const costNote = agentCostNote(record);
  if (costNote) push(`    ${costNote}`);
  add("herramientas", countValue(record.toolCount));

  const outcome = view.state === "error" || view.state === "blocked";
  add(outcome ? "motivo" : "resultado final", outcome ? agentReason(record) : textValue(record.result));

  const paths = (Array.isArray(record.changedPaths) ? record.changedPaths : [])
    .map((path) => shortPath(path))
    .filter(Boolean);
  push("  rutas editadas");
  if (paths.length === 0) push(`    ${UNAVAILABLE}`);
  for (const path of paths.slice(0, MAX_EXPANDED_PATHS)) push(`    ${path}`);
  if (paths.length > MAX_EXPANDED_PATHS) push(`    … ${paths.length - MAX_EXPANDED_PATHS} más`);

  const activities = Array.isArray(record.activities) ? record.activities.slice(0, MAX_ACTIVITIES) : [];
  push("  historial reciente");
  if (activities.length === 0) push(`    ${UNAVAILABLE}`);
  for (const activity of activities) {
    const text = textValue(activity?.text);
    if (!text) continue;
    const age = typeof activity.at === "number" ? `${formatRelative(activity.at, now)}  ` : "";
    push(`    ${age}${text}`);
  }
  return rows;
}

/**
 * The positions the bounded list window renders: a slice centred on the
 * selection and never larger than `max`, so a long session still reads as a
 * small, stable surface.
 */
function listWindow(count: number, index: number, max: number): number[] {
  if (count <= 0) return [];
  const size = Math.max(1, Math.min(max, count));
  let start = index - Math.floor(size / 2);
  if (start < 0) start = 0;
  if (start + size > count) start = count - size;
  const positions: number[] = [];
  for (let position = start; position < start + size; position += 1) positions.push(position);
  return positions;
}

/** The semantic tone of a child's lifecycle, from the shared vocabulary palette. */
function statusTone(status: AgentRecord["status"]): SemanticColor {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "blocked":
      return "warning";
    default:
      return "running";
  }
}

/**
 * The human state label of a child, matching the panel/rail wording so a child
 * reads the same way everywhere (`activo`/`completado`/`falló`/`bloqueado`).
 */
function statusLabel(status: AgentRecord["status"]): string {
  switch (status) {
    case "completed":
      return "completado";
    case "failed":
      return "falló";
    case "blocked":
      return "bloqueado";
    default:
      return "activo";
  }
}

/** The selectable list rows, each clipped to the column width. */
function listLines(records: readonly AgentRecord[], index: number, width: number): ModalLine[] {
  return listWindow(records.length, index, AGENTS_VISIBLE_ROWS).map((position) => {
    const record = records[position];
    const marker = position === index ? "▸" : " ";
    const chip = `${statusGlyph(record)} ${statusLabel(record.status)}`;
    const text = hardClip(`${marker} ${agentLabel(record, position)}  ${chip}`, width);
    return { text, color: position === index ? "selection" : statusTone(record.status) };
  });
}

/**
 * Join two bounded columns row by row into single, width-safe rows. The shared
 * frame paints exactly one tone per line, so a combined row takes the left list
 * entry's tone (selection or the child's lifecycle) whenever a list line exists,
 * and falls back to the detail tone only for the rows below the list. This is
 * what keeps the left column's state chips painted without a second renderer.
 */
function composeColumns(
  left: readonly ModalLine[],
  right: readonly ModalLine[],
  leftWidth: number,
  gap: number,
  totalWidth: number,
): ModalLine[] {
  const rows: ModalLine[] = [];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const cell = hardClip(left[index]?.text ?? "", leftWidth);
    const padded = cell.length >= leftWidth ? cell : `${cell}${" ".repeat(leftWidth - cell.length)}`;
    rows.push({
      text: hardClip(`${padded}${" ".repeat(gap)}${right[index]?.text ?? ""}`, totalWidth),
      color: left[index]?.color ?? right[index]?.color ?? "text",
    });
  }
  return rows;
}

/**
 * The unframed `/agents` content. A wide inner width uses side-by-side columns
 * (list plus detail); anything narrower stacks a bounded list above the detail.
 * Every returned line is already clipped to `innerWidth`.
 */
function renderAgentsContent(
  records: readonly AgentRecord[],
  selectedIndex: number,
  now: number,
  innerWidth: number,
  expanded: boolean,
): ModalLine[] {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) {
    return [{ text: hardClip("  sin agentes en esta sesión", innerWidth), color: "dim" }];
  }

  const index = clampIndex(selectedIndex, list.length);
  const record = list[index];

  if (expanded) return expandedLines(record, index, list.length, now, innerWidth);

  if (innerWidth >= AGENTS_SPLIT_MIN_WIDTH) {
    const listWidth = Math.min(LIST_COLUMN_WIDTH, Math.max(1, innerWidth - COLUMN_GAP - 1));
    const detailWidth = Math.max(1, innerWidth - listWidth - COLUMN_GAP);
    return composeColumns(
      listLines(list, index, listWidth),
      detailLines(record, now, detailWidth),
      listWidth,
      COLUMN_GAP,
      innerWidth,
    );
  }

  return [
    ...listLines(list, index, innerWidth),
    { text: "", color: "text" },
    ...detailLines(record, now, innerWidth),
  ];
}

/**
 * The `/agents` modal: a centered, bounded frame around the responsive content.
 * Every line fits the passed width; the frame degrades to clipped plain rows
 * below the smallest drawable width instead of overdrawing.
 */
export function renderAgentsView(
  records: readonly AgentRecord[],
  selectedIndex: number,
  now: number,
  options: AgentsOptions = {},
): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const available = positiveWidth(options.width) ?? 80;
  const frameWidth = Math.min(available, AGENTS_MODAL_WIDTH);
  const innerWidth = Math.max(1, frameWidth - MODAL_FRAME_CHROME);
  const expanded = options.expanded === true;
  const lines = renderAgentsContent(records, selectedIndex, now, innerWidth, expanded);

  return renderModalFrame({
    title: AGENTS_TITLE,
    lines,
    help: expanded ? AGENTS_HELP_EXPANDED : AGENTS_HELP,
    width: available,
    preferredWidth: AGENTS_MODAL_WIDTH,
    paint,
  });
}
