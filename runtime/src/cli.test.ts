// src/cli.test.ts — T0 preflight/banner/oneshot + T1 resume/state.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";

import {
	BANNER_BAR,
	BRIEFING_PREFIX,
	formatStateHuman,
	formatStateOutput,
	oneshotExitCode,
	oneshotOverwriteNotice,
	pad,
	parseResumeGuide,
	preflight,
	priorInProgressNotice,
	replStartupMessages,
	resolveResume,
	runCycle,
	runOneshot,
	runResumeCycle,
	summarizeOneshotResult,
	summarizeState,
	stripRunPrefix,
} from "./cli.js";
import { LocalStore } from "./cli-persistence.js";
import type { DecideOutcome, ExecuteOutcome } from "./core/events.js";
import { initState, type Decision, type RuntimeState } from "./core/state.js";
import type { Config } from "./config.js";
import { StreamRenderer } from "./ui/stream-renderer.js";
import type { WorkerTelemetry } from "./telemetry/types.js";

const TELEM: WorkerTelemetry = {
	usage: null,
	contextUsage: null,
	telemetryUnavailable: false,
};

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function capture(): { stream: NodeJS.WritableStream; text: () => string; plain: () => string } {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
	} as NodeJS.WritableStream;
	return {
		stream,
		text: () => chunks.join(""),
		plain: () => stripAnsi(chunks.join("")),
	};
}

const CFG: Config = {
	provider: "anthropic",
	models: { orchestrator: "claude-sonnet-4-5" },
	orchestratorThinkingLevel: "low",
};

function silentRenderer(): StreamRenderer {
	const c = capture();
	return new StreamRenderer(c.stream);
}

function enCursoState(iterations: number): RuntimeState {
	const s = initState(
		{
			objetivo: "seguir el plan",
			alcance: null,
			restricciones: null,
			resultadoEsperado: null,
			condicionFinalizacion: "ok",
		},
		{ maxIterations: 12 },
	);
	return {
		...s,
		taskState: "En curso",
		iterations,
		nextStep: "continuar la unidad pendiente",
		units: [
			{
				id: "u0",
				objetivo: "explorar",
				alcance: null,
				infoNecesaria: null,
				resultadoEsperado: "mapa",
				condicionFinalizacion: "ok",
				capacidad: "explorer",
				estado: "Terminada",
			},
			{
				id: "u1",
				objetivo: "implementar",
				alcance: null,
				infoNecesaria: null,
				resultadoEsperado: "diff",
				condicionFinalizacion: "ok",
				capacidad: "implementer",
				estado: "Pendiente",
			},
			{
				id: "u2",
				objetivo: "verificar",
				alcance: null,
				infoNecesaria: null,
				resultadoEsperado: "PASS",
				condicionFinalizacion: "ok",
				capacidad: "verifier",
				estado: "Fallida",
			},
		],
		results: [{ kind: "unidad", text: "ok", unidadId: "u0", passed: true }],
	};
}

function terminarDecision(): Decision {
	return {
		operación: "terminar",
		ajustePlan: null,
		unidad: null,
		motivo: "listo",
		condición: { desenlace: "completed", detalle: "cumplida" },
	};
}

function failTerminarDecision(): Decision {
	return {
		operación: "terminar",
		ajustePlan: null,
		unidad: null,
		motivo: "inviable",
		condición: { desenlace: "failed", detalle: "inviable: sin vía viable" },
	};
}

const decideTerminar =
	(d: Decision) =>
	async (): Promise<DecideOutcome> => ({
		decision: d,
		telemetry: TELEM,
		raw: "{}",
		parseFail: false,
	});

const executeTerminar =
	(passed: boolean | null) =>
	async (): Promise<ExecuteOutcome> => ({
		result: {
			kind: "terminación",
			text: passed === false ? "sin continuación" : "finalización declarada",
			unidadId: null,
			passed,
		},
		telemetry: TELEM,
	});

describe("preflight", () => {
	it("imprime provider/modelo y no avisa si la env está presente", () => {
		const out = capture();
		preflight(CFG, out.stream, { ANTHROPIC_API_KEY: "sk-test" });
		const plain = out.plain();
		assert.match(plain, /aies: provider=anthropic modelo=claude-sonnet-4-5 — ok\./);
		assert.doesNotMatch(plain, /ANTHROPIC_API_KEY no está definida/);
	});

	it("avisa en ámbar si falta la clave, sin bloquear", () => {
		const out = capture();
		preflight(CFG, out.stream, {});
		const plain = out.plain();
		assert.match(plain, /aies: provider=anthropic modelo=claude-sonnet-4-5 — ok\./);
		assert.match(plain, /ANTHROPIC_API_KEY no está definida/);
	});
});

describe("banner pad", () => {
	it("pad(l1).length === pad(l2).length === bar.length + 2", () => {
		const l1 = "│  AIES — Autonomous Software Engineering Harness │";
		const l2 = "│  Escribe tu tarea o /help para comandos       │";
		const width = BANNER_BAR.length + 2;
		assert.equal(pad(l1).length, pad(l2).length);
		assert.equal(pad(l1).length, width);
		assert.equal(pad(l2).length, width);
	});
});

describe("oneshot exit code", () => {
	it("estado terminal no Completada y no interrumpido → 1", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-oneshot-"));
		const store = new LocalStore(cwd);
		const code = await runOneshot("tarea inviable", {
			cwd,
			limits: { maxIterations: 12 },
			model: undefined,
			thinkingLevel: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: decideTerminar(failTerminarDecision()),
			executeOverride: executeTerminar(false),
			signal: new AbortController().signal,
			out: capture().stream,
		});
		assert.equal(code, 1);
		assert.equal(oneshotExitCode({ state: store.loadState()!, interrupted: false, completed: false }), 1);
	});
});

describe("--json (T4.3): stdout es UNA línea de JSON, nada más", () => {
	it("éxito: stdout parsea como JSON, exitCode 0, sin texto humano mezclado", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-json-ok-"));
		const store = new LocalStore(cwd);
		const stdout = capture();
		const stderr = capture();
		const code = await runOneshot("tarea trivial", {
			cwd,
			limits: { maxIterations: 12 },
			model: undefined,
			thinkingLevel: undefined,
			store,
			decideOverride: decideTerminar(terminarDecision()),
			executeOverride: executeTerminar(null),
			signal: new AbortController().signal,
			out: stdout.stream,
			json: true,
			diagOut: stderr.stream,
		});
		assert.equal(code, 0);
		const text = stdout.text();
		// Exactamente una línea — un segundo JSON.parse (o cualquier prosa) delataría
		// que algo más escribió a stdout.
		assert.equal(text.split("\n").filter(Boolean).length, 1, `stdout debe ser una sola línea: ${JSON.stringify(text)}`);
		const payload = JSON.parse(text);
		assert.equal(payload.ok, true);
		assert.equal(payload.exitCode, 0);
		assert.equal(payload.completed, true);
		assert.equal(payload.interrupted, false);
		assert.equal(payload.state.taskState, "Completada");
	});

	it("fallo: exitCode 1, stdout sigue siendo JSON parseable (no la prosa 'tarea terminó en estado')", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-json-fail-"));
		const store = new LocalStore(cwd);
		const stdout = capture();
		const code = await runOneshot("tarea inviable", {
			cwd,
			limits: { maxIterations: 12 },
			model: undefined,
			thinkingLevel: undefined,
			store,
			decideOverride: decideTerminar(failTerminarDecision()),
			executeOverride: executeTerminar(false),
			signal: new AbortController().signal,
			out: stdout.stream,
			json: true,
			diagOut: capture().stream,
		});
		assert.equal(code, 1);
		const payload = JSON.parse(stdout.text());
		assert.equal(payload.ok, false);
		assert.equal(payload.exitCode, 1);
		assert.doesNotMatch(stdout.text(), /tarea terminó en estado/, "la prosa no-json no debe colarse en stdout");
	});

	it("los avisos de arranque (state.json corrupto, tarea previa En curso) van a diagOut, no a stdout", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-json-diag-"));
		mkdirSync(path.join(cwd, ".aies"), { recursive: true });
		writeFileSync(path.join(cwd, ".aies", "state.json"), "{ esto no es JSON", "utf8");
		const store = new LocalStore(cwd);
		const stdout = capture();
		const stderr = capture();
		await runOneshot("tarea trivial", {
			cwd,
			limits: { maxIterations: 12 },
			model: undefined,
			thinkingLevel: undefined,
			store,
			decideOverride: decideTerminar(terminarDecision()),
			executeOverride: executeTerminar(null),
			signal: new AbortController().signal,
			out: stdout.stream,
			json: true,
			diagOut: stderr.stream,
		});
		assert.match(stderr.text(), /corrupto/);
		assert.doesNotMatch(stdout.text(), /corrupto/, "el aviso de state.json corrupto no es parte del payload");
		// stdout sigue siendo únicamente el JSON — el aviso no lo precede ni lo rompe.
		assert.doesNotThrow(() => JSON.parse(stdout.text()));
	});

	it("sin json (comportamiento previo intacto): stdout lleva la prosa humana, no JSON", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-nojson-"));
		const store = new LocalStore(cwd);
		const stdout = capture();
		const code = await runOneshot("tarea inviable", {
			cwd,
			limits: { maxIterations: 12 },
			model: undefined,
			thinkingLevel: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: decideTerminar(failTerminarDecision()),
			executeOverride: executeTerminar(false),
			signal: new AbortController().signal,
			out: stdout.stream,
		});
		assert.equal(code, 1);
		assert.match(stdout.text(), /tarea terminó en estado/);
		assert.throws(() => JSON.parse(stdout.text()));
	});

	it("summarizeOneshotResult: mismo lenguaje que summarizeState, con el desenlace del oneshot encima", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-json-summary-"));
		const store = new LocalStore(cwd);
		void store; // sólo para reservar el tmpdir con el mismo patrón que el resto del archivo
		const state = enCursoState(3);
		const payload = summarizeOneshotResult({ state, interrupted: false, completed: false });
		assert.equal(payload.ok, false);
		assert.equal(payload.exitCode, 1);
		assert.deepEqual(payload.state, summarizeState(state));
	});
});

describe("T1 persistencia y /resume", () => {
	const dirs: string[] = [];
	afterEach(() => {
		/* scratch dirs are in tmp; no cleanup required beyond OS tmp */
		dirs.length = 0;
	});

	it("LocalStore carga fixture En curso con iterations > 0", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-resume-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		const fixture = enCursoState(4);
		store.saveState(fixture);
		const loaded = store.loadState();
		assert.ok(loaded);
		assert.equal(loaded!.taskState, "En curso");
		assert.equal(loaded!.iterations, 4);
		assert.equal(loaded!.task.objetivo, "seguir el plan");
	});

	it("schema antiguo no es reanudable (no crash)", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-old-"));
		mkdirSync(path.join(cwd, ".aies"), { recursive: true });
		writeFileSync(path.join(cwd, ".aies", "state.json"), JSON.stringify({ taskState: "En curso" }), "utf8");
		const store = new LocalStore(cwd);
		assert.equal(store.loadState(), null);
		assert.equal(store.loadStateResult().kind, "invalid");
		const msgs = replStartupMessages(store);
		assert.ok(msgs.some((m) => /schema antiguo/.test(m)));
	});

	it("resolveResume + runResumeCycle pasa resumeFrom y no resetea iterations a 0", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-cycle-"));
		const store = new LocalStore(cwd);
		// Sin unidades activas: la terminación estricta puede aceptar `terminar completed`.
		const fixture: RuntimeState = { ...enCursoState(5), units: [] };
		store.saveState(fixture);
		const loaded = store.loadState();
		const resolved = resolveResume(loaded);
		assert.equal(resolved.ok, true);
		if (!resolved.ok) throw new Error("unreachable");

		let seenResumeFrom: RuntimeState | undefined;
		const result = await runResumeCycle(resolved.state, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: async (state) => {
				seenResumeFrom = state;
				return decideTerminar(terminarDecision())();
			},
			executeOverride: executeTerminar(null),
			resumeFrom: resolved.state,
		});

		assert.ok(seenResumeFrom);
		assert.equal(seenResumeFrom!.iterations, 5);
		assert.equal(seenResumeFrom!.task.objetivo, fixture.task.objetivo);
		assert.ok(result.state.iterations >= 5, `iterations=${result.state.iterations} no debe resetear a 0`);
		assert.notEqual(result.state.iterations, 0);
	});

	it("runResumeCycle tras pausa por límite avanza si opts.limits.maxIterations es mayor", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-resume-limit-"));
		const store = new LocalStore(cwd);
		// Sin unidades activas: la terminación estricta acepta `terminar completed`.
		const paused: RuntimeState = { ...enCursoState(1), limits: { maxIterations: 1, maxConsecutiveNoProgress: 3 }, units: [] };
		store.saveState(paused);
		const resolved = resolveResume(store.loadState());
		assert.equal(resolved.ok, true);
		if (!resolved.ok) throw new Error("unreachable");

		let decideCalled = false;
		const result = await runResumeCycle(resolved.state, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: async (state) => {
				decideCalled = true;
				assert.equal(state.iterations, 1);
				assert.equal(state.limits.maxIterations, 12, "opts.limits debe refrescar el snapshot");
				return decideTerminar(terminarDecision())();
			},
			executeOverride: executeTerminar(null),
		});

		assert.ok(decideCalled, "decide debe invocarse para que haya avance");
		assert.ok(result.state.iterations >= 2, `iterations=${result.state.iterations} debe crecer tras avanzar`);
	});

	it("runCycle sin resumeFrom sí arranca en 0 (control negativo)", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-fresh-"));
		const store = new LocalStore(cwd);
		const result = await runCycle(enCursoState(5).task, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: decideTerminar(terminarDecision()),
			executeOverride: executeTerminar(null),
		});
		assert.equal(result.state.iterations, 1);
	});

	it("aviso de arranque REPL con En curso previo", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-repl-"));
		const store = new LocalStore(cwd);
		store.saveState(enCursoState(3));
		const msgs = replStartupMessages(store);
		assert.ok(msgs.some((m) => /tarea previa "En curso"/.test(m)));
		assert.ok(msgs.some((m) => /Usa \/resume/.test(m)));
		assert.match(priorInProgressNotice(store.loadState()) ?? "", /seguir el plan/);
	});

	it("oneshot avisa si va a sobreescribir En curso", () => {
		const notice = oneshotOverwriteNotice(enCursoState(2));
		assert.match(notice ?? "", /Esta oneshot la sobreescribirá/);
	});

	it("/resume sin En curso avisa y no corre", () => {
		const resolved = resolveResume(null);
		assert.equal(resolved.ok, false);
		if (resolved.ok) throw new Error("unreachable");
		assert.match(resolved.message, /no hay una tarea reanudable/);
		const done = resolveResume({ ...enCursoState(1), taskState: "Completada" });
		assert.equal(done.ok, false);
	});

	it("/resume acepta Recibida (pausa antes del primer ajustePlan) — ADR-012 D4", () => {
		const recibida = { ...enCursoState(0), taskState: "Recibida" as const };
		const r = resolveResume(recibida);
		assert.equal(r.ok, true, "Recibida debe ser reanudable");
		if (!r.ok) throw new Error("unreachable");
	});

	it("priorInProgressNotice incluye Recibida", () => {
		const recibida = { ...enCursoState(0), taskState: "Recibida" as const };
		assert.match(priorInProgressNotice(recibida) ?? "", /tarea previa "Recibida"/);
		assert.match(oneshotOverwriteNotice(recibida) ?? "", /tarea previa "Recibida"/);
	});

	it("resolveResume rechaza Completada y Fallida", () => {
		const completada = { ...enCursoState(0), taskState: "Completada" as const };
		const fallida = { ...enCursoState(0), taskState: "Fallida" as const };
		assert.equal(resolveResume(completada).ok, false);
		assert.equal(resolveResume(fallida).ok, false);
	});
});

describe("T2.2 parseResumeGuide", () => {
	it("sin resto → undefined", () => {
		assert.equal(parseResumeGuide("/resume"), undefined);
		assert.equal(parseResumeGuide("/resume    "), undefined);
	});
	it('comillas dobles alrededor de la guía', () => {
		assert.equal(parseResumeGuide('/resume "verifica el caso de borde primero"'), "verifica el caso de borde primero");
	});
	it("sin comillas: resto crudo", () => {
		assert.equal(parseResumeGuide("/resume verifica el caso de borde"), "verifica el caso de borde");
	});
	it("comillas vacías → undefined", () => {
		assert.equal(parseResumeGuide('/resume ""'), undefined);
	});
});

describe("T2.2 /resume con guía inyecta knownInfo", () => {
	it("runResumeCycle con resumeGuide añade la nota al estado reanudado", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-resume-guide-"));
		const store = new LocalStore(cwd);
		const fixture = enCursoState(3);
		store.saveState(fixture);
		const resolved = resolveResume(store.loadState());
		assert.equal(resolved.ok, true);
		if (!resolved.ok) throw new Error("unreachable");

		let seenKnownInfo: string[] | undefined;
		await runResumeCycle(resolved.state, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: async (state) => {
				seenKnownInfo = state.knownInfo;
				return decideTerminar(terminarDecision())();
			},
			executeOverride: executeTerminar(null),
			resumeGuide: "verifica el caso de borde primero",
		});

		assert.ok(seenKnownInfo);
		assert.ok(
			seenKnownInfo!.some((k) => /guía del desarrollador al reanudar:.*verifica el caso de borde primero/.test(k)),
			"la guía debe inyectarse en knownInfo",
		);
	});

	it("runResumeCycle sin guide no inyecta nada en knownInfo", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-resume-noguide-"));
		const store = new LocalStore(cwd);
		const fixture = enCursoState(2);
		store.saveState(fixture);
		const resolved = resolveResume(store.loadState());
		assert.equal(resolved.ok, true);
		if (!resolved.ok) throw new Error("unreachable");

		let seenKnownInfo: string[] | undefined;
		await runResumeCycle(resolved.state, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: async (state) => {
				seenKnownInfo = state.knownInfo;
				return decideTerminar(terminarDecision())();
			},
			executeOverride: executeTerminar(null),
		});

		assert.ok(seenKnownInfo);
		assert.ok(!seenKnownInfo!.some((k) => /guía del desarrollador/.test(k)), "sin guide: no se añade la nota");
	});
});

describe("ADR-012 T4 — briefing: reemplazar, no acumular", () => {
	function startupWith(lines: string[]): ReturnType<typeof runStartup> {
		return {
			availability: { codegraph: "missing", projectmem: "missing", cwd: "/tmp" },
			codegraphInit: { status: "skipped", message: "test" },
			memoryBriefing: null,
			briefing: lines,
			customTools: [],
			toolNames: { code_explore: false, mem_read: false, mem_log: false },
		};
	}

	it("runCycle sin resumeFrom inyecta una sola entrada de briefing en knownInfo", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-brief-fresh-"));
		const store = new LocalStore(cwd);
		let seenKnownInfo: string[] | undefined;
		await runCycle(enCursoState(0).task, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: async (state) => {
				seenKnownInfo = state.knownInfo;
				return decideTerminar(terminarDecision())();
			},
			executeOverride: executeTerminar(null),
			startup: startupWith(["HERRAMIENTAS: codegraph=missing, projectmem=missing."]),
		});
		assert.ok(seenKnownInfo);
		const briefings = seenKnownInfo!.filter((k) => k.startsWith(BRIEFING_PREFIX));
		assert.equal(briefings.length, 1, "una sola entrada de briefing tras tarea nueva");
		assert.match(briefings[0]!, /HERRAMIENTAS: codegraph=missing/);
	});

	it("dos runResumeCycle encadenados dejan una sola entrada de briefing", async () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-brief-resume-"));
		const store = new LocalStore(cwd);
		const fixture = enCursoState(2);
		store.saveState(fixture);

		const startup = startupWith(["HERRAMIENTAS: codegraph=missing, projectmem=missing."]);

		// Primer resume: añadir el briefing, correr y persistir.
		let after1: RuntimeState | undefined;
		await runResumeCycle(resolveResume(store.loadState()).ok ? (store.loadState()!) : fixture, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: async (state) => {
				after1 = state;
				return decideTerminar(terminarDecision())();
			},
			executeOverride: executeTerminar(null),
			startup,
		});
		assert.ok(after1);
		const briefingsAfter1 = after1!.knownInfo.filter((k) => k.startsWith(BRIEFING_PREFIX));
		assert.equal(briefingsAfter1.length, 1, "después del primer resume: una sola entrada");
		store.saveState(after1!);

		// Segundo resume sobre el estado recién persistido (que ya tiene el briefing).
		let after2: RuntimeState | undefined;
		await runResumeCycle(store.loadState()!, {
			cwd,
			model: undefined,
			thinkingLevel: undefined,
			limits: { maxIterations: 12 },
			signal: undefined,
			store,
			renderer: silentRenderer(),
			decideOverride: async (state) => {
				after2 = state;
				return decideTerminar(terminarDecision())();
			},
			executeOverride: executeTerminar(null),
			startup,
		});
		assert.ok(after2);
		const briefingsAfter2 = after2!.knownInfo.filter((k) => k.startsWith(BRIEFING_PREFIX));
		assert.equal(briefingsAfter2.length, 1, "segundo resume: briefing reemplazado, no acumulado");
	});
});

describe("formatStateHuman y /state", () => {
	it("árbol de unidades con ✓/✗/○ según el enum real", () => {
		const text = formatStateHuman(enCursoState(3));
		assert.match(text, /Objetivo\s+: seguir el plan/);
		assert.match(text, /Estado\s+: En curso/);
		assert.match(text, /Iteración\s+: 3\/12/);
		assert.match(text, /Siguiente\s+: continuar la unidad pendiente/);
		assert.match(text, /✓ u0 · explorer · Terminada/);
		assert.match(text, /○ u1 · implementer · Pendiente/);
		assert.match(text, /✗ u2 · verifier · Fallida/);
		assert.match(text, /Resultados\s+: 1/);
	});

	it("/state es humano; /state --json es summarizeState", () => {
		const s = enCursoState(2);
		const human = formatStateOutput("/state", s);
		const json = formatStateOutput("/state --json", s);
		assert.match(human, /Objetivo\s+:/);
		assert.doesNotMatch(human, /"taskState"/);
		const parsed = JSON.parse(json) as ReturnType<typeof summarizeState>;
		assert.equal(parsed.taskState, "En curso");
		assert.equal(parsed.iterations, 2);
		assert.deepEqual(parsed, summarizeState(s));
	});
});

describe("stripRunPrefix — routing `aies run` (headless MVP DoD)", () => {
	it("detecta el prefijo run y devuelve el resto como tarea", () => {
		assert.deepEqual(stripRunPrefix(["run", "corrige", "tests"]), { headless: true, rest: ["corrige", "tests"] });
	});

	it("sin prefijo run NO consume el primer token", () => {
		assert.deepEqual(stripRunPrefix(["corrige", "run", "x"]), { headless: false, rest: ["corrige", "run", "x"] });
	});

	it("`aies run` solo → rest vacío (el caller decide stdin/uso)", () => {
		assert.deepEqual(stripRunPrefix(["run"]), { headless: true, rest: [] });
	});

	it("argv vacío → no headless", () => {
		assert.deepEqual(stripRunPrefix([]), { headless: false, rest: [] });
	});
});
