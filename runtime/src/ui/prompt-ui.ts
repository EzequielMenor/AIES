// src/ui/prompt-ui.ts — abstracción mínima para UI interactiva transitoria.
//
// Filosofía:
//   - No es un framework TUI. No usa alternate screen, no es fullscreen, no oculta el scrollback.
//   - El Agent Stream (StreamRenderer) sigue siendo la verdad persistente; esto es SOLO
//     la capa que vive justo encima del prompt y desaparece al cerrarse.
//   - Cada método que pinta bajo el prompt (transient/info) sabe cuántas líneas ha escrito
//     y puede borrarlas deterministamente con ANSI. El Agent Stream NO depende de esto.
//   - Non-TTY cae a su equivalente line-oriented: imprime texto plano y pregunta vía stdin.
//
// TTY gating:
//   `isTTY()` se evalúa UNA vez en el constructor — toda la instancia es coherente.

import * as readline from "node:readline/promises";
import { emitKeypressEvents, type Key } from "node:readline";

export interface PromptStreams {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
}

export interface PromptUIOptions {
	streams: PromptStreams;
	prompt: string;
	columns?: number | undefined;
}

export interface PaletteItem {
	readonly label: string;
	readonly description: string;
	readonly token: string;
}

export interface SearchPickerItem<T> {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	readonly hint?: string;
	readonly value: T;
}

export interface SearchPickerResult<T> {
	kind: "selected" | "cancelled";
	value: T | null;
}

export interface SelectResult<T> {
	kind: "selected" | "cancelled";
	value: T | null;
}

/** Detecta TTY tanto en real-stdin (CreateIfIOTty) como en streams sintéticos de tests. */
function isStdioTTY(stream: NodeJS.ReadableStream | NodeJS.WritableStream): boolean {
	const tty = (stream as NodeJS.ReadStream | NodeJS.WriteStream).isTTY;
	return Boolean(tty);
}

function stripCRLF(s: string): string {
	return s.replace(/\r\n$/, "").replace(/\r$/, "");
}

export class PromptUI {
	readonly #streams: PromptStreams;
	readonly #prompt: string;
	readonly #tty: boolean;
	readonly #columns: number;
	constructor(opts: PromptUIOptions) {
		this.#streams = opts.streams;
		this.#prompt = opts.prompt;
		this.#tty = isStdioTTY(opts.streams.input) && isStdioTTY(opts.streams.output);
		this.#columns = opts.columns ?? process.stdout.columns ?? 80;
	}

	get isTTY(): boolean {
		return this.#tty;
	}

	/**
	 * Lee UNA línea del prompt. En TTY usa readline (con la edición estándar); en pipe lee
	 * directamente del stream bloqueante hasta primer `\n`/EOF.
	 */
	async readLine(): Promise<string> {
		if (!this.#tty) return this.#readLineFromPipe();
		const rl = readline.createInterface({
			input: this.#streams.input,
			output: this.#streams.output,
			terminal: true,
		});
		emitKeypressEvents(this.#streams.input as NodeJS.ReadStream);
		try {
			const line = await rl.question(this.#prompt);
			return stripCRLF(line);
		} finally {
			rl.close();
		}
	}

	#readLineFromPipe(): Promise<string> {
		return new Promise<string>((resolve) => {
			const stream = this.#streams.input as NodeJS.ReadableStream;
			const onData = (chunk: Buffer | string) => {
				stream.removeListener("data", onData);
				stream.removeListener("end", onEnd);
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				resolve(stripCRLF(text));
			};
			const onEnd = () => {
				stream.removeListener("data", onData);
				stream.removeListener("end", onEnd);
				resolve("");
			};
			stream.on("data", onData);
			stream.on("end", onEnd);
			if (typeof (stream as NodeJS.ReadStream).resume === "function") {
				(stream as NodeJS.ReadStream).resume();
			}
		});
	}

	/**
	 * Picker con filtro vivo y navegación ↑↓. TTY = redibujo en sitio; non-TTY = numerado.
	 *
	 * No usa readline para evitar el conflicto entre su editor de línea y nuestro bloque
	 * transitorio bajo el prompt. Maneja su propia edición de la query en raw mode.
	 */
	async searchSelect<T>(
		title: string,
		items: readonly SearchPickerItem<T>[],
		opts: {
			initialQuery?: string | undefined;
			footer?: string | undefined;
			header?: ((item: SearchPickerItem<T>) => string) | undefined;
			renderHint?: ((item: SearchPickerItem<T>) => string | undefined) | undefined;
		} = {},
	): Promise<SearchPickerResult<T>> {
		if (!this.#tty) return this.#searchSelectNonTTY(title, items, opts.initialQuery);
		return this.#searchSelectTTY(title, items, opts);
	}

	/** Wrapper para non-TTY. Mantenido determinista — sin ANSI, sin teclas. */
	async #searchSelectNonTTY<T>(
		title: string,
		items: readonly SearchPickerItem<T>[],
		query: string | undefined,
	): Promise<SearchPickerResult<T>> {
		const out = this.#streams.output;
		const filtered = filterSearch(items, query ?? "");
		out.write(`${title}\n`);
		for (const [index, item] of filtered.entries()) {
			const desc = item.description ? ` — ${item.description}` : "";
			out.write(`  ${index + 1}) ${item.label}${desc}\n`);
		}
		if (filtered.length === 0) {
			out.write("  (sin coincidencias)\n");
			return { kind: "cancelled", value: null };
		}
		const rl = readline.createInterface({
			input: this.#streams.input,
			output: this.#streams.output,
			terminal: false,
		});
		try {
			const answer = stripCRLF(await rl.question("número o vacío para cancelar: "));
			const trimmed = answer.trim();
			if (!trimmed) return { kind: "cancelled", value: null };
			const n = Number(trimmed);
			if (Number.isInteger(n) && n >= 1 && n <= filtered.length) {
				return { kind: "selected", value: filtered[n - 1]!.value };
			}
			const lower = trimmed.toLowerCase();
			const exact = items.find((item) => item.id.toLowerCase() === lower);
			return exact ? { kind: "selected", value: exact.value } : { kind: "cancelled", value: null };
		} finally {
			rl.close();
		}
	}

	/**
	 * Implementación TTY: raw mode sobre stdin, sin readline.
	 *
	 * Layout vertical (todo debajo del prompt):
	 *   ❯ <query>
	 *   <title>
	 *   › <label>  <description>  <hint>
	 *     <label>  <description>  <hint>
	 *     …
	 *   <footer>
	 *
	 * El bloque bajo el prompt (todo lo que NO es la línea `❯ …`) está delimitado por
	 * `lastBlockLines`. Al cerrarse, clearBlock() lo borra exactamente.
	 */
	async #searchSelectTTY<T>(
		title: string,
		items: readonly SearchPickerItem<T>[],
		opts: {
			initialQuery?: string | undefined;
			footer?: string | undefined;
			header?: ((item: SearchPickerItem<T>) => string) | undefined;
			renderHint?: ((item: SearchPickerItem<T>) => string | undefined) | undefined;
		},
	): Promise<SearchPickerResult<T>> {
		const out = this.#streams.output as NodeJS.WriteStream;
		const inp = this.#streams.input as NodeJS.ReadStream;
		const initialQuery = opts.initialQuery ?? "";
		const footer = opts.footer ?? "↑↓ navegar · Enter seleccionar · Esc cancelar";
		const header = opts.header;
		const renderHint = opts.renderHint;

		const stdinWasRaw = inp.isRaw ?? false;
		const promptLine = this.#prompt;

		let filtered: SearchPickerItem<T>[] = filterSearch(items, initialQuery);
		let cursor = 0;
		let query = initialQuery;
		let lastBlockLines = 0;
		let settled = false;
		let resolveFn: ((value: SearchPickerResult<T>) => void) | null = null;
		let pending = "";

		const finish = (result: SearchPickerResult<T>) => {
			if (settled) return;
			settled = true;
			resolveFn?.(result);
		};

		const clearBlock = () => {
			if (lastBlockLines <= 0) return;
			out.write(`\x1b7`);
			out.write(`\x1b[1B`);
			for (let i = 0; i < lastBlockLines; i += 1) {
				out.write(`\x1b[2K`);
				if (i < lastBlockLines - 1) out.write(`\n`);
			}
			out.write(`\x1b[1A`);
			out.write(`\x1b8`);
			lastBlockLines = 0;
		};

		const writePromptLine = () => {
			out.write(`\r\x1b[2K${promptLine}${query}`);
		};

		const renderBlock = () => {
			clearBlock();
			const lines = buildSearchPickerLines(title, filtered, cursor, footer, renderHint);
			out.write(`\x1b7`);
			out.write(`\x1b[1B`);
			for (const line of lines) out.write(`${line}\n`);
			out.write(`\x1b8`);
			lastBlockLines = lines.length;
			writePromptLine();
		};

		const refreshAfterChange = () => {
			filtered = filterSearch(items, query);
			cursor = 0;
			renderBlock();
		};

		const navigate = (delta: number) => {
			if (filtered.length === 0) return;
			cursor = (cursor + delta + filtered.length) % filtered.length;
			renderBlock();
		};

		const handleCSI = (seq: string): boolean => {
			switch (seq) {
				case "\u001b[A": // up
					navigate(-1);
					return true;
				case "\u001b[B": // down
					navigate(1);
					return true;
				case "\u001b[H": // home
					cursor = 0;
					renderBlock();
					return true;
				case "\u001b[F": // end
					if (filtered.length > 0) cursor = filtered.length - 1;
					renderBlock();
					return true;
				default:
					return false;
			}
		};

		const onData = (chunk: Buffer | string) => {
			if (settled) return;
			pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			while (pending.length > 0) {
				if (pending[0] === "\u001b") {
					if (pending.length === 1) {
						pending = "";
						finish({ kind: "cancelled", value: null });
						return;
					}
					if (pending.length >= 3 && pending[2] === "~") {
						pending = pending.slice(3);
						continue;
					}
					if (pending.length >= 3) {
						const seq = pending.slice(0, 3);
						if (handleCSI(seq)) {
							pending = pending.slice(3);
							continue;
						}
						// Secuencia desconocida — descartamos el primer byte.
						pending = pending.slice(1);
						continue;
					}
					return;
				}
				const ch = pending[0]!;
				pending = pending.slice(1);
				switch (ch) {
					case "\r":
					case "\n":
						finish({ kind: "selected", value: filtered[cursor]?.value ?? null });
						return;
					case "\u0003":
						finish({ kind: "cancelled", value: null });
						return;
					case "\u007f":
					case "\b":
						if (query.length > 0) {
							query = query.slice(0, -1);
							refreshAfterChange();
						}
						continue;
					case "\t":
						navigate(1);
						continue;
					default:
						if (ch >= " " && ch <= "~") {
							query = `${query}${ch}`;
							refreshAfterChange();
							continue;
						}
						// Caracteres de control (< 0x20) que no manejamos: descartar.
						continue;
				}
			}
		};

		inp.setRawMode?.(true);
		inp.resume();
		inp.setEncoding("utf8");
		inp.on("data", onData);
		writePromptLine();
		renderBlock();

		try {
			const result = await new Promise<SearchPickerResult<T>>((resolve) => {
				resolveFn = resolve;
			});
			if (header) {
				const chosen = filtered[cursor];
				if (chosen) out.write(`\n${header(chosen)}\n`);
			}
			return result;
		} finally {
			inp.removeListener("data", onData);
			inp.setRawMode?.(stdinWasRaw);
			clearBlock();
			writePromptLine();
		}
	}

	/** Selector simple, sin filtro. Non-TTY cae a numerado. */
	async select<T>(title: string, items: readonly SearchPickerItem<T>[]): Promise<SelectResult<T>> {
		if (!this.#tty) {
			const result = await this.#searchSelectNonTTY(title, items, undefined);
			return { kind: result.kind === "selected" ? "selected" : "cancelled", value: result.value };
		}
		return this.#searchSelectTTY(title, items, {});
	}

	/** Lee un secreto: en TTY raw mode sin eco; en pipe lee primera línea. */
	async secret(message: string): Promise<string> {
		const out = this.#streams.output as NodeJS.WriteStream;
		const inp = this.#streams.input as NodeJS.ReadStream;
		out.write(`${message}: `);
		if (!this.#tty) return await this.#readLineFromPipe();
		const wasRaw = inp.isRaw ?? false;
		return await new Promise<string>((resolve, reject) => {
			let buf = "";
			const onData = (chunk: Buffer | string) => {
				const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
				for (const ch of text) {
					if (ch === "\r" || ch === "\n") {
						inp.removeListener("data", onData);
						inp.setRawMode?.(wasRaw);
						out.write("\n");
						resolve(buf);
						return;
					}
					if (ch === "\u0003") {
						inp.removeListener("data", onData);
						inp.setRawMode?.(wasRaw);
						out.write("\n");
						reject(new Error("cancelado"));
						return;
					}
					if (ch === "\u007f" || ch === "\b") {
						if (buf.length > 0) buf = buf.slice(0, -1);
						continue;
					}
					buf += ch;
				}
			};
			inp.setRawMode?.(true);
			inp.resume();
			inp.setEncoding("utf8");
			inp.on("data", onData);
		});
	}

	/** Mensaje estable en el Agent Stream (no es transitorio). */
	info(line: string): void {
		this.#streams.output.write(`${line}\n`);
	}

	/** Acceso explícito a los streams — usado por `runTrackedReplCycle` para instalar
	 *  listeners de keypress sin tocar el readline efímero. */
	streams(): PromptStreams {
		return this.#streams;
	}

	/** readline efímero — usado durante el ciclo de intervención. El caller es responsable
	 *  de cerrarlo. */
	createReadline(): readline.Interface {
		return readline.createInterface({
			input: this.#streams.input,
			output: this.#streams.output,
			terminal: this.#tty,
			escapeCodeTimeout: 50,
		});
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers exportados — separados para tests directos.
// ──────────────────────────────────────────────────────────────────────────────

export function filterSearch<T>(items: readonly SearchPickerItem<T>[], query: string): SearchPickerItem<T>[] {
	const q = query.trim().toLowerCase();
	if (!q) return [...items];
	return items.filter(
		(item) =>
			item.label.toLowerCase().includes(q) ||
			item.id.toLowerCase().includes(q) ||
			(item.description?.toLowerCase().includes(q) ?? false),
	);
}

export function buildSearchPickerLines<T>(
	title: string,
	filtered: readonly SearchPickerItem<T>[],
	cursor: number,
	footer: string,
	renderHint?: ((item: SearchPickerItem<T>) => string | undefined) | undefined,
): string[] {
	const lines: string[] = [];
	lines.push(title);
	if (filtered.length === 0) {
		lines.push("  (sin coincidencias)");
		lines.push(footer);
		return lines;
	}
	const max = Math.min(filtered.length, 12);
	const start = Math.max(0, Math.min(cursor - 6, filtered.length - max));
	const end = Math.min(filtered.length, start + max);
	if (start > 0) lines.push(`  … (${start} anteriores)`);
	for (let i = start; i < end; i += 1) {
		const item = filtered[i]!;
		const arrow = i === cursor ? "›" : " ";
		const desc = item.description ? `  ${item.description}` : "";
		const hint = renderHint ? `  ${renderHint(item) ?? ""}` : "";
		lines.push(`  ${arrow} ${item.label}${desc}${hint}`);
	}
	if (end < filtered.length) lines.push(`  … (${filtered.length - end} siguientes)`);
	lines.push(footer);
	return lines;
}
