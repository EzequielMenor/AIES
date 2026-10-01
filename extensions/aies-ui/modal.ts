/**
 * Shared AIES modal frame (AIES UI final observational polish / T1).
 *
 * One small, Pi-free primitive for every AIES overlay surface: hand it a title,
 * content lines and an optional help row, and it draws a bounded box. It knows
 * nothing about models or agents, so `/aies-models` today and `/agents` later
 * frame themselves through exactly the same code.
 *
 * The frame never emits raw ANSI. Colors are named semantically and resolved by
 * the injected `Paint`, which is the identity `PLAIN_PAINT` in tests and
 * headless runs and the host theme in a TUI. Width is content-adapted but
 * always clamped to the available terminal width, so a narrow terminal degrades
 * to plain clipped rows instead of overdrawing.
 */

import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";

/** The widest frame the helper will ever draw, so it never becomes a banner. */
export const MODAL_MAX_WIDTH = 96;

/** The narrowest frame that still reads as a bounded, readable surface. */
export const MODAL_MIN_WIDTH = 24;

/** The columns the border consumes: `│ ` on the left plus ` │` on the right. */
export const MODAL_FRAME_CHROME = 4;

/** One content row: its plain text and the semantic tone it paints with. */
export interface ModalLine {
  text: string;
  /** Defaults to `text` when omitted. */
  color?: SemanticColor;
}

/** The framed content, independent of any particular surface. */
export interface ModalContent {
  title: string;
  lines: readonly ModalLine[];
  help?: string;
}

export interface ModalFrameInput extends ModalContent {
  /** Available width reported by the host; no rendered line exceeds it. */
  width: number;
  /** A content-derived preferred width; clamped to `width`. */
  preferredWidth?: number;
  paint?: Paint;
}

function usableWidth(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

/** The widest visible character count in the content, ignoring paint. */
export function modalContentWidth(content: ModalContent): number {
  let widest = content.title.length;
  for (const line of content.lines) widest = Math.max(widest, line.text.length);
  if (content.help) widest = Math.max(widest, content.help.length);
  return widest;
}

/**
 * The bounded, content-adapted frame width for an available terminal width.
 * The wanted width is the largest of the readable floor, the caller's preferred
 * width and the content plus its chrome, capped by the maximum and by the space
 * the terminal actually offers.
 */
export function modalWidth(content: ModalContent, available: number, preferred?: number): number {
  const width = usableWidth(available);
  const wanted = Math.max(
    MODAL_MIN_WIDTH,
    typeof preferred === "number" && Number.isFinite(preferred) ? preferred : 0,
    modalContentWidth(content) + MODAL_FRAME_CHROME,
  );
  return Math.max(1, Math.min(width, Math.min(MODAL_MAX_WIDTH, wanted)));
}

function clip(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  if (text.length <= limit) return text;
  if (limit <= 0) return "";
  if (limit === 1) return "…";
  return `${text.slice(0, limit - 1)}…`;
}

/** Clip to `width` and pad with spaces so the row fills the inner column. */
function pad(text: string, width: number): string {
  const clipped = clip(text, width);
  return clipped.length >= width ? clipped : `${clipped}${" ".repeat(width - clipped.length)}`;
}

function topBorder(title: string, frameWidth: number): string {
  const inner = Math.max(0, frameWidth - 2);
  const label = ` ${clip(title, Math.max(0, inner - 2))} `;
  const head = clip(`─${label}`, inner);
  const filled = `${head}${"─".repeat(Math.max(0, inner - head.length))}`.slice(0, inner);
  return `╭${filled}╮`;
}

function bodyLine(text: string, color: SemanticColor, frameWidth: number, paint: Paint): string {
  const inner = Math.max(0, frameWidth - MODAL_FRAME_CHROME);
  return `│ ${paint.fg(color, pad(text, inner))} │`;
}

function bottomBorder(frameWidth: number): string {
  return `╰${"─".repeat(Math.max(0, frameWidth - 2))}╯`;
}

/**
 * Render the frame into lines already centered inside the available width, so
 * the caller can hand them straight to the host. When a border cannot fit the
 * terminal, it degrades to clipped plain rows rather than overdrawing.
 */
export function renderModalFrame(input: ModalFrameInput): string[] {
  const paint = input.paint ?? PLAIN_PAINT;
  const available = usableWidth(input.width);
  const content: ModalContent = { title: input.title, lines: input.lines, help: input.help };

  if (available < MODAL_FRAME_CHROME + 1) {
    const rows = [
      content.title,
      ...content.lines.map((line) => line.text),
      ...(content.help ? ["", content.help] : []),
    ];
    return rows.map((row) => paint.fg("text", clip(row, available)));
  }

  const frameWidth = modalWidth(content, available, input.preferredWidth);
  const offset = Math.max(0, Math.floor((available - frameWidth) / 2));
  const prefix = " ".repeat(offset);

  const lines: string[] = [
    paint.fg("accent", topBorder(content.title, frameWidth)),
    bodyLine("", "text", frameWidth, paint),
  ];
  for (const line of content.lines) {
    lines.push(bodyLine(line.text, line.color ?? "text", frameWidth, paint));
  }
  if (content.help) {
    lines.push(bodyLine("", "text", frameWidth, paint));
    lines.push(bodyLine(content.help, "dim", frameWidth, paint));
  }
  lines.push(paint.fg("accent", bottomBorder(frameWidth)));

  return lines.map((line) => `${prefix}${line}`);
}
