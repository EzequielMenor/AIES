// tests/smoke-e2e.test.ts — Smoke Test End-to-End del CLI AIES.
//
// Conecta el bucle AIES (runLoop), el renderizador (StreamRenderer) y los mocks
// realistas de decide/execute sobre la tarea:
//
//   "crear función greet(name) en ./tmp/smoke-math.js y verificarla con node"
//
// Valida:
//   1. StreamRenderer renderiza cabecera, árbol de workers y tarjeta de completado sin lanzar.
//   2. El archivo ./tmp/smoke-math.js se crea con un contenido válido.
//   3. El verificador ejecuta `node` realmente y emite VEREDICTO: PASS.
//   4. El bucle termina en estado "Completada".
//
// Sin dependencias externas: usa `node:assert/strict`, `node:fs`, `node:child_process`.
// Diseñado para `vitest run tests/smoke-e2e.test.ts`.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, it, beforeEach, afterEach } from "vitest";

import { runCycle } from "../src/cli.js";
import type { StreamRenderer } from "../src/ui/stream-renderer.js";
import { StreamRenderer as StreamRendererClass } from "../src/ui/stream-renderer.js";
import type { DecideOutcome, ExecuteOutcome, TaskTelemetry, WorkerEventSink } from "../src/core/events.js";
import type { Decision, RuntimeState, OperationResult } from "../src/core/state.js";
import { DEFAULT_LIMITS, initState, applyAjustePlan } from "../src/core/state.js";
import { LocalStore } from "../src/cli-persistence.js";
import type { WorkerTelemetry } from "../src/telemetry/types.js";

const TELEM: WorkerTelemetry = {
	usage: null,
	contextUsage: null,
	telemetryUnavailable: false,
};

const TARGET_FILE = resolve(process.cwd(), "tmp", "smoke-math.js");

/** Script de decisiones del orquestador (stub): plan + ejecutar u0 (implementer) + ejecutar u1 (verifier) + terminar. */
function smokeScript(): Decision[] {
	return [
		{
			operación: "ejecutar una unidad",
			ajustePlan: {
				tipo: "determinar el proceso",
				unidades: [
					{
						objetivo: `crear función greet(name) en ${TARGET_FILE}`,
						alcance: TARGET_FILE,
						infoNecesaria: null,
						resultadoEsperado: "greet(name) exportada y devuelve 'hello ' + name",
						condicionFinalizacion: `${TARGET_FILE} existe con greet() exportada`,
						capacidad: "implementer",
					},
					{
						objetivo: `verificar ${TARGET_FILE}`,
						alcance: TARGET_FILE,
						infoNecesaria: null,
						resultadoEsperado: "node ejecuta greet() sin errores",
						condicionFinalizacion: "VEREDICTO: PASS",
						capacidad: "verifier",
					},
				],
			},
			unidad: "u0",
			capacidad: "implementer",
			comunicación: null,
			motivo: "tarea Recibida; planificar e implementar greet()",
			condición: null,
		},
		{
			operación: "ejecutar una unidad",
			ajustePlan: null,
			unidad: "u1",
			capacidad: "verifier",
			comunicación: null,
			motivo: "verificar greet() con node antes de terminar",
			condición: null,
		},
		{
			operación: "terminar",
			ajustePlan: null,
			unidad: null,
			capacidad: null,
			comunicación: null,
			motivo: "verifier devolvió PASS",
			condición: "cumplida — verificado con PASS",
		},
	];
}

/** Stub de decide que recorre el script de decisiones y deja el ajustePlan en el estado. */
function makeDecideStub(script: Decision[]): (state: RuntimeState) => Promise<DecideOutcome> {
	let i = 0;
	return async (state: RuntimeState): Promise<DecideOutcome> => {
		const next = script[i++] ?? script[script.length - 1]!;
		// Aplica el plan en el estado antes de devolver la decisión (C3 orden por turno).
		const after = next.ajustePlan ? applyAjustePlan(state, next.ajustePlan) : state;
		const adjusted: Decision = {
			...next,
			ajustePlan: after.units.length > state.units.length ? next.ajustePlan : null,
		};
		return {
			decision: adjusted,
			telemetry: TELEM,
			raw: JSON.stringify(adjusted),
			parseFail: false,
		};
	};
}

/** Stub de execute: implementer escribe el archivo; verifier ejecuta `node` y devuelve PASS/FAIL. */
function makeExecuteStub(): (
	state: RuntimeState,
	decision: Decision,
	events: WorkerEventSink,
) => Promise<ExecuteOutcome> {
	return async (state: RuntimeState, decision: Decision): Promise<ExecuteOutcome> => {
		if (decision.operación === "comunicar al desarrollador") {
			const text = decision.comunicación ?? "";
			return {
				result: { kind: "comunicación", text, unidadId: null, passed: null } satisfies OperationResult,
				telemetry: TELEM,
			};
		}
		if (decision.operación === "terminar") {
			const cond = decision.condición ?? "";
			const inviable = /inviable|sin vía viable/i.test(cond);
			return {
				result: {
					kind: "terminación",
					text: inviable ? cond || "inviable" : "finalización declarada",
					unidadId: null,
					passed: inviable ? false : null,
				} satisfies OperationResult,
				telemetry: TELEM,
			};
		}
		if (decision.operación === "obtener información") {
			return {
				result: { kind: "info", text: "info-stub", unidadId: null, passed: null } satisfies OperationResult,
				telemetry: TELEM,
			};
		}
		if (decision.operación !== "ejecutar una unidad") {
			throw new Error(`operación no soportada en stub: ${decision.operación}`);
		}
		const unitId = decision.unidad ?? "";
		if (unitId === "u0") {
			// Implementer: escribe el archivo real (ESM, dado que el paquete tiene "type":"module").
			const content = [
				"// Generado por el smoke E2E de AIES.",
				"export function greet(name) {",
				"  return 'hello ' + name;",
				"}",
				"",
			].join("\n");
			mkdirSync(join(TARGET_FILE, ".."), { recursive: true });
			writeFileSync(TARGET_FILE, content, "utf8");
			return {
				result: {
					kind: "unidad",
					text: `greet() escrita en ${TARGET_FILE}`,
					unidadId: unitId,
					passed: true,
				} satisfies OperationResult,
				telemetry: TELEM,
			};
		}
		if (unitId === "u1") {
			// Verifier: ejecuta `node` realmente y devuelve VEREDICTO según el resultado.
			// Usamos dynamic import porque el archivo generado es ESM (paquete "type":"module").
			const probe = [
				"import('file://' + process.argv[1]).then((m) => {",
				"  const r = m.greet('world');",
				"  if (r !== 'hello world') { console.error('FAIL:', r); process.exit(1); }",
				"  console.log('VEREDICTO: PASS — greet() devuelve ' + JSON.stringify(r));",
				"}).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });",
			].join("\n");
			const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe, TARGET_FILE], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
			const stdout = (r.stdout ?? "").trim();
			const stderr = (r.stderr ?? "").trim();
			const verdictMatch = stdout.match(/VEREDICTO\s*:?\s*(PASS|FAIL)/i);
			const passed = r.status === 0 && verdictMatch?.[1]?.toUpperCase() === "PASS";
			const text = passed ? stdout : (stderr || stdout || "verifier: sin salida");
			return {
				result: {
					kind: "unidad",
					text,
					unidadId: unitId,
					passed,
				} satisfies OperationResult,
				telemetry: TELEM,
			};
		}
		throw new Error(`unidad desconocida en stub: ${unitId}`);
	};
}

describe("smoke E2E del CLI", () => {
	let tmpDir: string;
	let store: LocalStore;
	let renderer: StreamRenderer;
	let renderedChunks: string[];

	beforeEach(() => {
		// Usa un cwd virtual para que la persistencia (.aies/) no contamine el repo.
		tmpDir = resolve(process.cwd(), "tmp", `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tmpDir, { recursive: true });
		store = new LocalStore(tmpDir);

		// Capturamos la salida del StreamRenderer para poder afirmar "no lanza excepciones".
		// El renderer escribe a process.stdout directamente; lo monkey-patcheamos sólo durante
		// el test y lo restauramos al final.
		renderedChunks = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		(process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string): boolean => {
			renderedChunks.push(s);
			return true;
		};
		// Restaurar se hace en afterEach.
		process.once("exit", () => {
			(process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
		});

		renderer = new StreamRendererClass(process.stdout);
	});

	afterEach(() => {
		// Limpia tmp/.
		try {
			rmSync(join(process.cwd(), "tmp"), { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	});

	it("renderiza, crea el archivo, verifica con node y termina Completada", async () => {
		const script = smokeScript();
		const decide = makeDecideStub(script);
		const execute = makeExecuteStub();

		const initialTask = {
			objetivo: `crear función greet(name) en ${TARGET_FILE} y verificarla con node`,
			alcance: null,
			restricciones: null,
			resultadoEsperado: null,
			condicionFinalizacion: "tarea completada o fallida",
		};
		const initial = initState(initialTask, DEFAULT_LIMITS);

		const result = await runCycle(initialTask, {
			cwd: tmpDir,
			model: undefined,
			thinkingLevel: undefined,
			limits: DEFAULT_LIMITS,
			signal: undefined,
			store,
			renderer,
			decideOverride: decide,
			executeOverride: execute,
		});

		const final = result.state;

		// 1) StreamRenderer no lanzó excepciones: terminó el run y renderizó algo.
		const renderedRaw = renderedChunks.join("");
		const rendered = renderedRaw.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(rendered.length > 0, "el renderer debe emitir bytes a stdout");
		assert.match(rendered, /AIES Orchestrator/, "cabecera AIES Orchestrator");
		assert.match(rendered, /Implementer \(u0/, "tarjeta del worker implementer");
		assert.match(rendered, /Verifier \(u1/, "tarjeta del worker verifier");
		assert.match(rendered, /TASK COMPLETED/, "tarjeta de tarea completada");

		// 2) El archivo ./tmp/smoke-math.js existe con contenido válido.
		assert.ok(existsSync(TARGET_FILE), `${TARGET_FILE} debe existir tras el implementer`);
		const content = (await import("node:fs")).readFileSync(TARGET_FILE, "utf8");
		assert.match(content, /function\s+greet\s*\(/, "el archivo declara greet()");
		assert.match(content, /export\s+function\s+greet/, "el archivo exporta greet() (ESM)");

		// 3) El verificador ejecutó node y obtuvo PASS.
		const verifierResult = final.results.find((r) => r.kind === "unidad" && r.unidadId === "u1");
		assert.ok(verifierResult, "debe existir resultado del verifier (u1)");
		assert.equal(verifierResult!.passed, true, `verifier PASS; texto=${verifierResult!.text}`);
		assert.match(verifierResult!.text, /VEREDICTO\s*:?\s*PASS/, "texto del verifier incluye VEREDICTO: PASS");

		// 4) El bucle termina Completada.
		assert.equal(final.taskState, "Completada", `final.taskState=${final.taskState}`);
		assert.equal(final.outcomes.execution, "success");
		assert.equal(final.outcomes.verification, "pass", "verifier PASS → verification=pass");
		assert.ok(final.units.every((u) => u.estado === "Terminada"), "todas las unidades Terminada");
		assert.equal(final.iterations, 3, "3 iteraciones: plan+impl / verify / terminar");
		assert.equal(result.completed, true);
		assert.equal(result.interrupted, false);

		// Persistencia: state.json + log.jsonl en el cwd virtual.
		assert.ok(store.loadState() !== null, "state.json debe estar persistido");
	});

	it("muestra el coste real cuando hay usage, y 'n/d' cuando no, sin inventar $0.000", () => {
		// (1) Coste conocido → la tarjeta muestra el importe real acumulado, nunca $0.000.
		const known: TaskTelemetry = {
			iterations: 2,
			totalCost: 0.0123,
			totalTokens: 100,
			startTs: 0,
			endTs: 2000,
		};
		renderer.onTaskCompleted("tarea completada", known);
		const renderedKnown = renderedChunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
		assert.match(renderedKnown, /\$0\.012/, "muestra el coste real ($0.012)");
		assert.doesNotMatch(renderedKnown, /\$0\.000/, "NO inventa $0.000 cuando hay coste conocido");
		assert.match(renderedKnown, /TASK COMPLETED/, "tarjeta de completado con coste");

		// (2) Sin telemetría fiable → representa explícitamente 'n/d', no un número.
		renderedChunks.length = 0;
		const unknown: TaskTelemetry = { iterations: 2, totalCost: null, totalTokens: null, startTs: 0, endTs: 1000 };
		renderer.onTaskCompleted("tarea completada", unknown);
		const renderedUnknown = renderedChunks.join("").replace(/\x1b\[[0-9;]*m/g, "");
		assert.match(renderedUnknown, /cost n\/d/, "sin usage → muestra 'cost n/d', NO $0.000");
		assert.doesNotMatch(renderedUnknown, /\$0\.000/, "sin usage NO inventa $0.000");
	});
});
