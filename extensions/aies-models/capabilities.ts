/**
 * Model capability projection for `/aies-models` (AIES-010D / T12).
 *
 * Pure and host-free: it reads only the model metadata Pi exposes through
 * `ctx.modelRegistry.getAvailable()` and mirrors the documented
 * `thinkingLevelMap` rules from Pi's models documentation:
 *
 * - A non-reasoning model supports only `off`.
 * - Ordinary levels through `high` use the provider's default mapping unless a
 *   map entry replaces them with a provider value.
 * - `xhigh` and `max` are supported only when the map explicitly defines them.
 * - A `null` map entry marks a level as unsupported and removes it from the UI.
 *
 * This module never clamps and never presents an unsupported level as
 * selectable: unsupported means absent.
 */

export type AiesThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Pi's canonical thinking-level order, from the most restrained to the most intense. */
export const THINKING_LEVELS: readonly AiesThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** The subset of a Pi `Model` this projection reads. */
export interface ModelLike {
  provider?: unknown;
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: unknown;
}

/** A projected, display-ready available model with its valid thinking levels. */
export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  /** Stable `provider/id` identity used for persistence. */
  value: string;
  /** Human label that names both the provider and the model. */
  label: string;
  reasoning: boolean;
  levels: AiesThinkingLevel[];
  /** The raw Pi model, so the caller can pass it to `pi.setModel`. */
  model: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The thinking levels a model can actually accept, in Pi's canonical order.
 * A missing model has no choices rather than a fabricated one.
 */
export function supportedThinkingLevels(model: ModelLike | null | undefined): AiesThinkingLevel[] {
  if (!model) return [];
  if (model.reasoning !== true) return ["off"];

  const map = asRecord(model.thinkingLevelMap);
  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/** Whether the level is one of the model's real, selectable choices. */
export function isThinkingLevelSupported(
  model: ModelLike | null | undefined,
  level: string,
): level is AiesThinkingLevel {
  return supportedThinkingLevels(model).includes(level as AiesThinkingLevel);
}

/**
 * Return the requested level only when the model supports it. An unsupported
 * request resolves to `undefined`, never to a clamped neighbour, so the caller
 * can never persist or surface a level the model cannot run.
 */
export function normalizeThinkingLevel(
  model: ModelLike | null | undefined,
  level: unknown,
): AiesThinkingLevel | undefined {
  if (typeof level !== "string") return undefined;
  return isThinkingLevelSupported(model, level) ? (level as AiesThinkingLevel) : undefined;
}

/** Project one raw Pi model into a display option, or `undefined` when unusable. */
export function projectModelOption(model: unknown): ModelOption | undefined {
  const record = asRecord(model);
  const provider = nonEmptyString(record?.provider);
  const id = nonEmptyString(record?.id);
  if (!provider || !id) return undefined;

  const name = nonEmptyString(record?.name) ?? id;
  const reasoning = record?.reasoning === true;

  return {
    provider,
    id,
    name,
    value: `${provider}/${id}`,
    label: `${provider} · ${name}`,
    reasoning,
    levels: supportedThinkingLevels(record as ModelLike),
    model,
  };
}

/**
 * Project every model in a raw array the registry returned, deduping by
 * `provider/id` and sorting by provider then display name. Non-array input (a
 * hostile or partial registry) degrades to an empty list rather than throwing.
 */
export function projectModelOptions(raw: unknown): ModelOption[] {
  if (!Array.isArray(raw)) return [];

  const options: ModelOption[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    const option = projectModelOption(candidate);
    if (!option || seen.has(option.value)) continue;
    seen.add(option.value);
    options.push(option);
  }
  options.sort(
    (left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name),
  );
  return options;
}

/**
 * Project every model the registry currently reports as available. Only
 * `getAvailable()` is consulted, so a model without configured auth can never
 * appear; a missing or throwing registry degrades to an empty list.
 */
export function availableModelOptions(registry: unknown): ModelOption[] {
  let raw: unknown;
  try {
    const getAvailable = asRecord(registry)?.getAvailable;
    if (typeof getAvailable !== "function") return [];
    raw = (getAvailable as () => unknown).call(registry);
  } catch {
    return [];
  }
  return projectModelOptions(raw);
}
