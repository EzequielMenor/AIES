/**
 * Shared command policy for AIES child agents (AIES-005).
 *
 * Worker and Verify both get a shell, but they are not allowed the same things.
 * Worker implements: it may write through its own `edit`/`write` tools, and its
 * shell may run anything that is not destructive or remote. Verify inspects: its
 * shell may not mutate the workspace at all. Both policies share one mechanism -
 * segment splitting, tokenizing, and the destructive/remote rules no child may
 * run - and take the role as a parameter instead of duplicating the list.
 *
 * This is a guard, not a sandbox. It stops the obvious mutation vectors so that
 * Verify has no direct editing primitive, and it is deliberately small: the full
 * permission layer is AIES-006.
 */

import { resolve } from "node:path";
import { Type } from "typebox";
import { createBashToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export type CommandPolicy = "worker" | "verify";

export interface CommandPermissionResult {
  allowed: boolean;
  reason?: string;
}

export type GuardedBashRunner = (
  command: string,
  cwd: string,
) => Promise<{ stdout: string; exitCode?: number; stderr?: string }>;

/** Human label used in guard messages, so a blocked command names its role. */
const POLICY_LABEL: Record<CommandPolicy, string> = {
  worker: "Worker",
  verify: "Verify",
};

const SENSITIVE_SYSTEM_PREFIXES = ["/etc", "/var", "/boot", "/System", "/root"];

const DEPLOY_BINARIES = ["deploy", "publish", "release", "vercel", "flyctl", "serverless", "sls"];

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];

/** Verification never switches, stages, records or rewrites git state. */
const GIT_MUTATING_SUBCOMMANDS = [
  "add", "am", "apply", "checkout", "cherry-pick", "clean", "commit", "fetch",
  "init", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert",
  "rm", "stash", "submodule", "switch", "tag", "worktree",
];

/**
 * Binaries whose only effect is to change files in or around the workspace.
 * `sed` and `perl` are absent on purpose: they are ordinary readers until the
 * in-place flag appears, and that flag is checked separately below.
 */
const MUTATING_BINARIES = [
  "chmod", "chown", "cp", "dd", "install", "ln", "mkdir", "mv", "patch", "rm",
  "rmdir", "tee", "touch", "truncate",
];

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
 * Locate the command head of a segment, skipping `VAR=value` prefixes.
 */
export function commandHead(
  rawTokens: string[],
): { binary: string; args: string[]; tokens: string[] } | undefined {
  let index = 0;
  while (index < rawTokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(rawTokens[index])) {
    index++;
  }
  if (index >= rawTokens.length) return undefined;

  const head = rawTokens[index];
  const binary = head.split("/").pop() ?? head;
  return { binary, args: rawTokens.slice(index + 1), tokens: rawTokens.slice(index) };
}

/** Index of a git subcommand inside its argument list, skipping global flags. */
export function gitSubcommandIndex(tokens: string[]): number {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index++;
      continue;
    }
    break;
  }
  return index;
}

/**
 * A file redirection that writes somewhere other than `/dev/null`.
 *
 * File descriptor duplication (`2>&1`, `>&2`) is not a write and is allowed.
 * Returns the target of the verified-file write, or `undefined` when the segment
 * only reads.
 */
export function findFileRedirection(segment: string): string | undefined {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote || char !== ">") continue;

    // `2>&1`, `>&2`, `>&1`: descriptor duplication, not a file write.
    if (segment[i + 1] === "&") {
      i++;
      continue;
    }

    let cursor = i + 1;
    if (segment[cursor] === ">") cursor++;

    while (segment[cursor] === " " || segment[cursor] === "\t") cursor++;

    let target = "";
    while (cursor < segment.length && !/[\s;|&<>]/u.test(segment[cursor])) {
      target += segment[cursor];
      cursor++;
    }

    i = cursor - 1;
    if (!target || target === "/dev/null") continue;
    return target;
  }

  return undefined;
}

/**
 * Command substitution hides a second command from the segment scanner, which is
 * exactly how a guard like this gets bypassed. Verify may always run the inner
 * command directly, where the policy can see it.
 */
export function findCommandSubstitution(segment: string): string | undefined {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote) continue;

    if (char === "`") return "`";
    if (char === "$" && segment[i + 1] === "(") return "$(";
    if ((char === "<" || char === ">") && segment[i + 1] === "(") return `${char}(`;
  }

  return undefined;
}

function destructiveGitReason(
  tokens: string[],
  subcommand: string,
  policy: CommandPolicy,
): string | undefined {
  const label = POLICY_LABEL[policy];

  if (policy === "verify" && GIT_MUTATING_SUBCOMMANDS.includes(subcommand)) {
    return `git ${subcommand} mutates repository state and is not permitted in ${label}`;
  }

  if (subcommand === "clean") {
    return `git clean is destructive and not permitted in ${label}`;
  }

  if (subcommand === "reset") {
    if (tokens.some((t) => t === "--hard" || t === "--merge" || t === "--keep")) {
      return `git reset --hard/--merge/--keep is destructive and not permitted in ${label}`;
    }
  }

  if (subcommand === "checkout") {
    if (tokens.some((t) => t === "--" || t === "." || t === "-f" || t === "--force")) {
      return `git checkout discarding worktree changes is not permitted in ${label}`;
    }
  }

  if (subcommand === "restore") {
    return `git restore discarding changes is not permitted in ${label}`;
  }

  if (subcommand === "push") {
    return `git push / remote mutations are not permitted in ${label}`;
  }

  if (subcommand === "merge") {
    return `git merge is not permitted in ${label}`;
  }

  if (subcommand === "rebase") {
    return `git rebase is not permitted in ${label}`;
  }

  if (subcommand === "branch" && tokens.some((t) => t === "-D" || t === "-d" || t === "--delete")) {
    return `git branch deletion is not permitted in ${label}`;
  }

  return undefined;
}

function destructiveBinaryReason(
  binary: string,
  tokens: string[],
  policy: CommandPolicy,
): string | undefined {
  const label = POLICY_LABEL[policy];

  if (binary === "sudo") {
    return `sudo is not permitted in ${label}`;
  }

  if (DEPLOY_BINARIES.includes(binary)) {
    return `${binary} deployment/publishing operations are not permitted in ${label}`;
  }

  if (PACKAGE_MANAGERS.includes(binary)) {
    if (tokens.includes("publish")) {
      return `package publishing is not permitted in ${label}`;
    }
    if (policy === "verify") {
      const installs = ["install", "i", "ci", "add", "uninstall", "remove", "update", "upgrade"];
      if (tokens.some((t) => installs.includes(t))) {
        return `dependency installation mutates the workspace and is not permitted in ${label}`;
      }
    }
  }

  if (binary === "gh" && (tokens.includes("release") || tokens.includes("pr"))) {
    return `gh release/pr operations are not permitted in ${label}`;
  }

  return undefined;
}

function massDeletionReason(tokens: string[]): string | undefined {
  const hasRecursive = tokens.some(
    (t) => /^-[a-zA-Z]*r[a-zA-Z]*$/u.test(t) || t === "--recursive",
  );
  if (!hasRecursive) return undefined;

  const targets = tokens.filter((t) => !t.startsWith("-"));
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
      return "mass file deletion";
    }
  }
  return undefined;
}

/**
 * Extra mutation vectors that only matter where the shell may not write at all.
 * `sed -i`, `perl -i` and friends are ordinary reads until the in-place flag.
 */
function verifyMutationReason(binary: string, args: string[]): string | undefined {
  if (binary === "rm") return "file deletion is not permitted in Verify";
  if (binary === "mv") return "moving files is not permitted in Verify";
  if (binary === "cp") return "copying over files is not permitted in Verify";

  if (MUTATING_BINARIES.includes(binary)) {
    return `${binary} mutates the workspace and is not permitted in Verify`;
  }

  // `find -delete` and `find -exec` are mutations wearing an inspection command,
  // and `xargs` runs a command the guard cannot read.
  if (binary === "find" && args.some((a) => ["-delete", "-exec", "-execdir", "-ok"].includes(a))) {
    return "find with -delete/-exec mutates the workspace and is not permitted in Verify";
  }

  if (binary === "xargs") {
    return "xargs runs a command the Verify guard cannot inspect; run the command directly";
  }

  if (binary === "sed" && args.some((a) => a === "-i" || (a.startsWith("-i") && !a.startsWith("--")))) {
    return "in-place editing (sed -i) is not permitted in Verify";
  }

  if (binary === "perl" && args.some((a) => /^-[a-zA-Z]*i/u.test(a))) {
    return "in-place editing (perl -i) is not permitted in Verify";
  }

  return undefined;
}

/**
 * Validate whether a command is safe and permitted for a child role.
 */
export function checkCommandPolicy(
  command: string,
  workspaceRoot: string,
  policy: CommandPolicy,
): CommandPermissionResult {
  const label = POLICY_LABEL[policy];
  const segments = splitCommandSegments(command);

  for (const segment of segments) {
    if (policy === "verify") {
      const substitution = findCommandSubstitution(segment);
      if (substitution) {
        return {
          allowed: false,
          reason: `command substitution (${substitution}...) hides a command from the ${label} guard; run the inner command directly`,
        };
      }

      const redirection = findFileRedirection(segment);
      if (redirection) {
        return {
          allowed: false,
          reason: `writing to a file ("${redirection}") is not permitted in ${label}`,
        };
      }
    }

    const rawTokens = tokenizeCommandLine(segment);
    if (!rawTokens.length) continue;

    const head = commandHead(rawTokens);
    if (!head) continue;

    const { binary, args, tokens } = head;

    const destructive = destructiveBinaryReason(binary, tokens, policy);
    if (destructive) return { allowed: false, reason: destructive };

    // Git commands are read through their subcommand, never as a whole line.
    if (binary === "git") {
      const subIndex = gitSubcommandIndex(tokens);
      const subcommand = tokens[subIndex];
      if (subcommand) {
        const reason = destructiveGitReason(tokens, subcommand, policy);
        if (reason) return { allowed: false, reason };
      }
    }

    const massDeletion = massDeletionReason(tokens);
    if (massDeletion) {
      return { allowed: false, reason: `${massDeletion} is not permitted in ${label}` };
    }

    if (policy === "verify") {
      const mutation = verifyMutationReason(binary, args);
      if (mutation) return { allowed: false, reason: mutation };
    }

    // Navigation is bounded to the workspace for every child role.
    if (binary === "cd") {
      const target = args[0];
      if (target) {
        const resolved = resolve(workspaceRoot, target);
        if (!resolved.startsWith(workspaceRoot)) {
          return {
            allowed: false,
            reason: `navigating outside workspace root is not permitted in ${label}`,
          };
        }
      }
    }

    // System paths outside the workspace are never a child's business.
    for (const token of tokens) {
      if (!token.startsWith("/")) continue;
      if (token === "/dev/null") continue;
      for (const sensitive of SENSITIVE_SYSTEM_PREFIXES) {
        if (token === sensitive || token.startsWith(`${sensitive}/`)) {
          return {
            allowed: false,
            reason: `accessing system path (${sensitive}) outside workspace root is not permitted in ${label}`,
          };
        }
      }
    }
  }

  return { allowed: true };
}

export const GuardedBashSchema = Type.Object({
  command: Type.String({ description: "The bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Optional execution timeout in seconds" })),
});

export interface GuardedBashOptions {
  workspaceRoot: string;
  policy: CommandPolicy;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  runner?: GuardedBashRunner;
}

/**
 * Create a guarded `bash` tool for a child role. The custom definition replaces
 * Pi's own `bash` because a custom tool with a built-in name wins by name.
 */
export function createGuardedBashToolDefinition(
  options: GuardedBashOptions,
): ToolDefinition<typeof GuardedBashSchema> {
  const { workspaceRoot, policy, runner } = options;
  const nativeBash = runner ? undefined : createBashToolDefinition(workspaceRoot);

  return {
    name: "bash",
    label: `AIES ${POLICY_LABEL[policy]} Bash (Guarded)`,
    description: options.description,
    promptSnippet: options.promptSnippet,
    promptGuidelines: options.promptGuidelines,
    parameters: GuardedBashSchema,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const command = params.command;
      const permission = checkCommandPolicy(command, workspaceRoot, policy);

      if (!permission.allowed) {
        return {
          content: [
            {
              type: "text",
              text: `Command blocked by ${POLICY_LABEL[policy]} safety guard: ${permission.reason}`,
            },
          ],
          isError: true,
        };
      }

      if (runner) {
        try {
          const result = await runner(command, workspaceRoot);
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
