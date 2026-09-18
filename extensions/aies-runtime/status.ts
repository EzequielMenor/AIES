/**
 * Rendering of the AIES-002 state.
 *
 * Pure presentation: it turns a snapshot into the strings a human sees and
 * decides nothing. User-facing labels are in Spanish, technical keys stay in
 * English. All business logic lives in `state.ts`; this module only reads it.
 */

import type { AiesSnapshot } from "./state.ts";

/** Below this, token counts are verbatim; above, rounded to thousands (`34k`). */
const TOKEN_ROUNDING_THRESHOLD = 10_000;

const THOUSAND = 1000;

/** Width of the label column in the status report. */
const LABEL_WIDTH = 18;

/** How many tools to list under "most used". */
const TOP_TOOLS = 5;

/** Token count as Pi reported it, or `?` when it is not known yet. */
export function formatTokens(value: number | null | undefined): string {
  const tokens = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  if (tokens === null) return "?";
  if (tokens < TOKEN_ROUNDING_THRESHOLD) return `${tokens}`;
  const thousands = Math.round(tokens / THOUSAND);
  if (thousands < THOUSAND) return `${thousands}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}

/** Duration as `mm:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(milliseconds) ? milliseconds : 0) / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

function group(value: number): string {
  return value.toLocaleString("en-US");
}

function topTools(callsByName: Record<string, number>, limit: number): string {
  const entries = Object.entries(callsByName).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!entries.length) return "-";
  return entries.slice(0, limit).map(([name, count]) => `${name} ${count}`).join(" · ");
}

/**
 * The peak, annotated when it belongs to a different context window than the one
 * in force now. Without the annotation a peak inherited from a bigger model
 * reads as headroom that does not exist.
 */
function peakLabel(snapshot: AiesSnapshot): string {
  const peak = formatTokens(snapshot.peakContextTokens);
  const ownedWindow = snapshot.peakContextWindow && snapshot.peakContextWindow !== snapshot.contextWindow;
  return ownedWindow ? `${peak} (ventana ${formatTokens(snapshot.peakContextWindow)})` : peak;
}

/**
 * The verification segment of the footer, or nothing when this session never
 * verified anything. `V:?` means a verification run is in flight, `V:STALE`
 * means its PASS no longer describes the artifact.
 */
function verificationSegment(snapshot: AiesSnapshot): string | undefined {
  const verification = snapshot.verification;
  if (!verification) return undefined;
  if (snapshot.delegations?.activeRole === "verify") return "V:?";

  switch (verification.status) {
    case "pass":
      return verification.valid ? "V:PASS" : "V:STALE";
    case "fail":
      return "V:FAIL";
    case "blocked":
      return "V:BLOCKED";
    default:
      return verification.attempts > 0 ? "V:none" : undefined;
  }
}

/**
 * The footer line: `AIES · ctx 34k/peak 41k · tools 8 · files 4 · V:PASS · 02:14`.
 *
 * One line, no panel. An in-flight verification names itself (`VERIFY`) and the
 * segments that have nothing to report stay out: compaction only appears once
 * there is one, and verification only once this session verified something.
 */
export function renderFooter(snapshot: AiesSnapshot, now: number): string {
  const parts = ["AIES"];
  if (snapshot.ticket?.active && snapshot.ticket.identifier) parts.push(snapshot.ticket.identifier);
  if (snapshot.delegations?.activeRole === "verify") parts.push("VERIFY");
  if (snapshot.contextGovernor?.compacting) parts.push("compactando");

  const isPressure =
    snapshot.contextGovernor?.zone === "pressure" ||
    snapshot.contextGovernor?.zone === "compact" ||
    snapshot.contextGovernor?.zone === "ceiling";

  const ctxText = isPressure
    ? `ctx ${formatTokens(snapshot.contextTokens)}!`
    : `ctx ${formatTokens(snapshot.contextTokens)}`;

  parts.push(
    `${ctxText}/peak ${formatTokens(snapshot.peakContextTokens)}`,
    `tools ${snapshot.toolCalls}`,
    `files ${snapshot.filesInspected.length}`,
  );
  if (snapshot.compactionCount > 0) parts.push(`cmp ${snapshot.compactionCount}`);

  const verification = verificationSegment(snapshot);
  if (verification) parts.push(verification);

  if (snapshot.delegations?.activeRole && snapshot.delegations.activeRole !== "verify") {
    parts.push(`delegando ${snapshot.delegations.activeRole}`);
  }
  if (snapshot.permissions && snapshot.permissions.sandbox !== "active") {
    parts.push("SANDBOX OFF");
  }
  parts.push(formatDuration(now - snapshot.startedAt));
  return parts.join(" · ");
}

/** The `/aies-status` report: the same numbers, unfolded for a human. */
export function renderStatusReport(snapshot: AiesSnapshot, now: number): string {
  const row = (label: string, value: string) => `  ${label.padEnd(LABEL_WIDTH)}${value}`;
  const section = (title: string, rows: string[]) => [`${title}:`, ...rows, ""];

  const percent = typeof snapshot.usagePercent === "number" ? ` (${snapshot.usagePercent.toFixed(1)}%)` : "";
  const window = snapshot.contextWindow ? ` / ${formatTokens(snapshot.contextWindow)}` : "";
  const model = snapshot.model ? `${snapshot.model.id} (${snapshot.model.provider})` : "-";

  return [
    "AIES — estado de la sesión",
    "",
    ...section("Contexto", [
      row("actual", `${formatTokens(snapshot.contextTokens)}${window}${percent}`),
      row("peak", peakLabel(snapshot)),
      row("compactions", String(snapshot.compactionCount)),
    ]),
    ...(snapshot.contextGovernor
      ? section("Context governor", [
          row("zone", snapshot.contextGovernor.zone),
          row("current", formatTokens(snapshot.contextGovernor.currentTokens)),
          row("compact at", formatTokens(snapshot.contextGovernor.compactAtTokens)),
          row("ceiling", formatTokens(snapshot.contextGovernor.ceilingTokens)),
          row("pending", snapshot.contextGovernor.compactPending ? "yes" : "no"),
          row("compacting", snapshot.contextGovernor.compacting ? "yes" : "no"),
          row("compactions", String(snapshot.contextGovernor.compactionCount)),
          row("oversized", String(snapshot.contextGovernor.oversizedResults)),
        ])
      : []),
    ...section("Padre", [
      row("tool calls", String(snapshot.toolCalls)),
      row("reads", String(snapshot.sourceReads)),
      row("búsquedas", String(snapshot.searchCalls)),
      row("shell inspección", String(snapshot.shellInspections)),
      row("archivos", String(snapshot.filesInspected.length)),
      row("más usadas", topTools(snapshot.toolCallsByName, TOP_TOOLS)),
    ]),
    ...(snapshot.delegations && snapshot.delegations.total > 0
      ? section("Delegaciones", [
          row("total", String(snapshot.delegations.total)),
          ...Object.entries(snapshot.delegations.byRole).map(([r, c]) => row(`  ${r}`, String(c))),
          row("activa", snapshot.delegations.activeRole ?? "-"),
          row("último resultado", snapshot.delegations.lastOutcome ?? "-"),
          ...(typeof snapshot.delegations.lastDurationMs === "number"
            ? [row("última duración", formatDuration(snapshot.delegations.lastDurationMs))]
            : []),
        ])
      : []),
    ...(snapshot.verification && (snapshot.verification.attempts > 0 || snapshot.verification.status !== "none")
      ? section("Verificación", [
          row("estado", snapshot.verification.status.toUpperCase()),
          row("válido", snapshot.verification.valid ? "sí" : "no"),
          row("intentos", String(snapshot.verification.attempts)),
          row("repairs", `${snapshot.verification.repairs} / ${snapshot.verification.maxRepairs}`),
          row("pendiente", snapshot.verification.awaiting ? "sí" : "no"),
          row(
            "última duración",
            typeof snapshot.verification.lastDurationMs === "number"
              ? formatDuration(snapshot.verification.lastDurationMs)
              : "-",
          ),
          row("cambios tras PASS", String(snapshot.verification.mutationsSincePass)),
        ])
      : []),
    ...(snapshot.ticket && snapshot.ticket.active && snapshot.ticket.identifier
      ? section("Ticket", [
          row("identifier", snapshot.ticket.identifier),
          row("title", snapshot.ticket.title ? (snapshot.ticket.title.length > 35 ? `${snapshot.ticket.title.slice(0, 32)}...` : snapshot.ticket.title) : "-"),
          row("status", snapshot.ticket.status ?? "-"),
          row("work", snapshot.ticket.workState ?? "-"),
          row("verify", snapshot.ticket.validVerify ? "PASS (valid)" : (snapshot.verification?.status?.toUpperCase() ?? "NONE")),
        ])
      : []),
    ...(snapshot.permissions
      ? section("Permisos", [
          row("sandbox", snapshot.permissions.sandbox),
          row("worker", snapshot.permissions.worker),
          row("verify", snapshot.permissions.verify),
          row("network", snapshot.permissions.network),
          row("denegaciones", String(snapshot.permissions.denials)),
          row("aprobaciones", String(snapshot.permissions.approvals)),
          row("fallos sandbox", String(snapshot.permissions.sandboxFailures)),
        ])
      : []),
    ...section("Resultados de tools", [
      row("devueltos", String(snapshot.toolResults)),
      row("con error", String(snapshot.toolErrors)),
      row("caracteres", group(snapshot.outputChars)),
      row("mayor", `${group(snapshot.largestOutputChars)} chars`),
    ]),
    ...section("Runtime", [
      row("modelo", model),
      row("activa", formatDuration(now - snapshot.startedAt)),
      ...(typeof snapshot.resumedAt === "number"
        ? [row("esta ejecución", formatDuration(now - snapshot.resumedAt))]
        : []),
      row("tools activas", String(snapshot.activeToolCount)),
      row("stop reason", snapshot.stopReason ?? "-"),
      row("sesión", snapshot.sessionId ?? "-"),
    ]),
    "Mide, no gobierna: ninguna métrica cambia el comportamiento.",
  ].join("\n");
}
