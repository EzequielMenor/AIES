/**
 * Command security guard for Worker child agents (AIES-004).
 *
 * Worker implements: its shell may run tests, builds and development checks, but
 * it may not run destructive, remote or out-of-workspace commands. The shared
 * mechanics and the rule list live in `command-guard.ts`; this module is only the
 * Worker-facing entry point, kept so the AIES-004 surface does not move.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  checkCommandPolicy,
  createGuardedBashToolDefinition,
  type CommandPermissionResult,
  type GuardedBashRunner,
  type GuardedBashSchema,
} from "./command-guard.ts";

export type WorkerBashRunner = GuardedBashRunner;

/**
 * Validate whether a command is safe and permitted for a Worker.
 */
export function isCommandPermittedInWorker(
  command: string,
  workspaceRoot: string,
): CommandPermissionResult {
  return checkCommandPolicy(command, workspaceRoot, "worker");
}

/**
 * Creates a guarded bash ToolDefinition for Worker child agents.
 */
export function createWorkerBashToolDefinition(
  cwd: string,
  options?: { runner?: WorkerBashRunner },
): ToolDefinition<typeof GuardedBashSchema> {
  return createGuardedBashToolDefinition({
    workspaceRoot: cwd,
    policy: "worker",
    runner: options?.runner,
    description:
      "Execute bash commands within the workspace (e.g. tests, linters, git status/diff, builds). Destructive commands (git clean, reset --hard, push, sudo) are strictly blocked.",
    promptSnippet: "bash: Execute tests, builds, and development checks safely.",
    promptGuidelines: [
      "Use bash to run tests, typecheck, lint, or inspect git status/diff.",
      "Destructive commands like git clean, git reset --hard, git push, and sudo are blocked.",
    ],
  });
}
