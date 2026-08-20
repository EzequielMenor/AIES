// src/extension/run-command.ts — handler de comandos /run, /resume, /status.
//
// /run: arranca el bucle AIES con una tarea nueva.
// /resume: continúa una tarea previa no terminal (guardada en state-store).
// /status: muestra el estado actual del bucle.
//
// El bucle corre dentro del command handler de la extensión. Pi espera a que el handler termine —
// esto bloquea la TUI hasta que la tarea llega a estado terminal (o intervención).
// Plan §2.1 / Fase 3: intervention real vía pi.ui.confirm; /resume y /status.

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { runLoop } from "../core/loop.js";
import type { AiesEventHandlers, ExecuteOutcome, WorkerEventSink } from "../core/events.js";
import { initState, type Decision, type OperationResult, type RuntimeState, type Task, type Limits } from "../core/state.js";
import type { WorkerTelemetry } from "../telemetry/types.js";
import type { ThinkingLevel } from "./types.js";
import type { LoopObservation } from "../core/observation.js";
import { appendFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { LogEntry } from "../observability.js";
import { loadConfig } from "../config.js";
import { limitsFromConfig } from "../limits.js";
import { createDecide, type ResolvedModel } from "../orchestrator/decide.js";
import { runWorker, type WorkerToolContext } from "../workers/tools.js";
import { getCurrentTask, setCurrentTask, updateCurrentTask, clearCurrentTask, isResumable, type AiesTaskState } from "./state-store.js";

const NO_TELEM: WorkerTelemetry = { usage: null, contextUsage: null, telemetryUnavailable: false };

type ExecuteFn = (state: RuntimeState, decision: Decision, events: WorkerEventSink) => Promise<ExecuteOutcome>;

function taskFromArg(taskArg: string): Task {
	return {
		objetivo: taskArg.trim(),
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "tarea completada o fallida",
	};
}

function buildExecute(wctx: WorkerToolContext, notify: (msg: string) => void): ExecuteFn {
	return async (state: RuntimeState, decision: Decision, events: WorkerEventSink) => {
		switch (decision.operación) {
			case "comunicar al desarrollador": {
				const text = decision.comunicación ?? "";
				notify(text);
				return { result: { kind: "comunicación", text, unidadId: null, passed: null } satisfies OperationResult, telemetry: NO_TELEM };
			}
			case "terminar": {
				const cond = decision.condición ?? "";
				const inviable = /sin (continuación|v([íi])a viable)|no hay (continuación|v([íi])a)|^inviable|irrecuperable/i.test(cond);
				return {
					result: {
						kind: "terminación",
						text: inviable ? cond || "sin continuación viable" : "finalización declarada",
						unidadId: null,
						passed: inviable ? false : null,
					} satisfies OperationResult,
					telemetry: NO_TELEM,
				};
			}
			case "obtener información": {
				const lastResult = state.results[state.results.length - 1];
				const contexto = lastResult?.text ?? state.knownInfo.join("; ");
				const objetivo = decision.motivo || "obtener información relevante para continuar la tarea";
				const r = await runWorker("explorer", { objetivo, contexto }, wctx, undefined, events);
				if (r.status === "failed") {
					return { result: { kind: "fallo", text: r.error, unidadId: null, passed: false } satisfies OperationResult, telemetry: NO_TELEM };
				}
				return { result: { kind: "info", text: r.text, unidadId: null, passed: null } satisfies OperationResult, telemetry: NO_TELEM };
			}
			case "ejecutar una unidad": {
				const unitId = decision.unidad;
				const unit = unitId ? state.units.find((u) => u.id === unitId) ?? null : null;
				if (!unit) {
					return { result: { kind: "fallo", text: `unidad no encontrada en el estado: ${unitId ?? "(sin unidad)"}`, unidadId: unitId, passed: false } satisfies OperationResult, telemetry: NO_TELEM };
				}
				const cap = (decision.capacidad ?? unit.capacidad) as "explorer" | "implementer" | "verifier";
				if (cap !== "explorer" && cap !== "implementer" && cap !== "verifier") {
					return { result: { kind: "fallo", text: `capacidad desconocida: ${cap}`, unidadId: unit.id, passed: false } satisfies OperationResult, telemetry: NO_TELEM };
				}
				const r = await runWorker(cap, { objetivo: unit.objetivo, contexto: state.knownInfo.join("; "), unidad: unit.id }, wctx, undefined, events);
				if (r.status === "failed") {
					return { result: { kind: "fallo", text: r.error, unidadId: unit.id, passed: false } satisfies OperationResult, telemetry: NO_TELEM };
				}
				const passed = cap === "verifier" ? (r.verdict === "PASS") : true;
				return { result: { kind: "unidad", text: r.text, unidadId: unit.id, passed } satisfies OperationResult, telemetry: NO_TELEM };
			}
		}
	};
}

function logPath(cwd: string): string {
	return path.join(cwd, ".pi", "aies-log.jsonl");
}

function ensureDir(filePath: string): void {
	const dir = path.dirname(filePath);
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* dir exists or readonly; emit best-effort */
	}
}

function emitJsonl(entry: LogEntry, filePath: string): void {
	ensureDir(filePath);
	try {
		appendFileSync(filePath, JSON.stringify(entry) + "\n");
	} catch {
		/* log best-effort */
	}
}

interface RunDeps {
	cwd: string;
	model: ResolvedModel | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	signal: AbortSignal | undefined;
	notify: (msg: string, level?: "info" | "warning" | "error") => void;
	confirm: (title: string, message: string) => Promise<boolean>;
}

async function runLoopUntilDone(initial: RuntimeState, deps: RunDeps): Promise<RuntimeState> {
	const logFile = logPath(deps.cwd);
	const observe = (o: LoopObservation) => {
		try {
			deps.notify(`${o.phase} iter=${o.state.iterations}`, "info");
		} catch {
			/* notify best-effort */
		}
	};
	const emit = (entry: LogEntry) => {
		emitJsonl(entry, logFile);
	};
	const wctx: WorkerToolContext = { cwd: deps.cwd, model: deps.model, thinkingLevel: deps.thinkingLevel };
	const decideCtx = { cwd: deps.cwd, model: deps.model, thinkingLevel: deps.thinkingLevel, signal: deps.signal };
	const decide = createDecide(decideCtx);
	const execute = buildExecute(wctx, (msg) => deps.notify(msg, "info"));

	const handlers: AiesEventHandlers = {
		decide,
		execute,
		onLogEntry: emit,
		onLoopObservation: observe,
		stopSignal: () => Boolean(deps.signal?.aborted),
		onLimit: async (state) => {
			// Fase 3: intervention real vía pi.ui.confirm.
			const ok = await deps.confirm(
				"AIES: límite alcanzado",
				`Límite de iteraciones alcanzado (${state.iterations}/${state.limits.maxIterations}). ¿Continuar?`,
			);
			return ok ? "intervenir" : "terminar";
		},
	};
	return runLoop(initial, handlers);
}

export async function runCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const taskArg = args.trim();
	if (!taskArg) {
		ctx.ui.notify("/run requiere una tarea. Ej: /run lista los archivos del proyecto", "error");
		return;
	}

	let cfg;
	try {
		cfg = loadConfig();
	} catch (e) {
		ctx.ui.notify(`aies.config.json ausente o inválido: ${e instanceof Error ? e.message : String(e)}`, "error");
		return;
	}
	const limits: Limits = limitsFromConfig(cfg);
	const task = taskFromArg(taskArg);
	const initial = initState(task, limits);
	setCurrentTask(initial);

	const model = ctx.model as ResolvedModel | undefined;
	const thinkingLevel = ctx.thinkingLevel as ThinkingLevel | undefined;
	const deps: RunDeps = {
		cwd: ctx.cwd,
		model,
		thinkingLevel,
		signal: ctx.signal,
		notify: (msg, level) => ctx.ui.notify(msg, level ?? "info"),
		confirm: (title, message) => ctx.ui.confirm(title, message),
	};

	ctx.ui.notify(`AIES: iniciando tarea — ${taskArg.slice(0, 80)}`, "info");

	let finalState: RuntimeState;
	try {
		finalState = await runLoopUntilDone(initial, deps);
		updateCurrentTask(finalState);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(`AIES: error en el bucle — ${msg}`, "error");
		clearCurrentTask();
		return;
	}

	const summary =
		finalState.taskState === "Completada"
			? `AIES: tarea completada (${finalState.iterations} iteraciones)`
			: finalState.taskState === "Fallida"
				? `AIES: tarea fallida — ${finalState.terminalCondition ?? "sin condición"} (${finalState.iterations} iter)`
				: `AIES: tarea en pausa (${finalState.taskState}) — ${finalState.nextStep ?? "sin siguiente paso"}. Usa /resume para continuar.`;
	ctx.ui.notify(summary, finalState.taskState === "Completada" ? "info" : "warning");
}

export async function resumeCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const current = getCurrentTask();
	if (!current) {
		ctx.ui.notify("AIES: no hay tarea para reanudar. Usa /run <tarea> primero.", "error");
		return;
	}
	if (!isResumable(current.runtime)) {
		ctx.ui.notify(`AIES: tarea terminal (${current.runtime.taskState}). Nada que reanudar.`, "warning");
		return;
	}

	const model = ctx.model as ResolvedModel | undefined;
	const thinkingLevel = ctx.thinkingLevel as ThinkingLevel | undefined;
	const deps: RunDeps = {
		cwd: ctx.cwd,
		model,
		thinkingLevel,
		signal: ctx.signal,
		notify: (msg, level) => ctx.ui.notify(msg, level ?? "info"),
		confirm: (title, message) => ctx.ui.confirm(title, message),
	};

	ctx.ui.notify(`AIES: reanudando tarea (${current.runtime.iterations}/${current.runtime.limits.maxIterations} iter)`, "info");
	let finalState: RuntimeState;
	try {
		finalState = await runLoopUntilDone(current.runtime, deps);
		updateCurrentTask(finalState);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		ctx.ui.notify(`AIES: error en el bucle — ${msg}`, "error");
		return;
	}
	const summary =
		finalState.taskState === "Completada"
			? `AIES: tarea completada al reanudar (${finalState.iterations} iter)`
			: finalState.taskState === "Fallida"
				? `AIES: tarea fallida al reanudar — ${finalState.terminalCondition ?? "sin condición"}`
				: `AIES: tarea en pausa (${finalState.taskState}) — ${finalState.nextStep ?? "sin siguiente paso"}.`;
	ctx.ui.notify(summary, finalState.taskState === "Completada" ? "info" : "warning");
}

export async function statusCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const current: AiesTaskState | null = getCurrentTask();
	if (!current) {
		ctx.ui.notify("AIES: sin tarea activa.", "info");
		return;
	}
	const s = current.runtime;
	const lines: string[] = [
		`tarea: ${s.task.objetivo}`,
		`estado: ${s.taskState} (${s.terminalCondition ?? "en curso"})`,
		`iteraciones: ${s.iterations} / ${s.limits.maxIterations}`,
		`unidades: ${s.units.length} (${s.units.filter((u) => u.estado === "Terminada").length} terminadas, ${s.units.filter((u) => u.estado === "Pendiente").length} pendientes)`,
		`resultados: ${s.results.length}`,
	];
	if (s.nextStep) lines.push(`siguiente paso: ${s.nextStep}`);
	if (s.taskState === "Completada" || s.taskState === "Fallida") {
		lines.push(`outcomes: execution=${s.outcomes.execution} verification=${s.outcomes.verification} scope=${s.outcomes.scope}`);
	}
	ctx.ui.notify(lines.join(" | "), "info");
}
