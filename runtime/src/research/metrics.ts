// src/research/metrics.ts — runner mínimo de handoff a 06-research (plan step 10).
// Lee un log.jsonl (dataset de observabilidad, ADR-008) y emite métricas por dimensión NFR §3,
// mapeadas a H-01…H-06. NO asevera hipótesis verdaderas (P-19): produce datos para calibrar.
// coste/tokens incluyen orquestador (decisiones con telemetría) + workers (resultados).
// Uso: node dist/research/metrics.js <path/a/log.jsonl>

import * as fs from "node:fs";
import type { LogEntry, DecisionLogEntry, ResultLogEntry } from "../observability.js";

function isDecision(e: LogEntry): e is DecisionLogEntry {
	return e.type === "decision";
}
function isResult(e: LogEntry): e is ResultLogEntry {
	return e.type === "resultado";
}

function asNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readLog(file: string): LogEntry[] {
	if (!fs.existsSync(file)) throw new Error(`log no encontrado: ${file}`);
	const out: LogEntry[] = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line) as LogEntry);
		} catch {
			/* línea corrupta: saltar */
		}
	}
	return out;
}

function diffMs(a?: string, b?: string): number | null {
	if (!a || !b) return null;
	const t = Date.parse(b) - Date.parse(a);
	return Number.isFinite(t) ? t : null;
}

export interface MetricsReport {
	fuente: string;
	entradas: number;
	dimensiones: {
		tiempo: { total_ms: number | null; por_iter_ms: (number | null)[] };
		coste: { total: number; orquestador: number; por_unidad: Record<string, number> };
		contexto: { tokens_total: number; orquestador_tokens: number; workers_tokens: number; pct_min: number | null; pct_max: number | null; window: number | null };
		calidad: { verify_pass: number; verify_fail: number; terminado: boolean; condicion: string | null };
		observabilidad: { decisiones: number; resultados: number; compactions: number; parseFail: number; limites: number };
		fiabilidad: { fallos: number; parse_errors: number };
	};
	hipotesis: Record<string, string>;
}

export function computeMetrics(file: string, entries?: LogEntry[]): MetricsReport {
	const log = entries ?? readLog(file);
	const decisions = log.filter(isDecision);
	const results = log.filter(isResult);
	// Las entradas `compaction` no son vueltas del bucle: fuera de iteraciones, contadas aparte.
	const compactions = log.filter((e) => e.type === "compaction").length;
	// Turno i del bucle = decision@i → resultado@(i+1). core/loop.ts:126-127 incrementa
	// state.iterations ANTES de emitir resultEntry(iterations, …), así que el resultado del turno i
	// aparece con iter=i+1 en el log. Emparejamos decisión con resultado cuyo iter = decision.iter+1;
	// quedan fuera la última decisión (sin resultado posterior) e iter=huérfanos sin par.
	const iters = [...new Set(decisions.map((d) => d.iter))]
		.filter((i) => results.some((r) => r.iter === i + 1))
		.sort((a, b) => a - b);

	// Tiempo: total (primera→última ts) y por iter (decisión→resultado).
	let firstTs: string | undefined;
	let lastTs: string | undefined;
	for (const e of log) {
		if (typeof (e as { ts?: string }).ts === "string") {
			const ts = (e as { ts?: string }).ts!;
			if (!firstTs) firstTs = ts;
			lastTs = ts;
		}
	}
	const porIter = iters.map((i) => {
		// Para iter=i, puede haber varias decisiones (e.g. parse fails consecutivos del orquestador
		// reintentando antes de una decisión válida). Tomamos la ÚLTIMA decisión con ts válido
		// inmediatamente anterior al resultado: es la que precede al resultado del mismo turno.
		const r = results.find((x) => x.iter === i + 1);
		if (!r?.ts) return null;
		const d = [...decisions].reverse().find((x) => x.iter === i && typeof x.ts === "string" && Date.parse(x.ts) <= Date.parse(r.ts!));
		return diffMs(d?.ts, r.ts);
	});

	// Coste (RNF-17): acumulado por worker (resultados) + orquestador (decisiones con telemetría)
	// desde el cierre de la telemetría del orquestador, y desglosado por unidad (unidadId del resultado).
	let costTotal = 0;
	let costOrquestador = 0;
	const porUnidad: Record<string, number> = {};
	for (const r of results) {
		const c = r.usage ? asNumber(r.usage.cost) : 0;
		costTotal += c;
		// E-01A: si la entrada viene de la sesión local (atribución experimental), su coste
		// cuenta como orquestador, NO como worker (no va a por_unidad).
		if (r.atribución === "orquestador") {
			costOrquestador += c;
		} else if (r.unidadId) {
			porUnidad[r.unidadId] = (porUnidad[r.unidadId] ?? 0) + c;
		}
	}
	for (const d of decisions) {
		const c = d.usage ? asNumber(d.usage.cost) : 0;
		costTotal += c;
		costOrquestador += c;
	}

	// Contexto/tokens (RNF-07): total = workers + orquestador; desglose orquestador/workers
	// (E-01, réplicas N≥3: dónde está el coste de contexto). pct min/max sobre el que dispone de contextUsage.
	let tokens = 0;
	let orquestadorTokens = 0;
	let workersTokens = 0;
	let pctMin: number | null = null;
	let pctMax: number | null = null;
	let window: number | null = null;
	for (const e of log) {
		if (e.type !== "resultado" && e.type !== "decision") continue;
		const t = e.usage ? asNumber(e.usage.tokens.total) : 0;
		tokens += t;
		// E-01A: resultado con atribución="orquestador" suma al orquestador (sesión local
		// experimental); resultado sin marca suma a workers (modo normal).
		if (e.type === "decision") orquestadorTokens += t;
		else if (e.type === "resultado" && e.atribución === "orquestador") orquestadorTokens += t;
		else workersTokens += t;
		if (e.contextUsage) {
			const p = e.contextUsage.percent;
			if (p !== null) {
				pctMin = pctMin === null ? p : Math.min(pctMin, p);
				pctMax = pctMax === null ? p : Math.max(pctMax, p);
			}
			if (e.contextUsage.contextWindow) window = e.contextUsage.contextWindow;
		}
	}

	// Calidad (RNF-15): veredictos del Verifier + terminación. Regex unificado con workers/index.ts
	// (tolerante a `VEREDICTO:` / `VEREDICTO ` / `veredicto:` / `veredicto `) para que
	// `state.results[].passed === true` ⇔ `metrics.calidad.verify_pass += 1` no diverjan.
	const VERED_RE = /(?:VEREDICTO\s*:?\s*|veredicto\s+)(PASS|FAIL)\b/i;
	const verifyPass = results.filter((r) => {
		const m = r.resultado.match(VERED_RE);
		return !!m && m[1]!.toUpperCase() === "PASS";
	}).length;
	const verifyFail = results.filter((r) => {
		const m = r.resultado.match(VERED_RE);
		return !!m && m[1]!.toUpperCase() === "FAIL";
	}).length;
	const termDec = decisions.find((d) => d.operación === "terminar");
	const terminado = !!termDec;

	// Observabilidad / Fiabilidad / Límites
	const parseFail = decisions.filter((d) => d.parseFail).length;
	const limites = results.filter((r) => r.límite_alcanzado !== null).length;
	const fallos = results.filter((r) => r.kind === "fallo").length;
	const parseErrors = results.filter((r) => r.kind === "parse_error").length;

	return {
		fuente: file,
		entradas: log.length,
		dimensiones: {
			tiempo: { total_ms: diffMs(firstTs, lastTs), por_iter_ms: porIter },
			coste: { total: costTotal, orquestador: costOrquestador, por_unidad: porUnidad },
			contexto: { tokens_total: tokens, orquestador_tokens: orquestadorTokens, workers_tokens: workersTokens, pct_min: pctMin, pct_max: pctMax, window },
			calidad: { verify_pass: verifyPass, verify_fail: verifyFail, terminado, condicion: termDec?.condición ?? null },
			observabilidad: { decisiones: decisions.length, resultados: results.length, compactions, parseFail, limites },
			fiabilidad: { fallos, parse_errors: parseErrors },
		},
		hipotesis: {
			"H-01": "contexto: comparar tokens_total (orquestador+workers, telemetría cerrada) contra baseline agente-único a paridad — datos listos, baseline en E-01.",
			"H-02": "coste/tiempo vs complejidad: correlaciona coste.total (incluye orquestador) + tiempo.total con nº de unidades/iter — datos listos.",
			"H-03": "calidad: verify_pass/verify_fail + terminado; comparar contra baselines — datos AIES listos.",
			"H-04": "especialización: desglose por unidad (coste.por_unidad) + veredictos — datos limitados (la capacidad va en la decisión, aparear por iter).",
			"H-05": "persistencia: NO medible desde un único log (requiere experimento con/sin state.json restore).",
			"H-06": "modelos económicos: comparar coste.total ahora con orquestador incluido; NO decidible solo desde el log (requiere config por rol + baseline).",
		},
	};
}

function main(): void {
	const file = process.argv[2];
	if (!file) {
		console.error("Uso: node dist/research/metrics.js <path/a/log.jsonl>");
		process.exit(2);
	}
	const report = computeMetrics(file);
	console.log(JSON.stringify(report, null, 2));
}

main();