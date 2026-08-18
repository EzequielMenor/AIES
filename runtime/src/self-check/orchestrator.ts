// src/self-check/orchestrator.ts — verificación del parser/decide del orquestador sin pi (plan step 5/C3).
// Inyecta JSON malformado / desconocido / sin condición / con código ejecutable → NO crash, NO reinicio;
// parsea válidos (plain, fence, wrapper). createDecide con HostSession STUB prueba el cableado.

import assert from "node:assert/strict";
import { ORCHESTRATOR_SYSTEM_PROMPT, createDecide, buildStatePrompt } from "../orchestrator/index.js";
import { parseDecision } from "../orchestrator/parse.js";
import { initState } from "../core/state.js";
import type { HostSession } from "../host/types.js";
import { TurnError, type TurnResult } from "../host/types.js";
import type { WorkerTelemetry } from "../telemetry/types.js";

const TELEM: WorkerTelemetry = {
	usage: { tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }, cost: 0.0001 },
	contextUsage: { tokens: 100, contextWindow: 200000, percent: 0.05 },
	telemetryUnavailable: false,
};

const VALID = JSON.stringify({
	operación: "ejecutar una unidad",
	ajustePlan: { tipo: "determinar el proceso", unidades: [
		{ objetivo: "explorar", alcance: null, infoNecesaria: null, resultadoEsperado: "info", condicionFinalizacion: "ok", capacidad: "explorer" },
	] },
	unidad: "u0",
	capacidad: "explorer",
	motivo: "tarea Recibida; info insuficiente",
});

function parseShould(text: string, expectFail: boolean, label: string): void {
	const r = parseDecision(text);
	assert.equal(r.parseFail, expectFail, `${label}: parseFail esperado ${expectFail}`);
}

function fakeHost(text: string): HostSession {
	return {
		id: "fake-orchestrator",
		runTurn: async (): Promise<TurnResult> => ({ text, telemetry: TELEM }),
		abort: async () => {},
		dispose: () => {},
	};
}

function throwingHost(err: TurnError): HostSession {
	return {
		id: "fake-orch-fail",
		runTurn: async (): Promise<TurnResult> => { throw err; },
		abort: async () => {},
		dispose: () => {},
	};
}

async function main(): Promise<void> {
	assert.ok(ORCHESTRATOR_SYSTEM_PROMPT.length > 500, "system prompt definido");
	assert.ok(buildStatePrompt(initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" })).includes("Estado de la tarea"));

	// parseo robusto (C3): no crash ante entradas adversas
	parseShould(VALID, false, "válido plain");
	parseShould("```json\n" + VALID + "\n```", false, "válido con fence");
	parseShould("texto previo\n" + VALID + "\ntexto después", false, "válido con texto alrededor (substring)");
	parseShould(JSON.stringify({ decision: JSON.parse(VALID) }), false, "válido envuelto en wrapper");

	parseShould("not json{{", true, "malformado");
	parseShould("", true, "vacío");
	parseShould(JSON.stringify({ operación: "determinar el proceso", motivo: "x" }), true, "operación desconocida (no es catálogo de 4)");
	parseShould(JSON.stringify({ operación: "terminar", motivo: "listo" }), true, "terminar sin condición");
	parseShould(JSON.stringify({ operación: "ejecutar una unidad", motivo: "x" }), true, "ejecutar sin unidad");
	parseShould(JSON.stringify({ operación: "comunicar al desarrollador", motivo: "x" }), true, "comunicar sin comunicación");

	// contenido ejecutable en ajustePlan → rechazo (C3)
	parseShould(JSON.stringify({
		operación: "ejecutar una unidad", unidad: "u0", motivo: "x",
		ajustePlan: { tipo: "descomponer", unidades: [{ objetivo: "haz X", alcance: null, infoNecesaria: null, resultadoEsperado: "r", condicionFinalizacion: "c", capacidad: "implementer" }] },
	}), false, "ajustePlan válido (sin código)");

	parseShould(JSON.stringify({
		operación: "ejecutar una unidad", unidad: "u0", motivo: "x",
		ajustePlan: { tipo: "descomponer", unidades: [{ objetivo: "```\nfunction greet(){return 'hello'}\n```", alcance: null, infoNecesaria: null, resultadoEsperado: "r", condicionFinalizacion: "c", capacidad: "implementer" }] },
	}), true, "ajustePlan con code fence → rechazo");

	// clave extra (strict) → rechazo
	parseShould(JSON.stringify({ ...JSON.parse(VALID), code: "evita esto" }), true, "clave extra → strict rechaza");

	// createDecide con host válido → DecideOutcome correcto
	const state = initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" });
	const decideOk = createDecide({ session: fakeHost(VALID) });
	const outOk = await decideOk(state);
	assert.equal(outOk.parseFail, false, "decide válido: parseFail false");
	assert.equal(outOk.decision.operación, "ejecutar una unidad");
	assert.equal(outOk.decision.ajustePlan?.tipo, "determinar el proceso");
	assert.ok(outOk.telemetry.usage !== null, "decide válido: telemetry propagada");

	// createDecide con host que devuelve malformado → parseFail, no crash
	const decideBad = createDecide({ session: fakeHost("not json{{") });
	const outBad = await decideBad(state);
	assert.equal(outBad.parseFail, true, "decide malformado: parseFail true");
	assert.match(outBad.parseError ?? "", /malformado|schema|parse/i);

	// createDecide con host que lanza TurnError (auth) → parseFail + telemetry del error, no crash
	const te = new TurnError("autenticación de proveedor ausente", TELEM);
	const decideErr = createDecide({ session: throwingHost(te) });
	const outErr = await decideErr(state);
	assert.equal(outErr.parseFail, true, "decide host-error: parseFail true");
	assert.match(outErr.parseError ?? "", /autenticación/);
	assert.ok(outErr.telemetry.usage !== null, "decide host-error: telemetry del TurnError propagada");

	console.log("OK parser/decide: válido (plain/fence/wrapper), malformado/desconocido/sin-cond/sin-unidad/exec/strict → parseFail, host-error → no crash");
	console.log("\nself-check orchestrator OK: C3 satisfecha. El orquestador no crashea ni reinicia ante salidas adversas.");
}

main().catch((e) => {
	console.error("self-check orchestrator FAIL:", e);
	process.exit(1);
});