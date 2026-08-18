// src/workers/capabilities.ts — allowlists de tools por capacidad (MVP-v0-Scope.md §1, ADR-009 §2).
// La capacidad no concedida NO existe en su sesión (Agent-Model §7, RNF-05). El Verifier SIN edit/write
// (ADR-002): si ver necesita modificar → es OTRA unidad de Implementer, no edita él.

import type { Capability } from "../core/state.js";

export const CAPABILITY_TOOLS: Record<Capability, string[]> = {
	// Explorer — obtener información (read-only, P-10/REQ-F-18). Sin edit/write/bash.
	explorer: ["read", "grep", "find", "ls"],
	// Implementer — implementar (puede modificar el proyecto).
	implementer: ["read", "edit", "write", "bash", "grep", "find"],
	// Verifier (ADR-002) — verificar; SÓLO ejecuta comprobaciones (tsc/test/build). Sin edit/write.
	verifier: ["read", "bash", "grep", "find", "ls"],
};

export const CAPABILITIES: Capability[] = ["explorer", "implementer", "verifier"];