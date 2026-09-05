// src/observability.test.ts — forma de las entradas de log.jsonl (v0.5: traza de tools).

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { serializeEntry, toolTraceEntry, type LogEntry } from "./observability.js";
import type { ToolTraceRecord } from "./core/tool-trace.js";

const RECORD: ToolTraceRecord = {
	unidadId: "U2",
	capacidad: "implementer",
	iter: 3,
	herramienta: "edit",
	args: { path: "src/a.ts", new_text: "<5 líneas>" },
	target: "src/a.ts",
	leidos: [],
	modificados: ["src/a.ts"],
	resumen: "aplicado",
	detalle: "applied",
	error: false,
	ts: "2026-09-05T10:00:00.000Z",
};

describe("toolTraceEntry", () => {
	it("proyecta el registro completo a la entrada `type:tool` de log.jsonl", () => {
		const entry = toolTraceEntry(RECORD);
		assert.equal(entry.type, "tool");
		assert.equal(entry.unidadId, "U2");
		assert.equal(entry.capacidad, "implementer");
		assert.equal(entry.herramienta, "edit");
		assert.deepEqual(entry.args, RECORD.args);
		assert.deepEqual(entry.archivos_modificados, ["src/a.ts"]);
		assert.deepEqual(entry.archivos_leidos, []);
		assert.equal(entry.resumen, "aplicado");
		assert.equal(entry.error, false);
		assert.equal(entry.ts, RECORD.ts);
	});

	it("serializa a una única línea JSON válida", () => {
		const line = serializeEntry(toolTraceEntry(RECORD) as LogEntry);
		assert.ok(!line.includes("\n"));
		const back = JSON.parse(line);
		assert.equal(back.herramienta, "edit");
	});
});
