/**
 * Bounded headless projection for `/aies-models` (AIES-010D / T12).
 *
 * Print/JSON/RPC hosts get readable text through `ctx.ui.notify` and never see
 * a custom component. The output is deliberately small: a fixed header, one
 * line per preference role, a bounded list of available models and a short
 * hint. Both the line count and the character count are capped by the caller.
 */

import type { ModelOption } from "./capabilities.ts";
import { ROLE_LABELS, ROLE_ORDER } from "./overlay.ts";
import type { AiesRole, ChildPreference } from "./config.ts";

export interface HeadlessInput {
  models: ModelOption[];
  preferences: Partial<Record<string, ChildPreference>>;
  maxLines?: number;
  maxChars?: number;
}

/** A single line never grows past this width, so one model cannot flood the host. */
const MAX_LINE_CHARS = 160;

function preferenceLine(role: AiesRole, preference: ChildPreference | undefined): string {
  const label = ROLE_LABELS[role];
  const model = typeof preference?.model === "string" && preference.model.trim() ? preference.model.trim() : undefined;
  if (!model) return `${label} · sin preferencia`;
  const level = preference?.thinkingLevel ? ` · ${preference.thinkingLevel}` : "";
  return `${label} · ${model}${level}`;
}

/**
 * Render the bounded headless report. The header and the preference lines come
 * first, so truncation removes the model catalogue before it removes context.
 */
export function renderHeadlessModels(input: HeadlessInput): string {
  const maxLines = Math.max(1, Math.floor(input.maxLines ?? 12));
  const maxChars = Math.max(40, Math.floor(input.maxChars ?? 2000));

  const candidates: string[] = [
    `Modelos AIES disponibles (${input.models.length})`,
    ...ROLE_ORDER.map((role) => preferenceLine(role, input.preferences[role])),
    "",
    ...(input.models.length > 0
      ? input.models.map((model) => `${model.value}${model.reasoning ? "" : " · sin razonamiento"}`)
      : ["sin modelos disponibles para la sesión"]),
  ];

  const keep = candidates.length > maxLines ? [...candidates.slice(0, maxLines - 1), "…"] : candidates;

  const lines = keep
    .map((line) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line))
    .filter((line, index) => line.length > 0 || index > 0);

  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars - 1)}…`;
  return text;
}
