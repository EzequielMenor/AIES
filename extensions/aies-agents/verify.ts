/**
 * Execution runner for isolated Verify child agents (AIES-005).
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context: no parent history, no Worker transcript, no Worker reasoning.
 * - Factual input only, composed by `buildVerifyTaskInput` from the work unit and
 *   the acceptance criteria. There is no free-form context field to fill.
 * - Inspection-only tool surface (`read`, `grep`, `find`, `ls`, `tgrep`, and a
 *   guarded read-only `bash`); no `edit` and no `write` exist in the session.
 * - Isolated from parent extensions, so its checks never inflate parent metrics.
 * - Defensively parsed and capped; an unreadable verdict is `blocked`, never `pass`.
 */

import { parseVerifyHandoff, type VerifyHandoff } from "./handoff.ts";
import { resolveVerifyModel } from "./model.ts";
import type { SandboxConfigOptions } from "./sandbox.ts";
import { executeChildSession, resolveRoleSystemPrompt } from "./session.ts";
import { createTgrepToolDefinition, type TgrepRunner } from "./tgrep.ts";
import { buildVerifyTaskInput } from "./verification.ts";
import { createVerifyBashToolDefinition, type VerifyBashRunner } from "./verify-guard.ts";

/** The complete tool surface a Verify child may use. There is no mutation tool. */
export const VERIFY_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "tgrep", "bash"];

export interface RunVerifyOptions {
  /** The work unit being verified, as a fact. */
  task: string;
  /** Verifiable acceptance criteria. The verdict is judged against these. */
  criteria: string[];
  changedPaths?: string[];
  baseRef?: string;
  checks?: string[];
  cwd: string;
  agentDir: string;
  modelRuntime?: any;
  parentModel?: any;
  model?: any;
  systemPrompt?: string;
  signal?: AbortSignal;
  sessionManager?: any;
  tgrepRunner?: TgrepRunner;
  bashRunner?: VerifyBashRunner;
  sandboxOptions?: SandboxConfigOptions;
}

/**
 * Execute an independent verification run in a dedicated child AgentSession.
 */
export async function runVerifyAgent(options: RunVerifyOptions): Promise<VerifyHandoff> {
  const { task, criteria, cwd, agentDir, modelRuntime, parentModel, signal } = options;

  const systemPrompt = resolveRoleSystemPrompt("verify", agentDir, options.systemPrompt);
  const model = options.model ?? (await resolveVerifyModel(modelRuntime, parentModel, agentDir));

  // The child prompt is the structured verification input, nothing else.
  const verifyInput = buildVerifyTaskInput({
    task,
    criteria,
    changedPaths: options.changedPaths,
    baseRef: options.baseRef,
    checks: options.checks,
  });

  const customTgrep = createTgrepToolDefinition(cwd, { runner: options.tgrepRunner });
  const guardedBash = createVerifyBashToolDefinition(cwd, {
    runner: options.bashRunner,
    sandboxOptions: options.sandboxOptions,
  });

  try {
    const rawOutput = await executeChildSession({
      task: verifyInput,
      cwd,
      agentDir,
      systemPrompt,
      model,
      modelRuntime,
      tools: [...VERIFY_TOOLS],
      customTools: [customTgrep, guardedBash],
      signal,
      sessionManager: options.sessionManager,
    });

    return parseVerifyHandoff(rawOutput);
  } catch (error: any) {
    return {
      status: "blocked",
      summary: `Verify session failed: ${error?.message ?? String(error)}`,
      criteria: [],
      checks: [],
      defects: [],
      next: ["Re-run verification, or fix the child agent configuration first."],
    };
  }
}
