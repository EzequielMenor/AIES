// src/cli-status.test.ts — T3.2: /status (estado + telemetría agregada + huella por vuelta).

import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";

import { LocalStore } from "./cli-persistence.js";
import { formatStatus } from "./cli-status.js";
import { initState, type RuntimeState } from "./core/state.js";
import { computeMetrics } from "./research/metrics.js";
import type { LogEntry, DecisionLogEntry, ResultLogEntry } from "./observability.js";
import type { TelemetryUsage } from "./telemetry/types.js";

const dirs: string[] = [];
afterEach(() => {
	dirs.length = 0;
});

function makeState(iterations: number, units: RuntimeState["units"], results: RuntimeState["results"]): RuntimeState {
	const s = initState(
		{ objetivo: "tarea T3.2", alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: "ok" },
		{ maxIterations: 12 },
	);
	return { ...s, taskState: "En curso", iterations, units, results };
}

const USAGE_ORQ: TelemetryUsage = {
	tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
	cost: 0.0015,
};
const USAGE_WORKER: TelemetryUsage = {
	tokens: { input: 200, output: 100, cacheRead: 0, cacheWrite: 0, total: 300 },
	cost: 0.003,
};

function decisionEntry(iter: number, op: DecisionLogEntry["operación"], overrides: Partial<DecisionLogEntry> = {}): DecisionLogEntry {
	return {
		type: "decision",
		iter,
		operación: op,
		ajustePlan: null,
		motivo: "motivo",
		unidad: null,
		capacidad: null,
		condición: null,
		parseFail: false,
		ts: new Date(1_700_000_000_000 + iter * 1000).toISOString(),
		...overrides,
	};
}

function resultEntry(iter: number, kind: ResultLogEntry["kind"], overrides: Partial<ResultLogEntry> = {}): ResultLogEntry {
	return {
		type: "resultado",
		iter,
		resultado: "VEREDICTO: PASS",
		kind,
		unidadId: null,
		usage: USAGE_WORKER,
		contextUsage: null,
		telemetryUnavailable: false,
		telemetryReason: null,
		límite_alcanzado: null,
		ts: new Date(1_700_000_000_000 + iter * 1000 + 500).toISOString(),
		...overrides,
	};
}

describe("LocalStore readLogIndexed", () => {
	it("archivo ausente → []", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-empty-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		assert.deepEqual(store.readLogIndexed(), []);
	});

	it("lee líneas con nº de línea físico 1-based", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-lines-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		store.appendLog(decisionEntry(0, "obtener información"));
		store.appendLog(resultEntry(1, "info"));
		const entries = store.readLogIndexed();
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.line, 1);
		assert.equal(entries[1]!.line, 2);
	});

	it("línea corrupta: se salta pero no desplaza offsets posteriores", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-corrupt-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		store.appendLog(decisionEntry(0, "obtener información"));
		// Inyectar línea corrupta entre dos entradas válidas.
		appendFileSync(path.join(cwd, ".aies", "log.jsonl"), "{ esto no es JSON\n", "utf8");
		store.appendLog(resultEntry(1, "info"));
		const entries = store.readLogIndexed();
		assert.equal(entries.length, 2);
		assert.equal(entries[0]!.line, 1, "primera entrada en línea 1");
		assert.equal(entries[1]!.line, 3, "segunda entrada en línea 3 (la 2 es corrupta)");
	});
});

describe("/status — criterios de salida Fase 3", () => {
	it("1) log sintético completo: árbol, totales, ctx máx, verify, incidencias, log#X–Y", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-full-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);

		// Estado con unidades ✓/○/✗.
		const state = makeState(
			3,
			[
				{ id: "u0", objetivo: "explorar", alcance: null, infoNecesaria: null, resultadoEsperado: "x", condicionFinalizacion: "ok", capacidad: "explorer", estado: "Terminada" },
				{ id: "u1", objetivo: "implementar", alcance: null, infoNecesaria: null, resultadoEsperado: "x", condicionFinalizacion: "ok", capacidad: "implementer", estado: "Pendiente" },
				{ id: "u2", objetivo: "verificar", alcance: null, infoNecesaria: null, resultadoEsperado: "x", condicionFinalizacion: "ok", capacidad: "verifier", estado: "Fallida" },
			],
			[{ kind: "unidad", text: "ok", unidadId: "u0", passed: true }],
		);

		// Entradas sintéticas: 3 vueltas completas + 1 parse-fail + 1 compaction + 1 límite.
		// vuelta 0: decisión@0 (orq) + resultado@1 (PASS) → orq telemetría cuenta a orquestador.
		store.appendLog(decisionEntry(0, "obtener información", { usage: USAGE_ORQ }));
		store.appendLog(resultEntry(1, "info", { resultado: "VEREDICTO: PASS", usage: USAGE_WORKER, contextUsage: { tokens: 5000, contextWindow: 100000, percent: 50 } }));
		// vuelta 1: parse-fail en decisión@1 (cuenta como decisión del turno), resultado@2.
		store.appendLog(decisionEntry(1, "ejecutar una unidad", { parseFail: true, unidad: "u1", capacidad: "implementer", usage: USAGE_ORQ }));
		store.appendLog(resultEntry(2, "unidad", { resultado: "VEREDICTO: FAIL", usage: USAGE_WORKER, unidadId: "u1" }));
		// vuelta 2: límite alcanzado en resultado@3 (decisión@2 ejecuta).
		store.appendLog(decisionEntry(2, "ejecutar una unidad", { unidad: "u2", capacidad: "verifier", usage: USAGE_ORQ }));
		store.appendLog(resultEntry(3, "límite", { límite_alcanzado: "iteraciones", kind: "límite", usage: USAGE_WORKER }));
		// Compaction fuera de iteraciones.
		store.appendLog({
			type: "compaction",
			fase: "start",
			reason: "threshold",
			summary: null,
			firstKeptEntryId: null,
			tokensBefore: null,
			estimatedTokensAfter: null,
			aborted: false,
			willRetry: false,
			errorMessage: null,
		});

		const log = store.readLogIndexed();
		const text = formatStatus(state, log);

		// Sección 1: árbol.
		assert.match(text, /✓ u0 · explorer · Terminada/);
		assert.match(text, /○ u1 · implementer · Pendiente/);
		assert.match(text, /✗ u2 · verifier · Fallida/);

		// Sección 2: totales.
		// orq tokens = 150*3 = 450; workers = 300*3 = 900; total = 1350 → 1.35k
		assert.match(text, /tokens totales\s*: 1\.35k tok/);
		assert.match(text, /orq 450 · workers 900/);
		// orq coste = 0.0015*3 = 0.0045 → $0.005; workers = 0.003*3 = 0.009; total = 0.0135 → $0.013
		assert.match(text, /coste total\s*: \$0\.013/);
		assert.match(text, /orq \$0\.005/);
		// ctx máx: la entrada con percent=50 fija max = 50%, window 100000.
		assert.match(text, /contexto máx\s*: 50% \(window 100000\)/);
		// verify: 2 PASS (info@1 PASS, límite@3 hereda el default PASS), 1 FAIL (unidad@2 FAIL).
		assert.match(text, /verify\s*: 2 PASS · 1 FAIL/);
		// incidencias: 1 parse-fail, 1 límite, 1 compaction.
		assert.match(text, /incidencias\s*: 1 parse-fail, 1 límites, 1 compactions/);

		// Sección 3: huella por vuelta con offsets físicos.
		assert.match(text, /Vueltas \(historial\):/);
		assert.match(text, /iter 0 .*→ info .* log#1–2/);
		assert.match(text, /iter 1 .*→ unidad .* log#3–4/);
		assert.match(text, /iter 2 .*→ límite .* log#5–6/);
	});

	it("2) sin log: sección 'sin entradas', ningún $0 / 0 tok inventado", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-nolog-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		const state = makeState(0, [], []);
		const text = formatStatus(state, store.readLogIndexed());
		assert.match(text, /0 entradas/);
		assert.match(text, /sin entradas en \.aies\/log\.jsonl/);
		// RNF-07/17: ningún `$0.000` ni `0 tok`.
		assert.doesNotMatch(text, /\$0\.000/);
		assert.doesNotMatch(text, /\b0 tok\b/);
		// Sin entradas: verify/incidencias/coste NO se imprimen (mínimo), vueltas dice "sin vueltas emparejadas".
		assert.doesNotMatch(text, /verify\s*:/);
		assert.doesNotMatch(text, /incidencias\s*:/);
		assert.match(text, /\(sin vueltas emparejadas\)/);
	});

	it("3) telemetría ausente (usage null en todas) → n/d explícito", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-nd-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		const state = makeState(1, [], []);
		const noUsageResult = (iter: number): ResultLogEntry => ({
			type: "resultado",
			iter,
			resultado: "veredicto PASS",
			kind: "info",
			unidadId: null,
			usage: null,
			contextUsage: null,
			telemetryUnavailable: true,
			telemetryReason: "host sin telemetría",
			límite_alcanzado: null,
			ts: new Date(1_700_000_001_000 + iter * 1000).toISOString(),
		});
		store.appendLog({
			type: "decision",
			iter: 0,
			operación: "obtener información",
			ajustePlan: null,
			motivo: "x",
			unidad: null,
			capacidad: null,
			condición: null,
			parseFail: false,
			usage: null,
			ts: new Date(1_700_000_000_000).toISOString(),
		});
		store.appendLog(noUsageResult(1));
		const text = formatStatus(state, store.readLogIndexed());
		assert.match(text, /tokens totales\s*: n\/d/);
		assert.match(text, /coste total\s*: n\/d/);
		assert.match(text, /contexto máx\s*: n\/d/);
		// Pero verify sigue funcionando (lee texto): 1 PASS.
		assert.match(text, /verify\s*: 1 PASS · 0 FAIL/);
	});

	it("4) línea corrupta en medio del jsonl: huella cita líneas físicas", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-mixed-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		const state = makeState(1, [], []);

		// Línea 1: decisión válida.
		store.appendLog(decisionEntry(0, "obtener información"));
		// Línea 2: basura (inyectada directamente).
		appendFileSync(path.join(cwd, ".aies", "log.jsonl"), "<<< corrupto >>>\n", "utf8");
		// Línea 3: resultado válido.
		store.appendLog(resultEntry(1, "info"));

		const log = store.readLogIndexed();
		assert.equal(log.length, 2, "la línea corrupta se descarta");
		assert.equal(log[0]!.line, 1);
		assert.equal(log[1]!.line, 3, "el nº de línea físico NO se desplaza");

		const text = formatStatus(state, log);
		assert.match(text, /log#1–3/, "la huella cita los offsets físicos reales");
	});

	it("resultados sintéticos en la misma iteración: la huella no los pierde", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-synthetic-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		store.appendLog(decisionEntry(0, "comunicar al desarrollador"));
		store.appendLog(resultEntry(0, "límite", { límite_alcanzado: "iteraciones", kind: "límite" }));
		const text = formatStatus(makeState(0, [], []), store.readLogIndexed());
		assert.match(text, /iter 0 .*→ límite .* log#1–2/);
	});

	it("JSON válido con shape de log incompleto: se descarta sin crash", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-invalid-json-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		mkdirSync(path.join(cwd, ".aies"), { recursive: true });
		writeFileSync(path.join(cwd, ".aies", "log.jsonl"), '{"type":"resultado"}\n', "utf8");
		assert.deepEqual(store.readLogIndexed(), []);
		assert.match(formatStatus(makeState(0, [], []), store.readLogIndexed()), /0 entradas/);
	});

	it("5) sin estado (null) → mensaje sin crash", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-nostate-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		const text = formatStatus(null, store.readLogIndexed());
		assert.match(text, /sin estado cargado todavía/);
		// Sin secciones adicionales (no se imprime árbol ni telemetría).
		assert.doesNotMatch(text, /Telemetría \(historial/);
		assert.doesNotMatch(text, /Vueltas \(historial\):/);
	});

	it("6) importar computeMetrics NO ejecuta main() (no process.exit en import)", () => {
		// Si el guard no estuviera, este test terminaría el proceso. Llegar hasta aquí lo verifica.
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-guard-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		store.appendLog(decisionEntry(0, "obtener información"));
		const report = computeMetrics(path.join(cwd, ".aies", "log.jsonl"), store.readLog());
		assert.ok(report);
		assert.equal(report.entradas, 1);
	});
});

describe("cobertura auxiliar", () => {
	it("formatStatus con log desordenado físicamente se ordena por iter asc", () => {
		const cwd = mkdtempSync(path.join(tmpdir(), "aies-status-order-"));
		dirs.push(cwd);
		const store = new LocalStore(cwd);
		const state = makeState(3, [], []);
		// Vuelta iter 2 primero, luego vuelta iter 0. La huella debe listar iter 0 antes que iter 2.
		store.appendLog(decisionEntry(2, "ejecutar una unidad", { unidad: "u2", capacidad: "verifier" }));
		store.appendLog(resultEntry(3, "info"));
		store.appendLog(decisionEntry(0, "obtener información"));
		store.appendLog(resultEntry(1, "info"));
		const text = formatStatus(state, store.readLogIndexed());
		const idx0 = text.indexOf("iter 0");
		const idx2 = text.indexOf("iter 2");
		assert.ok(idx0 > -1, "vuelta iter 0 presente");
		assert.ok(idx2 > -1, "vuelta iter 2 presente");
		assert.ok(idx0 < idx2, "orden estable por iter asc pese al orden de append");
	});
});
