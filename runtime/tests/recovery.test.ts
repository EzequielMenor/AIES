// tests/recovery.test.ts — EL ciclo central del MVP:
//   implement → deterministic verify → failure capture → focused repair → verify again.
//
// Pipeline REAL (runCycle → buildExecute → verification/engine sobre un proyecto temporal con
// script `test` determinista). Sólo se mockea `runWorker` (la sesión de pi): se prueba el
// cableado del gate + reparación acotada, no pi. Cf. corrección #8 (ciclo completo) y #6 (no
// flags genéricos: el fixture expone un script `test` real).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

// El mock intercepta SÓLO runWorker; toWorkerRunParams y el resto quedan reales.
const h = vi.hoisted(() => ({
	implementCalls: [] as Array<{ objetivo: string; feedback: string | null; writeOk: boolean }>,
	writeTarget: "",
}));

vi.mock("../src/workers/tools.js", async () => {
	const actual = await vi.importActual<typeof import("../src/workers/tools.js")>("../src/workers/tools.js");
	return {
		...actual,
		runWorker: async (
			capability: "explorer" | "implementer" | "verifier",
			params: { unit: { objetivo: string }; feedbackCorrectivo: string | null },
		) => {
			if (capability !== "implementer") throw new Error(`capability inesperada en test: ${capability}`);
			// 1ª llamada (sin feedback) escribe "Y" (rompe el check). Con feedback de reparación, "X".
			const writeOk = params.feedbackCorrectivo !== null;
			h.implementCalls.push({ objetivo: params.unit.objetivo, feedback: params.feedbackCorrectivo, writeOk });
			writeFileSync(path.join(h.writeTarget, "expected.txt"), writeOk ? "X\n" : "Y\n", "utf8");
			const report = { status: "satisfied" as const, summary: writeOk ? "contiene X" : "contiene Y", criteria: [], unmetCriteria: [] };
			return {
				status: "ok" as const,
				text: JSON.stringify(report),
				verdict: null,
				telemetry: { usage: null, contextUsage: null, telemetryUnavailable: false },
				report,
				reportError: null,
			};
		},
	};
});

const { runCycle } = await import("../src/cli.js");
const { LocalStore } = await import("../src/cli-persistence.js");
const { DEFAULT_LIMITS, applyAjustePlan } = await import("../src/core/state.js");
const { StreamRenderer } = await import("../src/ui/stream-renderer.js");
const { DEFAULT_VERIFICATION } = await import("../src/config.js");
import type { DecideOutcome } from "../src/core/events.js";
import type { WorkerTelemetry } from "../src/telemetry/types.js";
import type { Decision, RuntimeState, Task } from "../src/core/state.js";

const TELEM: WorkerTelemetry = { usage: null, contextUsage: null, telemetryUnavailable: false };

const FIXTURE_TEST =
	"node -e \"const fs=require('fs');const v=fs.readFileSync('expected.txt','utf8').trim(); if (v!=='X') { console.error('AssertionError: expected X, got '+JSON.stringify(v)); process.exit(1);} console.log('ok');\"";

function makeProject(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "aies-recovery-"));
	writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts: { test: FIXTURE_TEST } }), "utf8");
	mkdirSync(path.join(dir, "node_modules"), { recursive: true });
	writeFileSync(path.join(dir, "expected.txt"), "inicio\n", "utf8");
	return dir;
}

function task(objetivo: string): Task {
	return { objetivo, alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "tarea completada o fallida" };
}

function planUnit(objetivo: string, condicion: string): NonNullable<Decision["ajustePlan"]>["unidades"][number] {
	return {
		objetivo,
		alcance: null,
		infoNecesaria: null,
		resultadoEsperado: objetivo,
		condicionFinalizacion: condicion,
		capacidad: "implementer",
	};
}

function makeDecide(script: Decision[]): (state: RuntimeState) => Promise<DecideOutcome> {
	let i = 0;
	return async (state: RuntimeState): Promise<DecideOutcome> => {
		const step = script[i++] ?? script[script.length - 1]!;
		let decision = step;
		if (step.ajustePlan) {
			const after = applyAjustePlan(state, step.ajustePlan);
			if (after.state.units.length === state.units.length) {
				decision = { ...step, ajustePlan: null };
			}
		}
		return { decision, telemetry: TELEM, raw: JSON.stringify(step), parseFail: false };
	};
}

const dirs: string[] = [];
let projectDir = "";

beforeAll(() => {
	projectDir = makeProject();
	dirs.push(projectDir);
	h.writeTarget = projectDir;
});

afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("ciclo implement → deterministic verify → failure capture → focused repair → verify again", () => {
	it("detecta el fallo, realimenta al implementer con la salida exacta y cierra verificación sin verifier LLM", async () => {
		h.implementCalls.length = 0;
		writeFileSync(path.join(projectDir, "expected.txt"), "inicio\n", "utf8");

		const checks: Array<{ name: string; passed: boolean }> = [];
		const repairs: Array<{ attempt: number; max: number }> = [];
		const renderer = new StreamRenderer(process.stdout);
		const origCheck = renderer.onDeterministicCheckResult?.bind(renderer);
		renderer.onDeterministicCheckResult = (unitId, name, command, passed, failure) => {
			checks.push({ name, passed });
			origCheck?.(unitId, name, command, passed, failure);
		};
		renderer.onRepairAttempt = (_unitId, attempt, max) => {
			repairs.push({ attempt, max });
		};

		const decide = makeDecide([
			{
				operación: "ejecutar una unidad",
				ajustePlan: { tipo: "determinar el proceso", unidades: [planUnit("escribir X en expected.txt", "npm test pasa")] },
				unidad: { tipo: "planificada", indice: 0 },
				motivo: "aplicar el cambio",
			},
			{
				operación: "terminar",
				ajustePlan: null,
				unidad: null,
				comunicación: null,
				motivo: "checks en exit 0",
				condición: { desenlace: "completed", detalle: "criterios cumplidos" },
			},
		]);

		const store = new LocalStore(projectDir);
		const result = await runCycle(task("garantizar expected.txt == X"), {
			cwd: projectDir,
			model: undefined,
			modelRuntime: undefined,
			thinkingLevel: undefined,
			limits: DEFAULT_LIMITS,
			signal: undefined,
			store,
			renderer,
			decideOverride: decide,
			verification: { ...DEFAULT_VERIFICATION, maxRepairAttempts: 3, checkTimeoutMs: 10_000 },
		});

		// failure capture + focused repair: 1 intento (Y) + 1 reparación (X).
		assert.equal(h.implementCalls.length, 2, "implementer: intento inicial + reparación focalizada");
		assert.equal(h.implementCalls[0]!.feedback, null, "el primer intento no traía feedback");
		const repairFeedback = h.implementCalls[1]!.feedback ?? "";
		assert.ok(repairFeedback.length > 0, "la reparación llegó con feedback");
		assert.match(repairFeedback, /AssertionError: expected X/, "el feedback contiene la salida EXACTA del fallo");
		assert.match(repairFeedback, /intento de reparación 1\/3/, "numeración de intento presente");
		assert.deepEqual(checks.map((c) => c.passed), [false, true], "gate falló → gate pasó");
		assert.equal(repairs.length, 1);
		assert.equal(repairs[0]!.attempt, 1);
		assert.equal(repairs[0]!.max, 3);

		// La unidad cierra por el gate determinista (sin verifier LLM; sólo hubo implementers).
		const final = result.state;
		assert.equal(final.units.find((u) => u.id === "u0")?.estado, "Terminada");
		assert.equal(final.taskState, "Completada");
		assert.equal(final.outcomes.verification, "pass");
		assert.equal(final.results.find((r) => r.unidadId === "u0")?.passed, true);
		assert.equal(readFileSync(path.join(projectDir, "expected.txt"), "utf8").trim(), "X");
	});

	it("agotadas las reparaciones → passed=false con la salida al contexto; el verifier LLM nunca corrió", async () => {
		h.implementCalls.length = 0;
		const dir = makeProject();
		dirs.push(dir);
		h.writeTarget = dir;
		// El fixture siempre falla: fuerza 1 + maxRepairAttempts invocaciones y luego entrega.
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "stuck", scripts: { test: "node -e \"console.error('AssertionError: siempre falla'); process.exit(1)\"" } }), "utf8");

		const decide = makeDecide([
			{
				operación: "ejecutar una unidad",
				ajustePlan: { tipo: "determinar el proceso", unidades: [planUnit("hacer que npm test pase", "npm test pasa")] },
				unidad: { tipo: "planificada", indice: 0 },
				motivo: "aplicar el cambio",
			},
			{
				operación: "terminar",
				ajustePlan: null,
				unidad: null,
				comunicación: null,
				motivo: "no es viable tras agotar las reparaciones",
				condición: { desenlace: "failed", detalle: "el proyecto sigue sin pasar sus checks" },
			},
		]);

		const store = new LocalStore(dir);
		const result = await runCycle(task("tarea con checks irrecuperables"), {
			cwd: dir,
			model: undefined,
			modelRuntime: undefined,
			thinkingLevel: undefined,
			limits: { ...DEFAULT_LIMITS, maxIterations: 6 },
			signal: undefined,
			store,
			renderer: new StreamRenderer(process.stdout),
			decideOverride: decide,
			verification: { deterministic: true, maxRepairAttempts: 2, checkTimeoutMs: 10_000 },
		});

		// 1 intento + 2 reparaciones = 3; el fallo NO se maquilla.
		assert.equal(h.implementCalls.length, 3, `esperadas 3 invocaciones, got ${h.implementCalls.length}`);
		const impl = result.state.results.find((r) => r.kind === "unidad" && r.unidadId === "u0");
		assert.equal(impl?.passed, false);
		assert.match(impl?.text ?? "", /AssertionError/, "la salida viaja al contexto del orquestador");
		assert.equal(result.state.units.find((u) => u.id === "u0")?.estado, "Fallida");
	});
});
