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

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import pc from "picocolors";

import { LocalStore } from "./cli-persistence.js";
import { formatStatus } from "./cli-status.js";
import { loadConfig, type Config } from "./config.js";
import { runStartup, type StartupReport } from "./integrations/index.js";
import { addKnownInfo } from "./core/state.js";

const nodeRequire = createRequire(import.meta.url);
import type {
	AiesEventHandlers,
	DecideOutcome,
	ExecuteOutcome,
	InterventionAdjustment,
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
import { limitsFromConfig } from "./limits.js";
import { createDecide, type ResolvedModel } from "./orchestrator/decide.js";
import { runWorker, type WorkerToolContext } from "./workers/tools.js";
import { StreamRenderer, amber, violet } from "./ui/stream-renderer.js";
import { serializeEntry, type LogEntry } from "./observability.js";
import type { WorkerTelemetry } from "./telemetry/types.js";
import { checkForUpdate, formatUpdateNotice, resolveInstallDir, runUpdate, type UpdateStatus } from "./update.js";

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
	decideOverride?: ((state: RuntimeState) => Promise<DecideOutcome>) | undefined;
	executeOverride?: ExecuteFn | undefined;
	/** Snapshot persistido a reanudar. El caller debe pasar `task = resumeFrom.task`. */
	resumeFrom?: RuntimeState | undefined;
	/** T2.1 — canal opcional de ajuste en caliente. Si está, el bucle lo consulta cada turno. */
	pollIntervention?: (() => InterventionAdjustment | null) | undefined;
	/** T2.2 — guía del desarrollador inyectada al reanudar (se añade a `knownInfo`). */
	resumeGuide?: string | undefined;
	/** ADR-011 — startup cacheado. Si se omite, se calcula aquí (runStartup). */
	startup?: StartupReport | undefined;
}

export interface RunCycleResult {
	state: RuntimeState;
	interrupted: boolean;
	completed: boolean;
	/** Reporte de integraciones del arranque (disponibilidad, briefing, tools). */
	startup: StartupReport;
}

export async function runCycle(task: Task, opts: RunCycleOptions): Promise<RunCycleResult> {
	const startup = opts.startup ?? runStartup(opts.cwd);
	let initial = opts.resumeFrom ?? initState(task, opts.limits);
	// ADR-011 §4 — briefing al estado ANTES del bucle: el orquestador (P-09) ve `knownInfo`
	// serializado en cada turno. Se añade tras la guía de /resume si la hay.
	for (const line of startup.briefing) initial = addKnownInfo(initial, line);
	if (opts.resumeGuide && opts.resumeFrom) {
		// T2.2 — la guía se inyecta al estado reanudado como `knownInfo` antes de arrancar el bucle.
		const note = `guía del desarrollador al reanudar: ${opts.resumeGuide}`;
		initial = { ...initial, knownInfo: [...initial.knownInfo, note] };
	}
	const wctx: WorkerToolContext = {
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		customTools: startup.customTools,
		integrationBits: startup.toolNames,
	};
	const decideCtx = { cwd: opts.cwd, model: opts.model, thinkingLevel: opts.thinkingLevel, signal: opts.signal };
	const renderer = opts.renderer ?? new StreamRenderer(output);
	const decide: (state: RuntimeState) => Promise<DecideOutcome> =
		opts.decideOverride ?? createDecide(decideCtx);
	const execute: ExecuteFn = opts.executeOverride ?? buildExecute(wctx, opts.signal);

	const handlers: AiesEventHandlers = StreamRenderer.merge(renderer, { decide, execute });
	const rendererOnLogEntry = handlers.onLogEntry?.bind(renderer);
	handlers.onLogEntry = (entry) => {
		rendererOnLogEntry?.(entry);
		try {
			opts.store.appendLog(entry);
		} catch {
			/* log best-effort (P-02: el bus es fire-and-forget) */
		}
	};
	handlers.stopSignal = () => Boolean(opts.signal?.aborted);
	if (opts.pollIntervention) handlers.pollIntervention = opts.pollIntervention;

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
	return { state: finalState, interrupted, completed, startup };
}

// ──────────────────────────────────────────────────────────────────────────────
// Banner y comandos REPL
// ──────────────────────────────────────────────────────────────────────────────

export const BANNER_BAR = "─".repeat(50);

/** Rellena `s` hasta `width` (por defecto `bar.length + 2`) con espacios a la derecha. */
export function pad(s: string, width: number = BANNER_BAR.length + 2): string {
	const spaces = Math.max(0, width - s.length);
	return s + " ".repeat(spaces);
}

function banner(out: NodeJS.WritableStream = output): void {
	const bar = BANNER_BAR;
	const top = `┌${bar}┐`;
	const bot = `└${bar}┘`;
	const l1 = "│  AIES — Autonomous Software Engineering Harness │";
	const l2 = "│  Escribe tu tarea o /help para comandos       │";
	out.write(`${top}\n${pad(l1)}\n${pad(l2)}\n${bot}\n`);
}

const HELP_TEXT = [
	"Comandos disponibles:",
	"  /help                       — muestra esta ayuda",
	"  /resume                     — reanuda la tarea En curso persistida",
	"  /resume \"<guía>\"            — reanuda inyectando la guía como knownInfo",
	"  /state                      — vista humana del RuntimeState actual",
	"  /state --json               — JSON resumido del RuntimeState actual",
	"  /status                     — estado + telemetría agregada del historial (log.jsonl)",
	"  /clear                      — limpia la pantalla",
	"  /exit | /quit               — cierra la sesión",
	"",
	" Cualquier otro texto se ejecuta como una nueva tarea sobre el proyecto.",
	" Mientras corre una tarea, escribe para intervenir (se aplicará en la siguiente decisión);",
	" Ctrl+C la aborta limpiamente (sin matar el proceso).",
	" Persistencia: .aies/state.json y .aies/log.jsonl tras cada ciclo.",
].join("\n");

function helpText(): string {
	return HELP_TEXT;
}

/** Env var de API key por provider (sin red). Providers desconocidos: aviso genérico. */
export const PROVIDER_ENV_KEY: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	gemini: "GEMINI_API_KEY",
	minimax: "MINIMAX_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
};

export function preflight(cfg: Config, out: NodeJS.WritableStream, env: NodeJS.ProcessEnv = process.env): void {
	const provider = cfg.provider;
	const modelo = cfg.models.orchestrator ?? "(por defecto)";
	out.write(`aies: provider=${provider} modelo=${modelo} — ok.\n`);
	const envKey = PROVIDER_ENV_KEY[provider.toLowerCase()];
	if (!envKey) return;
	if (!env[envKey]) {
		out.write(`${amber("▲")} aies: ${envKey} no está definida — el runtime degradará sin round-trip.\n`);
	}
}

export function priorInProgressNotice(state: RuntimeState | null): string | null {
	if (!state || state.taskState !== "En curso") return null;
	return `aies: hay una tarea previa "En curso" (objetivo: "${state.task.objetivo}"). Usa /resume para continuarla. Cualquier otro texto arranca una tarea nueva.`;
}

export function oneshotOverwriteNotice(state: RuntimeState | null): string | null {
	if (!state || state.taskState !== "En curso") return null;
	return `aies: hay una tarea previa "En curso" (objetivo: "${state.task.objetivo}"). Esta oneshot la sobreescribirá.`;
}

export function schemaInvalidNotice(reason: "corrupt" | "schema"): string {
	return reason === "schema"
		? "aies: state.json con schema antiguo o incompleto; se ignora (no reanudable)."
		: "aies: state.json corrupto; se ignora (sesión limpia).";
}

export function replStartupMessages(store: LocalStore): string[] {
	const loaded = store.loadStateResult();
	const msgs: string[] = [];
	if (loaded.kind === "invalid") msgs.push(schemaInvalidNotice(loaded.reason));
	const notice = priorInProgressNotice(loaded.kind === "ok" ? loaded.state : null);
	if (notice) msgs.push(notice);
	return msgs;
}

export function resolveResume(
	state: RuntimeState | null,
): { ok: true; state: RuntimeState } | { ok: false; message: string } {
	if (!state || state.taskState !== "En curso") {
		return { ok: false, message: 'aies: no hay una tarea "En curso" para reanudar.' };
	}
	return { ok: true, state };
}

/** Reanuda un snapshot `En curso` (el caller ya validó con `resolveResume`). */
export async function runResumeCycle(state: RuntimeState, opts: RunCycleOptions): Promise<RunCycleResult> {
	return runCycle(state.task, { ...opts, resumeFrom: { ...state, limits: opts.limits } });
}

function unitMark(estado: RuntimeState["units"][number]["estado"]): string {
	if (estado === "Terminada") return "✓";
	if (estado === "Fallida") return "✗";
	return "○";
}

export function formatStateHuman(s: RuntimeState): string {
	const lines: string[] = [
		`Objetivo     : ${s.task.objetivo}`,
		`Estado       : ${s.taskState}`,
		`Iteración    : ${s.iterations}/${s.limits.maxIterations}`,
		`Siguiente    : ${s.nextStep}`,
		"Unidades     :",
	];
	if (s.units.length === 0) {
		lines.push("  (ninguna)");
	} else {
		for (const u of s.units) {
			lines.push(`  ${unitMark(u.estado)} ${u.id} · ${u.capacidad} · ${u.estado} — ${u.objetivo}`);
		}
	}
	lines.push(`Resultados   : ${s.results.length}`);
	return lines.join("\n");
}

export function formatStateOutput(input: string, snapshot: RuntimeState | null): string {
	if (!snapshot) {
		return "aies: sin estado cargado todavía. Escribe una tarea para empezar.\n";
	}
	const json = /(?:^|\s)--json\b/.test(input);
	if (json) return `${JSON.stringify(summarizeState(snapshot), null, 2)}\n`;
	return `${formatStateHuman(snapshot)}\n`;
}

export function oneshotExitCode(result: Pick<RunCycleResult, "completed">): number {
	if (result.completed) return 0;
	// Cualquier estado no Completada (incluido "En curso" tras límite) sale 1 en oneshot.
	return 1;
}

const CLI_HELP_TEXT = [
	"Uso: aies [opción] | aies \"<tarea>\"",
	"",
	"  aies \"<tarea>\"     ejecuta una tarea y termina",
	"  aies               inicia el REPL interactivo",
	"  aies update        actualiza AIES mediante el instalador oficial",
	"  aies -V, --version muestra la versión y el commit actual",
	"  aies -h, --help    muestra esta ayuda",
	"",
	"  AIES_NO_UPDATE_CHECK=1 desactiva el chequeo automático de actualizaciones.",
].join("\n");

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

const UPDATE_NOTICE_TIMEOUT_MS = 3500;

function packageVersion(): string {
	const packageJson = nodeRequire("../package.json") as { version?: unknown };
	return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

function currentHead(): Promise<string> {
	const installDir = resolveInstallDir();
	if (!installDir) return Promise.resolve("unknown");
	return new Promise((resolve) => {
		execFile("git", ["-C", installDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8", timeout: 3000 }, (error, stdout) => {
			resolve(error ? "unknown" : stdout.trim() || "unknown");
		});
	});
}

function waitForUpdateNotice(promise: Promise<UpdateStatus>): Promise<UpdateStatus | null> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(null), UPDATE_NOTICE_TIMEOUT_MS);
		promise.then(
			(status) => {
				clearTimeout(timer);
				resolve(status);
			},
			() => {
				clearTimeout(timer);
				resolve(null);
			},
		);
	});
}

async function printVersion(): Promise<void> {
	output.write(`aies ${packageVersion()} (${await currentHead()})\n`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.length === 1) {
		const command = argv[0]!;
		if (command === "update") {
			process.exit(await runUpdate());
		}
		if (command === "--version" || command === "-V") {
			await printVersion();
			process.exit(0);
		}
		if (command === "--help" || command === "-h") {
			output.write(`${CLI_HELP_TEXT}\n`);
			process.exit(0);
		}
	}
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
	const updatePromise = checkForUpdate();
	preflight(cfg, output);

	if (repl) {
		await runRepl({ cwd, limits, model, thinkingLevel, updatePromise });
	} else {
		const exitCode = await runOneshot(taskArg!, { cwd, limits, model, thinkingLevel, updatePromise });
		const status = await waitForUpdateNotice(updatePromise);
		const notice = formatUpdateNotice(status ?? { kind: "skipped" });
		if (notice) output.write(`\n${notice}\n`);
		process.exit(exitCode);
	}
}

export async function runOneshot(
	taskArg: string,
	ctx: {
		cwd: string;
		limits: Limits;
		model: ResolvedModel | undefined;
		thinkingLevel: "off" | "low" | "medium" | "high" | undefined;
		updatePromise?: Promise<UpdateStatus> | undefined;
		store?: LocalStore | undefined;
		renderer?: StreamRenderer | undefined;
		decideOverride?: ((state: RuntimeState) => Promise<DecideOutcome>) | undefined;
		executeOverride?: ExecuteFn | undefined;
		out?: NodeJS.WritableStream | undefined;
		signal?: AbortSignal | undefined;
	},
): Promise<number> {
	const out = ctx.out ?? output;
	const task = taskFromArg(taskArg);
	const store = ctx.store ?? new LocalStore(ctx.cwd);
	const loaded = store.loadStateResult();
	if (loaded.kind === "invalid") out.write(`${schemaInvalidNotice(loaded.reason)}\n`);
	const prior = loaded.kind === "ok" ? loaded.state : null;
	const overwrite = oneshotOverwriteNotice(prior);
	if (overwrite) out.write(`${overwrite}\n`);

	const controller = new AbortController();
	const onSigint = () => controller.abort(new Error("Interrumpido por el usuario"));
	if (!ctx.signal) process.once("SIGINT", onSigint);

	const result = await runCycle(task, {
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		limits: ctx.limits,
		signal: ctx.signal ?? controller.signal,
		store,
		renderer: ctx.renderer,
		decideOverride: ctx.decideOverride,
		executeOverride: ctx.executeOverride,
	});

	if (!ctx.signal) process.off("SIGINT", onSigint);

	if (result.completed) return 0;
	if (result.interrupted) {
		out.write("\naies: tarea interrumpida por el usuario.\n");
	} else {
		out.write(`\naies: tarea terminó en estado ${result.state.taskState}.\n`);
	}
	return oneshotExitCode(result);
}

async function runRepl(ctx: {
	cwd: string;
	limits: Limits;
	model: ResolvedModel | undefined;
	thinkingLevel: "off" | "low" | "medium" | "high" | undefined;
	updatePromise: Promise<UpdateStatus>;
}): Promise<void> {
	const store = new LocalStore(ctx.cwd);
	banner();
	for (const msg of replStartupMessages(store)) output.write(`${msg}\n`);
	let currentState: RuntimeState | null = store.loadState();
	const updateStatus = await waitForUpdateNotice(ctx.updatePromise);
	const updateNotice = formatUpdateNotice(updateStatus ?? { kind: "skipped" });
	if (updateNotice) output.write(`\n${updateNotice}\n`);

	const rl = readline.createInterface({ input, output, terminal: true });
	let runInProgress = false;
	let activeAbort: AbortController | null = null;
	// T2.1 — cola de intervención acumulada mientras corre un run.
	const interventionQueue: string[] = [];

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
			if (input0 === "/state" || input0.startsWith("/state ")) {
				const snapshot = currentState ?? store.loadState();
				output.write(formatStateOutput(input0, snapshot));
				continue;
			}
			if (input0 === "/status") {
				const snapshot = currentState ?? store.loadState();
				output.write(`${formatStatus(snapshot, store.readLogIndexed())}\n`);
				continue;
			}
			if (input0 === "/resume" || input0.startsWith("/resume ")) {
				const guide = parseResumeGuide(input0);
				const resolved = resolveResume(currentState ?? store.loadState());
				if (!resolved.ok) {
					output.write(`${resolved.message}\n`);
					continue;
				}
				const result = await runTrackedReplCycle(output, rl, interventionQueue, {
					mark: (running, abort) => {
						runInProgress = running;
						activeAbort = abort;
					},
					run: (signal) =>
						runResumeCycle(resolved.state, {
							cwd: ctx.cwd,
							model: ctx.model,
							thinkingLevel: ctx.thinkingLevel,
							limits: ctx.limits,
							signal,
							store,
							pollIntervention: () => drainInterventionQueue(interventionQueue),
							resumeGuide: guide,
						}),
				});
				if (result) currentState = result.state;
				continue;
			}

			// Nueva tarea sobre el proyecto (manteniendo persistencia).
			const task = taskFromArg(input0);
			const before = currentState;
			const result = await runTrackedReplCycle(output, rl, interventionQueue, {
				mark: (running, abort) => {
					runInProgress = running;
					activeAbort = abort;
				},
				run: (signal) =>
					runCycle(task, {
						cwd: ctx.cwd,
						model: ctx.model,
						thinkingLevel: ctx.thinkingLevel,
						limits: ctx.limits,
						signal,
						store,
						pollIntervention: () => drainInterventionQueue(interventionQueue),
					}),
			});
			if (result) currentState = result.state;
			else if (before && !currentState) currentState = before;
		}
	} finally {
		close();
	}
}

/** Parsea `/resume "<guía>"` o `/resume <guía sin comillas>`; vacío si es sólo `/resume`. */
export function parseResumeGuide(input: string): string | undefined {
	const rest = input.replace(/^\/resume\s*/, "").trim();
	if (!rest) return undefined;
	if (rest.startsWith('"') && rest.endsWith('"') && rest.length >= 2) {
		return rest.slice(1, -1).trim() || undefined;
	}
	return rest;
}

/** Drena todas las entradas pendientes de la cola y las une en un único ajuste. */
function drainInterventionQueue(queue: string[]): InterventionAdjustment | null {
	if (queue.length === 0) return null;
	const text = queue.splice(0, queue.length).join("\n");
	return text ? { text } : null;
}

/** Abort/error handling compartido entre tarea nueva y `/resume` (sin acoplar a readline). */
async function runTrackedReplCycle(
	out: NodeJS.WritableStream,
	rl: readline.Interface,
	interventionQueue: string[],
	opts: {
		mark: (running: boolean, abort: AbortController | null) => void;
		run: (signal: AbortSignal) => Promise<RunCycleResult>;
	},
): Promise<RunCycleResult | undefined> {
	const abort = new AbortController();
	opts.mark(true, abort);
	// T2.1 — el listener SOLO vive durante el run; se retira en `finally` para no filtrar
	// entradas al próximo `rl.question()`.
	const onInterventionLine = (raw: string) => {
		const text = raw.trim();
		if (!text) return;
		if (text.startsWith("/")) {
			out.write(`${amber("▲")} los comandos / no están disponibles durante la ejecución (Ctrl+C para detener)\n`);
			return;
		}
		interventionQueue.push(text);
		out.write(`${violet("⚑ tú (intervención):")} ${text} — se aplicará en la siguiente decisión.\n`);
	};
	rl.on("line", onInterventionLine);
	try {
		out.write(`${pc.dim("(escribe para intervenir · Ctrl+C detiene)")}\n`);
		const result = await opts.run(abort.signal);
		if (result.interrupted) {
			out.write("\naies: tarea interrumpida por el usuario (Ctrl+C). Volviendo al prompt.\n");
		}
		return result;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		out.write(`\naies: error — ${msg}\n`);
		return undefined;
	} finally {
		rl.removeListener("line", onInterventionLine);
		opts.mark(false, null);
	}
}

export function summarizeState(s: RuntimeState): Record<string, unknown> {
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
