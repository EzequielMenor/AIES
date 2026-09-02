import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "vitest";

import { buildSearchPickerLines, filterSearch, PromptUI, type SearchPickerItem } from "./prompt-ui.js";

function makeTTYStreams(): { input: PassThrough; output: PassThrough; outputText: () => string; writeInput: (s: string) => void } {
	const input = new PassThrough();
	const output = new PassThrough();
	let buf = "";
	output.on("data", (chunk) => {
		buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	});
	// Truco: PassThrough.isTTY es false por defecto. Lo forzamos a true para que PromptUI
	// considere la pareja tty→raw mode.
	(input as unknown as { isTTY: boolean }).isTTY = true;
	(output as unknown as { isTTY: boolean }).isTTY = true;
	(input as unknown as { setRawMode: (mode: boolean) => void }).setRawMode = (_mode: boolean) => undefined;
	return {
		input,
		output,
		outputText: () => buf,
		writeInput: (s) => input.write(s),
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Filtro y redraw — non-interactive.
// ──────────────────────────────────────────────────────────────────────────────

describe("command palette — filter (non-interactive)", () => {
	it("filterSearch es case-insensitive y matchea label/id/description", () => {
		const items: SearchPickerItem<number>[] = [
			{ id: "login", label: "login", description: "conectar", value: 1 },
			{ id: "logout", label: "logout", description: "cerrar sesión", value: 2 },
			{ id: "model", label: "model", description: "elegir", value: 3 },
		];
		assert.deepEqual(filterSearch(items, "log").map((i) => i.id), ["login", "logout"]);
		assert.deepEqual(filterSearch(items, "ELEGIR").map((i) => i.id), ["model"]);
		assert.deepEqual(filterSearch(items, "").length, 3);
	});

	it("buildSearchPickerLines: cursor › visible, footer al final, vacío=list", () => {
		const items: SearchPickerItem<number>[] = [
			{ id: "a", label: "login", value: 1 },
			{ id: "b", label: "logout", value: 2 },
		];
		const lines = buildSearchPickerLines("Comandos", items, 0, "↑↓ · Enter · Esc");
		assert.equal(lines[0], "Comandos");
		assert.match(lines[1]!, /^  › login/);
		assert.match(lines[2]!, /^    logout/);
		assert.equal(lines.at(-1), "↑↓ · Enter · Esc");

		const empty = buildSearchPickerLines("Comandos", [], 0, "footer");
		assert.match(empty.join("\n"), /sin coincidencias/);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Picker TTY — input loop artificial.
// ──────────────────────────────────────────────────────────────────────────────

/** Helper: ejecuta searchSelect en background y empuja teclas después de un microtick. */
async function runPickerWithKeys(
	keys: string[],
	options?: { initialQuery?: string },
): Promise<{ prompt: PromptUI; resultPromise: Promise<unknown>; outputText: () => string }> {
	const streams = makeTTYStreams();
	const prompt = new PromptUI({ streams, prompt: "❯ " });
	const items: SearchPickerItem<number>[] = [
		{ id: "login", label: "login", description: "Conectar", value: 1 },
		{ id: "logout", label: "logout", description: "Cerrar sesión", value: 2 },
		{ id: "model", label: "model", description: "Elegir", value: 3 },
	];
	const resultPromise = prompt.searchSelect("Comandos", items, { initialQuery: options?.initialQuery });
	// Permite al picker pintar su bloque inicial ANTES de empujar las teclas.
	await new Promise<void>((r) => setImmediate(r));
	for (const chunk of keys) streams.input.write(chunk);
	return { prompt, resultPromise, outputText: streams.outputText };
}

describe("command palette — picker TTY", () => {
	it("Filtrar y pulsar Enter devuelve el ítem correcto", async () => {
		const { resultPromise } = await runPickerWithKeys(["l", "o", "g", "o", "u", "t", "\r"]);
		const r = await resultPromise;
		assert.deepEqual(r, { kind: "selected", value: 2 });
	});

	it("Esc cancela sin seleccionar", async () => {
		const { resultPromise } = await runPickerWithKeys(["\u001b"]);
		const r = await resultPromise;
		assert.deepEqual(r, { kind: "cancelled", value: null });
	});

	it("Filtrar en vivo actualiza el mismo bloque sin acumular líneas", async () => {
		const { resultPromise, outputText } = await runPickerWithKeys(["l", "o", "g", "\r"]);
		const r = await resultPromise;
		// log coincide con login y logout; ambos empiezan por log. Esperar login (value=1).
		assert.deepEqual(r, { kind: "selected", value: 1 });
		const text = outputText();
		const cursorSaves = (text.match(/\x1b7/g) ?? []).length;
		const clears = (text.match(/\x1b\[2K/g) ?? []).length;
		assert.ok(cursorSaves >= 4, `debería redraw varias veces — got ${cursorSaves}`);
		assert.ok(clears >= 4, `debería limpiar celdas cada update — got ${clears}`);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Repeated slash — no listener accumulation.
// ──────────────────────────────────────────────────────────────────────────────

describe("command palette — repeated slash no acumula listeners", () => {
	it("20 iteraciones de / + Esc no multiplican listeners en stdin", async () => {
		const streams = makeTTYStreams();
		const prompt = new PromptUI({ streams, prompt: "❯ " });
		const items: SearchPickerItem<number>[] = [
			{ id: "a", label: "a", value: 1 },
			{ id: "b", label: "b", value: 2 },
		];

		const startListeners = (streams.input as unknown as { listenerCount: (k: string) => number }).listenerCount("data");

		for (let i = 0; i < 20; i += 1) {
			const rPromise = prompt.searchSelect("c", items, {});
			await new Promise<void>((r) => setImmediate(r));
			streams.input.write("\u001b");
			const r = await rPromise;
			assert.equal(r.kind, "cancelled");
		}

		const afterListeners = (streams.input as unknown as { listenerCount: (k: string) => number }).listenerCount("data");
		assert.equal(afterListeners, startListeners, `listeners 'data' sobre stdin no deben acumular — start=${startListeners} after=${afterListeners}`);
	});

	it("20 iteraciones de selección producen 20 títulos 'Comandos' sin multiplicar output persistente", async () => {
		const streams = makeTTYStreams();
		const prompt = new PromptUI({ streams, prompt: "❯ " });
		const items: SearchPickerItem<number>[] = [
			{ id: "a", label: "a", value: 1 },
		];

		for (let i = 0; i < 20; i += 1) {
			const rPromise = prompt.searchSelect("Comandos", items, {});
			await new Promise<void>((r) => setImmediate(r));
			streams.input.write("\r");
			const r = await rPromise;
			assert.deepEqual(r, { kind: "selected", value: 1 });
		}

		const text = streams.outputText();
		const promptCount = (text.match(/Comandos\n/g) ?? []).length;
		assert.equal(promptCount, 20, `exactamente 20 títulos 'Comandos' — got ${promptCount}`);
	});
});

async function makePicker(s?: ReturnType<typeof makeTTYStreams>): Promise<{
	prompt: PromptUI;
	resultPromise: Promise<unknown>;
}> {
	const streams = s ?? makeTTYStreams();
	const prompt = new PromptUI({ streams, prompt: "❯ " });
	const items: SearchPickerItem<number>[] = [
		{ id: "a", label: "a", value: 1 },
		{ id: "b", label: "b", value: 2 },
	];
	const resultPromise = prompt.searchSelect("c", items, {});
	await new Promise<void>((r) => setImmediate(r));
	return { prompt, resultPromise };
}

// ──────────────────────────────────────────────────────────────────────────────
// Non-TTY
// ──────────────────────────────────────────────────────────────────────────────

describe("command palette — non-TTY es line-oriented", () => {
	function makeNonTTYStreams(): { input: PassThrough; output: PassThrough; outputText: () => string } {
		const input = new PassThrough();
		const output = new PassThrough();
		let buf = "";
		output.on("data", (chunk) => {
			buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		});
		return { input, output, outputText: () => buf };
	}

	it("searchSelect sin TTY no imprime ANSI y devuelve 'cancelled' si no hay candidatos", async () => {
		const streams = makeNonTTYStreams();
		const prompt = new PromptUI({ streams, prompt: "❯ " });
		const items: SearchPickerItem<number>[] = [{ id: "x", label: "x", value: 1 }];
		const resultPromise = prompt.searchSelect("Título", items, { initialQuery: "no-match" });
		// No hay número posible — debe resolver a cancelled sin pedir más input.
		const r = await resultPromise;
		assert.deepEqual(r, { kind: "cancelled", value: null });
		assert.doesNotMatch(streams.outputText(), /\x1b/);
	});

	it("searchSelect sin TTY acepta número", async () => {
		const streams = makeNonTTYStreams();
		const prompt = new PromptUI({ streams, prompt: "❯ " });
		const items: SearchPickerItem<number>[] = [
			{ id: "x", label: "X", value: 1 },
			{ id: "y", label: "Y", value: 2 },
		];
		const resultPromise = prompt.searchSelect("Título", items, {});
		setImmediate(() => streams.input.write("2\n"));
		const r = await resultPromise;
		assert.deepEqual(r, { kind: "selected", value: 2 });
		assert.doesNotMatch(streams.outputText(), /\x1b/);
	});
});
