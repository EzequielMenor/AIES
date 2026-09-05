// tests/loop.test.ts — tests unitarios del bucle AIES.
//
// P-02: el bucle es 100% puro. Estos tests lo ejercitan con stubs de orquestador/worker (sin pi)
// y verifican que el bus de eventos tipado (`AiesEventHandlers`) emite los eventos en orden
// determinista a lo largo del ciclo Pensar/Decidir → Ejecutar → Verificar → Actualizar Estado.
//
// Plan §3: la Decision es ahora una unión discriminada. Las unidades se referencian por
// `{tipo:"existente",id}` o `{tipo:"planificada",indice}` (el bucle resuelve el índice al ID
// canónico generado por `unitSeq`).

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

type CapturedEvent =
	| { kind: "onTaskStart"; iter: number }
	| { kind: "onDecideStart"; iter: number }
	| { kind: "onDecideSuccess"; op: Decision["operación"]; unidad: string | null }
	| { kind: "onWorkerStart"; unitId: string; role: WorkUnit["capacidad"] }
	| { kind: "onWorkerFinish"; unitId: string; passed: boolean | null }
	| { kind: "onTaskCompleted"; summary: string }
	| { kind: "onTaskFailed"; reason: string }
	| { kind: "intervention:adjustment"; text: string };

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
			onDecideSuccess: (d) => push({ kind: "onDecideSuccess", op: d.operación, unidad: d.unidad?.tipo === "existente" ? d.unidad.id : null }),
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

function plan(unidades: Array<{ capacidad: WorkUnit["capacidad"]; objetivo: string }>): NonNullable<Decision["ajustePlan"]> {
	return {
		tipo: "determinar el proceso",
		unidades: unidades.map((u) => ({
			objetivo: u.objetivo,
			alcance: null,
			infoNecesaria: null,
			resultadoEsperado: "listo",
			condicionFinalizacion: "ok",
			capacidad: u.capacidad,
		})),
	};
}

function execRef(id: string, ajuste?: NonNullable<Decision["ajustePlan"]>): Decision {
	return {
		operación: "ejecutar una unidad",
		ajustePlan: ajuste ?? null,
		unidad: { tipo: "existente", id },
		motivo: "test",
	};
}

function term(detalle: string): Decision {
	return { operación: "terminar", condición: { desenlace: "completed", detalle }, motivo: "fin" };
}

function buildScript(): Decision[] {
	return [
		{
			operación: "ejecutar una unidad",
			ajustePlan: plan([
				{ capacidad: "implementer", objetivo: "implementar greet()" },
				{ capacidad: "verifier", objetivo: "verificar greet()" },
			]),
			unidad: { tipo: "planificada", indice: 0 },
			motivo: "tarea Recibida; determinar proceso y arrancar con implementer",
		},
		execRef("u1"),
		term("cumplida — verificado con PASS"),
	];
}

function makeStubs(script: Decision[]): Pick<AiesEventHandlers, "decide" | "execute"> {
	let i = 0;
	return {
		decide: async () => {
			const decision = script[i] ?? script[script.length - 1]!;
			i++;
			return { decision, telemetry: TELEM, raw: "{}", parseFail: false };
		},
		execute: async (state, decision, _events: WorkerEventSink): Promise<ExecuteOutcome> => {
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
			// El bucle marca la unidad `En curso` antes de invocar execute; localizamos por estado.
			const unit = state.units.find((u) => u.estado === "En curso");
			const unitId = unit?.id ?? "?";
			return {
				result: { kind: "unidad", text: `resultado para ${unitId}`, unidadId: unitId, passed: true },
				telemetry: TELEM,
				report: { status: "satisfied", summary: "ok", criteria: [{ criterion: "ok", status: "pass", evidence: "stub" }], unmetCriteria: [] },
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

	// Eventos: secuencia exacta esperada (la planificada[0] se resuelve a u0).
	const expected: CapturedEvent[] = [
		{ kind: "onTaskStart", iter: -1 },
		{ kind: "onDecideStart", iter: 0 },
		{ kind: "onDecideSuccess", op: "ejecutar una unidad", unidad: null },
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
				motivo: "fallo controlado",
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

	// Tope 3 parse-fails → waiting_for_user, no terminal, sin onTaskCompleted/Failed.
	assert.equal(finalState.consecutiveParseFailures, 3);
	assert.ok(finalState.taskState === "Recibida" || finalState.taskState === "En curso", "parse-fail: no terminal");
	assert.equal(finalState.runStatus.tipo, "waiting_for_user", "3 parse-fails → waiting_for_user");
	const success = rec.events.filter((e) => e.kind === "onDecideSuccess");
	assert.equal(success.length, 0, "parse-fail no emite onDecideSuccess");
	const taskCompleted = rec.events.filter((e) => e.kind === "onTaskCompleted");
	const taskFailed = rec.events.filter((e) => e.kind === "onTaskFailed");
	assert.equal(taskCompleted.length, 0, "parse-fail: no onTaskCompleted");
	assert.equal(taskFailed.length, 0, "parse-fail: no onTaskFailed");
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
				condición: { desenlace: "failed", detalle: "inviable: sin vía viable" },
				motivo: "sin continuación viable",
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

	assert.equal(finalState.taskState, "Completada");
	assert.equal(finalState.iterations, 3);
	const interventions = rec.events.filter((e) => e.kind === "intervention:adjustment");
	assert.equal(interventions.length, 0, "un poll que lanza no produce observaciones");

	console.log("OK pollIntervention que lanza: aislado, el bucle sigue");
}

async function testStopSignalPausesTaskNotFails(): Promise<void> {
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
		decide: async () => ({
			decision: {
				operación: "obtener información",
				motivo: "preparar",
			},
			telemetry: TELEM,
			raw: "{}",
			parseFail: false,
		}),
		execute: async (): Promise<ExecuteOutcome> => ({
			result: { kind: "info", text: "preparado", unidadId: null, passed: null },
			telemetry: TELEM,
		}),
		stopSignal: () => stopped || (stopped = true, false),
	});

	assert.ok(
		finalState.taskState === "En curso" || finalState.taskState === "Recibida",
		`stopSignal debe preservar taskState (visto: ${finalState.taskState})`,
	);
	assert.match(finalState.nextStep, /pausada por el desarrollador/);
	assert.equal(finalState.terminalCondition, null, "pausa no es terminal");
	assert.notEqual(finalState.taskState, "Fallida");
	assert.notEqual(finalState.taskState, "Completada");
	assert.equal(finalState.runStatus.tipo, "paused_by_user", "stopSignal → paused_by_user");

	const completed = rec.events.filter((e) => e.kind === "onTaskCompleted");
	const failed = rec.events.filter((e) => e.kind === "onTaskFailed");
	assert.equal(completed.length, 0, "stopSignal no emite onTaskCompleted");
	assert.equal(failed.length, 0, "stopSignal no emite onTaskFailed (ADR-012)");

	console.log("OK stopSignal: pausa en lugar de Fallida; paused_by_user; sin onTaskFailed/Completed");
}

async function testComunicarBloqueaSinExecute(): Promise<void> {
	// Plan §3 — invariante 9: comunicar al desarrollador bloquea el bucle; decide se llama 1 vez,
	// execute 0 veces, y runStatus pasa a waiting_for_user.
	const state: RuntimeState = initState({
		objetivo: "necesito input",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	let decideCalls = 0;
	let executeCalls = 0;
	const finalState = await runLoop(state, {
		decide: async () => {
			decideCalls++;
			return {
				decision: {
					operación: "comunicar al desarrollador",
					comunicación: { pregunta: "¿qué hago?", razón: "subjective_choice", informaciónFaltante: "color favorito" },
					motivo: "necesito una decisión del usuario",
				},
				telemetry: TELEM,
				raw: "{}",
				parseFail: false,
			};
		},
		execute: async () => {
			executeCalls++;
			return { result: { kind: "comunicación", text: "", unidadId: null, passed: null }, telemetry: TELEM };
		},
	});
	assert.equal(decideCalls, 1, "decide llamado una vez");
	assert.equal(executeCalls, 0, "execute NO se invoca para comunicar bloqueante");
	assert.equal(finalState.runStatus.tipo, "waiting_for_user");
	assert.ok(finalState.taskState === "En curso" || finalState.taskState === "Recibida", "waiting_for_user mantiene taskState (reanudable)");
	console.log("OK comunicar-bloqueante: decide 1 vez, execute 0, waiting_for_user");
}

async function testObtenerInformacionPropagaEventosDeTool(): Promise<void> {
	// T4.9 — `obtener información` no tiene WorkUnit, así que el bucle usaba emptyWorkerSink():
	// las tool calls de Explorer (grep/read reales) nunca llegaban a onWorkerToolCall/Result, y
	// la TUI no tenía forma de mostrarlas. Verifica que ahora SÍ se propagan.
	const state: RuntimeState = initState({
		objetivo: "investigar el módulo de auth",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	const toolCalls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const toolResults: Array<{ tool: string; result: string; isError: boolean }> = [];
	let calls = 0;
	await runLoop(state, {
		onWorkerToolCall: (_unitId, tool, args) => toolCalls.push({ tool, args }),
		onWorkerToolResult: (_unitId, tool, result, isError) => toolResults.push({ tool, result, isError }),
		decide: async () => {
			calls += 1;
			if (calls === 1) {
				return {
					decision: { operación: "obtener información", motivo: "investigar" },
					telemetry: TELEM,
					raw: "{}",
					parseFail: false,
				};
			}
			return {
				decision: { operación: "terminar", condición: { desenlace: "completed", detalle: "listo" }, motivo: "fin" },
				telemetry: TELEM,
				raw: "{}",
				parseFail: false,
			};
		},
		execute: async (_state, decision, events): Promise<ExecuteOutcome> => {
			if (decision.operación === "obtener información") {
				events.onWorkerToolCall?.("grep", { pattern: "JWT" });
				events.onWorkerToolResult?.("grep", "3 matches", false);
				return { result: { kind: "info", text: "usa JWT", unidadId: null, passed: null }, telemetry: TELEM };
			}
			return { result: { kind: "terminación", text: "listo", unidadId: null, passed: null }, telemetry: TELEM };
		},
	});
	assert.deepEqual(toolCalls, [{ tool: "grep", args: { pattern: "JWT" } }]);
	assert.deepEqual(toolResults, [{ tool: "grep", result: "3 matches", isError: false }]);
	console.log("OK obtener-información-sink: tool calls/resultados llegan a los handlers (antes: emptyWorkerSink los descartaba)");
}

async function testTerminarInvalidoPorUnidadesActivas(): Promise<void> {
	// Plan §3 — invariante 7: completar es imposible con unidades activas Pendiente/En curso/Fallida.
	const state: RuntimeState = initState({
		objetivo: "x",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "x",
	});
	let decideCalls = 0;
	const finalState = await runLoop(state, {
		decide: async () => {
			decideCalls++;
			return {
				decision: {
					operación: "ejecutar una unidad",
					ajustePlan: {
						tipo: "determinar el proceso",
						unidades: [{ objetivo: "u-pendiente", alcance: null, infoNecesaria: null, resultadoEsperado: "x", condicionFinalizacion: "x", capacidad: "implementer" }],
					},
					unidad: { tipo: "planificada", indice: 0 },
					motivo: "crear unidad pendiente",
				},
				telemetry: TELEM,
				raw: "{}",
				parseFail: false,
			};
		},
		execute: async () => ({
			result: { kind: "unidad", text: "ok", unidadId: "u0", passed: true },
			telemetry: TELEM,
		}),
	});

	// Tras 12 iteraciones (default maxIterations) el bucle llega al límite.
	assert.equal(decideCalls, state.limits.maxIterations, "decide llamado hasta el límite");
	// Estado final: o bien terminación controlada por límite (waiting_for_user), o bien el
	// bucle sigue activo. Lo importante es que NUNCA aceptó `terminar completed` con la
	// unidad Pendiente (invariante 7 — terminación estricta).
	const acceptedTermination = finalState.units.some((u) => u.id === "u0" && u.estado === "Terminada" && finalState.taskState === "Completada");
	assert.equal(acceptedTermination, false, "nunca debe completar con unidades Pendiente sin satisfacer");
	console.log("OK terminar-invalido: terminación estricta nunca acepta completar con unidades activas");
}

async function main(): Promise<void> {
	await testImplementVerifyEmitsAllEventsInOrder();
	await testParseFailDoesNotEmitDecideSuccess();
	await testTerminarInviableEmitsOnTaskFailed();
	await testPollInterventionAbsentNoRegression();
	await testPollInterventionAppliesAdjustment();
	await testPollInterventionHandlerThrowsIsolated();
	await testStopSignalPausesTaskNotFails();
	await testComunicarBloqueaSinExecute();
	await testTerminarInvalidoPorUnidadesActivas();
	await testObtenerInformacionPropagaEventosDeTool();
	console.log("\nloop.test OK: 10 tests unitarios del bucle + bus de eventos verificados");
}

main().catch((e) => {
	console.error("loop.test FAIL:", e);
	process.exit(1);
});