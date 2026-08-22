// src/integrations/memory-briefing.ts — lectura del resumen destilado de projectmem (ADR-011).
//
// Lectura directa de `.projectmem/summary.md` — sin shell-out, determinista, sin spawn.
// Truncado a `MAX_CHARS` con nota si excede. Si el archivo no existe → null (el briefing al
// orquestador simplemente omite esa sección; ver ADR-011 §3 y §4).

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export const MAX_BRIEFING_CHARS = 4096;

export interface MemoryBriefing {
	text: string;
	truncated: boolean;
	originalChars: number;
}

/** Lee `<cwd>/.projectmem/summary.md` y devuelve un texto truncado a `MAX_BRIEFING_CHARS`.
 *  Devuelve `null` si el archivo no existe o falla la lectura (memoria no inicializada). */
export function readMemoryBriefing(cwd: string, maxChars: number = MAX_BRIEFING_CHARS): MemoryBriefing | null {
	const file = path.join(cwd, ".projectmem", "summary.md");
	if (!existsSync(file)) return null;
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.length <= maxChars) {
		return { text: trimmed, truncated: false, originalChars: trimmed.length };
	}
	const suffix = `\n\n[…resumen truncado: ${trimmed.length}→${maxChars} chars]`;
	const head = trimmed.slice(0, maxChars - suffix.length);
	return { text: head + suffix, truncated: true, originalChars: trimmed.length };
}
