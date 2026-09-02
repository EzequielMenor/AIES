// src/model-runtime.ts — helpers de referencia provider/model-id (parseModelRef, ROLES, isRole).
//
// La creación del ModelRuntime vive en `./auth.ts` (singleton compartido con el resto del
// proceso). Este módulo sólo aporta utilidades de parsing/validación usadas por `/pick`,
// `/models`, preflight y los tests.

export type Role = "orchestrator" | "explorer" | "implementer" | "verifier";

export const ROLES: readonly Role[] = ["orchestrator", "explorer", "implementer", "verifier"] as const;

export function isRole(value: string): value is Role {
	return (ROLES as readonly string[]).includes(value);
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

/** Tipo `Model<Api>` de pi-ai — sólo lo necesitamos como opaco para las firmas de helpers. */
export type ResolvedModel = NonNullable<ReturnType<typeof import("@earendil-works/pi-coding-agent").ModelRuntime.prototype.getModel>>;

/** Interfaz mínima del runtime que AIES usa. Permite inyectar mocks en tests. */
export interface AiesModelRuntimeLike {
	getProviders(): readonly { id: string; displayName?: string }[];
	getModels(providerId?: string): readonly ResolvedModel[];
	getModel(providerId: string, modelId: string): ResolvedModel | undefined;
	hasConfiguredAuth(providerId: string): boolean;
}

/**
 * Busca un modelo por id cruzando TODOS los providers con auth configurada. Se usa en `/model
 * <query>` para que el usuario no necesite saber el provider de antemano.
 *
 * Coincidencia por `id` exacto (case-insensitive) devuelve el primero; si no hay coincidencia
 * exacta, se devuelve el match por substring (también case-insensitive). `null` cuando nada
 * coincide.
 *
 * El orden de providers se respeta (estable por id).
 */
export function findModelAcrossProviders(
	runtime: AiesModelRuntimeLike,
	query: string,
): ResolvedModel | null {
	const needle = query.trim().toLowerCase();
	if (!needle) return null;
	const providers = [...runtime.getProviders()].sort((a, b) => a.id.localeCompare(b.id));
	let fallback: ResolvedModel | null = null;
	for (const p of providers) {
		if (!runtime.hasConfiguredAuth(p.id)) continue;
		const models = runtime.getModels(p.id);
		for (const model of models) {
			if (model.id.toLowerCase() === needle) return model;
			if (!fallback && model.id.toLowerCase().includes(needle)) fallback = model;
		}
	}
	return fallback;
}