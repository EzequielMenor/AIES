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

/** Width of the label column in the `/aies-status` overview. */
const LABEL_WIDTH = 18;

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

/** The `/aies-status` human view: grouped by concept, zeros omitted, under ~30 lines. */
export function renderStatusOverview(snapshot: AiesSnapshot, now: number, options: { paint?: Paint } = {}): string {
  const paint = options.paint ?? PLAIN_PAINT;
  const row = (label: string, value: string) => `  ${label.padEnd(LABEL_WIDTH)}${value}`;
  const sections: string[][] = [["AIES"]];

  const ticket = snapshot.ticket;
  if (ticket?.active && ticket.identifier) {
    const rows = [row("identifier", ticket.identifier)];
    if (ticket.status) rows.push(row("status", ticket.status));
    if (ticket.title) rows.push(row("title", ticket.title));
    sections.push([paint.fg("muted", "Ticket"), ...rows]);
  }

  if (snapshot.autonomy) {
    sections.push([
      paint.fg("muted", "Run"),
      row("autonomía", snapshot.autonomy.enabled ? "activa" : "pausada"),
      row("transcurrido", formatDuration(now - snapshot.startedAt)),
      row("continuaciones", String(snapshot.autonomy.continuationCount)),
    ]);
  }

  const verification = snapshot.verification;
  if (verification && (verification.status !== "none" || verification.attempts > 0 || verification.repairs > 0 || verification.awaiting)) {
    sections.push([
      paint.fg("muted", "Verificación"),
      row("estado", verification.status === "none" ? "pendiente" : verification.status.toUpperCase()),
      row("intentos", String(verification.attempts)),
      row("repairs", `${verification.repairs} / ${verification.maxRepairs}`),
    ]);
  }

  const window = snapshot.contextWindow ? ` / ${formatTokens(snapshot.contextWindow)}` : "";
  const zone = snapshot.contextWindow ? zoneLabel(snapshot.contextGovernor?.zone) : "";
  sections.push([
    paint.fg("muted", "Contexto"),
    row("actual", `${formatTokens(snapshot.contextTokens)}${window}${zone ? ` · ${zone}` : ""}`),
    row("peak", formatTokens(snapshot.peakContextTokens)),
    row("compactions", String(snapshot.compactionCount)),
  ]);

  const delegations = snapshot.delegations;
  if (delegations && delegations.total > 0) {
    const rows: string[] = [];
    const active = delegations.activeRole;
    for (const role of ["explore", "worker", "verify"]) {
      const count = delegations.byRole?.[role] ?? 0;
      if (active === role) rows.push(row(role, "activo"));
      else if (count > 0) rows.push(row(role, "done"));
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
