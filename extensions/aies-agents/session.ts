/**
 * Shared execution runner for isolated child agents (Explore, Worker).
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context (no parent history/sentinel leakage).
 * - Isolated from parent extensions (no metric pollution).
 * - Guaranteed session disposal on completion or failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AiesThinkingLevel } from "../aies-models/capabilities.ts";
import type {
  AgentObservatory,
  BeginAgentInput,
  FinishAgentInput,
} from "./observatory.ts";
import type { AgentRole } from "./model.ts";

export interface ChildSessionOptions {
  task: string;
  context?: string;
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  model: any;
  modelRuntime?: any;
  /** Capability-valid thinking level for the child session, when one is configured. */
  thinkingLevel?: AiesThinkingLevel;
  tools: string[];
  customTools?: ToolDefinition[];
  signal?: AbortSignal;
  sessionManager?: any;
  /**
   * Session-local presentation registry. When supplied together with `agentId`,
   * the child session is observed through exactly one event listener. It never
   * routes, authorizes or changes what the child does.
   */
  observatory?: AgentObservatory;
  /** The record id returned by `observatory.begin`, when observation is active. */
  agentId?: string;
}

/** The event fields the observatory reads; every other field is ignored. */
export interface ObservableChildEvent {
  type?: unknown;
  toolName?: unknown;
  args?: unknown;
}

/** The minimal AgentSession surface the observatory needs, so a fake can implement it. */
export interface ObservableChildSession {
  subscribe(listener: (event: ObservableChildEvent) => void): () => void;
  getSessionStats(): unknown;
}

import { observableCost } from "../aies-ui/format.ts";

/** The lifecycle boundaries that sample the child's own usage once. */
const USAGE_EVENT_TYPES = new Set(["turn_end", "agent_settled", "agent_end"]);

/** Read the real usage fields off `SessionStats`: `tokens.total` and `cost`. */
function readChildUsage(
  stats: unknown,
  model?: { id?: string; provider?: string },
): { totalTokens: number; cost: number | null } {
  const record = (stats ?? {}) as { tokens?: { total?: unknown }; cost?: unknown };
  const total = record.tokens?.total;
  const rawCost = typeof record.cost === "number" && Number.isFinite(record.cost) ? record.cost : null;
  const cost = observableCost(rawCost, model?.id, model?.provider);
  return {
    totalTokens: typeof total === "number" && Number.isFinite(total) ? total : 0,
    cost,
  };
}

/**
 * Attach exactly one event-driven listener to a child session and return its
 * unsubscribe function. Tool lifecycle starts become mechanical activities;
 * turn end / agent settled / agent end sample the child's own usage. Every path
 * is guarded so a broken observer or a session that no longer answers can never
 * fail the child run. No timer and no polling are used.
 */
export function attachChildObservatory(
  session: ObservableChildSession,
  observatory: Pick<AgentObservatory, "observe" | "updateUsage">,
  agentId: string,
  model?: { id?: string; provider?: string },
): () => void {
  const listener = (event: ObservableChildEvent): void => {
    try {
      if (event?.type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        const args =
          event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {};
        observatory.observe(agentId, toolName, args, Date.now());
        return;
      }
      if (typeof event?.type === "string" && USAGE_EVENT_TYPES.has(event.type)) {
        observatory.updateUsage(agentId, readChildUsage(session.getSessionStats(), model));
      }
    } catch {
      // Observation is presentation only: it must never fail the child run.
    }
  };

  try {
    return session.subscribe(listener);
  } catch {
    return () => {};
  }
}

/** Project a resolved model into the registry's presentation identity. */
export function projectModelIdentity(model: any): {
  modelId: string | null;
  modelLabel: string | null;
  providerId: string | null;
} {
  const modelId = typeof model?.id === "string" && model.id ? model.id : null;
  const modelLabel = typeof model?.name === "string" && model.name ? model.name : modelId;
  const providerId = typeof model?.provider === "string" && model.provider ? model.provider : null;
  return { modelId, modelLabel, providerId };
}

/** Open a record without ever failing a run on a broken observer. */
export function beginChildObservation(
  observatory: AgentObservatory | undefined,
  input: BeginAgentInput,
): string | undefined {
  if (!observatory) return undefined;
  try {
    return observatory.begin(input);
  } catch {
    return undefined;
  }
}

/** Close a record without ever failing a run on a broken observer. */
export function finishChildObservation(
  observatory: AgentObservatory | undefined,
  agentId: string | undefined,
  input: FinishAgentInput,
): void {
  if (!observatory || !agentId) return;
  try {
    observatory.finish(agentId, input);
  } catch {
    // Presentation only.
  }
}

/**
 * Resolve system prompt for a role from agentDir or repo fallback.
 */
export function resolveRoleSystemPrompt(
  role: AgentRole,
  agentDir: string,
  override?: string,
): string {
  if (override) return override;

  const candidatePaths = [
    join(agentDir, "agents", `${role}.md`),
    fileURLToPath(new URL(`../../agents/${role}.md`, import.meta.url)),
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        // Continue to fallback
      }
    }
  }

  if (role === "worker") {
    return "You are an isolated worker agent. Implement the assigned work unit and conclude with structured JSON.";
  }

  if (role === "verify") {
    return "You are an isolated verification agent. Inspect the real repository state against the acceptance criteria and conclude with structured JSON.";
  }

  return "You are an isolated read-only explore agent. Investigate the codebase and conclude with structured JSON.";
}

/**
 * Whether a value is a real session `ModelRuntime` rather than the extension's
 * synchronous `ModelRegistry` facade. Only a genuine runtime may be handed to
 * `createAgentSession`; a registry is a resolution source only.
 */
export function isSessionModelRuntime(value: any): boolean {
  return Boolean(value) && typeof value.getAuth === "function" && typeof value.streamSimple === "function";
}

/**
 * Whether a value is the public extension `ModelRegistry` facade: a resolution
 * source that exposes the registered-provider config surface but is not itself a
 * session runtime.
 */
export function isSessionModelRegistry(value: any): boolean {
  return (
    Boolean(value) &&
    !isSessionModelRuntime(value) &&
    typeof value.getRegisteredProviderConfig === "function"
  );
}

/**
 * Build the isolated child `ModelRuntime` when the parent delegated through its
 * public `ModelRegistry` facade and that facade registered the provider the
 * selected child model belongs to (EZE-454).
 *
 * The runtime is built by the public API with the child's own `agentDir` auth and
 * models files, so a stored credential stays readable and `models.json` still
 * applies, and only the one provider config the facade exposes is copied. Child
 * extensions and skills still never load: the resource loader keeps
 * `noExtensions`/`noSkills`, and this runtime only knows the model it was handed.
 *
 * Returns `undefined` when no registered provider config matches, so a facade for
 * a built-in or `models.json` provider keeps Pi's own default child runtime.
 */
export async function createChildModelRuntime(
  agentDir: string,
  model: any,
  registry: any,
): Promise<ModelRuntime | undefined> {
  if (!isSessionModelRegistry(registry)) return undefined;

  const providerId =
    typeof model?.provider === "string" && model.provider ? model.provider : undefined;
  if (!providerId) return undefined;

  let config: any;
  let nativeProvider: any;
  try {
    config = registry.getRegisteredProviderConfig(providerId);
    if (!config && typeof registry.getRegisteredNativeProvider === "function") {
      nativeProvider = registry.getRegisteredNativeProvider(providerId);
    }
  } catch {
    return undefined;
  }
  if (!config && !nativeProvider) return undefined;

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  if (config) runtime.registerProvider(providerId, config);
  else runtime.registerNativeProvider(nativeProvider);
  return runtime;
}

/**
 * Execute an isolated child AgentSession turn and return the assistant's final text.
 */
export async function executeChildSession(options: ChildSessionOptions): Promise<string> {
  const {
    task,
    context,
    cwd,
    agentDir,
    systemPrompt,
    model,
    modelRuntime,
    thinkingLevel,
    tools,
    customTools = [],
    signal,
    sessionManager: customSessionManager,
    observatory,
    agentId,
  } = options;

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
  });
  await resourceLoader.reload();

  const sessionManager = customSessionManager ?? SessionManager.inMemory(cwd);

  // A genuine runtime is used untouched. A public `ModelRegistry` facade is a
  // resolution source that a child runtime cannot authenticate an
  // extension-registered provider with, so the child gets its own isolated
  // runtime carrying exactly the selected model's registered provider config.
  const childRuntime = isSessionModelRuntime(modelRuntime)
    ? modelRuntime
    : await createChildModelRuntime(agentDir, model, modelRuntime);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime: childRuntime,
    thinkingLevel,
    resourceLoader,
    sessionManager,
    customTools,
    tools,
  });

  const unsubscribe =
    observatory && agentId ? attachChildObservatory(session, observatory, agentId, model) : undefined;

  let promptText = `TASK: ${task}`;
  if (context && context.trim()) {
    promptText += `\n\nCONTEXT:\n${context.trim()}`;
  }

  try {
    if (signal?.aborted) {
      throw new Error("Child agent operation was aborted before starting");
    }

    await session.prompt(promptText);
    return session.getLastAssistantText() ?? "";
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // Unsubscribe errors must not mask execution results
    }
    try {
      session.dispose();
    } catch {
      // Dispose errors must not mask execution results
    }
  }
}
