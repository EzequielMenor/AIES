/**
 * Isolated persistence for provider credential health.
 *
 * Records live under the `providerHealth` key of
 * `$PI_CODING_AGENT_DIR/aies.json`, the same isolated AIES config file the
 * model picker writes. Writes preserve every unrelated top-level key, refuse to
 * clobber a file they cannot parse, and land through an atomic temp-file +
 * rename so a crash can never leave a half-written config. A missing agent dir
 * fails closed with a Spanish error instead of falling back to the ambient
 * `~/.pi/agent`.
 *
 * Only the truncated digest produced by `credentialFingerprint` is stored; the
 * raw secret never reaches this file.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseProviderHealth, type ProviderHealthRecord } from "./health.ts";

/** The AIES config file inside the isolated agent dir. */
export const AIES_CONFIG_FILE = "aies.json";

/** The key under which credential-health records are persisted. */
export const PROVIDER_HEALTH_KEY = "providerHealth";

// This guarded-parse + atomic-write primitive intentionally mirrors
// `extensions/aies-models/config.ts` rather than importing it: the two modules
// own different keys of the same file, and a cross-extension dependency for a
// 35-line primitive is not worth it until a third caller exists.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type ParsedConfig =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

/** Guarded parse: a missing/empty file is an empty object; invalid content fails. */
function parseConfigFile(agentDir: string | undefined): ParsedConfig {
  if (!agentDir) {
    return { ok: false, error: "PI_CODING_AGENT_DIR no está configurado" };
  }

  const path = join(agentDir, AIES_CONFIG_FILE);
  if (!existsSync(path)) return { ok: true, data: {} };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return {
      ok: false,
      error: `no se pudo leer ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!raw.trim()) return { ok: true, data: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `${path} no es JSON válido` };
  }

  const data = asRecord(parsed);
  if (!data) return { ok: false, error: `${path} no contiene un objeto JSON` };
  return { ok: true, data };
}

/**
 * Read every stored health record. A missing, unreadable or malformed file
 * resolves to an empty map rather than throwing.
 */
export function readProviderHealth(
  agentDir: string | undefined,
): Record<string, ProviderHealthRecord> {
  const parsed = parseConfigFile(agentDir);
  if (!parsed.ok) return {};
  return parseProviderHealth(parsed.data[PROVIDER_HEALTH_KEY]);
}

/**
 * Persist the whole health map while preserving every unrelated key. Refuses to
 * overwrite a file it cannot parse, writes atomically and fails closed when the
 * isolated agent dir is absent.
 */
export function writeProviderHealth(
  agentDir: string | undefined,
  records: Record<string, ProviderHealthRecord>,
): { ok: true } | { ok: false; error: string } {
  if (!agentDir) {
    return {
      ok: false,
      error: "PI_CODING_AGENT_DIR no está configurado; no se persiste nada fuera del perfil aislado",
    };
  }

  const path = join(agentDir, AIES_CONFIG_FILE);
  const parsed = parseConfigFile(agentDir);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const next: Record<string, unknown> = { ...parsed.data, [PROVIDER_HEALTH_KEY]: records };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A leftover temp file is preferable to losing the real config.
    }
    return {
      ok: false,
      error: `no se pudo escribir ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Read-modify-write one provider's record. The inverse of `readProviderHealth`
 * for a single provider, with the same atomicity and fail-closed guarantees.
 */
export function recordRejection(
  agentDir: string | undefined,
  record: ProviderHealthRecord,
): { ok: true } | { ok: false; error: string } {
  const current = readProviderHealth(agentDir);
  return writeProviderHealth(agentDir, { ...current, [record.provider]: record });
}
