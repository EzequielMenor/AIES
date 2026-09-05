// src/cli-log.test.ts — T3.3: /log (tail legible de log.jsonl).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";

import { LocalStore } from "./cli-persistence.js";
import { DEFAULT_LOG_TAIL, formatLogTail, formatToolTrace, parseLogArg, parseTraceArg } from "./cli-log.js";
import type { CompactionLogEntry, DecisionLogEntry, ResultLogEntry } from "./observability.js";
import type { TelemetryUsage } from "./telemetry/types.js";

const dirs: string[] = [];
afterEach(() => {
	dirs.length = 0;
});

function newStore(prefix: string): LocalStore {
	const cwd = mkdtempSync(path.join(tmpdir(), prefix));
	dirs.push(cwd);
	return new LocalStore(cwd);
}

const USAGE: TelemetryUsage = {
	tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
	cost: 0.0015,
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
		...overrides,
	};
}

function resultEntry(iter: number, kind: ResultLogEntry["kind"], overrides: Partial<ResultLogEntry> = {}): ResultLogEntry {
	return {
		type: "resultado",
		iter,
		resultado: "ok",
		kind,
		unidadId: null,
		usage: USAGE,
		contextUsage: null,
		telemetryUnavailable: false,
		telemetryReason: null,
		límite_alcanzado: null,
		...overrides,
	};
}

function compactionEntry(fase: CompactionLogEntry["fase"], overrides: Partial<CompactionLogEntry> = {}): CompactionLogEntry {
	return {
		type: "compaction",
		fase,
		reason: "threshold",
		summary: null,
		firstKeptEntryId: null,
		tokensBefore: 1000,
		estimatedTokensAfter: 400,
		aborted: false,
		willRetry: false,
		errorMessage: null,
		...overrides,
	};
}

describe("parseLogArg", () => {
	it("vacío → tail por defecto", () => {
		assert.equal(parseLogArg(""), DEFAULT_LOG_TAIL);
		assert.equal(parseLogArg("   "), DEFAULT_LOG_TAIL);
	});
	it('"all" → sin límite (null)', () => {
		assert.equal(parseLogArg("all"), null);
	});
	it("número entero positivo → ese límite", () => {
		assert.equal(parseLogArg("5"), 5);
		assert.equal(parseLogArg("100"), 100);
	});
	it("entrada inválida (no numérica, negativa, 0) → tail por defecto, no lanza", () => {
		assert.equal(parseLogArg("abc"), DEFAULT_LOG_TAIL);
		assert.equal(parseLogArg("-3"), DEFAULT_LOG_TAIL);
		assert.equal(parseLogArg("0"), DEFAULT_LOG_TAIL);
		assert.equal(parseLogArg("3.5"), DEFAULT_LOG_TAIL);
	});
});

describe("formatLogTail", () => {
	it("log vacío → mensaje explícito, no una tabla vacía", () => {
		assert.match(formatLogTail([], DEFAULT_LOG_TAIL), /sin entradas en \.aies\/log\.jsonl/);
	});

	it("una vuelta normal: iter, operación, unidad/capacidad, tokens, coste", () => {
		const store = newStore("aies-log-turn-");
		store.appendLog(decisionEntry(0, "ejecutar una unidad", { unidad: "u2", capacidad: "implementer" }));
		store.appendLog(resultEntry(0, "unidad"));
		const out = formatLogTail(store.readLogIndexed(), null);
		// formatCost redondea a 3 decimales bajo $1 (0.0015 -> "$0.002") — mismo
		// formateador que /status, no una regla propia de /log.
		assert.match(out, /iter 0\s+ejecutar unidad \(u2, implementer\) → unidad · 150 tok · \$0\.002\b/);
	});

	it("comunicación: muestra el TEXTO, no tokens/coste — es el único contenido legible de esa entrada", () => {
		const store = newStore("aies-log-comm-");
		store.appendLog(decisionEntry(0, "comunicar al desarrollador"));
		store.appendLog(resultEntry(0, "comunicación", { resultado: "cambios aplicados, verificando" }));
		const out = formatLogTail(store.readLogIndexed(), null);
		assert.match(out, /💬 "cambios aplicados, verificando"/);
		assert.doesNotMatch(out, /150 tok/);
	});

	it("comunicación larga se trunca con … en vez de desbordar la línea", () => {
		const store = newStore("aies-log-comm-long-");
		const long = "x".repeat(200);
		store.appendLog(decisionEntry(0, "comunicar al desarrollador"));
		store.appendLog(resultEntry(0, "comunicación", { resultado: long }));
		const out = formatLogTail(store.readLogIndexed(), null);
		assert.ok(out.includes("…"));
		assert.ok(!out.includes(long));
	});

	it("telemetría ausente → n/d explícito, nunca 0 tok / $0 (RNF-07/17)", () => {
		const store = newStore("aies-log-noteleme-");
		store.appendLog(decisionEntry(0, "obtener información"));
		store.appendLog(resultEntry(0, "info", { usage: null }));
		const out = formatLogTail(store.readLogIndexed(), null);
		assert.match(out, /→ info · n\/d · n\/d/);
	});

	it("compaction se muestra inline, no sólo agregada", () => {
		const store = newStore("aies-log-compaction-");
		store.appendLog(decisionEntry(0, "obtener información"));
		store.appendLog(resultEntry(0, "info"));
		store.appendLog(compactionEntry("start", { reason: "overflow" }));
		store.appendLog(compactionEntry("end", { reason: "overflow", summary: "resumen de 40 entradas" }));
		const out = formatLogTail(store.readLogIndexed(), null);
		assert.match(out, /compaction start · overflow/);
		assert.match(out, /compaction end · overflow.*resumen de 40 entradas/);
	});

	it("orden por línea física, vueltas y compactions intercaladas", () => {
		// Líneas: 1 decision(0), 2 compaction(start), 3 compaction(end),
		// 4 result(0), 5 decision(1), 6 result(1). Una vuelta se ordena por la
		// línea de su RESULTADO (donde pairTurns la ancla), no por su decisión —
		// así que la vuelta 0 (resultLine=4) cae DESPUÉS de ambas compactions
		// (líneas 2 y 3), aunque su decisión (línea 1) sea anterior a las dos.
		const store = newStore("aies-log-order-");
		store.appendLog(decisionEntry(0, "obtener información"));
		store.appendLog(compactionEntry("start"));
		store.appendLog(compactionEntry("end"));
		store.appendLog(resultEntry(0, "info"));
		store.appendLog(decisionEntry(1, "terminar"));
		store.appendLog(resultEntry(1, "terminación"));
		const out = formatLogTail(store.readLogIndexed(), null);
		const lines = out.split("\n").filter((l) => l.startsWith("  "));
		assert.equal(lines.length, 4, "2 compactions + 2 vueltas");
		assert.ok(lines[0]!.includes("compaction start"), lines[0]);
		assert.ok(lines[1]!.includes("compaction end"), lines[1]);
		assert.ok(lines[2]!.includes("iter 0"), lines[2]);
		assert.ok(lines[3]!.includes("iter 1"), lines[3]);
	});

	it("tail: limit recorta a las últimas N, cabecera lo indica", () => {
		const store = newStore("aies-log-tail-");
		for (let i = 0; i < 5; i++) {
			store.appendLog(decisionEntry(i, "obtener información"));
			store.appendLog(resultEntry(i, "info"));
		}
		const out = formatLogTail(store.readLogIndexed(), 2);
		assert.match(out, /últimas 2 de 5/);
		assert.doesNotMatch(out, /iter 0\s/);
		assert.doesNotMatch(out, /iter 1\s/);
		assert.doesNotMatch(out, /iter 2\s/);
		assert.match(out, /iter 3\s/);
		assert.match(out, /iter 4\s/);
	});

	it('limit null ("/log all") muestra todo, cabecera sin "últimas"', () => {
		const store = newStore("aies-log-all-");
		for (let i = 0; i < 3; i++) {
			store.appendLog(decisionEntry(i, "obtener información"));
			store.appendLog(resultEntry(i, "info"));
		}
		const out = formatLogTail(store.readLogIndexed(), null);
		assert.match(out, /^Log \(3 entradas\):/);
		assert.match(out, /iter 0\s/);
		assert.match(out, /iter 2\s/);
	});

	it("limit mayor que el historial no falla ni miente en la cabecera", () => {
		const store = newStore("aies-log-tail-over-");
		store.appendLog(decisionEntry(0, "obtener información"));
		store.appendLog(resultEntry(0, "info"));
		const out = formatLogTail(store.readLogIndexed(), 999);
		assert.match(out, /^Log \(1 entradas\):/);
		assert.doesNotMatch(out, /últimas/);
	});
});

// ── /trace: Tool trace (v0.5 Caja de cristal) ─────────────────────────────────

function toolEntry(overrides: Partial<import("./observability.js").ToolTraceLogEntry> = {}): import("./observability.js").ToolTraceLogEntry {
	return {
		type: "tool",
		iter: 2,
		unidadId: "U1",
		capacidad: "explorer",
		herramienta: "read",
		args: { path: "src/a.ts" },
		target: "src/a.ts",
		archivos_leidos: ["src/a.ts"],
		archivos_modificados: [],
		resumen: "40 líneas",
		detalle: "…",
		error: false,
		ts: "2026-09-05T10:00:00.000Z",
		...overrides,
	};
}

describe("/trace — formatToolTrace", () => {
	it("las entradas tool sobreviven al round-trip por LocalStore", () => {
		const store = newStore("aies-trace-roundtrip-");
		store.appendLog(toolEntry());
		const back = store.readLogIndexed();
		assert.equal(back.length, 1);
		assert.equal(back[0]!.entry.type, "tool");
	});

	it('no contamina "/log" (sólo vueltas y compaction)', () => {
		const store = newStore("aies-trace-log-clean-");
		store.appendLog(decisionEntry(0, "obtener información"));
		store.appendLog(resultEntry(0, "info"));
		store.appendLog(toolEntry());
		const out = formatLogTail(store.readLogIndexed(), null);
		assert.match(out, /^Log \(1 entradas\):/);
		assert.doesNotMatch(out, /read/);
	});

	it("agrupa por unidad y muestra herramienta, target, resumen y modificación", () => {
		const store = newStore("aies-trace-group-");
		store.appendLog(toolEntry());
		store.appendLog(toolEntry({ unidadId: "U2", capacidad: "implementer", iter: 3, herramienta: "edit", target: "src/b.ts", args: { path: "src/b.ts" }, archivos_modificados: ["src/b.ts"], archivos_leidos: [], resumen: "aplicado" }));
		const out = formatToolTrace(store.readLogIndexed());
		assert.match(out, /^Traza de tools \(2\):/);
		assert.match(out, /● U1 · explorer · iter 2/);
		assert.match(out, /● U2 · implementer · iter 3/);
		assert.match(out, /✓ read\s+src\/a\.ts\s+40 líneas/);
		assert.match(out, /✓ edit\s+src\/b\.ts\s+aplicado\s+→ modifica src\/b\.ts/);
	});

	it("filtra por unidad y reporta vacío explícito", () => {
		const store = newStore("aies-trace-filter-");
		store.appendLog(toolEntry());
		store.appendLog(toolEntry({ unidadId: "U2" }));
		const out = formatToolTrace(store.readLogIndexed(), "U2");
		assert.match(out, /unidad U2/);
		assert.match(out, /● U2/);
		assert.doesNotMatch(out, /● U1/);
		assert.match(formatToolTrace(store.readLogIndexed(), "U9"), /sin trazas de tools para la unidad "U9"/);
	});

	it("cuenta errores por unidad", () => {
		const store = newStore("aies-trace-err-");
		store.appendLog(toolEntry({ herramienta: "bash", target: "pnpm tsc", resumen: "error TS2345", error: true }));
		const out = formatToolTrace(store.readLogIndexed());
		assert.match(out, /● U1 · explorer · iter 2\s+\(1 error\)/);
		assert.match(out, /✗ bash/);
	});

	it("parseTraceArg: sin arg → null; 'all' → null; unidad → unidad", () => {
		assert.equal(parseTraceArg(""), null);
		assert.equal(parseTraceArg("all"), null);
		assert.equal(parseTraceArg("U2"), "U2");
	});
});
