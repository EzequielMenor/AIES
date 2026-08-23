// tests/loop.test.ts — tests unitarios del bucle AIES.
//
// P-02: el bucle es 100% puro. Estos tests lo ejercitan con stubs de orquestador/worker (sin pi)
// y verifican que el bus de eventos tipado (`AiesEventHandlers`) emite los eventos en orden
// determinista a lo largo del ciclo Pensar/Decidir → Ejecutar → Verificar → Actualizar Estado.
//
// Sin framework externo: `node:assert/strict` (mismo estilo que `src/self-check/`). Se compila
// con `tsc -p tsconfig.test.json` y se ejecuta con `node dist/tests/loop.test.js`.

import assert from "node:assert/strict";
import { runLoop } from "../src/core/loop.js";
import type { AiesEventHandlers, ExecuteOutcome, WorkerEventSink } from "../src/core/events.js";
import type { Decision, RuntimeState, WorkUnit } from "../src/core/state.js";
import { initState } from "../src/core/state.js";
import type { WorkerTelemetry } from "../src/telemetry/types.js";

const TELEM: WorkerTelemetry = {
	usage: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.0001 },
	contextUsage: null,
	telemetryUnavailable: false,
};

/** Tipos de eventos capturados en orden cronológico. */
type CapturedEvent =
	| { kind: "onTaskStart"; iter: number }
	| { kind: "onDecideStart"; iter: number }
	| { kind: "onDecideSuccess"; op: Decision["operación"]; unidad: string | null }
	| { kind: "onWorkerStart"; unitId: string; role: WorkUnit["capacidad"] }
	| { kind: "onWorkerFinish"; unitId: string; passed: boolean | null }
	| { kind: "onTaskCompleted"; summary: string }
	| { kind: "onTaskFailed"; reason: string }
	| { kind: "intervention:adjustment"; text: string };

/** Captura todos los eventos del bus en una lista indexada por orden de emisión. */
function makeRecorder(): {
	events: CapturedEvent[];
	handlers: Pick<
		AiesEventHandlers,
		| "onTaskStart"
		| "onDecideStart"
		| "onDecideSuccess"
		| "onWorkerStart"
		| "onWorkerFinish"
		| "onTaskCompleted"
		| "onTaskFailed"
		| "onLoopObservation"
	>;
} {
	const events: CapturedEvent[] = [];
	const push = (e: CapturedEvent) => {
		events.push(e);
	};
	return {
		events,
		handlers: {
			onTaskStart: (_state) => push({ kind: "onTaskStart", iter: -1 }),
			onDecideStart: (iter) => push({ kind: "onDecideStart", iter }),
			onDecideSuccess: (d) => push({ kind: "onDecideSuccess", op: d.operación, unidad: d.unidad }),
			onWorkerStart: (u, info) => push({ kind: "onWorkerStart", unitId: u.id, role: info.role }),
			onWorkerFinish: (unitId, r) => push({ kind: "onWorkerFinish", unitId, passed: r.passed }),
			onTaskCompleted: (summary) => push({ kind: "onTaskCompleted", summary }),
			onTaskFailed: (reason) => push({ kind: "onTaskFailed", reason }),
			onLoopObservation: (obs) => {
				if (obs.phase === "intervention:adjustment") push({ kind: "intervention:adjustment", text: obs.text });
			},
		},
	};
}

/** Script de decisiones: 1 ajuste de plan (2 unidades) + ejecutar u0 (implementer) + ejecutar u1 (verifier) + terminar. */
function buildScript(): Decision[] {
	return [
		{
			operación: "ejecutar una unidad",
			ajustePlan: {
				tipo: "determinar el proceso",
				unidades: [
					{
						objetivo: "implementar greet()",
						alcance: null,
						infoNecesaria: null,
						resultadoEsperado: "greet() exportada y devuelve 'hello'",
						condicionFinalizacion: "greet() añadida a src/math.ts",
						capacidad: "implementer",
					},
					{
						objetivo: "verificar greet()",
						alcance: null,
						infoNecesaria: null,
						resultadoEsperado: "tsc + runtime ok",
						condicionFinalizacion: "VEREDICTO: PASS",
						capacidad: "verifier",
					},
				],
			},
			unidad: "u0",
			capacidad: "implementer",
			comunicación: null,
			motivo: "tarea Recibida; determinar proceso y arrancar con implementer",
			condición: null,
		},
		{
			operación: "ejecutar una unidad",
			ajustePlan: null,
			unidad: "u1",
			capacidad: "verifier",
			comunicación: null,
			motivo: "verificar antes de terminar",
			condición: null,
		},
		{
			operación: "terminar",
			ajustePlan: null,
			unidad: null,
			capacidad: null,
			comunicación: null,
			motivo: "verifier devolvió PASS",
			condición: "cumplida — verificado con PASS",
		},
	];
}

/** Stubs de orquestador/worker que ejecutan el script de decisiones. */
function makeStubs(script: Decision[]): Pick<AiesEventHandlers, "decide" | "execute"> {
	let i = 0;
	return {
		decide: async () => {
			const decision = script[i] ?? script[script.length - 1]!;
			i++;
			return { decision, telemetry: TELEM, raw: "{}", parseFail: false };
		},
		execute: async (_state, decision, _events: WorkerEventSink): Promise<ExecuteOutcome> => {
			if (decision.operación === "terminar") {
				return {
					result: { kind: "terminación", text: "finalización declarada", unidadId: null, passed: null },
					telemetry: TELEM,
				};
			}
			if (decision.operación !== "ejecutar una unidad") {
				return {
					result: { kind: "info", text: "info", unidadId: null, passed: null },
					telemetry: TELEM,
				};
			}
			const unitId = decision.unidad ?? "u?";
			if (unitId === "u0") {
				return {
					result: { kind: "unidad", text: "greet() añadida a src/math.ts", unidadId: unitId, passed: true },
					telemetry: TELEM,
				};
			}
			// u1 (verifier): PASS
			return {
				result: { kind: "unidad", text: "VEREDICTO: PASS — greet() exporta y devuelve 'hello'", unidadId: unitId, passed: true },
				telemetry: TELEM,
			};
		},
	};
}

async function testImplementVerifyEmitsAllEventsInOrder(): Promise<void> {
	const state: RuntimeState = initState({
		objetivo: "añadir greet() a src/math.ts",
		alcance: "src/math.ts",
		restricciones: null,
		resultadoEsperado: "greet() exportada y devuelve 'hello'",
		condicionFinalizacion: "greet() existe, importa y devuelve 'hello'",
	});
	const rec = makeRecorder();
	const stubs = makeStubs(buildScript());

	const finalState = await runLoop(state, { ...rec.handlers, ...stubs });

	// Estado final esperado: tarea Completada, 2 unidades, ambas Terminada, 3 iteraciones.
	assert.equal(finalState.taskState, "Completada", "tarea debe terminar Completada");
	assert.equal(finalState.iterations, 3, "3 iteraciones: plan+implement / verify / terminar");
	assert.equal(finalState.units.length, 2, "2 unidades definidas (implementer + verifier)");
	assert.ok(finalState.units.every((u) => u.estado === "Terminada"), "ambas unidades Terminada");
	assert.equal(finalState.outcomes.execution, "success");
	assert.equal(finalState.outcomes.verification, "pass", "verifier PASS → verification=pass");

	// Eventos: secuencia exacta esperada.
	const expected: CapturedEvent[] = [
		{ kind: "onTaskStart", iter: -1 },
		{ kind: "onDecideStart", iter: 0 },
		{ kind: "onDecideSuccess", op: "ejecutar una unidad", unidad: "u0" },
		{ kind: "onWorkerStart", unitId: "u0", role: "implementer" },
		{ kind: "onWorkerFinish", unitId: "u0", passed: true },
		{ kind: "onDecideStart", iter: 1 },
		{ kind: "onDecideSuccess", op: "ejecutar una unidad", unidad: "u1" },
		{ kind: "onWorkerStart", unitId: "u1", role: "verifier" },
		{ kind: "onWorkerFinish", unitId: "u1", passed: true },
		{ kind: "onDecideStart", iter: 2 },
		{ kind: "onDecideSuccess", op: "terminar", unidad: null },
		{ kind: "onTaskCompleted", summary: "cumplida — verificado con PASS" },
	];

	assert.equal(rec.events.length, expected.length, `esperaba ${expected.length} eventos, recibí ${rec.events.length}`);
	for (let i = 0; i < expected.length; i++) {
		assert.deepEqual(rec.events[i], expected[i], `evento #${i} difiere`);
	}

	console.log("OK implement→verify: 2 unidades, eventos en orden, onTaskCompleted emitido");
}

async function testParseFailDoesNotEmitDecideSuccess(): Promise<void> {
	const state: RuntimeState = initState({
		objetivo: "x",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	const rec = makeRecorder();

	const finalState = await runLoop(state, {
		...rec.handlers,
		decide: async () => ({
			decision: {
				operación: "obtener información",
				ajustePlan: null,
				unidad: null,
				capacidad: null,
				comunicación: null,
				motivo: "fallo controlado",
				condición: null,
			},
			telemetry: TELEM,
			raw: "not-json{{",
			parseFail: true,
			parseError: "JSON malformado",
		}),
		execute: async (): Promise<ExecuteOutcome> => ({
			result: { kind: "info", text: "", unidadId: null, passed: null },
			telemetry: TELEM,
		}),
	});

	// Tope 3 parse-fails → intervención, no terminal, sin onTaskCompleted/Failed.
	assert.equal(finalState.consecutiveParseFailures, 3);
	assert.ok(finalState.taskState === "Recibida" || finalState.taskState === "En curso", "parse-fail: no terminal");
	const success = rec.events.filter((e) => e.kind === "onDecideSuccess");
	assert.equal(success.length, 0, "parse-fail no emite onDecideSuccess");
	const taskCompleted = rec.events.filter((e) => e.kind === "onTaskCompleted");
	const taskFailed = rec.events.filter((e) => e.kind === "onTaskFailed");
	assert.equal(taskCompleted.length, 0, "parse-fail: no onTaskCompleted");
	assert.equal(taskFailed.length, 0, "parse-fail: no onTaskFailed");
	// onTaskStart una vez, onDecideStart tres veces.
	assert.equal(rec.events.filter((e) => e.kind === "onTaskStart").length, 1);
	assert.equal(rec.events.filter((e) => e.kind === "onDecideStart").length, 3);

	console.log("OK parse-fail-cap: no emite onDecideSuccess, no onTaskCompleted, no onTaskFailed");
}

async function testTerminarInviableEmitsOnTaskFailed(): Promise<void> {
	const state: RuntimeState = initState({
		objetivo: "x",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	const rec = makeRecorder();

	const finalState = await runLoop(state, {
		...rec.handlers,
		decide: async () => ({
			decision: {
				operación: "terminar",
				ajustePlan: null,
				unidad: null,
				capacidad: null,
				comunicación: null,
				motivo: "sin continuación viable",
				condición: "inviable: sin vía viable",
			},
			telemetry: TELEM,
			raw: "{}",
			parseFail: false,
		}),
		execute: async (): Promise<ExecuteOutcome> => ({
			result: { kind: "terminación", text: "sin continuación", unidadId: null, passed: false },
			telemetry: TELEM,
		}),
	});

	assert.equal(finalState.taskState, "Fallida", "terminar inviable → Fallida");
	const failed = rec.events.filter((e) => e.kind === "onTaskFailed");
	const completed = rec.events.filter((e) => e.kind === "onTaskCompleted");
	assert.equal(failed.length, 1, "una emisión de onTaskFailed");
	assert.equal(completed.length, 0, "ninguna emisión de onTaskCompleted");
	if (failed[0]?.kind === "onTaskFailed") {
		assert.match(failed[0].reason, /inviable: sin vía viable/);
	}

	console.log("OK terminar-inviable: emite onTaskFailed, no onTaskCompleted");
}

async function testPollInterventionAbsentNoRegression(): Promise<void> {
	const state: RuntimeState = initState({
		objetivo: "x",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	const rec = makeRecorder();
	const stubs = makeStubs(buildScript());

	// Sin `pollIntervention` en absoluto: comportamiento idéntico al baseline (no regresión).
	const finalState = await runLoop(state, { ...rec.handlers, ...stubs });

	assert.equal(finalState.taskState, "Completada");
	assert.equal(finalState.iterations, 3);
	const interventions = rec.events.filter((e) => e.kind === "intervention:adjustment");
	assert.equal(interventions.length, 0, "sin pollIntervention: cero observaciones de ajuste");
	assert.equal(finalState.results.filter((r) => r.kind === "intervención").length, 0);

	console.log("OK pollIntervention ausente: comportamiento idéntico al baseline");
}

async function testPollInterventionAppliesAdjustment(): Promise<void> {
	const state: RuntimeState = initState({
		objetivo: "x",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	const rec = makeRecorder();
	const stubs = makeStubs(buildScript());

	const queue = ["verifica también el caso de borde antes de terminar", "y añade un test"];
	let polls = 0;
	const finalState = await runLoop(state, {
		...rec.handlers,
		...stubs,
		pollIntervention: () => {
			polls += 1;
			if (queue.length === 0) return null;
			return { text: queue.shift()! };
		},
	});

	// Se consumen 2 ajustes → 2 observations; el orquestador los ve en `results` + `knownInfo`.
	const interventions = rec.events.filter((e) => e.kind === "intervention:adjustment");
	assert.equal(interventions.length, 2, "dos ajustes drenados en dos turnos");
	if (interventions[0]?.kind === "intervention:adjustment") {
		assert.match(interventions[0].text, /caso de borde/);
	}
	if (interventions[1]?.kind === "intervention:adjustment") {
		assert.match(interventions[1].text, /añade un test/);
	}

	const adjResults = finalState.results.filter((r) => r.kind === "intervención");
	assert.equal(adjResults.length, 2, "dos resultados `intervención` aplicados al estado");
	assert.ok(finalState.knownInfo.some((k) => k.includes("caso de borde")), "primer ajuste en knownInfo");
	assert.ok(finalState.knownInfo.some((k) => k.includes("añade un test")), "segundo ajuste en knownInfo");

	// Las intervenciones NO consumen iteración: la cuenta final debe ser 3 (igual al baseline).
	assert.equal(finalState.iterations, 3, "el ajuste no incrementa iteraciones (3 = baseline)");

	console.log("OK pollIntervention: ajuste drenado, observación emitida, estado incorpora texto, iterations sin cambio");
}

async function testPollInterventionHandlerThrowsIsolated(): Promise<void> {
	const state: RuntimeState = initState({
		objetivo: "x",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	const rec = makeRecorder();
	const stubs = makeStubs(buildScript());

	const finalState = await runLoop(state, {
		...rec.handlers,
		...stubs,
		pollIntervention: () => {
			throw new Error("poll roto");
		},
	});

	// Handler que lanza NO rompe el bucle (P-02): la tarea sigue su curso normal.
	assert.equal(finalState.taskState, "Completada");
	assert.equal(finalState.iterations, 3);
	const interventions = rec.events.filter((e) => e.kind === "intervention:adjustment");
	assert.equal(interventions.length, 0, "un poll que lanza no produce observaciones");

	console.log("OK pollIntervention que lanza: aislado, el bucle sigue");
}

async function testStopSignalPausesTaskNotFails(): Promise<void> {
	// ADR-012: stopSignal (ESC / SIGINT) PAUSA la tarea, no la marca Fallida.
	// taskState se conserva ("En curso" / "Recibida"), nextStep lleva marcador de pausa,
	// no se emiten onTaskCompleted ni onTaskFailed.
	const state: RuntimeState = initState({
		objetivo: "tarea pausable",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	const rec = makeRecorder();
	let stopped = false;
	const finalState = await runLoop(state, {
		...rec.handlers,
		decide: async () => {
			// Primera vuelta: indicamos stop; el bucle procesa stopSignal al inicio del siguiente
			// turno y sale. Devolvemos una decisión válida para que se ejecute al menos un turno
			// antes del stop (cubre la rama stopSignal al inicio del 2º turno).
			return {
				decision: {
					operación: "obtener información",
					ajustePlan: null,
					unidad: null,
					capacidad: null,
					comunicación: null,
					motivo: "preparar",
					condición: null,
				},
				telemetry: TELEM,
				raw: "{}",
				parseFail: false,
			};
		},
		execute: async (): Promise<ExecuteOutcome> => ({
			result: { kind: "info", text: "preparado", unidadId: null, passed: null },
			telemetry: TELEM,
		}),
		stopSignal: () => stopped || (stopped = true, false), // false la 1ª vez, true la 2ª
	});

	// Estado final: NO Fallida, NO Completada — pausada.
	assert.ok(
		finalState.taskState === "En curso" || finalState.taskState === "Recibida",
		`stopSignal debe preservar taskState (visto: ${finalState.taskState})`,
	);
	assert.match(finalState.nextStep, /pausada por el desarrollador/);
	assert.equal(finalState.terminalCondition, null, "pausa no es terminal");
	assert.notEqual(finalState.taskState, "Fallida");
	assert.notEqual(finalState.taskState, "Completada");

	const completed = rec.events.filter((e) => e.kind === "onTaskCompleted");
	const failed = rec.events.filter((e) => e.kind === "onTaskFailed");
	assert.equal(completed.length, 0, "stopSignal no emite onTaskCompleted");
	assert.equal(failed.length, 0, "stopSignal no emite onTaskFailed (ADR-012)");

	console.log("OK stopSignal: pausa en lugar de Fallida; nextStep marcador; sin onTaskFailed/Completed");
}

async function main(): Promise<void> {
	await testImplementVerifyEmitsAllEventsInOrder();
	await testParseFailDoesNotEmitDecideSuccess();
	await testTerminarInviableEmitsOnTaskFailed();
	await testPollInterventionAbsentNoRegression();
	await testPollInterventionAppliesAdjustment();
	await testPollInterventionHandlerThrowsIsolated();
	await testStopSignalPausesTaskNotFails();
	console.log("\nloop.test OK: 7 tests unitarios del bucle + bus de eventos verificados");
}

main().catch((e) => {
	console.error("loop.test FAIL:", e);
	process.exit(1);
});
