// src/integrations/ensure-codegraph.ts — auto-init de codegraph (ADR-011 §3).
//
// Idempotente: si `.codegraph/` ya existe, no hace nada. Si CLI ausente, devuelve skipped.
// Si `codegraph init` falla o excede timeout, devuelve `failed` con stderr — la tool no se registra.

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

export type EnsureResult =
	| { status: "ready"; message: string }
	| { status: "skipped"; message: string }
	| { status: "initiated"; message: string }
	| { status: "failed"; message: string };

const INIT_TIMEOUT_MS = 120_000;

/** Una sola vez por proceso+CLI ausente: ejecuta `codegraph init` en `cwd`.
 *  Mejor esfuerzo: NUNCA lanza. Devuelve `failed` con detalle si algo va mal. */
export function ensureCodegraphIndex(cwd: string, timeoutMs: number = INIT_TIMEOUT_MS): EnsureResult {
	if (!existsSync(path.join(cwd, ".codegraph"))) {
		// Probe CLI; si no está, no hay nada que hacer.
		const probe = spawnSync("codegraph", ["--version"], { encoding: "utf8", timeout: 3000 });
		if (probe.error || probe.status === null) {
			return { status: "skipped", message: "codegraph CLI ausente" };
		}
		const r = spawnSync("codegraph", ["init"], {
			cwd,
			encoding: "utf8",
			timeout: timeoutMs,
		});
		if (r.error || r.status === null) {
			const why = r.error?.message ?? `signal=${r.signal ?? "null"}`;
			return { status: "failed", message: `codegraph init no se pudo ejecutar: ${why}` };
		}
		if (r.status !== 0) {
			const tail = (r.stderr || r.stdout || "").trim().slice(-400);
			return { status: "failed", message: `codegraph init salió con código ${r.status}: ${tail}` };
		}
		return { status: "initiated", message: "codegraph init completado" };
	}
	return { status: "ready", message: "índice codegraph ya presente" };
}
