// src/config.ts — carga y valida aies.config.json (provider + modelos por rol; SIN claves).
// Versionado en el paquete. Claves por env (ANTHROPIC_API_KEY etc.), leídas por ModelRuntime.create() (ADR-009).

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { z } from "zod";

/** Política de verificación determinista + reparación acotada (fuera del state machine). */
export interface VerificationPolicy {
	/** Ejecutar checks deterministas del proyecto tras el implementer antes de gastar verifier LLM. */
	deterministic: boolean;
	/** Máximo de ciclos de reparación focalizada del implementer ante fallo determinista. */
	maxRepairAttempts: number;
	/** Timeout duro por check (ms). Los comandos scriptados no siempre saben que deben parar. */
	checkTimeoutMs: number;
}

export const DEFAULT_VERIFICATION: VerificationPolicy = {
	deterministic: true,
	maxRepairAttempts: 3,
	checkTimeoutMs: 30_000,
};

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
		// strict:false (omitido) — claves de schema vecinas (p. ej. `repair.*` antiguas) en un
		// config versionado NO deben reventar el arranque; zod las descarta en silencio.
		repair: z
			.object({
				deterministic: z.boolean().optional(),
				maxRepairAttempts: z.number().int().min(0).max(10).optional(),
				checkTimeoutMs: z.number().int().positive().max(600_000).optional(),
			})
			.partial()
			.optional(),
	});

export interface Config {
	provider: string;
	models: Partial<Record<"orchestrator" | "explorer" | "implementer" | "verifier", string>>;
	orchestratorThinkingLevel: "off" | "low" | "medium" | "high";
	limits?: { maxIterations?: number | undefined };
	repair?: {
		deterministic?: boolean | undefined;
		maxRepairAttempts?: number | undefined;
		checkTimeoutMs?: number | undefined;
	} | undefined;
}

/** Traduce el bloque `repair` del config a la política usada por `buildExecute`. */
export function verificationFromConfig(cfg: { repair?: Config["repair"] } | undefined): VerificationPolicy {
	return {
		deterministic: cfg?.repair?.deterministic ?? DEFAULT_VERIFICATION.deterministic,
		maxRepairAttempts: cfg?.repair?.maxRepairAttempts ?? DEFAULT_VERIFICATION.maxRepairAttempts,
		checkTimeoutMs: cfg?.repair?.checkTimeoutMs ?? DEFAULT_VERIFICATION.checkTimeoutMs,
	};
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