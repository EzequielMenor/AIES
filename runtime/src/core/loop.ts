// src/core/loop.ts — el bucle. AIES-core es el dueño (ADR-009); pi es sólo el motor inyectado.
//
// Plan §4 (orden estricto del runtime). Cambio de fase v1→v2:
//   - Rechazar entrada si `runStatus` no es `ready` (invariante 9 — pedir input detiene el loop).
//   - Checkpoint atómico ANTES de ejecutar la unidad (invariante 3 — toda mutación se
//     checkpointa antes de tocar el proyecto).
//   - UnitRef resuelto desde `createdUnitIds`; capacidad = unidad canónica (invariante 4).
//   - Worker recibe contrato completo (Task + WorkUnit + requisitos + criterios + infoNecesaria).
//   - Reporte estructurado del worker alimenta `verification` (invariante 8 — Sustituida no
//     contamina).
//   - Comunicación bloqueante → waiting_for_user, no invoca execute (invariante 9).
//   - No-progress counter (presupuesto consecutivo, default 3).
//   - Terminación estricta: todas las unidades activas deben estar Terminada + verificación
//     pass para Completada.

import type { AiesEventHandlers, TaskTelemetry, UnitResult, WorkerEventSink, WorkerInfo } from "./events.js";
import { type ObservationHook, safeObserve } from "./observation.js";
import { decisionEntry, resultEntry, syntheticDecision, type LogEntry } from "../observability.js";
import type { WorkerTelemetry, TelemetryUsage } from "../telemetry/types.js";
import {
	type AjustePlanOutcome,
	type CommunicationRequest,
	type Capability,
	type Decision,
	type OperationResult,
	type Outcomes,
	type RuntimeState,
	type UnitState,
	type WorkerReport,
	activeUnits,
	addKnownInfo,
	appendResult,
	applyAjustePlan,
	computeOutcomes,
	markUnitEnCurso,
	markUnitState,
	resolveUnitRef,
	setTerminal,
} from "./state.js";

function telemetryEmpty(): WorkerTelemetry {
	return { usage: null, contextUsage: null, telemetryUnavailable: true, reason: "sintético: sin vuelta de host" };
}

/** Contrato de checkpoint: el handler persiste el estado. Si lanza, la mutación de plan NO
 *  se ejecuta (invariante 3 — toda mutación se checkpointa antes de tocar el proyecto). */
type CheckpointFn = (state: RuntimeState, motivo: string) => Promise<void> | void;

/** Lee un checkpoint del handler o usa uno no-op (tests). */
function checkpointFrom(handlers: AiesEventHandlers): CheckpointFn {
	const cp = handlers.checkpoint;
	if (!cp) return () => undefined;
	return async (state, motivo) => cp(state, motivo);
}

function applyOperationResult(state: RuntimeState, decision: Decision, result: OperationResult): RuntimeState {
	let s = state;
	if (decision.operación === "obtener información") {
		s = addKnownInfo(s, result.text);
	} else if (decision.operación === "ejecutar una unidad" && result.unidadId) {
		const estado: UnitState = result.kind === "fallo" ? "Fallida" : result.passed === false ? "Fallida" : "Terminada";
		s = markUnitState(s, result.unidadId, estado);
	}
	return s;
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
	if (handlers.onDeterministicCheckStart) {
		const cb = handlers.onDeterministicCheckStart;
		sink.onDeterministicCheckStart = (name, command) => safeCallback(() => cb(unitId, name, command));
	}
	if (handlers.onDeterministicCheckResult) {
		const cb = handlers.onDeterministicCheckResult;
		sink.onDeterministicCheckResult = (name, command, passed, failure) => safeCallback(() => cb(unitId, name, command, passed, failure));
	}
	if (handlers.onRepairAttempt) {
		const cb = handlers.onRepairAttempt;
		sink.onRepairAttempt = (attempt, max) => safeCallback(() => cb(unitId, attempt, max));
	}
	return sink;
}

function emptyWorkerSink(): WorkerEventSink {
	return {};
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

type TelemetryAccumulator = { totalCost: number; totalTokens: number; known: boolean };
function accUsage(acc: TelemetryAccumulator, usage: TelemetryUsage | null | undefined): void {
	if (!usage) return;
	acc.totalCost += usage.cost;
	acc.totalTokens += usage.tokens.total;
	acc.known = true;
}

function telemetryToTask(acc: TelemetryAccumulator, iterations: number, startTs: number, endTs: number): TaskTelemetry {
	return {
		iterations,
		totalCost: acc.known ? acc.totalCost : null,
		totalTokens: acc.known ? acc.totalTokens : null,
		startTs,
		endTs,
	};
}

function unitSignature(unit: RuntimeState["units"][number]): string {
	return JSON.stringify({
		objetivo: unit.objetivo,
		alcance: unit.alcance,
		resultadoEsperado: unit.resultadoEsperado,
		condicionFinalizacion: unit.condicionFinalizacion,
		capacidad: unit.capacidad,
		requisitos: unit.requisitos ?? [],
		criteriosAceptacion: unit.criteriosAceptacion ?? [],
	});
}

/** Un replan sólo cuenta si cambia realmente la unidad sustituida, no si la repite. */
function hasMeaningfulPlanProgress(
	previous: RuntimeState,
	adjustment: AjustePlanOutcome,
): boolean {
	if (adjustment.createdUnitIds.length === 0) return false;
	if (adjustment.substitutedIds.length === 0) return true;
	const replaced = previous.units.filter((u) => adjustment.substitutedIds.includes(u.id));
	const created = adjustment.state.units.filter((u) => adjustment.createdUnitIds.includes(u.id));
	return created.some((next) => replaced.every((old) => unitSignature(next) !== unitSignature(old)));
}

/** Un reporte distinto puede aportar evidencia o una causa nueva aunque aún no resuelva la unidad. */
function reportShowsProgress(current: WorkerReport | null, previous: WorkerReport | null): boolean {
	if (!current || !previous) return false;
	const failedCriteria = (report: WorkerReport) =>
		report.unmetCriteria.length + report.criteria.filter((criterion) => criterion.status === "fail").length;
	if (failedCriteria(current) < failedCriteria(previous)) return true;
	if (current.status !== previous.status) return true;
	if (current.summary !== previous.summary) return true;
	return current.criteria.some((criterion) => {
		const old = previous.criteria.find((candidate) => candidate.criterion === criterion.criterion);
		return old?.evidence !== criterion.evidence || old?.status !== criterion.status;
	});
}

/** Determina si la operación cuenta como progreso (reset del contador). */
function isProgress(
	operation: Decision["operación"],
	result: OperationResult,
	report: WorkerReport | null,
	previousState: RuntimeState,
	planProgress: boolean,
	previousReport: WorkerReport | null,
): boolean {
	if (operation === "obtener información") {
		// El mismo hallazgo repetido no debe resetear el presupuesto de no-progreso.
		return !!result.text.trim() && !previousState.knownInfo.includes(result.text);
	}
	if (operation === "ejecutar una unidad") {
		// Un replan material o evidencia nueva son progreso aunque el worker aún no haya
		// conseguido satisfacer la unidad.
		if (planProgress || reportShowsProgress(report, previousReport)) return true;
		// Una unidad aceptada (passed !== false) cuenta; fallida no.
		if (result.passed === false) return false;
		// Si el worker reportó satisfied con criterios pass, progreso pleno.
		if (report?.status === "satisfied") return true;
		// Implementer pasó (passed=true) sin reporte estructurado → progreso (legado).
		return result.passed === true;
	}
	// comunicar al desarrollador: no consume progreso (es petición bloqueante).
	// terminar: no consume progreso (sale del bucle).
	return false;
}

/** Normaliza un reporte del worker a `WorkerReport`. Si no hay reporte, devuelve `unsatisfied`
 *  con un error de contrato (plan §3 — invariante 6, sin éxito inventado). */
function normalizeReport(report: WorkerReport | null, reportError: string | null, passed: boolean | null): WorkerReport {
	if (report) return report;
	return {
		status: passed === false ? "unsatisfied" : "unsatisfied",
		summary: reportError ?? "reporte del worker ausente",
		criteria: [],
		unmetCriteria: reportError ? [reportError] : ["reporte del worker ausente o inválido"],
	};
}

/** Mapa de reportes por unidad canónica para `computeOutcomes`. */
function buildReportMap(reports: Array<{ unitId: string; report: WorkerReport }>): Map<string, "pass" | "fail"> {
	const out = new Map<string, "pass" | "fail">();
	for (const { unitId, report } of reports) {
		const failed = report.status !== "satisfied" || report.criteria.some((c) => c.status === "fail");
		out.set(unitId, failed ? "fail" : "pass");
	}
	return out;
}

/**
 * Ejecuta el bucle sobre una tarea En curso hasta terminal (Completada/Fallida), pausa
 * humana (paused_by_user), espera humana (waiting_for_user) o intervención.
 *
 * Eventos emitidos (en orden, sobre `handlers`):
 *   1. `onTaskStart(state)` — una vez, antes del primer turno.
 *   2. Por turno: `onDecideStart(iter)` → `decide` → `onDecideSuccess(decision)` → `execute` →
 *      `onWorkerStart`/`onWorkerFinish` (si ejecutó una unidad) → `onTaskCompleted`/`onTaskFailed` (si terminó).
 */
export async function runLoop(initial: RuntimeState, handlers: AiesEventHandlers): Promise<RuntimeState> {
	let state = initial;
	const startTs = Date.now();
	const telemetryAcc: TelemetryAccumulator = { totalCost: 0, totalTokens: 0, known: false };
	const observe: ObservationHook | undefined = handlers.onLoopObservation
		? (obs) => safeCallback(() => handlers.onLoopObservation?.(obs))
		: undefined;
	const emitLog: (entry: LogEntry) => void = handlers.onLogEntry
		? (entry) => safeCallback(() => handlers.onLogEntry?.(entry))
		: () => undefined;
	const checkpoint = checkpointFrom(handlers);
	const workerReports: Array<{ unitId: string; report: WorkerReport }> = [];

	emit(handlers, "onTaskStart", () => handlers.onTaskStart?.(state));

	while (state.taskState === "Recibida" || state.taskState === "En curso") {
		// Invariante 9 — pedir input detiene el loop hasta una nueva entrada válida.
		if (state.runStatus.tipo === "waiting_for_user") {
			safeObserve(observe, { phase: "waiting_for_user", state });
			break;
		}
		if (state.runStatus.tipo === "paused_by_user") {
			safeObserve(observe, { phase: "intervention:paused", state });
			break;
		}
		if (state.runStatus.tipo === "terminal") {
			break;
		}

		// Intervención externa (Runtime §7, ADR-012) — sólo SIGINT/ESC/external crean pausa;
		// nunca una decisión del Orchestrator (invariante 10).
		if (handlers.stopSignal?.()) {
			emitLog(syntheticDecision(state.iterations, "comunicar al desarrollador", "intervención: detención solicitada por el desarrollador"));
			emitLog(resultEntry(state.iterations, { kind: "intervención", text: "tarea pausada por el desarrollador", unidadId: null, passed: null }, telemetryEmpty()));
			safeObserve(observe, { phase: "intervention:paused", state });
			state = {
				...state,
				runStatus: { tipo: "paused_by_user", causa: "external", mensaje: "stopSignal activo" },
				nextStep: "pausada por el desarrollador — reanudable con /resume",
			};
			break;
		}

		// Ajuste en caliente (T2.1) — se aplica al inicio del turno, antes de la decisión.
		if (handlers.pollIntervention) {
			let adj: { text: string } | null | undefined;
			try {
				adj = await handlers.pollIntervention();
			} catch {
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

		// Límite de iteraciones (ADR-005).
		if (state.iterations >= state.limits.maxIterations) {
			const action = (await handlers.onLimit?.(state)) ?? "intervenir";
			safeObserve(observe, {
				phase: "limit:reached",
				state,
				action,
				reason: `límite de iteraciones alcanzado (${state.limits.maxIterations})`,
			});
			if (action === "intervenir") {
				emitLog(syntheticDecision(state.iterations, "comunicar al desarrollador", `límite de iteraciones alcanzado (${state.limits.maxIterations})`));
				emitLog(resultEntry(state.iterations, { kind: "límite", text: `intervención requerida: límite de iteraciones (${state.limits.maxIterations})`, unidadId: null, passed: null }, telemetryEmpty(), `iteraciones=${state.limits.maxIterations}`));
				const comm: CommunicationRequest = {
					pregunta: `¿cómo procedo? He alcanzado el límite de iteraciones (${state.limits.maxIterations}).`,
					razón: "limit_extension",
					informaciónFaltante: "decisión del desarrollador (continuar / cambiar de estrategia / terminar)",
				};
				state = {
					...state,
					runStatus: { tipo: "waiting_for_user", request: comm, mensaje: `intervención requerida: límite de iteraciones (${state.limits.maxIterations})` },
					humanWait: comm,
					nextStep: `intervención requerida: límite de iteraciones (${state.limits.maxIterations})`,
				};
				handlers.onHumanWait?.(comm);
				break;
			}
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

		// Presupuesto consecutivo de no-progreso (plan §3 — invariante 14).
		if (state.consecutiveNoProgress >= state.limits.maxConsecutiveNoProgress) {
			emitLog(syntheticDecision(state.iterations, "terminar", `terminación controlada: ${state.consecutiveNoProgress} turnos sin progreso (maxConsecutiveNoProgress=${state.limits.maxConsecutiveNoProgress})`));
			state = setTerminal(state, { execution: "fail", verification: "unknown", scope: "unknown" }, `terminación controlada: no-progreso consecutivo (${state.consecutiveNoProgress})`);
			emitLog(resultEntry(state.iterations, { kind: "no_progress", text: state.terminalCondition ?? "no-progress", unidadId: null, passed: false }, telemetryEmpty()));
			safeObserve(observe, { phase: "terminated", state, reason: state.terminalCondition ?? "no-progress" });
			emit(handlers, "onTaskFailed", () => {
				const reason = state.terminalCondition ?? "no-progress";
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
				const comm: CommunicationRequest = {
					pregunta: `El orquestador falló al parsear 3 turnos consecutivos. ¿Indico el formato esperado?`,
					razón: "orchestrator_contract_failure",
					informaciónFaltante: "formato JSON exacto o guía para corregir el orquestador",
				};
				emitLog(resultEntry(state.iterations, { kind: "parse_error", text: "intervención requerida: 3 fallos consecutivos de parseo", unidadId: null, passed: null }, telemetryEmpty()));
				state = {
					...state,
					runStatus: { tipo: "waiting_for_user", request: comm, mensaje: "intervención requerida: 3 fallos de parseo consecutivos del orquestador" },
					humanWait: comm,
					nextStep: "intervención requerida: 3 fallos de parseo consecutivos del orquestador",
				};
				handlers.onHumanWait?.(comm);
				break;
			}
			state = { ...state, nextStep: turn.parseError ?? "salida del orquestador no parseable" };
			continue;
		}

		// Reset de parse-fail. La decisión es válida.
		state = { ...state, consecutiveParseFailures: 0 };

		// Resolución de UnitRef + validación de target. Una unidad nueva planificada en el mismo
		// turno se referencia por índice del ajuste; el bucle resuelve al ID que `unitSeq` le
		// asignó (plan §3 — invariante 2).
		let ajuste: AjustePlanOutcome = applyAjustePlan(state, turn.decision.ajustePlan ?? null);
		state = ajuste.state;

		let resolvedUnitId: string | null = null;
		let workerUnit: RuntimeState["units"][number] | undefined;

		if (turn.decision.operación === "ejecutar una unidad" && turn.decision.unidad) {
			resolvedUnitId = resolveUnitRef(turn.decision.unidad, ajuste.createdUnitIds);
			if (!resolvedUnitId) {
				const reason = `decisión referencia una unidad inexistente o índice fuera de rango: ${JSON.stringify(turn.decision.unidad)}`;
				const failResult: OperationResult = { kind: "fallo", text: reason, unidadId: null, passed: false };
				safeObserve(observe, { phase: "error:unidad-inexistente", state, decision: turn.decision });
				emitLog(resultEntry(state.iterations, failResult, turn.telemetry));
				state = appendResult(state, failResult);
				state = {
					...state,
					iterations: state.iterations + 1,
					nextStep: reason,
					consecutiveNoProgress: state.consecutiveNoProgress + 1,
				};
				continue;
			}
			workerUnit = state.units.find((u) => u.id === resolvedUnitId);
			if (!workerUnit) {
				const reason = `decisión referencia una unidad inexistente: ${resolvedUnitId}`;
				const failResult: OperationResult = { kind: "fallo", text: reason, unidadId: resolvedUnitId, passed: false };
				safeObserve(observe, { phase: "error:unidad-inexistente", state, decision: turn.decision });
				emitLog(resultEntry(state.iterations, failResult, turn.telemetry));
				state = appendResult(state, failResult);
				state = {
					...state,
					iterations: state.iterations + 1,
					nextStep: reason,
					consecutiveNoProgress: state.consecutiveNoProgress + 1,
				};
				continue;
			}
			if (workerUnit.estado !== "Pendiente") {
				const reason = `decisión referencia una unidad no pendiente: ${resolvedUnitId} (${workerUnit.estado})`;
				const failResult: OperationResult = { kind: "fallo", text: reason, unidadId: resolvedUnitId, passed: false };
				safeObserve(observe, { phase: "error:unidad-no-pendiente", state, decision: turn.decision });
				emitLog(resultEntry(state.iterations, failResult, turn.telemetry));
				state = appendResult(state, failResult);
				state = {
					...state,
					iterations: state.iterations + 1,
					nextStep: reason,
					consecutiveNoProgress: state.consecutiveNoProgress + 1,
				};
				continue;
			}
		}

		safeObserve(observe, {
			phase: "decision:resolved",
			state,
			decision: turn.decision,
			parseFail: false,
			parseError: null,
			raw: turn.raw,
			telemetry: turn.telemetry,
		});
		emitLog(decisionEntry(state.iterations, turn.decision, false, turn.telemetry, handlers.resolveWorkerModel?.("orchestrator") ?? null));
		emit(handlers, "onDecideSuccess", () => handlers.onDecideSuccess?.(turn.decision));

		// Comunicación bloqueante: persistir waiting_for_user y salir del loop sin execute
		// (plan §3 — invariante 9).
		if (turn.decision.operación === "comunicar al desarrollador") {
			const comm = turn.decision.comunicación;
			if (!comm) {
				// El parser ya bloquea esta condición; defendemos aquí también.
				const reason = "comunicar al desarrollador sin bloque comunicación";
				state = appendResult(state, { kind: "fallo", text: reason, unidadId: null, passed: false });
				state = { ...state, iterations: state.iterations + 1, nextStep: reason, consecutiveNoProgress: state.consecutiveNoProgress + 1 };
				continue;
			}
			const result: OperationResult = { kind: "comunicación", text: comm.pregunta, unidadId: null, passed: null };
			state = appendResult(state, result);
			state = {
				...state,
				iterations: state.iterations + 1,
				nextStep: comm.pregunta,
				runStatus: { tipo: "waiting_for_user", request: comm, mensaje: comm.pregunta },
				humanWait: comm,
			};
			emitLog(resultEntry(state.iterations, result, turn.telemetry));
			emit(handlers, "onWorkerFinish", () => undefined);
			handlers.onHumanWait?.(comm);
			break;
		}

		// Checkpoint atómico ANTES de ejecutar el worker (plan §4 — paso 8, invariante 3).
		// El handler puede lanzar; si lanza, abortamos este turno y reintentamos el próximo.
		if (turn.decision.operación === "ejecutar una unidad" && workerUnit) {
			state = markUnitEnCurso(state, workerUnit.id);
			try {
				await checkpoint(state, `pre-execute:${workerUnit.id}`);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				state = markUnitState(state, workerUnit.id, "Pendiente");
				const failResult: OperationResult = { kind: "fallo", text: `checkpoint falló: ${msg}`, unidadId: workerUnit.id, passed: false };
				state = appendResult(state, failResult);
				state = { ...state, iterations: state.iterations + 1, nextStep: `checkpoint falló: ${msg}`, consecutiveNoProgress: state.consecutiveNoProgress + 1 };
				emitLog(resultEntry(state.iterations, failResult, turn.telemetry));
				continue;
			}
			const workerInfo: WorkerInfo = {
				role: workerUnit.capacidad,
				model: handlers.resolveWorkerModel?.(workerUnit.capacidad) ?? "unknown",
			};
			emit(handlers, "onWorkerStart", () => handlers.onWorkerStart?.(workerUnit!, workerInfo));
		}

		safeObserve(observe, { phase: "execution:start", state, decision: turn.decision });
		const sink = workerUnit ? buildWorkerSink(handlers, workerUnit.id) : emptyWorkerSink();
		const out = await handlers.execute(state, turn.decision, sink);
		accUsage(telemetryAcc, out.telemetry.usage);

		// Captura del reporte estructurado (si lo hubo) para alimentar `computeOutcomes`.
		let report: WorkerReport | null = null;
		if (out.report) report = out.report;
		else if (out.reportError) report = normalizeReport(null, out.reportError, out.result.passed);

		const previousState = state;
		const previousReport = workerReports.length > 0 ? workerReports[workerReports.length - 1]!.report : null;
		state = applyOperationResult(state, turn.decision, out.result);
		state = appendResult(state, out.result);
		state = { ...state, iterations: state.iterations + 1 };

		// Progreso: reset o incremento del contador consecutiveNoProgress.
		const progress = isProgress(
			turn.decision.operación,
			out.result,
			report,
			previousState,
			hasMeaningfulPlanProgress(previousState, ajuste),
			previousReport,
		);
		state = {
			...state,
			consecutiveNoProgress: progress ? 0 : state.consecutiveNoProgress + 1,
		};

		safeObserve(observe, {
			phase: "execution:resolved",
			state,
			decision: turn.decision,
			result: out.result,
			telemetry: out.telemetry,
			atribución: out.atribución ?? null,
		});
		emitLog(
			resultEntry(
				state.iterations,
				out.result,
				out.telemetry,
				null,
				out.atribución ?? null,
				// Atribución del modelo según el rol que realmente corrió: unidad canónica si la
				// hubo; explorer en `obtener información`; null para comunicar/terminar (sin worker).
				workerUnit
					? handlers.resolveWorkerModel?.(workerUnit.capacidad) ?? null
					: turn.decision.operación === "obtener información"
						? handlers.resolveWorkerModel?.("explorer") ?? null
						: null,
			),
		);

		if (turn.decision.operación === "ejecutar una unidad" && workerUnit) {
			workerReports.push({ unitId: workerUnit.id, report: report ?? normalizeReport(null, "reporte ausente", out.result.passed) });
			const unitResult: UnitResult = {
				unitId: workerUnit.id,
				text: out.result.text,
				passed: out.result.passed,
				kind: out.result.kind,
			};
			emit(handlers, "onWorkerFinish", () => handlers.onWorkerFinish?.(workerUnit!.id, unitResult));
		}

		// Checkpoint post-execute (plan §4 — paso 12, invariante 3).
		if (turn.decision.operación === "ejecutar una unidad") {
			try {
				await checkpoint(state, `post-execute:${workerUnit?.id ?? "?"}`);
			} catch {
				/* best-effort; el run puede continuar */
			}
		}

		if (turn.decision.operación === "terminar") {
			const cond = turn.decision.condición;
			const desenlace = cond?.desenlace ?? "completed";
			const execution: Outcomes["execution"] = desenlace === "completed" ? "success" : "fail";

			// Terminación estricta (invariante 7): si hay unidades activas, no completar.
			const active = activeUnits(state);
			if (desenlace === "completed" && active.length > 0) {
				const reason = `terminar inválido: ${active.length} unidades activas sin satisfacer (${active.map((u) => `${u.id}:${u.estado}`).join(", ")})`;
				const failResult: OperationResult = { kind: "fallo", text: reason, unidadId: null, passed: false };
				state = appendResult(state, failResult);
				state = { ...state, nextStep: reason, consecutiveNoProgress: state.consecutiveNoProgress + 1 };
				emitLog(resultEntry(state.iterations, failResult, turn.telemetry));
				continue;
			}

			const reportMap = buildReportMap(workerReports);
			const outcomes = computeOutcomes(state, execution, reportMap);
			state = setTerminal(state, outcomes, cond?.detalle ?? "terminación");
			safeObserve(observe, {
				phase: "terminated",
				state,
				reason: cond?.detalle ?? "terminación",
			});

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
		// obtener información / ejecutar una unidad: vuelven al bucle.
	}

	return state;
}

/** Serializa una lista de entradas a texto .jsonl (append-only). Útil para tests y dump. */
export function dumpJsonl(entries: LogEntry[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
}
