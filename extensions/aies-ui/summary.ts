/**
 * The two work-unit summaries (DONE, BLOCKED) and the human `/aies-status` view.
 *
 * Presentation only: a section with no value is omitted, never labelled with a
 * placeholder. Rows in the overview keep the `  <label><value>` layout so the
 * same reader works in tests and in the terminal.
 */

import type { AiesSnapshot } from "../aies-runtime/state.ts";
import { formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
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

export interface DoneSummaryInput {
  ticket?: string;
  changes?: string[];
  verification?: string;
  linear?: string;
  durationMs?: number;
  commit?: string;
}

/** DONE card: what changed, how it was verified, and where it landed. */
export function renderDoneSummary(input: DoneSummaryInput = {}, options: { paint?: Paint } = {}): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const ticket = singleLine(input.ticket ?? "");
  const blocks: string[] = [paint.fg("success", ticket ? `✓ ${ticket} completado` : "✓ Tarea completada")];

  const changes = (input.changes ?? []).map((change) => singleLine(String(change))).filter(Boolean);
  if (changes.length) {
    blocks.push([paint.fg("muted", "Cambios"), ...changes.map((change) => `  ${change}`)].join("\n"));
  }

  const verification = singleLine(input.verification ?? "");
  if (verification) blocks.push([paint.fg("muted", "Verificación"), `  ${verification}`].join("\n"));

  const linear = singleLine(input.linear ?? "");
  if (linear) blocks.push([paint.fg("muted", "Linear"), `  ${linear}`].join("\n"));

  const commit = singleLine(input.commit ?? "");
  if (commit) blocks.push([paint.fg("muted", "Git"), `  ${commit}`].join("\n"));

  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs)) {
    blocks.push([paint.fg("muted", "Tiempo"), `  ${formatDuration(input.durationMs)}`].join("\n"));
  }

  return blocks.join("\n\n").split("\n");
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
  const blocks: string[] = [paint.fg("error", ticket ? `! ${ticket} bloqueado` : "! Bloqueado")];

  const happened = singleLine(input.happened ?? "");
  if (happened) blocks.push(happened);

  const needs = singleLine(input.needs ?? "");
  if (needs) blocks.push([paint.fg("muted", "Necesita"), `  ${needs}`].join("\n"));

  const done = (input.done ?? []).map((item) => singleLine(String(item))).filter(Boolean);
  const pending = singleLine(input.pending ?? "");
  const estado: string[] = [...done.map((item) => `  ${item}`)];
  if (pending) estado.push(`  ${pending}`);
  if (estado.length) blocks.push([paint.fg("muted", "Estado"), ...estado].join("\n"));

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
  const sections: string[][] = [[paint.fg("text", "AIES · autonomía")]];

  const ticket = snapshot.ticket;
  if (ticket?.active && ticket.identifier) {
    const value = ticket.status ? `${ticket.identifier} · ${ticket.status}` : ticket.identifier;
    sections.push([paint.fg("muted", "Ticket"), row("", value)]);
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
  sections.push([paint.fg("muted", "Ejecución"), ...runRows]);

  sections.push([paint.fg("dim", "Estado completo: /aies-status")]);
  return sections.map((section) => section.join("\n")).join("\n\n");
}

/** The `/aies-status` human view: grouped by concept, zeros omitted, under ~30 lines. */
export function renderStatusOverview(snapshot: AiesSnapshot, now: number, options: { paint?: Paint } = {}): string {
  const paint = options.paint ?? PLAIN_PAINT;
  const row = (label: string, value: string) => `  ${label.padEnd(LABEL_WIDTH)}${value}`;
  const sections: string[][] = [["AIES"]];

  const ticket = snapshot.ticket;
  if (ticket?.active && ticket.identifier) {
    const rows = [row("id", ticket.identifier)];
    if (ticket.status) rows.push(row("situación", ticket.status));
    if (ticket.title) rows.push(row("título", ticket.title));
    sections.push([paint.fg("muted", "Ticket"), ...rows]);
  }

  // Ejecución is always worth a row: the stage is the headline answer to "what is
  // it doing?", and a stopped autonomy owes the human the reason it stopped.
  const stage = deriveStage(snapshot);
  const autonomy = snapshot.autonomy;
  const runRows = [row("etapa", autonomy?.enabled ? `${stage} · autonomía activa` : stage)];
  if (autonomy) {
    runRows.push(
      row("transcurrido", `${formatDuration(now - snapshot.startedAt)} · continuaciones ${autonomy.continuationCount}`),
    );
    const stopped = autonomy.stopReason ? STOP_LABEL[autonomy.stopReason] : undefined;
    if (!autonomy.enabled && stopped) runRows.push(row("parada", stopped));
  }
  sections.push([paint.fg("muted", "Ejecución"), ...runRows]);

  const verification = snapshot.verification;
  if (verification && (verification.status !== "none" || verification.attempts > 0 || verification.repairs > 0 || verification.awaiting)) {
    sections.push([
      paint.fg("muted", "Verificación"),
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
  sections.push([paint.fg("muted", "Contexto"), ...contextRows]);

  const delegations = snapshot.delegations;
  if (delegations && delegations.total > 0) {
    const rows: string[] = [];
    const active = delegations.activeRole;
    for (const role of ["explore", "worker", "verify"]) {
      const count = delegations.byRole?.[role] ?? 0;
      if (active === role) rows.push(row(role, "activo"));
      else if (count > 0) rows.push(row(role, "terminado"));
    }
    if (active && !["explore", "worker", "verify"].includes(active)) rows.push(row(active, "activo"));
    if (rows.length) sections.push([paint.fg("muted", "Agentes"), ...rows]);
  }

  const permissions = snapshot.permissions;
  if (permissions) {
    const rows = [row("sandbox", permissions.sandbox)];
    if (permissions.denials > 0) rows.push(row("denegaciones", String(permissions.denials)));
    if (permissions.approvals > 0) rows.push(row("aprobaciones", String(permissions.approvals)));
    sections.push([paint.fg("muted", "Permisos"), ...rows]);
  }

  return sections.map((section) => section.join("\n")).join("\n\n");
}
