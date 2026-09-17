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
}

/**
 * Resolve system prompt for a role from agentDir or repo fallback.
 */
export function resolveRoleSystemPrompt(
  role: "explore" | "worker",
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
      session.dispose();
    } catch {
      // Dispose errors must not mask execution results
    }
  }
}
