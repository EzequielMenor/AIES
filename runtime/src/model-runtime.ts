// src/model-runtime.ts — runtime de modelos/autenticación de AIES.
//
// Envuelve `ModelRuntime` de pi-coding-agent con:
//   - ruta de credenciales propia (`~/.config/aies/auth.json`, override `AIES_AUTH`)
//   - catálogo sin red (`refreshOnCreate: false`, `allowModelNetwork: false`)
//   - helpers de resolución `provider/model-id` por rol
//
// La ruta propia evita colisión con `~/.pi/agent/auth.json` (la instalación de `install.sh`
// clona en `~/.aies`, así que `~/.aies/auth.json` mezclaría credenciales con el árbol git).
//
// El singleton se cachea por proceso; tests construyen su propio runtime con mocks/stubs.

import { homedir } from "node:os";
import * as path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { Config } from "./config.js";

export type Role = "orchestrator" | "explorer" | "implementer" | "verifier";

export const ROLES: readonly Role[] = ["orchestrator", "explorer", "implementer", "verifier"] as const;

export function isRole(value: string): value is Role {
	return (ROLES as readonly string[]).includes(value);
}

/** `~/.config/aies/auth.json` por defecto; override por `AIES_AUTH` (tests). */
export function getAiesAuthPath(): string {
	if (process.env.AIES_AUTH) return process.env.AIES_AUTH;
	return path.join(homedir(), ".config", "aies", "auth.json");
}

let cachedRuntime: Promise<ModelRuntime> | null = null;

/** Singleton por proceso de `ModelRuntime` con la ruta propia de AIES. Catálogo estático (sin red). */
export function getAiesModelRuntime(): Promise<ModelRuntime> {
	if (!cachedRuntime) {
		cachedRuntime = ModelRuntime.create({
			authPath: getAiesAuthPath(),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
	}
	return cachedRuntime;
}

/** Test helper: descarta el singleton para que la siguiente llamada cree otro. */
export function resetAiesModelRuntimeCache(): void {
	cachedRuntime = null;
}

export interface ModelRef {
	provider: string;
	modelId: string;
}

/** Parsea `provider/model-id` (o sólo `model-id` → provider por defecto). Trim y lower-case del provider. */
export function parseModelRef(ref: string, defaultProvider: string): ModelRef {
	const trimmed = ref.trim();
	if (!trimmed) throw new Error("referencia de modelo vacía");
	const slash = trimmed.indexOf("/");
	if (slash === -1) return { provider: defaultProvider.trim(), modelId: trimmed };
	const provider = trimmed.slice(0, slash).trim().toLowerCase();
	const modelId = trimmed.slice(slash + 1).trim();
	if (!provider) throw new Error(`referencia de modelo inválida (provider vacío): ${ref}`);
	if (!modelId) throw new Error(`referencia de modelo inválida (model-id vacío): ${ref}`);
	return { provider, modelId };
}

/** Resuelve los 4 roles contra el catálogo. Modelo inexistente → undefined (degradación visible). */
export interface ResolvedRoleModels {
	orchestrator: ResolvedModel | undefined;
	explorer: ResolvedModel | undefined;
	implementer: ResolvedModel | undefined;
	verifier: ResolvedModel | undefined;
	warnings: string[];
}

export type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** API mínima del runtime que AIES usa (subset). Permite inyectar mocks en tests. */
export interface AiesModelRuntimeLike {
	getProviders(): readonly { id: string; displayName?: string }[];
	getModels(providerId?: string): readonly ResolvedModel[];
	getModel(providerId: string, modelId: string): ResolvedModel | undefined;
	hasConfiguredAuth(providerId: string): boolean;
}

export function resolveRoleModels(
	cfg: Pick<Config, "provider" | "models">,
	runtime: AiesModelRuntimeLike,
): ResolvedRoleModels {
	const out: ResolvedRoleModels = {
		orchestrator: undefined,
		explorer: undefined,
		implementer: undefined,
		verifier: undefined,
		warnings: [],
	};
	for (const role of ROLES) {
		const ref = cfg.models[role];
		if (!ref) continue;
		let parsed: ModelRef;
		try {
			parsed = parseModelRef(ref, cfg.provider);
		} catch (e) {
			out.warnings.push(`${role}: ${e instanceof Error ? e.message : String(e)}`);
			continue;
		}
		const model = runtime.getModel(parsed.provider, parsed.modelId);
		if (!model) {
			out.warnings.push(`${role}: modelo "${ref}" no encontrado en el catálogo`);
			continue;
		}
		out[role] = model;
	}
	return out;
}