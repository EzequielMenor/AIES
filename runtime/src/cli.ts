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
// SIGINT / ESC (ADR-012 — `5-Decisions/ADR-012-intervencion-pausa-no-fallo.md`):
//   - ESC durante un run (sólo en REPL con TTY) → aborta el worker; la tarea queda PAUSADA
//     (`En curso`/`Recibida` intactos, `nextStep` marcador) y el REPL vuelve al prompt.
//     Reanudable con `/resume`. No se cierra el proceso.
//   - SIGINT (Ctrl+C) durante un run → aborta el worker, persiste el estado y, tras drenar el
//     turno, cierra el REPL. Oneshot: sale con código 1 y deja estado reanudable. Reanudable
//     con `/resume` en la siguiente invocación.
//   - 2º SIGINT consecutivo (sin importar timing) → `process.exit(130)` inmediato: el drenado
//     del turno puede quedarse colgado y el usuario tiene la última palabra.
//   - SIGINT en el prompt del REPL (sin run) → cierra el REPL tras persistir.

import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { emitKeypressEvents, type Key } from "node:readline";
import pc from "picocolors";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
	formatAuthStatusLines,
	getModelRuntime,
	loginProvider,
	logoutProvider,
	PROVIDER_ENV_KEY,
	supportedLoginProviders,
} from "./auth.js";
import { LocalStore } from "./cli-persistence.js";
import { formatLogTail, parseLogArg } from "./cli-log.js";
import { formatStatus } from "./cli-status.js";
import { defaultConfigPath, loadConfig, type Config } from "./config.js";
import { runStartup, type StartupReport } from "./integrations/index.js";
import { addKnownInfo } from "./core/state.js";
import { formatModelsTable, parseModelsQuery, resolveModelsForListing, searchModels } from "./models-list.js";
import { runPickCommand } from "./cli-models.js";
import { bareExitTokens, filterSlashCommands, formatHelpCommands, parseSlashCommand } from "./commands.js";
import {
	runLoginFlow,
	runLogoutFlow,
	runModelFlow,
	runSlashPaletteDispatch,
} from "./cli-repl-helpers.js";
import { PromptUI } from "./ui/prompt-ui.js";

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
import { parseModelRef, ROLES, type ResolvedModel } from "./model-runtime.js";
import { createDecide } from "./orchestrator/decide.js";
import { runWorker, toWorkerRunParams, type WorkerToolContext } from "./workers/tools.js";
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
				// El bucle intercepta `comunicar al desarrollador` antes de invocar execute (plan §4 —
				// invariante 9). El caso defensivo en execute sólo se ejecuta si un caller
				// sobreescribe el loop o un test inyecta execute directamente.
				const text = decision.comunicación?.pregunta ?? "(sin pregunta)";
				return {
					result: { kind: "comunicación", text, unidadId: null, passed: null } satisfies OperationResult,
					telemetry: NO_TELEM,
				};
			}
			case "terminar": {
				const cond = decision.condición;
				const desenlace = cond?.desenlace ?? "completed";
				const detalle = cond?.detalle ?? "terminación";
				const inviable = desenlace === "failed";
				return {
					result: {
						kind: "terminación",
						text: inviable ? detalle || "sin continuación viable" : "finalización declarada",
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
				const params = toWorkerRunParams("explorer", { objetivo, contexto });
				const r = await runWorker("explorer", params, wctx, signal, events);
				if (r.status === "failed") {
					return {
						result: { kind: "fallo", text: r.error, unidadId: null, passed: false } satisfies OperationResult,
						telemetry: r.telemetry,
					};
				}
				return {
					result: { kind: "info", text: r.text, unidadId: null, passed: null } satisfies OperationResult,
					telemetry: r.telemetry,
					report: r.report ?? null,
					reportError: r.reportError ?? null,
				};
			}
			case "ejecutar una unidad": {
				// El bucle ya resuelve UnitRef a un ID canónico, marca la unidad `En curso` y la
				// checkpointea. Aquí recuperamos la unidad para construir el contrato completo:
				//   - `unitRef.existente`: por id (back-compat con tests/extension que no corren el loop).
				//   - `unitRef.planificada` o null: buscamos la unidad que el loop acaba de marcar
				//     `En curso` (una sola a la vez; invariante del bucle).
				const unitRef = decision.unidad;
				let unit = null;
				if (unitRef?.tipo === "existente") {
					unit = state.units.find((u) => u.id === unitRef.id) ?? null;
				} else {
					unit = state.units.find((u) => u.estado === "En curso") ?? null;
				}
				if (!unit) {
					return {
						result: {
							kind: "fallo",
							text: `unidad no encontrada en el estado (ref=${JSON.stringify(unitRef)})`,
							unidadId: null,
							passed: false,
						} satisfies OperationResult,
						telemetry: NO_TELEM,
					};
				}
				const cap = unit.capacidad;
				// Evidencia acotada (plan §3 — invariante 15): no se duplica results/knownInfo;
				// el worker recibe la infoNecesaria de la unidad y la solicitud original (Task).
				const evidence = unit.infoNecesaria ?? "";
				const params = toWorkerRunParams(cap, { objetivo: unit.objetivo, contexto: evidence, unidad: unit.id }, decision.feedbackCorrectivo ?? null);
				// Reemplazar el Task generado por toWorkerRunParams con el canónico del estado.
				params.task = state.task;
				const r = await runWorker(cap, params, wctx, signal, events);
				if (r.status === "failed") {
					return {
						result: { kind: "fallo", text: r.error, unidadId: unit.id, passed: false } satisfies OperationResult,
						telemetry: r.telemetry,
						report: r.report ?? null,
						reportError: r.reportError ?? null,
					};
				}
				// Verificación: el reporte estructurado es la verdad (invariante 6). Si el implementer
				// no emite reporte, NO se marca como passed=true automático (plan §3 worker contract).
				let passed: boolean | null;
				if (cap === "verifier") {
					// Verifier legacy (VEREDICTO): compat. Si además hay reporte estructurado, prima.
					passed = r.report ? r.report.status === "satisfied" : r.verdict === "PASS";
				} else if (cap === "explorer") {
					passed = null;
				} else {
					passed = r.report?.status === "satisfied" ? true : (r.report ? false : null);
				}
				return {
					result: { kind: "unidad", text: r.text, unidadId: unit.id, passed } satisfies OperationResult,
					telemetry: r.telemetry,
					report: r.report ?? null,
					reportError: r.reportError ?? null,
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

/** Prefijo estable para que el filtro en `runCycle` pueda reemplazar el briefing entre ciclos. */
export const BRIEFING_PREFIX = "briefing de arranque:";

export async function runCycle(task: Task, opts: RunCycleOptions): Promise<RunCycleResult> {
	const startup = opts.startup ?? runStartup(opts.cwd);
	let initial = opts.resumeFrom ?? initState(task, opts.limits);
	// ADR-011 §4 + ADR-012 — briefing al estado como UNA entrada marcada (no N) para acotar el
	// crecimiento de `knownInfo` en /resume. Sin resumeFrom: primera tarea, no hay briefing previo.
	// Con resumeFrom: filtramos el briefing del ciclo anterior antes de inyectar el nuevo.
	const knownInfoWithoutBriefing = initial.knownInfo.filter((k) => !k.startsWith(BRIEFING_PREFIX));
	initial = { ...initial, knownInfo: knownInfoWithoutBriefing };
	const briefingEntry = `${BRIEFING_PREFIX}\n${startup.briefing.join("\n")}`;
	initial = addKnownInfo(initial, briefingEntry);
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
	const decideCtx = {
		cwd: opts.cwd,
		model: opts.model,
		thinkingLevel: opts.thinkingLevel,
		signal: opts.signal,
	};
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

/**
 * Banner compacto. Antes era un recuadro box-drawing pesado (`─┌│┐└` con dos líneas de
 * relleno). Ahora es una línea con provider/modelo + otra con la tecla de ayuda —
 * coherente con la regla "el stream manda, el chrome es mínimo" del spec.
 */
function banner(out: NodeJS.WritableStream = output, ctx?: { runtime: ModelRuntime; model: ResolvedModel | undefined }, store?: LocalStore): void {
	const provider = ctx?.model?.provider ?? "—";
	const model = ctx?.model?.id ?? "(no autenticado)";
	out.write(`AIES · ${provider} / ${model}\n`);
	const resume = store?.loadState();
	if (resume && (resume.taskState === "En curso" || resume.taskState === "Recibida")) {
		const obj = resume.task.objetivo.length > 60 ? `${resume.task.objetivo.slice(0, 57)}…` : resume.task.objetivo;
		out.write(`reanudar: ${obj}  ·  /resume continúa\n`);
	} else {
		out.write("Escribe una tarea  ·  / para comandos\n");
	}
}

/** Wrapper retrocompatible — usado en tests históricos (`cli.test.ts`). */
export function bannerCompat(out: NodeJS.WritableStream = output): void {
	const bar = BANNER_BAR;
	const top = `┌${bar}┐`;
	const bot = `└${bar}┘`;
	const l1 = "│  AIES — Autonomous Software Engineering Harness │";
	const l2 = "│  Escribe tu tarea o /help para comandos       │";
	out.write(`${top}\n${pad(l1)}\n${pad(l2)}\n${bot}\n`);
}

const HELP_TEXT = [
	"Comandos disponibles:",
	formatHelpCommands(),
	"",
	"Detalles:",
	"  /resume                     — reanuda la tarea En curso persistida",
	"  /resume \"<guía>\"            — reanuda inyectando la guía como knownInfo",
	"  /state                      — vista humana del RuntimeState actual",
	"  /state --json               — JSON resumido del RuntimeState actual",
	"  /status                     — estado + telemetría agregada del historial (log.jsonl)",
	"  /log [n|all]                — tail de log.jsonl (últimas n vueltas; por defecto 20)",
	"  /login                      — abre el selector de proveedor y método",
	"  /logout                     — abre el selector de proveedor o Todos",
	"  /model                      — lista modelos de providers autenticados",
	"  /model <id>                 — usa ese modelo para el resto de esta sesión (no persiste)",
	"",
	" Cualquier otro texto se ejecuta como una nueva tarea sobre el proyecto.",
	" Mientras corre una tarea, escribe para intervenir (se aplicará en la siguiente decisión);",
	" ESC la pausa (sigue en /resume); Ctrl+C la pausa y cierra la sesión",
	" (un 2º Ctrl+C fuerza salida inmediata).",
	" Persistencia: .aies/state.json y .aies/log.jsonl tras cada ciclo.",
	" provider/modelo por defecto: aies.config.json (usar /pick para hacerlo permanente).",
].join("\n");

function helpText(): string {
	return HELP_TEXT;
}

// PROVIDER_ENV_KEY vive en ./auth.js (compartida con /login, /auth); re-exportada aquí por
// compatibilidad — nada más en el paquete la importaba desde cli.ts antes de este cambio.
export { PROVIDER_ENV_KEY };

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

/**
 * Confirmación extra cuando la autenticación viene de /login (credencial guardada), no de
 * env — preflight() de arriba sólo mira la env var y seguiría avisando en ámbar aunque el
 * provider SÍ esté configurado vía credencial persistida. No toca preflight() para no
 * romper sus tests (comportamiento env-only intacto).
 */
export function authReadinessNotice(runtime: ModelRuntime, cfg: Config, out: NodeJS.WritableStream): void {
	const status = runtime.getProviderAuthStatus(cfg.provider);
	if (status.configured && status.source && status.source !== "environment") {
		out.write(`aies: ${cfg.provider} autenticado vía ${status.source} (/login).\n`);
	}
}

export function priorInProgressNotice(state: RuntimeState | null): string | null {
	if (!state || (state.taskState !== "En curso" && state.taskState !== "Recibida")) return null;
	return `aies: hay una tarea previa "${state.taskState}" (objetivo: "${state.task.objetivo}"). Usa /resume para continuarla. Cualquier otro texto arranca una tarea nueva.`;
}

export function oneshotOverwriteNotice(state: RuntimeState | null): string | null {
	if (!state || (state.taskState !== "En curso" && state.taskState !== "Recibida")) return null;
	return `aies: hay una tarea previa "${state.taskState}" (objetivo: "${state.task.objetivo}"). Esta oneshot la sobreescribirá.`;
}

export function schemaInvalidNotice(reason: "corrupt" | "schema" | "unsupported_version"): string {
	return reason === "schema"
		? "aies: state.json con schema antiguo o incompleto; se ignora (no reanudable)."
		: reason === "unsupported_version"
			? "aies: state.json con versión no soportada; se ignora (no reanudable)."
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
	// ADR-012: una tarea pausada antes del primer ajuste de plan queda en "Recibida"; también es
	// reanudable. Coherente con `persistence/recover.ts::isResumable` (ya lo aceptaba).
	if (!state || (state.taskState !== "En curso" && state.taskState !== "Recibida")) {
		return { ok: false, message: 'aies: no hay una tarea reanudable ("En curso"/"Recibida").' };
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
	"  aies \"<tarea>\"             ejecuta una tarea y termina",
	"  aies \"<tarea>\" --json      igual, pero stdout es una sola línea de JSON (scripts/pipes)",
	"  aies                         inicia el REPL interactivo",
	"  aies auth                    estado de autenticación por provider",
	"  aies login <proveedor>       guarda una API key (persiste en ~/.pi/agent/auth.json)",
	"  aies logout <proveedor>      borra la credencial persistida",
	"  aies models [@prov] [q]      lista modelos (pipe-safe)",
	"  aies pick <rol> <ref>        asigna un modelo por rol (escribe aies.config.json)",
	"  aies update                  actualiza AIES mediante el instalador oficial",
	"  aies -V, --version           muestra la versión y el commit actual",
	"  aies -h, --help              muestra esta ayuda",
	"",
	"  AIES_NO_UPDATE_CHECK=1 desactiva el chequeo automático de actualizaciones.",
	"  AIES_MODEL=<id>         fuerza un modelo puntual, sin tocar aies.config.json.",
].join("\n");

function clearScreen(): void {
	// ANSI: ESC[2J (borrar pantalla) + ESC[H (cursor arriba-izquierda).
	if (input.isTTY && output.isTTY) output.write("\x1b[2J\x1b[H");
	else output.write("\n");
}

/**
 * Lee UNA línea del REPL preservando saltos de línea dentro de un paste.
 *
 * Por qué existe:
 *   `rl.question(prompt)` resuelve en el PRIMER \n del input — incluyendo los \n
 *   embebidos en un paste multi-línea. Sin este wrapper, pegar "line1\nline2\n"
 *   envía "line1" como tarea al orquestador mientras "line2\n" aún llega al
 *   stream, donde el listener de intervención (`runTrackedReplCycle::onInterventionLine`)
 *   los captura como `⚑ tú (intervención)` y los mete en la cola.
 *
 * Diseño:
 *   1. NO usamos `rl.question()` (consume la primera línea sin emitir `'line'`).
 *      Mostramos el prompt con `rl.prompt()` y escuchamos `'line'` + `'data'`
 *      directamente.
 *   2. Cada `'line'` event (paste \n y Enter \r) entra al buffer `lines`.
 *   3. La ÚNICA señal que dispara la resolución es un `\r` STANDALONE
 *      (no parte de CRLF) en el input crudo — eso es exactamente lo que
 *      envía la tecla Enter en TTY real, y lo que los tests simulan con
 *      `input.write("\r")`. CRLF llega como "\r\n" en el mismo chunk y NO
 *      cuenta → descarta falsos positivos de paste (los paste modernos
 *      usan \n, pero por si acaso).
 *   4. `close` (Ctrl+C desde el SIGINT handler del REPL, Ctrl+D directo)
 *      rechaza: el caller hace `break` sin enviar contenido parcial.
 *
 * Por qué NO usamos debounce:
 *   Resolvería también al "final de paste sin Enter", que es exactamente el
 *   bug que arreglamos. La señal correcta es Enter (tecla explícita del
 *   usuario), NO el silencio del stream.
 *
 * Garantías del contrato (`tests/cli-repl.test.ts`):
 *   - Pulsar Enter UNA vez produce UNA llamada al orquestador.
 *   - El mensaje preserva los saltos de línea del paste.
 *   - Paste sin Enter posterior NO dispara el orquestador.
 *   - Ningún fragmento del mensaje se convierte en intervención.
 *   - Ctrl+C / cierre del stream NO envía contenido parcial.
 */
export function readPromptLine(
	rl: readline.Interface,
	inputStream: NodeJS.ReadableStream,
	prompt: string,
	options: { resolveOnLine?: boolean } = {},
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const lines: string[] = [];
		let settled = false;
		let enterPressed = false;

		const trimTrailingEmpty = () => {
			while (lines.length > 0 && lines[lines.length - 1] === "") {
				lines.pop();
			}
		};

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			rl.removeListener("line", onLine);
			rl.removeListener("close", onClose);
			inputStream.removeListener("data", onData);
			fn();
		};

		// Detecta Enter en el input crudo. CRLF ("\r\n") se ignora; un \r
		// standalone al final del chunk sí cuenta. (Un paste con line endings
		// CR-only, raro/legacy, sería un falso positivo — aceptable.)
		const onData = (chunk: Buffer | string) => {
			const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (str.endsWith("\r") && !str.endsWith("\r\n")) {
				enterPressed = true;
			}
		};

		// Acumulamos cada line event. Sólo resolvemos cuando Enter fue pulsado.
		const onLine = (line: string) => {
			lines.push(line);
			if (enterPressed || options.resolveOnLine) {
				settle(() => {
					trimTrailingEmpty();
					resolve(lines.join("\n"));
				});
			}
		};

		const onClose = () => settle(() => reject(new Error("readline closed")));

		// `prependListener` para que onData se registre ANTES que el handler interno
		// de readline y así procesemos el \r (Enter) en el mismo tick que el `line`
		// event correspondiente — si va detrás, llegaría tarde y no detectaríamos
		// el Enter en la primera línea de un paste+Enter compacto.
		inputStream.prependListener("data", onData);
		rl.on("line", onLine);
		rl.once("close", onClose);

		rl.setPrompt(prompt);
		rl.prompt();
	});
}

/** Discovery live bajo el prompt, sin alternate screen ni estado persistido. */
function setupSlashDiscovery(
	rl: readline.Interface,
	inputStream: NodeJS.ReadableStream,
	out: NodeJS.WritableStream,
	isIdle: () => boolean,
): { dispose: () => void } {
	let visibleLines = 0;
	let enabled = true;
	const clearSuggestions = () => {
		if (visibleLines === 0) return;
		out.write("\x1b7\x1b[1B\r");
		for (let index = 0; index < visibleLines; index += 1) {
			out.write("\x1b[2K");
			if (index < visibleLines - 1) out.write("\x1b[1B\r");
		}
		out.write("\x1b8");
		visibleLines = 0;
	};
	const render = () => {
		if (!enabled || !isIdle()) return clearSuggestions();
		const line = rl.line;
		if (!/^\/[^\s]*$/.test(line) || parseSlashCommand(line)) return clearSuggestions();
		const suggestions = filterSlashCommands(line);
		clearSuggestions();
		if (suggestions.length === 0) return;
		const lines = suggestions.map((command) => `  /${command.name.padEnd(10)} ${command.description}`);
		out.write("\x1b7\x1b[1B\r");
		out.write(`${lines.join("\n")}\n`);
		out.write("\x1b8");
		visibleLines = lines.length;
	};
	const onKeypress = () => {
		// readline actualiza `rl.line` justo después del evento keypress.
		setImmediate(render);
	};
	inputStream.on("keypress", onKeypress);
	return {
		dispose: () => {
			enabled = false;
			inputStream.removeListener("keypress", onKeypress);
			clearSuggestions();
		},
	};
}

/** Wrapper local de defaultConfigPath (re-export para los comandos REPL/oneshot). */
function defaultConfigPathLocal(): string {
	return defaultConfigPath();
}

async function runPickOneshot(rest: string[]): Promise<number> {
	const runtime = await getModelRuntime();
	const cfg = loadConfig();
	const configPath = defaultConfigPathLocal();
	await runPickCommand(null, runtime, cfg, configPath, rest.join(" ").trim());
	return 0;
}

export function canonicalLoginProvider(providerId: string): string {
	const normalized = providerId.toLowerCase();
	if (normalized === "openai" || normalized === "chatgpt") return "openai-codex";
	if (normalized === "qwen" || normalized === "alibaba" || normalized === "modelstudio" || normalized === "qwen-token-plan") return "qwen-token-plan-cn";
	return normalized;
}

function formatAuthenticatedModels(runtime: ModelRuntime, activeModel: ResolvedModel | undefined): string {
	const lines = [`aies: provider=${activeModel?.provider ?? "(ninguno)"} modelo=${activeModel?.id ?? "(ninguno)"} — ${activeModel ? "ok" : "sin modelo autenticado"}.`, "", "Modelos utilizables:"];
	let count = 0;
	for (const provider of runtime.getProviders()) {
		if (!runtime.hasConfiguredAuth(provider.id)) continue;
		const models = runtime.getModels(provider.id);
		if (models.length === 0) continue;
		lines.push(`  ${provider.name ?? provider.id}`);
		for (const model of models) lines.push(`    ${model.id}${model.id === activeModel?.id && model.provider === activeModel?.provider ? "  ✓ activo" : ""}`);
		count += models.length;
	}
	if (count === 0) lines.push("  (ningún provider autenticado; ejecuta /login)");
	return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

export interface CliOptions {
	cwd: string;
	taskArg: string | null;
	repl: boolean;
}

/**
 * Resuelve provider+id de aies.config.json (o AIES_MODEL como override puntual) contra el
 * catálogo real de `runtime`.
 *
 * Antes esta función era un stub que siempre devolvía undefined — aies.config.json's
 * `provider`/`models` no tenían ningún efecto; el host resolvía silenciosamente su propio
 * modelo por defecto sin importar lo que dijera el config. Ese comportamiento se descubrió
 * al construir /login y /models: sin esta función real ninguna de las dos podía demostrarse
 * (¿de qué sirve iniciar sesión en un provider si el config nunca lo llegaba a usar?).
 *
 * getModel() sólo busca el id en el catálogo — NO valida credenciales; la autenticación se
 * resuelve más tarde, en la primera llamada real al modelo (mismo diseño no-bloqueante que
 * preflight()).
 */
async function resolveModel(
	runtime: ModelRuntime,
	cfg: Config,
	overrideId: string | undefined,
	out: NodeJS.WritableStream,
): Promise<ResolvedModel | undefined> {
	const modelId = overrideId ?? cfg.models.orchestrator;
	if (!modelId) return undefined;
	const found = runtime.getModel(cfg.provider, modelId);
	if (!found) {
		out.write(
			`${amber("▲")} aies: modelo "${modelId}" no encontrado para provider "${cfg.provider}" — el runtime usará su modelo por defecto. Usa /models para ver los disponibles.\n`,
		);
		return undefined;
	}
	return found;
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

/**
 * Subcomandos de auth/modelos, resueltos antes de tocar aies.config.json: /login, /logout y
 * /auth son operaciones sobre el credential store de pi, no sobre el proyecto — no deberían
 * fallar sólo porque aies.config.json esté roto o ausente. `models` es la única excepción,
 * ya que sin `@provider` explícito necesita un provider por defecto de algún sitio.
 *
 * Devuelve true si `argv` era uno de estos subcomandos (y ya se ha hecho process.exit()).
 */
async function tryRunAuthSubcommand(argv: string[]): Promise<boolean> {
	const [command, ...rest] = argv;

	if (command === "auth" && rest.length === 0) {
		const runtime = await getModelRuntime();
		for (const line of formatAuthStatusLines(runtime)) output.write(`${line}\n`);
		process.exit(0);
	}

	if (command === "login") {
		const providerId = rest[0];
		if (!providerId) {
			output.write("Uso: aies login <provider>   (ver providers con: aies auth)\n");
			process.exit(2);
		}
		const runtime = await getModelRuntime();
		const target = canonicalLoginProvider(providerId);
		const option = supportedLoginProviders(runtime).find((candidate) => candidate.providerId === target);
		const result = await loginProvider(runtime, target, output, undefined, option?.authType ?? "api_key", option?.keyPrefix);
		output.write(result.ok ? `✓ ${result.providerId}: autenticado (credential store de pi).\n` : `✗ ${result.providerId}: ${result.error}\n`);
		process.exit(result.ok ? 0 : 1);
	}

	if (command === "logout") {
		const providerId = rest[0];
		if (!providerId) {
			output.write("Uso: aies logout <provider>\n");
			process.exit(2);
		}
		const runtime = await getModelRuntime();
		const result = await logoutProvider(runtime, canonicalLoginProvider(providerId));
		output.write(result.ok ? `✓ ${result.providerId}: sesión cerrada.\n` : `✗ ${result.providerId}: ${result.error}\n`);
		process.exit(result.ok ? 0 : 1);
	}

	if (command === "models") {
		// aies.config.json es opcional aquí — sólo aporta el provider por defecto cuando no
		// se pasa @provider; sin config válido, cae a "anthropic" (el default del propio schema).
		let defaultProvider = "anthropic";
		try {
			defaultProvider = loadConfig().provider;
		} catch {
			/* sin config válido: usar el default */
		}
		const { providerId, query } = parseModelsQuery(rest.join(" "), defaultProvider);
		const runtime = await getModelRuntime();
		const all = resolveModelsForListing(runtime, providerId);
		const filtered = searchModels(all, query);
		output.write(`Modelos — ${providerId}${query ? ` · "${query}"` : ""} (${filtered.length}/${all.length})\n`);
		output.write(`${formatModelsTable(filtered)}\n`);
		process.exit(0);
	}

	return false;
}

async function main(): Promise<void> {
	// T4.3: --json se reconoce en cualquier posición y se retira de argv antes de
	// cualquier otro dispatch (subcomandos, tarea) — así ni "aies --json login x" ni
	// "aies login x --json" cambian cómo se parsean update/pick/auth/la tarea en sí.
	// Sólo lo consume el camino oneshot; en los demás simplemente desaparece del argv.
	const rawArgv = process.argv.slice(2);
	const jsonMode = rawArgv.includes("--json");
	const argv = jsonMode ? rawArgv.filter((a) => a !== "--json") : rawArgv;
	if (argv.length >= 1 && argv[0] === "update" && argv.length === 1) {
		process.exit(await runUpdate());
	}
	if (argv.length >= 1) {
		const command = argv[0]!;
		if (command === "--version" || command === "-V") {
			await printVersion();
			process.exit(0);
		}
		if (command === "--help" || command === "-h") {
			output.write(`${CLI_HELP_TEXT}\n`);
			process.exit(0);
		}
		if (command === "pick") {
			process.exit(await runPickOneshot(argv.slice(1)));
		}
	}
	if (argv.length >= 1 && ["auth", "login", "logout", "models"].includes(argv[0]!)) {
		await tryRunAuthSubcommand(argv);
	}
	const taskArg = argv.length > 0 ? argv.join(" ").trim() : null;
	const repl = taskArg === null || taskArg.length === 0;
	const cwd = process.cwd();

	// json: nada de lo previo a la ejecución (config rota, preflight, auth, modelo no
	// encontrado) puede aterrizar en stdout — todo va a stderr, stdout se reserva
	// enteramente para el JSON final.
	const diagOut = jsonMode ? process.stderr : output;

	let cfg;
	try {
		cfg = loadConfig();
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		diagOut.write(`aies: aies.config.json ausente o inválido: ${msg}\n`);
		process.exit(2);
	}
	const limits: Limits = limitsFromConfig(cfg);
	const updatePromise = checkForUpdate();
	const thinkingLevel = cfg.orchestratorThinkingLevel;
	const runtime = await getModelRuntime();
	const model = await resolveModel(runtime, cfg, process.env.AIES_MODEL, diagOut);
	preflight(cfg, diagOut);
	authReadinessNotice(runtime, cfg, diagOut);

	if (repl) {
		await runRepl({ cwd, limits, model, thinkingLevel, updatePromise, runtime, cfg });
	} else {
		const exitCode = await runOneshot(taskArg!, {
			cwd,
			limits,
			model,
			thinkingLevel,
			updatePromise,
			json: jsonMode,
			diagOut,
		});
		const status = await waitForUpdateNotice(updatePromise);
		const notice = formatUpdateNotice(status ?? { kind: "skipped" });
		// json: el JSON ya se escribió (una única línea) dentro de runOneshot() — el
		// aviso de actualización, si lo hay, va a stderr, nunca añadido después en stdout.
		if (notice) diagOut.write(`\n${notice}\n`);
		process.exit(exitCode);
	}
}

/** Payload de `--json`: mismo lenguaje que `/state --json` (summarizeState), más el desenlace del oneshot en sí. */
export function summarizeOneshotResult(result: RunCycleResult): Record<string, unknown> {
	return {
		ok: result.completed,
		exitCode: oneshotExitCode(result),
		interrupted: result.interrupted,
		completed: result.completed,
		state: summarizeState(result.state),
	};
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
		/**
		 * T4.3: stdout (`out`) carries ONLY one line of JSON — the machine-readable
		 * result, so `aies "<tarea>" --json | jq .` never sees anything else.
		 * Every human notice this function would normally print (loaded-state
		 * warnings, "tarea pausada", "tarea terminó en estado X") goes to
		 * `diagOut` instead (stderr in practice — see main()), same unix split as
		 * any tool meant to be piped: stdout = payload, stderr = diagnostics.
		 */
		json?: boolean | undefined;
		diagOut?: NodeJS.WritableStream | undefined;
	},
): Promise<number> {
	const out = ctx.out ?? output;
	const diag = ctx.json ? (ctx.diagOut ?? process.stderr) : out;
	const task = taskFromArg(taskArg);
	const store = ctx.store ?? new LocalStore(ctx.cwd);
	const loaded = store.loadStateResult();
	if (loaded.kind === "invalid") diag.write(`${schemaInvalidNotice(loaded.reason)}\n`);
	const prior = loaded.kind === "ok" ? loaded.state : null;
	const overwrite = oneshotOverwriteNotice(prior);
	if (overwrite) diag.write(`${overwrite}\n`);

	const controller = new AbortController();
	// ADR-012 — 1ª SIGINT aborta y deja la tarea pausada (reanudable); 2ª SIGINT fuerza exit(130).
	let sigintCount = 0;
	const onSigint = () => {
		sigintCount += 1;
		if (sigintCount >= 2) {
			diag.write("\naies: segunda señal recibida — saliendo (130).\n");
			process.exit(130);
		}
		controller.abort(new Error("SIGINT"));
	};
	if (!ctx.signal) process.on("SIGINT", onSigint);

	const result = await runCycle(task, {
		cwd: ctx.cwd,
		model: ctx.model,
		thinkingLevel: ctx.thinkingLevel,
		limits: ctx.limits,
		signal: ctx.signal ?? controller.signal,
		store,
		// json: el StreamRenderer por defecto de runCycle() pinta a `output` (ANSI,
		// spinners, bloques de worker) — ese ruido se manda a stderr, nunca a stdout.
		renderer: ctx.renderer ?? (ctx.json ? new StreamRenderer(diag) : undefined),
		decideOverride: ctx.decideOverride,
		executeOverride: ctx.executeOverride,
	});

	if (!ctx.signal) process.off("SIGINT", onSigint);

	if (ctx.json) {
		out.write(`${JSON.stringify(summarizeOneshotResult(result))}\n`);
		return oneshotExitCode(result);
	}

	if (result.completed) return 0;
	if (result.interrupted) {
		out.write("\naies: tarea pausada; reanúdala en la siguiente invocación con `/resume`.\n");
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
	runtime: ModelRuntime;
	cfg: Config;
}): Promise<void> {
	const store = new LocalStore(ctx.cwd);
	const prompt = new PromptUI({ streams: { input, output }, prompt: "❯ " });
	banner(output, { runtime: ctx.runtime, model: ctx.model }, store);
	for (const msg of replStartupMessages(store)) output.write(`${msg}\n`);
	let currentState: RuntimeState | null = store.loadState();
	// /model la cambia para el resto de esta sesión — no toca aies.config.json, así que no hay
	// que preocuparse por dejar el repo con cambios sin querer.
	let activeModel = ctx.model;
	const updateStatus = await waitForUpdateNotice(ctx.updatePromise);
	const updateNotice = formatUpdateNotice(updateStatus ?? { kind: "skipped" });
	if (updateNotice) prompt.info(`\n${updateNotice}`);

	let runInProgress = false;
	let activeAbort: AbortController | null = null;
	// T2.1 — cola de intervención acumulada mientras corre un run.
	const interventionQueue: string[] = [];

	// ADR-012 — control plane del REPL. Cierra tras el ciclo en curso y deja la tarea PAUSADA
	// (no Fallida). El estado ya quedó persistido por `runCycle::saveState` antes de retornar.
	let exitAfterCycle = false;
	let sigintCount = 0;
	const onSigint = () => {
		sigintCount += 1;
		if (sigintCount >= 2) {
			// 2º SIGINT en cualquier momento dentro del REPL → forzar salida inmediata.
			output.write(`\naies: segunda señal recibida — saliendo (130).\n`);
			process.exit(130);
		}
		if (runInProgress && activeAbort) {
			activeAbort.abort(new Error("SIGINT"));
			exitAfterCycle = true;
		} else if (!runInProgress) {
			// Sin run en curso: SIGINT cierra el REPL directamente.
			exitAfterCycle = true;
			prompt.info("(Ctrl+C — envía otra para salir)");
		}
	};
	process.on("SIGINT", onSigint);

	// Cierre limpio del REPL con /exit o EOF.
	const close = () => {
		process.off("SIGINT", onSigint);
	};

	try {
		while (true) {
			let raw: string;
			try {
				raw = await prompt.readLine();
			} catch {
				// EOF (Ctrl+D) o stream cerrado.
				break;
			}
			const input0 = raw.trim();
			if (!input0) continue;
			// Tras cada comando atendido: el próximo SIGINT empieza una ráfaga nueva.
			sigintCount = 0;

			// ── FASE 9: ningún control command acaba persistido como Task. ──
			if (bareExitTokens().includes(input0)) break;
			if (input0 === "/exit" || input0 === "/quit") break;

			const parsed = parseSlashCommand(input0);

			// Comando slash vacío o parcialmente coincidiente: command palette interactivo.
			if (input0 === "/" || (input0.startsWith("/") && !parsed)) {
				const dispatched = await runSlashPaletteDispatch({
					ctx,
					prompt,
					store,
					input0,
					setActiveModel: (m) => {
						activeModel = m;
					},
					onExit: () => {
						exitAfterCycle = true;
					},
				});
				if (dispatched.kind === "exit") break;
				continue;
			}

			if (input0 === "/help") {
				prompt.info(helpText());
				continue;
			}
			if (input0 === "/clear") {
				clearScreen();
				continue;
			}
			if (input0 === "/state" || input0.startsWith("/state ")) {
				const snapshot = currentState ?? store.loadState();
				prompt.info(formatStateOutput(input0, snapshot));
				continue;
			}
			if (input0 === "/status") {
				const snapshot = currentState ?? store.loadState();
				prompt.info(`${formatAuthenticatedModels(ctx.runtime, activeModel)}\n\n${formatStatus(snapshot, store.readLogIndexed())}`);
				continue;
			}
			if (input0 === "/log" || input0.startsWith("/log ")) {
				const arg = input0.slice("/log".length).trim();
				prompt.info(formatLogTail(store.readLogIndexed(), parseLogArg(arg)));
				continue;
			}
			if (input0 === "/auth") {
				for (const line of formatAuthStatusLines(ctx.runtime)) prompt.info(line);
				continue;
			}
			if (input0 === "/login" || input0.startsWith("/login ")) {
				const r = await runLoginFlow(ctx, prompt, input0);
				if (r?.kind === "activated") activeModel = r.activeModel ?? activeModel;
				continue;
			}
			if (input0 === "/logout" || input0.startsWith("/logout ")) {
				const r = await runLogoutFlow(ctx, prompt, input0);
				if (r?.kind === "deactivated") activeModel = undefined;
				continue;
			}
			if (input0 === "/model" || input0.startsWith("/model ")) {
				const r = await runModelFlow(ctx, prompt, input0, activeModel);
				if (r?.kind === "selected") activeModel = r.model;
				continue;
			}
			if (input0 === "/models" || input0.startsWith("/models ")) {
				// Fase 8 — /models es alias de /model (selector interactivo con filtro).
				const r = await runModelFlow(ctx, prompt, "/model", activeModel);
				if (r?.kind === "selected") activeModel = r.model;
				continue;
			}
			if (input0 === "/resume" || input0.startsWith("/resume ")) {
				const guide = parseResumeGuide(input0);
				const resolved = resolveResume(currentState ?? store.loadState());
				if (!resolved.ok) {
					prompt.info(resolved.message);
					continue;
				}
				const result = await runTrackedReplCycle(prompt, interventionQueue, {
					mark: (running, abort) => {
						runInProgress = running;
						activeAbort = abort;
					},
					run: (signal) =>
						runResumeCycle(resolved.state, {
							cwd: ctx.cwd,
							model: activeModel,
							thinkingLevel: ctx.thinkingLevel,
							limits: ctx.limits,
							signal,
							store,
							pollIntervention: () => drainInterventionQueue(interventionQueue),
							resumeGuide: guide,
						}),
				});
				if (result) currentState = result.state;
				if (exitAfterCycle) break;
				continue;
			}
			if (input0 === "/pick" || input0.startsWith("/pick ")) {
				const cfg = loadConfig();
				const configPath = defaultConfigPathLocal();
				const pickRl = prompt.createReadline();
				try {
					await runPickCommand(pickRl, ctx.runtime, cfg, configPath, input0.slice("/pick".length).trim());
				} finally {
					pickRl.close();
				}
				continue;
			}

			// Nueva tarea sobre el proyecto (manteniendo persistencia).
			const task = taskFromArg(input0);
			const before = currentState;
			const result = await runTrackedReplCycle(prompt, interventionQueue, {
				mark: (running, abort) => {
					runInProgress = running;
					activeAbort = abort;
				},
				run: (signal) =>
					runCycle(task, {
						cwd: ctx.cwd,
						model: activeModel,
						thinkingLevel: ctx.thinkingLevel,
						limits: ctx.limits,
						signal,
						store,
						pollIntervention: () => drainInterventionQueue(interventionQueue),
					}),
			});
			if (result) currentState = result.state;
			else if (before && !currentState) currentState = before;
			if (exitAfterCycle) break;
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
	prompt: PromptUI,
	interventionQueue: string[],
	opts: {
		mark: (running: boolean, abort: AbortController | null) => void;
		run: (signal: AbortSignal) => Promise<RunCycleResult>;
	},
): Promise<RunCycleResult | undefined> {
	const abort = new AbortController();
	opts.mark(true, abort);
	// T2.1 — el readline efímero sólo vive durante el run; se cierra en `finally` para no
	// filtrar entradas al próximo `prompt.readLine()` del REPL.
	const rl = prompt.createReadline();
	const out = process.stdout;
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
	// ADR-012 — ESC durante el run = parar la tarea y volver al prompt.
	// Sólo aplica en TTY (en pipe no llegan keypress).
	const onKeypress = (_ch: string | undefined, key: Key | undefined) => {
		if (key?.name === "escape") abort.abort(new Error("ESC"));
	};
	let keypressTarget: NodeJS.ReadStream | null = null;
	if (prompt.isTTY) {
		keypressTarget = prompt.streams().input as NodeJS.ReadStream;
		emitKeypressEvents(keypressTarget);
		keypressTarget.on("keypress", onKeypress);
	}
	try {
		out.write(`${pc.dim("(escribe para intervenir · ESC para parar · Ctrl+C para salir)")}\n`);
		const result = await opts.run(abort.signal);
		if (result.interrupted) {
			const reason = String(abort.signal.reason ?? "");
			if (reason.includes("SIGINT")) {
				out.write("\naies: tarea pausada — sesión cerrada. El estado queda guardado para /resume.\n");
			} else {
				out.write("\naies: tarea pausada (ESC). Usa /resume para continuarla.\n");
			}
		}
		return result;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		out.write(`\naies: error — ${msg}\n`);
		return undefined;
	} finally {
		rl.removeListener("line", onInterventionLine);
		if (keypressTarget) keypressTarget.removeListener("keypress", onKeypress);
		rl.close();
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
