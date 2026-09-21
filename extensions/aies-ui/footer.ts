/**
 * The AIES shell: the full custom footer Pi renders while AIES is active, and
 * the responsive active-ticket header.
 *
 * One footer line, always: `✧ AIES · <ticket> · <STAGE> · ctx <n> · [alarms] ·
 * [AUTO] · [V:PASS]` with the compact cwd and model appended only when the width
 * leaves room. The renderer measures plain text, decides what fits, then paints:
 * colors never affect layout, identity, ticket and alarms are never dropped, and
 * a narrow terminal clips the tail as a last resort.
 *
 * When a status panel is already on screen (`panelVisible`), the footer drops to
 * its minimal form: identity, ticket, stage and context plus the alarms. The
 * facts the panel already shows (model, cwd, AUTO, V:PASS) are omitted so the
 * human is not told the same thing twice.
 *
 * The header is small: a boxed identity at normal widths and one compact line at
 * narrow widths. Both renderers read a snapshot and return strings; neither ever
 * feeds a workflow decision.
 */

import type { AiesSnapshot } from "../aies-runtime/state.ts";
import { clip, formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import { deriveStage, isCompacting, isContextPressure, STAGE_TONE, verificationIndicator, type Stage } from "./vocabulary.ts";

/** The fixed brand identity of the footer. */
const IDENTITY = "✧ AIES";

/** The idle placeholder: no ticket, nothing in flight. */
const IDLE_LABEL = "listo";

/** Below this width the ticket header collapses to a single line. */
const HEADER_NARROW_WIDTH = 60;

/** The widest the boxed header is allowed to grow. */
const HEADER_MAX_WIDTH = 64;

/** Options for `renderFooter`. Width is in terminal columns. */
export interface FooterOptions {
  width?: number;
  paint?: Paint;
  /** Retained for call-site compatibility; location is no longer shell chrome. */
  cwd?: string;
  /**
   * When a status panel already shows model, cwd, AUTO and V:PASS, the footer
   * renders its minimal form instead of repeating them.
   */
  panelVisible?: boolean;
}

/** Options for `renderHeader`. */
export interface HeaderOptions {
  paint?: Paint;
}

const SEPARATOR = " · ";

/** Drop order, least important first, as documented in `docs/UX.md` §5. */
type DropTag = "model" | "cost" | "elapsed" | "vpass" | "auto" | "ctx" | "stage";

interface Segment {
  text: string;
  color: SemanticColor;
  drop?: DropTag;
}

const STAGE_COLOR: Record<Stage, SemanticColor> = STAGE_TONE;

function positiveWidth(width: number | undefined): number | undefined {
  if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return undefined;
  return Math.floor(width);
}

function buildSegments(snapshot: AiesSnapshot, now: number, minimal: boolean): Segment[] {
  const segments: Segment[] = [{ text: IDENTITY, color: "text" }];

  const stage = deriveStage(snapshot);
  const identifier = snapshot.ticket?.active && snapshot.ticket.identifier ? snapshot.ticket.identifier : undefined;
  // A real ticket is always shown; `listo` is a placeholder only for the idle state.
  // With no ticket and work in flight the slot is omitted rather than filled.
  if (identifier) segments.push({ text: identifier, color: "text" });
  else if (stage === "IDLE") segments.push({ text: IDLE_LABEL, color: "muted" });

  if (stage !== "IDLE") segments.push({ text: stage, color: STAGE_COLOR[stage], drop: "stage" });

  // Below the panel breakpoint this is the entire persistent status surface.
  // Keep the compact technical identity together so model and provider never
  // masquerade as two unrelated facts.
  if (!minimal) {
    const model = singleLine(snapshot.model?.id ?? "");
    const provider = singleLine(snapshot.model?.provider ?? "");
    if (model) {
      segments.push({ text: provider ? `${model}/${provider}` : model, color: "dim", drop: "model" });
    }
  }

  const pressure = isContextPressure(snapshot);
  // Under pressure the segment IS the alarm, so it is never dropped; a very narrow
  // terminal clips the tail instead of losing the warning.
  segments.push({
    text: `ctx ${formatTokens(snapshot.contextTokens)}${pressure ? " !" : ""}`,
    color: pressure ? "warning" : "dim",
    ...(pressure ? {} : { drop: "ctx" as DropTag }),
  });

  // Alarms: present only while true, never dropped, in this fixed order.
  if (!minimal) {
    segments.push({
      text: formatDuration(Math.max(0, now - snapshot.startedAt)),
      color: "dim",
      drop: "elapsed",
    });
    const totalCost = snapshot.runUsage?.total.cost;
    if (typeof totalCost === "number" && Number.isFinite(totalCost) && totalCost > 0) {
      segments.push({ text: formatCost(totalCost), color: "dim", drop: "cost" });
    }
  }

  if (isCompacting(snapshot)) segments.push({ text: "compactando…", color: "warning" });
  const indicator = verificationIndicator(snapshot);
  if (indicator === "V:FAIL") segments.push({ text: "V:FAIL", color: "error" });
  else if (indicator === "V:ERROR") segments.push({ text: "V:ERROR", color: "error" });
  else if (indicator === "V:STALE") segments.push({ text: "V:STALE", color: "warning" });
  if (snapshot.permissions?.denials > 0) segments.push({ text: "PERM", color: "warning" });
  if (snapshot.permissions?.sandbox === "unavailable" || snapshot.permissions?.sandbox === "disabled") {
    segments.push({ text: "SANDBOX OFF", color: "error" });
  }

  // The panel already carries autonomy and a valid PASS, so the minimal footer
  // omits them instead of repeating the same fact twice.
  if (!minimal) {
    if (snapshot.autonomy?.enabled) segments.push({ text: "AUTO", color: "accent", drop: "auto" });
    if (indicator === "V:PASS" && stage !== "DONE") segments.push({ text: "V:PASS", color: "success", drop: "vpass" });
  }

  return segments;
}

function joinPlain(segments: Segment[]): string {
  return segments.map((segment) => segment.text).join(SEPARATOR);
}

/**
 * Render the footer line. Below the panel breakpoint it is the rich fallback;
 * while the fixed panel is visible it keeps only non-duplicated essentials.
 */
export function renderFooter(snapshot: AiesSnapshot, now: number, options: FooterOptions = {}): string {
  const paint = options.paint ?? PLAIN_PAINT;
  const width = positiveWidth(options.width);
  const minimal = options.panelVisible === true;

  let segments = buildSegments(snapshot, now, minimal);
  // Width-less pure renders keep the historical concise contract. The rich
  // fallback is a terminal-width behavior, not an invitation to grow logs.
  if (!minimal && width === undefined) {
    segments = segments.filter((segment) => !["model", "elapsed", "cost"].includes(segment.drop ?? ""));
  }

  let plain = joinPlain(segments);

  if (width !== undefined && plain.length > width) {
    for (const tag of ["model", "cost", "elapsed", "vpass", "auto", "ctx", "stage"] as const) {
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

/**
 * Render the active-ticket header. Wide terminals get a small boxed identity with
 * the ticket ID, title, status and AUTO; narrow terminals get one compact line.
 * With no active ticket there is nothing to show and the renderer returns `[]`.
 */
export function renderHeader(snapshot: AiesSnapshot, width: number | undefined, options: HeaderOptions = {}): string[] {
  const paint = options.paint ?? PLAIN_PAINT;
  const ticket = snapshot.ticket;
  if (!ticket?.active || !ticket.identifier) return [];

  const identifier = singleLine(ticket.identifier);
  const status = singleLine(ticket.status ?? "");
  const title = singleLine(ticket.title ?? "");
  const auto = snapshot.autonomy?.enabled === true;
  const available = positiveWidth(width);

  const compact = [identifier, status, auto ? "AUTO" : ""].filter(Boolean).join(SEPARATOR);

  if (available !== undefined && available < HEADER_NARROW_WIDTH) {
    return [paint.fg("accent", clip(compact, available))];
  }

  const boxWidth = available !== undefined ? Math.min(available, HEADER_MAX_WIDTH) : HEADER_MAX_WIDTH;
  const inner = boxWidth - 4;
  if (inner < 8) return [paint.fg("accent", clip(compact, available ?? compact.length))];

  const label = `✧ ${identifier}`;
  const top = `╭─ ${label} ${"─".repeat(Math.max(0, boxWidth - label.length - 5))}╮`;
  const bottom = `╰${"─".repeat(Math.max(0, boxWidth - 2))}╯`;

  const content: string[] = [];
  if (title) content.push(title);
  content.push([status, auto ? "AUTO" : ""].filter(Boolean).join(SEPARATOR) || identifier);

  const lines = [paint.fg("accent", top)];
  for (const line of content) {
    lines.push(`│ ${paint.fg("text", clip(line, inner).padEnd(inner))} │`);
  }
  lines.push(paint.fg("accent", bottom));
  return lines;
}
