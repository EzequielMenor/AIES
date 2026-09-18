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
      "Execute read-only commands within the workspace: tests, typecheck, lint, build and git inspection (status, diff, show, log, blame, ls-files). Mutating commands and file writes are blocked.",
    promptSnippet: "bash: Run the checks that produce evidence, and inspect git safely.",
    promptGuidelines: [
      "Use bash to run the repository's own checks: npm test, npm run lint, typecheck, build, pytest, cargo test, go test.",
      "Use bash for read-only git inspection: git status, git diff, git show, git log, git blame, git ls-files.",
      "Verify never mutates the workspace: edits, in-place sed, file deletion or movement, dependency installation and file redirection are blocked.",
    ],
  });
}
