/**
 * Rendering of the AIES-002 state.
 *
 * Pure presentation: it turns a snapshot into the strings a human sees and
 * decides nothing. User-facing labels are in Spanish, technical keys stay in
 * English. All business logic lives in `state.ts`; this module only reads it.
 */

import type { AiesSnapshot } from "./state.ts";
import { formatDuration, formatTokens } from "../aies-ui/format.ts";
import { renderFooter } from "../aies-ui/footer.ts";

// One implementation each: the formatters and the footer live in `aies-ui` and are
// re-exported here so existing callers and tests keep importing from this module.
export { formatDuration, formatTokens, renderFooter };

/** Width of the label column in the status report. */
const LABEL_WIDTH = 18;

/** How many tools to list under "most used". */
const TOP_TOOLS = 5;

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
    ...(snapshot.autonomy
      ? section("Autonomía", [
          row("activa", snapshot.autonomy.enabled ? "sí" : "no"),
          row("ticket", snapshot.autonomy.ticketId ?? "-"),
          row("continuaciones", String(snapshot.autonomy.continuationCount)),
          row("último paso", snapshot.autonomy.lastStep ?? "-"),
          row("stop reason", snapshot.autonomy.stopReason ?? "-"),
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
