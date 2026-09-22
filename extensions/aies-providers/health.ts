/**
 * Pure credential-health classification for the AIES provider layer.
 *
 * AIES policy: a provider is selectable only when it is connected **and** its
 * credential is usable. This module owns the second half of that policy — the
 * classification of a failed turn into a *credential rejection* — and nothing
 * else. It is host-free and deterministic: no `node:fs`, no Pi imports, no
 * network and no clock. It never throws, so a hostile provider error can never
 * break a session.
 *
 * The only sound runtime signal that a credential is actually *rejected* is the
 * failed turn. Pi 0.87.0 fires neither `after_provider_response` nor `error` on
 * an HTTP 401; `turn_end` does fire, with `message.stopReason === "error"` and
 * `message.errorMessage` carrying the provider body. Availability, by contrast,
 * depends on credential *presence* only, so a present-but-wrong key still
 * advertises its models until a real request fails.
 *
 * Only a truncated SHA-256 digest of the rejected credential is ever persisted
 * (see `store.ts`); the secret itself is never stored, logged or rendered.
 */

import { createHash } from "node:crypto";

/** Truncated SHA-256 hex length used for credential fingerprints. */
export const FINGERPRINT_LENGTH = 16;

/** Longest reason token AIES will keep from a provider error body. */
const MAX_REASON_LENGTH = 48;

/** Longest user-facing label produced by `rejectionLabel`. */
const MAX_LABEL_LENGTH = 96;

/**
 * Lowercase tokens that mark a credential as rejected rather than merely
 * failing. Order is significant: the first match wins and becomes `reason`.
 * The set is intentionally narrow — only authentication/authorization signals,
 * never rate limits, server errors, network faults or aborts.
 */
const REJECTION_TOKENS: readonly string[] = [
  "authentication_error",
  "invalid_api_key",
  "invalid api key",
  "api key is invalid",
  "incorrect api key",
  "invalid x-api-key",
  "invalid bearer",
  "permission_error",
  "permission denied",
  "accessdenied",
  "unpurchased",
  "unauthorized",
  "forbidden",
];

/** Leading HTTP status, tolerating leading whitespace and refusing 4+ digits. */
const STATUS_PATTERN = /^\s*(\d{3})(?!\d)/;

/** A parsed credential rejection. Never contains the raw error body. */
export interface CredentialRejection {
  /** HTTP status parsed from the provider error, when present. */
  status?: number;
  /** Bounded reason token, e.g. "authentication_error". Never a secret. */
  reason: string;
}

/** One persisted observation that a provider rejected its credential. */
export interface ProviderHealthRecord {
  provider: string;
  /** Truncated SHA-256 digest of the rejected credential. NEVER the secret. */
  fingerprint: string;
  status?: number;
  reason: string;
  /** Epoch milliseconds. */
  observedAt: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A truncated SHA-256 digest of the secret, used only to detect that the
 * credential changed. Any non-string, empty or whitespace-only input has no
 * fingerprint — a credential AIES cannot read must never be mistaken for one.
 */
export function credentialFingerprint(secret: unknown): string | undefined {
  if (typeof secret !== "string" || !secret.trim()) return undefined;
  return createHash("sha256").update(secret).digest("hex").slice(0, FINGERPRINT_LENGTH);
}

/**
 * Classify a failed turn as a credential rejection, or `undefined` when it is
 * anything else (rate limit, server error, network fault, abort, stream error).
 *
 * Rejection requires `stopReason === "error"` and a non-empty `errorMessage`,
 * then either an HTTP 401/403 or one of the documented rejection tokens.
 */
export function classifyCredentialRejection(input: {
  stopReason?: unknown;
  errorMessage?: unknown;
}): CredentialRejection | undefined {
  const { stopReason, errorMessage } = input ?? {};
  if (stopReason !== "error") return undefined;
  if (typeof errorMessage !== "string" || !errorMessage.trim()) return undefined;

  const statusMatch = STATUS_PATTERN.exec(errorMessage);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;

  const lowercased = errorMessage.toLowerCase();
  let token: string | undefined;
  for (const candidate of REJECTION_TOKENS) {
    if (lowercased.includes(candidate)) {
      token = candidate;
      break;
    }
  }

  const statusIsRejection = status === 401 || status === 403;
  if (!statusIsRejection && token === undefined) return undefined;

  const reason = (token ?? (status !== undefined ? `HTTP ${status}` : "credencial rechazada")).slice(
    0,
    MAX_REASON_LENGTH,
  );

  return status !== undefined ? { status, reason } : { reason };
}

/** Whether a decoded value is a complete, well-formed health record. */
function isProviderHealthRecord(value: unknown): value is ProviderHealthRecord {
  const raw = asRecord(value);
  if (!raw) return false;
  if (!nonEmptyString(raw.provider)) return false;
  if (!nonEmptyString(raw.fingerprint)) return false;
  if (!nonEmptyString(raw.reason)) return false;
  if (finiteNumber(raw.observedAt) === undefined) return false;
  if (raw.status !== undefined && finiteNumber(raw.status) === undefined) return false;
  return true;
}

/**
 * Whether a stored record still describes the credential the session would use
 * right now.
 *
 * This is deliberately **fail-open**: when AIES cannot resolve the current
 * credential (`currentFingerprint` is absent) or the record is malformed, the
 * answer is `false`, so stale evidence can never suppress a provider. A record
 * self-heals the moment the credential changes, because the digests differ.
 */
export function recordApplies(
  record: ProviderHealthRecord | undefined,
  currentFingerprint: string | undefined,
): boolean {
  if (!isProviderHealthRecord(record)) return false;
  if (typeof currentFingerprint !== "string" || !currentFingerprint.trim()) return false;
  return record.fingerprint === currentFingerprint;
}

/**
 * Bounded Spanish label for the UI. It never carries the fingerprint or any
 * secret, and it does not repeat a status the reason already encodes.
 */
export function rejectionLabel(record: ProviderHealthRecord): string {
  const parts = ["credencial rechazada"];
  const reason = nonEmptyString(record?.reason) ?? "";
  const status = finiteNumber(record?.status);
  const reasonIsStatus = status !== undefined && reason === `HTTP ${status}`;
  if (status !== undefined && !reasonIsStatus) parts.push(`HTTP ${status}`);
  if (reason) parts.push(reason);
  return parts.join(" · ").slice(0, MAX_LABEL_LENGTH);
}

/**
 * Narrow untrusted JSON into a provider-keyed record map. Only well-formed
 * records survive; invalid entries are dropped silently and this never throws.
 * A record is keyed by its own `provider` id when present.
 */
export function parseProviderHealth(value: unknown): Record<string, ProviderHealthRecord> {
  const root = asRecord(value);
  if (!root) return {};

  const out: Record<string, ProviderHealthRecord> = {};
  for (const [key, entry] of Object.entries(root)) {
    if (!isProviderHealthRecord(entry)) continue;
    const provider = nonEmptyString(entry.provider) ?? key;
    const record: ProviderHealthRecord = {
      provider,
      fingerprint: entry.fingerprint,
      reason: entry.reason,
      observedAt: entry.observedAt,
    };
    const status = finiteNumber(entry.status);
    if (status !== undefined) record.status = status;
    out[provider] = record;
  }
  return out;
}
