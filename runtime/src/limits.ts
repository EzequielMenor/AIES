// src/limits.ts — política de límites v0 (ADR-005 + MVP-v0-Scope §4).
// Valores v0 (provisionales, recalibrables en 06-research): iteraciones 12; coste off; contexto
// delegado a autoCompaction y OBSERVADO vía contextUsage con backstop de iteraciones (plan C2).

import { DEFAULT_LIMITS, type Limits } from "./core/state.js";

export { DEFAULT_LIMITS };

/** Repertorio al alcanzar un límite (ADR-005): por defecto "pedir intervención" (ya en el loop). */
export const LIMIT_REPERTOIRE = ["terminar controladamente", "pedir intervención", "cambiar de estrategia", "ampliación preautorizada"] as const;

/**
 * coste: off → sin presupuesto de coste (sólo medición vía usage, RNF-17).
 * contexto: techo blando vía autoCompaction; AIES NUNCA asume no-overflow →
 * observa contextUsage y, si falta/obsoleto, avisa (telemetry_unavailable) y sigue con el backstop de iteraciones.
 */
export const LIMIT_POLICY = { cost: "off", context: "observed-autoCompaction-backstop-iter" } as const;

export function limitsFromConfig(cfg: { limits?: { maxIterations?: number | undefined } | undefined } | undefined): Limits {
	return { maxIterations: cfg?.limits?.maxIterations ?? DEFAULT_LIMITS.maxIterations };
}