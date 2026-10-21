/**
 * Which memory store a session may use, and what to say about it (D42, D40).
 *
 * The project key comes from one place only: the explicit `repos` binding of `aies.json`
 * (`scripts/bind-project.mjs`) for the git repository the session runs in. It is never read from a
 * tool argument, from a ticket text or from the model. An unbound repository, an ambiguous binding
 * (two projects bound to one repository), a key that cannot be a directory name, a missing
 * `AIES_HOME`: each means "memory unavailable". There is no fallback to another project and no
 * shared store.
 *
 * Pure reads plus `git rev-parse`; no write, no network. Node only, so `bin/aies --aies-info` can
 * import it.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { gitToplevel, readRepoGuardConfig, samePath } from "../aies-agents/repo-guard.ts";
import { isValidProjectKey } from "./guards.ts";
import { createMemoryStore, type MemoryErrorCode, type MemoryStore, type MemoryStoreOptions } from "./store.ts";

export type MemoryScope =
  | { ok: true; key: string; aiesHome: string; root: string }
  | { ok: false; reason: string; key?: string };

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The scope of the session that runs in `cwd`, or why there is none. */
export function resolveMemoryScope(cwd: string, env: NodeJS.ProcessEnv = process.env): MemoryScope {
  const aiesHome = env.AIES_HOME;
  if (!aiesHome || !isAbsolute(aiesHome)) return { ok: false, reason: "AIES_HOME is not set" };

  const root = typeof cwd === "string" && cwd.length > 0 ? gitToplevel(cwd) : undefined;
  if (!root) return { ok: false, reason: "this directory is not a git repository" };

  const config = readRepoGuardConfig(env);
  const keys = Object.entries(config.repos)
    .filter(([, bound]) => samePath(realOrResolved(bound), root))
    .map(([key]) => key);
  if (keys.length === 0) return { ok: false, reason: "this repository is not bound to a project" };
  if (keys.length > 1) return { ok: false, reason: "this repository is bound to more than one project" };

  const key = keys[0];
  if (!isValidProjectKey(key)) return { ok: false, reason: "the bound project name cannot be used as a store name" };
  return { ok: true, key, aiesHome, root };
}

export interface MemoryConfig {
  /** True only when the user set `memory.writes` to `true`: the runtime may then store the learnings a completed ticket proposes (`learn.ts`). */
  writes: boolean;
}

/** `memory.writes` of `$PI_CODING_AGENT_DIR/aies.json`. Absent, invalid or unreadable means false. */
export function readMemoryConfig(env: NodeJS.ProcessEnv = process.env): MemoryConfig {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (!agentDir) return { writes: false };
  const configPath = join(agentDir, "aies.json");
  try {
    if (!existsSync(configPath)) return { writes: false };
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { memory?: { writes?: unknown } } | null;
    return { writes: parsed?.memory?.writes === true };
  } catch {
    return { writes: false };
  }
}

export interface MemoryNotice {
  level: "info" | "warning";
  message: string;
  available: boolean;
}

/** Reasons that are a normal state of a profile, not a fault worth a warning. */
const QUIET_CODES: ReadonlySet<MemoryErrorCode | undefined> = new Set(["pjm_missing", undefined]);

/**
 * The one line `--aies-info` and the startup notice show:
 * `memory: <available|unavailable (reason)> project=<key> events=<n>`.
 */
export async function describeMemory(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  storeOptions: Partial<MemoryStoreOptions> = {},
): Promise<MemoryNotice> {
  const scope = resolveMemoryScope(cwd, env);
  if (!scope.ok) {
    return { level: "info", available: false, message: `memory: unavailable (${scope.reason}) project=none events=n/a` };
  }
  const store = createMemoryStore({ aiesHome: scope.aiesHome, projectKey: scope.key, env, ...storeOptions });
  const status = await store.status();
  const events = status.events === null ? "n/a" : `${status.eventsAtLeast ? ">=" : ""}${status.events}`;
  if (status.available) {
    return { level: "info", available: true, message: `memory: available project=${scope.key} events=${events}` };
  }
  return {
    level: QUIET_CODES.has(status.code) ? "info" : "warning",
    available: false,
    message: `memory: unavailable (${status.reason ?? "unknown"}) project=${scope.key} events=${events}`,
  };
}

/** A store for a resolved scope. */
export function storeForScope(scope: Extract<MemoryScope, { ok: true }>, options: Partial<MemoryStoreOptions> = {}): MemoryStore {
  return createMemoryStore({ aiesHome: scope.aiesHome, projectKey: scope.key, ...options });
}
