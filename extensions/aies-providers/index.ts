/**
 * AIES provider credential health — Pi wiring (EZE-453 / T1).
 *
 * Policy this extension enforces, generically and with no vendor special case:
 *
 * ```
 * connected + credential usable  → selectable
 * disconnected                   → not selectable ("no conectado")
 * connected + credential rejected → not selectable, with the observed status
 * ```
 *
 * The only sound runtime signal that a credential is actually *rejected* — as
 * opposed to merely present — is the failed turn. On Pi 0.87.0 an HTTP 401
 * fires neither `after_provider_response` (the stream never starts) nor the
 * `error` event; `turn_end` does fire, carrying `message.stopReason === "error"`
 * and the provider body in `message.errorMessage`. Model availability itself
 * depends on credential *presence* only, so a present-but-wrong key keeps
 * advertising its models until a real request fails. That is why this observer
 * is the only place a rejection can be learned from.
 *
 * What is recorded is deliberately minimal: a truncated SHA-256 digest of the
 * rejected credential, the provider id, the status, a bounded reason and a
 * timestamp. The secret is never stored, logged or rendered. Because the digest
 * identifies the *credential*, the record self-heals: once the credential
 * changes (a fresh `/login`), the next observation no longer matches and the
 * provider is allowed back. When AIES cannot resolve a credential it records
 * nothing, so it can never suppress a provider on evidence that cannot heal.
 *
 * This module is wiring only: one `turn_end` handler, no command, no widget, no
 * startup work and no network. The handler swallows every error so a broken
 * notification or a hostile provider body can never break a session.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  classifyCredentialRejection,
  credentialFingerprint,
  recordApplies,
  rejectionLabel,
  type ProviderHealthRecord,
} from "./health.ts";
import { readProviderHealth, recordRejection } from "./store.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The isolated agent dir, or `undefined` so callers fail closed rather than
 * fall back to the ambient `~/.pi/agent`. Mirrors the model picker's helper
 * locally instead of importing across extensions.
 */
function isolatedAgentDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.PI_CODING_AGENT_DIR;
  return typeof dir === "string" && dir.trim() ? dir.trim() : undefined;
}

/** A notification must never be able to break a session. */
function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    // A host without notifications keeps the session silent rather than noisy.
  }
}

export default function aiesProviders(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    try {
      const message = asRecord(event?.message);
      if (!message) return;
      if (message.stopReason !== "error") return;

      const rejection = classifyCredentialRejection({
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
      });
      if (!rejection) return;

      const provider =
        nonEmptyString(message.provider) ?? nonEmptyString(ctx?.model?.provider);
      if (!provider) return;

      // Resolving the credential may reject or execute a configured command;
      // an unresolvable credential is not recordable evidence.
      let fingerprint: string | undefined;
      try {
        fingerprint = credentialFingerprint(await ctx.modelRegistry.getApiKeyForProvider(provider));
      } catch {
        return;
      }
      if (!fingerprint) return;

      const agentDir = isolatedAgentDir();
      const existing = readProviderHealth(agentDir)[provider];
      const unchanged =
        recordApplies(existing, fingerprint) &&
        existing?.status === rejection.status &&
        existing?.reason === rejection.reason;
      if (unchanged) return;

      const record: ProviderHealthRecord = {
        provider,
        fingerprint,
        reason: rejection.reason,
        observedAt: Date.now(),
      };
      if (rejection.status !== undefined) record.status = rejection.status;

      const written = recordRejection(agentDir, record);
      if (!written.ok) return;

      notify(
        ctx,
        `${provider} · ${rejectionLabel(record)} — no queda seleccionable en /aies-models; corregí la clave o ejecutá /login ${provider}`,
        "warning",
      );
    } catch {
      // The observer is best-effort: it must never break the turn it watches.
    }
  });
}
