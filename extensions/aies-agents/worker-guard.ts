/**
 * Security guard and bash wrapper for Worker child agents (AIES-004).
 *
 * Enforces command restrictions to prevent destructive operations,
 * remote mutations, worktree clobbering, and out-of-workspace access.
 */

import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import {
  createBashToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export interface CommandPermissionResult {
  allowed: boolean;
  reason?: string;
}

export type WorkerBashRunner = (
  command: string,
  cwd: string,
) => Promise<{ stdout: string; exitCode?: number; stderr?: string }>;

const SENSITIVE_SYSTEM_PREFIXES = ["/etc", "/var", "/boot", "/System", "/root"];

/**
 * Split a shell command string into individual subcommands by ;, &&, ||, |, and \n,
 * respecting single and double quotes.
 */
export function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (char === "\n" || char === ";") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        continue;
      }
      if (char === "&" && command[i + 1] === "&") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (char === "|" && command[i + 1] === "|") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (char === "|") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

/**
 * Tokenize a single command line into arguments, stripping outer quotes.
 */
export function tokenizeCommandLine(cmd: string): string[] {
  const tokens: string[] = [];
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/gu;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(cmd)) !== null) {
    let token = match[0];
    if (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    ) {
      token = token.slice(1, -1);
    }
    tokens.push(token);
  }

  return tokens;
}

/**
 * Validate whether a command is safe and permitted for execution by a Worker.
 */
export function isCommandPermittedInWorker(
  command: string,
  workspaceRoot: string,
): CommandPermissionResult {
  const segments = splitCommandSegments(command);

  for (const segment of segments) {
    const rawTokens = tokenizeCommandLine(segment);
    if (!rawTokens.length) continue;

    // Skip leading environment variable assignments (e.g. FOO=bar)
    let index = 0;
    while (index < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rawTokens[index])) {
      index++;
    }
    if (index >= rawTokens.length) continue;

    const tokens = rawTokens.slice(index);
    const head = tokens[0];
    const binary = head.split("/").pop() ?? head;

    // 1. Sudo is strictly forbidden
    if (binary === "sudo") {
      return { allowed: false, reason: "sudo is not permitted in Worker" };
    }

    // 2. Git command safety
    if (binary === "git") {
      // Find git subcommand (skipping global flags like -C, -c, --git-dir, etc.)
      let subIndex = 1;
      while (subIndex < tokens.length) {
        const tok = tokens[subIndex];
        if (tok === "-C" || tok === "-c" || tok === "--git-dir" || tok === "--work-tree") {
          subIndex += 2;
          continue;
        }
        if (tok.startsWith("-")) {
          subIndex++;
          continue;
        }
        break;
      }

      const subcommand = tokens[subIndex];
      if (subcommand) {
        if (subcommand === "clean") {
          return {
            allowed: false,
            reason: "git clean is destructive and not permitted in Worker",
          };
        }

        if (subcommand === "reset") {
          if (tokens.some((t) => t === "--hard" || t === "--merge" || t === "--keep")) {
            return {
              allowed: false,
              reason: "git reset --hard/--merge/--keep is destructive and not permitted in Worker",
            };
          }
        }

        if (subcommand === "checkout") {
          if (tokens.some((t) => t === "--" || t === "." || t === "-f" || t === "--force")) {
            return {
              allowed: false,
              reason: "git checkout discarding worktree changes is not permitted in Worker",
            };
          }
        }

        if (subcommand === "restore") {
          return {
            allowed: false,
            reason: "git restore discarding changes is not permitted in Worker",
          };
        }

        if (subcommand === "push") {
          return {
            allowed: false,
            reason: "git push / remote mutations are not permitted in Worker",
          };
        }

        if (subcommand === "merge") {
          return {
            allowed: false,
            reason: "git merge is not permitted in Worker",
          };
        }

        if (subcommand === "rebase") {
          return {
            allowed: false,
            reason: "git rebase is not permitted in Worker",
          };
        }

        if (subcommand === "branch") {
          if (tokens.some((t) => t === "-D" || t === "-d" || t === "--delete")) {
            return {
              allowed: false,
              reason: "git branch deletion is not permitted in Worker",
            };
          }
        }
      }
    }

    // 3. Mass file deletions
    if (binary === "rm") {
      const hasRecursive = tokens.some((t) => /^-[a-zA-Z]*r[a-zA-Z]*$/u.test(t) || t === "--recursive");
      if (hasRecursive) {
        const targets = tokens.slice(1).filter((t) => !t.startsWith("-"));
        for (const target of targets) {
          if (
            target === "/" ||
            target === "/*" ||
            target === "*" ||
            target === "." ||
            target === ".." ||
            target === "~" ||
            target === "$HOME"
          ) {
            return {
              allowed: false,
              reason: "mass file deletion is not permitted in Worker",
            };
          }
        }
      }
    }

    // 4. Workspace navigation bounds
    if (binary === "cd") {
      const target = tokens[1];
      if (target) {
        const resolved = resolve(workspaceRoot, target);
        if (!resolved.startsWith(workspaceRoot)) {
          return {
            allowed: false,
            reason: "navigating outside workspace root is not permitted in Worker",
          };
        }
      }
    }

    // 5. Deploy / publish operations
    if (["deploy", "publish", "release", "vercel", "flyctl", "serverless", "sls"].includes(binary)) {
      return {
        allowed: false,
        reason: `${binary} deployment/publishing operations are not permitted in Worker`,
      };
    }

    if (["npm", "pnpm", "yarn", "bun"].includes(binary) && tokens.includes("publish")) {
      return {
        allowed: false,
        reason: "package publishing is not permitted in Worker",
      };
    }

    if (binary === "gh" && (tokens.includes("release") || tokens.includes("pr"))) {
      return {
        allowed: false,
        reason: "gh release/pr operations are not permitted in Worker",
      };
    }

    // 6. Accessing sensitive system files outside workspace
    for (const tok of tokens) {
      if (tok.startsWith("/")) {
        if (tok === "/dev/null") continue;
        for (const sensitive of SENSITIVE_SYSTEM_PREFIXES) {
          if (tok === sensitive || tok.startsWith(`${sensitive}/`)) {
            return {
              allowed: false,
              reason: `accessing system path (${sensitive}) outside workspace root is not permitted in Worker`,
            };
          }
        }
      }
    }
  }

  return { allowed: true };
}

const BashSchema = Type.Object({
  command: Type.String({ description: "The bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Optional execution timeout in seconds" })),
});

/**
 * Creates a guarded bash ToolDefinition for Worker child agents.
 */
export function createWorkerBashToolDefinition(
  cwd: string,
  options?: { runner?: WorkerBashRunner },
): ToolDefinition<typeof BashSchema> {
  const nativeBash = options?.runner ? undefined : createBashToolDefinition(cwd);

  return {
    name: "bash",
    label: "Worker Bash (Guarded)",
    description:
      "Execute bash commands within the workspace (e.g. tests, linters, git status/diff, builds). Destructive commands (git clean, reset --hard, push, sudo) are strictly blocked.",
    promptSnippet: "bash: Execute tests, builds, and development checks safely.",
    promptGuidelines: [
      "Use bash to run tests, typecheck, lint, or inspect git status/diff.",
      "Destructive commands like git clean, git reset --hard, git push, and sudo are blocked.",
    ],
    parameters: BashSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command;
      const permission = isCommandPermittedInWorker(command, cwd);

      if (!permission.allowed) {
        return {
          content: [
            {
              type: "text",
              text: `Command blocked by Worker safety guard: ${permission.reason}`,
            },
          ],
          isError: true,
        };
      }

      if (options?.runner) {
        try {
          const result = await options.runner(command, cwd);
          const isError = (result.exitCode ?? 0) !== 0;
          return {
            content: [{ type: "text", text: result.stdout || result.stderr || "" }],
            isError,
          };
        } catch (err: any) {
          return {
            content: [{ type: "text", text: err?.message ?? String(err) }],
            isError: true,
          };
        }
      }

      if (nativeBash) {
        return (await nativeBash.execute(toolCallId, params, signal, onUpdate, ctx)) as any;
      }

      return {
        content: [{ type: "text", text: "Bash execution environment not available." }],
        isError: true,
      };
    },
  };
}
