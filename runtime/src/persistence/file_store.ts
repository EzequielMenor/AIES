// src/persistence/file_store.ts — state.json + log.jsonl bajo <agentDir>/aies/<hash(cwd)>/ (ADR-008).
// Dominio puro (no pi). Realización v0: el contenido conceptual lo fija Runtime-Model §3.1 + ADR-005;
// la serialización concreta (.json/.jsonl) la elige este módulo dentro de esos conceptos (plan C1).
//
// ponytail: formato v0; extraer StateStore/DecisionLog si aparece un 2.º store (DB/remote). Mientras
// haya un único store, un objeto concreto (no interfaz) es lo mínimo — la interfaz seria YAGNI aquí.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LogEntry } from "../observability.js";
import { serializeEntry } from "../observability.js";
import type { RuntimeState } from "../core/state.js";

function hashCwd(cwd: string): string {
	const abs = path.resolve(cwd);
	// 16 hex de sha1: colisión despreciable para cwds locales; legible en disco.
	return createHash("sha1").update(abs).digest("hex").slice(0, 16);
}

export interface PersistPaths {
	dir: string;
	stateFile: string;
	logFile: string;
}

export function persistPaths(agentDir: string, cwd: string): PersistPaths {
	const dir = path.join(agentDir, "aies", hashCwd(cwd));
	return { dir, stateFile: path.join(dir, "state.json"), logFile: path.join(dir, "log.jsonl") };
}

export type LoadResult =
	| { kind: "absent" }
	| { kind: "ok"; state: RuntimeState }
	| { kind: "corrupt"; error: string };

function writeAtomic(file: string, content: string): void {
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, content, "utf8");
	fs.renameSync(tmp, file);
}

function looksLikeState(v: unknown): v is RuntimeState {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.taskState === "string" &&
		typeof o.task === "object" && o.task !== null &&
		Array.isArray(o.units) &&
		typeof o.iterations === "number" &&
		typeof o.limits === "object" && o.limits !== null
	);
}

export interface FileStore extends PersistPaths {
	saveState(state: RuntimeState): void;
	loadState(): LoadResult;
	appendLog(entry: LogEntry): void;
	readLog(): LogEntry[];
}

export function createStore(agentDir: string, cwd: string): FileStore {
	const { dir, stateFile, logFile } = persistPaths(agentDir, cwd);

	return {
		dir,
		stateFile,
		logFile,

		saveState(state) {
			fs.mkdirSync(dir, { recursive: true });
			writeAtomic(stateFile, JSON.stringify(state, null, 2));
		},

		loadState(): LoadResult {
			if (!fs.existsSync(stateFile)) return { kind: "absent" };
			let text: string;
			try {
				text = fs.readFileSync(stateFile, "utf8");
			} catch (e) {
				return { kind: "corrupt", error: e instanceof Error ? e.message : String(e) };
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch (e) {
				return { kind: "corrupt", error: e instanceof Error ? e.message : String(e) };
			}
			if (!looksLikeState(parsed)) return { kind: "corrupt", error: "estado sin campos requeridos (Runtime-Model §3.1)" };
			return { kind: "ok", state: parsed };
		},

		appendLog(entry) {
			fs.mkdirSync(dir, { recursive: true });
			fs.appendFileSync(logFile, serializeEntry(entry) + "\n", "utf8");
		},

		readLog(): LogEntry[] {
			if (!fs.existsSync(logFile)) return [];
			const text = fs.readFileSync(logFile, "utf8");
			const out: LogEntry[] = [];
			for (const line of text.split("\n")) {
				if (!line.trim()) continue;
				try {
					out.push(JSON.parse(line) as LogEntry);
				} catch {
					// línea corrupta: saltar (log historial preservado, ADR-008 §5).
				}
			}
			return out;
		},
	};
}