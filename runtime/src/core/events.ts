// src/core/events.ts — bus de eventos tipado del bucle AIES.
//
// P-02: el bucle es 100% puro y agnóstico de la UI/TUI. Toda interacción con el exterior
// ocurre emitiendo eventos a través de este contrato. El bucle NO importa nada de Ink/React/pi-ui:
// cualquier consumidor (TUI, log, tests) implementa `AiesEventHandlers` y se la pasa a `runLoop`.
//
// Estructura:
//   - `DecideOutcome` / `ExecuteOutcome`: payloads de las primitivas inyectadas (decide/execute).
//   - `WorkerEventSink`: surface de eventos finos que el bucle pasa a `execute` para que el worker
//     emita sus tool calls / verificación desde dentro. Independiente del contrato del bucle.
//   - `AiesEventHandlers`: handlers opcionales (todos `void` salvo `decide`/`execute`) que el bucle
//     invoca en orden determinista a lo largo del ciclo.

import type { LoopObservation } from "./observation.js";
import type { LogEntry } from "../observability.js";
import type {
	Capability,
	Decision,
	OperationResult,
	ResultKind,
	RuntimeState,
	WorkUnit,
} from "./state.js";
import type { WorkerTelemetry } from "../telemetry/types.js";

// ──────────────────────────────────────────────────────────────────────────────
// Primitivas inyectadas
// ──────────────────────────────────────────────────────────────────────────────

/** DecideFn: el orquestador lee el estado y emite una decisión JSON. Inyectada. */
export interface DecideOutcome {
	decision: Decision;
	telemetry: WorkerTelemetry;
	raw: string;
	parseFail: boolean;
	parseError?: string;
}

/** Tipo función: un `DecideFn` consume estado y devuelve un `DecideOutcome`. */
export type DecideFn = (state: RuntimeState) => Promise<DecideOutcome>;

/** ExecuteFn: ejecuta la operación contra un worker. Recibe un `WorkerEventSink` para emitir
 *  eventos de granularidad fina (tool calls, verificación) desde dentro del worker. */
export interface ExecuteOutcome {
	result: OperationResult;
	telemetry: WorkerTelemetry;
	/** E-01A: marca experimental de atribución. Si está, metrics.ts atribuye los tokens al
	 *  orquestador en lugar de al worker. */
	atribución?: "orquestador" | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tipos de payloads de eventos
// ──────────────────────────────────────────────────────────────────────────────

/** Decisión validada del orquestador (alias tipado público de `Decision`). */
export type OrchestratorDecision = Decision;

/** Metadata del worker que se va a lanzar (emitido en `onWorkerStart`). */
export interface WorkerInfo {
	/** Capacidad del worker (explorer / implementer / verifier). */
	role: Capability;
	/** Modelo del worker (cadena libre; "unknown" hasta que se instrumenta). */
	model: string;
}

/** Resultado normalizado de una unidad (emitido en `onWorkerFinish`). */
export interface UnitResult {
	unitId: string;
	text: string;
	passed: boolean | null;
	kind: ResultKind;
}

/** Resumen de telemetría al cierre de la tarea (emitido en `onTaskCompleted`/`onTaskFailed`).
 *  `totalCost`/`totalTokens` son `null` cuando NO hubo telemetría fiable en NINGUNA vuelta
 *  (ni orquestador ni workers): en ese caso la UI debe representarlo explícitamente como
 *  desconocido y NO inventar un número (RNF-07/17). */
export interface TaskTelemetry {
	iterations: number;
	totalCost: number | null;
	totalTokens: number | null;
	startTs: number;
	endTs: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// WorkerEventSink: surface de eventos finos para el worker
// ──────────────────────────────────────────────────────────────────────────────

/** Bus de eventos de granularidad fina que el bucle pasa a `execute`. Cada método es opcional:
 *  el worker emite sólo los que sabe instrumentar (hoy: ninguno — la instrumentación llega en
 *  una iteración posterior; el contrato ya queda definido). */
export interface WorkerEventSink {
	onWorkerToolCall?: (tool: string, args: Record<string, unknown>) => void;
	onWorkerToolResult?: (tool: string, result: string, isError: boolean) => void;
	onVerificationStart?: (command: string) => void;
	onVerificationResult?: (verdict: "PASS" | "FAIL", output: string) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Contrato principal: AiesEventHandlers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Handlers del bucle AIES.
 *
 * - **Inyección obligatoria** (necesarios para que el bucle ejecute): `decide`, `execute`.
 * - **Eventos del bucle** (todos opcionales, `void`): se invocan en orden determinista
 *   a lo largo del ciclo Pensar/Decidir → Ejecutar → Observar → Verificar → Actualizar Estado.
 *   Ningún handler puede lanzar hacia el bucle: el bucle aísla errores con `safeObserve`-style
 *   guards para que un consumer que falle no rompa la correctitud.
 * - **Primitivas de control** (`onLimit`, `stopSignal`, `onLogEntry`, `onLoopObservation`, `onRaw`):
 *   se conservan del contrato anterior para no romper la instrumentación de log.jsonl ni
 *   el backstop de límites (ADR-005).
 */
export interface AiesEventHandlers {
	// ── Inyección obligatoria ─────────────────────────────────────────────────
	/** DecideFn: lee el estado, devuelve la decisión del orquestador. */
	decide: (state: RuntimeState) => Promise<DecideOutcome>;
	/** ExecuteFn: ejecuta la operación contra un worker. El `events` sink permite emitir
	 *  eventos finos (tool calls, verificación) desde dentro del worker. */
	execute: (state: RuntimeState, decision: Decision, events: WorkerEventSink) => Promise<ExecuteOutcome>;

	// ── Eventos del bucle (orden determinista) ───────────────────────────────
	/** Una vez al inicio, antes de la primera iteración. */
	onTaskStart?: (state: RuntimeState) => void;
	/** Antes de invocar `decide`. */
	onDecideStart?: (iteration: number) => void;
	/** Tras una decisión válida (post-parse OK). NO se emite en parse-fail. */
	onDecideSuccess?: (decision: OrchestratorDecision) => void;
	/** Antes de ejecutar una unidad (no se emite para `obtener información` / `comunicar`). */
	onWorkerStart?: (unit: WorkUnit, workerInfo: WorkerInfo) => void;
	/** Cuando el worker invoca una tool durante la ejecución de la unidad. */
	onWorkerToolCall?: (unitId: string, tool: string, args: Record<string, unknown>) => void;
	/** Cuando el worker recibe el resultado de una tool. */
	onWorkerToolResult?: (unitId: string, tool: string, result: string, isError: boolean) => void;
	/** Tras ejecutar una unidad — el bucle ya aplicó el resultado al estado. */
	onWorkerFinish?: (unitId: string, result: UnitResult) => void;
	/** Cuando el worker verifier arranca (cualquier tool/acción que valide la unidad). */
	onVerificationStart?: (unitId: string, command: string) => void;
	/** Cuando el worker verifier emite su veredicto final. */
	onVerificationResult?: (unitId: string, verdict: "PASS" | "FAIL", output: string) => void;
	/** Cuando la tarea alcanza `Completada`. */
	onTaskCompleted?: (summary: string, telemetry: TaskTelemetry) => void;
	/** Cuando la tarea alcanza `Fallida` o es abortada por stop-signal. */
	onTaskFailed?: (reason: string, error?: Error) => void;

	// ── Primitivas de control (compatibilidad) ───────────────────────────────
	/** Repertorio al alcanzar límite (ADR-005). Por defecto "intervenir". */
	onLimit?: (state: RuntimeState) => "intervenir" | "terminar" | Promise<"intervenir" | "terminar">;
	/** Intervención externa (Runtime §7). */
	stopSignal?: () => boolean;
	/** Entrada de log.jsonl — el log es un observability concern aparte del bus de eventos. */
	onLogEntry?: (entry: LogEntry) => void;
	/** Snapshots detallados del ciclo (decision:start, execution:resolved, etc.) para TUI/debug. */
	onLoopObservation?: (obs: LoopObservation) => void;
	/** Texto crudo del orquestador, útil para depuración. */
	onRaw?: (iter: number, raw: string) => void;
}
