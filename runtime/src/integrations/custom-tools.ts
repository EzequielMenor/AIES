// src/integrations/custom-tools.ts — herramientas AIES-side registradas como `customTools` (ADR-011).
//
// Tres tools:
//   - code_explore  → shell-out `codegraph explore <query>` en cwd (explorer/implementer/verifier)
//   - mem_read      → lectura directa de `.projectmem/summary.md` (explorer/implementer/verifier)
//   - mem_log       → shell-out a `pjm log|attempt|fix|decision|note <text>` (sólo implementer)
//
// Forma: TypeBox schemas + `execute(toolCallId, params, signal, onUpdate, ctx): AgentToolResult`.
// Las tools devuelven SIEMPRE texto (con error claro cuando proceda); nunca lanzan al modelo.
// Cuando el CLI/archivo falta, la tool no se registra — el modelo ni la ve (P-10/RNF-05).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Availability } from "./detect.js";
import { MAX_BRIEFING_CHARS } from "./memory-briefing.js";

const execFileP = promisify(execFile);

const textResult = (text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } => ({
	content: [{ type: "text", text }],
	details: {},
});

/** Ejecuta un comando con timeout y captura stdout/stderr. Si el binario no existe (`ENOENT`),
 *  devuelve `{ code: null, notFound: true }`. Nunca lanza. */
async function runCli(
	bin: string,
	args: string[],
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; signal: string | null; notFound: boolean }> {
	try {
		const r = await execFileP(bin, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, signal });
		return { code: 0, stdout: r.stdout, stderr: r.stderr, signal: null, notFound: false };
	} catch (e: unknown) {
		const err = e as NodeJS.ErrnoException & { code?: string; stdout?: string; stderr?: string; signal?: string; killed?: boolean };
		if (err && (err.code === "ENOENT" || /ENOENT/.test(err.message))) {
			return { code: null, stdout: "", stderr: "", signal: null, notFound: true };
		}
		const stdout = typeof err.stdout === "string" ? err.stdout : "";
		const stderr = (typeof err.stderr === "string" ? err.stderr : "") || err.message;
		const code = typeof err.code === "number" ? err.code : 1;
		return { code, stdout, stderr, signal: err.signal ?? (err.killed ? "SIGTERM" : null), notFound: false };
	}
}

const EXPLORE_TIMEOUT_MS = 30_000;
const MEM_TIMEOUT_MS = 10_000;

// ──────────────────────────────────────────────────────────────────────────────
// code_explore
// ──────────────────────────────────────────────────────────────────────────────

const CodeExploreParams = Type.Object({
	query: Type.String({ description: "Pregunta en lenguaje natural sobre la estructura/call paths del proyecto. Se pasa tal cual a `codegraph explore`." }),
});

function buildCodeExploreTool(cwd: string): ToolDefinition<typeof CodeExploreParams> {
	return {
		name: "code_explore",
		label: "code_explore",
		description:
			"Consulta estructural del código (símbolos + call paths) en una sola llamada. Usa esto antes que grep/find extensivos para preguntas sobre QUÉ hace un módulo, QUIÉN llama a una función, o DÓNDE está definido un símbolo. Ejecuta `codegraph explore <query>` en el proyecto.",
		promptSnippet: "code_explore <query> — contexto estructural de código en una llamada",
		parameters: CodeExploreParams,
		execute: async (_id, params, signal, _onUpdate, _ctx) => {
			const r = await runCli("codegraph", ["explore", params.query], cwd, EXPLORE_TIMEOUT_MS, signal);
			if (r.notFound) {
				return textResult("code_explore: codegraph CLI no instalado. Instalar con `npm i -g @colbymchenry/codegraph` y reiniciar.");
			}
			if (r.code !== 0) {
				const tail = (r.stderr || r.stdout || "").trim().slice(-300);
				return textResult(`code_explore: codegraph explore salió con código ${r.code}${r.signal ? ` (signal=${r.signal})` : ""}: ${tail}`);
			}
			const out = r.stdout.trim();
			return textResult(out || "(codegraph explore no devolvió contenido)");
		},
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// mem_read
// ──────────────────────────────────────────────────────────────────────────────

const MemReadParams = Type.Object({
	section: Type.Optional(
		Type.String({
			description: "Sección opcional del resumen (palabra clave). Si se omite, devuelve el resumen completo truncado a 4k chars.",
		}),
	),
});

function buildMemReadTool(cwd: string): ToolDefinition<typeof MemReadParams> {
	return {
		name: "mem_read",
		label: "mem_read",
		description:
			"Lee el resumen destilado de la memoria operativa del proyecto (`.projectmem/summary.md`). Contiene decisiones, gotchas y lecciones entre sesiones. Úsalo al iniciar una unidad para no repetir errores conocidos. Si no hay memoria inicializada, sugiere `pjm init`.",
		promptSnippet: "mem_read [section] — resumen destilado de la memoria operativa del proyecto",
		parameters: MemReadParams,
		execute: async (_id, params, _signal, _onUpdate, _ctx) => {
			const file = path.join(cwd, ".projectmem", "summary.md");
			if (!existsSync(file)) {
				return textResult(
					"mem_read: memoria del proyecto no inicializada. Para empezar a registrar decisiones y lecciones ejecuta `pjm init` en el proyecto (crea `.projectmem/` con hooks locales; no contamina el repo hasta que decidas qué guardar).",
				);
			}
			let raw: string;
			try {
				raw = readFileSync(file, "utf8");
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				return textResult(`mem_read: no se pudo leer .projectmem/summary.md: ${msg}`);
			}
			let body = raw.trim();
			if (params.section) {
				const needle = params.section.toLowerCase();
				const lines = body.split("\n");
				const hits = lines.filter((l) => l.toLowerCase().includes(needle));
				body = hits.length ? hits.join("\n") : `(sin coincidencias para "${params.section}")`;
			}
			if (body.length > MAX_BRIEFING_CHARS) {
				const suffix = `\n\n[…resumen truncado: ${body.length}→${MAX_BRIEFING_CHARS} chars]`;
				body = body.slice(0, MAX_BRIEFING_CHARS - suffix.length) + suffix;
			}
			return textResult(body);
		},
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// mem_log
// ──────────────────────────────────────────────────────────────────────────────

const MemLogType = Type.Union([
	Type.Literal("issue"),
	Type.Literal("attempt"),
	Type.Literal("fix"),
	Type.Literal("decision"),
	Type.Literal("note"),
]);

const MemLogParams = Type.Object({
	type: MemLogType,
	text: Type.String({ description: "Texto principal de la entrada. Para `attempt`, describe qué se intentó; para `fix`, la solución; para `decision`, la opción tomada." }),
	at: Type.Optional(Type.String({ description: "Ubicación (file:line, módulo.método). Opcional." })),
	outcome: Type.Optional(
		Type.Union([Type.Literal("worked"), Type.Literal("failed"), Type.Literal("partial")], {
			description: "Sólo para `type=attempt`. --worked / --failed / --partial.",
		}),
	),
	issue: Type.Optional(Type.String({ description: "Sólo para `type=attempt`. ID de issue al que se asocia (p. ej. 0042)." })),
});

function buildMemLogTool(cwd: string): ToolDefinition<typeof MemLogParams> {
	return {
		name: "mem_log",
		label: "mem_log",
		description:
			"Registra una entrada en la memoria operativa del proyecto (`.projectmem/`). Tipos: `issue` (problema abierto), `attempt` (intento con --worked/--failed/--partial), `fix` (solución que cierra issue), `decision` (decisión durable, opcionalmente supersedes anterior), `note` (nota libre). ÚSALO SÓLO para conocimiento operativo durable entre sesiones; NO para ruido (cada turno no es una entrada).",
		promptSnippet: "mem_log <type> <text> — registra en la memoria operativa del proyecto",
		parameters: MemLogParams,
		execute: async (_id, params, signal, _onUpdate, _ctx) => {
			const cli = "pjm";
			// projectmem llama `log` al comando que inicia un issue.
			const args: string[] = [params.type === "issue" ? "log" : params.type];
			if (params.type === "attempt") {
				const outcome = params.outcome ?? "partial";
				const flag = outcome === "worked" ? "--worked" : outcome === "failed" ? "--failed" : "--partial";
				args.push(flag);
				if (params.issue) args.push("--issue", params.issue);
			}
			if (params.at) args.push("--at", params.at);
			args.push(params.text);
			const r = await runCli(cli, args, cwd, MEM_TIMEOUT_MS, signal);
			if (r.notFound) {
				return textResult("mem_log: pjm CLI no instalado. Instalar con `uv tool install projectmem` (o `pipx install projectmem`) y reiniciar.");
			}
			if (r.code !== 0) {
				const tail = (r.stderr || r.stdout || "").trim().slice(-300);
				return textResult(`mem_log: pjm ${params.type} salió con código ${r.code}${r.signal ? ` (signal=${r.signal})` : ""}: ${tail}`);
			}
			const out = (r.stdout || r.stderr || "").trim() || `registrado en memoria: ${params.type}`;
			return textResult(out);
		},
	};
}

// ──────────────────────────────────────────────────────────────────────────────
// Builder público
// ──────────────────────────────────────────────────────────────────────────────

export type { ToolDefinition };

/** Devuelve las `customTools` activas según disponibilidad. La capacidad (allowlist) decide cuáles
 *  entran en cada worker; aquí sólo construimos las herramientas disponibles en este `cwd`. */
export function buildCustomTools(avail: Availability): ToolDefinition[] {
	const tools: ToolDefinition[] = [];
	// code_explore: requiere CLI codegraph + índice presente (o que se haya decidido auto-init aparte).
	if (avail.codegraph === "ready") {
		tools.push(buildCodeExploreTool(avail.cwd));
	}
	// mem_read: requiere pjm CLI; si la memoria no está inicializada, la tool responde con sugerencia.
	if (avail.projectmem !== "missing") {
		tools.push(buildMemReadTool(avail.cwd));
	}
	// mem_log: igual que mem_read, requiere pjm CLI presente.
	if (avail.projectmem !== "missing") {
		tools.push(buildMemLogTool(avail.cwd));
	}
	return tools;
}

/** Nombres de tools registradas, derivados del mismo `Availability`. Útil para construir las
 *  allowlists por capability dinámicamente sin duplicar la lógica de disponibilidad. */
export function toolNamesFor(avail: Availability): { code_explore: boolean; mem_read: boolean; mem_log: boolean } {
	return {
		code_explore: avail.codegraph === "ready",
		mem_read: avail.projectmem !== "missing",
		mem_log: avail.projectmem !== "missing",
	};
}
