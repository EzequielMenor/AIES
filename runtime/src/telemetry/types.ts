// Telemetría — interfaz de dominio (C2, plan §3).
// El dominio (core/orchestrator/workers/observability) depende SOLO de este archivo,
// jamás de tipos de pi. Si la API de pi 0.x cambia, sólo `src/pi-binding/` se rompe.
// DIP justificado por la volatilidad de un SDK 0.x — no es YAGNI (plan C2).

/** Tokens de una vuelta (delta de getSessionStats). unidad equivalente de RNF-07. */
export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

/** Consumo de una vuelta: tokens + coste (RNF-07/RNF-17). null = no disponible. */
export interface TelemetryUsage {
	tokens: TokenUsage;
	cost: number;
}

/**
 * Techo de contexto observado (vía getContextUsage/RNF-18).
 * `tokens: null` significa "incidencia": el host devolvió telemetría de contexto
 * NO disponible (post-compaction, pre-respuesta, error de instrumentación). NO
 * se debe confundir con cero ni con el último valor conocido (RNF-17 sin
 * continuación silenciosa sobre techo de contexto).
 *
 * `percent` está normalizado a escala 0..100 (entero). `null` cuando `tokens`
 * es `null` o cuando la instrumentación no pudo calcular la fracción.
 * Esta escala la garantiza `pi-binding/events.ts:mapContextUsage` (un único punto
 * de normalización) — los componentes de presentación NO aplican heurísticas.
 */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/**
 * Lo que una vuelta de worker u orquestador reporta al dominio.
 * `usage` y `contextUsage` son *observabilidad* (no correctitud, plan C2):
 * si faltan o están obsoletos la vuelta completó igual; la decisión procede
 * sobre el resultado textual, no sobre la telemetría.
 */
export interface WorkerTelemetry {
	usage: TelemetryUsage | null;
	contextUsage: ContextUsage | null;
	/** true cuando pi no entregó telemetría fiable → AIES lo avisa en log.jsonl y sigue con el backstop de iteraciones. */
	telemetryUnavailable: boolean;
	/** sólo presente cuando telemetryUnavailable === true (exactOptional). */
	reason?: string;
}

/**
 * Observación de compactación del host (pi `compaction_start`/`compaction_end`).
 * El techo de contexto es un límite más (RNF-18/19): AIES no lo reimplementa,
 * pero deja huella observable de cuándo y cómo se compactó (06-research/H-01).
 */
export interface CompactionObservation {
	fase: "start" | "end";
	reason: string;
	summary: string | null;
	firstKeptEntryId: string | null;
	tokensBefore: number | null;
	estimatedTokensAfter: number | null;
	aborted: boolean | null;
	willRetry: boolean | null;
	errorMessage: string | null;
}