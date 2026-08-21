// src/cli.test.ts — T0 preflight/banner/oneshot + T1 resume/state.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";

import {
	BANNER_BAR,
	formatStateHuman,
	formatStateOutput,
	oneshotExitCode,
	oneshotOverwriteNotice,
	pad,
	preflight,
	priorInProgressNotice,
	replStartupMessages,
	resolveResume,
	runCycle,
	runOneshot,
	runResumeCycle,
	summarizeState,
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
		capacidad: null,
		comunicación: null,
		motivo: "listo",
		condición: "cumplida",
	};
}

function failTerminarDecision(): Decision {
	return {
		operación: "terminar",
		ajustePlan: null,
		unidad: null,
		capacidad: null,
		comunicación: null,
		motivo: "inviable",
		condición: "inviable: sin vía viable",
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
		const fixture = enCursoState(5);
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
		const paused = { ...enCursoState(1), limits: { maxIterations: 1 } };
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
		assert.match(resolved.message, /no hay una tarea "En curso"/);
		const done = resolveResume({ ...enCursoState(1), taskState: "Completada" });
		assert.equal(done.ok, false);
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
