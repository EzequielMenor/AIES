/**
 * Model resolution for Explore and Worker child agents.
 *
 * Resolution order:
 * 1. Environment variable: AIES_EXPLORE_MODEL / AIES_WORKER_MODEL
 * 2. Configuration file: $AIES_AGENT_DIR/aies.json (agents.<role>.model)
 * 3. Parent model: ctx.model
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function findModel(modelRuntime: any, spec: string): any {
  if (!modelRuntime || !spec) return undefined;
  const trimmed = spec.trim();
  if (!trimmed) return undefined;

  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const provider = trimmed.slice(0, slash);
    const modelId = trimmed.slice(slash + 1);
    const model = modelRuntime.getModel?.(provider, modelId);
    if (model) return model;
  }

  const models = modelRuntime.getModels ? modelRuntime.getModels() : [];
  return models.find((m: any) => m.id === trimmed || `${m.provider}/${m.id}` === trimmed);
}

function readConfigModel(agentDir: string, role: "explore" | "worker"): string | undefined {
  const configPath = join(agentDir, "aies.json");
  if (!existsSync(configPath)) return undefined;

  try {
    const content = JSON.parse(readFileSync(configPath, "utf8"));
    const modelSpec =
      content.agents?.[role]?.model ??
      content.delegate?.[role]?.model;
    return typeof modelSpec === "string" && modelSpec.trim() ? modelSpec.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Model instance for a specific child agent role.
 */
export async function resolveAgentModel(
  role: "explore" | "worker",
  modelRuntime: any,
  parentModel: any,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<any> {
  // 1. Environment variable override
  const envVarName = role === "worker" ? "AIES_WORKER_MODEL" : "AIES_EXPLORE_MODEL";
  const envModel = env[envVarName]?.trim();
  if (envModel && modelRuntime) {
    const model = findModel(modelRuntime, envModel);
    if (model) return model;
  }

  // 2. Profile configuration: aies.json
  const configModel = readConfigModel(agentDir, role);
  if (configModel && modelRuntime) {
    const model = findModel(modelRuntime, configModel);
    if (model) return model;
  }

  // 3. Fallback to parent session model
  return parentModel;
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
