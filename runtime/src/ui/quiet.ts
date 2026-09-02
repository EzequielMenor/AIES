// src/ui/quiet.ts — silenciador reversible del stdout nativo de Node.
//
// Por qué existe:
//   La librería pi (`@earendil-works/pi-coding-agent`) imprime parte de su propia UI
//   directamente a `process.stdout` con `console.log` o `process.stdout.write`,
//   ANTES de pasar por la `notify` callback de AuthInteraction. Esto contamina el REPL con
//   mensajes como "Select OpenAI Codex login method:" mientras AIES intenta pintar su
//   propio picker.
//
// Uso:
//   const restore = quietStdout();
//   try {
//     await pi.runtime.login(...);
//   } finally {
//     restore();
//   }
//
// Cómo:
//   - Reemplaza temporalmente `process.stdout.write` por una versión que DESCARTA los
//     writes. Los eventos `data` del stream siguen emitiéndose normalmente (no tocamos los
//     listeners); esto es seguro porque pi escribe a stdout sincrónicamente desde su login.
//   - Guarda la referencia original en un closure; `restore()` la devuelve.
//   - Si una llamada `info` de AIES se cuela dentro del intervalo quieteado,，我们会 la 同样 descartar. Para evitarlo, los flujos de AIES usan `PromptUI.streams().output` que es
//     normalmente el mismo `process.stdout`; aquí  ASUMIMOS que durante el quieteado NINGÚN
//     AIES path escribe a stdout (es responsabilidad del caller: el único ai context válido
//     durante `login` es la `terminalAuthInteraction.notify`, que apunta al mismo stream —
//     por eso redirigimos a un buffer interno de QuietBuffer en su lugar).
//
// Limitación:
//   Si pi escribe a `console.error` o abre otro fd, este mecanismo no los silencia. El
//   objetivo es 1) eliminar los prompts duplicados y 2) dejar paso libre al AIES UI; no
//   es un sink universal.

import { Writable } from "node:stream";

declare global {
	// Variable global que `quietStdout` usa — aislada por módulo para evitar fugas.
	// eslint-disable-next-line no-var
	var __aiesQuietStdoutDepth: number | undefined;
}

const QUIET_BUFFER_KEY = Symbol.for("__aies_quiet_stdout_buffer__");

type BufferAcc = string[];

function getBuffer(): BufferAcc {
	const g = globalThis as unknown as { [k: symbol]: BufferAcc | undefined };
	let buf = g[QUIET_BUFFER_KEY];
	if (!buf) {
		buf = [];
		g[QUIET_BUFFER_KEY] = buf;
	}
	return buf;
}

/**
 * Comienza a descartar writes a `process.stdout`. Devuelve una función que, al llamarla,
 * restaura `write` y (opcionalmente) devuelve el contenido acumulado durante el intervalo
 * — útil para depurar o para reemprimir tras la captura.
 */
export function quietStdout(): () => void {
	const g = globalThis as unknown as { [k: symbol]: number | undefined };
	g[QUIET_BUFFER_KEY] = g[QUIET_BUFFER_KEY] ?? undefined; // no-op type marker
	const buf = getBuffer();
	const original = process.stdout.write.bind(process.stdout);
	let intercepted = true;
	(process.stdout as unknown as { write: typeof process.stdout.write }).write = ((...args: Parameters<typeof process.stdout.write>) => {
		if (!intercepted) return original(...args);
		const text = args[0];
		if (text) buf.push(typeof text === "string" ? text : Buffer.isBuffer(text) ? text.toString("utf8") : String(text));
		return true;
	}) as typeof process.stdout.write;
	return () => {
		intercepted = false;
		(process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
	};
}

/** Recupera y vacía el buffer acumulado por `quietStdout`. */
export function drainQuietBuffer(): string {
	const buf = getBuffer();
	const text = buf.join("");
	buf.length = 0;
	return text;
}

/** Sink descartable para tests — equivalente a `process.stdout` pero no escribe nada. */
export function silentWritable(): Writable {
	return new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
}
