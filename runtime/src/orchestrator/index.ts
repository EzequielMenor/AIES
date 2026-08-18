// src/orchestrator/index.ts — orquestador (ADR-007): AgentSession noTools:"all" + system prompt de
// decisión estructurada + parser Zod robusto (C3). DecideFn: lee el estado → vuelve al host → parsea.
// Dominio puro salvo la dependencia de HostSession (host/types, NO pi). La sesión la crea pi-binding.

import type { HostSession } from "../host/types.js";
import { TurnError } from "../host/types.js";
import type { WorkerTelemetry } from "../telemetry/types.js";
import type { DecideFn, DecideOutcome } from "../core/loop.js";
import type { RuntimeState, WorkUnit } from "../core/state.js";
import { parseDecision } from "./parse.js";

/** Contrato de salida estructurada del orquestador (Decision-Model §2/§4/§11, MVP-v0-Scope §2). */
export const ORCHESTRATOR_SYSTEM_PROMPT = `Eres el ORQUESTADOR de AIES. Coordinas; NO ejecutas trabajo delegable del proyecto (no dispones de herramientas, P-01). Tu única salida es una decisión.

# Salida
Responde EXCLUSIVAMENTE con un único objeto JSON, sin texto adicional ni fences ni markdown:
{
  "operación": "obtener información" | "ejecutar una unidad" | "comunicar al desarrollador" | "terminar",
  "ajustePlan": null | { "tipo": "descomponer" | "re-descomponer" | "cambiar de estrategia" | "determinar el proceso", "unidades": [ { "objetivo": "...", "alcance": "..." | null, "infoNecesaria": "..." | null, "resultadoEsperado": "...", "condicionFinalizacion": "...", "capacidad": "explorer" | "implementer" | "verifier" } ] },
  "unidad": "<id de unidad existente a ejecutar>" | null,
  "capacidad": "explorer" | "implementer" | "verifier" | null,
  "comunicación": "...",   // sólo si operación = "comunicar al desarrollador"
  "motivo": "<qué del estado justifica la decisión>",
  "condición": "<cumplida o causa de inviabilidad>"   // sólo si operación = "terminar"
}

# Reglas
- "operación" es OBLIGATORIA y exactamente una del catálogo (Runtime-Model §4).
- "ajustePlan" es OPCIONAL y hermana de "operación" (no se anida en ella). Cambia el plan, NO el proyecto.
- "ajustePlan.unidades" son DEFINICIONES (objetivo/alcance/resultado esperado/condición/capacidad). NUNCA incluyas código, diffs, comandos ni tool calls dentro de ajustePlan: el trabajo ejecutable lo delega un worker, no tú.
- "motivo" siempre. "condición" sólo cuando operación = "terminar".
- "unidad" (id de una unidad existente del estado) es obligatoria cuando operación = "ejecutar una unidad".
- "comunicación" es obligatoria cuando operación = "comunicar al desarrollador".
- "capacidad" es opcional (se derive de la unidad); indica el worker si lo decides.

# Cuándo elegir cada operación (Decision-Model §5/§7)
- "obtener información": el estado NO contiene información suficiente para ejecutar sin suponer. No modifica el proyecto.
- "ejecutar una unidad": hay trabajo pendiente e información suficiente. Selecciona la unidad pendiente adecuada.
- "comunicar al desarrollador": hay progreso/decisión/resultado que hacer visible; devuelve el control al bucle.
- "terminar": las condiciones de finalización están cumplidas y verificadas (Completada) o no hay continuación viable (Fallida).

# Repertorio ante resultados (Decision-Model §6, ADR-005/006)
- Fallo de unidad: NO implica fallo de tarea. Corrige/re-delega, obtén información, re-descompón, o termina como Fallida si no hay vía viable.
- Verificación insatisactoria: vuelve al bucle (otra unidad de Implementer); el Verifier no edita.
- Límite alcanzado (iter. máx): comunica para pedir intervención (por defecto) o termina controladamente.
- Re-descomponer (ajustePlan.tipo="re-descomponer"): cuando una unidad es demasiado grande/mal definida (multiplicidad de resultados, fallo no localizable, alcance ampliado, iteraciones sin progreso). Conserva el trabajo aceptado.

# Orden del turno
Si emites ajustePlan, se aplicará al estado ANTES de ejecutar la operación de este mismo turno (la operación actúa sobre el estado post-ajuste).

Nunca continues de forma silenciosa ni ilimitada (RNF-19). Decides QUÉ; los trabajadores hacen CÓMO.`;

function unitLine(u: WorkUnit): string {
	const sc = u.alcance ? ` | alcance: ${u.alcance}` : "";
	return `- ${u.id} [${u.estado}] (${u.capacidad}): objetivo: ${u.objetivo}${sc} | resultado esperado: ${u.resultadoEsperado} | condición: ${u.condicionFinalizacion}`;
}

/** Serializa el estado en el prompt por turno (P-09: el estado, no la conversación, es la entrada de la decisión). */
export function buildStatePrompt(state: RuntimeState): string {
	const out: string[] = [];
	out.push(`# Estado de la tarea (iteración ${state.iterations})`);
	out.push("## Tarea");
	out.push(`- objetivo: ${state.task.objetivo}`);
	if (state.task.alcance) out.push(`- alcance: ${state.task.alcance}`);
	if (state.task.restricciones?.length) out.push(`- restricciones: ${state.task.restricciones.join("; ")}`);
	if (state.task.resultadoEsperado) out.push(`- resultado esperado: ${state.task.resultadoEsperado}`);
	out.push(`- condición de finalización: ${state.task.condicionFinalizacion}`);
	out.push("## Información conocida");
	(state.knownInfo.length ? state.knownInfo : ["(sin información aún)"]).forEach((i) => out.push(`- ${i}`));
	out.push("## Unidades de trabajo");
	state.units.forEach((u) => out.push(unitLine(u)));
	out.push("## Resultados obtenidos");
	if (state.results.length) {
		state.results.forEach((r, i) => {
			const tag = r.unidadId ? ` [${r.unidadId}]` : "";
			out.push(`- ${i}: (${r.kind}${tag}) ${r.text}`);
		});
	} else {
		out.push("- (sin resultados aún)");
	}
	out.push("## Límites e iteraciones");
	out.push(`- iteraciones: ${state.iterations} / ${state.limits.maxIterations} (provisional); coste: off; contexto delegado a autoCompaction (observado).`);
	if (state.nextStep) out.push(`## Siguiente paso sugerido\n- ${state.nextStep}`);
	out.push("## Tu decisión");
	out.push("Emite tu decisión JSON según el contrato (ver system prompt).");
	return out.join("\n");
}

export interface OrchestratorDeps {
	session: HostSession;
}

/** Construye el DecideFn del bucle: estado → prompt → runTurn del host → parse Zod → Decisión. */
export function createDecide(deps: OrchestratorDeps): DecideFn {
	return async (state: RuntimeState): Promise<DecideOutcome> => {
		const prompt = buildStatePrompt(state);
		let text: string;
		let telemetry: WorkerTelemetry;
		try {
			const r = await deps.session.runTurn(prompt);
			text = r.text;
			telemetry = r.telemetry;
		} catch (e) {
			// Fallo del host durante la decisión (auth ausente, abort, overflow no recuperable):
			// se trata como info-insuficiente (salida no disponible) y se reentra (C3/RNF-09).
			// Tope 3 fallos consecutivos → intervención. Sin crash.
			if (e instanceof TurnError) {
				return { decision: emptyDecisionSafe(), telemetry: e.telemetry, raw: "", parseFail: true, parseError: e.message };
			}
			const msg = e instanceof Error ? e.message : String(e);
			return {
				decision: emptyDecisionSafe(),
				telemetry: { usage: null, contextUsage: null, telemetryUnavailable: true, reason: `host decide falló: ${msg}` },
				raw: "",
				parseFail: true,
				parseError: msg,
			};
		}
		const parsed = parseDecision(text);
		const outcome: DecideOutcome = { decision: parsed.decision, telemetry, raw: text, parseFail: parsed.parseFail };
		if (parsed.parseError) outcome.parseError = parsed.parseError;
		return outcome;
	};
}

function emptyDecisionSafe() {
	return parseDecision("").decision;
}