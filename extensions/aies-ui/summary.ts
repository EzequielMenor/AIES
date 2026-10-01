/**
 * The two work-unit summaries (DONE, BLOCKED) and the human `/aies-status` view.
 *
 * Presentation only: a section with no value is omitted, never labelled with a
 * placeholder. Rows in the overview keep the `  <label><value>` layout so the
 * same reader works in tests and in the terminal.
 */

import type { AiesSnapshot } from "../aies-runtime/state.ts";
import type { AgentRecord } from "../aies-agents/observatory.ts";
import type { AgentsSnapshot } from "./agents.ts";
import { clip, formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import { sectionHeading } from "./panel.ts";
import { deriveStage, verificationStatusLabel } from "./vocabulary.ts";

/** Width of the label column in the `/aies-status` overview. */
const LABEL_WIDTH = 18;

/**
 * Autonomy stop reasons in Spanish for the human view. A reason with no entry is
 * left out rather than printed as a raw code.
 */
const STOP_LABEL: Record<string, string> = {
  completed: "completado",
  user_stopped: "detenida por el usuario",
  user_required: "necesita tu intervención",
  blocked: "bloqueada",
  verification_failed: "verificación fallida",
  verification_protocol_error: "error de protocolo en la verificación",
  repair_limit: "límite de reparaciones agotado",
  no_progress: "sin progreso",
  continuation_limit: "límite de continuaciones alcanzado",
  permission_denied: "permiso denegado",
  sandbox_unavailable: "sandbox no disponible",
  context_failure: "fallo de contexto",
  linear_conflict: "conflicto en Linear",
  linear_sync_failed: "Linear no sincronizó",
  scope_change: "cambio de alcance",
};

export interface DoneSummaryAgent {
  role: string;
  glyph: string;
  text: string;
}

/** Run token telemetry: `Tokens <total> (main X · agents Y)`. */
export interface DoneSummaryTokens {
  total: number;
  main: number;
  agents: number;
}

export interface DoneSummaryInput {
  ticket?: string;
  /** Legacy detail input kept in the durable entry; never drawn in the card. */
  changes?: string[];
  verification?: string;
  linear?: string;
  durationMs?: number;
  /** Legacy detail input kept in the durable entry; never drawn in the card. */
  commit?: string;
  /** One indented row per finished child: `<role> <glyph> <text>`. */
  agents?: DoneSummaryAgent[];
  /** Run token telemetry kept in the durable entry; never drawn in the card. */
  tokens?: DoneSummaryTokens;
  /** Run cost kept in the durable entry; never drawn in the card. */
  cost?: number | null;
  /** Real warnings to surface, each with a pointer to the full view. */
  warnings?: string[];
}

/** Rows the DONE card shows before collapsing the rest. */
const MAX_DONE_AGENT_ROWS = 4;

/** Characters of arbitrary child text allowed on one DONE row. */
const MAX_DONE_AGENT_TEXT = 60;

/** The child roles the compact DONE card treats as essential. */
const DONE_ESSENTIAL_ROLES: ReadonlySet<string> = new Set(["worker", "verify"]);

/**
 * The compact DONE projection: a headline, a bounded set of essential child
 * outcomes and the Linear result, plus real warnings. Tokens, cost and git stay
 * in the durable entry and the `/aies-status` detail surfaces instead of
 * lengthening the card, and arbitrary child text is clipped so the card can
 * never grow without limit. When the width allows, the duration rides the
 * headline; otherwise it becomes a `Tiempo` row.
 */
export function renderDoneSummary(
  input: DoneSummaryInput = {},
  options: { paint?: Paint; width?: number } = {},
): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const width =
    typeof options.width === "number" && Number.isFinite(options.width) && options.width > 0
      ? Math.floor(options.width)
      : undefined;

  const ticket = singleLine(input.ticket ?? "");
  const headline = ticket ? `✓ ${ticket} · completado` : "✓ Tarea completada";
  const duration =
    typeof input.durationMs === "number" && Number.isFinite(input.durationMs)
      ? formatDuration(input.durationMs)
      : undefined;

  const lines: string[] = [];
  let headlineLine = headline;
  let durationOnHeadline = false;
  if (duration && width !== undefined) {
    const gap = width - headline.length - duration.length;
    if (gap >= 2) {
      headlineLine = `${headline}${" ".repeat(gap)}${duration}`;
      durationOnHeadline = true;
    }
  }
  lines.push(sectionHeading(headlineLine, paint, "success"));

  // Bound arbitrary child input: essential roles first, a fixed row cap and a
  // clipped text so a verbose child summary cannot turn the card into a report.
  const agents = Array.isArray(input.agents) ? input.agents : [];
  const essential = agents.filter((agent) =>
    DONE_ESSENTIAL_ROLES.has(singleLine(agent?.role ?? "").toLowerCase()),
  );
  const considered = essential.length > 0 ? essential : agents;
  const shown = considered.slice(0, MAX_DONE_AGENT_ROWS);
  for (const agent of shown) {
    const row = [
      singleLine(agent?.role ?? ""),
      singleLine(agent?.glyph ?? ""),
      clip(singleLine(agent?.text ?? ""), MAX_DONE_AGENT_TEXT),
    ]
      .filter(Boolean)
      .join(" ");
    if (row) lines.push(`  ${row}`);
  }
  if (considered.length > shown.length) lines.push(`  … ${considered.length - shown.length} más`);

  const verification = singleLine(input.verification ?? "");
  if (verification && !agents.some((agent) => singleLine(agent?.role ?? "").toLowerCase() === "verify")) {
    lines.push(`  Verify ✓ ${clip(verification, MAX_DONE_AGENT_TEXT)}`);
  }

  const linear = singleLine(input.linear ?? "");
  if (linear) lines.push(`  Linear ✓ ${linear}`);

  const warnings = (input.warnings ?? []).map((entry) => singleLine(String(entry))).filter(Boolean);
  if (warnings.length) {
    for (const warning of warnings) lines.push(`! ${clip(warning, MAX_DONE_AGENT_TEXT)}`);
    lines.push("  /aies-status detalle");
  }

  if (duration && !durationOnHeadline) lines.push(`  Tiempo ${duration}`);
  return lines;
}

export interface BlockedSummaryInput {
  ticket?: string;
  happened: string;
  needs?: string;
  done?: string[];
  pending?: string;
  verification?: string;
}

function normalizeVerification(value: string | undefined): string | undefined {
  const raw = singleLine(value ?? "");
  if (!raw) return undefined;
  switch (raw.toUpperCase()) {
    case "V:PASS":
    case "PASS":
      return "V:PASS";
    case "V:FAIL":
    case "FAIL":
      return "V:FAIL";
    case "V:BLOCKED":
    case "BLOCKED":
      return "V:BLOCKED";
    case "V:ERROR":
    case "ERROR":
    case "PROTOCOL_ERROR":
      return "V:ERROR";
    default:
      return raw;
  }
}

/** BLOCKED card: what happened, what is already done, and what the human must decide. */
export function renderBlockedSummary(input: BlockedSummaryInput, options: { paint?: Paint } = {}): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const ticket = singleLine(input.ticket ?? "");
  const blocks: string[] = [sectionHeading(ticket ? `! ${ticket} bloqueado` : "! Bloqueado", paint, "error")];

  const happened = singleLine(input.happened ?? "");
  if (happened) blocks.push(happened);

  const needs = singleLine(input.needs ?? "");
  if (needs) blocks.push([sectionHeading("Necesita", paint, "muted"), `  ${needs}`].join("\n"));

  const done = (input.done ?? []).map((item) => singleLine(String(item))).filter(Boolean);
  const pending = singleLine(input.pending ?? "");
  const estado: string[] = [...done.map((item) => `  ${item}`)];
  if (pending) estado.push(`  ${pending}`);
  if (estado.length) blocks.push([sectionHeading("Estado", paint, "muted"), ...estado].join("\n"));

  const verification = normalizeVerification(input.verification);
  if (verification) {
    const color: SemanticColor = verification === "V:PASS" ? "success" : verification === "V:STALE" ? "warning" : "error";
    blocks.push(paint.fg(color, verification));
  }

  return blocks.join("\n\n").split("\n");
}

function zoneLabel(zone: string | undefined): string {
  switch (zone) {
    case "green":
      return "verde";
    case "amber":
      return "ámbar";
    case "pressure":
      return "presión";
    case "compact":
      return "compactando";
    case "ceiling":
      return "límite";
    case undefined:
      return "";
    default:
      return zone;
  }
}

/**
 * The `/aies-run status` view. Scope-specific on purpose: this command is about
 * autonomy, so it reports autonomy and the ticket and points at the session view
 * instead of duplicating it. It never prints a row it cannot fill.
 */
export function renderAutonomyStatus(snapshot: AiesSnapshot, options: { paint?: Paint } = {}): string {
  const paint = options.paint ?? PLAIN_PAINT;
  const row = (label: string, value: string) => `  ${label.padEnd(LABEL_WIDTH)}${value}`;
  const sections: string[][] = [[sectionHeading("AIES · autonomía", paint, "accent")]];

  const ticket = snapshot.ticket;
  if (ticket?.active && ticket.identifier) {
    const value = ticket.status ? `${ticket.identifier} · ${ticket.status}` : ticket.identifier;
    sections.push([sectionHeading("Ticket", paint, "muted"), row("", value)]);
  }

  const autonomy = snapshot.autonomy;
  const stage = deriveStage(snapshot);
  const runRows = [
    row("etapa", autonomy?.enabled ? `${stage} · activa` : `${stage} · pausada`),
  ];
  if (autonomy) {
    runRows.push(row("continuaciones", String(autonomy.continuationCount)));
    if (autonomy.lastStep) runRows.push(row("último paso", autonomy.lastStep));
    const stopped = autonomy.stopReason ? STOP_LABEL[autonomy.stopReason] : undefined;
    if (!autonomy.enabled && stopped) runRows.push(row("parada", stopped));
  }
  sections.push([sectionHeading("Ejecución", paint, "muted"), ...runRows]);

  sections.push([paint.fg("dim", "Estado completo: /aies-status")]);
  return sections.map((section) => section.join("\n")).join("\n\n");
}

/** `completed · 00:31 · 12k`: the role's facts in one grouped value. */
function agentSummary(record: AgentRecord, now: number): string {
  const parts: string[] = [singleLine(record.status)];
  if (typeof record.startedAt === "number") {
    const end = typeof record.finishedAt === "number" ? record.finishedAt : now;
    parts.push(formatDuration(Math.max(0, end - record.startedAt)));
  }
  if (typeof record.totalTokens === "number" && record.totalTokens > 0) parts.push(formatTokens(record.totalTokens));
  return parts.join(" · ");
}

/** The `/aies-status` human view: grouped by concept, zeros omitted, under ~34 lines. */
export function renderStatusOverview(snapshot: AgentsSnapshot, now: number, options: { paint?: Paint } = {}): string {
  const paint = options.paint ?? PLAIN_PAINT;
  const row = (label: string, value: string) => `  ${label.padEnd(LABEL_WIDTH)}${value}`;
  const sections: string[][] = [[sectionHeading("AIES", paint, "accent")]];

  const ticket = snapshot.ticket;
  if (ticket?.active && ticket.identifier) {
    const rows = [row("id", ticket.identifier)];
    if (ticket.status) rows.push(row("situación", ticket.status));
    if (ticket.title) rows.push(row("título", ticket.title));
    sections.push([sectionHeading("Ticket", paint, "muted"), ...rows]);
  }

  // Ejecución is always worth a row: the stage is the headline answer to "what is
  // it doing?". The model and the clock fold in here so the view stays grouped.
  const stage = deriveStage(snapshot);
  const autonomy = snapshot.autonomy;
  const run = snapshot.runUsage;
  const runRows = [row("etapa", autonomy?.enabled ? `${stage} · autonomía activa` : stage)];
  if (autonomy) {
    runRows.push(row("continuaciones", String(autonomy.continuationCount)));
    const stopped = autonomy.stopReason ? STOP_LABEL[autonomy.stopReason] : undefined;
    if (!autonomy.enabled && stopped) runRows.push(row("parada", stopped));
  }
  const model = snapshot.model;
  if (model?.label) {
    const label = singleLine(model.label);
    runRows.push(row("modelo", model.provider ? `${label} · ${singleLine(model.provider)}` : label));
  }
  const clock = [formatDuration(Math.max(0, now - snapshot.startedAt))];
  if (run?.active && typeof run.startedAt === "number") clock.push(`run ${formatDuration(Math.max(0, now - run.startedAt))}`);
  runRows.push(row("tiempo", clock.join(" · ")));
  sections.push([sectionHeading("Ejecución", paint, "muted"), ...runRows]);

  const verification = snapshot.verification;
  if (verification && (verification.status !== "none" || verification.attempts > 0 || verification.repairs > 0 || verification.awaiting)) {
    sections.push([
      sectionHeading("Verificación", paint, "muted"),
      row("estado", verification.status === "none" ? "pendiente" : verificationStatusLabel(verification.status)),
      row("intentos", String(verification.attempts)),
      row("reparaciones", `${verification.repairs} / ${verification.maxRepairs}`),
    ]);
  }

  const window = snapshot.contextWindow ? ` / ${formatTokens(snapshot.contextWindow)}` : "";
  const zone = snapshot.contextWindow ? zoneLabel(snapshot.contextGovernor?.zone) : "";
  const contextRows = [
    row("actual", `${formatTokens(snapshot.contextTokens)}${window}${zone ? ` · ${zone}` : ""}`),
    row("pico", formatTokens(snapshot.peakContextTokens)),
    row("compactaciones", String(snapshot.compactionCount)),
  ];
  sections.push([sectionHeading("Contexto", paint, "muted"), ...contextRows]);

  // Usage: tokens and cost grouped together, zero rows omitted, an unknown cost
  // rendered as an em dash rather than a zero.
  const usageRows: string[] = [];
  if (run && run.total.totalTokens > 0) {
    usageRows.push(
      row(
        "Tokens",
        `Main ${formatTokens(run.main.totalTokens)} · Agents ${formatTokens(run.agents.totalTokens)} · Total ${formatTokens(run.total.totalTokens)}`,
      ),
    );
  }
  if (run && (run.main.cost !== null || run.total.cost !== null)) {
    usageRows.push(
      row(
        "Coste",
        `Main ${formatCost(run.main.cost)} · Agents ${formatCost(run.agents.cost)} · Total ${formatCost(run.total.cost)}`,
      ),
    );
  }
  if (usageRows.length) sections.push([sectionHeading("Uso", paint, "muted"), ...usageRows]);

  const records = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  const delegations = snapshot.delegations;
  if (records.length) {
    sections.push([sectionHeading("Agentes", paint, "muted"), ...records.map((record) => row(singleLine(record.role), agentSummary(record, now)))]);
  } else if (delegations && delegations.total > 0) {
    const rows: string[] = [];
    const active = delegations.activeRole;
    for (const role of ["explore", "worker", "verify"]) {
      const count = delegations.byRole?.[role] ?? 0;
      if (active === role) rows.push(row(role, "activo"));
      else if (count > 0) rows.push(row(role, "terminado"));
    }
    if (active && !["explore", "worker", "verify"].includes(active)) rows.push(row(active, "activo"));
    if (rows.length) sections.push([sectionHeading("Agentes", paint, "muted"), ...rows]);
  }

  const permissions = snapshot.permissions;
  if (permissions) {
    const rows = [row("sandbox", permissions.sandbox)];
    if (permissions.denials > 0) rows.push(row("denegaciones", String(permissions.denials)));
    if (permissions.approvals > 0) rows.push(row("aprobaciones", String(permissions.approvals)));
    sections.push([sectionHeading("Permisos", paint, "muted"), ...rows]);
  }

  return sections.map((section) => section.join("\n")).join("\n\n");
}
