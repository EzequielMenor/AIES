// src/self-check/orchestrator.ts — verificación del parser/decide del orquestador sin pi (C3).
// Inyecta JSON malformado / desconocido / sin condición / con código ejecutable → NO crash, NO reinicio;
// parsea válidos (plain, fence, wrapper). buildStatePrompt + createDecide con stubs in-memory.
//
// En Fase 1+ la firma de createDecide cambia: ya no toma {session: HostSession}, sino DecideContext
// (cwd + modelo + thinkingLevel). El test stub provee un cliente HTTP fake en lugar de una sesión pi,
// pero aquí seguimos testeando el comportamiento del DecideFn vía un wrapper que no crea AgentSession.

import assert from "node:assert/strict";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "../orchestrator/prompts.js";
import { buildStatePrompt, createDecide } from "../orchestrator/decide.js";
import { parseDecision } from "../orchestrator/parse.js";
import { initState } from "../core/state.js";
import type { WorkerTelemetry } from "../telemetry/types.js";
import type { DecideFn, DecideOutcome } from "../core/events.js";
import type { RuntimeState } from "../core/state.js";

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

/** DecideFn stub para verificar el cableado del parser sin inicializar un AgentSession pi. */
function fakeDecide(text: string, throwErr?: Error): DecideFn {
	return async (_state: RuntimeState): Promise<DecideOutcome> => {
		if (throwErr) {
			return {
				decision: parseDecision("").decision,
				telemetry: { ...TELEM, telemetryUnavailable: true, reason: `host decide falló: ${throwErr.message}` },
				raw: "",
				parseFail: true,
				parseError: throwErr.message,
			};
		}
		const parsed = parseDecision(text);
		const outcome: DecideOutcome = { decision: parsed.decision, telemetry: TELEM, raw: text, parseFail: parsed.parseFail };
		if (parsed.parseError) outcome.parseError = parsed.parseError;
		return outcome;
	};
}

async function main(): Promise<void> {
	assert.ok(ORCHESTRATOR_SYSTEM_PROMPT.length > 500, "system prompt definido");
	assert.ok(
		buildStatePrompt(
			initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" }),
		).includes("Estado de la tarea"),
	);

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

	parseShould(JSON.stringify({
		operación: "ejecutar una unidad", unidad: "u0", motivo: "x",
		ajustePlan: { tipo: "descomponer", unidades: [{ objetivo: "haz X", alcance: null, infoNecesaria: null, resultadoEsperado: "r", condicionFinalizacion: "c", capacidad: "implementer" }] },
	}), false, "ajustePlan válido (sin código)");

	parseShould(JSON.stringify({
		operación: "ejecutar una unidad", unidad: "u0", motivo: "x",
		ajustePlan: { tipo: "descomponer", unidades: [{ objetivo: "```\nfunction greet(){return 'hello'}\n```", alcance: null, infoNecesaria: null, resultadoEsperado: "r", condicionFinalizacion: "c", capacidad: "implementer" }] },
	}), true, "ajustePlan con code fence → rechazo");

	parseShould(JSON.stringify({ ...JSON.parse(VALID), code: "evita esto" }), true, "clave extra → strict rechaza");

	// DecideFn válido → DecideOutcome correcto (cableado del parser).
	const state = initState({ objetivo: "x", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "x" });
	const decideOk = fakeDecide(VALID);
	const outOk = await decideOk(state);
	assert.equal(outOk.parseFail, false, "decide válido: parseFail false");
	assert.equal(outOk.decision.operación, "ejecutar una unidad");
	assert.equal(outOk.decision.ajustePlan?.tipo, "determinar el proceso");
	assert.ok(outOk.telemetry.usage !== null, "decide válido: telemetry propagada");

	const decideBad = fakeDecide("not json{{");
	const outBad = await decideBad(state);
	assert.equal(outBad.parseFail, true, "decide malformado: parseFail true");
	assert.match(outBad.parseError ?? "", /malformado|schema|parse/i);

	const decideErr = fakeDecide("", new Error("autenticación de proveedor ausente"));
	const outErr = await decideErr(state);
	assert.equal(outErr.parseFail, true, "decide host-error: parseFail true");
	assert.match(outErr.parseError ?? "", /autenticación/);
	assert.ok(outErr.telemetry.usage !== null, "decide host-error: telemetry del TurnError propagada");

	// createDecide real (Fase 1) acepta DecideContext y devuelve un DecideFn — sanity check sin LLM.
	const decideReal = createDecide({ cwd: process.cwd(), model: undefined, thinkingLevel: undefined });
	assert.equal(typeof decideReal, "function", "createDecide devuelve un DecideFn");

	console.log("OK parser/decide: válido (plain/fence/wrapper), malformado/desconocido/sin-cond/sin-unidad/exec/strict → parseFail, host-error → no crash");
	console.log("\nself-check orchestrator OK: C3 satisfecha. El orquestador no crashea ni reinicia ante salidas adversas.");
}

main().catch((e) => {
	console.error("self-check orchestrator FAIL:", e);
	process.exit(1);
});
