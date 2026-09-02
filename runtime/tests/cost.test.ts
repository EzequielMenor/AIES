// tests/cost.test.ts — tests del accounting de coste/tokens de extremo a extremo (PROBLEMA 1).
//
// Verifica el flujo: telemetría por vuelta (orquestador + worker) → acumulación en el bucle →
// TaskTelemetry del evento onTaskCompleted → la UI recibe el coste correcto. Y que, cuando NO
// hay telemetría fiable, NO se inventa un coste (totalCost/totalTokens = null).
//
// Plan §3 — WorkerReport: el bucle acepta el reporte estructurado del worker para verificar; si
// el implementer NO emite reporte (legacy), se considera `unsatisfied` y `passed=false` (ya no
// se marca `passed:true` automático). Por eso este test usa un stub de execute que inyecta un
// reporte `satisfied` para simular el contrato nuevo.

import assert from "node:assert/strict";
import { runLoop } from "../src/core/loop.js";
import type { AiesEventHandlers, DecideOutcome, ExecuteOutcome, TaskTelemetry, WorkerEventSink } from "../src/core/events.js";
import type { Decision, RuntimeState } from "../src/core/state.js";
import { initState } from "../src/core/state.js";
import type { TelemetryUsage, WorkerTelemetry } from "../src/telemetry/types.js";

function telem(usage: TelemetryUsage | null): WorkerTelemetry {
	return { usage, contextUsage: null, telemetryUnavailable: usage === null };
}

function tokens(input: number, output: number, cacheRead = 0, cacheWrite = 0): TelemetryUsage {
	return {
		tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
		cost: (input + output) / 200_000,
	};
}

interface ScriptConfig {
	decideTelem: WorkerTelemetry;
	executeTelem: WorkerTelemetry;
}

function makeDecision(decision: Decision, telemetry: WorkerTelemetry): DecideOutcome {
	return { decision, telemetry, raw: JSON.stringify(decision), parseFail: false };
}

function unitPlanificada(): Decision {
	return {
		operación: "ejecutar una unidad",
		ajustePlan: {
			tipo: "determinar el proceso",
			unidades: [
				{
					objetivo: "implementar greet()",
					alcance: null,
					infoNecesaria: null,
					resultadoEsperado: "greet() añadida",
					condicionFinalizacion: "greet() existe",
					capacidad: "implementer",
				},
			],
		},
		unidad: { tipo: "planificada", indice: 0 },
		motivo: "planificar y ejecutar",
	};
}

function terminateDecision(): Decision {
	return { operación: "terminar", condición: { desenlace: "completed", detalle: "cumplida" }, motivo: "unidad terminada" };
}

function satisfiedReport() {
	return { status: "satisfied" as const, summary: "ok", criteria: [{ criterion: "greet() añadida", status: "pass" as const, evidence: "tsc ok" }], unmetCriteria: [] };
}

function makeHandlers(cfg: ScriptConfig): {
	handlers: Pick<AiesEventHandlers, "decide" | "execute" | "onTaskCompleted" | "onTaskFailed">;
	completedTelemetry: (TaskTelemetry | null)[];
	failedReasons: string[];
} {
	let decideCalls = 0;
	let executeCalls = 0;
	const completedTelemetry: (TaskTelemetry | null)[] = [];
	const failedReasons: string[] = [];
	return {
		completedTelemetry,
		failedReasons,
		handlers: {
			onTaskCompleted: (_summary, telemetry) => completedTelemetry.push(telemetry),
			onTaskFailed: (reason) => failedReasons.push(reason),
			decide: async (): Promise<DecideOutcome> => {
				decideCalls++;
				const decision = decideCalls === 1 ? unitPlanificada() : terminateDecision();
				return makeDecision(decision, cfg.decideTelem);
			},
			execute: async (_state, decision, _events: WorkerEventSink): Promise<ExecuteOutcome> => {
				executeCalls++;
				if (decision.operación === "terminar") {
					return { result: { kind: "terminación", text: "finalización declarada", unidadId: null, passed: null }, telemetry: cfg.executeTelem };
				}
				return { result: { kind: "unidad", text: "greet() añadida", unidadId: "u0", passed: true }, telemetry: cfg.executeTelem, report: satisfiedReport() };
			},
		},
	};
}

function baseState(): RuntimeState {
	return initState({
		objetivo: "añadir greet()",
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "tarea completada o fallida",
	});
}

async function testUsageCapturedAndCostSummed(): Promise<void> {
	const d1 = tokens(100, 200);
	const d2 = tokens(50, 50);
	const e1 = tokens(10, 20);
	const e2 = tokens(5, 5);
	let decideN = 0;
	let executeN = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async (): Promise<DecideOutcome> => {
			decideN++;
			const decision = decideN === 1 ? unitPlanificada() : terminateDecision();
			return makeDecision(decision, telem(decideN === 1 ? d1 : d2));
		},
		execute: async (state, decision): Promise<ExecuteOutcome> => {
			executeN++;
			const used = executeN === 1 ? e1 : e2;
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "finalización declarada", unidadId: null, passed: null }, telemetry: telem(used) };
			}
			const unit = state.units.find((u) => u.estado === "En curso");
			return { result: { kind: "unidad", text: "ok", unidadId: unit?.id ?? null, passed: true }, telemetry: telem(used), report: satisfiedReport() };
		},
	};

	let received: TaskTelemetry | undefined;
	await runLoop(baseState(), { ...handlers, onTaskCompleted: (_s, t) => (received = t) });

	assert.ok(received, "onTaskCompleted debe emitirse con telemetría");
	assert.equal(received!.totalCost, d1.cost + d2.cost + e1.cost + e2.cost, `coste total = suma de todas las vueltas (got ${received!.totalCost})`);
	assert.equal(received!.totalTokens, d1.tokens.total + d2.tokens.total + e1.tokens.total + e2.tokens.total, "tokens totales = suma de totals conservados");
	assert.ok(received!.totalCost! > 0, "no debe ser $0.000 cuando hay usage conocido");
	console.log(`OK usage-captured: coste ${received!.totalCost} (no 0), tokens ${received!.totalTokens}`);
}

async function testInputOutputTokensPreserved(): Promise<void> {
	const runs: TelemetryUsage[] = [tokens(1000, 500), tokens(300, 700)];
	let di = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async (): Promise<DecideOutcome> => {
			di++;
			const decision = di === 1 ? unitPlanificada() : terminateDecision();
			return makeDecision(decision, telem(runs[di - 1]!));
		},
		execute: async (state, decision): Promise<ExecuteOutcome> => {
			const used: TelemetryUsage | null = null;
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: telem(used) };
			}
			const unit = state.units.find((u) => u.estado === "En curso");
			return { result: { kind: "unidad", text: "ok", unidadId: unit?.id ?? null, passed: true }, telemetry: telem(used), report: satisfiedReport() };
		},
	};
	let received: TaskTelemetry | undefined;
	await runLoop(baseState(), { ...handlers, onTaskCompleted: (_s, t) => (received = t) });

	const inputSum = runs.reduce((a, u) => a + u.tokens.input, 0);
	const outputSum = runs.reduce((a, u) => a + u.tokens.output, 0);
	assert.equal(received!.totalTokens, inputSum + outputSum, "input+output conservados en totalTokens");
	console.log(`OK tokens-preserved: totalTokens=${received!.totalTokens} (input=${inputSum} + output=${outputSum})`);
}

async function testNoInventedCostWhenUsageUnavailable(): Promise<void> {
	const cfg: ScriptConfig = { decideTelem: telem(null), executeTelem: telem(null) };
	const { handlers, completedTelemetry } = makeHandlers(cfg);
	await runLoop(baseState(), handlers);

	assert.equal(completedTelemetry.length, 1, "onTaskCompleted se emite una vez");
	const t = completedTelemetry[0]!;
	assert.equal(t.totalCost, null, "sin usage → totalCost null (no se inventa coste)");
	assert.equal(t.totalTokens, null, "sin usage → totalTokens null");
	console.log("OK no-invented-cost: sin telemetría → totalCost/totalTokens=null (UI mostrará n/d)");
}

async function testPartialUsageKeepsKnownCost(): Promise<void> {
	const known = tokens(100, 100);
	let di = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute" | "onTaskCompleted"> = {
		decide: async (): Promise<DecideOutcome> => {
			di++;
			const decision = di === 1 ? unitPlanificada() : terminateDecision();
			return makeDecision(decision, telem(known));
		},
		execute: async (state, decision): Promise<ExecuteOutcome> => {
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: telem(null) };
			}
			const unit = state.units.find((u) => u.estado === "En curso");
			return { result: { kind: "unidad", text: "ok", unidadId: unit?.id ?? null, passed: true }, telemetry: telem(null), report: satisfiedReport() };
		},
	};
	let received: TaskTelemetry | undefined;
	await runLoop(baseState(), { ...handlers, onTaskCompleted: (_s, t) => (received = t) });

	assert.equal(received!.totalCost, known.cost * 2, "el coste conocido del orquestador se acumula aunque los workers no reporten");
	assert.equal(received!.totalTokens, known.tokens.total * 2, "tokens del orquestador acumulados");
	console.log(`OK partial-usage: orquestador conocido (${received!.totalCost}), workers null → coste no nulo ni 0-falso`);
}

async function main(): Promise<void> {
	await testUsageCapturedAndCostSummed();
	await testInputOutputTokensPreserved();
	await testNoInventedCostWhenUsageUnavailable();
	await testPartialUsageKeepsKnownCost();
	console.log("\ncost.test OK: 4 tests de accounting de coste/tokens");
}

main().catch((e) => {
	console.error("cost.test FAIL:", e);
	process.exit(1);
});