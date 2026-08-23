// src/cli-status.ts — `/status`: estado del bucle + telemetría agregada del historial (log.jsonl).
//
// RNF-11: lee artefactos persistidos en `.aies/` sin reejecutar el bucle ni invocar decide/workers.
// RNF-07/17: telemetría ausente → `n/d` explícito; nunca inventar `$0` ni `0 tok`.
//
// Estructura de la salida (tres secciones separadas por líneas en blanco):
//   1) formatStateHuman(state)                 — árbol de unidades + estado del bucle
//   2) Telemetría (historial .aies/log.jsonl, N entradas): tokens/coste/contexto/verify/incidencias
//   3) Vueltas (historial):                    — huella mínima por vuelta con ref log#X–Y

import { computeMetrics } from "./research/metrics.js";
import type { LogEntry, DecisionLogEntry, ResultLogEntry } from "./observability.js";
import type { RuntimeState } from "./core/state.js";
import { formatStateHuman } from "./cli.js";
import { formatCost, formatTokens } from "./ui/stream-renderer.js";

interface IndexedLogEntry {
	line: number;
	entry: LogEntry;
}

const SIN_ESTADO_MSG = "aies: sin estado cargado todavía. Escribe una tarea para empezar.";

/** Devuelve true si alguna entrada del log lleva `usage` no nulo. */
function hasAnyUsage(log: IndexedLogEntry[]): boolean {
	for (const { entry } of log) {
		if (entry.type === "decision" || entry.type === "resultado") {
			if (entry.usage) return true;
		}
	}
	return false;
}

function isDecision(e: LogEntry): e is DecisionLogEntry {
	return e.type === "decision";
}
function isResult(e: LogEntry): e is ResultLogEntry {
	return e.type === "resultado";
}

/** Empareja decisiones y resultados usando los dos formatos que emite el bucle:
 *  operaciones normales escriben resultado en iter+1; resultados sintéticos (límite,
 *  intervención, parse-error) comparten iter con su decisión. Devuelve un array estable en
 *  orden de iter con offsets físicos de inicio y fin. */
function pairTurns(log: IndexedLogEntry[]): Array<{
	iter: number;
	decision: DecisionLogEntry;
	decisionLine: number;
	result: ResultLogEntry;
	resultLine: number;
}> {
	const decisions = log.filter(({ entry }) => isDecision(entry)).map(({ line, entry }, index) => ({ index, line, entry: entry as DecisionLogEntry }));
	const results = log.filter(({ entry }) => isResult(entry)).map(({ line, entry }) => ({ line, entry: entry as ResultLogEntry }));
	const usedDecisions = new Set<number>();
	const out: Array<{
		iter: number;
		decision: DecisionLogEntry;
		decisionLine: number;
		result: ResultLogEntry;
		resultLine: number;
	}> = [];
	for (const r of results) {
		const rTs = typeof r.entry.ts === "string" ? Date.parse(r.entry.ts) : Number.NaN;
		const canPair = (d: (typeof decisions)[number], expectedIter: number): boolean => {
			if (d.entry.iter !== expectedIter || d.line >= r.line || usedDecisions.has(d.index)) return false;
			const dTs = typeof d.entry.ts === "string" ? Date.parse(d.entry.ts) : Number.NaN;
			return !Number.isFinite(rTs) || !Number.isFinite(dTs) || dTs <= rTs;
		};
		let candidate = [...decisions].reverse().find((d) => canPair(d, r.entry.iter));
		if (!candidate) candidate = [...decisions].reverse().find((d) => canPair(d, r.entry.iter - 1));
		if (!candidate) continue;
		usedDecisions.add(candidate.index);
		out.push({
			iter: candidate.entry.iter,
			decision: candidate.entry,
			decisionLine: candidate.line,
			result: r.entry,
			resultLine: r.line,
		});
	}
	return out.sort((a, b) => a.iter - b.iter || a.decisionLine - b.decisionLine);
}

function formatTelemetrySection(report: ReturnType<typeof computeMetrics>, entries: number, telemKnown: boolean): string[] {
	const d = report.dimensiones;
	const lines: string[] = [];
	if (entries === 0) {
		lines.push("Telemetría (historial .aies/log.jsonl, 0 entradas):");
		lines.push("  sin entradas en .aies/log.jsonl");
		return lines;
	}
	lines.push(`Telemetría (historial .aies/log.jsonl, ${entries} entradas):`);
	lines.push(`  vueltas emparejadas   : ${d.tiempo.por_iter_ms.length}`);
	lines.push(`  decisiones / resultados: ${d.observabilidad.decisiones} / ${d.observabilidad.resultados}`);
	// Tokens / coste: n/d si ninguna entrada trajo usage (RNF-07/17).
	const tok = telemKnown ? `${formatTokens(d.contexto.tokens_total)} tok` : "n/d";
	const tokBreak = telemKnown ? ` (orq ${formatTokens(d.contexto.orquestador_tokens)} · workers ${formatTokens(d.contexto.workers_tokens)})` : "";
	const cost = telemKnown ? formatCost(d.coste.total) : "n/d";
	const costBreak = telemKnown ? ` (orq ${formatCost(d.coste.orquestador)})` : "";
	lines.push(`  tokens totales        : ${tok}${tokBreak}`);
	lines.push(`  coste total           : ${cost}${costBreak}`);
	const pctMax = d.contexto.pct_max;
	const win = d.contexto.window;
	if (pctMax === null || win === null) {
		lines.push(`  contexto máx          : n/d`);
	} else {
		lines.push(`  contexto máx          : ${Math.round(pctMax)}% (window ${win})`);
	}
	lines.push(`  verify                : ${d.calidad.verify_pass} PASS · ${d.calidad.verify_fail} FAIL`);
	const inc: string[] = [];
	if (d.observabilidad.parseFail > 0) inc.push(`${d.observabilidad.parseFail} parse-fail`);
	if (d.observabilidad.limites > 0) inc.push(`${d.observabilidad.limites} límites`);
	if (d.observabilidad.compactions > 0) inc.push(`${d.observabilidad.compactions} compactions`);
	if (d.fiabilidad.fallos > 0) inc.push(`${d.fiabilidad.fallos} fallos`);
	if (d.fiabilidad.parse_errors > 0) inc.push(`${d.fiabilidad.parse_errors} parse_errors`);
	lines.push(`  incidencias           : ${inc.length === 0 ? "ninguna" : inc.join(", ")}`);
	if (d.calidad.terminado) {
		lines.push(`  terminación           : sí${d.calidad.condicion ? ` (${d.calidad.condicion})` : ""}`);
	} else {
		lines.push(`  terminación           : no`);
	}
	return lines;
}

function describeOperación(op: DecisionLogEntry["operación"]): string {
	switch (op) {
		case "ejecutar una unidad":
			return "ejecutar unidad";
		case "obtener información":
			return "obtener información";
		case "comunicar al desarrollador":
			return "comunicar";
		case "terminar":
			return "terminar";
	}
}

function describeResultKind(kind: ResultLogEntry["kind"]): string {
	switch (kind) {
		case "info":
			return "info";
		case "unidad":
			return "unidad";
		case "comunicación":
			return "comunicación";
		case "terminación":
			return "terminación";
		case "fallo":
			return "fallo";
		case "límite":
			return "límite";
		case "parse_error":
			return "parse_error";
		case "intervención":
			return "intervención";
	}
}

function formatTurnsSection(turns: ReturnType<typeof pairTurns>): string[] {
	const lines: string[] = ["Vueltas (historial):"];
	if (turns.length === 0) {
		lines.push("  (sin vueltas emparejadas)");
		return lines;
	}
	for (const t of turns) {
		const opLabel = describeOperación(t.decision.operación);
		const unitSuffix = t.decision.unidad
			? ` (${t.decision.unidad}${t.decision.capacidad ? `, ${t.decision.capacidad}` : ""})`
			: "";
		const resultLabel = describeResultKind(t.result.kind);
		const tokens = t.result.usage ? `${formatTokens(t.result.usage.tokens.total)} tok` : "n/d";
		const cost = t.result.usage ? formatCost(t.result.usage.cost) : "n/d";
		lines.push(
			`  · iter ${t.iter} ${opLabel}${unitSuffix} → ${resultLabel} · ${tokens} · ${cost} · log#${t.decisionLine}–${t.resultLine}`,
		);
	}
	return lines;
}

/**
 * Renderiza el bloque `/status` con tres secciones:
 *   1) árbol de unidades (formatStateHuman reutilizado)
 *   2) telemetría agregada del historial
 *   3) huella mínima por vuelta con referencia a offsets físicos del log
 *
 * `source` se usa para la `fuente` del reporte de métricas (la firma pública de `computeMetrics`
 * lo requiere pero ya no provoca una lectura de disco cuando se dan las entradas).
 */
export function formatStatus(
	state: RuntimeState | null,
	log: IndexedLogEntry[],
	source: string = "<log.jsonl>",
): string {
	if (state === null) return SIN_ESTADO_MSG;
	const entries = log.map((x) => x.entry);
	const report = computeMetrics(source, entries);
	const telemKnown = entries.length > 0 && hasAnyUsage(log);
	const sections: string[] = [];
	sections.push(formatStateHuman(state));
	sections.push("");
	sections.push(...formatTelemetrySection(report, entries.length, telemKnown));
	sections.push("");
	sections.push(...formatTurnsSection(pairTurns(log)));
	return sections.join("\n");
}
