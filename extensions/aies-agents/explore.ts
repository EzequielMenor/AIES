/**
 * Execution runner for isolated Explore child agents.
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context (no parent history/sentinel leakage).
 * - Read-only tool surface (read, grep, find, ls, scoped tgrep).
 * - Isolated from parent extensions (no metric pollution).
 * - Defensively parses and caps handoff output.
 */

import { parseExploreHandoff, type ExploreHandoff } from "./handoff.ts";
import { resolveExploreModel } from "./model.ts";
import { executeChildSession, resolveRoleSystemPrompt } from "./session.ts";
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

  const systemPrompt = resolveRoleSystemPrompt("explore", agentDir, options.systemPrompt);
  const model = options.model ?? (await resolveExploreModel(modelRuntime, parentModel, agentDir));

  const customTgrep = createTgrepToolDefinition(cwd, {
    runner: options.tgrepRunner,
  });

  try {
    const rawOutput = await executeChildSession({
      task,
      context,
      cwd,
      agentDir,
      systemPrompt,
      model,
      modelRuntime,
      tools: ["read", "grep", "find", "ls", "tgrep"],
      customTools: [customTgrep],
      signal,
      sessionManager: options.sessionManager,
    });

    return parseExploreHandoff(rawOutput);
  } catch (error: any) {
    return {
      status: "failed",
      summary: `Explore session failed: ${error?.message ?? String(error)}`,
      evidence: [],
      issues: [error?.message ?? String(error)],
      next: ["Check child agent configuration or retry exploration."],
    };
  }
}
