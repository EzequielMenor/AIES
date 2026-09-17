/**
 * Execution runner for isolated Worker child agents (AIES-004).
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context (no parent history/sentinel leakage).
 * - Focused implementation tool surface (read, grep, find, ls, tgrep, edit, write, guarded bash).
 * - Guarded against destructive commands (git clean, reset --hard, push, sudo).
 * - Isolated from parent extensions (no metric pollution).
 * - Defensively parses and caps handoff output.
 */

import { parseWorkerHandoff, type WorkerHandoff } from "./handoff.ts";
import { resolveWorkerModel } from "./model.ts";
import { executeChildSession, resolveRoleSystemPrompt } from "./session.ts";
import { createTgrepToolDefinition, type TgrepRunner } from "./tgrep.ts";
import { createWorkerBashToolDefinition, type WorkerBashRunner } from "./worker-guard.ts";

export interface RunWorkerOptions {
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
  bashRunner?: WorkerBashRunner;
}

/**
 * Execute an isolated implementation task in a dedicated child AgentSession.
 */
export async function runWorkerAgent(options: RunWorkerOptions): Promise<WorkerHandoff> {
  const {
    task,
    context,
    cwd,
    agentDir,
    modelRuntime,
    parentModel,
    signal,
  } = options;

  const systemPrompt = resolveRoleSystemPrompt("worker", agentDir, options.systemPrompt);
  const model = options.model ?? (await resolveWorkerModel(modelRuntime, parentModel, agentDir));

  const customTgrep = createTgrepToolDefinition(cwd, {
    runner: options.tgrepRunner,
  });

  const guardedBash = createWorkerBashToolDefinition(cwd, {
    runner: options.bashRunner,
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
      tools: ["read", "grep", "find", "ls", "tgrep", "edit", "write", "bash"],
      customTools: [customTgrep, guardedBash],
      signal,
      sessionManager: options.sessionManager,
    });

    return parseWorkerHandoff(rawOutput);
  } catch (error: any) {
    return {
      status: "failed",
      summary: `Worker session failed: ${error?.message ?? String(error)}`,
      changes: [],
      checks: [],
      issues: [error?.message ?? String(error)],
      next: ["Check child agent configuration or re-scope the work unit."],
    };
  }
}
