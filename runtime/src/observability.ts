// src/observability.ts — forma de las entradas de log.jsonl (Decision-Model.md §11, MVP-v0-Scope §8).
// Dominio puro. `log.jsonl` es el único artefacto de observabilidad y el dataset de `06-research` (ADR-008).
// Una línea = un objeto JSON; append-only. Por vuelta: una entrada decisión + una entrada resultado (cuando hay operación).

import type { AjustePlan, Capability, CommunicationRequest, Decision, Operation, OperationResult, ResultKind, TerminationCondition, UnitRef } from "./core/state.js";
import type { CompactionObservation, ContextUsage, TelemetryUsage, WorkerTelemetry } from "./telemetry/types.js";

export interface DecisionLogEntry {
	type: "decision";
	iter: number;
	operación: Operation;
	ajustePlan: AjustePlan | null;
	motivo: string;
	unidad: UnitRef | null;
	capacidad: Capability | null;
	condición: TerminationCondition | null;
	parseFail: boolean;
	/** Telemetría de la vuelta del orquestador (ADR-009/RNF-17: usage por orquestador). Ausente en entradas sintéticas sin vuelta de host. */
	usage?: TelemetryUsage | null;
	contextUsage?: ContextUsage | null;
	telemetryUnavailable?: boolean;
	telemetryReason?: string | null;
	/** Modelo con el que ejecutó el orquestador en esta vuelta (`provider/model-id`). Opcional:
	 *  ausente en tests y en entradas sintéticas. Prueba de model-per-role en el log. */
	modelo?: string | null;
	/** Marca temporal (ISO) al emitir; instrumentación de tiempo de AIES-core (NFR §3, 06-research). Opcional: ausente en tests. */
	ts?: string;
}

export interface ResultLogEntry {
	type: "resultado";
	iter: number;
	resultado: string;
	kind: ResultKind;
	unidadId: string | null;
	usage: TelemetryUsage | null;
	contextUsage: ContextUsage | null;
	telemetryUnavailable: boolean;
	telemetryReason: string | null;
	límite_alcanzado: string | null;
	/** E-01A: marca experimental. Si vale "orquestador", metrics.ts atribuye los tokens/coste
	 * de esta entrada al orquestador (sesión local efímera, sin frontera de delegación). Ausente
	 * en modo normal. */
	atribución?: "orquestador" | null;
	/** Modelo con que ejecutó el worker de esta unidad (`provider/model-id`). Prueba de
	 *  model-per-role en el log. Opcional: ausente en callers antiguos. */
	modelo?: string | null;
	/** Marca temporal (ISO) al emitir; instrumentación de tiempo de AIES-core (NFR §3, 06-research). Opcional: ausente en tests. */
	ts?: string;
}

/**
 * Entrada de compactación del host (RNF-18/19). No es una vuelta del bucle: es un
 * acontecimiento de contexto (threshold/overflow/manual) que ocurre durante un turno
 * y deja huella del techo de contexto aplicado (reconstrucción RNF-11).
 */
export interface CompactionLogEntry {
	type: "compaction";
	fase: "start" | "end";
	reason: string;
	summary: string | null;
	firstKeptEntryId: string | null;
	tokensBefore: number | null;
	estimatedTokensAfter: number | null;
	aborted: boolean | null;
	willRetry: boolean | null;
	errorMessage: string | null;
	/** Marca temporal (ISO) al emitir; instrumentación de tiempo de AIES-core (NFR §3, 06-research). Opcional: ausente en tests. */
	ts?: string;
}

/**
 * Entrada de traza de tools de un worker (v0.5 Caja de cristal — Tool trace). Una entrada por
 * tool-execution completada: herramienta, argumentos relevantes, target, archivos leídos/
 * modificados, resumen del resultado y error si existe. El detalle completo vive aquí
 * (inspección bajo demanda vía `/trace`); la vista principal muestra sólo el resumen.
 */
export interface ToolTraceLogEntry {
	type: "tool";
	iter: number;
	unidadId: string | null;
	capacidad: string | null;
	herramienta: string;
	args: Record<string, unknown>;
	target: string | null;
	archivos_leidos: string[];
	archivos_modificados: string[];
	/** Resumen de UNA línea del resultado (o del mensaje de error). */
	resumen: string;
	/** Resultado crudo acotado (evidencia para `/trace`/inspección; no se pinta en la vista). */
	detalle: string;
	error: boolean;
	/** Marca temporal (ISO) al cerrar la tool-execution. */
	ts?: string;
}

export type LogEntry = DecisionLogEntry | ResultLogEntry | CompactionLogEntry | ToolTraceLogEntry;

export function serializeEntry(entry: LogEntry): string {
	return JSON.stringify(entry);
}

function telemetryFields(telemetry: WorkerTelemetry): Pick<DecisionLogEntry, "usage" | "contextUsage" | "telemetryUnavailable" | "telemetryReason"> {
	return {
		usage: telemetry.usage,
		contextUsage: telemetry.contextUsage,
		telemetryUnavailable: telemetry.telemetryUnavailable,
		telemetryReason: telemetry.reason ?? null,
	};
}

export function decisionEntry(iter: number, decision: Decision, parseFail = false, telemetry?: WorkerTelemetry, modelo?: string | null): DecisionLogEntry {
	return {
		type: "decision",
		iter,
		operación: decision.operación,
		ajustePlan: decision.ajustePlan ?? null,
		motivo: decision.motivo,
		unidad: decision.unidad ?? null,
		capacidad: null,
		condición: decision.condición ?? null,
		parseFail,
		...(telemetry ? telemetryFields(telemetry) : {}),
		...(modelo ? { modelo } : {}),
	};
}

export function resultEntry(
	iter: number,
	result: OperationResult,
	telemetry: WorkerTelemetry,
	límiteAlcanzado: string | null = null,
	atribución: "orquestador" | null = null,
	modelo?: string | null,
): ResultLogEntry {
	return {
		type: "resultado",
		iter: iter,
		resultado: result.text,
		kind: result.kind,
		unidadId: result.unidadId,
		usage: telemetry.usage,
		contextUsage: telemetry.contextUsage,
		telemetryUnavailable: telemetry.telemetryUnavailable,
		telemetryReason: telemetry.reason ?? null,
		límite_alcanzado: límiteAlcanzado,
		atribución,
		...(modelo ? { modelo } : {}),
	};
}

/** Entrada artificial para sendas sin operación ejecutada (parse fail reentrante / límite / intervención). */
export function syntheticDecision(
	iter: number,
	operación: Operation,
	motivo: string,
	parseFail = false,
	telemetry?: WorkerTelemetry,
): DecisionLogEntry {
	return {
		type: "decision",
		iter,
		operación,
		ajustePlan: null,
		motivo,
		unidad: null,
		capacidad: null,
		condición: null,
		parseFail,
		...(telemetry ? telemetryFields(telemetry) : {}),
	};
}

/** Entrada de traza de tool (Tool trace): proyección de un `ToolTraceRecord` del recorder a log.jsonl. */
export function toolTraceEntry(r: import("./core/tool-trace.js").ToolTraceRecord): ToolTraceLogEntry {
	return {
		type: "tool",
		iter: r.iter,
		unidadId: r.unidadId,
		capacidad: r.capacidad,
		herramienta: r.herramienta,
		args: r.args,
		target: r.target,
		archivos_leidos: r.leidos,
		archivos_modificados: r.modificados,
		resumen: r.resumen,
		detalle: r.detalle,
		error: r.error,
		ts: r.ts,
	};
}

/** Entrada de compactación del host (RNF-18/19): observación del techo de contexto aplicado. */
export function compactionEntry(obs: CompactionObservation): CompactionLogEntry {
	return {
		type: "compaction",
		fase: obs.fase,
		reason: obs.reason,
		summary: obs.summary,
		firstKeptEntryId: obs.firstKeptEntryId,
		tokensBefore: obs.tokensBefore,
		estimatedTokensAfter: obs.estimatedTokensAfter,
		aborted: obs.aborted,
		willRetry: obs.willRetry,
		errorMessage: obs.errorMessage,
	};
}