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

// ──────────────────────────────────────────────────────────────────────────────
// Resolución estricta de modelo por rol (MVP: model-per-role real).
//
// Reglas (autoridad superior al plan):
//   - Un rol con elección EXPLÍCITA (models.<rol> en config, o AIES_MODEL) que no exista,
//     no esté en el catálogo o carezca de autenticación → ERROR ACCIONABLE. Nunca fallback
//     silencioso.
//   - Los defaults sólo se usan cuando el rol NO tiene elección explícita:
//     política de default = modelo del orchestrator (ref → resolución, no instancia) y,
//     si el orchestrator tampoco tiene ref, undefined (default del runtime de pi).
// ──────────────────────────────────────────────────────────────────────────────

export type RoleModels = Record<Role, ResolvedModel | undefined>;

export type RoleModelFailureReason = "invalid_ref" | "unknown_provider" | "model_not_found" | "no_auth";

export interface RoleModelFailure {
	role: Role;
	ref: string;
	provider: string;
	modelId: string;
	reason: RoleModelFailureReason;
	/** Mensaje accionable: indica rol, provider y modelo + qué hacer. */
	message: string;
}

export interface RoleModelResolution {
	models: RoleModels;
	failures: RoleModelFailure[];
	/** Ref canónica usada por rol (para banner//status): la explícita o la heredada del default. */
	refs: Record<Role, string | undefined>;
}

export interface RoleResolutionConfig {
	provider: string;
	models: Partial<Record<Role, string>>;
}

interface SingleResolution {
	model?: ResolvedModel;
	failure?: RoleModelFailure;
}

function resolveOne(
	role: Role,
	ref: string,
	runtime: AiesModelRuntimeLike,
	defaultProvider: string,
	envHint?: (provider: string) => string | undefined,
): SingleResolution {
	let parsed: ModelRef;
	try {
		parsed = parseModelRef(ref, defaultProvider);
	} catch (e) {
		return {
			failure: {
				role,
				ref,
				provider: defaultProvider,
				modelId: ref,
				reason: "invalid_ref",
				message: `rol "${role}": referencia de modelo inválida "${ref}" — usa "provider/model-id" (${e instanceof Error ? e.message : String(e)}).`,
			},
		};
	}
	const knownProvider = runtime.getProviders().some((p) => p.id === parsed.provider);
	if (!knownProvider) {
		return {
			failure: {
				role,
				ref,
				provider: parsed.provider,
				modelId: parsed.modelId,
				reason: "unknown_provider",
				message: `rol "${role}" usa "${ref}": provider "${parsed.provider}" no existe en este runtime. Comprueba providers con "aies auth" y modelos con "/models".`,
			},
		};
	}
	if (!runtime.hasConfiguredAuth(parsed.provider)) {
		const env = envHint?.(parsed.provider);
		return {
			failure: {
				role,
				ref,
				provider: parsed.provider,
				modelId: parsed.modelId,
				reason: "no_auth",
				message: `rol "${role}" usa "${ref}": el provider "${parsed.provider}" no está autenticado. Ejecuta "aies login ${parsed.provider}"${env ? ` o exporta ${env}` : ""}.`,
			},
		};
	}
	const model = runtime.getModel(parsed.provider, parsed.modelId);
	if (!model) {
		return {
			failure: {
				role,
				ref,
				provider: parsed.provider,
				modelId: parsed.modelId,
				reason: "model_not_found",
				message: `rol "${role}" usa "${ref}": el modelo "${parsed.modelId}" no existe en el catálogo de "${parsed.provider}". Lista disponibles con "/models @${parsed.provider}" y reasigna con "/model ${role} <provider/model-id>".`,
			},
		};
	}
	return { model };
}

/**
 * Resuelve los cuatro roles contra el catálogo real del runtime. NO lanza: devuelve fallos
 * acumulados para que el CLI los muestre todos a la vez y salga con un error accionable.
 *
 * `overrideRef` (AIES_MODEL) cuenta como elección explícita para TODOS los roles.
 */
export function resolveRoleModels(
	runtime: AiesModelRuntimeLike,
	cfg: RoleResolutionConfig,
	opts: { overrideRef?: string | undefined; envHint?: (provider: string) => string | undefined } = {},
): RoleModelResolution {
	const models = {} as RoleModels;
	const refs = {} as Record<Role, string | undefined>;
	const failures: RoleModelFailure[] = [];

	// 1) Orchestrator primero: es la política de default para roles sin elección explícita.
	const orchestratorRef = opts.overrideRef ?? cfg.models.orchestrator;
	let orchestrator: ResolvedModel | undefined;
	if (orchestratorRef) {
		const r = resolveOne("orchestrator", orchestratorRef, runtime, cfg.provider, opts.envHint);
		if (r.failure) failures.push(r.failure);
		orchestrator = r.model;
	}
	models.orchestrator = orchestrator;
	refs.orchestrator = orchestratorRef;

	// 2) Roles de workers: ref explícita → estricta; sin ref → default policy (orchestrator).
	for (const role of ROLES) {
		if (role === "orchestrator") continue;
		const ref = opts.overrideRef ?? cfg.models[role];
		if (!ref) {
			// Sin elección explícita → hereda el orchestrator resuelto (undefined = default de pi).
			models[role] = orchestrator;
			refs[role] = orchestratorRef;
			continue;
		}
		const r = resolveOne(role, ref, runtime, cfg.provider, opts.envHint);
		if (r.failure) failures.push(r.failure);
		models[role] = r.model;
		refs[role] = ref;
	}
	return { models, failures, refs };
}

/** Etiqueta legible `provider/model-id` de un rol resuelto (o undefined si usa default de pi). */
export function roleModelLabel(model: ResolvedModel | undefined): string | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}