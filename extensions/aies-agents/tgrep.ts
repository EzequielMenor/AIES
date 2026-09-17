/**
 * Scoped tgrep search tool for Explore agents.
 *
 * Exposes a structured, safe code-search capability:
 * - Arguments are validated via TypeBox schema (no arbitrary CLI flags or strings).
 * - Paths are strictly contained within the repository workspace (no traversal).
 * - Commands run via execFile without shell interpolation (no /bin/sh -c).
 * - Output is bounded with progressive disclosure (filesOnly vs context lines).
 * - Graceful fallback when tgrep executable is unavailable on PATH.
 */

import { execFile as nodeExecFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Type, type Static } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

export const TgrepParamsSchema = Type.Object({
  pattern: Type.String({
    description: "Search pattern to look for in files (regex by default, or fixed string if fixed: true)",
  }),
  path: Type.Optional(
    Type.String({
      description: "Subdirectory or file path within workspace to limit search to (default: workspace root)",
    }),
  ),
  fixed: Type.Optional(
    Type.Boolean({
      description: "Match pattern as a literal fixed string instead of regular expression",
    }),
  ),
  glob: Type.Optional(
    Type.String({
      description: "Glob pattern to filter files (e.g. '*.ts', 'docs/**/*.md')",
    }),
  ),
  fileType: Type.Optional(
    Type.String({
      description: "Filter search to specific file type (e.g. 'ts', 'rust', 'markdown')",
    }),
  ),
  context: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 5,
      description: "Number of context lines before and after match (0-5, default: 0)",
    }),
  ),
  filesOnly: Type.Optional(
    Type.Boolean({
      description: "Return only matching file paths instead of line matches (progressive disclosure)",
    }),
  ),
});

export type TgrepParams = Static<typeof TgrepParamsSchema>;

export const MAX_TGREP_OUTPUT_CHARS = 10_000;
export const MAX_TGREP_MATCH_LINES = 100;
export const MAX_TGREP_FILES = 50;

export type TgrepRunner = (
  bin: string,
  args: string[],
  opts: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr?: string }>;

const execFileAsync = promisify(nodeExecFile);

export const defaultTgrepRunner: TgrepRunner = async (bin, args, opts) => {
  return execFileAsync(bin, args, {
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: 2 * 1024 * 1024,
  });
};

/**
 * Validates and resolves an input path ensuring it does not escape the workspace.
 */
export function resolveSafePath(cwd: string, inputPath?: string): string {
  if (!inputPath || !inputPath.trim() || inputPath.trim() === ".") {
    return cwd;
  }
  const resolved = resolve(cwd, inputPath.trim());
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path traversal blocked: "${inputPath}" escapes workspace "${cwd}"`);
  }
  return resolved;
}

/**
 * Builds the safe argument list for tgrep invocation based on parameters.
 */
export function buildTgrepArgs(params: TgrepParams, safeTarget: string): string[] {
  const args: string[] = [];

  if (params.filesOnly) {
    args.push("-l");
  }

  if (params.fixed) {
    args.push("-F");
  }

  if (params.fileType && params.fileType.trim()) {
    args.push("-t", params.fileType.trim());
  }

  if (params.glob && params.glob.trim()) {
    args.push("-g", params.glob.trim());
  }

  if (params.context !== undefined && params.context > 0) {
    const clampedContext = Math.min(5, Math.max(0, Math.floor(params.context)));
    args.push("-C", String(clampedContext));
  }

  // Positional arguments: pattern, then target path
  args.push(params.pattern);
  args.push(safeTarget);

  return args;
}

export interface CreateTgrepToolOptions {
  runner?: TgrepRunner;
  binary?: string;
}

/**
 * Creates the tgrep ToolDefinition for child Explore agents.
 */
export function createTgrepToolDefinition(
  workspaceRoot: string,
  options?: CreateTgrepToolOptions,
): ToolDefinition<typeof TgrepParamsSchema, unknown> {
  const runner = options?.runner ?? defaultTgrepRunner;
  const binary = options?.binary ?? "tgrep";

  return {
    name: "tgrep",
    label: "tgrep",
    description:
      "Specialized fast code search across the workspace. Use filesOnly: true first to discover candidate files, then search specific patterns with optional context lines.",
    promptSnippet: "tgrep: Specialized fast repository search with regex, file-type filters, and progressive disclosure.",
    promptGuidelines: [
      "Use tgrep for fast code exploration.",
      "Prefer filesOnly: true first for broad searches to avoid overflowing context with match lines.",
    ],
    parameters: TgrepParamsSchema,
    async execute(_toolCallId, params: TgrepParams, _signal, _onUpdate, ctx?: ExtensionContext) {
      const cwd = ctx?.cwd ?? workspaceRoot;

      let safeTarget: string;
      try {
        safeTarget = resolveSafePath(cwd, params.path);
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        };
      }

      if (!existsSync(safeTarget)) {
        return {
          content: [{ type: "text", text: `Error: Path does not exist: "${params.path}"` }],
          isError: true,
        };
      }

      const args = buildTgrepArgs(params, safeTarget);

      try {
        const { stdout } = await runner(binary, args, { cwd, timeout: 15_000 });
        const rawOutput = (stdout || "").trim();

        if (!rawOutput) {
          return {
            content: [{ type: "text", text: `No matches found for pattern "${params.pattern}".` }],
            isError: false,
          };
        }

        let lines = rawOutput.split("\n");
        let truncated = false;
        let truncationReason = "";

        if (params.filesOnly) {
          lines = lines.filter((l) => l.trim().length > 0);
          if (lines.length > MAX_TGREP_FILES) {
            lines = lines.slice(0, MAX_TGREP_FILES);
            truncated = true;
            truncationReason = `limit of ${MAX_TGREP_FILES} files exceeded`;
          }
        } else {
          if (lines.length > MAX_TGREP_MATCH_LINES) {
            lines = lines.slice(0, MAX_TGREP_MATCH_LINES);
            truncated = true;
            truncationReason = `limit of ${MAX_TGREP_MATCH_LINES} match lines exceeded`;
          }
        }

        let resultText = lines.join("\n");
        if (resultText.length > MAX_TGREP_OUTPUT_CHARS) {
          resultText = resultText.slice(0, MAX_TGREP_OUTPUT_CHARS);
          truncated = true;
          truncationReason = `limit of ${MAX_TGREP_OUTPUT_CHARS} characters exceeded`;
        }

        if (truncated) {
          resultText += `\n\n[Results truncated: ${truncationReason}. Refine your query or use filesOnly: true]`;
        }

        return {
          content: [{ type: "text", text: resultText }],
          isError: false,
        };
      } catch (error: any) {
        // Exit code 1 indicates grep found 0 matches
        if (error?.code === 1) {
          return {
            content: [{ type: "text", text: `No matches found for pattern "${params.pattern}".` }],
            isError: false,
          };
        }

        // Binary not found on system
        if (error?.code === "ENOENT") {
          return {
            content: [
              {
                type: "text",
                text: "tgrep capability unavailable: 'tgrep' executable not found on PATH. Use built-in 'grep' or 'find' tools instead.",
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `tgrep search failed: ${error?.stderr || error?.message || String(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  };
}
