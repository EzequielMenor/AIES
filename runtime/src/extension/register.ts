// src/extension/register.ts — registro de tools, comandos y hooks de la extensión.
//
// @deprecated 2026-08-20: AIES usa CLI standalone (`src/cli.ts`). Este código se eliminará en v2.
//
//
// Fase 3: comandos /resume y /status; hook tool_call para tracking de actividad.

import { Type, type Static } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runExplore, runImplement, runVerify, type WorkerToolContext } from "../workers/tools.js";
import { resumeCommand, runCommand, statusCommand } from "./run-command.js";
import { getCurrentTask } from "./state-store.js";

const ExploreParamsSchema = Type.Object({
	objetivo: Type.String({ minLength: 1, description: "Qué debe descubrir el explorer." }),
	contexto: Type.Optional(Type.String({ description: "Contexto del estado AIES (opcional)." })),
});

export type ExploreInput = Static<typeof ExploreParamsSchema>;

const ImplementParamsSchema = Type.Object({
	objetivo: Type.String({ minLength: 1, description: "Qué cambio debe realizar el implementer." }),
	contexto: Type.Optional(Type.String({ description: "Contexto del estado AIES (opcional)." })),
	unidad: Type.Optional(Type.String({ description: "ID de la unidad AIES (opcional)." })),
});

export type ImplementInput = Static<typeof ImplementParamsSchema>;

const VerifyParamsSchema = Type.Object({
	objetivo: Type.String({ minLength: 1, description: "Qué debe verificar el verifier." }),
	contexto: Type.Optional(Type.String({ description: "Contexto del estado AIES (opcional)." })),
	unidad: Type.Optional(Type.String({ description: "ID de la unidad AIES (opcional)." })),
});

export type VerifyInput = Static<typeof VerifyParamsSchema>;

function makeWorkerCtx(ctx: { cwd: string; model: any; signal: AbortSignal | undefined }): WorkerToolContext {
	return { cwd: ctx.cwd, model: ctx.model };
}

const ExploreTool = {
	name: "explore",
	label: "Explore",
	description: "Delega una unidad de exploración a un worker con tools read-only (read/grep/find/ls). Devuelve un resumen estructurado y conciso.",
	parameters: ExploreParamsSchema,
	async execute(_toolCallId: string, params: ExploreInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string; model: any; signal: AbortSignal | undefined }) {
		const r = await runExplore({ objetivo: params.objetivo, contexto: params.contexto }, makeWorkerCtx(ctx), signal ?? ctx.signal);
		if (r.status === "failed") {
			return { content: [{ type: "text" as const, text: r.error }], details: {}, isError: true };
		}
		return { content: [{ type: "text" as const, text: r.text }], details: {} };
	},
} as const;

const ImplementTool = {
	name: "implement",
	label: "Implement",
	description: "Delega una unidad de implementación a un worker con tools de escritura (read/edit/write/bash/grep/find). Realiza el cambio mínimo y describe lo realizado.",
	parameters: ImplementParamsSchema,
	async execute(_toolCallId: string, params: ImplementInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string; model: any; signal: AbortSignal | undefined }) {
		const r = await runImplement({ objetivo: params.objetivo, contexto: params.contexto, unidad: params.unidad }, makeWorkerCtx(ctx), signal ?? ctx.signal);
		if (r.status === "failed") {
			return { content: [{ type: "text" as const, text: r.error }], details: { verdict: null }, isError: true };
		}
		return { content: [{ type: "text" as const, text: r.text }], details: { verdict: r.verdict ?? null } };
	},
} as const;

const VerifyTool = {
	name: "verify",
	label: "Verify",
	description: "Delega una unidad de verificación a un worker read-only (read/bash/grep/find/ls). SIN edit/write (ADR-002). Devuelve `VEREDICTO: PASS|FAIL` + evidencia.",
	parameters: VerifyParamsSchema,
	async execute(_toolCallId: string, params: VerifyInput, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: { cwd: string; model: any; signal: AbortSignal | undefined }) {
		const r = await runVerify({ objetivo: params.objetivo, contexto: params.contexto, unidad: params.unidad }, makeWorkerCtx(ctx), signal ?? ctx.signal);
		if (r.status === "failed") {
			return { content: [{ type: "text" as const, text: r.error }], details: { verdict: null }, isError: true };
		}
		return { content: [{ type: "text" as const, text: r.text }], details: { verdict: r.verdict ?? null } };
	},
} as const;

export function register(pi: ExtensionAPI): void {
	pi.registerTool(ExploreTool);
	pi.registerTool(ImplementTool);
	pi.registerTool(VerifyTool);

	pi.registerCommand("run", {
		description: "Ejecuta una tarea con el bucle AIES (orquestador + workers). Ej: /run añade greet() a src/math.ts",
		handler: runCommand,
	});
	pi.registerCommand("resume", {
		description: "Reanuda la última tarea AIES no terminal (estado Recibida/En curso).",
		handler: resumeCommand,
	});
	pi.registerCommand("status", {
		description: "Muestra el estado actual del bucle AIES (tarea, iteraciones, unidades, resultados).",
		handler: statusCommand,
	});

	// Observabilidad Fase 3: tracking de tool_call/compaction sin acoplarse a TUI concreta.
	pi.on("tool_execution_start", (event) => {
		const cur = getCurrentTask();
		if (!cur) return;
		// Sólo log en stderr — no se persiste en sesión (research:metrics en Fase 4).
		try {
			console.error(`[aies] tool start: ${event.toolName} (${(event.args as Record<string, unknown> | undefined)?.path ?? ""})`);
		} catch {
			/* stderr best-effort */
		}
	});

	pi.on("session_before_compact", (event) => {
		const cur = getCurrentTask();
		if (!cur) return;
		try {
			console.error(`[aies] compaction before: reason=${event.reason}`);
		} catch {
			/* stderr best-effort */
		}
	});
}
