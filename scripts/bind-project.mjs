#!/usr/bin/env node
/**
 * D40: explicit binding between a git repository and a tracker project.
 *
 *   node scripts/bind-project.mjs <PROJECT_IDENTIFIER> [repoPath=cwd] [options]
 *   node scripts/bind-project.mjs --list [options]
 *   node scripts/bind-project.mjs --unbind <PROJECT_IDENTIFIER> [options]
 *
 * It writes only the `repos` table (and, with `--tracker plane`, the `tracker` key) of
 * `<profile>/agent/aies.json`. The profile is resolved as bin/aies resolves it. The
 * script never reads auth.json or any MCP file, never copies credentials, and never
 * writes outside that one JSON file. Each write first copies the file to
 * `aies.json.bak-<timestamp>` and then replaces it atomically (temp file + rename).
 *
 * Exit codes: 0 done or nothing to change, 1 refused, 2 usage error.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROGRAM = "bind-project";
const PROJECT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/u;
const TRACKERS = ["plane"];
const DEFAULT_MODE = 0o644;

const USAGE = `usage: node scripts/bind-project.mjs <PROJECT_IDENTIFIER> [repoPath] [options]
       node scripts/bind-project.mjs --list [options]
       node scripts/bind-project.mjs --unbind <PROJECT_IDENTIFIER> [options]

Binds a git repository to a tracker project in the AIES profile. repoPath defaults
to the current directory and must be inside a git work tree.

options:
  --aies-home <dir>   profile directory (default: $AIES_HOME, else ~/.local/share/aies)
  --aies-ephemeral    accept a temporary $AIES_HOME in an interactive shell (as bin/aies)
  --tracker plane     set tracker=plane when aies.json has no tracker, or already plane
  --force             replace a conflicting binding, or change an existing tracker
  --list              print the tracker and the repository bindings
  --unbind <ID>       remove the binding of a project
  -h, --help          print this help`;

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const refusal = (message) => new CliError(message, 1);
const usageError = (message) => new CliError(message, 2);

/** Same flags and positional rules as bin/aies; `--flag=value` is accepted too. */
function parseArgs(argv) {
  const options = {
    help: false,
    list: false,
    force: false,
    ephemeral: false,
    home: undefined,
    tracker: undefined,
    unbind: undefined,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (i >= argv.length) throw usageError(`${flag} requires a value`);
      return argv[i];
    };
    const flagOnly = () => {
      if (inline !== undefined) throw usageError(`${flag} takes no value`);
    };

    switch (flag) {
      case "-h":
      case "--help":
        flagOnly();
        options.help = true;
        break;
      case "--list":
        flagOnly();
        options.list = true;
        break;
      case "--force":
        flagOnly();
        options.force = true;
        break;
      case "--aies-ephemeral":
        flagOnly();
        options.ephemeral = true;
        break;
      case "--aies-home":
        options.home = value();
        break;
      case "--tracker":
        options.tracker = value();
        break;
      case "--unbind":
        options.unbind = value();
        break;
      default:
        if (flag.startsWith("-")) throw usageError(`unknown option: ${flag}`);
        positional.push(arg);
    }
  }

  return { options, positional };
}

function validateRequest({ options, positional }) {
  if (options.tracker !== undefined && !TRACKERS.includes(options.tracker)) {
    throw usageError(`--tracker accepts only ${TRACKERS.join(", ")}; linear is the default when aies.json has no tracker`);
  }
  if (options.list && options.unbind !== undefined) throw usageError("--list and --unbind cannot be combined");
  if (options.list || options.unbind !== undefined) {
    if (positional.length > 0) throw usageError("--list and --unbind take no repository or project argument");
    if (options.tracker !== undefined) throw usageError("--tracker only applies when binding a project");
    if (options.force && options.list) throw usageError("--force does not apply to --list");
    if (options.unbind !== undefined) assertIdentifier(options.unbind);
    return { mode: options.list ? "list" : "unbind" };
  }
  if (positional.length === 0) throw usageError("a PROJECT_IDENTIFIER is required");
  if (positional.length > 2) throw usageError("too many arguments");
  assertIdentifier(positional[0]);
  return { mode: "bind", project: positional[0].toUpperCase(), repoPath: positional[1] ?? "." };
}

function assertIdentifier(value) {
  if (!PROJECT_IDENTIFIER.test(value)) {
    throw usageError(`invalid project identifier "${value}": expected letters, digits and underscores, starting with a letter`);
  }
}

function expandHome(path, env) {
  if (!path.startsWith("~/")) return path;
  return join(env.HOME ?? homedir(), path.slice(2));
}

/** Temporary locations that bin/aies refuses for an inherited AIES_HOME in an interactive shell. */
function isTemporaryHome(home, env) {
  const tmp = (env.TMPDIR || "/tmp").replace(/\/+$/u, "");
  return ["/tmp/", "/private/tmp/", "/var/folders/"].some((prefix) => home.startsWith(prefix)) || home.startsWith(`${tmp}/`);
}

/** Profile precedence of bin/aies: --aies-home, then inherited AIES_HOME, then the canonical home. */
function resolveAiesHome(options, env) {
  const canonical = join(env.HOME ?? homedir(), ".local", "share", "aies");
  if (options.home !== undefined) return resolve(expandHome(options.home, env));
  if (env.AIES_HOME) {
    const inherited = resolve(expandHome(env.AIES_HOME, env));
    const interactive = process.stdin.isTTY === true;
    if (isTemporaryHome(inherited, env) && !options.ephemeral && env.AIES_EPHEMERAL !== "1" && interactive) {
      process.stderr.write(`${PROGRAM}: ignoring inherited temporary AIES_HOME (${inherited}); using canonical profile (${canonical})\n`);
      process.stderr.write(`${PROGRAM}: pass --aies-ephemeral or --aies-home to intentionally use a temporary profile\n`);
      return canonical;
    }
    return inherited;
  }
  return canonical;
}

function resolveProfile(options, env) {
  const home = resolveAiesHome(options, env);
  const agentDir = join(home, "agent");
  const stat = statSync(agentDir, { throwIfNoEntry: false });
  if (!stat || !stat.isDirectory()) {
    throw refusal(`no existe el perfil de AIES en ${agentDir}. Ejecuta \`aies\` una vez para crearlo y vuelve a lanzar este comando.`);
  }
  return { home, agentDir, configPath: join(agentDir, "aies.json") };
}

/** Git toplevel of `repoPath`, realpathed. Refuses anything that is not inside a work tree. */
function resolveRepoRoot(repoPath) {
  const path = resolve(repoPath);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) throw refusal(`no existe la ruta ${path}`);
  if (!stat.isDirectory()) throw refusal(`${path} no es un directorio`);

  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: path, encoding: "utf8", timeout: 5000 });
  const toplevel = (result.stdout ?? "").trim();
  if (result.status !== 0 || !toplevel) {
    throw refusal(`${path} no está dentro de un repo git. Solo se pueden vincular repos git con un work tree.`);
  }
  return realpathSync(toplevel);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reads aies.json without ever creating it. Refuses anything it cannot round-trip safely. */
function loadConfig(configPath) {
  let stat;
  try {
    stat = lstatSync(configPath);
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, config: {}, mode: undefined };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw refusal(`${configPath} no es un fichero regular; no se ha modificado nada`);
  }

  let config;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw refusal(`${configPath} no es JSON válido; no se ha modificado nada`);
  }
  if (!isPlainObject(config)) throw refusal(`${configPath} no contiene un objeto JSON; no se ha modificado nada`);
  if (config.repos !== undefined && !isPlainObject(config.repos)) {
    throw refusal(`el campo "repos" de ${configPath} no es un objeto; no se ha modificado nada`);
  }
  return { exists: true, config, mode: stat.mode & 0o777 };
}

/** Same comparison as the guard: case-insensitive on macOS, where the filesystem is. */
function samePath(a, b) {
  return process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function realOrResolved(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function pointsTo(value, root) {
  return typeof value === "string" && samePath(realOrResolved(value), root);
}

/**
 * The new `repos` table for `project -> root`. Conflicts (the path bound to another
 * project, or the project bound to another path) are refused unless `force` is set,
 * and a forced replacement names what it removed.
 */
function planBinding(repos, project, root, force) {
  const sameProject = Object.keys(repos).filter((key) => key.toUpperCase() === project);
  const projectElsewhere = sameProject.filter((key) => !pointsTo(repos[key], root));
  const pathOwners = Object.keys(repos).filter((key) => key.toUpperCase() !== project && pointsTo(repos[key], root));

  const exact = sameProject.length === 1 && sameProject[0] === project && pointsTo(repos[project], root);
  if (exact && pathOwners.length === 0) return { changed: false, repos, replaced: [] };

  const replaced = [
    ...pathOwners.map((key) => `${key} (${repos[key]})`),
    ...projectElsewhere.map((key) => `${key} (${repos[key]})`),
  ];
  if (replaced.length > 0 && !force) {
    const lines = [
      ...pathOwners.map((key) => `la ruta ${root} ya está vinculada a ${key}`),
      ...projectElsewhere.map((key) => `${key} ya está vinculado a ${repos[key]}`),
    ];
    throw refusal(`${lines.join("; ")}. Usa --force para sustituir el vínculo existente.`);
  }

  const next = { ...repos };
  for (const key of [...pathOwners, ...sameProject]) delete next[key];
  next[project] = root;
  return { changed: true, repos: next, replaced };
}

/** The `tracker` value after binding. Absent or null is linear, so plane is set; any other value needs --force. */
function planTracker(config, requested, force) {
  if (requested === undefined) return { changed: false, value: config.tracker };
  const current = config.tracker;
  if (current === requested) return { changed: false, value: current };
  if (current !== undefined && current !== null && !force) {
    throw refusal(`aies.json declara tracker ${JSON.stringify(current)}; no se cambia a "${requested}" sin --force`);
  }
  return { changed: true, value: requested };
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/gu, "-");
}

/**
 * Atomic replace of aies.json: a backup first when the file exists, then a temp file in the
 * same directory with the original mode, then rename. Returns the backup path or undefined.
 */
function writeConfig(state, next) {
  let backup;
  if (state.exists) {
    backup = `${state.configPath}.bak-${timestamp()}`;
    copyFileSync(state.configPath, backup, constants.COPYFILE_EXCL);
  }

  const temp = join(dirname(state.configPath), `.aies.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: state.mode ?? DEFAULT_MODE });
    chmodSync(temp, state.mode ?? DEFAULT_MODE);
    renameSync(temp, state.configPath);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return backup;
}

function describeTracker(config) {
  return config.tracker === undefined || config.tracker === null ? "linear" : String(config.tracker);
}

function runList(state) {
  const lines = [`tracker=${describeTracker(state.config)}`];
  for (const [key, value] of Object.entries(state.config.repos ?? {})) {
    lines.push(`${key}=${value}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

function runUnbind(state, project) {
  const repos = state.config.repos ?? {};
  const keys = Object.keys(repos).filter((key) => key.toUpperCase() === project);
  if (keys.length === 0) throw refusal(`${project} no tiene vínculo en ${state.configPath}; no se ha modificado nada`);

  const removed = repos[keys[0]];
  const nextRepos = { ...repos };
  for (const key of keys) delete nextRepos[key];
  const next = { ...state.config, repos: nextRepos };
  const backup = writeConfig(state, next);

  process.stdout.write(`Desvinculado ${project} (era ${removed})\n`);
  if (backup) process.stdout.write(`Copia de seguridad: ${backup}\n`);
  return 0;
}

function runBind(state, { project, root }, options) {
  const repos = state.config.repos ?? {};
  const binding = planBinding(repos, project, root, options.force);
  const tracker = planTracker(state.config, options.tracker, options.force);

  if (!binding.changed && !tracker.changed) {
    process.stdout.write(`${project} ya estaba vinculado a ${root}. Nada que cambiar.\n`);
    return 0;
  }

  const next = { ...state.config, repos: binding.repos };
  if (tracker.changed) next.tracker = tracker.value;
  const backup = writeConfig(state, next);

  process.stdout.write(`Vinculado ${project} → ${root}\n`);
  for (const old of binding.replaced) process.stdout.write(`  sustituido: ${old}\n`);
  if (tracker.changed) process.stdout.write(`  tracker: ${tracker.value}\n`);
  if (backup) process.stdout.write(`  copia de seguridad: ${backup}\n`);
  else process.stdout.write(`  aies.json creado en ${state.configPath}\n`);
  return 0;
}

function main(argv, env) {
  const parsed = parseArgs(argv);
  if (parsed.options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const request = validateRequest(parsed);

  // Bind resolves the repository first, so a bad path is reported before any profile work.
  const repoRoot = request.mode === "bind" ? resolveRepoRoot(request.repoPath) : undefined;
  const profile = resolveProfile(parsed.options, env);
  const loaded = loadConfig(profile.configPath);
  const state = { ...profile, ...loaded };

  if (request.mode === "list") return runList(state);
  if (request.mode === "unbind") return runUnbind(state, parsed.options.unbind.toUpperCase());
  return runBind(state, { project: request.project, root: repoRoot }, parsed.options);
}

try {
  process.exitCode = main(process.argv.slice(2), process.env);
} catch (error) {
  // Refusals and usage errors carry their exit code; a filesystem failure is reported plainly.
  const code = error instanceof CliError ? error.code : 1;
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${PROGRAM}: ${message}\n`);
  process.exitCode = code;
}
