// src/core/types.ts — tipos de dominio AIES.
//
// Tipos que antes vivían en host/types.ts (la fachada Host, eliminada en Fase 4). ThinkingLevel
// y HostActivity son tipos de dominio AIES que se usan en la extensión (workers, events-mapping).

/** Nivel de thinking configurable por rol (pi ThinkingLevel, subconjunto válido). */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** Actividad operacional observada en vivo durante una vuelta del host. */
export interface HostActivity {
	fase: "start" | "end";
	tool: string;
	target: string | null;
	isError: boolean | null;
}
