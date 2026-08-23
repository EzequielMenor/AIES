// src/cli-models.ts — `/models` + `/pick` (REPL) y `aies models` / `aies pick` (oneshot).
//
// `formatModels` agrupa por proveedor (orden alfabético) con marcas de auth y rol.
// `runPick` valida ref contra el catálogo y escribe aies.config.json atómicamente.

import { copyFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import { isRole, parseModelRef, ROLES, type AiesModelRuntimeLike } from "./model-runtime.js";

/** Tipo del runtime que AIES usa en estos comandos. Alias para no atar a ModelRuntime directamente
 *  en las firmas (los tests inyectan mocks). */
type Runtime = AiesModelRuntimeLike;

/** Formato humano del catálogo. Agrupado por proveedor, marca de auth y rol asignado. */
export function formatModels(runtime: Runtime, cfg: Config): string {
	const lines: string[] = [];
	const providers = [...runtime.getProviders()].sort((a, b) => a.id.localeCompare(b.id));

	const assignedByProvider = new Map<string, Set<string>>();
	for (const role of ROLES) {
		const ref = cfg.models[role];
		if (!ref) continue;
		try {
			const parsed = parseModelRef(ref, cfg.provider);
			const set = assignedByProvider.get(parsed.provider) ?? new Set<string>();
			set.add(parsed.modelId);
			assignedByProvider.set(parsed.provider, set);
		} catch {
			/* ignore — el warning va en preflight */
		}
	}

	let anyAuth = false;
	for (const p of providers) {
		const auth = runtime.hasConfiguredAuth(p.id);
		if (auth) anyAuth = true;
		const authMark = auth ? "✓" : "✗";
		const display = p.displayName ? `${p.id} (${p.displayName})` : p.id;
		lines.push(`${authMark} ${display}`);
		const models = runtime.getModels(p.id);
		for (const m of models) {
			const assigned = assignedByProvider.get(p.id)?.has(m.id) ? " ◆" : "";
			lines.push(`    - ${m.id}${assigned}`);
		}
		lines.push("");
	}

	if (!anyAuth) {
		lines.push("ningún proveedor con auth configurada — ejecuta `/login` o define variables de entorno.");
	}

	return lines.join("\n").replace(/\n+$/, "\n");
}

/** Wrapper para el REPL/oneshot — devuelve el texto ya con newline final. */
export function runModelsCommand(runtime: Runtime, cfg: Config): string {
	return formatModels(runtime, cfg);
}

/** Argumentos parseados para `/pick`. */
export type PickArgs =
	| { kind: "show" }
	| { kind: "pick-role"; role: typeof ROLES[number] }
	| { kind: "assign"; role: typeof ROLES[number]; ref: string };

export function parsePickArgs(rest: string): PickArgs {
	const trimmed = rest.trim();
	if (!trimmed) return { kind: "show" };
	const parts = trimmed.split(/\s+/);
	if (parts.length === 1) {
		if (!isRole(parts[0]!)) {
			throw new Error(`rol desconocido: ${parts[0]} (válidos: ${ROLES.join(", ")})`);
		}
		return { kind: "pick-role", role: parts[0] };
	}
	if (!isRole(parts[0]!)) {
		throw new Error(`rol desconocido: ${parts[0]} (válidos: ${ROLES.join(", ")})`);
	}
	return { kind: "assign", role: parts[0], ref: parts.slice(1).join(" ") };
}

/** Escribe aies.config.json de forma atómica: tmp + rename + .bak. */
function writeConfigAtomic(configPath: string, data: unknown): void {
	const bak = `${configPath}.bak`;
	if (existsSync(configPath)) {
		try {
			copyFileSync(configPath, bak);
		} catch {
			/* best-effort */
		}
	}
	const tmp = `${configPath}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	renameSync(tmp, configPath);
}

/** Sugerencias difusas simples por substring del model id. */
function suggestModels(runtime: Runtime, partial: string): string[] {
	const target = partial.toLowerCase();
	const out: string[] = [];
	for (const p of runtime.getProviders()) {
		for (const m of runtime.getModels(p.id)) {
			if (m.id.toLowerCase().includes(target)) out.push(`${p.id}/${m.id}`);
		}
	}
	return out.slice(0, 8);
}

/** Tabla rol → modelo resuelto (mismo formato que `formatModels` por sección). */
function formatRoleTable(runtime: Runtime, cfg: Config): string {
	const lines: string[] = [];
	for (const role of ROLES) {
		const ref = cfg.models[role] ?? "(por defecto)";
		let resolved = "(por defecto)";
		let provider = cfg.provider;
		let auth = false;
		try {
			const parsed = parseModelRef(ref, cfg.provider);
			provider = parsed.provider;
			const m = runtime.getModel(parsed.provider, parsed.modelId);
			if (m) resolved = m.id;
			auth = runtime.hasConfiguredAuth(parsed.provider);
		} catch {
			resolved = "(ref inválida)";
		}
		const authMark = auth ? "✓" : "✗";
		lines.push(`${role.padEnd(13)} ${ref.padEnd(28)} → ${resolved}  [${authMark} ${provider}]`);
	}
	return lines.join("\n");
}

/** Lista numerada de modelos con auth (los que el usuario podría querer asignar). */
function formatAssignableModels(runtime: Runtime): { text: string; ids: string[] } {
	const providers = [...runtime.getProviders()].sort((a, b) => a.id.localeCompare(b.id));
	const lines: string[] = [];
	let i = 1;
	const ids: string[] = [];
	for (const p of providers) {
		if (!runtime.hasConfiguredAuth(p.id)) continue;
		for (const m of runtime.getModels(p.id)) {
			lines.push(`  ${String(i).padStart(3)}) ${p.id}/${m.id}`);
			ids.push(`${p.id}/${m.id}`);
			i += 1;
		}
	}
	if (ids.length === 0) {
		lines.push("  (ningún proveedor con auth — ejecuta `/login` o define env vars primero)");
	}
	return { text: lines.join("\n"), ids };
}

/** Handler unificado de REPL + oneshot. `rl` puede ser null en oneshot. */
export async function runPickCommand(
	rl: readline.Interface | null,
	runtime: Runtime,
	cfg: Config,
	configPath: string,
	rest: string,
): Promise<void> {
	const out = output;
	let args: PickArgs;
	try {
		args = parsePickArgs(rest);
	} catch (e) {
		out.write(`aies: ${e instanceof Error ? e.message : String(e)}\n`);
		return;
	}

	if (args.kind === "show") {
		out.write("rol          ref                           → modelo resuelto        auth\n");
		out.write(`${formatRoleTable(runtime, cfg)}\n`);
		return;
	}

	if (args.kind === "pick-role") {
		out.write(`modelos disponibles con auth para el rol "${args.role}":\n`);
		const { text, ids } = formatAssignableModels(runtime);
		out.write(`${text}\n`);
		if (rl && ids.length > 0) {
			const ans = await rl.question(`número o "provider/model-id" (Enter cancela): `);
			const trimmed = ans.trim();
			if (!trimmed) return;
			let chosen: string | undefined;
			const n = Number(trimmed);
			if (Number.isInteger(n) && n >= 1 && n <= ids.length) {
				chosen = ids[n - 1]!;
			} else if (ids.includes(trimmed)) {
				chosen = trimmed;
			} else {
				const suggestions = suggestModels(runtime, trimmed);
				out.write(`aies: selección inválida.${suggestions.length ? ` ¿Quisiste decir? ${suggestions.join(", ")}?` : ""}\n`);
				return;
			}
			args = { kind: "assign", role: args.role, ref: chosen };
		}
		if (!rl || args.kind !== "assign") return;
	}

	if (args.kind === "assign") {
		let parsed;
		try {
			parsed = parseModelRef(args.ref, cfg.provider);
		} catch (e) {
			out.write(`aies: ${e instanceof Error ? e.message : String(e)}\n`);
			return;
		}
		const model = runtime.getModel(parsed.provider, parsed.modelId);
		if (!model) {
			const suggestions = suggestModels(runtime, parsed.modelId);
			out.write(`aies: modelo "${args.ref}" no encontrado en el catálogo.${suggestions.length ? ` ¿Quisiste decir? ${suggestions.join(", ")}.` : ""}\n`);
			return;
		}
		if (!runtime.hasConfiguredAuth(parsed.provider)) {
			out.write(`aies: ⚠ el proveedor "${parsed.provider}" no tiene auth configurada — el modelo se guardará pero el runtime degradará.\n`);
		}
		const updated: Config = {
			...cfg,
			models: { ...cfg.models, [args.role]: args.ref },
		};
		try {
			writeConfigAtomic(configPath, updated);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			out.write(`aies: error escribiendo config: ${msg}\n`);
			return;
		}
		// Re-validar
		try {
			loadConfig(configPath);
		} catch (e) {
			out.write(`aies: ⚠ re-validación de aies.config.json falló: ${e instanceof Error ? e.message : String(e)}\n`);
			return;
		}
		out.write(`aies: ${args.role} → ${args.ref} (modelo ${model.id}). Configuración guardada en ${configPath}.\n`);
		// Asegurar permisos restrictivos del .bak si existe
		const bak = `${configPath}.bak`;
		if (existsSync(bak)) {
			try {
				const { chmodSync } = require("node:fs") as typeof import("node:fs");
				chmodSync(bak, 0o600);
			} catch {
				/* best-effort */
			}
		}
	}
}

// helper no usado pero dejado por simetría
export const _configDirHint = (): string => path.dirname("aies.config.json");