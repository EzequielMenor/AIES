// src/cli-persistence.ts — store local en .aies/ (cwd-relative) para el CLI.
//
// Plan §3 — invariante 3: toda mutación se checkpointa antes de tocar el proyecto. El store
// expone `checkpoint(state, motivo)` que escribe state.json atómicamente; el bucle llama a este
// checkpoint en `markUnitEnCurso` y tras cada ejecución de worker.
//
// Migración: snapshots v1 (sin `version`) se migran a v2 añadiendo `version`, `runStatus`,
// `consecutiveNoProgress` y `humanWait` con defaults seguros. Snapshots incompatibles se
// rechazan como `corrupt` (no se reanuda un estado a medias).

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, openSync, readSync, closeSync, statSync } from "node:fs";
import * as path from "node:path";
import { serializeEntry, type LogEntry } from "./observability.js";
import type { RuntimeState } from "./core/state.js";
import { STATE_VERSION, LegacyStateV1Schema } from "./core/state-schema.js";

export interface PersistPaths {
	dir: string;
	stateFile: string;
	logFile: string;
	historyFile: string;
}

/** Máximo de líneas en `.aies/history` (T4.1). Más antiguas se descartan al guardar. */
export const REPL_HISTORY_LIMIT = 500;

export function persistPaths(cwd: string): PersistPaths {
	const dir = path.join(cwd, ".aies");
	return {
		dir,
		stateFile: path.join(dir, "state.json"),
		logFile: path.join(dir, "log.jsonl"),
		historyFile: path.join(dir, "history"),
	};
}

function writeAtomic(file: string, content: string): void {
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, content, "utf8");
	try {
		renameSync(tmp, file);
	} catch (e) {
		try {
			unlinkSync(tmp);
		} catch {
			/* best-effort */
		}
		throw e;
	}
}

/** Descarta objetos JSON con discriminante válido pero shape de log incompleto. */
function isPersistedLogEntry(value: unknown): value is LogEntry {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	if (entry.type === "decision") {
		return typeof entry.iter === "number" && Number.isFinite(entry.iter) && typeof entry.operación === "string" && typeof entry.motivo === "string" && typeof entry.parseFail === "boolean";
	}
	if (entry.type === "resultado") {
		return typeof entry.iter === "number" && Number.isFinite(entry.iter) && typeof entry.resultado === "string" && typeof entry.kind === "string";
	}
	if (entry.type === "compaction") {
		return typeof entry.fase === "string" && typeof entry.reason === "string";
	}
	return false;
}

/** Migración v1→v2. Acepta snapshots sin `version`/`runStatus`/`consecutiveNoProgress` y los
 *  completa con defaults seguros. */
function migrateV1ToV2(raw: unknown): RuntimeState | null {
	const parsed = LegacyStateV1Schema.safeParse(raw);
	if (!parsed.success) return null;
	const v1 = parsed.data;
	const taskState = v1.taskState === "Recibida" || v1.taskState === "En curso" || v1.taskState === "Completada" || v1.taskState === "Fallida" ? v1.taskState : "En curso";
	const limits = v1.limits ?? { maxIterations: 12 };
	return {
		...v1,
		version: STATE_VERSION,
		taskState,
		limits: { ...limits, maxConsecutiveNoProgress: 3 },
		consecutiveParseFailures: v1.consecutiveParseFailures ?? 0,
		consecutiveNoProgress: 0,
		runStatus: { tipo: "ready" },
		humanWait: null,
	} as RuntimeState;
}

/** Campos mínimos para reanudar un snapshot de disco (schema antiguo → no reanudable). */
export function hasResumableShape(value: unknown): value is RuntimeState {
	if (value === null || typeof value !== "object") return false;
	const s = value as Record<string, unknown>;
	if (typeof s.taskState !== "string") return false;
	if (s.task === null || typeof s.task !== "object") return false;
	if (!Array.isArray(s.units) || !Array.isArray(s.results)) return false;
	if (typeof s.iterations !== "number") return false;
	if (s.limits === null || typeof s.limits !== "object") return false;
	return true;
}

export type LoadStateResult =
	| { kind: "ok"; state: RuntimeState }
	| { kind: "absent" }
	| { kind: "invalid"; reason: "corrupt" | "schema" | "unsupported_version" };

export class LocalStore {
	private readonly paths: PersistPaths;
	constructor(cwd: string) {
		this.paths = persistPaths(cwd);
	}
	dir(): string {
		return this.paths.dir;
	}
	saveState(state: RuntimeState): void {
		mkdirSync(this.paths.dir, { recursive: true });
		writeAtomic(this.paths.stateFile, JSON.stringify(state, null, 2));
	}
	/** Plan §4 — paso 8: checkpoint atómico. Si lanza, el bucle aborta el turno. */
	checkpoint(state: RuntimeState, _motivo: string): void {
		this.saveState(state);
	}
	loadStateResult(): LoadStateResult {
		if (!existsSync(this.paths.stateFile)) return { kind: "absent" };
		let text: string;
		try {
			text = readFileSync(this.paths.stateFile, "utf8");
		} catch {
			return { kind: "invalid", reason: "corrupt" };
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { kind: "invalid", reason: "corrupt" };
		}
		if (!hasResumableShape(parsed)) return { kind: "invalid", reason: "schema" };
		// Snapshot v2 canónico (con `version`).
		const record = parsed as unknown as Record<string, unknown>;
		if (record.version === STATE_VERSION) {
			return { kind: "ok", state: parsed as RuntimeState };
		}
		// Snapshot v1 (sin `version`): migración. Si falla, no se reanuda.
		const migrated = migrateV1ToV2(parsed);
		if (migrated) {
			// Re-persistimos como v2 para que los siguientes arranques lean v2 directo.
			try {
				this.saveState(migrated);
			} catch {
				/* best-effort; el caller aún recibe el estado migrado en memoria */
			}
			return { kind: "ok", state: migrated };
		}
		return { kind: "invalid", reason: "unsupported_version" };
	}
	loadState(): RuntimeState | null {
		const loaded = this.loadStateResult();
		return loaded.kind === "ok" ? loaded.state : null;
	}
	appendLog(entry: LogEntry): void {
		mkdirSync(this.paths.dir, { recursive: true });
		appendFileSync(this.paths.logFile, serializeEntry(entry) + "\n", "utf8");
	}

	readLogIndexed(): Array<{ line: number; entry: LogEntry }> {
		if (!existsSync(this.paths.logFile)) return [];
		const fd = openSync(this.paths.logFile, "r");
		try {
			const totalBytes = statSync(this.paths.logFile).size;
			const buf = Buffer.alloc(Math.max(1, totalBytes));
			let read = 0;
			while (read < totalBytes) {
				const r = readSync(fd, buf, read, totalBytes - read, read);
				if (r <= 0) break;
				read += r;
			}
			const text = buf.subarray(0, read).toString("utf8");
			const out: Array<{ line: number; entry: LogEntry }> = [];
			let line = 0;
			for (const ln of text.split("\n")) {
				line += 1;
				if (!ln.trim()) continue;
			try {
				const parsed: unknown = JSON.parse(ln);
				if (isPersistedLogEntry(parsed)) out.push({ line, entry: parsed });
			} catch {
					/* línea corrupta: saltar, nº de línea ya consumido */
				}
			}
			return out;
		} finally {
			closeSync(fd);
		}
	}

	readLog(): LogEntry[] {
		return this.readLogIndexed().map((x) => x.entry);
	}

	/**
	 * Historial del REPL (T4.1). El fichero es cronológico (más antiguo primero, estilo bash).
	 * El array devuelto va **más reciente primero**, que es lo que espera `readline` (`history[0]`).
	 * Fichero ausente o ilegible → `[]` (el REPL arranca vacío; no es un error de usuario).
	 */
	loadHistory(): string[] {
		if (!existsSync(this.paths.historyFile)) return [];
		try {
			const text = readFileSync(this.paths.historyFile, "utf8");
			const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
			const kept = lines.length > REPL_HISTORY_LIMIT ? lines.slice(-REPL_HISTORY_LIMIT) : lines;
			return kept.slice().reverse();
		} catch {
			return [];
		}
	}

	/**
	 * Reescribe `.aies/history` desde el array de readline (más reciente primero).
	 * Fallo de disco: best-effort — no tumba el REPL.
	 */
	saveHistory(newestFirst: readonly string[]): void {
		try {
			mkdirSync(this.paths.dir, { recursive: true });
			const chronological = newestFirst.filter((l) => l.length > 0).slice().reverse();
			const kept =
				chronological.length > REPL_HISTORY_LIMIT
					? chronological.slice(-REPL_HISTORY_LIMIT)
					: chronological;
			writeAtomic(this.paths.historyFile, kept.length ? `${kept.join("\n")}\n` : "");
		} catch {
			/* historial best-effort */
		}
	}
}