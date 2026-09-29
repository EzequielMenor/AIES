/**
 * Command guard for Verify child agents (AIES-005).
 *
 * Verify proves a claim, it never repairs one. Its shell may read the repository
 * and run the checks that produce evidence, and nothing else: the Worker
 * destructive list plus every workspace mutation (mutating git subcommands,
 * file deletion or movement, in-place editing, dependency installation and file
 * redirection). The policy lives in `command-guard.ts`; this module is the
 * Verify-facing entry point.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  checkCommandPolicy,
  createGuardedBashToolDefinition,
  type CommandPermissionResult,
  type GuardedBashRunner,
  type GuardedBashSchema,
} from "./command-guard.ts";
import type { SandboxConfigOptions } from "./sandbox.ts";

export type VerifyBashRunner = GuardedBashRunner;

/**
 * Validate whether a command is permitted for a read-only verification run.
 */
export function isCommandPermittedInVerify(
  command: string,
  workspaceRoot: string,
): CommandPermissionResult {
  return checkCommandPolicy(command, workspaceRoot, "verify");
}

/**
 * Creates the guarded bash ToolDefinition for Verify child agents.
 */
export function createVerifyBashToolDefinition(
  cwd: string,
  options?: { runner?: VerifyBashRunner; sandboxOptions?: SandboxConfigOptions },
): ToolDefinition<typeof GuardedBashSchema> {
  return createGuardedBashToolDefinition({
    workspaceRoot: cwd,
    policy: "verify",
    runner: options?.runner,
    sandboxOptions: options?.sandboxOptions,
    description:
      "Execute read-only checks and git inspection (npm test, build, lint, git status, git diff, git show). Mutations are blocked.",
    promptSnippet: "bash: Run checks and read-only git inspection safely.",
    promptGuidelines: [
      "Use bash for repository checks (npm test, build, lint) and read-only git inspection (git status, git diff, git show).",
      "Verify is strictly read-only: edits, file modifications, deletions, installs, and redirection are blocked.",
    ],
  });
}
