// src/integrations/index.ts — barrel del módulo de integraciones (ADR-011).
//
// Dominio AIES puro: sin pi. La frontera ADR-009 cruza sólo en session-factory.ts cuando pasa
// `customTools` a `createAgentSession`.

export { detect, type Availability, type CodegraphState, type ProjectmemState } from "./detect.js";
export { ensureCodegraphIndex, type EnsureResult } from "./ensure-codegraph.js";
export { readMemoryBriefing, MAX_BRIEFING_CHARS, type MemoryBriefing } from "./memory-briefing.js";
export { buildCustomTools, toolNamesFor } from "./custom-tools.js";
export { runStartup, type StartupReport } from "./startup.js";
