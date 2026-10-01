/**
 * Isolated preference persistence for `/aies-models` (AIES-010D / T12).
 *
 * Two separate stores, both confined to the isolated AIES profile:
 *
 * - Child roles persist into `$PI_CODING_AGENT_DIR/aies.json`. Writes preserve
 *   every unrelated key, refuse to clobber an unparseable file and land through
 *   an atomic write/rename so a crash can never leave a half-written config.
 * - The Parent default persists through Pi's public `SettingsManager`, which
 *   owns `$PI_CODING_AGENT_DIR/settings.json`. It fails safely when the isolated
 *   agent dir is absent instead of falling back to the ambient `~/.pi/agent`.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { normalizeThinkingLevel, type AiesThinkingLevel, type ModelLike } from "./capabilities.ts";

/** The AIES child-preference file inside the isolated agent dir. */
export const AIES_CONFIG_FILE = "aies.json";

/** Every preference role the picker can edit. */
export type AiesRole = "parent" | "explore" | "worker" | "verify";

/** The roles that persist into the AIES child config (Parent uses Pi settings). */
export type AiesChildRole = Exclude<AiesRole, "parent">;

/** The child roles in product order. */
export const CHILD_ROLES: readonly AiesChildRole[] = ["explore", "worker", "verify"];

/** One stored child preference. */
export interface ChildPreference {
  model?: string;
  thinkingLevel?: AiesThinkingLevel;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

type ParsedConfig =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

/** Guarded parse: a missing/empty file is an empty object; invalid content fails. */
function parseConfig(path: string): ParsedConfig {
  if (!existsSync(path)) return { ok: true, data: {} };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, error: `no se pudo leer ${path}: ${error instanceof Error ? error.message : String(error)}` };
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

function configPath(agentDir: string): string {
  return join(agentDir, AIES_CONFIG_FILE);
}

function preferenceOf(value: unknown): ChildPreference | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const model = nonEmptyString(record.model);
  const thinkingLevel = typeof record.thinkingLevel === "string" ? record.thinkingLevel : undefined;
  if (!model && !thinkingLevel) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel: thinkingLevel as AiesThinkingLevel } : {}),
  };
}

/**
 * Read every child preference from the isolated config. A missing, unreadable
 * or malformed file resolves to an empty map rather than throwing.
 */
export function readChildPreferences(agentDir: string | undefined): Partial<Record<AiesChildRole, ChildPreference>> {
  if (!agentDir) return {};
  const parsed = parseConfig(configPath(agentDir));
  if (!parsed.ok) return {};

  const agents = asRecord(parsed.data.agents);
  if (!agents) return {};

  const out: Partial<Record<AiesChildRole, ChildPreference>> = {};
  for (const role of CHILD_ROLES) {
    const preference = preferenceOf(agents[role]);
    if (preference) out[role] = preference;
  }
  return out;
}

/** Read one child preference, or `undefined` when none is stored. */
export function readChildPreference(
  agentDir: string | undefined,
  role: AiesChildRole,
): ChildPreference | undefined {
  return readChildPreferences(agentDir)[role];
}

/**
 * Persist one child preference while preserving every unrelated key. Refuses to
 * overwrite an existing file it cannot parse and writes atomically.
 */
export function writeChildPreference(
  agentDir: string | undefined,
  role: AiesChildRole,
  preference: ChildPreference,
): { ok: true } | { ok: false; error: string } {
  if (!agentDir) {
    return { ok: false, error: "PI_CODING_AGENT_DIR no está configurado; no se persiste nada fuera del perfil aislado" };
  }

  const path = configPath(agentDir);
  const parsed = parseConfig(path);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const next: Record<string, unknown> = { ...parsed.data };
  const agents: Record<string, unknown> = { ...(asRecord(parsed.data.agents) ?? {}) };
  const current = asRecord(agents[role]) ?? {};
  const merged: Record<string, unknown> = { ...current };

  const model = nonEmptyString(preference.model);
  if (model) merged.model = model;
  if (preference.thinkingLevel) merged.thinkingLevel = preference.thinkingLevel;
  agents[role] = merged;
  next.agents = agents;

  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // A leftover temp file is preferable to losing the real config.
    }
    return { ok: false, error: `no se pudo escribir ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface ParentDefaultInput {
  cwd: string;
  agentDir: string | undefined;
  provider: string;
  modelId: string;
  thinkingLevel?: AiesThinkingLevel;
  /** The selected model, so an explicitly supported xhigh/max level is not dropped. */
  model?: ModelLike;
}

/**
 * Persist the Parent default through Pi's public settings manager. The manager
 * is always pointed at the isolated agent dir; a missing dir is a safe failure,
 * never a fallback to the ambient profile.
 */
export async function persistParentDefaults(
  input: ParentDefaultInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { cwd, agentDir, provider, modelId, thinkingLevel, model } = input;
  if (!agentDir) {
    return { ok: false, error: "PI_CODING_AGENT_DIR no está configurado; no se persiste el modelo Parent" };
  }
  if (!provider || !modelId) {
    return { ok: false, error: "provider y modelId son obligatorios" };
  }

  try {
    const manager = SettingsManager.create(cwd, agentDir);
    manager.setDefaultModelAndProvider(provider, modelId);
    const level = normalizeThinkingLevel(model ?? { reasoning: true }, thinkingLevel);
    if (level) manager.setModelThinkingLevel(provider, modelId, level);
    await manager.flush();

    const errors = typeof manager.drainErrors === "function" ? manager.drainErrors() : [];
    if (errors.length > 0) {
      const first = errors[0];
      return { ok: false, error: `no se pudo persistir la configuración: ${first?.error?.message ?? "error desconocido"}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `no se pudo persistir la configuración: ${error instanceof Error ? error.message : String(error)}` };
  }
}
