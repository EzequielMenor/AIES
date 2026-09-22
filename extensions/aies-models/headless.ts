/**
 * Bounded headless projection for `/aies-models` (AIES-010D / T12, EZE-453 / T2).
 *
 * Print/JSON/RPC hosts get readable text through `ctx.ui.notify` and never see
 * a custom component. The output is deliberately small: a fixed header, one
 * line per preference role, the usable providers and a bounded block for every
 * provider that is not selectable. Both the line count and the character count
 * are capped by the caller, and the header and the preference lines come first
 * so truncation removes the catalogue before it removes context.
 */

import { ROLE_LABELS, ROLE_ORDER } from "./overlay.ts";
import type { AiesRole, ChildPreference } from "./config.ts";
import { PROVIDER_STATE_LABELS, type ProviderProjection } from "./providers.ts";

export interface HeadlessInput {
  projection: ProviderProjection;
  preferences: Partial<Record<string, ChildPreference>>;
  maxLines?: number;
  maxChars?: number;
}

/** A single line never grows past this width, so one model cannot flood the host. */
const MAX_LINE_CHARS = 160;

/** At most this many usable provider rows are listed before one summary row. */
const MAX_USABLE_ROWS = 8;

/** Default line budget: the header, the four roles and both sections must survive. */
const DEFAULT_MAX_LINES = 32;

/** Default character budget for hosts that only show a fixed-size notification. */
const DEFAULT_MAX_CHARS = 3000;

/** The explicit message when nothing at all is selectable. */
const NO_USABLE_MESSAGE = "sin modelos utilizables: autenticá un provider con /login <provider>";

function preferenceLine(role: AiesRole, preference: ChildPreference | undefined): string {
  const label = ROLE_LABELS[role];
  const model = typeof preference?.model === "string" && preference.model.trim() ? preference.model.trim() : undefined;
  if (!model) return `${label} · sin preferencia`;
  const level = preference?.thinkingLevel ? ` · ${preference.thinkingLevel}` : "";
  return `${label} · ${model}${level}`;
}

/** The usable-provider section, bounded, or the explicit "nothing usable" message. */
function usableSection(projection: ProviderProjection): string[] {
  if (projection.usable.length === 0) return [NO_USABLE_MESSAGE];
  const rows = projection.usable
    .slice(0, MAX_USABLE_ROWS)
    .map((section) => `  ${section.name} (${section.models.length})`);
  const hidden = projection.usable.length - MAX_USABLE_ROWS;
  if (hidden > 0) rows.push(`  … y ${hidden} providers utilizables más`);
  return ["Utilizables:", ...rows];
}

/** The bounded non-selectable block, omitted entirely when there is nothing to say. */
function attentionSection(projection: ProviderProjection): string[] {
  const rows = projection.attention.map((row) => {
    const detail = row.detail ? ` · ${row.detail}` : "";
    if (row.stateLabel === PROVIDER_STATE_LABELS.rejected) {
      return `  ✗ ${row.id} · ${row.stateLabel}${detail}`;
    }
    const hint = row.hint ? ` → ${row.hint}` : "";
    return `  ○ ${row.id} · ${row.stateLabel}${detail}${hint}`;
  });

  if (projection.hiddenDisconnected > 0) {
    rows.push(`  … ${projection.hiddenDisconnected} providers más sin conectar (/login <provider> en Pi)`);
  }
  if (rows.length === 0) return [];
  return ["", "No seleccionables:", ...rows];
}

/**
 * Render the bounded headless report. The header and the preference lines come
 * first, so truncation removes the catalogue before it removes context.
 */
export function renderHeadlessModels(input: HeadlessInput): string {
  const maxLines = Math.max(1, Math.floor(input.maxLines ?? DEFAULT_MAX_LINES));
  const maxChars = Math.max(40, Math.floor(input.maxChars ?? DEFAULT_MAX_CHARS));
  const projection = input.projection;

  const candidates: string[] = [
    `Modelos AIES utilizables (${projection.models.length})`,
    ...ROLE_ORDER.map((role) => preferenceLine(role, input.preferences[role])),
    "",
    ...usableSection(projection),
    ...attentionSection(projection),
  ];

  const keep = candidates.length > maxLines ? [...candidates.slice(0, maxLines - 1), "…"] : candidates;

  const lines = keep
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line))
    .filter((line, index) => line.length > 0 || index > 0);

  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}
