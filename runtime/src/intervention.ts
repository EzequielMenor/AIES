// src/intervention.ts — canal de intervención del desarrollador (Runtime-Model §7, P-20/RNF-04,
// ADR-012). La intervención es una ENTRADA EXTERNA al ciclo: se incorpora al estado como un
// resultado más (el bucle la procesa vía stopSignal). UX v0 (ADR-012):
//   - REPL: ESC durante un run → parar (pausar, sin cerrar). Ctrl+C durante un run → pausar y
//     cerrar el REPL tras drenar el turno; 2º Ctrl+C → exit(130) inmediato.
//   - Oneshot: Ctrl+C → pausar y exit 1; 2º Ctrl+C → exit(130) inmediato.
//   - Ajuste en caliente (T2.1) sigue funcionando vía readline (`pollIntervention` en
//     `core/events.ts`) y se aplica como resultado `intervención` en el siguiente turno.
//
// El código activo del wireado ESC/SIGINT vive en `cli.ts::runTrackedReplCycle` (REPL) y
// `cli.ts::runOneshot` (oneshot). Este módulo conserva la API legacy `createStopSignal` para
// el código @deprecated de `src/extension/`.

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