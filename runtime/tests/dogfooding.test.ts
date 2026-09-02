import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it } from "vitest";

import { LocalStore } from "../src/cli-persistence.js";
import { runLoop } from "../src/core/loop.js";
import type { AiesEventHandlers, DecideOutcome, ExecuteOutcome, WorkerEventSink } from "../src/core/events.js";
import {
	applyAjustePlan,
	appendResult,
	initState,
	type Decision,
	type OperationResult,
	type RuntimeState,
	type Task,
	type WorkerReport,
	type WorkUnit,
} from "../src/core/state.js";
import type { WorkerTelemetry } from "../src/telemetry/types.js";

const ORCH_TELEM: WorkerTelemetry = {
	usage: { tokens: { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, total: 120 }, cost: 0.001 },
	contextUsage: null,
	telemetryUnavailable: false,
};
const WORKER_TELEM: WorkerTelemetry = {
	usage: { tokens: { input: 220, output: 80, cacheRead: 0, cacheWrite: 0, total: 300 }, cost: 0.002 },
	contextUsage: null,
	telemetryUnavailable: false,
};
const NO_TELEM: WorkerTelemetry = {
	usage: null,
	contextUsage: null,
	telemetryUnavailable: false,
};

type Step = Decision | ((state: RuntimeState) => Decision);
type WorkerFn = (unit: WorkUnit, state: RuntimeState, events: WorkerEventSink) => Promise<ExecuteOutcome>;

interface DogfoodMetrics {
	scenario: string;
	prompt: string;
	decisions: number;
	workers: number;
	explorers: number;
	verifierLlm: number;
	deterministic: number;
	replans: number;
	humanWait: number;
	iterations: number;
	tokens: number;
	cost: number;
	final: string;
	correct: boolean;
}

const records: DogfoodMetrics[] = [];
const dogfoodRoots: string[] = [];
let activeMetrics: DogfoodMetrics | null = null;

function task(prompt: string): Task {
	return {
		objetivo: prompt,
		alcance: null,
		restricciones: null,
		resultadoEsperado: null,
		condicionFinalizacion: "tarea completada o fallida",
	};
}

function unit(objetivo: string, capacidad: WorkUnit["capacidad"], requisitos: string[] = [], criteriosAceptacion: string[] = []): NonNullable<Decision["ajustePlan"]>["unidades"][number] {
	return {
		objetivo,
		alcance: null,
		infoNecesaria: null,
		resultadoEsperado: "cambio verificado",
		condicionFinalizacion: "criterios de aceptación cumplidos",
		capacidad,
		requisitos,
		criteriosAceptacion,
	};
}

function executeResult(unitId: string, text: string, report: WorkerReport, passed: boolean | null = report.status === "satisfied"): ExecuteOutcome {
	return {
		result: { kind: "unidad", text, unidadId: unitId, passed } satisfies OperationResult,
		telemetry: WORKER_TELEM,
		report,
	};
}

function terminal(): Decision {
	return {
		operación: "terminar",
		motivo: "todas las unidades activas están satisfechas y verificadas",
		condición: { desenlace: "completed", detalle: "criterios cumplidos" },
	};
}

async function runScenario(
	scenario: string,
	prompt: string,
	steps: Step[],
	worker: WorkerFn,
	correct: (state: RuntimeState) => boolean,
	options: { maxIterations?: number; maxConsecutiveNoProgress?: number } = {},
): Promise<{ state: RuntimeState; metrics: DogfoodMetrics; root: string; checkpoints: Array<{ state: RuntimeState; motivo: string }> }> {
	const root = mkdtempSync(join(tmpdir(), "aies-dogfood-"));
	dogfoodRoots.push(root);
	const store = new LocalStore(root);
	const metrics: DogfoodMetrics = {
		scenario,
		prompt,
		decisions: 0,
		workers: 0,
		explorers: 0,
		verifierLlm: 0,
		deterministic: 0,
		replans: 0,
		humanWait: 0,
		iterations: 0,
		tokens: 0,
		cost: 0,
		final: "",
		correct: false,
	};
	const checkpoints: Array<{ state: RuntimeState; motivo: string }> = [];
	let stepIndex = 0;
	const decide = async (state: RuntimeState): Promise<DecideOutcome> => {
		metrics.decisions += 1;
		const step = steps[stepIndex++] ?? steps[steps.length - 1];
		if (!step) throw new Error(`scenario ${scenario}: faltan decisiones`);
		const decision = typeof step === "function" ? step(state) : step;
		metrics.tokens += ORCH_TELEM.usage?.tokens.total ?? 0;
		metrics.cost += ORCH_TELEM.usage?.cost ?? 0;
		if (decision.ajustePlan && (decision.ajustePlan.tipo === "re-descomponer" || decision.ajustePlan.tipo === "cambiar de estrategia")) {
			metrics.replans += 1;
		}
		return { decision, telemetry: ORCH_TELEM, raw: JSON.stringify(decision), parseFail: false };
	};
	const execute = async (state: RuntimeState, decision: Decision, events: WorkerEventSink): Promise<ExecuteOutcome> => {
		if (decision.operación === "obtener información") {
			metrics.explorers += 1;
			metrics.tokens += WORKER_TELEM.usage?.tokens.total ?? 0;
			metrics.cost += WORKER_TELEM.usage?.cost ?? 0;
			return worker({ ...unit("explorer", "explorer") , id: "explorer", estado: "En curso", intentos: 0 }, state, events);
		}
		if (decision.operación === "terminar") {
			return { result: { kind: "terminación", text: "terminación declarada", unidadId: null, passed: null }, telemetry: NO_TELEM };
		}
		const active = state.units.find((candidate) => candidate.estado === "En curso");
		if (!active) throw new Error(`scenario ${scenario}: worker sin unidad En curso`);
		metrics.workers += 1;
		if (active.capacidad === "verifier") metrics.verifierLlm += 1;
		metrics.tokens += WORKER_TELEM.usage?.tokens.total ?? 0;
		metrics.cost += WORKER_TELEM.usage?.cost ?? 0;
		return worker(active, state, events);
	};
	const handlers: AiesEventHandlers = {
		decide,
		execute,
		checkpoint: (state, motivo) => {
			store.checkpoint(state, motivo);
			checkpoints.push({ state, motivo });
		},
		onHumanWait: () => {
			metrics.humanWait += 1;
		},
	};
	const limits = {
		maxIterations: options.maxIterations ?? 12,
		maxConsecutiveNoProgress: options.maxConsecutiveNoProgress ?? 3,
	};
	activeMetrics = metrics;
	const state = await runLoop(initState(task(prompt), limits), handlers);
	metrics.iterations = state.iterations;
	metrics.final = state.taskState;
	metrics.correct = correct(state);
	records.push(metrics);
	activeMetrics = null;
	return { state, metrics, root, checkpoints };
}

afterAll(() => {
	console.log("\nAIES dogfooding metrics");
	console.table(records.map(({ prompt: _prompt, ...row }) => row));
	for (const root of dogfoodRoots) rmSync(root, { recursive: true, force: true });
});

describe("dogfooding de fiabilidad estructural", () => {
	it("A — entiende lenguaje humano mínimo y obtiene contexto antes de implementar", async () => {
		const layout = mkdtempSync(join(tmpdir(), "aies-astro-a-"));
		const file = join(layout, "Layout.astro");
		writeFileSync(file, "<html><body><slot /></body></html>\n", "utf8");
		try {
			const result = await runScenario(
				"A",
				"pon analytics de vercel",
				[
					{ operación: "obtener información", motivo: "inspeccionar el layout base antes de elegir la integración" },
					{
						operación: "ejecutar una unidad",
						ajustePlan: {
							tipo: "determinar el proceso",
							unidades: [unit("integrar Vercel Analytics en el layout Astro descubierto", "implementer", ["integrar analytics de Vercel"], ["el layout importa Analytics", "el layout renderiza Analytics"])],
						},
						unidad: { tipo: "planificada", indice: 0 },
						motivo: "contexto suficiente y paquete Astro identificado",
					},
					terminal(),
				],
				async (u, _state) => {
					if (u.capacidad === "explorer") return { result: { kind: "info", text: `layout base descubierto: ${file}`, unidadId: null, passed: null }, telemetry: WORKER_TELEM };
					const before = readFileSync(file, "utf8");
					const next = `---\nimport { Analytics } from "@vercel/analytics/astro";\n---\n${before.replace("<body>", "<body>\n  <Analytics />")}`;
					writeFileSync(file, next, "utf8");
					metricsDeterministic(records, "A");
					return executeResult(u.id, "Analytics integrada", { status: "satisfied", summary: "integración aplicada", criteria: [{ criterion: "el layout importa Analytics", status: "pass", evidence: next }, { criterion: "el layout renderiza Analytics", status: "pass", evidence: next }], unmetCriteria: [] });
				},
				(state) => state.taskState === "Completada" && state.results.some((r) => r.kind === "info"),
			);
			assert.equal(result.metrics.explorers, 1);
			assert.equal(result.metrics.workers, 1);
			assert.equal(result.metrics.humanWait, 0);
			assert.equal(result.metrics.decisions, 3);
			assert.equal(result.state.taskState, "Completada");
		} finally {
			rmSync(layout, { recursive: true, force: true });
		}
	});

	it("B — conserva el requisito literal y no acepta inject() como equivalente", async () => {
		const root = mkdtempSync(join(tmpdir(), "aies-astro-b-"));
		const file = join(root, "Layout.astro");
		const literal = "usa `@vercel/analytics/astro` en el layout base y añade `<Analytics />`";
		writeFileSync(file, "<html><body><slot /></body></html>\n", "utf8");
		try {
			let receivedRequirements: string[] = [];
			const result = await runScenario("B", literal, [
				{
					operación: "ejecutar una unidad",
					ajustePlan: { tipo: "determinar el proceso", unidades: [unit("aplicar el requisito literal en el layout base", "implementer", [literal], ["aparece el import literal", "aparece el componente Analytics"]) ] },
					unidad: { tipo: "planificada", indice: 0 },
					motivo: "el requisito técnico ya especifica la integración",
				},
				terminal(),
			], async (u) => {
				receivedRequirements = u.requisitos ?? [];
				const content = readFileSync(file, "utf8");
				if (!receivedRequirements.includes(literal)) return executeResult(u.id, "requisito perdido", { status: "unsatisfied", summary: "literal no recibido", criteria: [], unmetCriteria: [literal] }, false);
				const next = `---\nimport { Analytics } from "@vercel/analytics/astro";\n---\n${content.replace("<body>", "<body>\n<Analytics />")}`;
				writeFileSync(file, next, "utf8");
				metricsDeterministic(records, "B");
				const ok = next.includes("@vercel/analytics/astro") && next.includes("<Analytics />") && !next.includes("inject(");
				return executeResult(u.id, "requisito literal aplicado", { status: ok ? "satisfied" : "unsatisfied", summary: ok ? "literal conservado" : "alternativa no equivalente", criteria: [{ criterion: "literal", status: ok ? "pass" : "fail", evidence: next }], unmetCriteria: ok ? [] : [literal] }, ok);
			}, (state) => state.taskState === "Completada" && receivedRequirements.includes(literal) && !readFileSync(file, "utf8").includes("inject("));
			assert.equal(result.state.taskState, "Completada");
			assert.equal(receivedRequirements[0], literal);
			assert.equal(result.metrics.decisions, 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("C — recupera autónomamente de una alternativa incorrecta con replan persistido", async () => {
		const root = mkdtempSync(join(tmpdir(), "aies-recovery-c-"));
		const file = join(root, "target.txt");
		const requirement = "el archivo debe contener X";
		writeFileSync(file, "inicio\n", "utf8");
		try {
			const initial = unit("implementar X", "implementer", [requirement], [requirement]);
			const correction = unit("implementar X sin usar la alternativa Y", "implementer", [requirement], [requirement]);
			const result = await runScenario("C", "implementa X", [
				{ operación: "ejecutar una unidad", ajustePlan: { tipo: "determinar el proceso", unidades: [initial] }, unidad: { tipo: "planificada", indice: 0 }, motivo: "plan inicial" },
				{ operación: "ejecutar una unidad", ajustePlan: { tipo: "cambiar de estrategia", reemplaza: ["u0"], unidades: [correction] }, unidad: { tipo: "planificada", indice: 0 }, feedbackCorrectivo: "Y no satisface X; conserva el requisito original y escribe X.", motivo: "el reporte detectó mismatch" },
				terminal(),
			], async (u) => {
				if (u.id === "u0") {
					writeFileSync(file, "Y\n", "utf8");
					return executeResult(u.id, "alternativa Y aplicada", { status: "unsatisfied", summary: "Y no satisface X", criteria: [{ criterion: requirement, status: "fail", evidence: "sólo aparece Y" }], unmetCriteria: [requirement] }, false);
				}
				assert.equal(u.requisitos?.[0], requirement);
				writeFileSync(file, "X\n", "utf8");
				metricsDeterministic(records, "C");
				return executeResult(u.id, "X aplicado", { status: "satisfied", summary: "requisito original cumplido", criteria: [{ criterion: requirement, status: "pass", evidence: "X" }], unmetCriteria: [] });
			}, (state) => state.taskState === "Completada" && readFileSync(file, "utf8").includes("X") && state.units.some((u) => u.id === "u0" && u.estado === "Sustituida"));
			assert.equal(result.state.taskState, "Completada");
			assert.equal(result.metrics.humanWait, 0);
			assert.equal(result.metrics.replans, 1);
			assert.ok(result.checkpoints.some((c) => c.motivo === "pre-execute:u1" && c.state.units.some((u) => u.id === "u1")));
			assert.equal(new LocalStore(result.root).loadState()?.units.find((u) => u.id === "u1")?.estado, "Terminada");
			assert.ok(result.state.units.every((u) => /^u\d+$/.test(u.id)));
			assert.ok(result.metrics.iterations <= 3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("D — descubre la causa del error de guardado antes de corregir", async () => {
		const root = mkdtempSync(join(tmpdir(), "aies-save-d-"));
		const file = join(root, "save.ts");
		writeFileSync(file, "export function save(value) { return db.write(value); }\n", "utf8");
		try {
			const result = await runScenario("D", "arregla el error que sale al guardar", [
				{ operación: "obtener información", motivo: "inspeccionar código, tests y logs disponibles para localizar el error" },
				(state) => ({ operación: "ejecutar una unidad", ajustePlan: { tipo: "determinar el proceso", unidades: [unit(`corregir save.ts: ${state.knownInfo.find((x) => x.includes("causa:")) ?? "evidencia descubierta"}`, "implementer", ["no perder el valor guardado"], ["save devuelve el valor escrito"]) ] }, unidad: { tipo: "planificada", indice: 0 }, motivo: "la exploración aportó la causa raíz" }),
				terminal(),
			], async (u) => {
				if (u.capacidad === "explorer") return { result: { kind: "info", text: "evidencia: save.ts devuelve la promesa sin await; causa: valor no confirmado al guardar", unidadId: null, passed: null }, telemetry: WORKER_TELEM };
				writeFileSync(file, "export async function save(value) { return await db.write(value); }\n", "utf8");
				metricsDeterministic(records, "D");
				return executeResult(u.id, "causa corregida", { status: "satisfied", summary: "guardado confirmado", criteria: [{ criterion: "save devuelve el valor escrito", status: "pass", evidence: readFileSync(file, "utf8") }], unmetCriteria: [] });
			}, (state) => state.taskState === "Completada" && state.knownInfo.some((x) => x.includes("causa:")));
			assert.equal(result.metrics.humanWait, 0);
			assert.equal(result.metrics.explorers, 1);
			assert.equal(result.state.taskState, "Completada");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("E — mejora un header móvil inspeccionando primero el diseño existente", async () => {
		const root = mkdtempSync(join(tmpdir(), "aies-header-e-"));
		const file = join(root, "Header.css");
		writeFileSync(file, ".header { display: flex; padding: 32px; }\n", "utf8");
		try {
			const result = await runScenario("E", "haz que el header se vea mejor en móvil", [
				{ operación: "obtener información", motivo: "leer el header y sus estilos actuales" },
				{ operación: "ejecutar una unidad", ajustePlan: { tipo: "determinar el proceso", unidades: [unit("mejorar el espaciado del header en pantallas pequeñas", "implementer", [], ["existe una regla responsive para .header"]) ] }, unidad: { tipo: "planificada", indice: 0 }, motivo: "hay una mejora razonable inferible del CSS existente" },
				terminal(),
			], async (u) => {
				if (u.capacidad === "explorer") return { result: { kind: "info", text: "Header.css usa padding 32px y no tiene media query", unidadId: null, passed: null }, telemetry: WORKER_TELEM };
				const next = `${readFileSync(file, "utf8")}\n@media (max-width: 640px) { .header { padding: 16px; } }\n`;
				writeFileSync(file, next, "utf8");
				metricsDeterministic(records, "E");
				return executeResult(u.id, "responsive añadido", { status: "satisfied", summary: "header adaptado", criteria: [{ criterion: "existe una regla responsive para .header", status: "pass", evidence: next }], unmetCriteria: [] });
			}, (state) => state.taskState === "Completada" && readFileSync(file, "utf8").includes("max-width"));
			assert.equal(result.metrics.humanWait, 0);
			assert.equal(result.metrics.explorers, 1);
			assert.equal(result.state.taskState, "Completada");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("F — la ambigüedad genuina bloquea una vez y no reejecuta el orquestador", async () => {
		const prompt = "elige entre migrar el sistema de pagos o conservarlo";
		const waitingDecision: Decision = { operación: "comunicar al desarrollador", motivo: "dos decisiones incompatibles con impacto financiero", comunicación: { pregunta: "¿migramos pagos o conservamos el sistema actual?", razón: "architectural_conflict", informaciónFaltante: "decisión de producto y riesgo aceptado" } };
		let decideCalls = 0;
		let executeCalls = 0;
		const initial = initState(task(prompt), { maxIterations: 12, maxConsecutiveNoProgress: 3 });
		const handlers: AiesEventHandlers = {
			decide: async () => { decideCalls += 1; return { decision: waitingDecision, telemetry: ORCH_TELEM, raw: JSON.stringify(waitingDecision), parseFail: false }; },
			execute: async () => { executeCalls += 1; return { result: { kind: "fallo", text: "no debe ejecutarse", unidadId: null, passed: false }, telemetry: WORKER_TELEM }; },
		};
		const waiting = await runLoop(initial, handlers);
		assert.equal(waiting.runStatus.tipo, "waiting_for_user");
		assert.equal(decideCalls, 1);
		assert.equal(executeCalls, 0);
		const stillWaiting = await runLoop(waiting, handlers);
		assert.equal(decideCalls, 1, "reintentar el snapshot bloqueado no repite la pregunta");
		assert.equal(stillWaiting.runStatus.tipo, "waiting_for_user");
		const resumed = { ...waiting, runStatus: { tipo: "ready" as const }, humanWait: null, knownInfo: [...waiting.knownInfo, "respuesta humana: conservar el sistema actual"], results: [...waiting.results, { kind: "human_response" as const, text: "conservar el sistema actual", unidadId: null, passed: null }] };
		const finished = await runLoop(resumed, { decide: async () => ({ decision: terminal(), telemetry: ORCH_TELEM, raw: "{}", parseFail: false }), execute: handlers.execute });
		assert.equal(finished.taskState, "Completada");
		assert.equal(executeCalls, 1, "sólo continúa después de una respuesta nueva");
		const metrics: DogfoodMetrics = { scenario: "F", prompt, decisions: decideCalls + 1, workers: 0, explorers: 0, verifierLlm: 0, deterministic: 0, replans: 0, humanWait: 1, iterations: waiting.iterations + finished.iterations, tokens: ORCH_TELEM.usage!.tokens.total * 2, cost: ORCH_TELEM.usage!.cost * 2, final: finished.taskState, correct: true };
		records.push(metrics);
	});

	it("G — soluciones incorrectas equivalentes terminan por no-progreso acotado", async () => {
		const bad = (id: string): WorkerFn => async (u) => executeResult(u.id, `alternativa equivalente para ${id}`, { status: "unsatisfied", summary: "misma alternativa incorrecta", criteria: [{ criterion: "X", status: "fail", evidence: "Y" }], unmetCriteria: ["X"] }, false);
		const planFor = (tipo: "determinar el proceso" | "cambiar de estrategia", reemplaza: string[] = []) => ({ tipo, reemplaza, unidades: [unit("implementar X usando la misma alternativa Y", "implementer", ["X"], ["X"]) ] });
		const result = await runScenario("G", "implementa X", [
			{ operación: "ejecutar una unidad", ajustePlan: planFor("determinar el proceso"), unidad: { tipo: "planificada", indice: 0 }, motivo: "plan inicial" },
			{ operación: "ejecutar una unidad", ajustePlan: planFor("cambiar de estrategia", ["u0"]), unidad: { tipo: "planificada", indice: 0 }, motivo: "reintento equivalente" },
			{ operación: "ejecutar una unidad", ajustePlan: planFor("cambiar de estrategia", ["u1"]), unidad: { tipo: "planificada", indice: 0 }, motivo: "repetición equivalente" },
			{ operación: "ejecutar una unidad", ajustePlan: planFor("cambiar de estrategia", ["u2"]), unidad: { tipo: "planificada", indice: 0 }, motivo: "repetición equivalente final" },
		], bad("Y"), (state) => state.taskState === "Fallida" && /no-progreso/.test(state.terminalCondition ?? ""), { maxConsecutiveNoProgress: 3 });
		assert.equal(result.state.taskState, "Fallida");
		assert.equal(result.metrics.humanWait, 0);
		assert.equal(result.metrics.iterations, 4);
		assert.equal(result.metrics.replans, 3);
		assert.ok(result.metrics.iterations < 10);
	});

	it("consecutiveNoProgress no cuenta como progreso la misma evidencia informativa repetida", async () => {
		const result = await runScenario("no-progress-info", "repite la inspección", [
			{ operación: "obtener información", motivo: "leer evidencia" },
		], async () => ({ result: { kind: "info", text: "evidencia repetida", unidadId: null, passed: null }, telemetry: WORKER_TELEM }), state => state.taskState === "Fallida" && /no-progreso/.test(state.terminalCondition ?? ""), { maxConsecutiveNoProgress: 3 });
		assert.equal(result.metrics.iterations, 4);
		assert.equal(result.state.taskState, "Fallida");
	});

	it("un checkpoint fallido impide ejecutar el worker", async () => {
		let executed = false;
		const state = initState(task("checkpoint"));
		const final = await runLoop(state, {
			decide: async () => ({ decision: { operación: "ejecutar una unidad", ajustePlan: { tipo: "determinar el proceso", unidades: [unit("x", "implementer")] }, unidad: { tipo: "planificada", indice: 0 }, motivo: "x" }, telemetry: ORCH_TELEM, raw: "{}", parseFail: false }),
			execute: async () => { executed = true; return executeResult("u0", "no", { status: "satisfied", summary: "no", criteria: [], unmetCriteria: [] }); },
			checkpoint: () => { throw new Error("disco lleno"); },
		});
		assert.equal(executed, false);
		assert.ok(final.results.some((r) => r.text.includes("checkpoint falló")));
	});
});

function metricsDeterministic(_records: DogfoodMetrics[], _scenario: string): void {
	if (activeMetrics) activeMetrics.deterministic += 1;
}
