// tests/cost.test.ts — tests del accounting de coste/tokens de extremo a extremo (PROBLEMA 1).
//
// Verifica el flujo: telemetría por vuelta (orquestador + worker) → acumulación en el bucle →
// TaskTelemetry del evento onTaskCompleted → la UI recibe el coste correcto. Y que, cuando NO
// hay telemetría fiable, NO se inventa un coste (totalCost/totalTokens = null).
//
// Sin framework externo: `node:assert/strict`. Compila con `tsc -p tsconfig.test.json` y se
// ejecuta con `node dist-test/tests/cost.test.js`.

import assert from "node:assert/strict";
import { runLoop } from "../src/core/loop.js";
import type { AiesEventHandlers, DecideOutcome, ExecuteOutcome, TaskTelemetry, WorkerEventSink } from "../src/core/events.js";
import type { Decision, RuntimeState } from "../src/core/state.js";
import { initState } from "../src/core/state.js";
import type { TelemetryUsage, WorkerTelemetry } from "../src/telemetry/types.js";

/** Construye un WorkerTelemetry con un usage concreto (o null para "no disponible"). */
function telem(usage: TelemetryUsage | null): WorkerTelemetry {
	return { usage, contextUsage: null, telemetryUnavailable: usage === null };
}

function tokens(input: number, output: number, cacheRead = 0, cacheWrite = 0): TelemetryUsage {
	return {
		tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
		cost: (input + output) / 200_000, // coste determinista = f(tokens), para aserciones estables
	};
}

/** Script: plan + ejecutar u0 (implementer) + terminar. Devuelve la telemetría deseada por decide/execute. */
interface ScriptConfig {
	decideTelem: WorkerTelemetry;
	executeTelem: WorkerTelemetry;
}

function makeDecision(decision: Decision, telemetry: WorkerTelemetry): DecideOutcome {
	return { decision, telemetry, raw: JSON.stringify(decision), parseFail: false };
}

function unitDecision(unidad: string, capacidad: "implementer" | "verifier"): Decision {
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
					capacidad,
				},
			],
		},
		unidad,
		capacidad,
		comunicación: null,
		motivo: "planificar y ejecutar",
		condición: null,
	};
}

function terminateDecision(): Decision {
	return {
		operación: "terminar",
		ajustePlan: null,
		unidad: null,
		capacidad: null,
		comunicación: null,
		motivo: "unidad terminada",
		condición: "cumplida",
	};
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
				const decision = decideCalls === 1 ? unitDecision("u0", "implementer") : terminateDecision();
				return makeDecision(decision, cfg.decideTelem);
			},
			execute: async (_state, decision, _events: WorkerEventSink): Promise<ExecuteOutcome> => {
				executeCalls++;
				if (decision.operación === "terminar") {
					return {
						result: { kind: "terminación", text: "finalización declarada", unidadId: null, passed: null },
						telemetry: cfg.executeTelem,
					};
				}
				return {
					result: { kind: "unidad", text: "greet() añadida", unidadId: decision.unidad, passed: true },
					telemetry: cfg.executeTelem,
				};
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
	// Orquestador y worker reportan usage: el coste/tokens FINALES deben ser la suma de TODAS las vueltas.
	const d1 = tokens(100, 200); // decide iter0 → cost 300/200000
	const d2 = tokens(50, 50); // decide iter1 (terminar) → cost 100/200000
	const e1 = tokens(10, 20); // execute iter0 → cost 30/200000
	const e2 = tokens(5, 5); // execute iter1 (terminar) → 10/200000
	let decideN = 0;
	let executeN = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async (): Promise<DecideOutcome> => {
			decideN++;
			const decision = decideN === 1 ? unitDecision("u0", "implementer") : terminateDecision();
			return makeDecision(decision, telem(decideN === 1 ? d1 : d2));
		},
		execute: async (_s, decision): Promise<ExecuteOutcome> => {
			executeN++;
			const used = executeN === 1 ? e1 : e2;
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "finalización declarada", unidadId: null, passed: null }, telemetry: telem(used) };
			}
			return { result: { kind: "unidad", text: "ok", unidadId: decision.unidad, passed: true }, telemetry: telem(used) };
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
	// Sin cache (cacheRead=0, cacheWrite=0): totalTokens debe sumar input+output de cada vuelta.
	const runs: TelemetryUsage[] = [tokens(1000, 500), tokens(300, 700)];
	let di = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute"> = {
		decide: async (): Promise<DecideOutcome> => {
			di++;
			const decision = di === 1 ? unitDecision("u0", "implementer") : terminateDecision();
			return makeDecision(decision, telem(runs[di - 1]!));
		},
		execute: async (_s, decision): Promise<ExecuteOutcome> => {
			// Sin cache y con worker sin telemetría: sólo el orquestador (decide) aporta tokens,
			// así totalTokens == input+output de sus vueltas (conservación de componentes).
			const used: TelemetryUsage | null = null;
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: telem(used) };
			}
			return { result: { kind: "unidad", text: "ok", unidadId: decision.unidad, passed: true }, telemetry: telem(used) };
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
	// Ninguna vuelta reporta usage: totalCost/totalTokens deben ser null (desconocido), NO 0.
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
	// Orquestador conocido, worker sin telemetría: el coste conocido no se pierde ni se rellena con 0 falso.
	const known = tokens(100, 100);
	let di = 0;
	const handlers: Pick<AiesEventHandlers, "decide" | "execute" | "onTaskCompleted"> = {
		decide: async (): Promise<DecideOutcome> => {
			di++;
			const decision = di === 1 ? unitDecision("u0", "implementer") : terminateDecision();
			return makeDecision(decision, telem(known)); // orquestador SIEMPRE reporta
		},
		execute: async (_s, decision): Promise<ExecuteOutcome> => {
			if (decision.operación === "terminar") {
				return { result: { kind: "terminación", text: "fin", unidadId: null, passed: null }, telemetry: telem(null) };
			}
			return { result: { kind: "unidad", text: "ok", unidadId: decision.unidad, passed: true }, telemetry: telem(null) };
		},
	};
	let received: TaskTelemetry | undefined;
	await runLoop(baseState(), { ...handlers, onTaskCompleted: (_s, t) => (received = t) });

	// decide se llama 2 veces (cada una con coste known.cost) → se acumula el orquestador.
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