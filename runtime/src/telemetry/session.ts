// src/telemetry/session.ts — lectura de telemetría de una AgentSession de pi.
//
// Único punto que traduce `getSessionStats()`/`getContextUsage()` de pi al modelo de dominio
// `WorkerTelemetry` (telemetry/types.ts). Lo usan TANTO el orquestador (decide.ts) como los
// workers (tools.ts) para que el bucle pueda acumular coste/tokens de vuelta a vuelta (RNF-07/17).
//
// Reglas:
//   - `cost` y `tokens` vienen directamente de pi (`SessionStats.cost` / `.tokens`), que pi
//     calcula a partir del usage facturado por el proveedor. NO se inventan precios aquí.
//   - Si la sesión no reporta telemetría fiable (`getSessionStats` sin `tokens`), se marca
//     `telemetryUnavailable: true` con motivo — nunca se confunde con coste 0.

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { WorkerTelemetry } from "./types.js";

export const NO_TELEM: WorkerTelemetry = {
	usage: null,
	contextUsage: null,
	telemetryUnavailable: false,
};

/** Lee la telemetría acumulada de una sesión efímera justo tras su turno (antes de dispose). */
export function readSessionTelemetry(session: AgentSession): WorkerTelemetry {
	try {
		const stats = (session as unknown as { getSessionStats?: () => { tokens: unknown; cost?: number } }).getSessionStats?.();
		if (!stats?.tokens) {
			return { ...NO_TELEM, telemetryUnavailable: true, reason: "sin tokens en getSessionStats" };
		}
		const t = stats.tokens as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
		const cu = session.getContextUsage?.();
		return {
			usage: {
				tokens: {
					input: t.input ?? 0,
					output: t.output ?? 0,
					cacheRead: t.cacheRead ?? 0,
					cacheWrite: t.cacheWrite ?? 0,
					total: t.total ?? 0,
				},
				cost: stats.cost ?? 0,
			},
			contextUsage: cu
				? { tokens: cu.tokens ?? null, contextWindow: cu.contextWindow ?? 0, percent: cu.percent ?? null }
				: null,
			telemetryUnavailable: false,
		};
	} catch {
		return { ...NO_TELEM, telemetryUnavailable: true, reason: "no se pudo obtener telemetry de la sesión" };
	}
}