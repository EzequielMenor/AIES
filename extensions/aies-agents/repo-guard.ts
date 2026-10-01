/**
 * Cross-repository ticket guard (EZE-489).
 *
 * The ticket contract has no repository field by design (D14), so the only
 * reliable signal available offline is the Linear project name of the active
 * ticket compared against the git identity of the Parent session cwd. When they
 * disagree, the session is working the wrong repository: the Parent must not
 * delegate implementing roles, must not mutate files, and must not start the
 * work unit here.
 *
 * The module is pure and dependency-light on purpose: `node:fs`,
 * `node:child_process`, `node:path` plus the existing command policy. It never
 * throws, never blocks a ticket without a project, and never resolves a decision
 * from a path it could not read.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { checkCommandPolicy, splitCommandSegments } from "./command-guard.ts";

/** Lowercase, without spaces or separators: "Mi-Porfolio" -> "miporfolio". */
export function normalizeRepoName(value: string): string {
  return value.toLowerCase().replace(/[\s\-_.]/g, "");
}

export interface RepoIdentity {
  /** Realpath of the git toplevel, or of the cwd when git cannot resolve it. */
  root: string;
  /** Basename of `root`, kept verbatim so messages stay readable. */
  name: string;
}

const identityCache = new Map<string, RepoIdentity>();

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** `git rev-parse --show-toplevel` without a shell, realpaths when it can. */
function gitToplevel(cwd: string): string | undefined {
  try {
    const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      timeout: 5000,
    });
    if (result.status !== 0) return undefined;
    const toplevel = (result.stdout ?? "").trim();
    if (!toplevel) return undefined;
    return safeRealpath(toplevel) ?? toplevel;
  } catch {
    return undefined;
  }
}

/**
 * The effective workspace root of a cwd: its git toplevel when resolvable, the
 * realpath of the cwd otherwise. Tolerant of every failure, including a cwd that
 * no longer exists.
 */
export function resolveWorkspaceRoot(cwd: string): string {
  const toplevel = gitToplevel(cwd);
  if (toplevel) return toplevel;
  return safeRealpath(cwd) ?? resolve(cwd);
}

/** Repo identity of a cwd, cached per cwd because the hook sees every tool call. */
export function resolveRepoIdentity(cwd: string): RepoIdentity {
  const cached = identityCache.get(cwd);
  if (cached) return cached;
  const root = resolveWorkspaceRoot(cwd);
  const identity: RepoIdentity = { root, name: basename(root) };
  identityCache.set(cwd, identity);
  return identity;
}

/** Drop the per-cwd identity cache (used by tests and by profile switches). */
export function resetRepoGuardCache(): void {
  identityCache.clear();
}

export interface RepoBinding {
  /** Ticket identifier, carried through so the message can name the ticket. */
  identifier: string;
  /** The Linear project name, when the contract has one. */
  project?: string | null;
}

export interface RepoGuardConfig {
  /** Optional exact `project -> absolute repo root` bindings. */
  repos: Record<string, string>;
}

/**
 * Read the optional `repos` table from `$PI_CODING_AGENT_DIR/aies.json`. The
 * profile is not guaranteed to exist or to be valid JSON, so every failure is an
 * empty table: the guard then falls back to name comparison.
 */
export function readRepoGuardConfig(env?: NodeJS.ProcessEnv): RepoGuardConfig {
  const source = env ?? process.env;
  const agentDir = source.PI_CODING_AGENT_DIR;
  if (!agentDir) return { repos: {} };

  const configPath = join(agentDir, "aies.json");
  try {
    if (!existsSync(configPath)) return { repos: {} };
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return { repos: {} };
    const repos = (parsed as { repos?: unknown }).repos;
    if (!repos || typeof repos !== "object") return { repos: {} };

    const table: Record<string, string> = {};
    for (const [key, value] of Object.entries(repos as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) table[key] = value.trim();
    }
    return { repos: table };
  } catch {
    return { repos: {} };
  }
}

/**
 * Case-insensitive on macOS, where the filesystem is case-insensitive and git
 * paths differ in case between processes.
 */
function samePath(a: string, b: string): boolean {
  return process.platform === "darwin" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Binding lookup on the raw project name, then on its normalized form. */
function findBinding(repos: Record<string, string>, project: string): string | undefined {
  const direct = repos[project];
  if (direct) return direct;
  const normalized = normalizeRepoName(project);
  for (const [key, value] of Object.entries(repos)) {
    if (normalizeRepoName(key) === normalized) return value;
  }
  return undefined;
}

/** Defensive cap on the entries read from any single directory during the lookup. */
const REPO_SEARCH_ENTRY_LIMIT = 500;

/**
 * The child directories of `dir`, following symlinks that point at directories and
 * ignoring everything else: non-directories, dotfiles, `node_modules` and `.git`.
 * Any failure (missing, unreadable, not a directory) yields an empty list, so a cwd
 * that no longer exists simply has nothing to search.
 */
function listChildDirs(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries.slice(0, REPO_SEARCH_ENTRY_LIMIT)) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules") continue;
      const child = join(dir, entry.name);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      dirs.push(child);
      if (dirs.length >= REPO_SEARCH_ENTRY_LIMIT) break;
    }
    return dirs;
  } catch {
    return [];
  }
}

/** A candidate directory: matching normalized basename, a real directory holding `.git`. */
function matchCandidateDir(candidate: string, normalizedExpected: string): string | undefined {
  if (normalizeRepoName(basename(candidate)) !== normalizedExpected) return undefined;
  const real = safeRealpath(candidate);
  if (!real) return undefined;
  try {
    if (!statSync(real).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return existsSync(join(real, ".git")) ? real : undefined;
}

function collectCandidates(dirs: string[], normalizedExpected: string): Set<string> {
  const found = new Set<string>();
  for (const dir of dirs) {
    const match = matchCandidateDir(dir, normalizedExpected);
    if (match) found.add(match);
  }
  return found;
}

/**
 * Message-only enrichment: resolve the expected repository root with a search
 * bounded to two levels under the parent of the actual root. Level 1 is the set of
 * direct children of `dirname(actualRoot)`; level 2 looks at the children of those
 * children. Candidates from both levels are collected together and deduplicated by
 * realpath.
 *
 * A candidate is a directory whose normalized basename equals
 * `normalizeRepoName(expectedName)` and that contains `.git`. Resolution requires
 * uniqueness across the union of all levels: zero candidates or more than one
 * leaves the root unresolved, so an ambiguous filesystem (even across different
 * levels) can never produce a fabricated path. Repeated realpaths (the same
 * repository reached through two symlinks) count as one candidate. The result
 * is a realpath.
 *
 * This only enriches the block message: it never changes an `ok`, `mismatch` or
 * `unknown` status, and it never throws.
 */
export function findExpectedRepoRoot(actualRoot: string, expectedName: string): string | undefined {
  const normalized = normalizeRepoName(expectedName);
  if (!normalized) return undefined;
  try {
    const levelOne = listChildDirs(dirname(actualRoot));
    const candidates = collectCandidates(levelOne, normalized);

    const levelTwo: string[] = [];
    for (const dir of levelOne) {
      levelTwo.push(...listChildDirs(dir));
      if (levelTwo.length >= REPO_SEARCH_ENTRY_LIMIT) break;
    }
    for (const c of collectCandidates(levelTwo, normalized)) candidates.add(c);

    return candidates.size === 1 ? [...candidates][0] : undefined;
  } catch {
    return undefined;
  }
}

export type RepoGuardStatus = "ok" | "unknown" | "mismatch";

export interface RepoGuardDecision {
  status: RepoGuardStatus;
  /** Ticket identifier, so the block message can name the ticket. */
  identifier?: string;
  /** Expected repo, from the ticket project name. */
  expectedRepo?: string;
  /** Expected repo root, when a binding or the bounded two-level lookup resolved it. */
  expectedRoot?: string;
  /** Real root of the current session. */
  actualRoot: string;
  /** Basename of `actualRoot`. */
  actualRepo: string;
  reason?: string;
}

/**
 * Compare the ticket's expected repository with the repository this session runs
 * in. A ticket without a project is "unknown" and never blocks, so project-less
 * tickets keep working exactly as before.
 */
export function checkTicketRepo(
  binding: RepoBinding,
  cwd: string,
  options?: { config?: RepoGuardConfig; env?: NodeJS.ProcessEnv },
): RepoGuardDecision {
  const identity = resolveRepoIdentity(cwd);
  const base = { identifier: binding.identifier, actualRoot: identity.root, actualRepo: identity.name };

  const project = typeof binding.project === "string" ? binding.project.trim() : "";
  if (!project) {
    return { status: "unknown", ...base, reason: "the ticket contract declares no Linear project" };
  }

  const config = options?.config ?? readRepoGuardConfig(options?.env);
  const bound = findBinding(config.repos, project);
  if (bound) {
    const expectedRoot = safeRealpath(bound) ?? resolve(bound);
    const status: RepoGuardStatus = samePath(expectedRoot, identity.root) ? "ok" : "mismatch";
    return {
      status,
      ...base,
      expectedRepo: project,
      expectedRoot,
      reason:
        status === "ok"
          ? `the bound repository root matches this session: ${expectedRoot}`
          : `the bound repository root ${expectedRoot} is not this session root ${identity.root}`,
    };
  }

  if (normalizeRepoName(project) === normalizeRepoName(identity.name)) {
    return {
      status: "ok",
      ...base,
      expectedRepo: project,
      expectedRoot: identity.root,
      reason: `the ticket project "${project}" matches this session repository`,
    };
  }

  return {
    status: "mismatch",
    ...base,
    expectedRepo: project,
    expectedRoot: findExpectedRepoRoot(identity.root, project),
    reason: `the ticket belongs to project "${project}", but this session runs in repository "${identity.name}"`,
  };
}

/** Flags that make `git branch` an inspection, never a mutation. */
const GIT_BRANCH_READ_ONLY_FLAGS = [
  "-l",
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "--verbose",
  "-m",
  "--merged",
  "--no-merged",
  "-c",
  "--contains",
  "--format",
  "--show-current",
];

/**
 * Local rule the shared policy does not carry: `git branch <name>` creates a
 * branch, which is a workspace mutation, while a bare `git branch` or one with
 * read-only flags only inspects.
 */
function isMutatingGitBranch(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    const tokens = segment.split(/\s+/u).filter(Boolean);
    if (tokens.length === 0 || tokens[0] !== "git") continue;
    const branchIndex = tokens.findIndex((token) => token === "branch");
    if (branchIndex === -1) continue;

    for (const token of tokens.slice(branchIndex + 1)) {
      if (!token.startsWith("-")) return true;
      if (!GIT_BRANCH_READ_ONLY_FLAGS.includes(token)) return true;
    }
  }
  return false;
}

/**
 * The user-facing reason, in Spanish (D18), with paths, commands, repo names and
 * identifiers verbatim.
 */
function buildBlockReason(decision: RepoGuardDecision): string {
  const id = decision.identifier && decision.identifier.trim() ? decision.identifier.trim() : "";
  const expected = decision.expectedRepo && decision.expectedRepo.trim() ? decision.expectedRepo.trim() : "otro repo";
  const ticket = id ? `el ticket ${id}` : "el ticket activo";
  const loadHint = id ? `aies_ticket load ${id}` : "aies_ticket load <ID>";

  const first = `Bloqueado: ${ticket} pertenece al repo «${expected}», pero esta sesión corre en «${decision.actualRepo}» (${decision.actualRoot}).`;
  const second = "No se delegó ningún Worker y no se modificó ningún archivo.";
  const third = decision.expectedRoot
    ? `Relanzá la sesión desde el workspace correcto: cd ${decision.expectedRoot} && aies   (luego: ${loadHint})`
    : `Si no se pudo resolver el path: agregá un binding en $PI_CODING_AGENT_DIR/aies.json con {"repos":{"${expected}":"/ruta/absoluta"}} o abrí una sesión nueva en el workspace del repo «${expected}».`;
  const fourth = "Override explícito, solo si el ticket realmente pertenece a este repo: AIES_ALLOW_REPO_MISMATCH=1";

  return [first, second, third, fourth].join("\n");
}

/**
 * Decide whether a tool call must be blocked under a mismatch, and with which
 * message. Returns `null` when the tool is allowed: a non-mismatch decision, an
 * unlisted tool, a read-only Explore delegation, a read-only ticket operation, or
 * a read-only shell command.
 *
 * The blocked surface is the mutation surface: `aies_delegate` with role `worker`
 * or `verify`, `aies_ticket` with action `start`, `edit`, `write`, and `bash`
 * commands the verify policy (plus the `git branch <name>` rule) does not allow.
 * Explore stays allowed because reading the other repository is exactly the
 * diagnosis a mismatch needs.
 */
export function repoGuardBlockReason(
  toolName: string,
  input: Record<string, unknown> | undefined,
  decision: RepoGuardDecision,
  workspaceRoot: string,
): string | null {
  if (decision.status !== "mismatch") return null;

  if (toolName === "aies_delegate") {
    const role = typeof input?.role === "string" ? input.role : "";
    if (role !== "worker" && role !== "verify") return null;
    return buildBlockReason(decision);
  }

  if (toolName === "aies_ticket") {
    const action = typeof input?.action === "string" ? input.action : "";
    if (action !== "start") return null;
    return buildBlockReason(decision);
  }

  if (toolName === "edit" || toolName === "write") {
    return buildBlockReason(decision);
  }

  if (toolName === "bash") {
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    if (!command) return null;
    const policy = checkCommandPolicy(command, workspaceRoot, "verify");
    if (!policy.allowed) return buildBlockReason(decision);
    if (isMutatingGitBranch(command)) return buildBlockReason(decision);
    return null;
  }

  return null;
}
