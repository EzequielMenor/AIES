/**
 * Bash inspection guard for isolated child agents.
 *
 * Enforces a strict read-only boundary on shell execution. Rejects any mutating
 * command (file creation, deletion, modification, permissions), redirects,
 * command substitution, or unapproved binaries.
 */

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

/** Binaries permitted for inspection and query. */
const INSPECTION_WHITELIST: ReadonlySet<string> = new Set([
  "cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "ag", "ls", "ll", "tree",
  "find", "fd", "wc", "sort", "uniq", "column", "stat", "file", "du", "df",
  "realpath", "dirname", "basename", "pwd", "git", "diff", "strings", "bat",
  "batcat", "jq", "yq", "md5", "md5sum", "sha1sum", "sha256sum", "shasum",
  "sed", "awk", "echo", "printf", "true", "false", "test", "[", "cd",
]);

/** Git subcommands permitted for inspection. Mutating commands are rejected. */
const GIT_INSPECTION_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "blame", "ls-files", "ls-tree",
  "cat-file", "shortlog", "describe", "rev-parse", "grep",
]);

/**
 * Validate whether a shell command is strictly read-only inspection.
 */
export function isSafeInspectionCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== "string") return false;
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // Mask string literals to prevent false positives inside quotes
  const strippedStrings = trimmed
    .replace(/"([^"\\]|\\.)*"/gu, '""')
    .replace(/'[^']*'/gu, "''");

  // Reject command substitution (subshell execution)
  if (/\$\(|`/u.test(strippedStrings)) {
    return false;
  }

  // Reject output redirection (> or >>), allowing only 2>&1
  if (/>(?!\s*&1)/u.test(strippedStrings.replace(/2>&1/gu, ""))) {
    return false;
  }

  // Split by pipeline and command chaining: |, ;, &&, ||
  const parts = strippedStrings.split(/\|{1,2}|&&|;/u).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return false;

  for (const part of parts) {
    const tokens = part.split(/[\s()]+/u).filter(Boolean);
    let binary = "";
    let argIdx = 0;

    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      // Skip leading VAR=value assignments
      if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tok)) continue;
      binary = tok.split("/").pop() ?? "";
      argIdx = i + 1;
      break;
    }

    if (!binary || !INSPECTION_WHITELIST.has(binary)) return false;

    if (binary === "git") {
      const subcommand = tokens[argIdx];
      if (!subcommand || !GIT_INSPECTION_SUBCOMMANDS.has(subcommand)) return false;
    } else if (binary === "sed") {
      if (tokens.slice(argIdx).some((t) => t === "-i" || t.startsWith("-i") || t === "--in-place")) {
        return false;
      }
    } else if (binary === "find") {
      if (tokens.slice(argIdx).some((t) => t === "-delete" || t === "-exec" || t === "-execdir")) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Wraps bash operations with the read-only inspection guard.
 */
export function createReadOnlyBashOperations(baseOps = createLocalBashOperations()) {
  return {
    exec: async (command: string, cwd: string, options: any) => {
      if (!isSafeInspectionCommand(command)) {
        throw new Error(
          `Command blocked: Explore child agent is strictly read-only. Mutating or unapproved command: "${command}"`,
        );
      }
      return baseOps.exec(command, cwd, options);
    },
  };
}
