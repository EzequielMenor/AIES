/**
 * Execution runner for isolated Explore child agents.
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context (no parent history/sentinel leakage).
 * - Read-only tool surface (read, grep, find, ls, guarded bash).
 * - Isolated from parent extensions (no metric pollution).
 * - Defensively parses and caps handoff output.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { parseExploreHandoff, type ExploreHandoff } from "./handoff.ts";
import { resolveExploreModel } from "./model.ts";
import { createTgrepToolDefinition, type TgrepRunner } from "./tgrep.ts";

export interface RunExploreOptions {
  task: string;
  context?: string;
  cwd: string;
  agentDir: string;
  modelRuntime?: any;
  parentModel?: any;
  model?: any;
  systemPrompt?: string;
  signal?: AbortSignal;
  sessionManager?: any;
  tgrepRunner?: TgrepRunner;
}

function resolveSystemPrompt(agentDir: string, override?: string): string {
  if (override) return override;

  const candidatePaths = [
    join(agentDir, "agents", "explore.md"),
    fileURLToPath(new URL("../../agents/explore.md", import.meta.url)),
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

  return "You are an isolated read-only explore agent. Investigate the codebase and conclude with structured JSON.";
}

/**
 * Execute an isolated exploration task in a dedicated child AgentSession.
 */
export async function runExploreAgent(options: RunExploreOptions): Promise<ExploreHandoff> {
  const {
    task,
    context,
    cwd,
    agentDir,
    modelRuntime,
    parentModel,
    signal,
  } = options;

  const systemPrompt = resolveSystemPrompt(agentDir, options.systemPrompt);
  const model = options.model ?? (await resolveExploreModel(modelRuntime, parentModel, agentDir));

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

  const customTgrep = createTgrepToolDefinition(cwd, {
    runner: options.tgrepRunner,
  });

  const sessionManager = options.sessionManager ?? SessionManager.inMemory(cwd);

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager,
    customTools: [customTgrep],
    tools: ["read", "grep", "find", "ls", "tgrep"],
  });

  let promptText = `TASK: ${task}`;
  if (context && context.trim()) {
    promptText += `\n\nCONTEXT:\n${context.trim()}`;
  }

  try {
    if (signal?.aborted) {
      throw new Error("Explore operation was aborted before starting");
    }

    await session.prompt(promptText);
    const lastAssistantText = session.getLastAssistantText();
    return parseExploreHandoff(lastAssistantText);
  } catch (error: any) {
    return {
      status: "failed",
      summary: `Explore session failed: ${error?.message ?? String(error)}`,
      evidence: [],
      issues: [error?.message ?? String(error)],
      next: ["Check child agent configuration or retry exploration."],
    };
  } finally {
    try {
      session.dispose();
    } catch {
      // Dispose errors must not mask execution results
    }
  }
}
