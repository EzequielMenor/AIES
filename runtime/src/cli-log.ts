// src/cli-log.ts — `/log`: tail legible de .aies/log.jsonl (decisión/resultado/compaction) +
// `/trace`: traza de tools de los workers (v0.5 Caja de cristal — Tool trace).
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

import type { LogEntry, ToolTraceLogEntry } from "./observability.js";
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

/** Analiza el argumento de `/trace`: filtro opcional por unidad. */
export function parseTraceArg(arg: string): string | null {
	const token = arg.split(/\s+/).find((t) => t && t !== "all" && !t.startsWith("--"));
	return token ?? null;
}

/**
 * Traza de tools (v0.5 Caja de cristal): inspección bajo demanda de `type: "tool"` en
 * log.jsonl. Agrupada por unidad (capability + iter), una línea por tool-execution con
 * target, resumen del resultado y ✓/✗. Filtro opcional por unidad.
 */
export function formatToolTrace(log: IndexedLogEntry[], unit: string | null = null, limit: number | null = 80): string {
	const tools = log
		.filter((x): x is IndexedLogEntry & { entry: ToolTraceLogEntry } => x.entry.type === "tool")
		.filter((x) => !unit || x.entry.unidadId === unit);
	if (tools.length === 0) {
		return unit ? `  (sin trazas de tools para la unidad "${unit}")` : "  (sin trazas de tools en .aies/log.jsonl)";
	}
	const shown = limit === null ? tools : tools.slice(-limit);
	const lines: string[] = [
		`Traza de tools (${shown.length}${shown.length < tools.length ? ` de ${tools.length}` : ""}${unit ? `, unidad ${unit}` : ""}):`,
	];
	const groups = new Map<string, ToolTraceLogEntry[]>();
	for (const { entry } of shown) {
		const key = entry.unidadId ?? "?";
		const arr = groups.get(key) ?? [];
		arr.push(entry);
		groups.set(key, arr);
	}
	for (const [unitId, entries] of groups) {
		const first = entries[0]!;
		const errors = entries.filter((e) => e.error).length;
		lines.push("");
		lines.push(`● ${unitId} · ${first.capacidad ?? "?"} · iter ${first.iter}${errors ? `  (${errors} error${errors > 1 ? "es" : ""})` : ""}`);
		for (const e of entries) {
			const mark = e.error ? "✗" : "✓";
			const target = e.target ? truncate(e.target, 56) : "";
			const mods = e.archivos_modificados.length > 0 ? `  → modifica ${e.archivos_modificados.join(", ")}` : "";
			lines.push(`  ${mark} ${e.herramienta.padEnd(14)}${target ? ` ${target.padEnd(56)}` : `${" ".repeat(57)}`}${e.resumen}${mods}`);
		}
	}
	return lines.join("\n");
}

/** Parsea el argumento de /log: "" → tail por defecto, "all" → todo, "<n>" → tail de n. Inválido → tail por defecto. */
export function parseLogArg(arg: string): number | null {
	const trimmed = arg.trim();
	if (!trimmed) return DEFAULT_LOG_TAIL;
	if (trimmed === "all") return null;
	const n = Number(trimmed);
	return Number.isInteger(n) && n > 0 ? n : DEFAULT_LOG_TAIL;
}
