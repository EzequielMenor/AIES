// src/integrations/startup.ts — orquestador del arranque de integraciones (ADR-011 §4).
//
// Combina: detección (probing de PATH) → auto-init opcional de codegraph → briefing de
// memoria del proyecto → construcción de customTools. Se invoca UNA vez por tarea al
// recibirla (cli.ts::runCycle, antes del bucle). Tolerante: cada paso devuelve status
// independiente; ningún fallo aborta el ciclo AIES.

import { detect, type Availability } from "./detect.js";
import { ensureCodegraphIndex, type EnsureResult } from "./ensure-codegraph.js";
import { readMemoryBriefing, type MemoryBriefing } from "./memory-briefing.js";
import { buildCustomTools, toolNamesFor, type ToolDefinition } from "./custom-tools.js";

export interface StartupReport {
	availability: Availability;
	codegraphInit: EnsureResult;
	memoryBriefing: MemoryBriefing | null;
	/** Líneas de briefing listas para inyectar a `knownInfo` (P-09). */
	briefing: string[];
	/** Tools AIES-side registradas para este `cwd`. */
	customTools: ToolDefinition[];
	/** Resumen de qué tools hay disponibles (para `toolNamesFor`). */
	toolNames: { code_explore: boolean; mem_read: boolean; mem_log: boolean };
}

/** Ejecuta el pipeline de arranque. NUNCA lanza — cada paso degrada. */
export function runStartup(cwd: string): StartupReport {
	const availability = detect(cwd);
	let codegraphInit: EnsureResult;
	if (availability.codegraph === "needs-init") {
		codegraphInit = ensureCodegraphIndex(cwd);
		// Tras init, refrescar availability por si ahora hay índice.
		if (codegraphInit.status === "ready" || codegraphInit.status === "initiated") {
			availability.codegraph = "ready";
		}
	} else if (availability.codegraph === "ready") {
		codegraphInit = { status: "ready", message: "índice codegraph ya presente" };
	} else {
		codegraphInit = { status: "skipped", message: "codegraph CLI ausente" };
	}

	const memoryBriefing = availability.projectmem === "ready" ? readMemoryBriefing(cwd) : null;
	const customTools = buildCustomTools(availability);
	const toolNames = toolNamesFor(availability);

	const briefing: string[] = [];
	if (memoryBriefing) {
		const header = memoryBriefing.truncated
			? `MEMORIA DEL PROYECTO (resumen, truncado ${memoryBriefing.originalChars}→${memoryBriefing.text.length} chars):`
			: "MEMORIA DEL PROYECTO (resumen):";
		briefing.push(header, memoryBriefing.text);
	} else if (availability.projectmem === "uninit") {
		briefing.push("MEMORIA DEL PROYECTO: no inicializada. El implementer puede sugerir `pjm init` al desarrollador si va a registrar decisiones/lecciones duraderas.");
	}
	briefing.push(formatToolLine(availability, codegraphInit));

	return { availability, codegraphInit, memoryBriefing, briefing, customTools, toolNames };
}

function formatToolLine(av: Availability, init: EnsureResult): string {
	const cg = av.codegraph;
	const cgMsg = cg === "ready" ? "ok" : cg === "needs-init" ? (init.status === "initiated" ? "init" : "autoskip") : "missing";
	const pm = av.projectmem;
	const pmMsg = pm === "ready" ? "ok" : pm === "uninit" ? "uninit" : "missing";
	return `HERRAMIENTAS EXTERNAS: codegraph=${cgMsg}, projectmem=${pmMsg}.`;
}
