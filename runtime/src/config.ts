// src/config.ts — carga y valida aies.config.json (provider + modelos por rol; SIN claves).
// Versionado en el paquete. Claves por env (ANTHROPIC_API_KEY etc.), leídas por ModelRuntime.create() (ADR-009).

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

const ConfigSchema = z
	.object({
		provider: z.string().min(1).default("anthropic"),
		models: z
			.object({
				orchestrator: z.string(),
				explorer: z.string(),
				implementer: z.string(),
				verifier: z.string(),
			})
			.partial(),
		orchestratorThinkingLevel: z.enum(["off", "low", "medium", "high"]).default("low"),
		limits: z.object({ maxIterations: z.number().int().positive() }).partial().optional(),
	})
	.strict();

export interface Config {
	provider: string;
	models: Partial<Record<"orchestrator" | "explorer" | "implementer" | "verifier", string>>;
	orchestratorThinkingLevel: "off" | "low" | "medium" | "high";
	limits?: { maxIterations?: number | undefined };
}

/** Resuelve la ruta de aies.config.json (AIES_CONFIG env override, o raíz del paquete). */
export function defaultConfigPath(): string {
	if (process.env.AIES_CONFIG) return process.env.AIES_CONFIG;
	// dist/ → ../aies.config.json (raíz del paquete)
	const here = import.meta.dirname ?? process.cwd();
	return path.join(here, "..", "aies.config.json");
}

export function loadConfig(configPath: string = defaultConfigPath()): Config {
	if (!existsSync(configPath)) {
		throw new Error(`aies.config.json no encontrado en ${configPath} (pon ahí provider+modelos; las claves van por env).`);
	}
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch (e) {
		throw new Error(`no se pudo leer ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		throw new Error(`aies.config.json malformado: ${e instanceof Error ? e.message : String(e)}`);
	}
	const result = ConfigSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
		throw new Error(`aies.config.json inválido: ${issues}`);
	}
	return result.data as Config;
}