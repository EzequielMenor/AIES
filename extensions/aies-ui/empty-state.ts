/**
 * The idle empty state (AIES UI v1 real-bugfix, BUG 2).
 *
 * A fresh IDLE session has nothing to show in the main pane, and Pi's editor
 * exposes no public placeholder API. The supported surface is an `aboveEditor`
 * widget, so this module owns the pure decision and the pure renderer for that
 * content: a sober card plus the editor hint as its last line.
 *
 * It is a projection, never a store. The caller scans the transcript once with
 * `hasHumanTranscript`, keeps the resulting boolean and asks `emptyStateWanted`
 * with it, so no render path ever reads the entry log. `renderEmptyState`
 * invents nothing: no ASCII art, no boxes, nothing giant.
 */

import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";

/** The live signals and the precomputed transcript fact the decision depends on. */
export interface EmptyStateInput {
  userTranscriptSeen: boolean;
  isIdle: boolean;
  hasActivity: boolean;
  ticketActive: boolean;
  activeRole: string | undefined;
}

/** One content line: its plain text and the semantic tone it paints with. */
interface EmptyLine {
  text: string;
  color: SemanticColor;
}

/**
 * The transcript counts as started the moment a user message is present; every
 * other entry — custom summaries, labels, compaction, garbage — is ignored. A
 * non-array input means there is no transcript at all, which reads as empty.
 * The caller runs this once per session signal, never on a render path.
 */
export function hasHumanTranscript(entries: readonly unknown[]): boolean {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record.type !== "message") continue;
    const message = record.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    if ((message as Record<string, unknown>).role === "user") return true;
  }
  return false;
}

/**
 * The empty state is wanted only for a genuinely fresh, idle session: the agent
 * is idle, no child is running, no ticket is active, no role is active and the
 * transcript has not received a user message yet.
 */
export function emptyStateWanted(input: EmptyStateInput): boolean {
  if (input.userTranscriptSeen === true) return false;
  if (input.isIdle !== true) return false;
  if (input.hasActivity !== false) return false;
  if (input.ticketActive !== false) return false;
  if (input.activeRole !== undefined) return false;
  return true;
}

/** The card content in render order; blank entries are breathing room, not content. */
const EMPTY_LINES: readonly EmptyLine[] = [
  { text: "", color: "text" },
  { text: "✧ AIES", color: "accent" },
  { text: "", color: "text" },
  { text: "¿Qué quieres hacer?", color: "text" },
  { text: "Escribe una tarea o usa /", color: "dim" },
  { text: "", color: "text" },
  { text: "  /aies-run    Ejecutar ticket", color: "dim" },
  { text: "  /agents      Ver agentes", color: "dim" },
  { text: "  /aies-models Modelos", color: "dim" },
  { text: "", color: "text" },
  { text: "Escribe una tarea…  / para comandos", color: "muted" },
];

/** The width at or above which the card centers instead of staying left-aligned. */
const CENTER_MIN_WIDTH = 56;

/** The narrowest terminal the card renders into. */
const MIN_WIDTH = 20;

/**
 * Rows kept below the widget for the editor band (editor, status and footer).
 * The spacer treats this as a bounded reserve, never an absolute coordinate.
 */
export const EMPTY_STATE_EDITOR_RESERVE = 6;

/**
 * The bounded flow spacer that floats the card toward the first third of the
 * main pane. The `aboveEditor` widget is docked directly above the editor and
 * flows top-down, so blank rows appended after the card lift it upward. The
 * count is relative to the terminal height and collapses to zero on short
 * terminals, where the spacer must never crowd out the editor.
 */
export function emptyStateSpacerRows(height: number | undefined, cardRows: number): number {
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0) return 0;
  const targetTop = Math.floor(height / 3);
  const widgetHeight = height - targetTop - EMPTY_STATE_EDITOR_RESERVE;
  return Math.max(0, Math.floor(widgetHeight) - cardRows);
}

/**
 * Render the idle card. Every line is clipped to `width` and centered while the
 * terminal is wide enough; blank lines stay blank so they read as spacing. The
 * editor hint is always the last non-empty line. When a terminal `height` is
 * known, a bounded, trailing flow spacer lifts the card toward the first third
 * of the main pane; on short terminals the spacer collapses.
 */
export function renderEmptyState(options: { width: number; height?: number; paint?: Paint }): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const width = Math.max(MIN_WIDTH, Math.floor(Number.isFinite(options.width) ? options.width : MIN_WIDTH));
  const centered = width >= CENTER_MIN_WIDTH;

  const lines = EMPTY_LINES.map((line) => {
    if (line.text === "") return "";
    const text = line.text.slice(0, width);
    const pad = centered ? Math.max(0, Math.floor((width - text.length) / 2)) : 0;
    return paint.fg(line.color, `${" ".repeat(pad)}${text}`);
  });

  const spacer = emptyStateSpacerRows(options.height, EMPTY_LINES.length);
  for (let row = 0; row < spacer; row += 1) lines.push("");
  return lines;
}
