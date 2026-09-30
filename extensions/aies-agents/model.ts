/**
 * Model resolution for Explore, Worker and Verify child agents.
 *
 * Resolution order:
 * 1. Environment variable: AIES_EXPLORE_MODEL / AIES_WORKER_MODEL / AIES_VERIFY_MODEL
 * 2. Configuration file: $AIES_AGENT_DIR/aies.json (agents.<role>.model)
 * 3. Parent model: ctx.model
 *
 * Independence between Worker and Verify does not depend on using a different
 * model: it comes from a fresh context, a different prompt, the real artifact and
 * the absence of the Worker transcript. A different model can be configured, but
 * it is not required.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeThinkingLevel, type AiesThinkingLevel } from "../aies-models/capabilities.ts";

export type AgentRole = "explore" | "worker" | "verify";

const ROLE_ENV_VAR: Record<AgentRole, string> = {
  explore: "AIES_EXPLORE_MODEL",
  worker: "AIES_WORKER_MODEL",
  verify: "AIES_VERIFY_MODEL",
};

/**
 * An explicit role model (env or `aies.json`) that the parent registry could not
 * resolve. It is a routing/protocol fault, never a silent parent-model fallback:
 * the caller must surface it instead of running the wrong model (EZE-454).
 */
export class AgentModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelResolutionError";
  }
}

/**
 * Resolve a `provider/model` (or bare model id) through either Pi's extension
 * `ModelRegistry` facade (`find` / `getAvailable` / `getAll`) or a session
 * `ModelRuntime` (`getModel` / `getModels`). Both public shapes are supported so
 * the delegating parent can pass `ctx.modelRegistry`.
 */
function findModel(modelRuntime: any, spec: string): any {
  if (!modelRuntime || !spec) return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;

  const slash = trimmed.indexOf("/");
  const provider = slash > 0 ? trimmed.slice(0, slash) : undefined;
  const modelId = slash > 0 ? trimmed.slice(slash + 1) : trimmed;

  // ModelRegistry facade.
  if (provider && typeof modelRuntime.find === "function") {
    const model = modelRuntime.find(provider, modelId);
    if (model) return model;
  }
  for (const method of ["getAvailable", "getAll"]) {
    if (typeof modelRuntime[method] !== "function") continue;
    let models: any[] = [];
    try {
      const value = modelRuntime[method]();
      // A session ModelRuntime exposes an async getAvailable(); skip it here and
      // let the getModel/getModels branch below handle that shape.
      if (Array.isArray(value)) models = value;
      else continue;
    } catch {
      continue;
    }
    const model = models.find((m: any) => m.id === modelId || `${m.provider}/${m.id}` === trimmed);
    if (model) return model;
  }

  // Session ModelRuntime.
  if (provider && typeof modelRuntime.getModel === "function") {
    const model = modelRuntime.getModel(provider, modelId);
    if (model) return model;
  }
  if (typeof modelRuntime.getModels === "function") {
    const models = modelRuntime.getModels() ?? [];
    return models.find((m: any) => m.id === modelId || `${m.provider}/${m.id}` === trimmed);
  }
  return undefined;
}

/**
 * Resolve the display label for a provider id through the caller's registry or
 * session runtime. The label must derive from the CHILD's own provider id, never
 * from the parent's model: presentation only — a missing runtime, a missing
 * method, an empty label or a throwing runtime degrades to `null` and never
 * fails a delegation (EZE-487).
 */
export function providerDisplayLabel(
  modelRuntime: { getProviderDisplayName?: (provider: string) => string } | null | undefined,
  providerId: string | null | undefined,
): string | null {
  if (!modelRuntime || !providerId) return null;
  try {
    const label = modelRuntime.getProviderDisplayName?.(providerId);
    return typeof label === "string" && label.trim() ? label.trim() : null;
  } catch {
    return null;
  }
}

interface AgentConfig {
  model?: string;
  thinkingLevel?: string;
}

/**
 * Read one role's stored preference. `agents.<role>` is the current shape;
 * `delegate.<role>` is kept as a compatibility fallback.
 */
function readConfig(agentDir: string, role: AgentRole): AgentConfig {
  const configPath = join(agentDir, "aies.json");
  if (!existsSync(configPath)) return {};

  try {
    const content = JSON.parse(readFileSync(configPath, "utf8"));
    const agents = content.agents?.[role];
    const delegate = content.delegate?.[role];
    const modelSpec = agents?.model ?? delegate?.model;
    const thinking = agents?.thinkingLevel ?? delegate?.thinkingLevel;
    return {
      model: typeof modelSpec === "string" && modelSpec.trim() ? modelSpec.trim() : undefined,
      thinkingLevel: typeof thinking === "string" && thinking.trim() ? thinking.trim() : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolve the Model instance for a specific child agent role.
 *
 * An explicitly configured role model (env or `aies.json`) that cannot resolve
 * through the supplied registry fails with `AgentModelResolutionError`. Only the
 * absence of an explicit configuration falls back to the parent session model.
 */
export async function resolveAgentModel(
  role: AgentRole,
  modelRuntime: any,
  parentModel: any,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<any> {
  // 1. Environment variable override. Explicit means required: unresolved is a fault.
  const envModel = env[ROLE_ENV_VAR[role]]?.trim();
  if (envModel) {
    const model = findModel(modelRuntime, envModel);
    if (model) return model;
    throw new AgentModelResolutionError(
      `Configured ${role} model "${envModel}" (${ROLE_ENV_VAR[role]}) could not be resolved through the parent model registry. Refusing to fall back to the parent model.`,
    );
  }

  // 2. Profile configuration: aies.json. Explicit means required.
  const configModel = readConfig(agentDir, role).model;
  if (configModel) {
    const model = findModel(modelRuntime, configModel);
    if (model) return model;
    throw new AgentModelResolutionError(
      `Configured ${role} model "${configModel}" (aies.json agents.${role}.model) could not be resolved through the parent model registry. Refusing to fall back to the parent model.`,
    );
  }

  // 3. No explicit configuration: fall back to the parent session model.
  return parentModel;
}

/**
 * Resolve the configured thinking level for a role, validated against the
 * resolved model's capabilities. A configured level the model cannot run is
 * never returned: the child then falls back to Pi's own default.
 */
export function resolveAgentThinkingLevel(
  role: AgentRole,
  model: any,
  agentDir: string,
): AiesThinkingLevel | undefined {
  const configured = readConfig(agentDir, role).thinkingLevel;
  if (!configured) return undefined;
  return normalizeThinkingLevel(model, configured);
}

/**
 * Resolve the Model instance for the Explore child agent.
 */
export async function resolveExploreModel(
  modelRuntime: any,
  parentModel: any,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<any> {
  return resolveAgentModel("explore", modelRuntime, parentModel, agentDir, env);
}

/**
 * Resolve the Model instance for the Worker child agent.
 */
export async function resolveWorkerModel(
  modelRuntime: any,
  parentModel: any,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<any> {
  return resolveAgentModel("worker", modelRuntime, parentModel, agentDir, env);
}

/**
 * Resolve the Model instance for the Verify child agent.
 */
export async function resolveVerifyModel(
  modelRuntime: any,
  parentModel: any,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<any> {
  return resolveAgentModel("verify", modelRuntime, parentModel, agentDir, env);
}
