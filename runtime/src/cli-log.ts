// src/cli-log.ts — `/log`: tail legible de .aies/log.jsonl (decisión/resultado/compaction).
//
// RNF-11: lee el artefacto persistido tal cual — sin reejecutar el bucle ni invocar
// decide/workers. Mismo espíritu que /status (cli-status.ts), pero con dos diferencias:
//   1) es un TAIL, no el historial completo — por defecto las últimas DEFAULT_LOG_TAIL
//      entradas, para no inundar la terminal en una sesión larga.
//   2) interlínea también las entradas de compaction, que /status sólo cuenta de forma
//      agregada (nunca las muestra una a una).
//
// Reutiliza pairTurns()/describeOperación()/describeResultKind() de cli-status.ts en vez
// de reimplementar el emparejamiento decisión↔resultado — la misma vuelta debe leerse
// igual en /status y en /log.

import type { LogEntry } from "./observability.js";
import { describeOperación, describeResultKind, pairTurns, type IndexedLogEntry } from "./cli-status.js";
import { formatCost, formatTokens } from "./ui/stream-renderer.js";

export const DEFAULT_LOG_TAIL = 20;

type LogLine = { line: number; text: string };

/** Recorta a `n` caracteres con "…" — para no dejar que un texto largo de comunicación desborde la línea. */
function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function formatTurnLine(t: ReturnType<typeof pairTurns>[number]): LogLine {
	const opLabel = describeOperación(t.decision.operación);
	const unitSuffix = t.decision.unidad
		? ` (${t.decision.unidad}${t.decision.capacidad ? `, ${t.decision.capacidad}` : ""})`
		: "";
	// comunicación: lo que importa es EL TEXTO, no sus tokens — mostrar tokens/coste ahí
	// escondería el único contenido legible que tiene esta entrada.
	if (t.result.kind === "comunicación") {
		return {
			line: t.resultLine,
			text: `  iter ${t.iter}  ${opLabel}${unitSuffix} → 💬 "${truncate(t.result.resultado, 70)}"`,
		};
	}
	const resultLabel = describeResultKind(t.result.kind);
	const tokens = t.result.usage ? `${formatTokens(t.result.usage.tokens.total)} tok` : "n/d";
	const cost = t.result.usage ? formatCost(t.result.usage.cost) : "n/d";
	return {
		line: t.resultLine,
		text: `  iter ${t.iter}  ${opLabel}${unitSuffix} → ${resultLabel} · ${tokens} · ${cost}`,
	};
}

function formatCompactionLine(indexed: IndexedLogEntry, entry: Extract<LogEntry, { type: "compaction" }>): LogLine {
	const summary = entry.summary ? ` — ${truncate(entry.summary, 60)}` : "";
	const outcome = entry.aborted ? " (abortada)" : entry.willRetry ? " (reintentará)" : "";
	return { line: indexed.line, text: `  compaction ${entry.fase} · ${entry.reason}${outcome}${summary}` };
}

/**
 * Tail legible de log.jsonl: vueltas emparejadas (decisión+resultado) y eventos de
 * compaction, en orden de aparición física, recortado a las últimas `limit` entradas
 * (o todas, con `limit: null` — "/log all").
 */
export function formatLogTail(log: IndexedLogEntry[], limit: number | null = DEFAULT_LOG_TAIL): string {
	if (log.length === 0) return "  (sin entradas en .aies/log.jsonl)";

	const compactions = log.filter((x): x is IndexedLogEntry & { entry: Extract<LogEntry, { type: "compaction" }> } => x.entry.type === "compaction");
	const turns = pairTurns(log);

	const lines: LogLine[] = [
		...turns.map(formatTurnLine),
		...compactions.map((c) => formatCompactionLine(c, c.entry)),
	].sort((a, b) => a.line - b.line);

	if (lines.length === 0) return "  (sin vueltas legibles todavía — ver /status para el estado crudo)";

	const shown = limit === null ? lines : lines.slice(-limit);
	const header =
		limit === null || shown.length === lines.length
			? `Log (${lines.length} entradas):`
			: `Log (últimas ${shown.length} de ${lines.length} — "/log all" para el historial completo):`;

	return [header, ...shown.map((l) => l.text)].join("\n");
}

/** Parsea el argumento de /log: "" → tail por defecto, "all" → todo, "<n>" → tail de n. Inválido → tail por defecto. */
export function parseLogArg(arg: string): number | null {
	const trimmed = arg.trim();
	if (!trimmed) return DEFAULT_LOG_TAIL;
	if (trimmed === "all") return null;
	const n = Number(trimmed);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_LOG_TAIL;
}
