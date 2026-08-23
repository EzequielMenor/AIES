// src/core/loop.ts — el bucle. AIES-core es el dueño (ADR-009); pi es sólo el motor inyectado.
//
// P-02: el bucle es 100% puro. Toda interacción con el exterior ocurre vía el bus de eventos
// tipado definido en `./events.ts` (AiesEventHandlers). El bucle no importa nada de UI/TUI/console:
// decide/execute son interfaces inyectadas; las primitivas de control (onLimit, stopSignal) y los
// callbacks de log (onLogEntry, onLoopObservation, onRaw) se exponen como parte del mismo contrato.
//
// Orden por turno (C3): aplica ajustePlan al estado ANTES de ejecutar la operación del mismo turno.
// Parse fail (C3): no crash, no reinicio → tratar como info-insuficiente y reentrar; tope 3 → intervención.

import type { AiesEventHandlers, TaskTelemetry, UnitResult, WorkerEventSink, WorkerInfo } from "./events.js";
import { type ObservationHook, safeObserve } from "./observation.js";
import { decisionEntry, resultEntry, syntheticDecision, type LogEntry } from "../observability.js";
import type { WorkerTelemetry, TelemetryUsage } from "../telemetry/types.js";
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

/** Construye un sink vacío (todos los callbacks son no-op) para `execute` cuando el handler
 *  no implementa eventos de granularidad fina. */
function emptyWorkerSink(): WorkerEventSink {
	return {};
}

/** Helper interno: crea un `WorkerEventSink` que despacha a los handlers del bucle, prefijando
 *  el `unitId` que el bucle conoce. Si un handler no está, el callback correspondiente queda
 *  como no-op. */
function buildWorkerSink(handlers: AiesEventHandlers, unitId: string): WorkerEventSink {
	const sink: WorkerEventSink = {};
	if (handlers.onWorkerToolCall) {
		const cb = handlers.onWorkerToolCall;
		sink.onWorkerToolCall = (tool, args) => safeCallback(() => cb(unitId, tool, args));
	}
	if (handlers.onWorkerToolResult) {
		const cb = handlers.onWorkerToolResult;
		sink.onWorkerToolResult = (tool, result, isError) => safeCallback(() => cb(unitId, tool, result, isError));
	}
	if (handlers.onVerificationStart) {
		const cb = handlers.onVerificationStart;
		sink.onVerificationStart = (command) => safeCallback(() => cb(unitId, command));
	}
	if (handlers.onVerificationResult) {
		const cb = handlers.onVerificationResult;
		sink.onVerificationResult = (verdict, output) => safeCallback(() => cb(unitId, verdict, output));
	}
	return sink;
}

/** Despacha un callback tipado a través de un try/catch — un consumer que falle no rompe el bucle. */
function safeCallback(fn: () => void): void {
	try {
		fn();
	} catch {
		/* un handler que falla no rompe el bucle (P-02: el bus es fire-and-forget) */
	}
}

/** Despacha un evento del bucle de forma segura. */
function emit(handlers: AiesEventHandlers, name: keyof AiesEventHandlers, fn: () => void): void {
	if (typeof handlers[name] !== "function") return;
	safeCallback(fn);
}

/** Suma métricas de telemetría de una vuelta (orquestador) o de una operación (worker) sobre el
 *  acumulador global del bucle. `null` cuando esa vuelta no reportó usage fiable: se conserva el
 *  acumulado previo (el coste conocido nunca se pierde por una vuelta sin telemetría). */
type TelemetryAccumulator = { totalCost: number; totalTokens: number; known: boolean };
function accUsage(acc: TelemetryAccumulator, usage: TelemetryUsage | null | undefined): void {
	if (!usage) return;
	acc.totalCost += usage.cost;
	acc.totalTokens += usage.tokens.total;
	acc.known = true;
}

/** Serializa el acumulador de telemetría a TaskTelemetry (null si nada es conocido). */
function telemetryToTask(acc: TelemetryAccumulator, iterations: number, startTs: number, endTs: number): TaskTelemetry {
	return {
		iterations,
		totalCost: acc.known ? acc.totalCost : null,
		totalTokens: acc.known ? acc.totalTokens : null,
		startTs,
		endTs,
	};
}

/**
 * Ejecuta el bucle sobre una tarea En curso hasta terminal (Completada/Fallida) o intervención.
 * Devuelve el `RuntimeState` final.
 *
 * Eventos emitidos (en orden, sobre `handlers`):
 *   1. `onTaskStart(state)` — una vez, antes del primer turno.
 *   2. Por turno: `onDecideStart(iter)` → `decide` → `onDecideSuccess(decision)` → `execute` →
 *      `onWorkerStart`/`onWorkerFinish` (si ejecutó una unidad) → `onTaskCompleted`/`onTaskFailed` (si terminó).
 */
export async function runLoop(initial: RuntimeState, handlers: AiesEventHandlers): Promise<RuntimeState> {
	let state = initial;
	const startTs = Date.now();
	// Acumulador global de telemetría (RNF-07/17): suma coste/tokens de orquestador + workers a lo
	// largo de TODOS los turnos (incluidos parse-fails, cuya vuelta de orquestador sí se factura).
	const telemetryAcc: TelemetryAccumulator = { totalCost: 0, totalTokens: 0, known: false };
	const observe: ObservationHook | undefined = handlers.onLoopObservation
		? (obs) => safeCallback(() => handlers.onLoopObservation?.(obs))
		: undefined;
	const emitLog: (entry: LogEntry) => void = handlers.onLogEntry
		? (entry) => safeCallback(() => handlers.onLogEntry?.(entry))
		: () => undefined;

	emit(handlers, "onTaskStart", () => handlers.onTaskStart?.(state));

	while (state.taskState === "Recibida" || state.taskState === "En curso") {
		// Intervención externa (Runtime §7, ADR-012) — el desarrollador detuvo el run (ESC en REPL o
		// SIGINT). La tarea QUEDA PAUSADA, no Fallida: `taskState` intacto, `nextStep` marcador,
		// `Fallida` se reserva para inviabilidad y terminación controlada por límite. Reanudable
		// con /resume (estado persistido por el caller en runCycle::saveState).
		if (handlers.stopSignal?.()) {
			emitLog(syntheticDecision(state.iterations, "comunicar al desarrollador", "intervención: detención solicitada por el desarrollador"));
			emitLog(resultEntry(state.iterations, { kind: "intervención", text: "tarea pausada por el desarrollador", unidadId: null, passed: null }, telemetryEmpty()));
			safeObserve(observe, { phase: "intervention:paused", state });
			state = { ...state, nextStep: "pausada por el desarrollador — reanudable con /resume" };
			break;
		}

		// Ajuste en caliente (T2.1) — se aplica al inicio del turno, antes de la decisión. No
		// aborta el worker en curso; la guía se incorpora al estado (Runtime §7) y el
		// orquestador la ve en la siguiente decisión. Un handler que falle no rompe el bucle.
		if (handlers.pollIntervention) {
			let adj: { text: string } | null | undefined;
			try {
				adj = await handlers.pollIntervention();
			} catch {
				/* un poll que lanza no rompe el bucle */
				adj = null;
			}
			const text = adj?.text?.trim();
			if (text) {
				const result: OperationResult = { kind: "intervención", text, unidadId: null, passed: null };
				state = appendResult(state, result);
				state = addKnownInfo(state, `intervención del desarrollador: ${text}`);
				emitLog(resultEntry(state.iterations, result, telemetryEmpty()));
				safeObserve(observe, { phase: "intervention:adjustment", state, text });
			}
		}

		// Límite de iteraciones (ADR-005) — el backstop duro; pedir intervención por defecto.
		if (state.iterations >= state.limits.maxIterations) {
			const action = (await handlers.onLimit?.(state)) ?? "intervenir";
			safeObserve(observe, {
				phase: "limit:reached",
				state,
				action,
				reason: `límite de iteraciones alcanzado (${state.limits.maxIterations})`,
			});
			if (action === "intervenir") {
				// ADR-005: "pedir intervención" es la respuesta por defecto — NO falla la tarea:
				// queda En curso y reanudable; observable (RNF-19), nunca continuación silenciosa.
				emitLog(syntheticDecision(state.iterations, "comunicar al desarrollador", `límite de iteraciones alcanzado (${state.limits.maxIterations})`));
				emitLog(resultEntry(state.iterations, { kind: "límite", text: `intervención requerida: límite de iteraciones (${state.limits.maxIterations})`, unidadId: null, passed: null }, telemetryEmpty(), `iteraciones=${state.limits.maxIterations}`));
				state = { ...state, nextStep: `intervención requerida: límite de iteraciones (${state.limits.maxIterations})` };
				break;
			}
			// action === "terminar": terminación controlada por límite (pérdida de trabajo conservada).
			emitLog(syntheticDecision(state.iterations, "terminar", `terminación controlada por límite de iteraciones (${state.limits.maxIterations})`));
			state = setTerminal(state, { execution: "fail", verification: "unknown", scope: "unknown" }, `terminación controlada: límite de iteraciones (${state.limits.maxIterations})`);
			emitLog(resultEntry(state.iterations, { kind: "terminación", text: state.terminalCondition ?? "límite", unidadId: null, passed: false }, telemetryEmpty()));
			safeObserve(observe, { phase: "terminated", state, reason: state.terminalCondition ?? "límite" });
			emit(handlers, "onTaskFailed", () => {
				const reason = state.terminalCondition ?? "límite";
				handlers.onTaskFailed?.(reason);
			});
			break;
		}

		safeObserve(observe, { phase: "decision:start", state });
		emit(handlers, "onDecideStart", () => handlers.onDecideStart?.(state.iterations));

		const turn = await handlers.decide(state);
		accUsage(telemetryAcc, turn.telemetry.usage);
		if (handlers.onRaw) safeCallback(() => handlers.onRaw?.(state.iterations, turn.raw));

		if (turn.parseFail) {
			// C3: no crash, no reinicio → reentrada con el estado (info-insuficiente). Tope 3 → pedir intervención.
			// La telemetría de la vuelta del orquestador se conserva incluso en fallo de parseo (RNF-17: coste por orquestador).
			state = { ...state, consecutiveParseFailures: state.consecutiveParseFailures + 1 };
			safeObserve(observe, {
				phase: "decision:resolved",
				state,
				decision: null,
				parseFail: true,
				parseError: turn.parseError ?? "salida del orquestador no parseable",
				raw: turn.raw,
				telemetry: turn.telemetry,
			});
			emitLog(syntheticDecision(state.iterations, "obtener información", turn.parseError ?? "salida del orquestador no parseable", true, turn.telemetry));
			if (state.consecutiveParseFailures >= 3) {
				emitLog(resultEntry(state.iterations, { kind: "parse_error", text: "intervención requerida: 3 fallos consecutivos de parseo", unidadId: null, passed: null }, telemetryEmpty()));
				state = { ...state, nextStep: "intervención requerida: 3 fallos de parseo consecutivos del orquestador" };
				break; // En curso → reanudable tras intervención (no Fallida: el desarrollador ajusta y resume)
			}
			continue; // reentrar: el estado ya registra el fallo de formato
		}

		// Decisión válida: reset de fallos de parseo + aplicar plan ANTES de operación (C3 orden por turno).
		state = { ...state, consecutiveParseFailures: 0 };
		state = applyAjustePlan(state, turn.decision.ajustePlan);
		safeObserve(observe, {
			phase: "decision:resolved",
			state,
			decision: turn.decision,
			parseFail: false,
			parseError: null,
			raw: turn.raw,
			telemetry: turn.telemetry,
		});
		emitLog(decisionEntry(state.iterations, turn.decision, false, turn.telemetry));
		emit(handlers, "onDecideSuccess", () => handlers.onDecideSuccess?.(turn.decision));

		// onWorkerStart: si vamos a ejecutar una unidad, anunciamos al worker antes de invocarlo.
		// Invariancia de IDs: la decisión debe referenciar una unidad que exista en el estado.
		// Si referencia una inexistente → NO fallback silencioso a otra unidad, NO ejecución de
		// una unidad distinta. Se registra el error y se re-emite el turno al orquestador para
		// que corrija (p.ej. emitir primero `determinar el proceso` con la unidad en su plan).
		// El límite de iteraciones evita bucles infinitos si el orquestador no corrige.
		let workerUnit: RuntimeState["units"][number] | undefined;
		if (turn.decision.operación === "ejecutar una unidad" && turn.decision.unidad) {
			const targetId = turn.decision.unidad;
			workerUnit = state.units.find((u) => u.id === targetId);
			if (!workerUnit) {
				const reason = `decisión referencia una unidad inexistente: ${targetId}`;
				const failResult: OperationResult = { kind: "fallo", text: reason, unidadId: targetId, passed: false };
				safeObserve(observe, { phase: "error:unidad-inexistente", state, decision: turn.decision });
				emitLog(resultEntry(state.iterations, failResult, turn.telemetry));
				state = appendResult(state, failResult);
				state = { ...state, iterations: state.iterations + 1, nextStep: reason };
				continue;
			}
			const workerInfo: WorkerInfo = {
				role: workerUnit.capacidad,
				model: "unknown", // se rellenará cuando se instrumenten los modelos por capability
			};
			emit(handlers, "onWorkerStart", () => handlers.onWorkerStart?.(workerUnit!, workerInfo));
		}

		safeObserve(observe, { phase: "execution:start", state, decision: turn.decision });
		const sink = workerUnit ? buildWorkerSink(handlers, workerUnit.id) : emptyWorkerSink();
		const out = await handlers.execute(state, turn.decision, sink);
		accUsage(telemetryAcc, out.telemetry.usage);
		state = applyOperationResult(state, turn.decision, out.result);
		state = appendResult(state, out.result);
		state = { ...state, iterations: state.iterations + 1 };
		safeObserve(observe, {
			phase: "execution:resolved",
			state,
			decision: turn.decision,
			result: out.result,
			telemetry: out.telemetry,
			atribución: out.atribución ?? null,
		});
		emitLog(resultEntry(state.iterations, out.result, out.telemetry, null, out.atribución ?? null));

		// onWorkerFinish: tras ejecutar una unidad, informamos del resultado normalizado.
		if (turn.decision.operación === "ejecutar una unidad" && turn.decision.unidad) {
			const unitId = turn.decision.unidad;
			const unitResult: UnitResult = {
				unitId,
				text: out.result.text,
				passed: out.result.passed,
				kind: out.result.kind,
			};
			emit(handlers, "onWorkerFinish", () => handlers.onWorkerFinish?.(unitId, unitResult));
		}

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
			safeObserve(observe, {
				phase: "terminated",
				state,
				reason: turn.decision.condición ?? "terminación",
			});

			// onTaskCompleted / onTaskFailed — el taskState final ya está decidido por setTerminal.
			const endTs = Date.now();
			const telemetry: TaskTelemetry = telemetryToTask(telemetryAcc, state.iterations, startTs, endTs);
			if (state.taskState === "Completada") {
				emit(handlers, "onTaskCompleted", () => {
					const summary = state.terminalCondition ?? "tarea completada";
					handlers.onTaskCompleted?.(summary, telemetry);
				});
			} else {
				emit(handlers, "onTaskFailed", () => {
					const reason = state.terminalCondition ?? "tarea fallida";
					handlers.onTaskFailed?.(reason);
				});
			}
			break;
		}
		// obtener información / ejecutar una unidad / comunicar: devuelven el control al bucle.
	}

	return state;
}

/** Serializa una lista de entradas a texto .jsonl (append-only). Útil para tests y dump. */
export function dumpJsonl(entries: LogEntry[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}
