/**
 * Stale-runtime guard (EZE-492).
 *
 * Pi loads each AIES extension module exactly once, at process start, through
 * its own jiti instance with `moduleCache:false` (docs/ARCHITECTURE.md). The set
 * of loaded modules is therefore frozen for the whole lifetime of the process.
 * Every child agent (Explore, Worker, Verify) is created IN-PROCESS by
 * `executeChildSession`, so a child spawned after the Parent edited an
 * `extensions/*.ts` file still runs the already-imported, stale module code
 * while the working tree already holds the fix.
 *
 * The root cause of EZE-488 was precisely this: a Verify child produced a PASS
 * that proved the old code, not the working tree, because the modules changed on
 * disk after the process started. This module detects that situation and lets
 * the Verify delegation fail fast with relaunch guidance. It deliberately does
 * NOT hot-reload, auto-restart, or invalidate any module cache; detection plus a
 * clear, honest block is the whole design (D31).
 *
 * The module is pure and dependency-light on purpose: `node:fs`, `node:path`,
 * `node:url` only. It never throws: an unreadable directory or file is skipped.
 */

import { dirname, join, relative, resolve } from "node:path";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Runtime-loaded module extensions we care about (TypeScript/JavaScript family). */
const MODULE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Runtime-loaded NON-module resources, as paths relative to each scanned root.
 * `models.json` is read once at startup by `loadCommandCodeCatalog` (a
 * `readFileSync`) before `registerProvider()`, so editing it after the process
 * started leaves the runtime stale exactly like a `.ts` module. This is an
 * explicit allowlist, NOT a generic `.json` match: `README.md` and any other
 * non-runtime file under `extensions/` must stay ignored.
 */
const RUNTIME_RESOURCE_FILES = ["aies-provider-commandcode/models.json"];

/** Defensive cap on the entries read from any single directory during the walk. */
const DIR_ENTRY_LIMIT = 5000;

/**
 * The AIES repository root, derived from this module's own location: the file
 * lives at `<repoRoot>/extensions/aies-agents/runtime-freshness.ts`, so two
 * levels up is the root. `realpathSync` resolves the `$AIES_HOME` symlink that
 * `scripts/bootstrap-profile.sh` points into the profile, so this is the runtime
 * actually loaded regardless of the session cwd (AIES also runs on other repos).
 */
function repoRoot(): string {
  try {
    const here = realpathSync(dirname(fileURLToPath(import.meta.url)));
    return realpathSync(resolve(here, "..", ".."));
  } catch {
    // Unreadable module location: fall back to the unresolved path walk.
    return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  }
}

/** The runtime-loaded roots to scan. Only the AIES `extensions/` tree is loaded. */
function defaultRoots(): string[] {
  return [join(repoRoot(), "extensions")];
}

/**
 * Approximate wall-clock start time of this process in epoch milliseconds:
 * `Date.now()` minus the uptime. A module file whose mtime is later than this
 * baseline was edited after the runtime that must use it had already loaded.
 */
export function processStartedAt(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

export interface RuntimeFreshnessReport {
  /** `false` when at least one runtime-loaded module changed after `startedAt`. */
  fresh: boolean;
  /** The process-start baseline (epoch ms) the mtimes were compared against. */
  startedAt: number;
  /** Absolute roots that were scanned. */
  roots: string[];
  /** Readable, sorted list of the stale module paths. */
  stalePaths: string[];
  /** Count of module files inspected across every root. */
  scannedFiles: number;
}

/**
 * Recursively collect module files under `dir`, skipping dotfiles, `node_modules`
 * and anything that is not a regular module file. Every failure (missing,
 * unreadable, not a directory, a file that disappears mid-walk) is tolerated and
 * simply omitted from the result.
 */
function walkModuleFiles(dir: string, files: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.slice(0, DIR_ENTRY_LIMIT)) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;
    const child = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        walkModuleFiles(child, files);
      } else if (entry.isFile() && MODULE_FILE.test(entry.name)) {
        files.push(child);
      }
    } catch {
      continue;
    }
  }
}

/**
 * Scan the runtime-loaded roots and report every module file whose mtime is
 * strictly later than the baseline. A file is stale only when it was modified
 * after the process started, so a freshly launched process is always clean.
 * Beyond the module files, the explicit `RUNTIME_RESOURCE_FILES` allowlist is
 * scanned too (it is runtime-loaded even though it is not a module). Everything
 * else (docs, tests, scripts, prompts, READMEs) is not runtime-loaded and never
 * counts.
 */
export function checkRuntimeFreshness(options?: {
  startedAt?: number;
  roots?: string[];
}): RuntimeFreshnessReport {
  const startedAt = options?.startedAt ?? processStartedAt();
  const roots = options?.roots ?? defaultRoots();

  const stale = new Set<string>();
  let scannedFiles = 0;

  for (const root of roots) {
    const files: string[] = [];
    walkModuleFiles(root, files);
    for (const rel of RUNTIME_RESOURCE_FILES) {
      const resource = join(root, rel);
      try {
        if (statSync(resource).isFile()) files.push(resource);
      } catch {
        // Missing or unreadable resource: omit it, never throw.
      }
    }
    for (const file of files) {
      scannedFiles += 1;
      let mtimeMs;
      try {
        mtimeMs = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs > startedAt) stale.add(file);
    }
  }

  const stalePaths = [...stale].sort();
  return {
    fresh: stalePaths.length === 0,
    startedAt,
    roots,
    stalePaths,
    scannedFiles,
  };
}

/** How many stale paths to name before collapsing the rest into "y N más". */
const MAX_LISTED_PATHS = 5;

/** Render the stale paths relative to the first root when possible, else absolute. */
function listedStalePaths(report: RuntimeFreshnessReport): string {
  const base = report.roots[0];
  const shown = report.stalePaths.slice(0, MAX_LISTED_PATHS);
  const lines = shown.map((path) => {
    let readable = path;
    try {
      if (base) {
        const rel = relative(base, path);
        if (rel && !rel.startsWith("..")) readable = join("extensions", rel);
      }
    } catch {
      readable = path;
    }
    return `    - ${readable}`;
  });
  const rest = report.stalePaths.length - shown.length;
  if (rest > 0) lines.push(`    - y ${rest} más`);
  return lines.join("\n");
}

/**
 * The user-facing message, in Spanish (D18), fail-fast tone consistent with
 * repo-guard.ts. It states the fact (startup-loaded modules changed on disk after
 * this process started, capped list), why the same-process Verify is invalid
 * (children run in-process and reuse the already-loaded modules, so a PASS would
 * prove the old code rather than the working tree), the relaunch instruction
 * (exit AIES, run `aies`, delegate the verification again), and a note that
 * subprocess checks like `npm test` are unaffected.
 */
export function formatStaleRuntimeMessage(report: RuntimeFreshnessReport): string {
  const list = listedStalePaths(report);
  return [
    "Bloqueado: runtime obsoleto (stale). Estos módulos, que se cargan solo al inicio del proceso, cambiaron en el disco DESPUÉS de que este proceso se hubiera iniciado:",
    list,
    "No se delegó ningún agente Verify. Los hijos se ejecutan DENTRO DE ESTE PROCESO y reutilizan los módulos ya cargados: un PASS aquí probaría el código VIEJO, no el árbol de trabajo actual. Por eso la verificación en el mismo proceso queda bloqueada y no es válida.",
    "Reinicio para verificar: salí de AIES y relanzalo (`aies`); después, en el proceso nuevo, volvé a delegar la verificación para que cargue los módulos actualizados.",
    "Los checks que corren en subprocesos nuevos (p. ej. `npm test`) NO están afectados y siguen siendo válidos.",
  ].join("\n\n");
}
