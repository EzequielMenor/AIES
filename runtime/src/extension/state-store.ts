// src/extension/state-store.ts — estado AIES en memoria de la extensión.
//
// El estado de la tarea vive aquí (no en la sesión Pi, no en state.json). Cada /run crea/continúa
// una tarea; /status y /resume la consultan. Persistencia: en Fase 4 podemos añadir un appendEntry
// custom para sobrevivir recargas (ver plan §8 ADR-008).
//
// El "module-scope" singleton es correcto aquí: la extensión Pi es una factoría invocada UNA vez por
// sesión, y mantiene referencias capturadas en sus closures (los handlers de eventos/comandos).

import type { RuntimeState } from "../core/state.js";

export interface AiesTaskState {
	runtime: RuntimeState;
	createdAt: number;
	updatedAt: number;
}

let current: AiesTaskState | null = null;

export function getCurrentTask(): AiesTaskState | null {
	return current;
}

export function setCurrentTask(state: RuntimeState): AiesTaskState {
	const now = Date.now();
	const wrapped: AiesTaskState = { runtime: state, createdAt: current?.createdAt ?? now, updatedAt: now };
	current = wrapped;
	return wrapped;
}

export function updateCurrentTask(state: RuntimeState): AiesTaskState {
	const now = Date.now();
	const wrapped: AiesTaskState = { runtime: state, createdAt: current?.createdAt ?? now, updatedAt: now };
	current = wrapped;
	return wrapped;
}

export function clearCurrentTask(): void {
	current = null;
}

/** Resume: marca si la tarea guardada está en estado no terminal (Recibida/En curso). */
export function isResumable(state: RuntimeState): boolean {
	return state.taskState === "Recibida" || state.taskState === "En curso";
}
