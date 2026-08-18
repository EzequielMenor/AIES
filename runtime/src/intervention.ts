// src/intervention.ts — canal de intervención del desarrollador (Runtime-Model §7, P-20/RNF-04).
// La intervención es una ENTRADA EXTERNA al ciclo: se incorpora al estado como un resultado más
// (el bucle la procesa vía stopSignal). En v0 el canal es el proceso de AIES-core (SIGINT), no pi.
// UX v0 = SIGINT (Ctrl-C). REPL/TUI = Tier 3 (fuera).

export interface StopController {
	/** true cuando el desarrollador ha solicitado detener el ciclo. */
	stopSignal: () => boolean;
	dispose: () => void;
}

/**
 * Wirea SIGINT: la 1ª interrupción solicita detención ordenada (el bucle la procesa al inicio de la
 * siguiente iteración → tarea Fallida por intervención, Runtime §7). Una 2ª interrupción fuerza salida.
 */
export function createStopSignal(): StopController {
	let stop = false;
	const handler = () => {
		if (stop) {
			console.error("\n[intervención] segunda interrupción: saliendo.");
			process.exit(130);
		}
		stop = true;
		console.error("\n[intervención] detención solicitada; el bucle la procesará en el siguiente paso.");
	};
	process.on("SIGINT", handler);
	return {
		stopSignal: () => stop,
		dispose: () => {
			process.off("SIGINT", handler);
		},
	};
}