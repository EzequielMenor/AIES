/**
 * The AIES status panel: a pure, boxed header block that answers "what is the
 * run doing and what has it spent" at a glance.
 *
 * Wide terminals get two inner columns, mid terminals a single compact column,
 * and anything narrower gets nothing at all so the caller can fall back to the
 * rich footer. This is a header block, never a sidebar: it renders from the
 * snapshot, decides nothing and holds no state.
 *
 * Every row is printed only when it has a value; a fact the snapshot cannot
 * answer is omitted rather than guessed. The `Paint` adapter is injected, so the
 * same renderer is plain text in tests and headless runs.
 */

import type { AiesSnapshot } from "../aies-runtime/state.ts";
import type { AgentsSnapshot } from "./agents.ts";
import { formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint } from "./paint.ts";
import { deriveStage, isCompacting, isContextPressure } from "./vocabulary.ts";

/** Below this width the panel renders nothing. */
export const PANEL_MIN_WIDTH = 72;

/** At or above this width the panel switches to the two-column layout. */
export const PANEL_WIDE_WIDTH = 100;

/** The widest the box is allowed to grow. */
const PANEL_MAX_WIDTH = 72;

/** Body rows the wide and mid boxes are allowed, so the box never grows unbounded. */
const WIDE_BODY_ROWS = 6;
const MID_BODY_ROWS = 4;

/** Inner layout budgets for the two-column tier. */
const LEFT_WIDTH = 26;
const COLUMN_GAP = 2;

/** Fixed label width inside a column, so values line up. */
const LABEL_WIDTH = 9;

interface Row {
  label: string;
  value: string;
}

export interface PanelOptions {
  width?: number;
  paint?: Paint;
}

function positiveWidth(width: number | undefined): number | undefined {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return undefined;
  return Math.floor(width);
}

/** A non-collapsing clip: the box body keeps its internal alignment spacing. */
function hardClip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

function padEnd(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function capitalize(value: string): string {
  const trimmed = singleLine(value);
  if (!trimmed) return "";
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Run wall-clock while a run is active, otherwise the session elapsed time. */
function elapsedMs(snapshot: AiesSnapshot, now: number): number {
  const run = snapshot.runUsage;
  if (run?.active && typeof run.startedAt === "number") return Math.max(0, now - run.startedAt);
  return Math.max(0, now - snapshot.startedAt);
}

function contextValue(snapshot: AiesSnapshot): string {
  if (isCompacting(snapshot)) return "compactando…";
  const tokens = formatTokens(snapshot.contextTokens);
  return isContextPressure(snapshot) ? `${tokens} !` : tokens;
}

function agentsValue(snapshot: AgentsSnapshot): string | undefined {
  const records = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  const active = snapshot.delegations?.activeRole;
  if (records.length === 0 && !active) return undefined;
  const role = active ? `${capitalize(active)} activo` : "";
  return role ? `${records.length} · ${role}` : `${records.length}`;
}

function formatRow(row: Row): string {
  return `${row.label.padEnd(LABEL_WIDTH)}${row.value}`;
}

/** The title line, embedded in the top border: `✧ AIES · <ticket|listo> · <STAGE>`. */
function panelTitle(snapshot: AiesSnapshot): string {
  const stage = deriveStage(snapshot);
  const ticket = snapshot.ticket;
  const parts = ["✧ AIES"];
  if (ticket?.active && ticket.identifier) parts.push(singleLine(ticket.identifier));
  else if (stage === "IDLE") parts.push("listo");
  parts.push(stage);
  return parts.join(" · ");
}

function leftColumn(snapshot: AgentsSnapshot, now: number): Row[] {
  const rows: Row[] = [];
  const model = snapshot.model;
  if (model?.label) {
    rows.push({ label: "Modelo", value: singleLine(model.label) });
    if (model.provider) rows.push({ label: "", value: singleLine(model.provider) });
  }
  rows.push({ label: "Contexto", value: contextValue(snapshot) });
  rows.push({ label: "Tiempo", value: formatDuration(elapsedMs(snapshot, now)) });
  const agents = agentsValue(snapshot);
  if (agents !== undefined) rows.push({ label: "Agentes", value: agents });
  return rows;
}

function groupRows(group: string, entries: Array<[string, string]>): Row[] {
  return entries.map(([key, value], index) => ({
    label: index === 0 ? group : "",
    value: `${key.padEnd(7)}${value}`,
  }));
}

function rightColumn(snapshot: AiesSnapshot): Row[] {
  const run = snapshot.runUsage;
  if (!run) return [];

  const rows: Row[] = [];
  if (run.total.totalTokens > 0) {
    const entries: Array<[string, string]> = [];
    if (run.main.totalTokens > 0) entries.push(["Main", formatTokens(run.main.totalTokens)]);
    if (run.agents.totalTokens > 0) entries.push(["Agents", formatTokens(run.agents.totalTokens)]);
    entries.push(["Total", formatTokens(run.total.totalTokens)]);
    rows.push(...groupRows("Tokens", entries));
  }

  // A cost block shows only when at least one value was measured; within it an
  // unknown cost is an em dash, never a zero.
  if (run.main.cost !== null || run.total.cost !== null) {
    rows.push(
      ...groupRows("Coste", [
        ["Main", formatCost(run.main.cost)],
        ["Agents", formatCost(run.agents.cost)],
        ["Total", formatCost(run.total.cost)],
      ]),
    );
  }

  return rows;
}

function wideBody(snapshot: AgentsSnapshot, now: number, boxWidth: number): string[] {
  const left = leftColumn(snapshot, now);
  const right = rightColumn(snapshot);
  const inner = boxWidth - 4;
  const rightWidth = Math.max(0, inner - LEFT_WIDTH - COLUMN_GAP);
  const rowCount = Math.min(WIDE_BODY_ROWS, Math.max(left.length, right.length));

  const body: string[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const leftCell = padEnd(hardClip(left[index] ? formatRow(left[index]) : "", LEFT_WIDTH), LEFT_WIDTH);
    const rightCell = hardClip(right[index] ? formatRow(right[index]) : "", rightWidth);
    body.push(`${leftCell}${" ".repeat(COLUMN_GAP)}${rightCell}`);
  }
  return body;
}

function midBody(snapshot: AgentsSnapshot, now: number): string[] {
  const rows: Row[] = [
    { label: "Contexto", value: contextValue(snapshot) },
    { label: "Tiempo", value: formatDuration(elapsedMs(snapshot, now)) },
  ];

  const agents = agentsValue(snapshot);
  if (agents !== undefined) rows.push({ label: "Agentes", value: agents });

  const model = snapshot.model;
  if (model?.label) {
    const provider = model.provider ? ` · ${singleLine(model.provider)}` : "";
    rows.push({ label: "Modelo", value: `${singleLine(model.label)}${provider}` });
  }

  const run = snapshot.runUsage;
  if (run && run.total.totalTokens > 0) rows.push({ label: "Tokens", value: formatTokens(run.total.totalTokens) });
  if (run && (run.main.cost !== null || run.total.cost !== null)) {
    rows.push({ label: "Coste", value: formatCost(run.total.cost) });
  }

  // Cost is dropped first, then tokens, then the model: the base rows the human
  // is always owed stay, and the least critical fact goes first.
  return rows.slice(0, MID_BODY_ROWS).map(formatRow);
}

function box(title: string, body: string[], boxWidth: number, paint: Paint): string[] {
  const inner = boxWidth - 4;
  const label = ` ${title} `;
  const dashes = Math.max(0, boxWidth - 3 - label.length);
  const lines = [paint.fg("accent", `╭─${label}${"─".repeat(dashes)}╮`)];
  for (const line of body) {
    lines.push(`│ ${padEnd(hardClip(line, inner), inner)} │`);
  }
  lines.push(paint.fg("accent", `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`));
  return lines;
}

/**
 * Render the status panel. `[]` below `PANEL_MIN_WIDTH` (or without a width) so
 * the caller falls back to the rich footer. The box never exceeds 72 columns and
 * the wide tier never exceeds 8 lines; the mid tier never exceeds 6.
 */
export function renderStatusPanel(snapshot: AgentsSnapshot, now: number, options: PanelOptions = {}): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const width = positiveWidth(options.width);
  if (width === undefined || width < PANEL_MIN_WIDTH) return [];

  const boxWidth = Math.min(width, PANEL_MAX_WIDTH);
  const title = panelTitle(snapshot);
  const body = width >= PANEL_WIDE_WIDTH ? wideBody(snapshot, now, boxWidth) : midBody(snapshot, now);
  return box(title, body, boxWidth, paint);
}
