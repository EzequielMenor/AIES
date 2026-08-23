// src/workers/tools.ts — runners de los workers de AIES (explore/implement/verify).
//
// Cada runner crea una sesión efímera (session-factory), conecta el `WorkerEventSink` del bucle
// para emitir `onWorkerToolCall`/`onWorkerToolResult`, lanza el prompt del rol y devuelve el
// resultado. La MISMA implementación la usa:
//   (a) la extensión Pi (cuando el LLM principal llama al tool desde la TUI),
//   (b) el bucle AIES (cuando la decisión del orquestador delega a una capacidad).
//
// Manejo de errores (ADR-006): el runner NO relanza errores del modelo o de las tools — los
// captura limpiamente y los devuelve como `WorkerRunError { status: 'failed', error: string }`.
// El bucle AIES traduce este shape a `OperationResult { kind: "fallo" }`, lo que marca la
// unidad como `Fallida` y abre la puerta a la re-delegación o re-descomposición (P-13, REQ-F-16).

import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerEventSink } from "../core/events.js";
import type { IntegrationPromptBits } from "./prompts.js";
import { createWorkerSession, disposeWorkerSession, type ResolvedModel, type WorkerRunOutcome, type WorkerSessionDeps } from "./session-factory.js";
import { readSessionTelemetry } from "../telemetry/session.js";

export interface WorkerToolContext {
	cwd: string;
	/** Modelo por capacidad — undefined = usa modelo por defecto de pi. */
	model: ResolvedModel | undefined;
	/** thinking level opcional por capability. */
	thinkingLevel?: "off" | "low" | "medium" | "high" | undefined;
	/** Tools AIES-side registradas según disponibilidad del `cwd` (ADR-011). */
	customTools?: ToolDefinition[] | undefined;
	/** Bits por capability que controlan allowlist + prompt addenda (ADR-011). */
	integrationBits?: IntegrationPromptBits | undefined;
	/** AIES-owned ModelRuntime (credenciales en ~/.config/aies/auth.json). Si undefined, default de pi. */
	modelRuntime?: ModelRuntime | undefined;
}

export interface ExploreParams {
	/** Objetivo concreto: qué debe descubrir el explorer. */
	objetivo: string;
	/** Contexto opcional del estado AIES (info previa, motivo). */
	contexto?: string | undefined;
}

export interface WorkerResult {
	text: string;
	/** Sólo presente para verifier: PASS/FAIL. null = explorer/implementer. */
	verdict: "PASS" | "FAIL" | null;
}

function buildWorkerPrompt(capability: "explorer" | "implementer" | "verifier", params: { objetivo: string; contexto?: string | undefined; unidad?: string | undefined }): string {
	const lines: string[] = [];
	if (capability === "explorer") {
		lines.push("Eres el EXPLORER de AIES. Reúne SOLO la información mínima necesaria para resolver la tarea. Usa read/grep/find/ls. NO hagas reconocimiento general del proyecto. NO leas archivos que no sean directamente relevantes. Devuelve un resumen ESTRUCTURADO y CONCISO de lo encontrado.");
	} else if (capability === "implementer") {
		lines.push("Eres el IMPLEMENTER de AIES. Realiza el cambio mínimo que satisface la unidad (puedes edit/write/bash/grep/find). Haz SOLO lo que la unidad pide; nada superfluo. Describe brevemente el cambio realizado.");
	} else {
		lines.push("Eres el VERIFIER de AIES (ADR-002). Verificas con el método MÁS SIMPLE Y DIRECTO posible (read/bash/grep/find/ls): si basta con leer el archivo para confirmar el cambio, hazlo; no ejecutes imports dinámicos ni builds completos para cambios triviales. NO editas ni escribes. Termina SIEMPRE con `VEREDICTO: PASS` o `VEREDICTO: FAIL` + evidencia breve.");
	}
	lines.push(`# Objetivo\n${params.objetivo}`);
	if (params.contexto) lines.push(`# Contexto\n${params.contexto}`);
	if (params.unidad) lines.push(`# Unidad\n${params.unidad}`);
	if (capability === "verifier") lines.push("# Termina con `VEREDICTO: PASS` o `VEREDICTO: FAIL` + evidencia.");
	return lines.join("\n\n");
}

/** Heurística de extracción de veredicto del verifier. */
function parseVerdict(text: string): "PASS" | "FAIL" | null {
	const m = text.match(/(?:VEREDICTO\s*:?\s*|veredicto\s+)(PASS|FAIL)\b/i);
	if (!m) return null;
	return m[1]!.toUpperCase() === "PASS" ? "PASS" : "FAIL";
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Runner común a las tres capabilities. Conecta el sink al bus de AIES y captura errores
 *  como `WorkerRunError { status: 'failed', error }` (ADR-006). */
export async function runWorker(
	capability: "explorer" | "implementer" | "verifier",
	params: { objetivo: string; contexto?: string | undefined; unidad?: string | undefined },
	ctx: WorkerToolContext,
	signal?: AbortSignal | undefined,
	sink?: WorkerEventSink,
): Promise<WorkerRunOutcome> {
	const deps: WorkerSessionDeps = {
		cwd: ctx.cwd,
		model: ctx.model,
		capability,
		thinkingLevel: ctx.thinkingLevel,
		customTools: ctx.customTools,
		integrationBits: ctx.integrationBits,
		modelRuntime: ctx.modelRuntime,
	};
	const ws = await createWorkerSession(deps, sink);
	try {
		const prompt = buildWorkerPrompt(capability, params);
		try {
			const text = await new Promise<string>((resolve, reject) => {
				let result = "";
				const off = ws.session.subscribe((e: any) => {
					if (e?.type === "message_update" && e?.assistantMessageEvent?.type === "text_delta") {
						result += e.assistantMessageEvent.delta ?? "";
					}
					if (e?.type === "agent_end") {
						off();
						const last = ws.session.getLastAssistantText?.();
						resolve(last ?? result);
					}
				});
				const abortHandler = () => {
					off();
					reject(new Error("abortado por el llamador"));
				};
				if (signal) {
					if (signal.aborted) {
						abortHandler();
						return;
					}
					signal.addEventListener("abort", abortHandler, { once: true });
				}
				ws.session.prompt(prompt).catch((err) => {
					off();
					reject(err);
				});
			});
			const verdict = capability === "verifier" ? parseVerdict(text) : null;
			return { status: "ok", text, verdict, telemetry: readSessionTelemetry(ws.session) };
		} catch (e) {
			// Error de modelo, de tool, o de prompt → resultado de fallo limpio (ADR-006).
			return { status: "failed", error: `${capability} falló: ${errMsg(e)}`, telemetry: readSessionTelemetry(ws.session) };
		}
	} finally {
		disposeWorkerSession(ws);
	}
}

export async function runExplore(params: ExploreParams, ctx: WorkerToolContext, signal?: AbortSignal | undefined, sink?: WorkerEventSink): Promise<WorkerRunOutcome> {
	return runWorker("explorer", { objetivo: params.objetivo, contexto: params.contexto }, ctx, signal, sink);
}

export interface ImplementParams {
	objetivo: string;
	contexto?: string | undefined;
	unidad?: string | undefined;
}

export async function runImplement(params: ImplementParams, ctx: WorkerToolContext, signal?: AbortSignal | undefined, sink?: WorkerEventSink): Promise<WorkerRunOutcome> {
	return runWorker("implementer", { objetivo: params.objetivo, contexto: params.contexto, unidad: params.unidad }, ctx, signal, sink);
}

export interface VerifyParams {
	objetivo: string;
	contexto?: string | undefined;
	unidad?: string | undefined;
}

export async function runVerify(params: VerifyParams, ctx: WorkerToolContext, signal?: AbortSignal | undefined, sink?: WorkerEventSink): Promise<WorkerRunOutcome> {
	return runWorker("verifier", { objetivo: params.objetivo, contexto: params.contexto, unidad: params.unidad }, ctx, signal, sink);
}
