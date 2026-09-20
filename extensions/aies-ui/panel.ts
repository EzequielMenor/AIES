/**
 * The AIES status panel: a pure status block that answers "what is the run doing
 * and what has it spent" at a glance, rendered as a persistent widget below the
 * editor when the terminal is wide enough.
 *
 * Wide terminals get a compact, borderless block of at most four lines; mid
 * terminals a single compact column box; anything narrower gets nothing at all so
 * the caller can fall back to the ticket header. It renders from the snapshot,
 * decides nothing and holds no state.
 *
 * Every row is printed only when it has a value; a fact the snapshot cannot
 * answer is omitted rather than guessed. The `Paint` adapter is injected, so the
 * same renderer is plain text in tests and headless runs.
 */

import type { AiesSnapshot } from "../aies-runtime/state.ts";
import type { AgentsSnapshot } from "./agents.ts";
import { formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import { deriveStage, isCompacting, isContextPressure } from "./vocabulary.ts";

/** Below this width the panel renders nothing. */
export const PANEL_MIN_WIDTH = 72;

/** At or above this width the panel switches to the two-column layout. */
export const PANEL_WIDE_WIDTH = 100;

/** The widest the box (and any AIES card that shares this cap) is allowed to grow. */
export const PANEL_MAX_WIDTH = 72;

/** The wide tier is a compact, borderless block of at most four lines. */
export const PANEL_WIDE_LINES = 4;

/** Body rows the mid box is allowed, so the box never grows unbounded. */
const MID_BODY_ROWS = 4;

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
  // An empty registry is not a zero: print the row only when a child was actually
  // observed, so an active role never renders a `0` count next to it.
  if (records.length === 0) return undefined;
  const active = snapshot.delegations?.activeRole;
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

function wideMetaRow(snapshot: AgentsSnapshot, now: number): string {
  const parts: string[] = [];
  const model = snapshot.model;
  if (model?.label) {
    const label = singleLine(model.label);
    parts.push(model.provider ? `${label} · ${singleLine(model.provider)}` : label);
  }
  parts.push(`ctx ${contextValue(snapshot)}`);
  parts.push(formatDuration(elapsedMs(snapshot, now)));
  const agents = agentsValue(snapshot);
  if (agents !== undefined) parts.push(agents);
  return parts.join(" · ");
}

/** Run token telemetry: `Tokens Main … · Agents … · Total …`, omitted when nothing was measured. */
function wideTokenRow(run: AgentsSnapshot["runUsage"]): string | undefined {
  if (!run || run.total.totalTokens <= 0) return undefined;
  const entries: string[] = [];
  if (run.main.totalTokens > 0) entries.push(`Main ${formatTokens(run.main.totalTokens)}`);
  if (run.agents.totalTokens > 0) entries.push(`Agents ${formatTokens(run.agents.totalTokens)}`);
  entries.push(`Total ${formatTokens(run.total.totalTokens)}`);
  return `Tokens ${entries.join(" · ")}`;
}

/**
 * Whether a cost row carries information: an agent ran, or the run measured a
 * nonzero/known cost. A run with no agents and a measured zero cost is idle
 * noise and prints no cost row at all.
 */
function costRowVisible(snapshot: AgentsSnapshot): boolean {
  const run = snapshot.runUsage;
  const hasAgents = Array.isArray(snapshot.agents) && snapshot.agents.length > 0;
  if (hasAgents) return true;
  if (!run) return false;
  if (run.total.cost === 0) return false;
  return run.main.cost !== null || run.total.cost !== null;
}

/**
 * Run cost, omitted when there is nothing to report. Within a shown row an
 * unknown bucket stays an em dash, never a zero the run did not measure.
 */
function wideCostRow(snapshot: AgentsSnapshot): string | undefined {
  if (!costRowVisible(snapshot)) return undefined;
  const run = snapshot.runUsage;
  const main = formatCost(run?.main.cost ?? null);
  const agents = formatCost(run?.agents.cost ?? null);
  const total = formatCost(run?.total.cost ?? null);
  return `Coste Main ${main} · Agents ${agents} · Total ${total}`;
}

/**
 * The wide tier: the title row, one row carrying model, context, time and agents,
 * then the usage rows that have a value. At most four compact lines, no box.
 */
function wideRows(snapshot: AgentsSnapshot, now: number): Array<{ text: string; color: SemanticColor }> {
  const rows: Array<{ text: string; color: SemanticColor }> = [
    { text: panelTitle(snapshot), color: "accent" },
    { text: wideMetaRow(snapshot, now), color: "text" },
  ];
  const tokens = wideTokenRow(snapshot.runUsage);
  if (tokens) rows.push({ text: tokens, color: "muted" });
  const cost = wideCostRow(snapshot);
  if (cost) rows.push({ text: cost, color: "muted" });
  return rows.slice(0, PANEL_WIDE_LINES);
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
  if (costRowVisible(snapshot)) rows.push({ label: "Coste", value: formatCost(run?.total.cost ?? null) });

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
 * the caller falls back to the ticket header. At `PANEL_WIDE_WIDTH` and above it
 * is a persistent, borderless block of at most `PANEL_WIDE_LINES` lines, each at
 * most 72 columns; between the two thresholds it keeps the single-column box.
 */
export function renderStatusPanel(snapshot: AgentsSnapshot, now: number, options: PanelOptions = {}): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const width = positiveWidth(options.width);
  if (width === undefined || width < PANEL_MIN_WIDTH) return [];

  const budget = Math.min(width, PANEL_MAX_WIDTH);
  if (width >= PANEL_WIDE_WIDTH) {
    return wideRows(snapshot, now).map((row) => paint.fg(row.color, hardClip(row.text, budget)));
  }

  return box(panelTitle(snapshot), midBody(snapshot, now), budget, paint);
}
