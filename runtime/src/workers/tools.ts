// src/workers/tools.ts — runners de los workers de AIES (explore/implement/verify).
//
// Plan §3 (contrato worker completo): el worker recibe la SOLICITUD ORIGINAL (Task), la
// WorkUnit completa (con requisitos + criterios de aceptación explícitos) y la infoNecesaria
// seleccionada por el Orchestrator. La capacidad viene exclusivamente de la unidad canónica
// (invariante 4 — `decision.capacidad` se eliminó). El worker emite al final un único
// `WorkerReport` estructurado (status + criteria + unmetCriteria) que el runtime normaliza.
//
// Manejo de errores (ADR-006): el runner NO relanza errores del modelo o de las tools — los
// captura y los devuelve como `WorkerRunError { status: 'failed', error: string }`. El bucle AIES
// los traduce a `OperationResult { kind: "fallo" }` y a un `WorkerReport { status: "unsatisfied" }`
// para que la terminación estricta pueda detectar la insatisfacción.

import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkerEventSink } from "../core/events.js";
import type { IntegrationPromptBits } from "./prompts.js";
import { createWorkerSession, disposeWorkerSession, type ResolvedModel, type WorkerRunOutcome, type WorkerSessionDeps } from "./session-factory.js";
import { readSessionTelemetry } from "../telemetry/session.js";
import { parseWorkerReport, type WorkerReportParseResult } from "../orchestrator/parse.js";
import type { Task, WorkUnit, WorkerReport } from "../core/state.js";

export interface WorkerToolContext {
	cwd: string;
	/** Modelo del orchestrator — fallback cuando `models` no trae entrada para la capability.
	 *  undefined = usa modelo por defecto de pi. */
	model: ResolvedModel | undefined;
	/** Modelos resueltos por capability (model-per-role real). undefined por clave = `model`. */
	models?: Partial<Record<"explorer" | "implementer" | "verifier", ResolvedModel | undefined>> | undefined;
	/** thinking level opcional por capability. */
	thinkingLevel?: "off" | "low" | "medium" | "high" | undefined;
	/** Tools AIES-side registradas según disponibilidad del `cwd` (ADR-011). */
	customTools?: ToolDefinition[] | undefined;
	/** Bits por capability que controlan allowlist + prompt addenda (ADR-011). */
	integrationBits?: IntegrationPromptBits | undefined;
	/** AIES-owned ModelRuntime (credenciales en ~/.config/aies/auth.json). Si undefined, default de pi. */
	modelRuntime?: ModelRuntime | undefined;
}

/** Parámetros del worker v2 (plan §3 — contrato completo). */
export interface WorkerRunParams {
	/** Task original inmutable — invariante 5. */
	task: Task;
	/** WorkUnit canónica (requisitos + criterios vinculantes). */
	unit: WorkUnit;
	/** Info necesaria seleccionada por el Orchestrator (de `unit.infoNecesaria` + relevantes). */
	infoNecesaria: string | null;
	/** Feedback correctivo opcional (corrección de un fallo anterior del worker). */
	feedbackCorrectivo: string | null;
	/** Resultados de unidades anteriores que el worker debe respetar como evidencia (limitado). */
	evidenciaPrevia: string;
}

export interface WorkerResult {
	text: string;
	/** Reporte estructurado normalizado (plan §3). Ausente si el worker no produjo uno válido. */
	report: WorkerReportParseResult;
	/** Sólo presente para verifier: PASS/FAIL legacy. null = explorer/implementer. Conservado
	 *  para observabilidad y migración gradual; el runtime usa `report.status` para verificar. */
	verdict: "PASS" | "FAIL" | null;
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Forma legacy de los parámetros (plan §3 — todavía la usan algunos entry points). */
export interface LegacyWorkerParams {
	objetivo: string;
	contexto?: string | undefined;
	unidad?: string | undefined;
}

/** Adapta parámetros legacy al contrato completo. Usado por la extensión y por tests donde el
 *  llamador no tiene Task/WorkUnit canónicos a mano. */
export function toWorkerRunParams(
	capability: "explorer" | "implementer" | "verifier",
	legacy: LegacyWorkerParams,
	feedbackCorrectivo?: string | null,
): WorkerRunParams {
	return {
		task: {
			objetivo: legacy.objetivo,
			alcance: null,
			restricciones: null,
			resultadoEsperado: null,
			condicionFinalizacion: "tarea completada o fallida",
		},
		unit: {
			id: legacy.unidad ?? "?",
			objetivo: legacy.objetivo,
			alcance: null,
			infoNecesaria: legacy.contexto ?? null,
			resultadoEsperado: legacy.objetivo,
			condicionFinalizacion: "criterios cumplidos",
			capacidad: capability,
			estado: "Pendiente",
			intentos: 0,
		},
		infoNecesaria: legacy.contexto ?? null,
		feedbackCorrectivo: feedbackCorrectivo ?? null,
		evidenciaPrevia: legacy.contexto ?? "",
	};
}

function buildWorkerPrompt(
	capability: "explorer" | "implementer" | "verifier",
	params: WorkerRunParams,
): string {
	const lines: string[] = [];
	if (capability === "explorer") {
		lines.push("Eres el EXPLORER de AIES. Reúne SOLO la información mínima necesaria para resolver la tarea. Usa read/grep/find/ls. NO hagas reconocimiento general del proyecto. NO leas archivos que no sean directamente relevantes.");
	} else if (capability === "implementer") {
		lines.push("Eres el IMPLEMENTER de AIES. Realiza el cambio mínimo que satisface la unidad (puedes edit/write/bash/grep/find). Haz SOLO lo que la unidad pide; nada superfluo.");
	} else {
		lines.push("Eres el VERIFIER de AIES (ADR-002). Verificas con el método MÁS SIMPLE Y DIRECTO posible (read/bash/grep/find/ls): si basta con leer el archivo para confirmar el cambio, hazlo; no ejecutes imports dinámicos ni builds completos para cambios triviales. NO editas ni escribes.");
	}
	lines.push(`# Solicitud original (Task)\n${params.task.objetivo}`);
	if (params.task.alcance) lines.push(`# Alcance del Task\n${params.task.alcance}`);
	if (params.task.restricciones?.length) lines.push(`# Restricciones\n- ${params.task.restricciones.join("\n- ")}`);
	lines.push(`# Unidad ${params.unit.id} (${capability})\n${params.unit.objetivo}`);
	if (params.unit.alcance) lines.push(`# Alcance de la unidad\n${params.unit.alcance}`);
	if (params.unit.infoNecesaria) lines.push(`# Información necesaria\n${params.unit.infoNecesaria}`);
	lines.push(`# Resultado esperado\n${params.unit.resultadoEsperado}`);
	lines.push(`# Condición de finalización\n${params.unit.condicionFinalizacion}`);
	if (params.unit.requisitos?.length) {
		lines.push(`# Requisitos vinculantes (NO parafrasear; el worker decide el CÓMO, no el QUÉ)\n- ${params.unit.requisitos.join("\n- ")}`);
	}
	if (params.unit.criteriosAceptacion?.length) {
		lines.push(`# Criterios de aceptación (comprobaciones observables)\n- ${params.unit.criteriosAceptacion.join("\n- ")}`);
	}
	if (params.feedbackCorrectivo) {
		lines.push(`# Feedback correctivo del Orchestrator\n${params.feedbackCorrectivo}`);
	}
	if (params.evidenciaPrevia) {
		lines.push(`# Evidencia previa (limitada)\n${params.evidenciaPrevia}`);
	}
	if (capability !== "explorer") {
		lines.push(
			`# Reporte obligatorio (final del turno)\nAl terminar tu trabajo responde con un ÚNICO objeto JSON, sin texto adicional:\n{"status": "satisfied" | "unsatisfied" | "blocked", "summary": "<resumen breve>", "criteria": [{"criterion": "<texto del criterio>", "status": "pass" | "fail", "evidence": "<evidencia observada>"}], "unmetCriteria": ["<criterios que NO se cumplieron>"]}`,
		);
	}
	return lines.join("\n\n");
}

/** Heurística de extracción de veredicto del verifier (LEGACY — para compatibilidad con la
 *  extensión que ya emite VEREDICTO: PASS/FAIL). El runtime v2 usa `parseWorkerReport`. */
function parseVerdict(text: string): "PASS" | "FAIL" | null {
	const m = text.match(/(?:VEREDICTO\s*:?\s*|veredicto\s+)(PASS|FAIL)\b/i);
	if (!m) return null;
	return m[1]!.toUpperCase() === "PASS" ? "PASS" : "FAIL";
}

/** Runner común a las tres capabilities. Conecta el sink al bus de AIES y captura errores
 *  como `WorkerRunError { status: 'failed', error }` (ADR-006). Parsea el reporte estructurado. */
export async function runWorker(
	capability: "explorer" | "implementer" | "verifier",
	params: WorkerRunParams,
	ctx: WorkerToolContext,
	signal?: AbortSignal | undefined,
	sink?: WorkerEventSink,
): Promise<WorkerRunOutcome & { report?: WorkerReport | null; reportError?: string | null }> {
	const deps: WorkerSessionDeps = {
		cwd: ctx.cwd,
		// Model-per-role real: usa el modelo resuelto para esta capability; cae al del
		// orchestrator sólo si no hay asignación explícita (política de default definida).
		model: ctx.models?.[capability] ?? ctx.model,
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
			// Reporte estructurado: el parser es tolerante con fence/wrapper. Ausente o inválido
			// → unsatisfied con error de contrato (invariante 6).
			const reportParsed = capability === "explorer" ? null : parseWorkerReport(text);
			const report: WorkerReport | null = reportParsed?.ok ? reportParsed.report : null;
			const reportError = reportParsed && !reportParsed.ok ? reportParsed.error : null;
			const verdict = capability === "verifier" ? parseVerdict(text) : null;
			return {
				status: "ok",
				text,
				verdict,
				telemetry: readSessionTelemetry(ws.session),
				report,
				reportError,
			};
		} catch (e) {
			return { status: "failed", error: `${capability} falló: ${errMsg(e)}`, telemetry: readSessionTelemetry(ws.session) };
		}
	} finally {
		disposeWorkerSession(ws);
	}
}

export async function runExplore(params: WorkerRunParams, ctx: WorkerToolContext, signal?: AbortSignal | undefined, sink?: WorkerEventSink): Promise<WorkerRunOutcome> {
	return runWorker("explorer", params, ctx, signal, sink);
}

export async function runImplement(params: WorkerRunParams, ctx: WorkerToolContext, signal?: AbortSignal | undefined, sink?: WorkerEventSink): Promise<WorkerRunOutcome> {
	return runWorker("implementer", params, ctx, signal, sink);
}

export async function runVerify(params: WorkerRunParams, ctx: WorkerToolContext, signal?: AbortSignal | undefined, sink?: WorkerEventSink): Promise<WorkerRunOutcome> {
	return runWorker("verifier", params, ctx, signal, sink);
}