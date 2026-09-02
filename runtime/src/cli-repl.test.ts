// src/cli-repl.test.ts — contrato del input del REPL (TUI fix).
//
// Bug original: `rl.question()` resolvía con la PRIMERA línea de un paste
// multi-línea, mientras las líneas restantes llegaban después como eventos
// `line` que el listener de intervención (`runTrackedReplCycle`) capturaba
// como `⚑ tú (intervención)`. El orquestador empezaba a procesar un fragmento
// del mensaje antes de que el usuario pulsase Enter.
//
// Contrato que estos tests garantizan:
//   1. Escribir texto NO llama al orquestador.
//   2. Pegar texto largo NO llama al orquestador.
//   3. Escribir varias líneas NO llama al orquestador.
//   4. Pulsar Enter llama al orquestador exactamente una vez.
//   5. El mensaje recibido coincide exactamente con el texto enviado.
//   6. Los fragmentos del mensaje NO aparecen como intervenciones.
//   7. ESC NO envía el contenido parcial.
//   8. Ctrl+C mantiene el comportamiento existente.
//
// Nota sobre la simulación de Enter:
//   La señal real de "Enter" en producción es un `\r` standalone en el input
//   crudo (la tecla Enter envía CR; CRLF de paste NO cuenta). Los tests
//   simulan esto con `input.write("\r")`. Esto refleja exactamente lo que
//   hace la TUI real — el contrato es: `\r` = Enter, `\n` = contenido.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "vitest";
import * as readline from "node:readline/promises";

import { readPromptLine } from "./cli.js";

type Harness = {
	rl: readline.Interface;
	input: PassThrough;
	outputText: () => string;
	lineSpy: string[];
};

function makeHarness(): Harness {
	const input = new PassThrough();
	const output = new PassThrough();
	let outBuf = "";
	output.on("data", (chunk: Buffer | string) => {
		outBuf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	});
	// terminal:false ⇒ readline no aplica edición ni emite keypress; aquí
	// sólo queremos verificar el contrato de "qué cuenta como Enter y qué
	// como contenido". El path real (terminal:true) usa el mismo `onData`
	// sobre el stream de stdin.
	const rl = readline.createInterface({ input, output, terminal: false });

	const lineSpy: string[] = [];
	rl.on("line", (line) => lineSpy.push(line));

	return {
		rl,
		input,
		outputText: () => outBuf,
		lineSpy,
	};
}

/** Resuelve con el valor de `promise` si se asienta antes de `timeoutMs`;
 *  con `undefined` si el timeout expira (readPromptLine sigue pendiente). */
function settle<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	return new Promise<T | undefined>((resolveOuter) => {
		let done = false;
		const timer = setTimeout(() => {
			if (done) return;
			done = true;
			resolveOuter(undefined);
		}, timeoutMs);
		promise.then(
			(v) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolveOuter(v);
			},
			() => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolveOuter(undefined);
			},
		);
	});
}

const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

const ENTER = "\r";

// ──────────────────────────────────────────────────────────────────────────────
// 1+2+3. Escribir, pegar (largo), escribir varias líneas NO dispara el
//        orquestador — sólo Enter lo hace.
// ──────────────────────────────────────────────────────────────────────────────

describe("readPromptLine — la edición NO invoca al orquestador", () => {
	it("texto plano sin Enter: readPromptLine sigue pendiente", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("hola mundo");
		await tick(80);
		const result = await settle(promise, 80);
		assert.equal(result, undefined, "sin Enter: readPromptLine no debe resolver");
		h.rl.close();
	});

	it("paste largo multi-línea sin Enter posterior: readPromptLine sigue pendiente", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "� ");
		h.input.write("línea 1\nlínea 2\nlínea 3\nlínea 4\nlínea 5\n");
		await tick(80);
		const result = await settle(promise, 80);
		assert.equal(result, undefined, "paste sin Enter posterior: readPromptLine no debe resolver");
		h.rl.close();
	});

	it("escribir varias líneas (con \\n embebidos) sin Enter: pendiente", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("uno\ndos\ntres\n");
		await tick(80);
		const result = await settle(promise, 80);
		assert.equal(result, undefined, "\\n embebidos NO son Enter");
		h.rl.close();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// 4+5. Pulsar Enter dispara el orquestador EXACTAMENTE UNA vez y el contenido
//      coincide con el texto enviado (con \\n preservados).
// ──────────────────────────────────────────────────────────────────────────────

describe("readPromptLine — pulsar Enter resuelve UNA vez con el contenido completo", () => {
	it("línea única + Enter: resuelve con esa línea exacta", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("hola mundo");
		h.input.write(ENTER);
		const result = await settle(promise, 500);
		assert.equal(result, "hola mundo");
		h.rl.close();
	});

	it("paste multi-línea + Enter: contenido íntegro con \\n preservados", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("línea 1\nlínea 2\nlínea 3\n");
		h.input.write(ENTER);
		const result = await settle(promise, 500);
		assert.equal(result, "línea 1\nlínea 2\nlínea 3");
		h.rl.close();
	});

	it("paste + Enter del usuario: el contenido final NO incluye el \\r del Enter", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("line1\nline2\n");
		h.input.write(ENTER);
		const result = await settle(promise, 500);
		assert.equal(result, "line1\nline2");
		h.rl.close();
	});

	it("Enter vacío: resuelve con string vacío (lo trata el caller como no-tarea)", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write(ENTER);
		const result = await settle(promise, 500);
		assert.equal(result, "");
		h.rl.close();
	});

	it("dos envíos sucesivos (dos Enters) producen dos resoluciones independientes", async () => {
		const h = makeHarness();
		const p1 = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("primero");
		h.input.write(ENTER);
		const r1 = await settle(p1, 500);
		assert.equal(r1, "primero");

		const p2 = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("segundo");
		h.input.write(ENTER);
		const r2 = await settle(p2, 500);
		assert.equal(r2, "segundo");

		h.rl.close();
	});
});

describe("readPromptLine — non-TTY es determinista", () => {
	it("resuelve una línea de pipe con LF, sin exigir CR de terminal", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ", { resolveOnLine: true });
		h.input.write("/\n");
		assert.equal(await settle(promise, 500), "/");
		h.rl.close();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// 6. Fragmentos del mensaje NO aparecen como `line` events durante el run.
// ──────────────────────────────────────────────────────────────────────────────

describe("readPromptLine — fragmentos del mensaje no son eventos sueltos", () => {
	it("paste multi-línea + Enter: cada fragmento entra al contenido resuelto, ninguno se filtra al spy como evento suelto tras Enter", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("a\nb\nc\nd\ne\n");
		h.input.write(ENTER);
		const result = await settle(promise, 500);
		assert.equal(result, "a\nb\nc\nd\ne");
		// Tras Enter + resolución, ningún evento `line` adicional queda en el
		// buffer que un hipotético listener de intervención pudiese capturar.
		const interventionSpy: string[] = [];
		h.rl.on("line", (line) => interventionSpy.push(line));
		await tick(60);
		assert.equal(interventionSpy.length, 0, "tras Enter+resolución, no llega contenido residual al listener de intervención");
		h.rl.close();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// 7. ESC NO envía el contenido parcial.
// ──────────────────────────────────────────────────────────────────────────────

describe("readPromptLine — ESC no envía el contenido parcial", () => {
	it("ESC tras contenido parcial: la promesa no resuelve con ese contenido", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("contenido parcial");
		// ESC (\x1b) no es \r y no es line-ending → no dispara Enter ni resolución.
		h.input.write("\x1b");
		await tick(60);
		const result = await settle(promise, 60);
		assert.equal(result, undefined, "ESC no debe resolver readPromptLine con contenido parcial");
		h.rl.close();
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// 8. Ctrl+C mantiene el comportamiento existente: cierra el stream y rechaza.
// ──────────────────────────────────────────────────────────────────────────────

describe("readPromptLine — Ctrl+C cierra el stream y rechaza", () => {
	it("rl.close() (lo que hace el handler SIGINT existente): la promesa rechaza, no resuelve con contenido parcial", async () => {
		const h = makeHarness();
		const promise = readPromptLine(h.rl, h.input, "❯ ");
		h.input.write("a medio escribir");
		// Simulamos el comportamiento del handler SIGINT actual: rl.close().
		h.rl.close();
		await assert.rejects(promise, /readline closed/);
	});
});
