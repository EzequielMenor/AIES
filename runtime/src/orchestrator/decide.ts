// src/orchestrator/decide.ts — DecideFn que crea su propia sesión efímera del orquestador.
//
// Reemplaza al antiguo createDecide({session: HostSession}) — ahora decide.ts toma un contexto
// mínimo (cwd + modelo) y crea la sesión internamente. Compatible con la fase de extensión
// (sin HostSession) y con self-checks que inyectan stubs.
//
// Reglas arquitectónicas (ADR-009 §2, P-01):
//   - Sesión efímera SIN herramientas (`noTools: "all"`) — el orquestador decide QUÉ, no CÓMO.
//   - Una sesión NUEVA por turno — no acumula histórico de chats viejos. La entrada del turno
//     es el `RuntimeState` serializado (P-09), no la conversación.
//   - El prompt intencional se genera desde el estado (`buildStatePrompt`); el JSON se parsea
//     con `parseDecision` (validación Zod, trust boundary).

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type AgentSession,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { DecideFn, DecideOutcome } from "../core/events.js";
import type { RuntimeState, WorkUnit } from "../core/state.js";
import type { WorkerTelemetry } from "../telemetry/types.js";
import { NO_TELEM, readSessionTelemetry } from "../telemetry/session.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "./prompts.js";
import { parseDecision } from "./parse.js";

export type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface DecideContext {
	cwd: string;
	model: ResolvedModel | undefined;
	thinkingLevel?: "off" | "low" | "medium" | "high" | undefined;
	signal?: AbortSignal | undefined;
	/** AIES-owned ModelRuntime (credenciales en ~/.config/aies/auth.json). Si undefined, default de pi. */
	modelRuntime?: ModelRuntime | undefined;
}

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

function emptyDecision() {
	return parseDecision("").decision;
}

/** Construye la sesión efímera del orquestador para un único turno (sin tools, sin historial). */
async function buildOrchestratorSession(ctx: DecideContext): Promise<{ session: AgentSession; systemPrompt: string }> {
	const systemPrompt = ORCHESTRATOR_SYSTEM_PROMPT;
	const loader = new DefaultResourceLoader({
		cwd: ctx.cwd,
		agentDir: getAgentDir(),
		systemPromptOverride: () => systemPrompt,
		appendSystemPromptOverride: () => [],
		noExtensions: true,
	});
	await loader.reload();
	const opts: Parameters<typeof createAgentSession>[0] = {
		cwd: ctx.cwd,
		resourceLoader: loader,
		// Sin herramientas (P-01): el orquestador decide, los workers ejecutan.
		noTools: "all",
	};
	if (ctx.model) opts.model = ctx.model;
	if (ctx.thinkingLevel) opts.thinkingLevel = ctx.thinkingLevel;
	if (ctx.modelRuntime) opts.modelRuntime = ctx.modelRuntime;
	const { session } = await createAgentSession(opts);
	return { session, systemPrompt };
}

/** Captura el texto de un único turno de la sesión del orquestador. Resuelve con el último texto
 *  del asistente al `agent_end`, o rechaza con el error del modelo (el llamador lo mapea a
 *  `parseFail`). El caller es responsable de `session.dispose()`. */
function runTurn(session: AgentSession, prompt: string, signal: AbortSignal | undefined): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		let result = "";
		const off = session.subscribe((e: any) => {
			if (e?.type === "message_update" && e?.assistantMessageEvent?.type === "text_delta") {
				result += e.assistantMessageEvent.delta ?? "";
			}
			if (e?.type === "agent_end") {
				off();
				const last = session.getLastAssistantText?.();
				resolve(last ?? result);
			}
		});
		const onAbort = () => {
			off();
			reject(new Error("orquestador abortado"));
		};
		if (signal) {
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		session.prompt(prompt).catch((err) => {
			off();
			reject(err);
		});
	});
}

function readTelemetry(session: AgentSession): WorkerTelemetry {
	return readSessionTelemetry(session);
}

/** DecideFn que crea una sesión efímera por turno y la cierra al terminar. Sin histórico entre
 *  turnos: cada vuelta parte de un `RuntimeState` serializado (P-09) y una sesión nueva. */
export function createDecide(ctx: DecideContext): DecideFn {
	return async (state: RuntimeState): Promise<DecideOutcome> => {
		const prompt = buildStatePrompt(state);
		let text = "";
		let telemetry: WorkerTelemetry = NO_TELEM;
		let session: AgentSession | null = null;
		try {
			const built = await buildOrchestratorSession(ctx);
			session = built.session;
			text = await runTurn(session, prompt, ctx.signal);
			telemetry = readTelemetry(session);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return {
				decision: emptyDecision(),
				telemetry: { ...NO_TELEM, telemetryUnavailable: true, reason: `host decide falló: ${msg}` },
				raw: "",
				parseFail: true,
				parseError: msg,
			};
		} finally {
			if (session) {
				try {
					session.dispose();
				} catch {
					/* dispose best-effort */
				}
			}
		}
		const parsed = parseDecision(text);
		const outcome: DecideOutcome = { decision: parsed.decision, telemetry, raw: text, parseFail: parsed.parseFail };
		if (parsed.parseError) outcome.parseError = parsed.parseError;
		return outcome;
	};
}
