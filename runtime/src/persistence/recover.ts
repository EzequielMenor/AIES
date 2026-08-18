// src/persistence/recover.ts — recuperación segura (ADR-008 §5).
// state.json ausente/ilegible/corrupto → sesión limpia, NO fallo silencioso, NO continuación con estado
// inconsistente. Si log.jsonl es legible, se conserva como historial (nunca se sobrescribe con estado corrupto).
// Devuelve el estado (null = arrancar limpio), el log preservado y un flag `corrupt` para avisar al CLI.

import type { LogEntry } from "../observability.js";
import type { RuntimeState } from "../core/state.js";
import { createStore, type LoadResult } from "./file_store.js";

export interface Recovery {
	dir: string;
	state: RuntimeState | null;
	log: LogEntry[];
	corrupt: boolean;
	absent: boolean;
}

export function recover(agentDir: string, cwd: string, logger?: (msg: string) => void): Recovery {
	const store = createStore(agentDir, cwd);
	const loaded: LoadResult = store.loadState();
	const log = store.readLog();

	if (loaded.kind === "ok") {
		return { dir: store.dir, state: loaded.state, log, corrupt: false, absent: false };
	}

	// ausente o corrupto → sesión limpia. Log legible conservado.
	const corrupt = loaded.kind === "corrupt";
	if (corrupt) {
		const preserved = log.length > 0 ? ` (log.jsonl legible conservado: ${log.length} entradas)` : "";
		logger?.(`state.json corrupto → sesión limpia. Causa: ${loaded.error}${preserved}`);
	}
	return { dir: store.dir, state: null, log, corrupt, absent: loaded.kind === "absent" };
}

/** ¿La tarea cargada es reanudable (no terminal)? Para que el CLI decida resume vs. nueva. */
export function isResumable(state: RuntimeState | null): boolean {
	return state !== null && (state.taskState === "Recibida" || state.taskState === "En curso");
}