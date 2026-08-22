// src/integrations/detect.ts — detección de herramientas externas del harness (ADR-011).
//
// Dominio AIES puro: sin pi, sin tools. Sólo filesystem + child_process para probing de PATH.
// La presencia/ausencia determina qué `customTools` registra el session-factory.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

export type CodegraphState = "ready" | "needs-init" | "missing";
export type ProjectmemState = "ready" | "uninit" | "missing";

export interface Availability {
	codegraph: CodegraphState;
	projectmem: ProjectmemState;
	/** CWD resuelto del proyecto donde aplican las detecciones. */
	cwd: string;
}

/** ¿Está `bin` en PATH y responde a `--version` sin error fatal? Usa `spawnSync` con timeout corto. */
function probeCli(bin: string, versionArgs: string[] = ["--version"]): boolean {
	try {
		const r = spawnSync(bin, versionArgs, { encoding: "utf8", timeout: 3000 });
		// spawnSync devuelve `error` cuando el binario no existe; `status === null` si el SO no lo encuentra.
		if (r.error) return false;
		if (r.status === null && r.signal === null) return false;
		return true;
	} catch {
		return false;
	}
}

/** Detección no-destructiva: presencia de CLIs + presencia de índices en `cwd`. */
export function detect(
	cwd: string,
	options?: { probeCli?: (bin: string, args?: string[]) => boolean },
): Availability {
	const prober = options?.probeCli ?? probeCli;
	const codegraphCli = prober("codegraph");
	const projectmemCli = prober("pjm", ["brief", "--help"]);
	const hasCodegraphIndex = existsSync(path.join(cwd, ".codegraph"));
	const hasProjectmemSummary = existsSync(path.join(cwd, ".projectmem", "summary.md"));
	return {
		cwd,
		codegraph: codegraphCli ? (hasCodegraphIndex ? "ready" : "needs-init") : "missing",
		projectmem: projectmemCli ? (hasProjectmemSummary ? "ready" : "uninit") : "missing",
	};
}
