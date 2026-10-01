/**
 * AIES-010C T5: quiet projections for the six generic Pi tools.
 *
 * This module decides what each tool row looks like: the compact collapsed row,
 * the pending row while the call is in flight, the always-visible error row and
 * the expanded raw truth. It is pure by contract: no Pi import, no I/O, no
 * state, and no hardcoded ANSI — every color comes from the injected `Paint`.
 *
 * The result row names the same target the call row named, so a projection is
 * bound to the call arguments. The Pi boundary (registration, theme adapter and
 * the original tool instances) lives in `extensions/aies-runtime/quiet-tools.ts`.
 */

import type { Paint } from "./paint.ts";

/** The exact six generic tools this surface owns. Nothing else is overridden. */
export type QuietToolName = "read" | "bash" | "grep" | "find" | "edit" | "write";

/** The single source of the tool set: the Pi boundary iterates this list. */
export const QUIET_TOOL_NAMES: readonly QuietToolName[] = ["read", "bash", "grep", "find", "edit", "write"];

/** The render flags Pi hands to `renderResult` (plus the error bit from context). */
export interface QuietRenderOptions {
  expanded: boolean;
  isPartial: boolean;
  isError: boolean;
}

/** The slice of `AgentToolResult` a projection reads. Unknown input degrades to silence. */
export interface QuietResult {
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

/** One tool's two projections, with the call arguments already bound. */
export interface QuietProjection {
  /** `(options, paint) -> string[]`: the pending row while the call is in flight. */
  call(options: QuietRenderOptions, paint: Paint): string[];
  /** `(result, options, paint) -> string[]`: the settled, expanded or error row. */
  result(result: QuietResult, options: QuietRenderOptions, paint: Paint): string[];
}

/** Column width for the tool name, so every target starts at the same cell. */
const TOOL_COLUMN = 5;
const CHEVRON = "›";
const ERROR_CHEVRON = "✗";
const PENDING_GLYPH = "…";
const TRUNCATED_HINT = "[truncated]";
const CHECK_MARK = "✓";

/** A target longer than this is clipped; the row must stay one line. */
const MAX_TARGET = 60;
/** How many real error lines a collapsed row keeps visible. */
const MAX_ERROR_LINES = 3;
/** The most one genuinely short bash output line may occupy before it is dropped. */
const MAX_SHORT_OUTPUT = 60;
/** Pi's placeholder for a command with no output: never rendered as a fact. */
const BASH_EMPTY = "(no output)";

/** Pi's placeholders for an empty search: a count of lines must not read them as results. */
const NO_MATCHES = "No matches found";
const NO_FILES = "No files found matching pattern";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Collapse any whitespace run to one space, so a row is always a single line. */
function flatten(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Clip to `limit` cells with an ellipsis, never exceeding it. */
function clipTarget(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return limit <= 1 ? "…" : `${text.slice(0, limit - 1)}…`;
}

/** `1 archivo`, `3 archivos`: a count of one is not a plural in Spanish. */
function countLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The complete text Pi handed back, unchanged. */
function resultText(result: QuietResult): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record && record.type === "text" && typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

/** Every raw line of `result.content`, byte for byte, with nothing rewritten. */
function rawLines(result: QuietResult): string[] {
  return resultText(result).split("\n");
}

/** The first `max` non-blank lines, used only for the collapsed error body. */
function headLines(text: string, max: number): string[] {
  const lines = text.split("\n");
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start += 1;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end -= 1;
  return lines.slice(start, start + max);
}

/**
 * Count the real entry lines of a search result: the contiguous lines before the
 * first blank line. Pi appends its truncation notices after a blank line, and an
 * empty search is a placeholder, not one result.
 */
function entryCount(text: string, emptyPlaceholder: string): number {
  const trimmed = text.trim();
  if (!trimmed || trimmed === emptyPlaceholder) return 0;
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") break;
    count += 1;
  }
  return count;
}

/** A failure is the native flag, the result flag, or an explicit structured error. */
function isFailure(result: QuietResult, options: QuietRenderOptions): boolean {
  if (options.isError) return true;
  if (result?.isError === true) return true;
  const error = asRecord(result?.details)?.error;
  return typeof error === "string" && error.length > 0;
}

function truncationOf(result: QuietResult): Record<string, unknown> | undefined {
  const truncation = asRecord(result?.details)?.truncation;
  return truncation && truncation.truncated === true ? truncation : undefined;
}

/** The real target each tool names, clipped to one compact cell run. */
function targetOf(name: QuietToolName, args: Record<string, unknown>): string {
  let raw: string | undefined;
  switch (name) {
    case "read":
    case "edit":
    case "write":
      raw = nonEmptyString(args.path);
      break;
    case "bash":
      raw = nonEmptyString(args.command);
      break;
    case "grep":
      raw = nonEmptyString(args.pattern);
      break;
    case "find":
      raw = nonEmptyString(args.path) ?? nonEmptyString(args.pattern);
      break;
  }
  return clipTarget(flatten(raw ?? "?"), MAX_TARGET);
}

/** `› read  src/calculator.js` / `✗ bash  npm test`: the one-line row header. */
function header(name: QuietToolName, target: string, error: boolean, paint: Paint): string {
  const marker = paint.fg(error ? "error" : "muted", error ? ERROR_CHEVRON : CHEVRON);
  const label = paint.fg("text", name.padEnd(TOOL_COLUMN));
  const subject = paint.fg("accent", target);
  return `${marker} ${label} ${subject}`;
}

/** A real truncation signal, whatever public field carried it. */
function hasTruncationHint(name: QuietToolName, result: QuietResult): boolean {
  if (truncationOf(result)) return true;
  const details = asRecord(result?.details);
  if (!details) return false;
  if (name === "grep") {
    return finiteNumber(details.matchLimitReached) !== undefined || details.linesTruncated === true;
  }
  if (name === "find") return finiteNumber(details.resultLimitReached) !== undefined;
  return false;
}

/** The dashed truncation hint, appended to a compact row so it is never swallowed. */
function truncationHint(name: QuietToolName, result: QuietResult, paint: Paint): string | undefined {
  return hasTruncationHint(name, result) ? paint.fg("warning", TRUNCATED_HINT) : undefined;
}

/** The success status token for a tool, from real details only. */
function successStatus(name: QuietToolName, result: QuietResult, paint: Paint): string {
  switch (name) {
    case "grep": {
      const count = entryCount(resultText(result), NO_MATCHES);
      return paint.fg("muted", `· ${countLabel(count, "coincidencia", "coincidencias")}`);
    }
    case "find": {
      const count = entryCount(resultText(result), NO_FILES);
      return paint.fg("muted", `· ${countLabel(count, "archivo", "archivos")}`);
    }
    case "edit": {
      const diff = nonEmptyString(asRecord(result?.details)?.diff) ?? "";
      let additions = 0;
      let removals = 0;
      for (const line of diff.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
        if (line.startsWith("-") && !line.startsWith("---")) removals += 1;
      }
      return `${paint.fg("success", CHECK_MARK)} ${paint.fg("success", `+${additions}`)} ${paint.fg("dim", "/")} ${paint.fg("error", `-${removals}`)}`;
    }
    default:
      return paint.fg("success", CHECK_MARK);
  }
}

/** One short, genuinely useful bash output line, or nothing for routine output. */
function shortBashOutput(result: QuietResult): string | undefined {
  const text = resultText(result);
  if (text.includes(BASH_EMPTY)) return undefined;
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length !== 1) return undefined;
  const line = flatten(lines[0] ?? "");
  if (!line || line.length > MAX_SHORT_OUTPUT) return undefined;
  return line;
}

/** The real facts only the expanded view adds: the diff, and grep/find totals. */
function detailFacts(name: QuietToolName, result: QuietResult): string[] {
  const details = asRecord(result?.details);
  if (!details) return [];

  const facts: string[] = [];
  const truncation = truncationOf(result);
  if (truncation && (name === "grep" || name === "find")) {
    const output = finiteNumber(truncation.outputLines);
    const total = finiteNumber(truncation.totalLines);
    facts.push(output !== undefined && total !== undefined ? `[truncated: showing ${output} of ${total} lines]` : TRUNCATED_HINT);
  }
  if (name === "find" && finiteNumber(details.resultLimitReached) !== undefined) {
    facts.push(`[truncated: ${finiteNumber(details.resultLimitReached)} results limit]`);
  }

  if (name === "edit") {
    const diff = nonEmptyString(details.diff);
    if (diff) facts.push(...diff.split("\n"));
  }

  return facts;
}

/**
 * Build one tool's projections, bound to its call arguments. The binding is what
 * lets the settled row repeat the same target the call row showed, while both
 * projections keep the `(value, options, paint) -> string[]` shape.
 */
export function createQuietProjection(name: QuietToolName, args: Record<string, unknown> = {}): QuietProjection {
  const target = targetOf(name, args);

  return {
    call(_options, paint) {
      return [`${header(name, target, false, paint)} ${paint.fg("warning", PENDING_GLYPH)}`];
    },

    result(result, options, paint) {
      // A pending call renders a pending row; it never fakes a result.
      if (options.isPartial) {
        return [`${header(name, target, false, paint)} ${paint.fg("warning", PENDING_GLYPH)}`];
      }

      // Errors always win, collapsed or expanded, so a real failure is never hidden.
      if (isFailure(result, options)) {
        const body = options.expanded ? rawLines(result) : headLines(resultText(result), MAX_ERROR_LINES);
        const lines = [header(name, target, true, paint)];
        for (const line of body) lines.push(paint.fg("error", line));
        const hint = truncationHint(name, result, paint);
        if (hint) lines.push(hint);
        return lines;
      }

      // Expanded shows the raw truth byte for byte, plus the real detail facts.
      if (options.expanded) {
        const lines = [...rawLines(result)];
        lines.push(...detailFacts(name, result));
        return lines;
      }

      // Collapsed success: one compact row, plus the truncation hint.
      const status = successStatus(name, result, paint);
      const hint = truncationHint(name, result, paint);
      const lines = [`${header(name, target, false, paint)} ${status}${hint ? ` ${hint}` : ""}`];

      if (name === "bash") {
        const extra = shortBashOutput(result);
        if (extra) lines.push(paint.fg("dim", extra));
      }
      return lines;
    },
  };
}
