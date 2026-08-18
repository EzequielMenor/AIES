// Host — frontera de dominio con el entorno de ejecución (ADR-009, plan C1).
// El bucle (core/loop.ts) y los tests (step 3: worker stub in-memory) dependen de
// esta interfaz, no de pi. `pi-binding/` da la impl real; el test da un stub.
// Justificada por la necesidad del stub (step 3) + DIP ante pi 0.x: dos impls, no YAGNI.

import type { WorkerTelemetry } from "../telemetry/types.js";

/** Nivel de thinking configurable por rol (pi ThinkingLevel, subconjunto válido; ADR-007/ADR-009). */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** Resultado de una vuelta delegada al host: último texto + telemetría (plan C2). */
export interface TurnResult {
	text: string;
	telemetry: WorkerTelemetry;
}

/** Sesión del host (pi AgentSession) vista por AIES-core. Worker y orquestador lo son. */
export interface HostSession {
	readonly id: string;
	/** Envía un prompt, resuelve al terminar la vuelta, devuelve resultado + telemetría. */
	runTurn(prompt: string, opts?: { signal?: AbortSignal }): Promise<TurnResult>;
	abort(): Promise<void>;
	dispose(): void;
}

/** Error de turno: el host no pudo completar (p. ej. auth ausente, abort, overflow no recuperable). */
export class TurnError extends Error {
	readonly telemetry: WorkerTelemetry;
	constructor(message: string, telemetry: WorkerTelemetry) {
		super(message);
		this.name = "TurnError";
		this.telemetry = telemetry;
	}
}