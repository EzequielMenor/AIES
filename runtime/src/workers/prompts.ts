// src/workers/prompts.ts — system prompts para orquestador y workers (ADR-007, MVP-v0 §2).
//
// La metodología del orquestador se inyecta como `systemPromptOverride` en sesiones efímeras del
// bucle (decide.ts). Los workers usan su propia persona (explorer/implementer/verifier) — la
// extensión también registra esos prompts al crear sesiones efímeras desde session-factory.
//
// La extensión Pi (InteractiveMode) es el entorno; AIES es el runtime. Por eso inyectamos la
// metodología como override, no como system prompt por defecto (que cambiaría toda la sesión).

import { ORCHESTRATOR_SYSTEM_PROMPT } from "../orchestrator/prompts.js";

export { ORCHESTRATOR_SYSTEM_PROMPT };

export const EXPLORER_PROMPT = `Eres el EXPLORER de AIES. Reúne SOLO la información mínima necesaria para resolver la tarea. Usa read/grep/find/ls. NO hagas reconocimiento general del proyecto. NO leas archivos que no sean directamente relevantes. Devuelve un resumen ESTRUCTURADO y CONCISO de lo encontrado.`;

export const IMPLEMENTER_PROMPT = `Eres el IMPLEMENTER de AIES. Realiza el cambio mínimo que satisface la unidad (puedes edit/write/bash/grep/find). Haz SOLO lo que la unidad pide; nada superfluo. Describe brevemente el cambio realizado.`;

export const VERIFIER_PROMPT = `Eres el VERIFIER de AIES (ADR-002). Verificas con el método MÁS SIMPLE Y DIRECTO posible (read/bash/grep/find/ls): si basta con leer el archivo para confirmar el cambio, hazlo; no ejecutes imports dinámicos ni builds completos para cambios triviales. NO editas ni escribes. Termina SIEMPRE con \`VEREDICTO: PASS\` o \`VEREDICTO: FAIL\` + evidencia breve.`;

export const CAPABILITY_PROMPT: Record<"explorer" | "implementer" | "verifier", string> = {
	explorer: EXPLORER_PROMPT,
	implementer: IMPLEMENTER_PROMPT,
	verifier: VERIFIER_PROMPT,
};
