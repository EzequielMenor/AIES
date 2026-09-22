/**
 * Provider projection for `/aies-models` (EZE-453 / T2).
 *
 * `/aies-models` must answer three questions the flat model list cannot: is a
 * provider *installed* (registered), is it *connected* (has a credential) and,
 * when it is connected, was that credential *rejected* by the provider. This
 * module turns the public registry surface plus the persisted credential health
 * into one bounded projection, and nothing else.
 *
 * It is pure and host-free: no `node:fs`, no network and no clock. Every
 * registry access is guarded and structurally narrowed, so a hostile or partial
 * registry degrades to an empty projection instead of throwing. It never
 * enumerates the ~40 disconnected vendors Pi knows about; they are represented
 * by a single count so the signal (the two or three providers a user actually
 * configured) is not drowned by noise.
 *
 * The policy, with no vendor special case:
 * - a recorded rejection that still matches the current credential -> `rejected`,
 *   and the provider stays unselectable even if the registry advertises models;
 * - otherwise, at least one available model -> `usable`;
 * - otherwise, no configured credential -> `disconnected`;
 * - otherwise, configured but nothing available -> `empty`.
 */

import {
  availableModelOptions,
  projectModelOptions,
  type ModelOption,
} from "./capabilities.ts";
import {
  recordApplies,
  rejectionLabel,
  type ProviderHealthRecord,
} from "../aies-providers/health.ts";

/** Whether a provider can be selected in `/aies-models`. */
export type ProviderState = "usable" | "rejected" | "disconnected" | "empty";

/** Pi's `/model` scope toggle: every usable provider or only the scoped set. */
export type ModelScope = "all" | "scoped";

/** The bounded Spanish label every state renders with. */
export const PROVIDER_STATE_LABELS: Record<Exclude<ProviderState, "usable">, string> = {
  rejected: "credencial rechazada",
  disconnected: "no conectado",
  empty: "sin modelos disponibles",
};

/** One usable provider and its selectable models. */
export interface ProviderSection {
  /** Provider id, e.g. `commandcode`. */
  id: string;
  /** Display name from the registry, falling back to the id. */
  name: string;
  state: ProviderState;
  /** Selectable models; non-empty only when `state === "usable"`. */
  models: ModelOption[];
  /** Models the registry knows for this provider, available or not. */
  totalModels: number;
  /** Pi's `AuthStatus.source` when the provider is configured. */
  authSource?: string;
  /** Present only when `state === "rejected"`. */
  rejection?: ProviderHealthRecord;
}

/** One bounded, non-selectable row for the UI. */
export interface UnavailableProviderRow {
  id: string;
  /** Spanish state marker, at most 32 characters. */
  stateLabel: string;
  /** Bounded detail, e.g. `HTTP 401 · authentication_error` or `0/76`. */
  detail?: string;
  /** Bounded fix hint, e.g. `/login commandcode`. */
  hint?: string;
}

/** The bounded projection the picker renders. */
export interface ProviderProjection {
  /** The full-catalogue usable providers, sorted by display name then id. */
  usable: ProviderSection[];
  /**
   * The usable providers restricted to the scoped model set. When `hasScoped`
   * is false this is a structurally equal (but not aliased) copy of `usable`,
   * so a caller can never read a stale empty list.
   */
  scopedUsable: ProviderSection[];
  /** True when the scoped set is non-empty (Pi's rule). */
  hasScoped: boolean;
  /** Flat selectable list across usable providers, in provider then name order. */
  models: ModelOption[];
  /** Bounded non-selectable rows: rejected first, then registered-but-unusable. */
  attention: UnavailableProviderRow[];
  /** Disconnected vendors deliberately not enumerated. */
  hiddenDisconnected: number;
  /** The single bounded overlay line about everything that cannot be selected. */
  notUsable: NotUsableSummary;
}

/** The single bounded overlay line about providers that cannot be selected. */
export interface NotUsableSummary {
  /** Every rejected + registered-but-unusable provider, untruncated. */
  count: number;
  /** At most 2 display fragments, e.g. `["anthropic (401)", "llama.cpp"]`. */
  names: string[];
  /** `count - names.length`, never negative. */
  extra: number;
}

export interface ProviderProjectionInput {
  registry: unknown;
  health: Record<string, ProviderHealthRecord>;
  /** Current credential digest per provider, resolved by the caller (async). */
  fingerprints: Record<string, string | undefined>;
  /** Pi's `ctx.scopedModels`; malformed input degrades to no scoping. */
  scopedModels?: unknown;
  /** Cap on `attention` rows. Default 6. */
  maxAttention?: number;
}

/** Field limits, so no row can grow with provider input. */
const DETAIL_LIMIT = 48;
const HINT_LIMIT = 40;
const STATE_LABEL_LIMIT = 32;
const DEFAULT_MAX_ATTENTION = 6;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Clip a value to `max` characters with a trailing ellipsis. */
function bound(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** Call one registry method defensively: a missing or throwing method is `undefined`. */
function callRegistry(registry: unknown, name: string, ...args: unknown[]): unknown {
  const method = asRecord(registry)?.[name];
  if (typeof method !== "function") return undefined;
  try {
    return (method as (...values: unknown[]) => unknown).apply(registry, args);
  } catch {
    return undefined;
  }
}

/** The extension-registered provider ids, deduped and trimmed. */
function registeredProviderIds(registry: unknown): string[] {
  const raw = callRegistry(registry, "getRegisteredProviderIds");
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const value of raw) {
    const id = nonEmptyString(value);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Pi's auth status for one provider, narrowed to the fields this module uses. */
function authStatusOf(registry: unknown, id: string): { configured: boolean; source?: string } {
  const record = asRecord(callRegistry(registry, "getProviderAuthStatus", id));
  if (!record) return { configured: false };
  const source = nonEmptyString(record.source);
  return source ? { configured: record.configured === true, source } : { configured: record.configured === true };
}

/** The provider display name, falling back to the id. */
function providerName(registry: unknown, id: string): string {
  return nonEmptyString(callRegistry(registry, "getProviderDisplayName", id)) ?? id;
}

/** The health record's label with its leading state marker removed. */
function rejectionDetail(record: ProviderHealthRecord | undefined): string {
  if (!record) return "";
  const label = rejectionLabel(record);
  const prefix = PROVIDER_STATE_LABELS.rejected;
  const stripped = label.startsWith(prefix) ? label.slice(prefix.length).replace(/^\s*·\s*/, "") : label;
  return bound(stripped, DETAIL_LIMIT);
}

function rejectedRow(id: string, record: ProviderHealthRecord | undefined): UnavailableProviderRow {
  const detail = rejectionDetail(record);
  return {
    id,
    stateLabel: bound(PROVIDER_STATE_LABELS.rejected, STATE_LABEL_LIMIT),
    ...(detail ? { detail } : {}),
    hint: bound(`/login ${id}`, HINT_LIMIT),
  };
}

interface ResolvedProvider {
  id: string;
  name: string;
  state: ProviderState;
  models: ModelOption[];
  totalModels: number;
  authSource?: string;
  rejection?: ProviderHealthRecord;
}

/** The bounded row for a disconnected or empty provider, when registered. */
function unavailableRow(item: ResolvedProvider): UnavailableProviderRow {
  if (item.state === "empty") {
    return { id: item.id, stateLabel: bound(PROVIDER_STATE_LABELS.empty, STATE_LABEL_LIMIT) };
  }
  const detail = item.totalModels > 0 ? bound(`0/${item.totalModels}`, DETAIL_LIMIT) : undefined;
  return {
    id: item.id,
    stateLabel: bound(PROVIDER_STATE_LABELS.disconnected, STATE_LABEL_LIMIT),
    ...(detail ? { detail } : {}),
    hint: bound(`/login ${item.id}`, HINT_LIMIT),
  };
}

function attentionLimit(maxAttention: unknown): number {
  if (typeof maxAttention !== "number" || !Number.isFinite(maxAttention)) return DEFAULT_MAX_ATTENTION;
  return Math.max(0, Math.floor(maxAttention));
}

/**
 * Narrow Pi's `ctx.scopedModels` to a set of `provider/id` keys. The input is
 * untrusted: a missing host field, a non-array or any malformed entry simply
 * contributes nothing, so the caller degrades to unscoped instead of throwing.
 */
function scopedModelKeys(scopedModels: unknown): Set<string> {
  const keys = new Set<string>();
  if (!Array.isArray(scopedModels)) return keys;
  for (const entry of scopedModels) {
    const model = asRecord(asRecord(entry)?.model);
    const provider = nonEmptyString(model?.provider);
    const id = nonEmptyString(model?.id);
    if (provider && id) keys.add(`${provider}/${id}`);
  }
  return keys;
}

/**
 * Project the registry and the credential health into the bounded shape the
 * picker and the headless report render. Never throws.
 */
export function projectProviders(input: ProviderProjectionInput): ProviderProjection {
  const registry = input?.registry;
  const health = input?.health ?? {};
  const fingerprints = input?.fingerprints ?? {};

  const available = availableModelOptions(registry);
  const catalogModels = projectModelOptions(callRegistry(registry, "getAll"));
  const registered = registeredProviderIds(registry);

  const modelsByProvider = new Map<string, ModelOption[]>();
  for (const option of available) {
    const list = modelsByProvider.get(option.provider) ?? [];
    list.push(option);
    modelsByProvider.set(option.provider, list);
  }

  const totals = new Map<string, Set<string>>();
  for (const option of [...catalogModels, ...available]) {
    const set = totals.get(option.provider) ?? new Set<string>();
    set.add(option.value);
    totals.set(option.provider, set);
  }

  const ids = new Set<string>(totals.keys());
  for (const id of registered) ids.add(id);

  const resolved: ResolvedProvider[] = [];
  for (const id of ids) {
    const status = authStatusOf(registry, id);
    const record = health[id];
    const applies = recordApplies(record, fingerprints[id]);
    let state: ProviderState;
    const models = modelsByProvider.get(id) ?? [];
    if (applies) state = "rejected";
    else if (models.length > 0) state = "usable";
    else if (status.configured) state = "empty";
    else state = "disconnected";

    resolved.push({
      id,
      name: providerName(registry, id),
      state,
      models,
      totalModels: totals.get(id)?.size ?? 0,
      ...(status.source ? { authSource: status.source } : {}),
      ...(applies && record ? { rejection: record } : {}),
    });
  }

  const usable: ProviderSection[] = resolved
    .filter((item) => item.state === "usable")
    .map((item) => ({
      id: item.id,
      name: item.name,
      state: "usable" as const,
      models: item.models,
      totalModels: item.totalModels,
      ...(item.authSource ? { authSource: item.authSource } : {}),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  const models = usable.flatMap((section) => section.models);

  const scopedKeys = scopedModelKeys(input?.scopedModels);
  const hasScoped = scopedKeys.size > 0;
  const scopedUsable: ProviderSection[] = hasScoped
    ? usable
        .map((section) => ({
          ...section,
          models: section.models.filter((option) => scopedKeys.has(option.value)),
        }))
        .filter((section) => section.models.length > 0)
    : usable.map((section) => ({ ...section, models: [...section.models] }));

  const rejectedResolved = resolved
    .filter((item) => item.state === "rejected")
    .sort((left, right) => left.id.localeCompare(right.id));

  const registeredSet = new Set(registered);
  const registeredUnusableResolved = resolved
    .filter((item) => (item.state === "disconnected" || item.state === "empty") && registeredSet.has(item.id))
    .sort((left, right) => left.id.localeCompare(right.id));

  const rejectedRows = rejectedResolved.map((item) => rejectedRow(item.id, item.rejection));
  const registeredUnusableRows = registeredUnusableResolved.map(unavailableRow);

  const attention = [...rejectedRows, ...registeredUnusableRows].slice(0, attentionLimit(input?.maxAttention));

  const attentionIds = new Set(attention.map((row) => row.id));
  const hiddenDisconnected = resolved.filter(
    (item) => item.state === "disconnected" && !attentionIds.has(item.id),
  ).length;

  // The summary counts the full, untruncated set: the rejected providers first,
  // then the registered-but-unusable ones, with the HTTP status when AIES has
  // one. The ~36 unregistered disconnected vendors stay out of the count —
  // `hiddenDisconnected` already covers them.
  const names = [
    ...rejectedResolved.map((item) =>
      item.rejection?.status !== undefined ? `${item.id} (${item.rejection.status})` : item.id,
    ),
    ...registeredUnusableResolved.map((item) => item.id),
  ].slice(0, 2);
  const count = rejectedResolved.length + registeredUnusableResolved.length;
  const notUsable: NotUsableSummary = { count, names, extra: Math.max(0, count - names.length) };

  return { usable, scopedUsable, hasScoped, models, attention, hiddenDisconnected, notUsable };
}
