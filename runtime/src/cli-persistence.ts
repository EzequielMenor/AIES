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
	| { kind: "invalid"; reason: "corrupt" | "schema" };

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
	loadStateResult(): LoadStateResult {
		if (!existsSync(this.paths.stateFile)) return { kind: "absent" };
		try {
			const text = readFileSync(this.paths.stateFile, "utf8");
			const parsed: unknown = JSON.parse(text);
			if (!hasResumableShape(parsed)) return { kind: "invalid", reason: "schema" };
			return { kind: "ok", state: parsed };
		} catch {
			return { kind: "invalid", reason: "corrupt" };
		}
	}
	loadState(): RuntimeState | null {
		const loaded = this.loadStateResult();
		return loaded.kind === "ok" ? loaded.state : null;
	}
	appendLog(entry: LogEntry): void {
		mkdirSync(this.paths.dir, { recursive: true });
		appendFileSync(this.paths.logFile, serializeEntry(entry) + "\n", "utf8");
	}
}
