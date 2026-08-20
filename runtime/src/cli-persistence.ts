// src/cli-persistence.ts — store local en .aies/ (cwd-relative) para el CLI.
//
// Wrapper minimal sobre fs para state.json (snapshot) + log.jsonl (append-only).
// ADR-008: el log es append-only; lineas corruptas se descartan en lectura. state.json
// se escribe con rename atómico para evitar estados a medio escribir.
//
// Diferencia con FileStore (src/persistence/file_store.ts): éste vive en cwd/.aies/ (lo que
// espera el prompt del CLI). FileStore vive en <agentDir>/aies/<hash(cwd)>/ y es lo que usa
// la extensión Pi cuando AIES corre dentro de una sesión Pi.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import { serializeEntry, type LogEntry } from "./observability.js";
import type { RuntimeState } from "./core/state.js";

export interface PersistPaths {
	dir: string;
	stateFile: string;
	logFile: string;
}

export function persistPaths(cwd: string): PersistPaths {
	const dir = path.join(cwd, ".aies");
	return { dir, stateFile: path.join(dir, "state.json"), logFile: path.join(dir, "log.jsonl") };
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
	loadState(): RuntimeState | null {
		if (!existsSync(this.paths.stateFile)) return null;
		try {
			const text = readFileSync(this.paths.stateFile, "utf8");
			return JSON.parse(text) as RuntimeState;
		} catch {
			return null;
		}
	}
	appendLog(entry: LogEntry): void {
		mkdirSync(this.paths.dir, { recursive: true });
		appendFileSync(this.paths.logFile, serializeEntry(entry) + "\n", "utf8");
	}
}
