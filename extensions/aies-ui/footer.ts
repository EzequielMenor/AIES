/**
 * The AIES footer: `AIES · <ticket-or-ready> · <STAGE> · ctx <n> · [alarms] · [AUTO] · [V:PASS]`.
 *
 * One line, always. The renderer measures plain text, decides what fits, then
 * paints: colors never affect layout, and a narrow terminal drops the least
 * important segment instead of wrapping.
 */

import type { AiesSnapshot } from "../aies-runtime/state.ts";
import { clip, formatTokens } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import { deriveStage, isCompacting, isContextPressure, verificationIndicator, type Stage } from "./vocabulary.ts";

/** Options for `renderFooter`. Width is in terminal columns. */
export interface FooterOptions {
  width?: number;
  paint?: Paint;
}

const SEPARATOR = " · ";

/** Drop order, least important first, as documented in `docs/UX.md` §5. */
type DropTag = "vpass" | "auto" | "stage" | "ctx";

interface Segment {
  text: string;
  color: SemanticColor;
  drop?: DropTag;
}

const STAGE_COLOR: Record<Stage, SemanticColor> = {
  IDLE: "text",
  EXPLORE: "accent",
  WORK: "accent",
  REPAIR: "accent",
  VERIFY: "accent",
  WAIT: "warning",
  BLOCKED: "error",
  DONE: "success",
};

function positiveWidth(width: number | undefined): number | undefined {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return undefined;
  return Math.floor(width);
}

function buildSegments(snapshot: AiesSnapshot): Segment[] {
  const segments: Segment[] = [{ text: "AIES", color: "text" }];

  const stage = deriveStage(snapshot);
  const identifier = snapshot.ticket?.active && snapshot.ticket.identifier ? snapshot.ticket.identifier : undefined;
  // A real ticket is always shown; `ready` is a placeholder only for the idle state.
  // With no ticket and work in flight the slot is omitted rather than filled.
  if (identifier) segments.push({ text: identifier, color: "text" });
  else if (stage === "IDLE") segments.push({ text: "ready", color: "muted" });

  if (stage !== "IDLE") segments.push({ text: stage, color: STAGE_COLOR[stage], drop: "stage" });

  const pressure = isContextPressure(snapshot);
  // Under pressure the segment IS the alarm, so it is never dropped; a very narrow
  // terminal clips the tail instead of losing the warning.
  segments.push({
    text: `ctx ${formatTokens(snapshot.contextTokens)}${pressure ? " !" : ""}`,
    color: pressure ? "warning" : "dim",
    ...(pressure ? {} : { drop: "ctx" as DropTag }),
  });

  // Alarms: present only while true, never dropped, in this fixed order.
  if (isCompacting(snapshot)) segments.push({ text: "compactando…", color: "warning" });
  const indicator = verificationIndicator(snapshot);
  if (indicator === "V:FAIL") segments.push({ text: "V:FAIL", color: "error" });
  else if (indicator === "V:STALE") segments.push({ text: "V:STALE", color: "warning" });
  if (snapshot.permissions?.denials > 0) segments.push({ text: "PERM", color: "warning" });
  if (snapshot.permissions?.sandbox === "unavailable" || snapshot.permissions?.sandbox === "disabled") {
    segments.push({ text: "SANDBOX OFF", color: "error" });
  }

  if (snapshot.autonomy?.enabled) segments.push({ text: "AUTO", color: "accent", drop: "auto" });

  if (indicator === "V:PASS" && stage !== "DONE") segments.push({ text: "V:PASS", color: "success", drop: "vpass" });

  return segments;
}

function joinPlain(segments: Segment[]): string {
  return segments.map((segment) => segment.text).join(SEPARATOR);
}

/**
 * Render the footer line. `now` is accepted for call-site symmetry but the
 * footer never shows elapsed time: that belongs to the activity card.
 */
export function renderFooter(snapshot: AiesSnapshot, now: number, options: FooterOptions = {}): string {
  void now;
  const paint = options.paint ?? PLAIN_PAINT;
  const width = positiveWidth(options.width);

  let segments = buildSegments(snapshot);
  let plain = joinPlain(segments);

  if (width !== undefined && plain.length > width) {
    for (const tag of ["vpass", "auto", "stage", "ctx"] as const) {
      if (plain.length <= width) break;
      segments = segments.filter((segment) => segment.drop !== tag);
      plain = joinPlain(segments);
    }
  }

  if (width !== undefined && plain.length > width) {
    return paint.fg("text", clip(plain, width));
  }

  return segments.map((segment) => paint.fg(segment.color, segment.text)).join(SEPARATOR);
}
