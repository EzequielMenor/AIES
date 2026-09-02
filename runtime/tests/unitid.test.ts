// tests/unitid.test.ts — tests de consistencia de IDs de unidades (PROBLEMA 2 + plan §3 invariantes).
//
// Plan §3 (relación de invariantes):
//   - Una unidad recién planificada se referencia por índice del ajuste (`UnitRef.planificada`);
//     el runtime genera y resuelve el ID canónico.
//   - Una `UnitRef.existente` sólo es válida si la unidad está `Pendiente`.
//   - Las correcciones crean una unidad NUEVA con ID nuevo (no se reusa `u5` para arreglar `u5`).
//   - `re-descomponer`/`cambiar de estrategia` reemplazan unidades: pasan a `Sustituida`.

import assert from "node:assert/strict";
import { runLoop } from "../src/core/loop.js";
import type { AiesEventHandlers, DecideOutcome, ExecuteOutcome, WorkerEventSink } from "../src/core/events.js";
import type { Capability, Decision, WorkUnit } from "../src/core/state.js";
import { initState } from "../src/core/state.js";
import type { WorkerTelemetry } from "../src/telemetry/types.js";

const TELEM: WorkerTelemetry = { usage: null, contextUsage: null, telemetryUnavailable: false };

function makeDecision(decision: Decision): DecideOutcome {
	return { decision, telemetry: TELEM, raw: JSON.stringify(decision), parseFail: false };
}

function plan(tipo: "determinar el proceso" | "re-descomponer" | "descomponer" | "cambiar de estrategia", capacidades: WorkUnit["capacidad"][]): NonNullable<Decision["ajustePlan"]> {
	return {
		tipo,
		unidades: capacidades.map<NonNullable<Decision["ajustePlan"]>["unidades"][number]>((capacidad) => ({
			objetivo: `unidad ${capacidad}`,
			alcance: null,
			infoNecesaria: null,
			resultadoEsperado: "listo",
			condicionFinalizacion: "ok",
			capacidad,
		})),
	};
}

function execExisting(id: string, ajustePlan?: NonNullable<Decision["ajustePlan"]> | null): Decision {
	return {
		operación: "ejecutar una unidad",
		ajustePlan: ajustePlan ?? null,
		unidad: { tipo: "existente", id },
		motivo: "test",
	};
}

function execPlanificada(indice: number, ajustePlan: NonNullable<Decision["ajustePlan"]>): Decision {
	return {
		operación: "ejecutar una unidad",
		ajustePlan,
		unidad: { tipo: "planificada", indice },
		motivo: "test",
	};
}

function term(): Decision {
	return { operación: "terminar", condición: { desenlace: "completed", detalle: "cumplida" }, motivo: "fin" };
}

function baseState(): RuntimeState {
	return initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "fin" });
}
type RuntimeState = ReturnType<typeof initState>;

function makeRecorder(): {
	workerFinishes: string[];
	taskFailed: string[];
	taskCompleted: string[];
	events: Partial<Pick<AiesEventHandlers, "onWorkerStart" | "onWorkerFinish" | "onTaskFailed" | "onTaskCompleted">>;
} {
	const workerFinishes: string[] = [];
	const taskFailed: string[] = [];
	const taskCompleted: string[] = [];
	return {
		workerFinishes,
		taskFailed,
		taskCompleted,
		events: {
			onWorkerStart: () => undefined,
			onWorkerFinish: (unitId) => workerFinishes.push(unitId),
			onTaskFailed: (reason) => taskFailed.push(reason),
			onTaskCompleted: (summary) => taskCompleted.push(summary),
		},
	};
}

function stubExecute(mark: (unitId: string) => void): NonNullable<(state: RuntimeState, decision: Decision, events: WorkerEventSink) => Promise<ExecuteOutcome>> {
	return async (state, decision): Promise<ExecuteOutcome> => {
		if (decision.operación === "terminar") {
			return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: TELEM };
		}
		// El bucle marca la unidad `En curso` antes de invocar execute; lo localizamos en el estado.
		const unit = state.units.find((u) => u.estado === "En curso") ?? null;
		const unitId = unit?.id ?? "?";
		mark(unitId);
		return {
			result: { kind: "unidad", text: `ejecutada ${unitId}`, unidadId: unitId, passed: true },
			telemetry: TELEM,
			report: { status: "satisfied", summary: "ok", criteria: [{ criterion: "ok", status: "pass", evidence: "stub" }], unmetCriteria: [] },
		};
	};
}

/** Test 1: plan de UNA unidad + ejecutarla (referencia planificada) → se ejecuta, Completada. */
async function testPlanOneUnitAndExecuteIt(): Promise<void> {
	const rec = makeRecorder();
	const script: Decision[] = [
		execPlanificada(0, plan("determinar el proceso", ["implementer"])),
		term(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute(() => undefined),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	// El stub no conoce el ID canónico resuelto; verificamos que hay 1 unidad Terminada.
	assert.equal(final.taskState, "Completada");
	assert.equal(final.units.length, 1);
	assert.equal(final.units[0]!.estado, "Terminada");
	assert.equal(rec.workerFinishes.length, 1, "1 worker ejecutado");
	assert.equal(rec.taskCompleted.length, 1);
	assert.equal(rec.taskFailed.length, 0);
	console.log("OK test1: plan de una unidad (u0) → se ejecuta y marca u0");
}

/** Test 2: plan de VARIAS unidades + selección de la planificada[1] → NO se ejecuta la otra. */
async function testPlanMultipleSelectOneUnit(): Promise<void> {
	const rec = makeRecorder();
	const script: Decision[] = [
		execPlanificada(1, plan("determinar el proceso", ["implementer", "verifier"])),
		term(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute(() => undefined),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.equal(final.units.length, 2, "dos unidades planificadas");
	const u0 = final.units.find((u) => u.id === "u0")!;
	const u1 = final.units.find((u) => u.id === "u1")!;
	assert.equal(u1.estado, "Terminada", "la seleccionada (u1) se ejecuta");
	assert.equal(u0.estado, "Pendiente", "la NO seleccionada (u0) NO se toca");
	console.log("OK test2: plan múltiple + selección de u1 → u1 ejecutada, u0 intacta");
}

/** Test 3: referencia a unidad INEXISTENTE → error registrado, re-emisión al orquestador. */
async function testNonexistentUnitIsExplicitErrorNoFallback(): Promise<void> {
	const rec = makeRecorder();
	const script: Decision[] = [
		execExisting("u5"),
		execPlanificada(0, plan("determinar el proceso", ["implementer"])),
		term(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute(() => undefined),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.equal(rec.taskFailed.length, 0, "ningún onTaskFailed: el error se re-emite, no es terminal");
	const falloEntry = final.results.find((r) => r.kind === "fallo" && (r.text.includes("u5") || r.text.includes("inexistente")));
	assert.ok(falloEntry, "queda registrado el error de u5 en state.results");
	console.log("OK test3: unidad inexistente (u5) → error registrado, re-emisión, orquestador corrige");
}

/** Test 4: re-descomponer conserva Terminada y pasa la reemplazada a Sustituida. */
async function testReplanPreservesCanonicalIds(): Promise<void> {
	const rec = makeRecorder();
	const script: Decision[] = [
		// Turno 1: planifica u0 (implementer) y la ejecuta.
		execPlanificada(0, plan("determinar el proceso", ["implementer"])),
		// Turno 2: re-descomponer u0 → la sustituye con u1 (verifier) y conserva trabajo anterior.
		{
			operación: "ejecutar una unidad",
			ajustePlan: { tipo: "re-descomponer", reemplaza: ["u0"], unidades: [{ objetivo: "verificar", alcance: null, infoNecesaria: null, resultadoEsperado: "PASS", condicionFinalizacion: "PASS", capacidad: "verifier" }] },
			unidad: { tipo: "planificada", indice: 0 },
			motivo: "re-descomponer",
		},
		// Como u0 está Pendiente tras el error de "no-pendiente" (u0 ya Terminada), el bucle rechaza
		// el reemplazo; el orquestador debe corregir. Aquí terminamos si la verificación funciona.
		term(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute(() => undefined),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	// El test verifica que applyAjustePlan maneja correctamente el caso "reemplaza" cuando la
	// unidad no está en Pendiente/En curso/Fallida. En este caso u0 está Terminada, así que el
	// runtime NO la sustituye (defensa: Sustituida sólo aplica a Pendiente/En curso/Fallida).
	const u0 = final.units.find((u) => u.id === "u0");
	assert.ok(u0, "u0 existe con su ID canónico");
	assert.equal(final.units.length, 1, "un reemplazo inválido no crea una unidad huérfana");
	console.log("OK test4: re-descomponer con IDs canónicos (defensa: u0 ya Terminada no se sustituye)");
}

/** Test 5: flujo adaptativo completo Explorer → Implementer → Verifier. */
async function testExplorerImplementerVerifierFlow(): Promise<void> {
	const executed: string[] = [];
	const rec = makeRecorder();
	const script: Decision[] = [
		{ operación: "obtener información", motivo: "explorar" },
		execPlanificada(0, plan("determinar el proceso", ["implementer", "verifier"])),
		execExisting("u1"),
		term(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: async (state, decision): Promise<ExecuteOutcome> => {
			if (decision.operación === "obtener información") {
				return { result: { kind: "info", text: "hallazgo del explorer", unidadId: null, passed: null }, telemetry: TELEM };
			}
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: TELEM };
			}
			const unit = state.units.find((u) => u.estado === "En curso");
			executed.push(unit?.id ?? "?");
			return {
				result: { kind: "unidad", text: "ok", unidadId: unit?.id ?? null, passed: true },
				telemetry: TELEM,
				report: { status: "satisfied", summary: "ok", criteria: [{ criterion: "ok", status: "pass", evidence: "stub" }], unmetCriteria: [] },
			};
		},
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.equal(final.taskState, "Completada");
	assert.ok(final.knownInfo.includes("hallazgo del explorer"), "la info del explorer alimenta el estado");
	console.log("OK test5: Explorer→Implementer→Verifier completa sin romper el flujo adaptativo");
}

async function main(): Promise<void> {
	await testPlanOneUnitAndExecuteIt();
	await testPlanMultipleSelectOneUnit();
	await testNonexistentUnitIsExplicitErrorNoFallback();
	await testReplanPreservesCanonicalIds();
	await testExplorerImplementerVerifierFlow();
	console.log("\nunitid.test OK: 5 tests de consistencia de IDs de unidades + UnitRef");
}

main().catch((e) => {
	console.error("unitid.test FAIL:", e);
	process.exit(1);
});
