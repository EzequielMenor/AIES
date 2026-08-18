// src/core/loop.ts — el bucle. AIES-core es el dueño (ADR-009); pi es sólo el motor inyectado.
// Dominio puro: decide/execute son interfaces inyectadas (DecideFn/ExecuteFn). El step 3 lo verifica
// con stubs in-memory (no pi); el step 5/6 las cablea contra pi. Parseo robusto (C3) y límites (ADR-005) viven aquí.

import type { WorkerTelemetry } from "../telemetry/types.js";
import { decisionEntry, resultEntry, serializeEntry, syntheticDecision, type LogEntry } from "../observability.js";
import {
	type Decision,
	type OperationResult,
	type Outcomes,
	type RuntimeState,
	type UnitState,
	applyAjustePlan,
	addKnownInfo,
	appendResult,
	markUnitState,
	setTerminal,
} from "./state.js";

export interface DecideOutcome {
	decision: Decision;
	telemetry: WorkerTelemetry;
	raw: string;
	parseFail: boolean;
	parseError?: string;
}

export interface ExecuteOutcome {
	result: OperationResult;
	telemetry: WorkerTelemetry;
	/** E-01A: marca experimental de atribución. Si está, el bucle la propaga a resultEntry
	 * para que metrics.ts sume tokens/coste al orquestador en lugar de a workers. */
	atribución?: "orquestador" | null;
}

/** Decide: orquestador (AgentSession noTools) lee el estado y emite decisión JSON. Inyectada. */
export type DecideFn = (state: RuntimeState) => Promise<DecideOutcome>;
/** Execute: ejecuta la operación (delega a worker capability según MVP-v0 §1). Inyectada. */
export type ExecuteFn = (state: RuntimeState, decision: Decision) => Promise<ExecuteOutcome>;

export interface LoopHooks {
	decide: DecideFn;
	execute: ExecuteFn;
	emit: (entry: LogEntry) => void;
	/** Repertorio al alcanzar límite (ADR-005): por defecto "intervenir". */
	onLimit?: (state: RuntimeState) => "intervenir" | "terminar";
	/** Intervención externa (Runtime §7): el desarrollador detiene → entra como resultado. */
	stopSignal?: () => boolean;
	/** Log(optional) del texto crudo del orquestador para depuración. */
	onRaw?: (iter: number, raw: string) => void;
}

function telemetryEmpty(): WorkerTelemetry {
	return { usage: null, contextUsage: null, telemetryUnavailable: true, reason: "sintético: sin vuelta de host" };
}

function applyOperationResult(state: RuntimeState, decision: Decision, result: OperationResult): RuntimeState {
	let s = state;
	if (decision.operación === "obtener información") {
		s = addKnownInfo(s, result.text);
	} else if (decision.operación === "ejecutar una unidad" && result.unidadId) {
		const estado: UnitState = result.kind === "fallo" ? "Fallida" : result.passed === false ? "Fallida" : "Terminada";
		s = markUnitState(s, result.unidadId, estado);
		s = addKnownInfo(s, result.text); // resultados intermedios son info para decidir, no ruido (P-13)
	}
	return s;
}

/**
 * Ejecuta el bucle sobre una tarea En curso hasta terminal (Completada/Fallida) o intervención.
 * Orden por turno (C3): aplica ajustePlan al estado ANTES de ejecutar la operación del mismo turno.
 * Parse fail (C3): no crash, no reinicio → tratar como info-insuficiente y reentrar; tope 3 → intervención.
 */
export async function runLoop(initial: RuntimeState, hooks: LoopHooks): Promise<RuntimeState> {
	let state = initial;

	// El bucle corre mientras la tarea no sea terminal (Recibida|En curso). La primera decisión
	// (determinar el proceso) aplica el ajustePlan que lleva Recibida→En curso (Lifecycle §5, applyAjustePlan).
	while (state.taskState === "Recibida" || state.taskState === "En curso") {
		// Intervención externa (Runtime §7) — se procesa como una entrada más (detención).
		if (hooks.stopSignal?.()) {
			hooks.emit(syntheticDecision(state.iterations, "comunicar al desarrollador", "intervención: detención por el desarrollador"));
			hooks.emit(resultEntry(state.iterations, { kind: "límite", text: "tarea detenida por intervención", unidadId: null, passed: null }, telemetryEmpty()));
			state = setTerminal(state, { execution: "fail", verification: "unknown", scope: "unknown" }, "intervención del desarrollador (detención)");
			break;
		}

		// Límite de iteraciones (ADR-005) — el backstop duro; pedir intervención por defecto.
		if (state.iterations >= state.limits.maxIterations) {
			const action = hooks.onLimit?.(state) ?? "intervenir";
			if (action === "intervenir") {
				// ADR-005: "pedir intervención" es la respuesta por defecto — NO falla la tarea:
				// queda En curso y reanudable; observable (RNF-19), nunca continuación silenciosa.
				hooks.emit(syntheticDecision(state.iterations, "comunicar al desarrollador", `límite de iteraciones alcanzado (${state.limits.maxIterations})`));
				hooks.emit(resultEntry(state.iterations, { kind: "límite", text: `intervención requerida: límite de iteraciones (${state.limits.maxIterations})`, unidadId: null, passed: null }, telemetryEmpty(), `iteraciones=${state.limits.maxIterations}`));
				state = { ...state, nextStep: `intervención requerida: límite de iteraciones (${state.limits.maxIterations})` };
				break;
			}
			// action === "terminar": terminación controlada por límite (pérdida de trabajo conservada).
			hooks.emit(syntheticDecision(state.iterations, "terminar", `terminación controlada por límite de iteraciones (${state.limits.maxIterations})`));
			state = setTerminal(state, { execution: "fail", verification: "unknown", scope: "unknown" }, `terminación controlada: límite de iteraciones (${state.limits.maxIterations})`);
			hooks.emit(resultEntry(state.iterations, { kind: "terminación", text: state.terminalCondition ?? "límite", unidadId: null, passed: false }, telemetryEmpty()));
			break;
		}

		const turn = await hooks.decide(state);
		if (hooks.onRaw) hooks.onRaw(state.iterations, turn.raw);

		if (turn.parseFail) {
			// C3: no crash, no reinicio → reentrada con el estado (info-insuficiente). Tope 3 → pedir intervención.
			// La telemetría de la vuelta del orquestador se conserva incluso en fallo de parseo (RNF-17: coste por orquestador).
			state = { ...state, consecutiveParseFailures: state.consecutiveParseFailures + 1 };
			hooks.emit(syntheticDecision(state.iterations, "obtener información", turn.parseError ?? "salida del orquestador no parseable", true, turn.telemetry));
			if (state.consecutiveParseFailures >= 3) {
				hooks.emit(resultEntry(state.iterations, { kind: "parse_error", text: "intervención requerida: 3 fallos consecutivos de parseo", unidadId: null, passed: null }, telemetryEmpty()));
				state = { ...state, nextStep: "intervención requerida: 3 fallos de parseo consecutivos del orquestador" };
				break; // En curso → reanudable tras intervención (no Fallida: el desarrollador ajusta y resume)
			}
			continue; // reentrar: el estado ya registra el fallo de formato
		}

		// Decisión válida: reset de fallos de parseo + aplicar plan ANTES de operación (C3 orden por turno).
		state = { ...state, consecutiveParseFailures: 0 };
		state = applyAjustePlan(state, turn.decision.ajustePlan);
		hooks.emit(decisionEntry(state.iterations, turn.decision, false, turn.telemetry));

		const out = await hooks.execute(state, turn.decision);
		state = applyOperationResult(state, turn.decision, out.result);
		state = appendResult(state, out.result);
		state = { ...state, iterations: state.iterations + 1 };
		hooks.emit(resultEntry(state.iterations, out.result, out.telemetry, null, out.atribución ?? null));

		if (turn.decision.operación === "terminar") {
			// Outcomes (Fix 3): execution preserva la semántica original (terminación declarada y
			// no-inviable). verification agrega state.results de unidades previas con passed≠null
			// (pass=todas true, fail=alguna false, unknown=sin unidades). scope siempre unknown.
			const execution: Outcomes["execution"] =
				out.result.kind === "terminación" && out.result.passed !== false ? "success" : "fail";
			const verifierResults = state.results.filter((r) => r.kind === "unidad" && r.passed !== null);
			const verification: Outcomes["verification"] =
				verifierResults.length === 0
					? "unknown"
					: verifierResults.some((r) => r.passed === false)
						? "fail"
						: verifierResults.every((r) => r.passed === true)
							? "pass"
							: "unknown";
			const outcomes: Outcomes = { execution, verification, scope: "unknown" };
			state = setTerminal(state, outcomes, turn.decision.condición ?? "terminación");
			break;
		}
		// obtener información / ejecutar una unidad / comunicar: devuelven el control al bucle.
	}

	return state;
}

/** Serializa una lista de entradas a texto .jsonl (append-only). Útil para tests y dump. */
export function dumpJsonl(entries: LogEntry[]): string {
	return entries.map(serializeEntry).join("\n") + (entries.length ? "\n" : "");
}