import type { AgentRecord } from "../aies-agents/observatory.ts";
import { clip, formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint } from "./paint.ts";
import { deriveStage, isCompacting, isContextPressure } from "./vocabulary.ts";
import type { AgentsSnapshot } from "./agents.ts";

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

function roleLabel(role: string): string {
  const value = singleLine(role);
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Agente";
}

function agentFact(record: AgentRecord): string {
  const look = {
    running: ["◆", "activo"],
    completed: ["✓", "completado"],
    failed: ["✗", "falló"],
    blocked: ["!", "bloqueado"],
  }[record.status] ?? ["·", singleLine(record.status)];
  return `${look[0]} ${roleLabel(record.role)} ${look[1]}`;
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

function box(titleText: string, rows: string[], width: number, paint: Paint): string[] {
  const inner = width - 4;
  const label = ` ${clip(titleText, Math.max(1, width - 6))} `;
  const top = `╭─${label}${"─".repeat(Math.max(0, width - 3 - label.length))}╮`;
  return [
    paint.fg("accent", top),
    ...rows.map((row) => `│ ${clip(row, inner).padEnd(inner)} │`),
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
  const elapsed = formatDuration(Math.max(0, now - snapshot.startedAt));
  const model = modelText(snapshot);
  const agents = agentsRow(snapshot);
  const usage = usageRows(snapshot);

  if (available >= PANEL_WIDE_WIDTH) {
    const primary = [model, `ctx ${contextText(snapshot)}`, elapsed].filter(Boolean).join("  ·  ");
    return box(title(snapshot), [primary, ...usage, agents].filter((row): row is string => Boolean(row)), width, paint);
  }

  const rows = [
    model ? `Modelo    ${model}` : undefined,
    `Contexto  ${contextText(snapshot)} · Tiempo ${elapsed}`,
    ...usage,
    agents,
  ].filter((row): row is string => Boolean(row));
  return box(title(snapshot), rows, width, paint);
}
