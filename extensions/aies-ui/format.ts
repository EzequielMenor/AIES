/**
 * Small, pure text formatters shared by every AIES surface.
 *
 * Exactly one implementation of each: `status.ts` re-exports `formatTokens` and
 * `formatDuration` so existing imports keep working while the behaviour lives in
 * the presentation module.
 */

/** Below this, token counts are verbatim; above, rounded to thousands (`34k`). */
const TOKEN_ROUNDING_THRESHOLD = 10_000;

const THOUSAND = 1000;

/** Token count as Pi reported it, or `?` when it is not known yet. */
export function formatTokens(value: number | null | undefined): string {
  const tokens = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  if (tokens === null) return "?";
  if (tokens < TOKEN_ROUNDING_THRESHOLD) return `${tokens}`;
  const thousands = Math.round(tokens / THOUSAND);
  if (thousands < THOUSAND) return `${thousands}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
}

/**
 * Cost in dollars with two decimals (`$0.08`, `$0.10`). An unknown cost is an em
 * dash, never `$0.00`: a zero the workflow did not measure must not read as a
 * real zero. A negative or non-finite value is unknown too.
 */
export function formatCost(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  return `$${value.toFixed(2)}`;
}

/** Duration as `mm:ss`, or `h:mm:ss` past an hour. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.floor((Number.isFinite(milliseconds) ? milliseconds : 0) / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** Collapse every run of whitespace (including newlines) into one trimmed line. */
export function singleLine(text: string): string {
  return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * One-line clip that never exceeds `width`. The last cell becomes `…` when the
 * text is cut, so the result stays a single terminal cell wide per character.
 */
export function clip(text: string, width: number): string {
  const flat = singleLine(text);
  const limit = Math.max(0, Math.floor(Number.isFinite(width) ? width : 0));
  if (flat.length <= limit) return flat;
  if (limit <= 0) return "";
  if (limit === 1) return "…";
  return `${flat.slice(0, limit - 1)}…`;
}
