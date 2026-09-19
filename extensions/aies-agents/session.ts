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
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

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

/** The lifecycle boundaries that sample the child's own usage once. */
const USAGE_EVENT_TYPES = new Set(["turn_end", "agent_settled", "agent_end"]);

/** Read the real usage fields off `SessionStats`: `tokens.total` and `cost`. */
function readChildUsage(stats: unknown): { totalTokens: number; cost: number | null } {
  const record = (stats ?? {}) as { tokens?: { total?: unknown }; cost?: unknown };
  const total = record.tokens?.total;
  const cost = record.cost;
  return {
    totalTokens: typeof total === "number" && Number.isFinite(total) ? total : 0,
    cost: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
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
        observatory.updateUsage(agentId, readChildUsage(session.getSessionStats()));
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

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    customTools,
    tools,
  });

  const unsubscribe =
    observatory && agentId ? attachChildObservatory(session, observatory, agentId) : undefined;

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
