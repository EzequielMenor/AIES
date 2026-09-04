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
	CommunicationRequest,
	Decision,
	OperationResult,
	ResultKind,
	RuntimeState,
	WorkUnit,
	WorkerReport,
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
	/** Reporte estructurado del worker (plan §3 — worker contract). Opcional; el bucle lo
	 *  normaliza (unsatisfied si ausente). */
	report?: WorkerReport | null;
	/** Texto del error de parseo del reporte (cuando `report` es null por fallo del worker). */
	reportError?: string | null;
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
	/** Verificación determinista (checks reales del proyecto): una línea por comando, sin LLM. */
	onDeterministicCheckStart?: (name: string, command: string) => void;
	onDeterministicCheckResult?: (name: string, command: string, passed: boolean, failure: string) => void;
	/** Ciclo de reparación automática del implementer tras un fallo determinista. */
	onRepairAttempt?: (attempt: number, maxAttempts: number) => void;
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
/** Ajuste en caliente (T2.1): el desarrollador incorpora una guía al estado en curso.
 *  El bucle la aplica al inicio del siguiente turno como un resultado más
 *  (Runtime-Model §7); el orquestador la ve en `knownInfo`/`results` en la siguiente decisión. */
export interface InterventionAdjustment {
	text: string;
}

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
	/** Resuelve la etiqueta `provider/model` real del rol (model-per-role). El bucle la usa para
	 *  poblar `WorkerInfo.model`, el campo `modelo` de log.jsonl (turno de orquestador incluido)
	 *  y así dejar prueba del modelo con que ejecutó cada rol. Ausente ⇒ "unknown" (comportamiento previo). */
	resolveWorkerModel?: (role: "orchestrator" | Capability) => string | undefined;
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
	/** Verificación determinista (sin LLM): inicio de un check del proyecto. */
	onDeterministicCheckStart?: (unitId: string, name: string, command: string) => void;
	/** Verificación determinista: resultado de un check (failure = salida relevante si falla). */
	onDeterministicCheckResult?: (unitId: string, name: string, command: string, passed: boolean, failure: string) => void;
	/** Inicio de un ciclo de reparación automática del implementer (attempt 1-based). */
	onRepairAttempt?: (unitId: string, attempt: number, maxAttempts: number) => void;
	/** Cuando la tarea alcanza `Completada`. */
	onTaskCompleted?: (summary: string, telemetry: TaskTelemetry) => void;
	/** Cuando la tarea alcanza `Fallida` (inviabilidad / terminación controlada por límite). La
	 *  pausa por intervención del desarrollador (ADR-012) ya NO pasa por aquí — el bucle conserva
	 *  `taskState` intacto y emite `intervention:paused` vía `onLoopObservation`. */
	onTaskFailed?: (reason: string, error?: Error) => void;

	// ── Primitivas de control (compatibilidad) ───────────────────────────────
	/** Repertorio al alcanzar límite (ADR-005). Por defecto "intervenir". */
	onLimit?: (state: RuntimeState) => "intervenir" | "terminar" | Promise<"intervenir" | "terminar">;
	/** Intervención externa (Runtime §7). */
	stopSignal?: () => boolean;
	/** Ajuste en caliente (T2.1): el bucle lo consulta al inicio de cada turno. Si devuelve
	 *  un ajuste no vacío, lo incorpora al estado como un resultado `intervención` + `knownInfo`
	 *  antes de la siguiente decisión. Un handler que lance se aísla con safeCallback. */
	pollIntervention?: () => InterventionAdjustment | null | Promise<InterventionAdjustment | null>;
	/** Entrada de log.jsonl — el log es un observability concern aparte del bus de eventos. */
	onLogEntry?: (entry: LogEntry) => void;
	/** Snapshots detallados del ciclo (decision:start, execution:resolved, etc.) para TUI/debug. */
	onLoopObservation?: (obs: LoopObservation) => void;
	/** Texto crudo del orquestador, útil para depuración. */
	onRaw?: (iter: number, raw: string) => void;
	/** Checkpoint atómico del estado (plan §4 — paso 8, invariante 3). Si lanza, el bucle
	 *  aborta la ejecución del worker para ese turno. La persistencia (writeAtomic) debe ser
	 *  síncrona; el handler puede ser async pero el bucle espera antes de invocar execute. */
	checkpoint?: (state: RuntimeState, motivo: string) => void | Promise<void>;
	/** Notificación de espera humana activa (cambio a `RunStatus.waiting_for_user`). La UI/TUI
	 *  debe mostrar `request.pregunta`/`request.razón` y dejar de invocar el orquestador hasta
	 *  recibir la respuesta. */
	onHumanWait?: (request: CommunicationRequest) => void;
}
