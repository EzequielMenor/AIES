import type { AgentRecord } from "../aies-agents/observatory.ts";
import { runStartedAt } from "../aies-runtime/state.ts";
import { clip, formatCost, formatDuration, formatTokens, roleLabel, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import { deriveStage, isCompacting, isContextPressure, statusGlyph } from "./vocabulary.ts";
import type { AgentsSnapshot } from "./agents.ts";
import { deriveTodos, renderTodos } from "./todos.ts";

/** Below this width the status moves into the footer. */
export const PANEL_MIN_WIDTH = 80;

/** At this width the panel can combine related facts into fewer rows. */
export const PANEL_WIDE_WIDTH = 120;

/** A fixed dock must read as a card, never a full-width terminal banner. */
export const PANEL_MAX_WIDTH = 96;

export interface PanelOptions {
  width?: number;
  paint?: Paint;
}

function usableWidth(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < PANEL_MIN_WIDTH) return undefined;
  return Math.floor(value);
}

function modelText(snapshot: AgentsSnapshot): string | undefined {
  const label = singleLine(snapshot.model?.label ?? snapshot.model?.id ?? "");
  if (!label) return undefined;
  const provider = singleLine(snapshot.model?.provider ?? "");
  return provider ? `${label} · ${provider}` : label;
}

function contextText(snapshot: AgentsSnapshot): string {
  const pressure = isContextPressure(snapshot) ? " !" : "";
  const compacting = isCompacting(snapshot) ? " · compactando…" : "";
  return `${formatTokens(snapshot.contextTokens)}${pressure}${compacting}`;
}

function usageRows(snapshot: AgentsSnapshot): string[] {
  const usage = snapshot.runUsage;
  if (!usage) return [];

  const rows: string[] = [];
  if (usage.total.totalTokens > 0) {
    rows.push(
      `Tokens   Main ${formatTokens(usage.main.totalTokens)} · Agents ${formatTokens(usage.agents.totalTokens)} · Total ${formatTokens(usage.total.totalTokens)}`,
    );
  }

  const hasKnownCost = usage.main.cost !== null || usage.agents.cost !== null || usage.total.cost !== null;
  const hasNonZeroCost = [usage.main.cost, usage.agents.cost, usage.total.cost].some(
    (value) => typeof value === "number" && value > 0,
  );
  if (hasKnownCost && (hasNonZeroCost || usage.agents.totalTokens > 0)) {
    rows.push(
      `Coste    Main ${formatCost(usage.main.cost)} · Agents ${formatCost(usage.agents.cost)} · Total ${formatCost(usage.total.cost)}`,
    );
  }
  return rows;
}

/**
 * One child's one-line fact: role plus status glyph and label. Exported because
 * both the compact dock and the physical rail describe a child the same way.
 */
export function agentFact(record: AgentRecord): string {
  const label = {
    running: "activo",
    completed: "completado",
    failed: "falló",
    blocked: "bloqueado",
  }[record.status] ?? singleLine(record.status);
  return `${statusGlyph(record.status)} ${roleLabel(record.role)} ${label}`;
}

/** Active child first, then the newest completed child; never grow the dock. */
function agentsRow(snapshot: AgentsSnapshot): string | undefined {
  const records = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (!records.length) return undefined;
  const ordered = [...records].sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (right.status === "running" && left.status !== "running") return 1;
    return right.startedAt - left.startedAt;
  });
  return `Agentes  ${ordered.slice(0, 2).map(agentFact).join(" · ")}`;
}

function title(snapshot: AgentsSnapshot): string {
  const ticket = snapshot.ticket?.active && snapshot.ticket.identifier ? snapshot.ticket.identifier : "listo";
  return `✧ AIES · ${ticket} · ${deriveStage(snapshot)}`;
}

/**
 * Elapsed time of the current stage, in flight. While a delegation is active it
 * measures that stage from its own start; otherwise it measures the run from the
 * recorded run start. It never falls back to the session start, so an idle dock
 * shows nothing. `endAt`, when supplied, freezes a finished run at its own end so
 * it keeps its final duration instead of growing forever.
 */
export function activeRunElapsed(snapshot: AgentsSnapshot, now: number, endAt?: number): string | undefined {
  const runStart = runStartedAt(snapshot);
  if (typeof endAt === "number" && Number.isFinite(endAt)) {
    if (runStart === undefined) return undefined;
    return formatDuration(Math.max(0, Math.min(endAt, now) - runStart));
  }

  const delegations = snapshot.delegations;
  const stageStart = delegations?.activeStartedAt;
  const startedAt = typeof stageStart === "number" && Number.isFinite(stageStart) ? stageStart : runStart;
  if (startedAt === undefined) return undefined;
  return formatDuration(Math.max(0, now - startedAt));
}

/**
 * The single shared hierarchy primitive. Every AIES card draws its section
 * headings through it: the rail's `Status` and `Agents` sections and the
 * DONE/BLOCKED headlines. It only names a semantic color through the existing
 * `Paint`; the host theme decides the actual appearance. This is the smallest
 * abstraction that gives the rail and the summaries one hierarchy.
 */
export function sectionHeading(label: string, paint: Paint, tone: SemanticColor = "muted"): string {
  return paint.fg(tone, singleLine(label));
}

/**
 * The labelled facts shared by the compact below-editor dock and the right rail,
 * without the agent row. Exactly one implementation, so both surfaces time and
 * describe the run the same way; the rail gives the agents their own section.
 */
export function compactStatusRows(snapshot: AgentsSnapshot, now: number): string[] {
  const model = modelText(snapshot);
  const elapsed = activeRunElapsed(snapshot, now);
  const context = `Contexto  ${contextText(snapshot)}${elapsed ? ` · Tiempo ${elapsed}` : ""}`;
  return [
    model ? `Modelo    ${model}` : undefined,
    context,
    ...usageRows(snapshot),
  ].filter((row): row is string => Boolean(row));
}

/**
 * The labelled facts shared by the compact below-editor dock and the right rail.
 * Exactly one implementation, so both surfaces time and describe the run the same
 * way.
 */
export function compactPanelRows(snapshot: AgentsSnapshot, now: number): string[] {
  return [...compactStatusRows(snapshot, now), agentsRow(snapshot)].filter(
    (row): row is string => Boolean(row),
  );
}

/** The title line of the dock and the rail; exported so both read it identically. */
export function statusTitle(snapshot: AgentsSnapshot): string {
  return title(snapshot);
}

/**
 * One framed content row. `text` is the plain, aligned cell used to measure and
 * clip the row; `painted` is the finished cell to emit (defaults to `text`), so a
 * caller can color a row by segment without the color's escape length changing
 * the column layout.
 */
export interface StatusRow {
  text: string;
  painted?: string;
}

/** Clip a plain cell to `width` without collapsing its intentional column padding. */
function cellClip(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

/** Frame one content row: measure the plain text, emit its painted form when it fits. */
function framedRow(row: StatusRow, inner: number): string {
  const plain = cellClip(row.text, inner);
  if (plain !== row.text || typeof row.painted !== "string") {
    return `│ ${plain.padEnd(inner)} │`;
  }
  return `│ ${row.painted}${" ".repeat(Math.max(0, inner - plain.length))} │`;
}

/** Box a title and its bounded rows; exported for the rail's reused framing. */
export function statusBox(
  titleText: string,
  rows: Array<string | StatusRow>,
  width: number,
  paint: Paint,
): string[] {
  const inner = width - 4;
  const label = ` ${clip(titleText, Math.max(1, width - 6))} `;
  const top = `╭─${label}${"─".repeat(Math.max(0, width - 3 - label.length))}╮`;
  return [
    paint.fg("accent", top),
    ...rows.map((row) => (typeof row === "string" ? `│ ${clip(row, inner).padEnd(inner)} │` : framedRow(row, inner))),
    paint.fg("accent", `╰${"─".repeat(width - 2)}╯`),
  ];
}

/**
 * The supported fullscreen status dock. Pi owns the fullscreen viewport; this
 * pure renderer owns only the bounded `belowEditor` widget content.
 */
export function renderStatusPanel(
  snapshot: AgentsSnapshot,
  now: number,
  options: PanelOptions = {},
): string[] {
  const available = usableWidth(options.width);
  if (available === undefined) return [];

  const paint = options.paint ?? PLAIN_PAINT;
  const width = Math.min(available, available >= PANEL_WIDE_WIDTH ? PANEL_MAX_WIDTH : 72);
  const elapsed = activeRunElapsed(snapshot, now);
  const model = modelText(snapshot);
  const agents = agentsRow(snapshot);
  const usage = usageRows(snapshot);

  if (available >= PANEL_WIDE_WIDTH) {
    const primary = [model, `ctx ${contextText(snapshot)}`, elapsed].filter(Boolean).join("  ·  ");
    return statusBox(title(snapshot), [primary, ...usage, agents].filter((row): row is string => Boolean(row)), width, paint);
  }

  // The compact dock always carries the derived Todos summary as a single
  // bounded line, after the agent row so an active child is never crowded out.
  const todos = renderTodos(deriveTodos(snapshot), { paint, maxRows: 1 });
  return statusBox(title(snapshot), [...compactPanelRows(snapshot, now), ...todos], width, paint);
}
