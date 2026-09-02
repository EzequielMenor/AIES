// src/self-check/loop.ts — verificación autocontenida del bucle (plan step 3).
// Sin framework: `node:assert`. Drives runLoop con decide/execute STUBs in-memory (no pi).
// Reproduce la traza MVP-v0-Scope §9 (canonical: plan+ejecución combinados, Decision-Model §4.2) y
// cubre C3 (tope 3 parse-fail → intervención) y ADR-005 (límite → intervención, no Fallida).

import assert from "node:assert/strict";
import { runLoop, dumpJsonl } from "../core/loop.js";
import type { AiesEventHandlers, ExecuteOutcome, WorkerEventSink } from "../core/events.js";
import type { CommunicationRequest, Decision, TerminationCondition, UnitRef } from "../core/state.js";
import { initState, type RuntimeState } from "../core/state.js";
import type { DecisionLogEntry, LogEntry } from "../observability.js";
import type { WorkerTelemetry } from "../telemetry/types.js";

const TELEM: WorkerTelemetry = {
	usage: { tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.001 },
	contextUsage: { tokens: 1500, contextWindow: 200000, percent: 0.75 },
	telemetryUnavailable: false,
};
const EMPTY_RAW = "";

function ref(id: string): UnitRef {
	return { tipo: "existente", id };
}
function term(detalle: string, desenlace: "completed" | "failed" = "completed"): TerminationCondition {
	return { desenlace, detalle };
}
function comm(pregunta: string): CommunicationRequest {
	return { pregunta, razón: "limit_extension", informaciónFaltante: "decisión del desarrollador" };
}

function dec(op: Decision["operación"], rest: Partial<Decision>): Decision {
	return {
		operación: op,
		ajustePlan: rest.ajustePlan ?? null,
		unidad: rest.unidad ?? null,
		motivo: rest.motivo ?? "motivo",
		feedbackCorrectivo: rest.feedbackCorrectivo ?? null,
		comunicación: rest.comunicación ?? null,
		condición: rest.condición ?? null,
	};
}

function capture(): { entries: LogEntry[]; handlers: Pick<AiesEventHandlers, "onLogEntry"> } {
	const entries: LogEntry[] = [];
	return { entries, handlers: { onLogEntry: (e) => entries.push(e) } };
}

async function runHappy(): Promise<void> {
	const state = initState(
		{ objetivo: "añadir greet() a src/math.ts que devuelva 'hello'", alcance: null, restricciones: null, resultadoEsperado: "greet() exportada y devuelve 'hello'", condicionFinalizacion: "greet() existe, importa y devuelve 'hello'" },
		{ maxIterations: 12, maxConsecutiveNoProgress: 3 },
	);
	const script: Decision[] = [
		dec("ejecutar una unidad", {
			ajustePlan: { tipo: "determinar el proceso", unidades: [
				{ objetivo: "explorar src/math.ts", alcance: null, infoNecesaria: null, resultadoEsperado: "estructura del archivo", condicionFinalizacion: "se conoce el archivo", capacidad: "explorer" },
				{ objetivo: "añadir greet()", alcance: null, infoNecesaria: null, resultadoEsperado: "export function greet()", condicionFinalizacion: "greet() añadida", capacidad: "implementer" },
				{ objetivo: "verificar greet()", alcance: null, infoNecesaria: null, resultadoEsperado: "tsc + runtime ok", condicionFinalizacion: "devuelve 'hello'", capacidad: "verifier" },
			] },
			unidad: ref("u0"), motivo: "tarea Recibida; determinar proceso y obtener información primero",
		}),
		dec("ejecutar una unidad", { unidad: ref("u1"), motivo: "info suficiente para implementar" }),
		dec("ejecutar una unidad", { unidad: ref("u2"), motivo: "verificar antes de terminar" }),
		dec("terminar", { condición: term("finalización cumplida y verificada"), motivo: "unidad verificada, resultado conforme" }),
	];
	let i = 0;
	const { entries, handlers } = capture();
	const finalState = await runLoop(state, {
		...handlers,
		decide: async () => {
			const decision = script[i] ?? script[script.length - 1]!;
			i++;
			return { decision, telemetry: TELEM, raw: EMPTY_RAW, parseFail: false };
		},
		execute: async (_s, decision, _events: WorkerEventSink): Promise<ExecuteOutcome> => {
			if (decision.operación === "terminar") return { result: { kind: "terminación", text: "completada", unidadId: null, passed: true }, telemetry: TELEM };
			if (decision.operación === "obtener información") return { result: { kind: "info", text: "info obtenida", unidadId: null, passed: null }, telemetry: TELEM };
			const unitId = decision.unidad?.tipo === "existente" ? decision.unidad.id : "u?";
			if (unitId === "u0") return { result: { kind: "unidad", text: "src/math.ts existe, export vacío", unidadId: unitId, passed: true }, telemetry: TELEM };
			if (unitId === "u1") return { result: { kind: "unidad", text: "greet() añadida", unidadId: unitId, passed: true }, telemetry: TELEM };
			return { result: { kind: "unidad", text: "tsc ok; greet() => 'hello'", unidadId: unitId, passed: true }, telemetry: TELEM };
		},
	});

	assert.equal(finalState.taskState, "Completada", "happy: terminó Completada");
	assert.equal(finalState.terminalCondition, "finalización cumplida y verificada");
	assert.equal(finalState.units.length, 3);
	assert.ok(finalState.units.every((u) => u.estado === "Terminada"), "happy: todas Terminada");
	assert.equal(finalState.iterations, 4, "happy: 4 vueltas");
	assert.equal(entries.length, 8, "happy: 8 entradas (4 decisión + 4 resultado)");
	assert.equal(entries.filter((e) => e.type === "decision").length, 4);
	assert.equal(entries.filter((e) => e.type === "resultado").length, 4);
	const jsonl = dumpJsonl(entries);
	assert.equal(jsonl.trim().split("\n").length, 8);
	// la primera decisión lleva ajustePlan (determinar el proceso) combinada con ejecutar la unidad (Decision-Model §4.2)
	const firstPlan = entries.find((e) => e.type === "decision" && e.ajustePlan !== null);
	if (!(firstPlan && firstPlan.type === "decision")) assert.fail("esperaba decisión con ajustePlan");
	assert.match(firstPlan.operación, /ejecutar una unidad/);
	assert.equal(firstPlan.ajustePlan?.tipo, "determinar el proceso");
	// telemetría del orquestador (RNF-17): cada decisión con vuelta de host lleva usage/contextUsage.
	for (const e of entries) {
		if (e.type !== "decision") continue;
		const d = e as DecisionLogEntry;
		assert.ok(d.usage, "la decisión lleva el usage del orquestador");
		assert.equal(d.usage?.cost, 0.001);
		assert.equal(d.usage?.tokens.total, 150);
		assert.equal(d.contextUsage?.percent, 0.75);
		assert.equal(d.telemetryUnavailable, false);
	}
	console.log("OK happy path: Completada, 3 unidades Terminada, 4 vueltas, 8 entradas log.jsonl");
}

async function runParseFailCap(): Promise<void> {
	const state = initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" });
	const { entries, handlers } = capture();
	const finalState = await runLoop(state, {
		...handlers,
		decide: async () => ({ decision: dec("obtener información", {}), telemetry: TELEM, raw: "not-json{{", parseFail: true, parseError: "JSON malformado" }),
		execute: async (_s, _d, _e): Promise<ExecuteOutcome> => ({ result: { kind: "info", text: "", unidadId: null, passed: null }, telemetry: TELEM }),
	});

	// C3: no crash, no reinicio; 3 fallos consecutivos → pedir intervención, tarea NO terminal (reanudable).
	assert.ok(finalState.taskState === "Recibida" || finalState.taskState === "En curso", "parse-fail-cap: no terminal, reanudable");
	assert.equal(finalState.consecutiveParseFailures, 3);
	assert.match(finalState.nextStep, /3 fallos de parseo consecutivos/);
	assert.ok(entries.some((e) => e.type === "decision" && (e as { parseFail: boolean }).parseFail), "log.registra parse fails");
	// la telemetría del orquestador se conserva incluso en fallo de parseo (RNF-17)
	const parseFailDecisions = entries.filter((e) => e.type === "decision" && (e as { parseFail: boolean }).parseFail) as DecisionLogEntry[];
	assert.ok(parseFailDecisions.length >= 3, "3 decisiones parse-fail");
	for (const d of parseFailDecisions) assert.ok(d.usage, "parse-fail conserva el usage del orquestador");
	assert.ok(entries.some((e) => e.type === "resultado" && (e as { kind: string }).kind === "parse_error"), "log.registra intervención");
	console.log("OK parse-fail-cap: no crash, 3 fallos → intervención, no terminal reanudable");
}

async function runLimitIntervene(): Promise<void> {
	const state = initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" }, { maxIterations: 2, maxConsecutiveNoProgress: 3 });
	const { entries, handlers } = capture();
	const finalState = await runLoop(state, {
		...handlers,
		decide: async () => ({ decision: dec("obtener información", { motivo: "siempre falta info" }), telemetry: TELEM, raw: "{}", parseFail: false }),
		execute: async (_s, _d, _e): Promise<ExecuteOutcome> => ({ result: { kind: "info", text: "info", unidadId: null, passed: null }, telemetry: TELEM }),
	});

	// ADR-005: al límite de iteraciones → pedir intervención (defecto), NO terminal (reanudable).
	assert.ok(finalState.taskState === "Recibida" || finalState.taskState === "En curso", "limit-intervene: no terminal, reanudable");
	assert.equal(finalState.iterations, 2);
	assert.match(finalState.nextStep, /límite de iteraciones/);
	const limitResults = entries.filter((e) => e.type === "resultado" && (e as { límite_alcanzado: string | null }).límite_alcanzado);
	assert.equal(limitResults.length, 1, "una entrada con límite_alcanzado");
	console.log("OK limit-intervene: no terminal, límite observable, trabajo conservado");
}

async function runDeclaredTermination(): Promise<void> {
	// E-01/E-02 (corridas MiniMax): el orquestador terminó declarando condición cumplida y verificada
	// aunque el bookkeeping de unidades quedó imperfecto (IDs confabulados, verifier FAIL sin trabajo
	// erróneo). Runtime-Model §4: la terminación la DECLARA el orquestador; el runtime no re-deriva
	// el resultado del bookkeeping de unidades (trabajo verificado no debe acabar Fallida).
	// Fix 3: outcomes {execution, verification, scope} se calculan en loop.ts y se consultan en
	// setTerminal (state.ts). Regla B.1: Completada iff execution=success AND verification≠fail.
	const state = initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" });
	const { entries, handlers } = capture();
	const finalState = await runLoop(state, {
		...handlers,
		decide: async () => ({
			decision: dec("terminar", { ajustePlan: { tipo: "determinar el proceso", unidades: [
				{ objetivo: "u-objetivo", alcance: null, infoNecesaria: null, resultadoEsperado: "hecho", condicionFinalizacion: "hecho", capacidad: "implementer" },
			] }, condición: term("cumplida — verificado con PASS") }),
			telemetry: TELEM,
			raw: EMPTY_RAW,
			parseFail: false,
		}),
		execute: async (_s, _d, _e): Promise<ExecuteOutcome> => ({ result: { kind: "terminación", text: "finalización declarada", unidadId: null, passed: null }, telemetry: TELEM }),
	});
	assert.equal(finalState.taskState, "Completada", "terminado declarado-cumplida → Completada");
	assert.equal(finalState.outcomes.execution, "success", "cumpla: execution=success");
	assert.equal(finalState.outcomes.verification, "unknown", "cumpla sin unidades previas: verification=unknown");
	assert.equal(finalState.outcomes.scope, "unknown", "cumpla: scope=unknown (sin expected_artifacts)");
	assert.equal(entries.length, 2, "declared cumplida: 1 decisión + 1 resultado");
	// Variante inviable: condición declarando sin continuación → Fallida.
	const state2 = initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" });
	const entries2 = capture();
	const finalState2 = await runLoop(state2, {
		...entries2.handlers,
		decide: async () => ({ decision: dec("terminar", { condición: term("inviable: sin vía viable", "failed") }), telemetry: TELEM, raw: EMPTY_RAW, parseFail: false }),
		execute: async (_s, _d, _e): Promise<ExecuteOutcome> => ({ result: { kind: "terminación", text: "", unidadId: null, passed: false }, telemetry: TELEM }),
	});
	assert.equal(finalState2.taskState, "Fallida", "terminado declarado-inviable → Fallida");
	assert.equal(finalState2.outcomes.execution, "fail", "inviable: execution=fail");
	assert.equal(finalState2.outcomes.verification, "unknown", "inviable sin unidades previas: verification=unknown");
	const inviable = finalState2.terminalCondition ?? "";
	assert.match(inviable, /inviable: sin vía viable/);
	assert.equal(entries2.entries.length, 2, "declared inviable: 1 decisión + 1 resultado");
	console.log("OK declared termination: declarada cumplida→Completada (execution=success, verification=unknown), inviable→Fallida (execution=fail)");
}

async function runDeclaredTerminationWithVerifierFail(): Promise<void> {
	// Fix 3: aunque el orquestador declare cumplida, si una unidad verifier previa devolvió passed=false,
	// verification=fail → Completada es falsa → Fallida. Demuestra que outcomes desactiva el engaño.
	const state = initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" });
	const script: Decision[] = [
		dec("ejecutar una unidad", {
			ajustePlan: { tipo: "determinar el proceso", unidades: [
				{ objetivo: "verificar", alcance: null, infoNecesaria: null, resultadoEsperado: "PASS", condicionFinalizacion: "PASS", capacidad: "verifier" },
			] },
			unidad: ref("u0"), motivo: "verificar antes de terminar",
		}),
		dec("terminar", { condición: term("cumplida — el orquestador declara éxito") }),
	];
	let i = 0;
	const { entries, handlers } = capture();
	const finalState = await runLoop(state, {
		...handlers,
		decide: async () => {
			const decision = script[i] ?? script[script.length - 1]!;
			i++;
			return { decision, telemetry: TELEM, raw: EMPTY_RAW, parseFail: false };
		},
		execute: async (_s, decision, _e): Promise<ExecuteOutcome> => {
			if (decision.operación === "terminar") return { result: { kind: "terminación", text: "finalización declarada", unidadId: null, passed: null }, telemetry: TELEM };
			// unidad verifier falla
			return { result: { kind: "unidad", text: "**FAIL** — typecheck no pasa", unidadId: "u0", passed: false }, telemetry: TELEM };
		},
	});
	assert.equal(finalState.taskState, "Fallida", "cumpla con verifier FAIL previo → Fallida (outcomes.verification=fail bloquea)");
	assert.equal(finalState.outcomes.execution, "success", "cumpla: execution=success");
	assert.equal(finalState.outcomes.verification, "fail", "verifier FAIL previo: verification=fail");
	assert.equal(finalState.outcomes.scope, "unknown", "scope=unknown");
	console.log("OK declared-termination-with-verifier-fail: execution=success pero verification=fail → Fallida");
}

async function main(): Promise<void> {
	await runHappy();
	await runParseFailCap();
	await runLimitIntervene();
	await runDeclaredTermination();
	await runDeclaredTerminationWithVerifierFail();
	console.log("\nself-check OK: el bucle funciona sin pi (stubs). Cinco caminos verificados.");
}

main().catch((e) => {
	console.error("self-check FAIL:", e);
	process.exit(1);
});
