#!/usr/bin/env node
// src/cli.ts — entrypoint CLI de AIES (oneshot + REPL interactivo).
//
// Punto único que conecta runtime (core/loop), orquestador (orchestrator/decide),
// workers (workers/tools) y renderizador (ui/stream-renderer) con la terminal.
//
// Modos (resolución desde argv):
//   1) ONESHOT  — `aies "<tarea>"`: ejecuta una sola tarea y sale con código 0/1.
//   2) REPL     — `aies`: arranca el bucle interactivo con prompt `❯ `.
//
// Persistencia (ADR-008, en cwd-relative `.aies/`):
//   - state.json: snapshot final de RuntimeState tras cada ciclo.
//   - log.jsonl:  entradas estructuradas del bus onLogEntry.
//
// SIGINT (Ctrl+C):
//   - Si hay un run en curso, aborta el worker vía AbortSignal y marca el bucle como
//     interrumpido (stopSignal → setTerminal fail → onTaskFailed). El proceso NO muere.
//   - En REPL vuelve al prompt. En oneshot sale con código 1.

import {
	realpathSync,
} from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

import { LocalStore } from "./cli-persistence.js";

const nodeRequire = createRequire(import.meta.url);
import type {
	AiesEventHandlers,
	DecideOutcome,
	ExecuteOutcome,
	WorkerEventSink,
} from "./core/events.js";
import { runLoop } from "./core/loop.js";
import {
	type Decision,
	type Limits,
	type OperationResult,
	type RuntimeState,
	type Task,
	initState,
} from "./core/state.js";
import { loadConfig } from "./config.js";
import { limitsFromConfig } from "./limits.js";
import { createDecide, type ResolvedModel } from "./orchestrator/decide.js";
import { runWorker, type WorkerToolContext } from "./workers/tools.js";
import { StreamRenderer } from "./ui/stream-renderer.js";
import { serializeEntry, type LogEntry } from "./observability.js";
import type { WorkerTelemetry } from "./telemetry/types.js";

const NO_TELEM: WorkerTelemetry = {
	usage: null,
	contextUsage: null,
	telemetryUnavailable: false,
};

// ──────────────────────────────────────────────────────────────────────────────
// Persistencia local — ver src/cli-persistence.ts (LocalStore en .aies/ cwd-relative).
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Ejecución: compone los handlers AIES (StreamRenderer + decide + execute) y
// corre el bucle hasta terminal. Persiste al final del ciclo.
// ──────────────────────────────────────────────────────────────────────────────

function taskFromArg(taskArg: string): Task {
	return {
		objetivo: taskArg.trim(),
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "tarea completada o fallida",
	};
}

type ExecuteFn = (
	state: RuntimeState,
	decision: Decision,
	events: WorkerEventSink,
) => Promise<ExecuteOutcome>;

function buildExecute(wctx: WorkerToolContext, signal: AbortSignal | undefined): ExecuteFn {
	return async (state, decision, events) => {
		switch (decision.operación) {
			case "comunicar al desarrollador": {
				const text = decision.comunicación ?? "";
				return {
					result: { kind: "comunicación", text, unidadId: null, passed: null } satisfies OperationResult,
					telemetry: NO_TELEM,
				};
			}
			case "terminar": {
				const cond = decision.condición ?? "";
				const inviable =
					/sin (continuación|v([íi])a viable)|no hay (continuación|v([íi])a)|^inviable|irrecuperable/i.test(cond);
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
				const r = await runWorker("explorer", { objetivo, contexto }, wctx, signal, events);
				if (r.status === "failed") {
					return {
						result: { kind: "fallo", text: r.error, unidadId: null, passed: false } satisfies OperationResult,
						telemetry: r.telemetry,
					};
				}
				return {
					result: { kind: "info", text: r.text, unidadId: null, passed: null } satisfies OperationResult,
					telemetry: r.telemetry,
				};
			}
			case "ejecutar una unidad": {
				const unitId = decision.unidad;
				const unit = unitId ? state.units.find((u) => u.id === unitId) ?? null : null;
				if (!unit) {
					return {
						result: {
							kind: "fallo",
							text: `unidad no encontrada en el estado: ${unitId ?? "(sin unidad)"}`,
							unidadId: unitId,
							passed: false,
						} satisfies OperationResult,
						telemetry: NO_TELEM,
					};
				}
				const cap = (decision.capacidad ?? unit.capacidad) as "explorer" | "implementer" | "verifier";
				if (cap !== "explorer" && cap !== "implementer" && cap !== "verifier") {
					return {
						result: { kind: "fallo", text: `capacidad desconocida: ${cap}`, unidadId: unit.id, passed: false } satisfies OperationResult,
						telemetry: NO_TELEM,
					};
				}
				const r = await runWorker(
					cap,
					{ objetivo: unit.objetivo, contexto: state.knownInfo.join("; "), unidad: unit.id },
					wctx,
					signal,
					events,
				);
				if (r.status === "failed") {
					return {
						result: { kind: "fallo", text: r.error, unidadId: unit.id, passed: false } satisfies OperationResult,
						telemetry: r.telemetry,
					};
				}
				const passed = cap === "verifier" ? r.verdict === "PASS" : true;
				return {
					result: { kind: "unidad", text: r.text, unidadId: unit.id, passed } satisfies OperationResult,
					telemetry: r.telemetry,
				};
			}
		}
	};
}

export interface RunCycleOptions {
	cwd: string;
	model: ResolvedModel | undefined;
	thinkingLevel: "off" | "low" | "medium" | "high" | undefined;
	limits: Limits;
	signal: AbortSignal | undefined;
	store: LocalStore;
	renderer?: StreamRenderer | undefined;
	decideOverride?: (state: RuntimeState) => Promise<DecideOutcome>;
	executeOverride?: ExecuteFn;
}

export interface RunCycleResult {
	state: RuntimeState;
	interrupted: boolean;
	completed: boolean;
}

export async function runCycle(task: Task, opts: RunCycleOptions): Promise<RunCycleResult> {
	const initial = initState(task, opts.limits);
	const wctx: WorkerToolContext = {
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
	};
	const decideCtx = { cwd: opts.cwd, model: opts.model, thinkingLevel: opts.thinkingLevel, signal: opts.signal };
	const renderer = opts.renderer ?? new StreamRenderer(output);
	const decide: (state: RuntimeState) => Promise<DecideOutcome> =
		opts.decideOverride ?? createDecide(decideCtx);
	const execute: ExecuteFn = opts.executeOverride ?? buildExecute(wctx, opts.signal);

	const handlers: AiesEventHandlers = StreamRenderer.merge(renderer, { decide, execute });
	handlers.onLogEntry = (entry) => {
		try {
			opts.store.appendLog(entry);
		} catch {
			/* log best-effort (P-02: el bus es fire-and-forget) */
		}
	};
	handlers.stopSignal = () => Boolean(opts.signal?.aborted);

	const before = Date.now();
	let finalState: RuntimeState;
	try {
		finalState = await runLoop(initial, handlers);
	} finally {
		try {
			renderer.finalize();
		} catch {
			/* finalize best-effort */
		}
	}
	opts.store.saveState(finalState);

	const interrupted = Boolean(opts.signal?.aborted) && finalState.taskState !== "Completada";
	const completed = finalState.taskState === "Completada";
	if (interrupted) {
		// Marca explícita en el log: el usuario lo pidió.
		try {
			opts.store.appendLog({
				type: "compaction",
				fase: "start",
				reason: "user:interrupt",
				summary: `interrumpido por el usuario tras ${Date.now() - before}ms`,
				firstKeptEntryId: null,
				tokensBefore: null,
				estimatedTokensAfter: null,
				aborted: true,
				willRetry: false,
				errorMessage: null,
			} satisfies LogEntry);
		} catch {
			/* best-effort */
		}
	}
	return { state: finalState, interrupted, completed };
}

// ──────────────────────────────────────────────────────────────────────────────
// Banner y comandos REPL
// ──────────────────────────────────────────────────────────────────────────────

function banner(): void {
	const bar = "─".repeat(50);
	const top = `┌${bar}┐`;
	const bot = `└${bar}┘`;
	const l1 = "│  AIES — Autonomous Software Engineering Harness │";
	const l2 = "│  Escribe tu tarea o /help para comandos       │";
	const pad = (s: string) => {
		const width = 52; // incluye los │ inicial y final
		const inner = s.length;
		const spaces = Math.max(0, width - inner);
		return s + " ".repeat(spaces);
	};
	output.write(`${top}\n${pad(l1)}\n${pad(l2)}\n${bot}\n`);
}

const HELP_TEXT = [
	"Comandos disponibles:",
	"  /help              — muestra esta ayuda",
	"  /state             — imprime el JSON resumido del RuntimeState actual",
	"  /clear             — limpia la pantalla",
	"  /exit | /quit      — cierra la sesión",
	"",
	" Cualquier otro texto se ejecuta como una nueva tarea sobre el proyecto.",
	" Persistencia: .aies/state.json y .aies/log.jsonl tras cada ciclo.",
	" Ctrl+C durante una tarea la aborta limpiamente (sin matar el proceso).",
].join("\n");

function helpText(): string {
	return HELP_TEXT;
}

function clearScreen(): void {
	// ANSI: ESC[2J (borrar pantalla) + ESC[H (cursor arriba-izquierda).
	output.write("\x1b[2J\x1b[H");
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export interface CliOptions {
	cwd: string;
	taskArg: string | null;
	repl: boolean;
}

function resolveModel(modelStr: string | undefined): ResolvedModel | undefined {
	// CLI real: la resolución del modelo (provider + id → instancia) ocurre vía ModelRuntime.create
	// en `decide.ts`/worker. Aquí sólo devolvemos undefined → el host usará su modelo por defecto.
	// Si en el futuro se quiere aceptar --model en argv, se puede resolver aquí contra pi.
	return undefined;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const taskArg = argv.length > 0 ? argv.join(" ").trim() : null;
	const repl = taskArg === null || taskArg.length === 0;
	const cwd = process.cwd();

	let cfg;
	try {
		cfg = loadConfig();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		output.write(`aies: aies.config.json ausente o inválido: ${msg}\n`);
		process.exit(2);
	}
	const limits: Limits = limitsFromConfig(cfg);
	const model: ResolvedModel | undefined = resolveModel(process.env.AIES_MODEL);
	const thinkingLevel = cfg.orchestratorThinkingLevel;

	if (repl) {
		await runRepl({ cwd, limits, model, thinkingLevel });
	} else {
		const exitCode = await runOneshot(taskArg!, { cwd, limits, model, thinkingLevel });
		process.exit(exitCode);
	}
}

async function runOneshot(
	taskArg: string,
	ctx: { cwd: string; limits: Limits; model: ResolvedModel | undefined; thinkingLevel: "off" | "low" | "medium" | "high" | undefined },
): Promise<number> {
	const task = taskFromArg(taskArg);
	const store = new LocalStore(ctx.cwd);
	const controller = new AbortController();
	const onSigint = () => controller.abort(new Error("Interrumpido por el usuario"));
	process.once("SIGINT", onSigint);

	const result = await runCycle(task, {
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		limits: ctx.limits,
		signal: controller.signal,
		store,
	});

	process.off("SIGINT", onSigint);

	if (result.completed) return 0;
	if (result.interrupted) {
		output.write("\naies: tarea interrumpida por el usuario.\n");
		return 1;
	}
	output.write(`\naies: tarea terminó en estado ${result.state.taskState}.\n`);
	return result.state.taskState === "Fallida" ? 1 : 1;
}

async function runRepl(ctx: {
	cwd: string;
	limits: Limits;
	model: ResolvedModel | undefined;
	thinkingLevel: "off" | "low" | "medium" | "high" | undefined;
}): Promise<void> {
	const store = new LocalStore(ctx.cwd);
	banner();

	const rl = readline.createInterface({ input, output, terminal: true });
	let currentState: RuntimeState | null = store.loadState();
	let runInProgress = false;
	let activeAbort: AbortController | null = null;

	const onSigint = () => {
		if (runInProgress && activeAbort) {
			activeAbort.abort(new Error("Interrumpido por el usuario"));
		}
	};
	process.on("SIGINT", onSigint);

	// Cierre limpio del REPL con /exit o EOF.
	const close = () => {
		process.off("SIGINT", onSigint);
		rl.close();
	};

	try {
		while (true) {
			let line: string;
			try {
				line = await rl.question("❯ ");
			} catch {
				// readline aborted (Ctrl+D / cierre del stream).
				break;
			}
			const input0 = line.trim();
			if (!input0) continue;

			if (input0 === "/help") {
				output.write(`${helpText()}\n`);
				continue;
			}
			if (input0 === "/clear") {
				clearScreen();
				continue;
			}
			if (input0 === "/exit" || input0 === "/quit") {
				break;
			}
			if (input0 === "/state") {
				const snapshot = currentState ?? store.loadState();
				if (!snapshot) {
					output.write("aies: sin estado cargado todavía. Escribe una tarea para empezar.\n");
				} else {
					output.write(`${JSON.stringify(summarizeState(snapshot), null, 2)}\n`);
				}
				continue;
			}

			// Nueva tarea sobre el proyecto (manteniendo persistencia).
			const task = taskFromArg(input0);
			runInProgress = true;
			activeAbort = new AbortController();
			const before = currentState;
			try {
				const result = await runCycle(task, {
					cwd: ctx.cwd,
					model: ctx.model,
					thinkingLevel: ctx.thinkingLevel,
					limits: ctx.limits,
					signal: activeAbort.signal,
					store,
				});
				currentState = result.state;
				if (result.interrupted) {
					output.write("\naies: tarea interrumpida por el usuario (Ctrl+C). Volviendo al prompt.\n");
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				output.write(`\naies: error — ${msg}\n`);
			} finally {
				runInProgress = false;
				activeAbort = null;
				// Si abortamos por SIGINT, currentState queda en el último snapshot persistido.
				if (before && !currentState) currentState = before;
			}
		}
	} finally {
		close();
	}
}

function summarizeState(s: RuntimeState): Record<string, unknown> {
	return {
		taskState: s.taskState,
		objetivo: s.task.objetivo,
		iterations: s.iterations,
		maxIterations: s.limits.maxIterations,
		terminalCondition: s.terminalCondition,
		nextStep: s.nextStep,
		outcomes: s.outcomes,
		units: s.units.map((u) => ({ id: u.id, capacidad: u.capacidad, estado: u.estado, objetivo: u.objetivo })),
		resultsCount: s.results.length,
	};
}

// Ejecuta main sólo cuando se invoca como entrypoint real (no en tests).
// Detección portable: comparamos la URL real (realpath resuelve symlinks tipo /tmp → /private/tmp
// en macOS) de process.argv[1] contra import.meta.url.
const isEntrypoint = ((): boolean => {
	try {
		const entry = process.argv[1];
		if (!entry) return false;
		const entryReal = realpathSync(path.resolve(entry));
		const { fileURLToPath } = nodeRequire("node:url") as typeof import("node:url");
		const metaReal = realpathSync(fileURLToPath(import.meta.url));
		return entryReal === metaReal;
	} catch {
		return false;
	}
})();

if (isEntrypoint) {
	main().catch((e) => {
		const msg = e instanceof Error ? e.message : String(e);
		output.write(`aies: error fatal — ${msg}\n`);
		process.exit(2);
	});
}
