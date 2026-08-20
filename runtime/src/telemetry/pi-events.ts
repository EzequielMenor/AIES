// src/telemetry/pi-events.ts — mapeo de eventos de pi → tipos de dominio AIES.
//
// Único punto de traducción entre eventos crudos de pi (AgentSessionEvent) y tipos de dominio
// (CompactionObservation, HostActivity). Reemplaza al antiguo pi-binding/events.ts.
//
// C2: tipos de pi importados como type-only (sin runtime); los mapeos son funciones puras y se
// pueden testear sin inicializar un host. RNF-18/19: la huella de compactación se observa, no se
// reimplementa el techo de contexto.

import type { AgentSessionEvent, ContextUsage as PiContextUsage } from "@earendil-works/pi-coding-agent";
import type { CompactionObservation } from "../telemetry/types.js";
import type { HostActivity } from "../core/types.js";

type CompactionEvent = Extract<AgentSessionEvent, { type: "compaction_start" } | { type: "compaction_end" }>;

type ToolExecutionEvent = Extract<AgentSessionEvent, { type: "tool_execution_start" } | { type: "tool_execution_end" }>;

/** Deriva el target (path/cmd/pattern) de los args de un tool. Devuelve null si no hay dato. */
export function deriveTarget(args: unknown): string | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	const candidates: unknown[] = [a.path, a.file_path, a.cmd, a.command, a.pattern];
	for (const c of candidates) {
		if (typeof c === "string" && c.length > 0) return c;
	}
	return null;
}

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

export function mapActivity(e: ToolExecutionEvent): HostActivity | null {
	if (e.type === "tool_execution_start") {
		return {
			fase: "start",
			tool: e.toolName,
			target: deriveTarget(e.args),
			isError: null,
		};
	}
	return {
		fase: "end",
		tool: e.toolName,
		target: null,
		isError: e.isError,
	};
}

/** Normaliza `percent` al rango canónico 0..100. */
export function normalizePercent(raw: number | null | undefined): number | null {
	if (raw === null || raw === undefined) return null;
	if (!Number.isFinite(raw)) return null;
	if (raw > 0 && raw <= 1) return Math.max(0, Math.min(100, Math.round(raw * 100)));
	return Math.max(0, Math.min(100, Math.round(raw)));
}

export function mapContextUsage(ctx: PiContextUsage | undefined | null): { tokens: number | null; contextWindow: number; percent: number | null } | null {
	if (!ctx) return null;
	return { tokens: ctx.tokens, contextWindow: ctx.contextWindow, percent: normalizePercent(ctx.percent) };
}
