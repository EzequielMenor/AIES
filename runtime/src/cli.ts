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
import { runModelsCommand, runPickCommand } from "./cli-models.js";
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
	type WorkerReport,
	initState,
} from "./core/state.js";
import { DEFAULT_VERIFICATION, verificationFromConfig, type VerificationPolicy } from "./config.js";
import { limitsFromConfig } from "./limits.js";
import {
	ROLES,
	isRole,
	resolveRoleModels,
	roleModelLabel,
	type ResolvedModel,
	type Role,
	type RoleModels,
} from "./model-runtime.js";
import { createDecide } from "./orchestrator/decide.js";
import { runWorker, toWorkerRunParams, type WorkerRunParams, type WorkerToolContext } from "./workers/tools.js";
import {
	formatCheckCommand,
	runProjectChecks,
	type ProjectChecksReport,
} from "./verification/engine.js";
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

export type ExecuteFn = (
	state: RuntimeState,
	decision: Decision,
	events: WorkerEventSink,
) => Promise<ExecuteOutcome>;

/** Suma la telemetría de varias invocaciones de worker en un mismo turno (execute puede
 *  re-invocar al implementer en los ciclos de reparación). `null` = aún no conocida. */
function mergeTelemetry(a: WorkerTelemetry, b: WorkerTelemetry): WorkerTelemetry {
	if (!a.usage) return b;
	if (!b.usage) return a;
	return {
		usage: {
			tokens: {
				input: a.usage.tokens.input + b.usage.tokens.input,
				output: a.usage.tokens.output + b.usage.tokens.output,
				cacheRead: a.usage.tokens.cacheRead + b.usage.tokens.cacheRead,
				cacheWrite: a.usage.tokens.cacheWrite + b.usage.tokens.cacheWrite,
				total: a.usage.tokens.total + b.usage.tokens.total,
			},
			cost: a.usage.cost + b.usage.cost,
		},
		contextUsage: b.contextUsage ?? a.contextUsage,
		telemetryUnavailable: false,
	};
}

/** Evidencia de los checks deterministas como criterios del reporte estructurado. */
function gateCriteria(gate: ProjectChecksReport): WorkerReport["criteria"] {
	return gate.results.map((res) => ({
		criterion: `check determinista: ${res.command}`,
		status: res.status === "pass" ? ("pass" as const) : ("fail" as const),
		evidence: res.status === "pass" ? "exit 0" : res.failure.slice(0, 300) || `status ${res.status}`,
	}));
}

/** Fusiona el reporte del worker con la evidencia determinista (invariante 6: sin éxito inventado). */
function augmentReport(report: WorkerReport | null, gate: ProjectChecksReport): WorkerReport | null {
	if (!report) return report;
	const criteria = [...report.criteria, ...gateCriteria(gate)];
	const unmet = [...report.unmetCriteria, ...gate.results.filter((r) => r.status !== "pass").map((r) => `check determinista "${r.name}" (${r.status})`)];
	const status: WorkerReport["status"] = gate.allPassed ? report.status : "unsatisfied";
	return { status, summary: report.summary, criteria, unmetCriteria: unmet };
}

function buildExecute(wctx: WorkerToolContext, signal: AbortSignal | undefined, verification: VerificationPolicy): ExecuteFn {
	/** Corrección clave: correr checks sin flags inventados y reusar los mismos eventos. */
	const runGate = (events: WorkerEventSink) =>
		runProjectChecks(wctx.cwd, {
			timeoutMs: verification.checkTimeoutMs,
			onStart: (c) => events.onDeterministicCheckStart?.(c.name, formatCheckCommand(c)),
			onDone: (res) => events.onDeterministicCheckResult?.(res.name, res.command, res.status === "pass", res.failure),
		});
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

				let telemetryTotal: WorkerTelemetry = NO_TELEM;
				const absorb = (t: WorkerTelemetry): void => {
					telemetryTotal = mergeTelemetry(telemetryTotal, t);
				};

				// ── Deterministic-first para el verifier: los checks reales del proyecto se
				// ejecutan ANTES de gastar tokens del verifier LLM. Si fallan, el orquestador
				// recibe la salida exacta sin LLM; si pasan y no quedan criterios semánticos,
				// la unidad cierra con cero overhead de verificador.
				let gateBeforeVerifier: ProjectChecksReport | null = null;
				if (cap === "verifier" && verification.deterministic) {
					const gate = await runGate(events);
					if (!gate.empty && !gate.blocked) {
						gateBeforeVerifier = gate;
						if (!gate.allPassed) {
							const report: WorkerReport = {
								status: "unsatisfied",
								summary: `verificación determinista fallida (${gate.results.filter((r) => r.status !== "pass").map((r) => r.name).join(", ")})`,
								criteria: gateCriteria(gate),
								unmetCriteria: gate.results.filter((r) => r.status !== "pass").map((r) => r.name),
							};
							return {
								result: { kind: "unidad", text: `${report.summary}\n\n${gate.failureContext}`, unidadId: unit.id, passed: false } satisfies OperationResult,
								telemetry: telemetryTotal,
								report,
								reportError: null,
							};
						}
						if ((unit.criteriosAceptacion?.length ?? 0) === 0) {
							const report: WorkerReport = {
								status: "satisfied",
								summary: `verificación determinista: ${gate.results.map((r) => r.name).join(", ")} en exit 0`,
								criteria: gateCriteria(gate),
								unmetCriteria: [],
							};
							return {
								result: { kind: "unidad", text: report.summary, unidadId: unit.id, passed: true } satisfies OperationResult,
								telemetry: telemetryTotal,
								report,
								reportError: null,
							};
						}
						// Los checks pasaron; quedan criterios semánticos → verifier LLM con evidencia.
						params.evidenciaPrevia = [params.evidenciaPrevia, `checks deterministas ya en exit 0: ${gate.results.map((r) => r.command).join(", ")}`].filter(Boolean).join("\n");
					}
				}

				const r = await runWorker(cap, params, wctx, signal, events);
				absorb(r.telemetry);
				if (r.status === "failed") {
					return {
						result: { kind: "fallo", text: r.error, unidadId: unit.id, passed: false } satisfies OperationResult,
						telemetry: telemetryTotal,
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
				let report: WorkerReport | null = r.report ?? null;
				const reportError: string | null = r.reportError ?? null;
				let text = r.text;

				// ── El ciclo completo del MVP: implement → deterministic verify → failure
				// capture → focused repair → verify again. Sólo para implementers con reporte
				// (explorer no muta el repo; verifier ya gateó arriba).
				if (cap === "implementer" && verification.deterministic && passed !== false) {
					let gate = await runGate(events);
					while (!gate.empty && !gate.blocked && !gate.allPassed) {
						let attempt = 0;
						let lastFailure = gate.failureContext;
						while (!gate.allPassed && attempt < verification.maxRepairAttempts) {
							attempt += 1;
							events.onRepairAttempt?.(attempt, verification.maxRepairAttempts);
							const fixParams: WorkerRunParams = {
								...params,
								feedbackCorrectivo: [
									params.feedbackCorrectivo,
									`La verificación determinista del proyecto FALLÓ (intento de reparación ${attempt}/${verification.maxRepairAttempts}). Corrige SOLO lo necesario para que pasen los checks, sin ampliar el alcance. Salida exacta:\n\n${lastFailure}`,
								].filter(Boolean).join("\n\n"),
							};
							const fr = await runWorker("implementer", fixParams, wctx, signal, events);
							absorb(fr.telemetry);
							if (fr.status === "failed") {
								return {
									result: { kind: "fallo", text: `reparación abortada (intento ${attempt}/${verification.maxRepairAttempts}): ${fr.error}\n\n${lastFailure}`, unidadId: unit.id, passed: false } satisfies OperationResult,
									telemetry: telemetryTotal,
									report: fr.report ?? report,
									reportError: fr.reportError ?? reportError,
								};
							}
							text = fr.text;
							report = fr.report ?? report;
							passed = fr.report ? fr.report.status === "satisfied" : passed;
							gate = await runGate(events);
							lastFailure = gate.failureContext;
							if (gate.blocked) break;
						}
						break;
					}
					if (!gate.empty && !gate.blocked) {
						if (gate.allPassed) {
							report = augmentReport(report, gate) ?? report;
							// El gate determinista también puede DESCOLGAR el passed=true cuando
							// el worker no emitió reporte: aquí NO lo inventamos; null se conserva
							// y el bucle pedirá verifier/replan (invariante 6).
						} else {
							passed = false;
							report = augmentReport(report, gate) ?? report;
							text = `${text}\n\n# verificación determinista tras ${verification.maxRepairAttempts} reparaciones:\n${gate.failureContext}`;
						}
					}
				}

				if (cap === "verifier" && gateBeforeVerifier && passed === true) {
					report = augmentReport(report, gateBeforeVerifier) ?? report;
				}

				return {
					result: { kind: "unidad", text, unidadId: unit.id, passed } satisfies OperationResult,
					telemetry: telemetryTotal,
					report,
					reportError,
				};
			}
		}
	};
}

export interface RunCycleOptions {
	cwd: string;
	/** Modelo del orquestador (fallback para todos los roles si no se pasa `roleModels`).
	 *  Los tests inyectan aquí un único modelo; el CLI real rellena `roleModels` por rol. */
	model: ResolvedModel | undefined;
	/** Modelos resueltos por rol (model-per-role real). Si está, cada worker ejecuta con el suyo. */
	roleModels?: RoleModels | undefined;
	/** Runtime de modelos compartido (catálogo+credenciales) — se propaga a todas las sesiones.
	 *  Necesario para mezclar providers por rol sin recargar catálogos por worker. */
	modelRuntime?: ModelRuntime | undefined;
	thinkingLevel: "off" | "low" | "medium" | "high" | undefined;
	limits: Limits;
	signal: AbortSignal | undefined;
	store: LocalStore;
	renderer?: StreamRenderer | undefined;
	decideOverride?: ((state: RuntimeState) => Promise<DecideOutcome>) | undefined;
	executeOverride?: ExecuteFn | undefined;
	/** Snapshot persistido a reanudar. El caller debe pasar `task = resumeFrom.task`. */
	resumeFrom?: RuntimeState | undefined;
	/** Política de verificación determinista + reparación (default: DEFAULT_VERIFICATION). */
	verification?: VerificationPolicy | undefined;
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
	const orchestratorModel = opts.roleModels?.orchestrator ?? opts.model;
	const wctx: WorkerToolContext = {
		cwd: opts.cwd,
		// `model` = fallback (orquestador); `models` = modelos por capability resueltos del config.
		model: orchestratorModel,
		models: opts.roleModels
			? {
					explorer: opts.roleModels.explorer,
					implementer: opts.roleModels.implementer,
					verifier: opts.roleModels.verifier,
				}
			: undefined,
		thinkingLevel: opts.thinkingLevel,
		customTools: startup.customTools,
		integrationBits: startup.toolNames,
		modelRuntime: opts.modelRuntime,
	};
	const decideCtx = {
		cwd: opts.cwd,
		model: orchestratorModel,
		thinkingLevel: opts.thinkingLevel,
		signal: opts.signal,
		modelRuntime: opts.modelRuntime,
	};
	const renderer = opts.renderer ?? new StreamRenderer(output);
	const decide: (state: RuntimeState) => Promise<DecideOutcome> =
		opts.decideOverride ?? createDecide(decideCtx);
	const execute: ExecuteFn = opts.executeOverride ?? buildExecute(wctx, opts.signal, opts.verification ?? DEFAULT_VERIFICATION);

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
	// model-per-role real: propaga la etiqueta provider/model de cada rol al WorkerInfo para
	// que renderer y log.jsonl reflejen el modelo con que ejecuta cada worker.
	handlers.resolveWorkerModel = (role) => roleModelLabel(opts.roleModels?.[role] ?? orchestratorModel);
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

/** Etiquetas cortas por rol para el banner (una línea por asignación). */
const ROLE_SHORT: Record<Role, string> = { orchestrator: "orq", explorer: "exp", implementer: "imp", verifier: "ver" };

/**
 * Banner compacto. Una línea con los modelos por rol realmente resueltos (model-per-role
 * visible desde el arranque) + otra con la tecla de ayuda — coherente con la regla "el stream
 * manda, el chrome es mínimo" del spec.
 */
function banner(out: NodeJS.WritableStream = output, roleModels?: Partial<RoleModels>, store?: LocalStore, degraded = false): void {
	if (degraded) {
		// Hubo fallos explícitos de resolución: no fingir "default" — los errores ya se
		// imprimieron arriba y las tareas están bloqueadas hasta corregirlos.
		out.write(`AIES · ${amber("modelos: ✗ sin resolver — corrige con /model o /login (ver errores arriba)")}\n`);
	} else {
		const parts = ROLES.map((role: Role) => {
			const label = roleModelLabel(roleModels?.[role]) ?? "default";
			return `${ROLE_SHORT[role]} ${label}`;
		});
		// Si los cuatro roles comparten modelo, compactar en una sola etiqueta.
		const unique = new Set(parts.map((p) => p.split(" ").slice(1).join(" ")));
		const modelsLine = unique.size === 1 ? `Modelos: ${[...unique][0]}` : `Modelos: ${parts.join(" · ")}`;
		out.write(`AIES · ${modelsLine}\n`);
	}
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
	"  /model                      — tabla de asignaciones por rol (orchestrator/explorer/implementer/verifier)",
	"  /model <rol>                — elegir modelo para ese rol (buscador con auth; persiste)",
	"  /model <rol> <prov/modelo>  — asignación directa y persistente en aies.config.json",
	"  /model <query>              — cambio sólo de sesión (sin persistir) para el orquestador",
	"  /models                     — catálogo de modelos disponibles por provider (auth y roles asignados)",
	"",
	" Cualquier otro texto se ejecuta como una nueva tarea sobre el proyecto.",
	" Mientras corre una tarea, escribe para intervenir (se aplicará en la siguiente decisión);",
	" ESC la pausa (sigue en /resume); Ctrl+C la pausa y cierra la sesión",
	" (un 2º Ctrl+C fuerza salida inmediata).",
	" Persistencia: .aies/state.json y .aies/log.jsonl tras cada ciclo.",
	" provider/modelo por rol: aies.config.json (usa /model <rol> [ref] para cambiarlo).",
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
	"  aies run \"<tarea>\"         modo headless explícito (mismos códigos de salida; admite",
	"                             tarea por stdin: cat tarea.txt | aies run)",
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

/** Lee stdin sólo si viene pipeado (no TTY). `aies run` sin tarea acepta el prompt por stdin. */
function readPipedStdin(): Promise<string | null> {
	if (input.isTTY) return Promise.resolve(null);
	return new Promise((resolve) => {
		let buf = "";
		input.setEncoding("utf8");
		input.on("data", (chunk: string) => {
			buf += chunk;
		});
		input.on("end", () => resolve(buf.trim() ? buf.trim() : null));
		input.on("error", () => resolve(null));
		if (typeof input.resume === "function") input.resume();
	});
}

/**
 * Routing del prefijo `run`: `aies run "<tarea>"` es un oneshot headless explícito.
 * Pura y exportada para tests — el resto del dispatch de main() no cambia.
 */
export function stripRunPrefix(argv: string[]): { headless: boolean; rest: string[] } {
	if (argv.length > 0 && argv[0] === "run") return { headless: true, rest: argv.slice(1) };
	return { headless: false, rest: argv };
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
 * Resolución model-per-role REAL y estricta (correcciones al plan — autoridad superior).
 *
 * Reglas:
 *   - Cada rol (`orchestrator`, `explorer`, `implementer`, `verifier`) resuelve su propio
 *     `provider/model-id` contra el catálogo del runtime. No se reutiliza el modelo del
 *     orquestador en los workers salvo cuando el rol NO tiene elección explícita.
 *   - Un modelo EXPLÍCITAMENTE configurado que no existe / provider desconocido / sin auth
 *     produce un fallo ACCIONABLE (rol + provider + modelo + qué hacer). NO hay fallback
 *     silencioso.
 *   - `AIES_MODEL` cuenta como elección explícita para todos los roles (override puntual).
 *
 * `cfg` es opcional por tolerancia a tests; si falta, todo cae al default del runtime.
 */
function resolveModels(
	runtime: ModelRuntime,
	cfg: Config | undefined,
	overrideId: string | undefined,
	out: NodeJS.WritableStream,
): { roleModels: RoleModels; ok: boolean } {
	const effectiveCfg: Config = cfg ?? { provider: "anthropic", models: {}, orchestratorThinkingLevel: "low" };
	const resolution = resolveRoleModels(runtime, effectiveCfg, {
		overrideRef: overrideId,
		envHint: (provider) => PROVIDER_ENV_KEY[provider],
	});
	for (const failure of resolution.failures) {
		out.write(`${amber("✗")} aies: ${failure.message}\n`);
	}
	return { roleModels: resolution.models, ok: resolution.failures.length === 0 };
}

/** Etiqueta compacta `rol → provider/model` para banner/status (roles sin modelo → "default"). */
export function formatRoleModelLabels(roleModels: RoleModels): string {
	return ROLES.map((role: Role) => `${role} ${roleModelLabel(roleModels[role]) ?? "default"}`).join(" · ");
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
	let argv = jsonMode ? rawArgv.filter((a) => a !== "--json") : rawArgv;
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

	// `aies run "<tarea>"` — oneshot headless explícito (DoD MVP: modo CI/script). Reutiliza el
	// camino oneshot existente (ya emite activity lines vía StreamRenderer y sale 0/1 vía
	// oneshotExitCode); NO duplica la ejecución en un módulo aparte (corrección: zero speculative
	// architecture). Acepta tarea por argv o por stdin pipeada (`cat task.txt | aies run`).
	let runRequested = false;
	if (argv.length >= 1 && argv[0] === "run") {
		runRequested = true;
		argv = argv.slice(1);
		if (argv.length === 0) {
			const piped = await readPipedStdin();
			if (piped) argv = [piped];
		}
		if (argv.join(" ").trim().length === 0) {
			output.write('Uso: aies run "<tarea>"   (o bien:  cat tarea.txt | aies run)\n');
			process.exit(2);
		}
	}

	const taskArg = argv.length > 0 ? argv.join(" ").trim() : null;
	const repl = !runRequested && (taskArg === null || taskArg.length === 0);
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

	// model-per-role real y estricto. `AIES_MODEL`OverrideActúa como elección explícita para todos.
	const { roleModels, ok: modelsOk } = resolveModels(runtime, cfg, process.env.AIES_MODEL, diagOut);
	const model = roleModels.orchestrator;
	authReadinessNotice(runtime, cfg, diagOut);

	if (!modelsOk) {
		// Corrección #3: sin fallback silencioso ante modelos explícitamente configurados pero
		// imposibles de resolver. Oneshot sale ya; el REPL sigue arrancando para poder /login o
		// /model, pero bloqueará la ejecución de tareas hasta que se resuelvan (ver replRunTask).
		if (!repl) {
			diagOut.write("aies: no se puede ejecutar con los modelos configurados. Corrige aies.config.json, /model o la autenticación.\n");
			process.exit(2);
		}
	}

	if (repl) {
		await runRepl({ cwd, limits, model, roleModels, modelsOk, thinkingLevel, updatePromise, runtime, cfg });
	} else {
		const exitCode = await runOneshot(taskArg!, {
			cwd,
			limits,
			model,
			roleModels,
			modelRuntime: runtime,
			verification: verificationFromConfig(cfg),
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
		/** Modelos por rol (model-per-role real). Si está, cada worker usa el suyo. */
		roleModels?: RoleModels | undefined;
		/** Runtime de modelos compartido (catálogo + credenciales). */
		modelRuntime?: ModelRuntime | undefined;
		/** Política de verificación determinista + reparación. */
		verification?: VerificationPolicy | undefined;
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
		roleModels: ctx.roleModels,
		modelRuntime: ctx.modelRuntime,
		verification: ctx.verification,
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
	roleModels?: RoleModels | undefined;
	modelsOk?: boolean | undefined;
	thinkingLevel: "off" | "low" | "medium" | "high" | undefined;
	updatePromise: Promise<UpdateStatus>;
	runtime: ModelRuntime;
	cfg: Config;
}): Promise<void> {
	const store = new LocalStore(ctx.cwd);
	const prompt = new PromptUI({ streams: { input, output }, prompt: "❯ " });
	// Modelo por rol mutable durante la sesión. `orchestrator` actúa como override de sesión no
	// persistente (equivale al antiguo `activeModel`); los demás roles se re-resuelven al
	// reasignar con /model (que SÍ persiste en aies.config.json).
	const roleModels: RoleModels = { ...(ctx.roleModels ?? { orchestrator: ctx.model, explorer: ctx.model, implementer: ctx.model, verifier: ctx.model }) };
	banner(output, roleModels, store, ctx.modelsOk === false);
	for (const msg of replStartupMessages(store)) output.write(`${msg}\n`);
	let currentState: RuntimeState | null = store.loadState();
	// cfg vigente en memoria — se recarga tras /model para reflejar las asignaciones persistidas.
	let activeCfg = ctx.cfg;
	const updateStatus = await waitForUpdateNotice(ctx.updatePromise);
	const updateNotice = formatUpdateNotice(updateStatus ?? { kind: "skipped" });
	if (updateNotice) prompt.info(`\n${updateNotice}`);

	/** Re-resuelve los roles desde el config vigente. `ok=false` ⇒ hay fallos explícitos ya
	 *  impresos en `out`; los modelos previamente válidos se conservan intactos. */
	const applyRoleResolution = (): boolean => {
		const r = resolveModels(ctx.runtime, activeCfg, process.env.AIES_MODEL, output);
		if (r.ok) Object.assign(roleModels, r.roleModels);
		return r.ok;
	};

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
						roleModels.orchestrator = m ?? undefined;
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
				prompt.info(`Modelos por rol: ${formatRoleModelLabels(roleModels)}\n\n${formatStatus(snapshot, store.readLogIndexed())}`);
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
				await runLoginFlow(ctx, prompt, input0);
				// La autenticación nueva puede desbloquear roles explícitos que antes fallaban.
				applyRoleResolution();
				continue;
			}
			if (input0 === "/logout" || input0.startsWith("/logout ")) {
				await runLogoutFlow(ctx, prompt, input0);
				applyRoleResolution();
				continue;
			}
			if (input0 === "/model" || input0.startsWith("/model ")) {
				// /model gestiona asignaciones por rol (persisten en aies.config.json):
				//   /model                → tabla de asignaciones actuales
				//   /model <rol>          → selector interactivo para ese rol
				//   /model <rol> <ref>    → asignación directa
				//   /model <query>        → cambio de sesión NO persistente sólo para el orquestador
				const arg = input0.slice("/model".length).trim();
				const first = arg.length > 0 ? arg.split(/\s+/)[0]!.toLowerCase() : "";
				if (!arg || isRole(first)) {
					const pickRl = prompt.createReadline();
					try {
						await runPickCommand(pickRl, ctx.runtime, activeCfg, defaultConfigPathLocal(), arg);
					} finally {
						pickRl.close();
					}
					try {
						activeCfg = loadConfig();
					} catch {
						/* config ilegible: mantener el anterior en memoria */
					}
					applyRoleResolution();
					continue;
				}
				const r = await runModelFlow(ctx, prompt, input0, roleModels.orchestrator);
				if (r?.kind === "selected") roleModels.orchestrator = r.model;
				continue;
			}
			if (input0 === "/models" || input0.startsWith("/models ")) {
				// /models = CATÁLOGO (listado de modelos disponibles por provider con auth y roles
				// asignados). Los cambios de asignación van en /model.
				prompt.info(runModelsCommand(ctx.runtime, activeCfg));
				continue;
			}
			if (input0 === "/resume" || input0.startsWith("/resume ")) {
				const guide = parseResumeGuide(input0);
				const resolved = resolveResume(currentState ?? store.loadState());
				if (!resolved.ok) {
					prompt.info(resolved.message);
					continue;
				}
				if (!applyRoleResolution()) {
					prompt.info("aies: tarea no reanudada — los modelos configurados no son resolubles; corrige con /model o /login.");
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
							model: roleModels.orchestrator,
							roleModels: { ...roleModels },
							modelRuntime: ctx.runtime,
							verification: verificationFromConfig(activeCfg),
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
				const configPath = defaultConfigPathLocal();
				const pickRl = prompt.createReadline();
				try {
					await runPickCommand(pickRl, ctx.runtime, activeCfg, configPath, input0.slice("/pick".length).trim());
				} finally {
					pickRl.close();
				}
				try {
					activeCfg = loadConfig();
				} catch {
					/* mantener anterior */
				}
				applyRoleResolution();
				continue;
			}

			// Nueva tarea sobre el proyecto (manteniendo persistencia).
			if (!applyRoleResolution()) {
				prompt.info("aies: tarea no ejecutada — los modelos configurados no son resolubles; corrige con /model o /login.");
				continue;
			}
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
						model: roleModels.orchestrator,
						roleModels: { ...roleModels },
						modelRuntime: ctx.runtime,
						verification: verificationFromConfig(activeCfg),
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
