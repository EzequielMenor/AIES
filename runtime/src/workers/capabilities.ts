// src/workers/capabilities.ts — allowlists de tools por capacidad (MVP-v0-Scope.md §1, ADR-009 §2).
// La capacidad no concedida NO existe en su sesión (Agent-Model §7, RNF-05).
//
// ADR-011: las tools de integraciones (`code_explore`, `mem_read`, `mem_log`) sólo aparecen si la
// dependencia externa está disponible. Explorer sigue read-only (P-10/REQ-F-18): sólo gana
// `code_explore` y `mem_read` (lectura), nunca `mem_log` (escritura) ni `bash`.

import type { Capability } from "../core/state.js";
import type { toolNamesFor } from "../integrations/index.js";

export type IntegrationTools = ReturnType<typeof toolNamesFor>;

export interface CapabilityToolsConfig {
	integrations: IntegrationTools;
}

export function buildCapabilityTools(cfg: CapabilityToolsConfig): Record<Capability, string[]> {
	const intg: string[] = [];
	if (cfg.integrations.code_explore) intg.push("code_explore");
	if (cfg.integrations.mem_read) intg.push("mem_read");
	if (cfg.integrations.mem_log) intg.push("mem_log");

	return {
		// Explorer — sólo lectura (P-10/REQ-F-18). NO bash, NO mem_log.
		explorer: [...intg.filter((t) => t === "code_explore" || t === "mem_read"), "read", "grep", "find", "ls"],
		// Implementer — puede modificar. Sí recibe mem_log (escritura de memoria).
		implementer: [...intg, "read", "edit", "write", "bash", "grep", "find"],
		// Verifier (ADR-002) — comprobar sin editar. Sin mem_log.
		verifier: [...intg.filter((t) => t === "code_explore" || t === "mem_read"), "read", "bash", "grep", "find", "ls"],
	};
}

export const CAPABILITIES: Capability[] = ["explorer", "implementer", "verifier"];
