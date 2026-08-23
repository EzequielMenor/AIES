// src/workers/prompts.ts — system prompts para orquestador y workers (ADR-007, MVP-v0 §2, ADR-011).
//
// La metodología del orquestador se inyecta como `systemPromptOverride` en sesiones efímeras del
// bucle (decide.ts). Los workers usan su propia persona (explorer/implementer/verifier) — la
// extensión también registra esos prompts al crear sesiones efímeras desde session-factory.
//
// ADR-011: cada prompt se compone dinámicamente con un anexo de integración sólo cuando las tools
// correspondientes están activas en la sesión (evita inflar tokens en proyectos sin codegraph/pjm).

import { ORCHESTRATOR_SYSTEM_PROMPT } from "../orchestrator/prompts.js";

export { ORCHESTRATOR_SYSTEM_PROMPT };

export interface IntegrationPromptBits {
	code_explore: boolean;
	mem_read: boolean;
	mem_log: boolean;
}

const CODE_EXPLORE_HINT = "- Para preguntas estructurales sobre el código (símbolos, call paths), prefiere `code_explore` antes que grep/find extensivos.";

const MEM_READ_HINT = "- Antes de empezar una unidad, considera `mem_read` para revisar decisiones/gotchas/lecciones ya registradas en este proyecto entre sesiones.";

const MEM_LOG_HINT = "- Registra con `mem_log` SOLO conocimiento operativo durable entre sesiones (decisiones, gotchas, lecciones). NO registres ruido ni cada turno.";

function appendBits(base: string, bits: IntegrationPromptBits): string {
	const addenda: string[] = [];
	if (bits.code_explore) addenda.push(CODE_EXPLORE_HINT);
	if (bits.mem_read) addenda.push(MEM_READ_HINT);
	if (bits.mem_log) addenda.push(MEM_LOG_HINT);
	if (addenda.length === 0) return base;
	return `${base}\n\n# Integraciones activas\n${addenda.join("\n")}`;
}

export function composeExplorerPrompt(bits: IntegrationPromptBits): string {
	return appendBits(
		"Eres el EXPLORER de AIES. Reúne SOLO la información mínima necesaria para resolver la tarea. Usa read/grep/find/ls. NO hagas reconocimiento general del proyecto. NO leas archivos que no sean directamente relevantes. Devuelve un resumen ESTRUCTURADO y CONCISO de lo encontrado.",
		bits,
	);
}

export function composeImplementerPrompt(bits: IntegrationPromptBits): string {
	return appendBits(
		"Eres el IMPLEMENTER de AIES. Realiza el cambio mínimo que satisface la unidad (puedes edit/write/bash/grep/find). Haz SOLO lo que la unidad pide; nada superfluo. Describe brevemente el cambio realizado.",
		bits,
	);
}

export function composeVerifierPrompt(bits: IntegrationPromptBits): string {
	return appendBits(
		"Eres el VERIFIER de AIES (ADR-002). Verificas con el método MÁS SIMPLE Y DIRECTO posible (read/bash/grep/find/ls): si basta con leer el archivo para confirmar el cambio, hazlo; no ejecutes imports dinámicos ni builds completos para cambios triviales. NO editas ni escribes. Termina SIEMPRE con `VEREDICTO: PASS` o `VEREDICTO: FAIL` + evidencia breve.",
		bits,
	);
}
