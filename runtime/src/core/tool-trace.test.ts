// src/core/tool-trace.test.ts — Tool trace (v0.5 Caja de cristal): args relevantes, resúmenes,
// archivos afectados y emparejamiento call↔result del recorder.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	affectedFiles,
	capDetalle,
	createToolTraceRecorder,
	relevantArgs,
	summarizeToolResult,
	toolTarget,
	truncate,
	type ToolTraceRecord,
} from "./tool-trace.js";

describe("relevantArgs", () => {
	it("mantiene escalares y paths completos truncados", () => {
		const out = relevantArgs({ path: "src/a.ts", offset: 10, recursive: true });
		assert.deepEqual(out, { path: "src/a.ts", offset: 10, recursive: true });
	});

	it("resume payloads textuales voluminosos a '<N líneas>' sin volcar contenido", () => {
		const out = relevantArgs({ path: "x.ts", content: "a\nb\nc" });
		assert.equal(out.content, "<3 líneas>");
		assert.equal(out.path, "x.ts");
	});

	it("recorta strings largos con elipsis y descarta objetos anidados", () => {
		const long = "x".repeat(500);
		const out = relevantArgs({ command: long, nested: { a: 1 }, fn: () => 1 });
		assert.equal(typeof out.command, "string");
		assert.ok((out.command as string).length <= 200);
		assert.ok(!("nested" in out));
		assert.ok(!("fn" in out));
	});

	it("conserva arrays de strings (acotados)", () => {
		const out = relevantArgs({ paths: ["a.ts", "b.ts"] });
		assert.deepEqual(out.paths, ["a.ts", "b.ts"]);
	});
});

describe("toolTarget", () => {
	it("prefiere path sobre resto de candidatos", () => {
		assert.equal(toolTarget({ path: "p/q.ts", command: "ls" }), "p/q.ts");
	});

	it("cae a command/pattern si no hay path", () => {
		assert.equal(toolTarget({ command: "pnpm test" }), "pnpm test");
		assert.equal(toolTarget({ pattern: "foo" }), "foo");
		assert.equal(toolTarget({ unrelated: 1 }), null);
	});
});

describe("affectedFiles", () => {
	it("write/edit declaran archivo modificado", () => {
		assert.deepEqual(affectedFiles("edit", { path: "a/b.ts" }), { leidos: [], modificados: ["a/b.ts"] });
	});

	it("read/grep declaran archivo leído", () => {
		assert.deepEqual(affectedFiles("read", { path: "a/b.ts" }), { leidos: ["a/b.ts"], modificados: [] });
	});

	it("bash no declara archivos", () => {
		assert.deepEqual(affectedFiles("bash", { command: "rm -f x" }), { leidos: [], modificados: [] });
	});
});

describe("summarizeToolResult", () => {
	it("read: cuenta líneas", () => {
		assert.equal(summarizeToolResult("read", "1\n2\n3", false), "3 líneas");
	});

	it("grep/find: cuenta coincidencias no vacías", () => {
		assert.equal(summarizeToolResult("grep", "a\n\nb\nc", false), "3 coincidencias");
	});

	it("edit/write: 'aplicado'", () => {
		assert.equal(summarizeToolResult("write", "ok wrote file", false), "aplicado");
	});

	it("bash: primera línea + conteo", () => {
		assert.equal(summarizeToolResult("bash", "hello\nmundo", false), "hello (2 líneas)");
	});

	it("resultado vacío: '(vacío)'", () => {
		assert.equal(summarizeToolResult("ls", "", false), "(vacío)");
	});

	it("error: mensaje truncado en una línea", () => {
		const s = summarizeToolResult("bash", "Error: exit 2\nstack\ntrace", true);
		assert.match(s, /^Error: exit 2 stack trace$/);
	});
});

describe("capDetalle", () => {
	it("conserva el resultado tal cual si cabe en el máximo", () => {
		assert.equal(capDetalle("hola\nmundo"), "hola\nmundo");
	});

	it("recorta resultados largos conservando cabecera y cola con marca de omisión", () => {
		const big = "A".repeat(10000);
		const capped = capDetalle(big, 100);
		assert.ok(capped.startsWith("A"));
		assert.ok(capped.endsWith("A"));
		assert.ok(capped.length <= 112);
		assert.match(capped, /… \[\d+ chars\]/);
	});
});

describe("truncate", () => {
	it("colapsa espacios y añade elipsis al exceder", () => {
		assert.equal(truncate("hola   mundo", 100), "hola mundo");
		assert.equal(truncate("a".repeat(12), 10).length, 10);
	});
});

describe("createToolTraceRecorder", () => {
	function collect(): { emit: (r: ToolTraceRecord) => void; out: ToolTraceRecord[] } {
		const out: ToolTraceRecord[] = [];
		return { emit: (r) => out.push(r), out };
	}

	it("empareja call↔result FIFO por unidad+tool y produce un registro completo", () => {
		const { emit, out } = collect();
		const rec = createToolTraceRecorder(emit);
		rec.noteIteration(3);
		rec.noteUnit("U1", "implementer");
		rec.onToolCall("U1", "edit", { path: "src/a.ts", new_text: "x\ny" });
		rec.onToolResult("U1", "edit", "applied 2 lines", false);
		assert.equal(out.length, 1);
		assert.deepEqual(out[0], {
			unidadId: "U1",
			capacidad: "implementer",
			iter: 3,
			herramienta: "edit",
			args: { path: "src/a.ts", new_text: "<2 líneas>" },
			target: "src/a.ts",
			leidos: [],
			modificados: ["src/a.ts"],
			resumen: "aplicado",
			detalle: "applied 2 lines",
			error: false,
			ts: out[0]!.ts,
		});
	});

	it("distingue resultados concurrentes del mismo tool por orden FIFO", () => {
		const { emit, out } = collect();
		const rec = createToolTraceRecorder(emit);
		rec.onToolCall("U1", "read", { path: "a.ts" });
		rec.onToolCall("U1", "read", { path: "b.ts" });
		rec.onToolResult("U1", "read", "1\n2", false);
		rec.onToolResult("U1", "read", "1\n2\n3", false);
		assert.equal(out[0]!.target, "a.ts");
		assert.equal(out[0]!.resumen, "2 líneas");
		assert.equal(out[1]!.target, "b.ts");
		assert.equal(out[1]!.resumen, "3 líneas");
	});

	it("no cruza unidades ni tools", () => {
		const { emit, out } = collect();
		const rec = createToolTraceRecorder(emit);
		rec.onToolCall("U1", "bash", { command: "ls" });
		rec.onToolCall("U2", "read", { path: "x.ts" });
		rec.onToolResult("U2", "read", "a\nb", false);
		rec.onToolResult("U1", "bash", "f1\nf2\nf3", false);
		assert.equal(out[0]!.unidadId, "U2");
		assert.equal(out[0]!.herramienta, "read");
		assert.equal(out[1]!.unidadId, "U1");
		assert.match(out[1]!.resumen, /^f1 \(3 líneas\)$/);
	});

	it("un result huérfano (sin call) registra con args vacíos sin lanzar", () => {
		const { emit, out } = collect();
		const rec = createToolTraceRecorder(emit);
		rec.onToolResult("U1", "grep", "x", true);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.target, null);
		assert.equal(out[0]!.error, true);
		assert.equal(out[0]!.capacidad, null);
	});

	it("un emitente que lanza no rompe el recorder (bus fire-and-forget)", () => {
		const rec = createToolTraceRecorder(() => {
			throw new Error("consumer roto");
		});
		rec.onToolCall("U1", "read", { path: "a" });
		assert.doesNotThrow(() => rec.onToolResult("U1", "read", "x", false));
	});
});
