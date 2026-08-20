// tests/unitid.test.ts — tests de consistencia de IDs de unidades (PROBLEMA 2).
//
// Verifica que existe UN ÚNICO formato canónico de IDs (`u0`, `u1`, …) y que una decisión
// nunca ejecuta una unidad distinta de la seleccionada. Una referencia a una unidad inexistente
// se registra como error y se re-emite al orquestador para que corrija (sin fallback silencioso
// del tipo "si U1 no existe usa u0"); el orquestador puede entonces emitir `determinar el proceso`
// con la unidad y completar el flujo.
//
// Sin framework externo: `node:assert/strict`. Compila con `tsc -p tsconfig.test.json`.

import assert from "node:assert/strict";
import { runLoop } from "../src/core/loop.js";
import type { AiesEventHandlers, DecideOutcome, ExecuteOutcome, WorkerEventSink } from "../src/core/events.js";
import type { Capability, Decision, RuntimeState, WorkUnit } from "../src/core/state.js";
import { initState } from "../src/core/state.js";
import type { WorkerTelemetry } from "../src/telemetry/types.js";

const TELEM: WorkerTelemetry = { usage: null, contextUsage: null, telemetryUnavailable: false };

function makeDecision(decision: Decision): DecideOutcome {
	return { decision, telemetry: TELEM, raw: JSON.stringify(decision), parseFail: false };
}

function plan(tipo: "determinar el proceso" | "re-descomponer", unidades: WorkUnit["capacidad"][]): NonNullable<Decision["ajustePlan"]> {
	return {
		tipo,
		unidades: unidades.map<NonNullable<Decision["ajustePlan"]>["unidades"][number]>((capacidad) => ({
			objetivo: `unidad ${capacidad}`,
			alcance: null,
			infoNecesaria: null,
			resultadoEsperado: "listo",
			condicionFinalizacion: "ok",
			capacidad,
		})),
	};
}

function execDecision(unidad: string, capacidad: Capability, ajustePlan: NonNullable<Decision["ajustePlan"]> | null = null): Decision {
	return {
		operación: "ejecutar una unidad",
		ajustePlan,
		unidad,
		capacidad,
		comunicación: null,
		motivo: "test",
		condición: null,
	};
}

function terminate(): Decision {
	return { operación: "terminar", ajustePlan: null, unidad: null, capacidad: null, comunicación: null, motivo: "fin", condición: "cumplida" };
}

function baseState(): RuntimeState {
	return initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "fin" });
}

/** Registra eventos del bus para distinguir selección vs ejecución. */
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
	return async (_state, decision): Promise<ExecuteOutcome> => {
		if (decision.operación === "terminar") {
			return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: TELEM };
		}
		const unitId = decision.unidad ?? "?";
		mark(unitId);
		return { result: { kind: "unidad", text: `ejecutada ${unitId}`, unidadId: unitId, passed: true }, telemetry: TELEM };
	};
}

/** Test 1: plan de UNA unidad + ejecutarla → sólo esa unidad se marca, tarea Completada. */
async function testPlanOneUnitAndExecuteIt(): Promise<void> {
	const executed: string[] = [];
	const rec = makeRecorder();
	const script: Decision[] = [
		execDecision("u0", "implementer", plan("determinar el proceso", ["implementer"])),
		terminate(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute((u) => executed.push(u)),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.equal(final.taskState, "Completada");
	assert.equal(final.units.length, 1);
	assert.equal(final.units[0]!.id, "u0");
	assert.equal(final.units[0]!.estado, "Terminada");
	assert.deepEqual(executed, ["u0"], "sólo la unidad seleccionada se ejecuta");
	assert.deepEqual(rec.workerFinishes, ["u0"]);
	assert.equal(rec.taskCompleted.length, 1);
	assert.equal(rec.taskFailed.length, 0);
	console.log("OK test1: plan de una unidad (u0) → se ejecuta y marca u0");
}

/** Test 2: plan de VARIAS unidades + selección de una concreta → NO se ejecuta otra. */
async function testPlanMultipleSelectOneUnit(): Promise<void> {
	const executed: string[] = [];
	const rec = makeRecorder();
	const script: Decision[] = [
		execDecision("u1", "verifier", plan("determinar el proceso", ["implementer", "verifier"])),
		terminate(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute((u) => executed.push(u)),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.equal(final.units.length, 2, "dos unidades planificadas");
	const u0 = final.units.find((u) => u.id === "u0")!;
	const u1 = final.units.find((u) => u.id === "u1")!;
	assert.equal(u1.estado, "Terminada", "la seleccionada (u1) se ejecuta");
	assert.equal(u0.estado, "Pendiente", "la NO seleccionada (u0) NO se toca");
	assert.deepEqual(executed, ["u1"], "nunca se ejecuta una unidad distinta de la seleccionada");
	assert.deepEqual(rec.workerFinishes, ["u1"]);
	console.log("OK test2: plan múltiple + selección de u1 → u1 ejecutada, u0 intacta");
}

/** Test 3: referencia a unidad INEXISTENTE → error registrado, re-emisión al orquestador,
 *  SIN fallback silencioso. El orquestador corrige emitiendo `determinar el proceso` y luego
 *  ejecuta la unidad canónica (u0). */
async function testNonexistentUnitIsExplicitErrorNoFallback(): Promise<void> {
	const executed: string[] = [];
	const rec = makeRecorder();
	// Turno 1: el orquestador intenta ejecutar u5 (inexistente) → error registrado, sin ejecutar.
	// Turno 2: el orquestador corrige con `determinar el proceso` (crea u0) y luego ejecuta u0.
	const script: Decision[] = [
		execDecision("u5", "implementer", null),
		execDecision("u0", "implementer", plan("determinar el proceso", ["implementer"])),
		terminate(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute((u) => executed.push(u)),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.deepEqual(executed, ["u0"], "u5 NUNCA se ejecuta (no fallback); u0 sí tras la corrección");
	assert.deepEqual(rec.workerFinishes, ["u0"], "sólo u0 llega a onWorkerFinish");
	assert.equal(rec.taskFailed.length, 0, "ningún onTaskFailed: el error se re-emite, no es terminal");
	assert.equal(rec.taskCompleted.length, 1, "tarea Completada tras la corrección del orquestador");
	assert.equal(final.taskState, "Completada");
	const falloEntry = final.results.find((r) => r.kind === "fallo" && r.unidadId === "u5");
	assert.ok(falloEntry, "queda registrado el error de u5 en state.results");
	assert.match(falloEntry!.text, /unidad inexistente/, "motivo explícito del error");
	console.log("OK test3: unidad inexistente (u5) → error registrado, re-emisión, orquestador corrige a u0");
}

/** Test 4: re-descomponer conserva los IDs canónicos de las unidades conservadas (transición plan/estado). */
async function testReplanPreservesCanonicalIds(): Promise<void> {
	const rec = makeRecorder();
	const script: Decision[] = [
		execDecision("u0", "implementer", plan("determinar el proceso", ["implementer"])),
		execDecision("u1", "verifier", plan("re-descomponer", ["verifier"])),
		terminate(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: stubExecute(() => undefined),
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.equal(final.taskState, "Completada");
	assert.equal(final.units.length, 2, "u0 conservada + u1 nueva tras re-descomponer");
	const u0 = final.units.find((u) => u.id === "u0");
	const u1 = final.units.find((u) => u.id === "u1");
	assert.ok(u0 && u0.estado === "Terminada", "u0 conserva su ID canónico y su estado Terminada");
	assert.ok(u1 && u1.estado === "Terminada", "u1 nueva con ID canónico");
	// La verificación (u1) depende de que u0 ya esté terminada: se cumple el orden sin pérdida de IDs.
	assert.deepEqual(rec.workerFinishes, ["u0", "u1"], "dependencia de ejecución respetada (u0 antes que u1)");
	console.log("OK test4: re-descomponer conserva IDs canónicos (u0·u1) y orden de dependencia");
}

/** Test 5: flujo adaptativo completo Explorer → Implementer → Verifier (comportamiento deseado no roto). */
async function testExplorerImplementerVerifierFlow(): Promise<void> {
	const executed: string[] = [];
	const rec = makeRecorder();
	const script: Decision[] = [
		// Explorer: obtiene información (sin ejecutar unidad).
		{ operación: "obtener información", ajustePlan: null, unidad: null, capacidad: null, comunicación: null, motivo: "explorar", condición: null },
		execDecision("u0", "implementer", plan("determinar el proceso", ["implementer", "verifier"])),
		execDecision("u1", "verifier"),
		terminate(),
	];
	let i = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async () => makeDecision(script[i++] ?? script[script.length - 1]!),
		execute: async (_state, decision): Promise<ExecuteOutcome> => {
			if (decision.operación === "obtener información") {
				return { result: { kind: "info", text: "hallazgo del explorer", unidadId: null, passed: null }, telemetry: TELEM };
			}
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: TELEM };
			}
			const unitId = decision.unidad ?? "?";
			executed.push(unitId);
			return { result: { kind: "unidad", text: `ejecutada ${unitId}`, unidadId: unitId, passed: true }, telemetry: TELEM };
		},
	};
	const final = await runLoop(baseState(), { ...rec.events, ...handlers });

	assert.equal(final.taskState, "Completada", "explorer→implementer→verifier debe completar");
	assert.deepEqual(executed, ["u0", "u1"], "implementer (u0) y verifier (u1) ejecutados en orden tras explorar");
	assert.ok(final.knownInfo.includes("hallazgo del explorer"), "la info del explorer alimenta el estado");
	assert.equal(final.outcomes.verification, "pass", "verifier PASS → verification=pass");
	assert.deepEqual(rec.workerFinishes, ["u0", "u1"]);
	assert.equal(rec.taskFailed.length, 0);
	console.log("OK test5: Explorer→Implementer→Verifier completa sin romper el flujo adaptativo");
}

async function main(): Promise<void> {
	await testPlanOneUnitAndExecuteIt();
	await testPlanMultipleSelectOneUnit();
	await testNonexistentUnitIsExplicitErrorNoFallback();
	await testReplanPreservesCanonicalIds();
	await testExplorerImplementerVerifierFlow();
	console.log("\nunitid.test OK: 5 tests de consistencia de IDs de unidades");
}

main().catch((e) => {
	console.error("unitid.test FAIL:", e);
	process.exit(1);
});