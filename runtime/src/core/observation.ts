// src/core/observation.ts — contrato de observación del bucle para presentación.
//
// AIES-core es el dueño del bucle; pi es el motor (ADR-009). La TUI/Ink observa
// el bucle a través de un hook fire-and-forget: el bucle no conoce el EventBus,
// ni React, ni Ink, ni la API de pi. La traducción observación → evento de
// presentación vive en cli.ts (capítulo del adaptador CLI → TUI).
//
// Reglas:
//   - Hook síncrono o void; nunca se awaita. No se acopla a la latencia de la TUI.
//   - Los snapshots de `state` reflejan el momento del ciclo:
//       * decision:start  → estado previo a `hooks.decide`
//       * decision:resolved → estado post-`hooks.decide` (sin aplicar ajustePlan)
//       * execution:start → estado post-`applyAjustePlan`, pre-`hooks.execute`
//       * execution:resolved → estado post-`applyOperationResult`+`appendResult`
//                              y con `iterations + 1` aplicado
//   - Sin razonamiento: la decisión resuelta lleva la decisión VALIDADA o null
//     en parse-fail; nunca se filtra texto crudo del proveedor como si fuera
//     razonamiento visible.

import type { Decision, OperationResult, RuntimeState } from "./state.js";
import type { WorkerTelemetry } from "../telemetry/types.js";

export type LoopObservation =
	| { phase: "decision:start"; state: RuntimeState }
	| {
			phase: "decision:resolved";
			state: RuntimeState;
			decision: Decision | null;
			parseFail: boolean;
			parseError: string | null;
			raw: string;
			telemetry: WorkerTelemetry;
	  }
	| { phase: "execution:start"; state: RuntimeState; decision: Decision }
	| {
			phase: "execution:resolved";
			state: RuntimeState;
			decision: Decision;
			result: OperationResult;
			telemetry: WorkerTelemetry;
			atribución: "orquestador" | null;
	  }
	| {
			phase: "limit:reached";
			state: RuntimeState;
			action: "intervenir" | "terminar";
			reason: string;
	  }
	| { phase: "intervention:stopped"; state: RuntimeState }
	| { phase: "intervention:adjustment"; state: RuntimeState; text: string }
	| { phase: "terminated"; state: RuntimeState; reason: string }
	| { phase: "error:unidad-inexistente"; state: RuntimeState; decision: Decision };

export type ObservationHook = (obs: LoopObservation) => void;

/** Helper seguro: ejecuta el hook sin lanzar nada hacia el bucle.
 *  El bucle no debe quedar acoplado a la latencia de la presentación. */
export function safeObserve(hook: ObservationHook | undefined, obs: LoopObservation): void {
	if (!hook) return;
	try {
		hook(obs);
	} catch {
		/* un observer que falla no rompe el bucle */
	}
}
