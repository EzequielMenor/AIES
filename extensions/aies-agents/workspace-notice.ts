/**
 * D40: the startup notice about the tracker and the repository binding.
 *
 * One line, shown once when a session starts with a UI: which tracker the profile
 * uses, and whether the git repository the session runs in is bound to a project in
 * the `repos` table of `aies.json`. The binding itself is written only by
 * `scripts/bind-project.mjs`; this module reads and never writes.
 *
 * The module never throws and never blocks startup: every failure degrades to the
 * warning that the directory is not usable for ticket work.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { trackerLabel } from "./linear/labels.ts";
import { selectTracker } from "./linear/tracker.ts";
import { gitToplevel, readRepoGuardConfig, samePath } from "./repo-guard.ts";
import type { RepoGuardConfig } from "./repo-guard.ts";

export interface WorkspaceNotice {
  level: "info" | "warning";
  message: string;
}

export interface WorkspaceNoticeOptions {
  /** Environment that points at the profile (`PI_CODING_AGENT_DIR`). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Absolute path of `scripts/bind-project.mjs` shown in the hint. Defaults to this checkout. */
  bindScript?: string;
}

/** `scripts/bind-project.mjs` of the checkout this module was loaded from (two levels up). */
export function defaultBindScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let real = here;
  try {
    real = realpathSync(here);
  } catch {
    // Unreadable location: keep the unresolved walk, the hint is still the best known path.
  }
  return resolve(real, "..", "..", "scripts", "bind-project.mjs");
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The project key whose `repos` entry points at `root`, compared the way the guard compares. */
export function boundProjectOf(config: RepoGuardConfig, root: string): string | undefined {
  for (const [key, value] of Object.entries(config.repos)) {
    if (samePath(realOrResolved(value), root)) return key;
  }
  return undefined;
}

/** A path with spaces is quoted, so the hint stays a command the user can paste. */
function shellPath(path: string): string {
  return /\s/u.test(path) ? `"${path}"` : path;
}

/**
 * The notice for a session that starts in `cwd`. Pure apart from reading the profile and
 * asking git for the toplevel; the caller decides whether and where to show it.
 */
export function describeWorkspaceNotice(cwd: string, options: WorkspaceNoticeOptions = {}): WorkspaceNotice {
  const env = options.env ?? process.env;
  const selection = selectTracker(env);
  const label = selection.ok ? trackerLabel(selection.tracker.id) : undefined;
  const tracker = label ? `Tracker: ${label}` : "Tracker: no válido en aies.json";

  const root = gitToplevel(cwd);
  if (!root) {
    return {
      level: "warning",
      message: `${tracker} · AVISO: este directorio no es un repo git. El trabajo de tickets necesita un repo git.`,
    };
  }

  const project = boundProjectOf(readRepoGuardConfig(env), root);
  if (project) {
    return { level: "info", message: `${tracker} · este repo está vinculado a ${project}` };
  }

  const bindScript = shellPath(options.bindScript ?? defaultBindScript());
  const projectOf = label ? `de ${label}` : "del tracker";
  return {
    level: "warning",
    message: `${tracker} · AVISO: este repo no está vinculado a ningún proyecto ${projectOf}. Vincúlalo con: node ${bindScript} <PROJECT_ID> .`,
  };
}
