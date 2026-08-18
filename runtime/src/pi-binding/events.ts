// pi-binding/events.ts — mapea telemetría de pi → WorkerTelemetry/CompactionObservation (dominio).
// ÚNICO lugar que toca tipos de pi. Import de tipos SOLAMENTE para pureza/testabilidad;
// las llamadas reales a la API de pi viven en index.ts, que pasa valores planos.

import type { AgentSessionEvent, ContextUsage as PiContextUsage, SessionStats } from "@earendil-works/pi-coding-agent";
import type { CompactionObservation, ContextUsage, TelemetryUsage, TokenUsage, WorkerTelemetry } from "../telemetry/types.js";

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function deltaTokens(after: SessionStats["tokens"], before: SessionStats["tokens"]): TokenUsage {
	return {
		input: after.input - before.input,
		output: after.output - before.output,
		cacheRead: after.cacheRead - before.cacheRead,
		cacheWrite: after.cacheWrite - before.cacheWrite,
		total: after.total - before.total,
	};
}

function mapContextUsage(ctx: PiContextUsage | undefined | null): ContextUsage | null {
	if (!ctx) return null;
	return { tokens: ctx.tokens, contextWindow: ctx.contextWindow, percent: ctx.percent };
}

/**
 * Convierte stats/contexto acumulados de pi en telemetría de dominio (vuelta).
 * Reglas (plan C2): usage es observabilidad; si falta → null + warning; la vuelta no se rompe.
 * Nunca continuación silenciosa sobre techo de contexto: ctx obsoleto avisa y sigue con backstop.
 */
export function computeTelemetry(
	before: SessionStats | null,
	after: SessionStats | null,
	ctx: PiContextUsage | undefined | null,
): WorkerTelemetry {
	const reasons: string[] = [];
	let usage: TelemetryUsage | null = null;

	if (before === null || after === null) {
		// getSessionStats arrojó o no existe: sin telemetría de consumo (uso nulo, no crash).
		reasons.push("getSessionStats no disponible");
	} else {
		const base = before ?? ({ tokens: ZERO_TOKENS, cost: 0 } as SessionStats);
		usage = { tokens: deltaTokens(after.tokens, base.tokens), cost: after.cost - base.cost };
	}

	if (!ctx) {
		reasons.push("contextUsage no disponible");
	} else if (ctx.tokens === null) {
		// Estado NORMAL post-compaction/pre-respuesta: no falso negativo, pero AIES lo advierte (C2).
		reasons.push("contextUsage.tokens null (post-compaction o pre-respuesta)");
	}

	const unavailable = reasons.length > 0;
	const out: WorkerTelemetry = {
		usage,
		contextUsage: mapContextUsage(ctx),
		telemetryUnavailable: unavailable,
	};
	if (unavailable) out.reason = reasons.join("; ");
	return out;
}

type CompactionEvent = Extract<AgentSessionEvent, { type: "compaction_start" } | { type: "compaction_end" }>;

/**
 * Mapea un evento de compactación de pi a la observación de dominio (RNF-18/19).
 * `compaction_end` lleva el resumen y el coste en tokens del techo aplicado; `start` solo la razón.
 * El mapeo es defensivo: si faltara `result`, los campos van a null, nunca crash.
 */
export function mapCompaction(e: CompactionEvent): CompactionObservation {
	if (e.type === "compaction_start") {
		return {
			fase: "start",
			reason: e.reason,
			summary: null,
			firstKeptEntryId: null,
			tokensBefore: null,
			estimatedTokensAfter: null,
			aborted: null,
			willRetry: null,
			errorMessage: null,
		};
	}
	return {
		fase: "end",
		reason: e.reason,
		summary: e.result?.summary ?? null,
		firstKeptEntryId: e.result?.firstKeptEntryId ?? null,
		tokensBefore: e.result?.tokensBefore ?? null,
		estimatedTokensAfter: e.result?.estimatedTokensAfter ?? null,
		aborted: e.aborted,
		willRetry: e.willRetry,
		errorMessage: e.errorMessage ?? null,
	};
}