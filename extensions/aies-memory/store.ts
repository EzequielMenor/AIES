/**
 * AIES memory store adapter (D42, phase 1). Pure Node: no Pi import, so tests drive it directly.
 *
 * ProjectMem (a Python CLI, pinned) is the storage engine. This module is the only code that
 * touches it, and it does so under rules that do not depend on the model:
 *
 * - One store per project key at `$AIES_HOME/memory/<key>/.projectmem/`, outside every repository.
 *   The key is validated, the directory is resolved with `path.resolve`, and its real path must
 *   stay inside the real `$AIES_HOME/memory`. A symlinked store, or any escape, is refused.
 * - The binary is always `$AIES_HOME/memory/_venv/bin/pjm`, started without a shell, and the
 *   installed version must equal `PROJECTMEM_VERSION`. The global pjm is never used.
 * - Only the operations of `argvFor` exist. Each maps to a fixed argv; user text is always the
 *   last argument, after a `--`, so it can never be read as an option. Other ProjectMem commands
 *   (briefing, precheck, doctor, hooks, watch, dashboard, export, backfill, project registration,
 *   global memory) are never built here, and `exec` refuses any command outside the allowlist.
 * - The environment is an allowlist. `PROJECTMEM_HOME` and `HOME` point at `$AIES_HOME/memory/_home`,
 *   so the registry and global memory of ProjectMem are private to AIES and nothing is written to
 *   the user's real `~/.projectmem`. `PROJECTMEM_NO_REDACT` is never passed.
 * - Every call has a timeout and an output cap. A failure becomes a typed error, never an
 *   exception that reaches the turn, and three consecutive infrastructure failures open a circuit
 *   for the rest of the session.
 *
 * Git-history staleness (the ProjectMem briefing and precheck features) is deliberately NOT used.
 * Verified fact: with the store outside a repository those features run `git log` in the store
 * directory, which is not a repository, so they cannot work. V1 neither calls them nor relies on
 * staleness; a superseded decision is retired explicitly.
 */

import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { checkFocusPath, checkQueryText, checkWriteText, isValidEventId, isValidProjectKey } from "./guards.ts";

/** The only ProjectMem version AIES runs. A bump is a deliberate edit here and in the bootstrap script. */
export const PROJECTMEM_VERSION = "0.3.4";

export interface MemoryLimits {
  /** Wall clock for one process. Init gets three times this. */
  timeoutMs: number;
  /** Bytes read from stdout before the process is killed. */
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Events per store; past it writes are refused. */
  maxEvents: number;
  /** Writes per store object, which the extension recreates every session. */
  maxSessionWrites: number;
  /** An exact repeat of one of the last N summaries is dropped. */
  dedupWindow: number;
  /** Search lines returned. */
  maxResults: number;
  /** Characters of any text handed back to the caller. */
  maxResultChars: number;
  /** Bytes of events.jsonl read for list, counts and duplicate checks (the tail of a larger file). */
  maxEventsFileBytes: number;
  /** Consecutive infrastructure failures that open the circuit. */
  breakerThreshold: number;
}

export const DEFAULT_LIMITS: Readonly<MemoryLimits> = Object.freeze({
  timeoutMs: 3000,
  maxStdoutBytes: 16 * 1024,
  maxStderrBytes: 4 * 1024,
  maxEvents: 2000,
  maxSessionWrites: 30,
  dedupWindow: 50,
  maxResults: 10,
  maxResultChars: 6000,
  maxEventsFileBytes: 4 * 1024 * 1024,
  breakerThreshold: 3,
});

/** Token budget bounds for the briefing. */
export const MIN_CONTEXT_TOKENS = 100;
export const MAX_CONTEXT_TOKENS = 1500;
export const DEFAULT_CONTEXT_TOKENS = 800;

export type MemoryErrorCode =
  | "invalid_key"
  | "store_unsafe"
  | "pjm_missing"
  | "pjm_version"
  | "timeout"
  | "output_overflow"
  | "spawn_failed"
  | "command_failed"
  | "command_rejected"
  | "invalid_input"
  | "store_full"
  | "session_write_cap"
  | "duplicate"
  | "unknown_event"
  | "circuit_open";

/**
 * Failures of the machinery, which count toward the circuit. Rejected input, caps and clean
 * refusals by ProjectMem (`command_rejected`) neither count nor reset the streak.
 */
const INFRASTRUCTURE_CODES: ReadonlySet<MemoryErrorCode> = new Set([
  "pjm_missing",
  "pjm_version",
  "timeout",
  "output_overflow",
  "spawn_failed",
  "command_failed",
]);

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  /** Sanitised first line of the tool output, kept for the one fallback that reads it. */
  readonly detail: string;
  constructor(code: MemoryErrorCode, message: string, detail = "") {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.detail = detail;
  }
}

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: { code: MemoryErrorCode; message: string } };

// ---------------------------------------------------------------------------------------------
// Runner: the only place a process is started.
// ---------------------------------------------------------------------------------------------

export interface RunRequest {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  overflow: boolean;
  /** `error.code` of a spawn that never started (ENOENT, EACCES...). */
  spawnError?: string;
}

export type Runner = (request: RunRequest) => Promise<RunResult>;

/** Spawn without a shell, with a timeout and capped output. Never rejects. */
export const spawnRunner: Runner = (request) =>
  new Promise<RunResult>((resolveRun) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        overflow,
        ...(spawnError ? { spawnError } : {}),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.file, request.args, {
        cwd: request.cwd,
        env: request.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish(null, errorCode(error));
      return;
    }

    child.on("error", (error) => finish(null, errorCode(error)));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > request.maxStdoutBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes >= request.maxStderrBytes) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });
    child.on("close", (code) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, request.timeoutMs);
  });

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

// ---------------------------------------------------------------------------------------------
// Operations: a closed set, each with a fixed argv.
// ---------------------------------------------------------------------------------------------

export type AttemptOutcome = "failed" | "worked" | "partial";

export type Operation =
  | { op: "init" }
  | { op: "decision"; text: string; supersedes?: string }
  | { op: "log"; text: string }
  | { op: "attempt"; outcome: AttemptOutcome; text: string }
  | { op: "fix"; text: string }
  | { op: "note"; text: string }
  | { op: "search"; query: string }
  | { op: "context"; tokens: number; focus?: string };

/** Every ProjectMem command this module may start. `exec` refuses anything else. */
export const ALLOWED_COMMANDS: readonly string[] = ["init", "decision", "log", "attempt", "fix", "note", "search", "context"];

const INIT_FLAGS = [
  "--no-hooks",
  "--no-watch",
  "--no-backfill",
  "--no-global",
  "--no-claude-md",
  "--no-stack-detect",
  "--no-structure",
  "--no-mcp-config",
];

/**
 * The argv of an operation. User text is last, after `--`, and every other token is a constant or a
 * value validated by the caller. Search is the plain substring mode: the regex flag does not exist here.
 */
export function argvFor(operation: Operation): string[] {
  switch (operation.op) {
    case "init":
      return ["init", ...INIT_FLAGS];
    case "decision":
      return [
        "decision",
        ...(operation.supersedes ? ["--supersedes", assertEventId(operation.supersedes)] : []),
        "--",
        operation.text,
      ];
    case "log":
      return ["log", "--", operation.text];
    case "attempt":
      return ["attempt", `--${operation.outcome}`, "--auto-issue", "--", operation.text];
    case "fix":
      return ["fix", "--", operation.text];
    case "note":
      return ["note", "--", operation.text];
    case "search":
      return ["search", "--", operation.query];
    case "context": {
      const tokens = Math.trunc(operation.tokens);
      if (!(tokens >= MIN_CONTEXT_TOKENS && tokens <= MAX_CONTEXT_TOKENS)) {
        throw new MemoryError("invalid_input", `token budget must be between ${MIN_CONTEXT_TOKENS} and ${MAX_CONTEXT_TOKENS}`);
      }
      const focus = operation.focus === undefined ? undefined : checkFocusPath(operation.focus);
      if (operation.focus !== undefined && focus === undefined) {
        throw new MemoryError("invalid_input", "focus must be a relative path without '..'");
      }
      return ["context", "--tokens", String(tokens), ...(focus ? ["--focus", focus] : [])];
    }
  }
}

function assertEventId(id: string): string {
  if (!isValidEventId(id)) throw new MemoryError("invalid_input", "event id must look like evt_<hex>");
  return id;
}

/** The environment of every process this module starts: an allowlist, never a copy of the caller's. */
export function buildEnv(memoryHome: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {
    PATH: source.PATH && source.PATH.length > 0 ? source.PATH : "/usr/bin:/bin",
    HOME: memoryHome,
    PROJECTMEM_HOME: memoryHome,
    PYTHONUTF8: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONDONTWRITEBYTECODE: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const name of ["LANG", "LC_ALL", "TMPDIR"] as const) {
    const value = source[name];
    if (value) env[name] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------------------------
// Output handling
// ---------------------------------------------------------------------------------------------

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/gu;
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/** Remove terminal escapes and control characters; keep newlines. */
export function cleanOutput(text: string): string {
  return text.replace(ANSI, "").replace(/\r/gu, "").replace(CONTROL_EXCEPT_NEWLINE, "");
}

function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** One-line refusals ProjectMem 0.3.4 prints on exit 1 for a request it understood but cannot honour. */
const KNOWN_REFUSAL =
  /^(?:error:?\s*)?(?:no (?:open )?issues?\b|no such\b|unknown (?:event|decision|issue|id)\b|cannot supersede|.*\bnot found\b|.*\bdoes not exist\b|.*\balready (?:superseded|exists)\b)/iu;

/**
 * A nonzero exit of a ProjectMem command is a rejection (a clean refusal) or an infrastructure
 * failure. Infrastructure is the default: killed by a signal, an exit of 124 or more (timeout,
 * 126/127 cannot run, 137 killed), no output, a Python traceback, a multi-line dump, or a single line
 * that is not a known refusal (`database is locked`, `Killed`). A rejection is only exit 2 (typer usage
 * error) without a traceback, or exit 1 whose whole output is one short line in the known wording.
 */
function isRejection(result: RunResult): boolean {
  if (result.code === null || result.code >= 124) return false;
  const text = cleanOutput(`${result.stdout}\n${result.stderr}`);
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return false;
  if (/Traceback \(most recent call last\)|^\s*File ".*", line \d+/mu.test(text)) return false;
  if (result.code === 2) return true;
  return result.code === 1 && lines.length === 1 && lines[0].length <= 300 && KNOWN_REFUSAL.test(lines[0].trim());
}

const SEARCH_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z? \[evt_[0-9a-f]+\] /u;

// ---------------------------------------------------------------------------------------------
// Events read straight from events.jsonl (read only, bounded)
// ---------------------------------------------------------------------------------------------

export interface MemoryEvent {
  id: string;
  type: string;
  summary: string;
  timestamp: string;
  outcome?: string;
  supersedes?: string;
  superseded: boolean;
}

interface EventsRead {
  events: MemoryEvent[];
  /** False when the file was larger than the read bound and only its tail was parsed. */
  complete: boolean;
}

function parseEvents(text: string, dropFirstLine: boolean): MemoryEvent[] {
  const lines = text.split("\n");
  if (dropFirstLine) lines.shift();
  const events: MemoryEvent[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || !isValidEventId(record.id)) continue;
    if (typeof record.type !== "string" || typeof record.summary !== "string") continue;
    events.push({
      id: record.id,
      type: record.type.slice(0, 32),
      summary: record.summary.slice(0, 600),
      timestamp: typeof record.timestamp === "string" ? record.timestamp.slice(0, 40) : "",
      ...(typeof record.outcome === "string" ? { outcome: record.outcome.slice(0, 16) } : {}),
      ...(typeof record.supersedes === "string" && isValidEventId(record.supersedes) ? { supersedes: record.supersedes } : {}),
      superseded: false,
    });
  }
  const retired = new Set(events.flatMap((event) => (event.supersedes ? [event.supersedes] : [])));
  for (const event of events) event.superseded = retired.has(event.id);
  return events;
}

function readEventsFile(file: string, maxBytes: number): EventsRead {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { events: [], complete: true };
    throw new MemoryError("store_unsafe", "the events log cannot be read safely");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new MemoryError("store_unsafe", "the events log is not a regular file");
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(fd, buffer, offset, length - offset, start + offset);
      if (read === 0) break;
      offset += read;
    }
    return { events: parseEvents(buffer.subarray(0, offset).toString("utf8"), start > 0), complete: start === 0 };
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------------------------
// Store location and safety checks
// ---------------------------------------------------------------------------------------------

interface Locations {
  memoryRoot: string;
  storeDir: string;
  eventsFile: string;
  memoryHome: string;
  pjm: string;
  python: string;
  /** The store directory exists. */
  storeExists: boolean;
  /** `.projectmem/config.toml` exists, so ProjectMem accepts the directory as a project. */
  initialized: boolean;
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new MemoryError("store_unsafe", "a store path cannot be inspected");
  }
}

function realOf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    throw new MemoryError("store_unsafe", "a store path cannot be resolved");
  }
}

/** A real directory: neither a symlink nor anything else. `null` when it does not exist. */
function requireRealDir(path: string, label: string): boolean {
  const stat = lstatOrNull(path);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new MemoryError("store_unsafe", `${label} is not a plain directory`);
  }
  return true;
}

/**
 * Resolve and verify every path of a store. With `create`, missing store directories are created
 * (mode 0700); without it nothing is written. Every call re-checks, so a directory swapped for a
 * symlink between two calls is caught on the next one.
 */
function locate(aiesHome: string, key: string, create: boolean): Locations {
  if (!isValidProjectKey(key)) throw new MemoryError("invalid_key", "the project key is not valid for a store name");
  if (typeof aiesHome !== "string" || !isAbsolute(aiesHome)) {
    throw new MemoryError("store_unsafe", "the AIES profile directory is not an absolute path");
  }
  const home = resolve(aiesHome);
  const realHome = realOf(home);

  const memoryRoot = join(home, "memory");
  if (!requireRealDir(memoryRoot, "the memory directory")) {
    if (!create) {
      return emptyLocations(memoryRoot, key);
    }
    mkdirSync(memoryRoot, { mode: 0o700 });
  }
  const realMemory = realOf(memoryRoot);
  if (realMemory !== join(realHome, "memory")) {
    throw new MemoryError("store_unsafe", "the memory directory resolves outside the profile");
  }

  const storeDir = resolve(memoryRoot, key);
  if (dirname(storeDir) !== memoryRoot) throw new MemoryError("invalid_key", "the project key escapes the memory directory");

  const memoryHome = join(memoryRoot, "_home");
  const venv = join(memoryRoot, "_venv");
  const base = { memoryRoot, storeDir, memoryHome, pjm: join(venv, "bin", "pjm"), python: join(venv, "bin", "python") };

  let storeExists = requireRealDir(storeDir, "the store directory");
  if (!storeExists && create) {
    mkdirSync(storeDir, { mode: 0o700 });
    storeExists = true;
  }
  if (!storeExists) return { ...base, eventsFile: join(storeDir, ".projectmem", "events.jsonl"), storeExists: false, initialized: false };

  const realStore = realOf(storeDir);
  if (realStore !== join(realMemory, key) || !realStore.startsWith(realMemory + sep)) {
    throw new MemoryError("store_unsafe", "the store directory resolves outside the memory directory");
  }

  const pmDir = join(storeDir, ".projectmem");
  const hasPmDir = requireRealDir(pmDir, "the .projectmem directory");
  let initialized = false;
  if (hasPmDir) {
    const config = lstatOrNull(join(pmDir, "config.toml"));
    initialized = config !== null && config.isFile();
  }
  return { ...base, eventsFile: join(pmDir, "events.jsonl"), storeExists, initialized };
}

function emptyLocations(memoryRoot: string, key: string): Locations {
  const storeDir = join(memoryRoot, key);
  return {
    memoryRoot,
    storeDir,
    eventsFile: join(storeDir, ".projectmem", "events.jsonl"),
    memoryHome: join(memoryRoot, "_home"),
    pjm: join(memoryRoot, "_venv", "bin", "pjm"),
    python: join(memoryRoot, "_venv", "bin", "python"),
    storeExists: false,
    initialized: false,
  };
}

/**
 * Check `_home` (the private ProjectMem registry); refuse a symlink. Only the write path may create
 * it. A read path that finds it missing reports it instead of creating anything.
 */
function ensureMemoryHome(path: string, memoryRoot: string, create: boolean): void {
  if (!requireRealDir(path, "the ProjectMem home")) {
    if (!create) throw new MemoryError("store_unsafe", "the ProjectMem home is missing (the next write recreates it)");
    mkdirSync(path, { mode: 0o700 });
  }
  if (realOf(path) !== join(realOf(memoryRoot), "_home")) {
    throw new MemoryError("store_unsafe", "the ProjectMem home resolves outside the memory directory");
  }
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

export type RecordKind = "decision" | "failed_attempt" | "fix" | "note" | "supersede";
export const RECORD_KINDS: readonly RecordKind[] = ["decision", "failed_attempt", "fix", "note", "supersede"];

export interface MemoryStatus {
  available: boolean;
  key: string;
  /** Events in the log; `null` when it cannot be counted. */
  events: number | null;
  /** True when the log is larger than the read bound and `events` is a lower bound. */
  eventsAtLeast: boolean;
  code?: MemoryErrorCode;
  reason?: string;
}

export interface SearchOutcome {
  lines: string[];
  /** Older matches were left out by the result cap. */
  truncated: boolean;
}

export interface RecordOutcome {
  kind: RecordKind;
  /** The new event id, when it could be read back from the log. */
  id?: string;
}

/**
 * The directory of a project's store (`$AIES_HOME/memory/<key>`), checked like every other store path:
 * a real directory under the real memory root. With `create`, missing directories are made (0700).
 * Automatic writes keep their lock and pending files here, next to `.projectmem`, outside every repository.
 */
export function storeDirectory(aiesHome: string, key: string, create: boolean): MemoryResult<{ storeDir: string; exists: boolean }> {
  try {
    const locations = locate(aiesHome, key, create);
    return { ok: true, value: { storeDir: locations.storeDir, exists: locations.storeExists } };
  } catch (error) {
    return failure(error);
  }
}

export interface MemoryStoreOptions {
  aiesHome: string;
  projectKey: string;
  runner?: Runner;
  limits?: Partial<MemoryLimits>;
  /** Environment the allowlist is built from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface MemoryStore {
  readonly projectKey: string;
  status(): Promise<MemoryStatus>;
  search(query: string): Promise<MemoryResult<SearchOutcome>>;
  context(options?: { focus?: string; tokens?: number }): Promise<MemoryResult<string>>;
  list(limit?: number): Promise<MemoryResult<MemoryEvent[]>>;
  /** Every event of the log, read only; `complete` is false when the log is larger than the read bound. */
  all(): Promise<MemoryResult<{ events: MemoryEvent[]; complete: boolean }>>;
  record(input: { kind: RecordKind; summary: string; supersedes?: string }): Promise<MemoryResult<RecordOutcome>>;
  /** True once three consecutive infrastructure failures opened the circuit. */
  isOpen(): boolean;
}

function failure(error: unknown): { ok: false; error: { code: MemoryErrorCode; message: string } } {
  if (error instanceof MemoryError) return { ok: false, error: { code: error.code, message: error.message } };
  return { ok: false, error: { code: "spawn_failed", message: "memory failed unexpectedly" } };
}

export function createMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const limits: MemoryLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const runner = options.runner ?? spawnRunner;
  const key = options.projectKey;
  const aiesHome = options.aiesHome;

  let consecutiveFailures = 0;
  let open = false;
  let writes = 0;
  let versionVerified = false;
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.catch(() => undefined);
    return run;
  };

  /** Run a task as one counted call: the circuit gate, the failure count and the typed result. */
  const guarded = <T>(task: () => Promise<T>): Promise<MemoryResult<T>> =>
    serial(async () => {
      if (open) return failure(new MemoryError("circuit_open", "memory is paused for this session after repeated failures"));
      try {
        const value = await task();
        consecutiveFailures = 0;
        return { ok: true as const, value };
      } catch (error) {
        const typed = error instanceof MemoryError ? error : new MemoryError("spawn_failed", "memory failed unexpectedly");
        if (INFRASTRUCTURE_CODES.has(typed.code)) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= limits.breakerThreshold) open = true;
        }
        return failure(typed);
      }
    });

  const sanitizeDetail = (text: string): string => {
    const line = cleanOutput(text).split("\n").find((candidate) => candidate.trim().length > 0) ?? "";
    return clip(line.split(aiesHome).join("$AIES_HOME").trim(), 200);
  };

  async function exec(
    locations: Locations,
    file: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    allowRejection = true,
  ): Promise<string> {
    const result = await runner({
      file,
      args,
      cwd,
      env: buildEnv(locations.memoryHome, options.env),
      timeoutMs,
      maxStdoutBytes: limits.maxStdoutBytes,
      maxStderrBytes: limits.maxStderrBytes,
    });
    if (result.spawnError) {
      if (!existsSync(file)) throw new MemoryError("pjm_missing", "ProjectMem is not installed for this profile (run scripts/memory-bootstrap.sh)");
      throw new MemoryError("spawn_failed", "ProjectMem could not be started");
    }
    if (result.timedOut) throw new MemoryError("timeout", `ProjectMem did not answer within ${Math.round(timeoutMs / 1000)}s`);
    if (result.overflow) throw new MemoryError("output_overflow", "ProjectMem produced more output than allowed");
    if (result.code !== 0) {
      const detail = sanitizeDetail(result.stdout.length > 0 ? result.stdout : result.stderr);
      const rejected = allowRejection && isRejection(result);
      throw new MemoryError(
        rejected ? "command_rejected" : "command_failed",
        `ProjectMem ${rejected ? "refused the request" : "failed"} (exit code ${result.code ?? "none"})`,
        detail,
      );
    }
    return cleanOutput(result.stdout);
  }

  /** Run one allowlisted ProjectMem operation inside the store directory. */
  async function runOperation(locations: Locations, operation: Operation): Promise<string> {
    const args = argvFor(operation);
    if (!ALLOWED_COMMANDS.includes(args[0])) throw new MemoryError("invalid_input", "operation is not allowed");
    const timeout = operation.op === "init" ? limits.timeoutMs * 3 : limits.timeoutMs;
    return exec(locations, locations.pjm, args, locations.storeDir, timeout);
  }

  /**
   * Pure probe: the installed version must be exactly the pinned one; any other install is treated
   * as missing. `python -I` writes nothing (no bytecode, no user site) and runs in the memory root.
   * Any nonzero exit of the probe is infrastructure: it is never a refusal.
   */
  async function probeVersion(locations: Locations): Promise<void> {
    if (!existsSync(locations.pjm) || !existsSync(locations.python)) {
      throw new MemoryError("pjm_missing", "ProjectMem is not installed for this profile (run scripts/memory-bootstrap.sh)");
    }
    const output = await exec(
      locations,
      locations.python,
      ["-I", "-c", "import importlib.metadata as m; print(m.version('projectmem'))"],
      locations.memoryRoot,
      limits.timeoutMs,
      false,
    );
    const found = output.trim();
    if (found !== PROJECTMEM_VERSION) {
      throw new MemoryError("pjm_version", `ProjectMem ${clip(found, 20) || "unknown"} is installed, ${PROJECTMEM_VERSION} is required`);
    }
  }

  /** Version check for a real operation. `create` (write path only) may create `_home`; reads never do. */
  async function ensureVersion(locations: Locations, create: boolean): Promise<void> {
    if (!existsSync(locations.pjm) || !existsSync(locations.python)) {
      throw new MemoryError("pjm_missing", "ProjectMem is not installed for this profile (run scripts/memory-bootstrap.sh)");
    }
    // On a read path a missing `_home` is reported, not recreated and not run against: the env would
    // point ProjectMem at a directory it might create itself.
    ensureMemoryHome(locations.memoryHome, locations.memoryRoot, create);
    if (versionVerified) return;
    await probeVersion(locations);
    versionVerified = true;
  }

  function trimResult(text: string): string {
    const body = text.trim();
    return Array.from(body).length <= limits.maxResultChars ? body : `${clip(body, limits.maxResultChars - 20)}\n[truncated]`;
  }

  return {
    projectKey: key,

    isOpen: () => open,

    async status(): Promise<MemoryStatus> {
      const base = { key, events: null as number | null, eventsAtLeast: false };
      try {
        const locations = locate(aiesHome, key, false);
        let events: number | null = 0;
        let atLeast = false;
        if (locations.initialized) {
          const read = readEventsFile(locations.eventsFile, limits.maxEventsFileBytes);
          events = read.events.length;
          atLeast = !read.complete;
        }
        // A pure probe: it does not go through `guarded`, so it neither counts toward the circuit
        // nor resets it, and it does not cache the verified version.
        const gate = await serial(async (): Promise<MemoryResult<null>> => {
          if (open) return failure(new MemoryError("circuit_open", "memory is paused for this session after repeated failures"));
          try {
            await probeVersion(locations);
            return { ok: true, value: null };
          } catch (error) {
            return failure(error);
          }
        });
        if (!gate.ok) return { ...base, events, eventsAtLeast: atLeast, available: false, code: gate.error.code, reason: gate.error.message };
        return { ...base, events, eventsAtLeast: atLeast, available: true };
      } catch (error) {
        const failed = failure(error);
        return { ...base, available: false, code: failed.error.code, reason: failed.error.message };
      }
    },

    async search(query: string): Promise<MemoryResult<SearchOutcome>> {
      const checked = checkQueryText(query);
      if (!checked.ok) return failure(new MemoryError("invalid_input", checked.reason));
      return guarded(async () => {
        const locations = locate(aiesHome, key, false);
        if (!locations.initialized) return { lines: [], truncated: false };
        await ensureVersion(locations, false);
        const output = await runOperation(locations, { op: "search", query: checked.text });
        const matches = output.split("\n").filter((line) => SEARCH_LINE.test(line));
        const newest = matches.slice(-limits.maxResults);
        const lines: string[] = [];
        let chars = 0;
        for (const line of newest.reverse()) {
          const shown = clip(line, 500);
          if (chars + shown.length > limits.maxResultChars) break;
          chars += shown.length;
          lines.push(shown);
        }
        return { lines, truncated: matches.length > lines.length };
      });
    },

    async context(request = {}): Promise<MemoryResult<string>> {
      let operation: Operation;
      try {
        operation = { op: "context", tokens: request.tokens ?? DEFAULT_CONTEXT_TOKENS, focus: request.focus };
        argvFor(operation); // validates the budget and the focus before any file is touched
      } catch (error) {
        return failure(error);
      }
      return guarded(async () => {
        const locations = locate(aiesHome, key, false);
        if (!locations.initialized) return "";
        await ensureVersion(locations, false);
        return trimResult(await runOperation(locations, operation));
      });
    },

    async list(limit = 20): Promise<MemoryResult<MemoryEvent[]>> {
      return serial(async () => {
        try {
          const locations = locate(aiesHome, key, false);
          if (!locations.initialized) return { ok: true as const, value: [] };
          const read = readEventsFile(locations.eventsFile, limits.maxEventsFileBytes);
          const count = Math.max(1, Math.min(Math.trunc(limit) || 20, 50));
          return { ok: true as const, value: read.events.slice(-count).reverse() };
        } catch (error) {
          return failure(error);
        }
      });
    },

    async all(): Promise<MemoryResult<{ events: MemoryEvent[]; complete: boolean }>> {
      return serial(async () => {
        try {
          const locations = locate(aiesHome, key, false);
          if (!locations.initialized) return { ok: true as const, value: { events: [], complete: true } };
          return { ok: true as const, value: readEventsFile(locations.eventsFile, limits.maxEventsFileBytes) };
        } catch (error) {
          return failure(error);
        }
      });
    },

    async record(input): Promise<MemoryResult<RecordOutcome>> {
      if (!RECORD_KINDS.includes(input.kind)) return failure(new MemoryError("invalid_input", "unknown record kind"));
      const checked = checkWriteText(input.summary);
      if (!checked.ok) return failure(new MemoryError("invalid_input", checked.reason));
      if (input.kind === "supersede") {
        if (!isValidEventId(input.supersedes)) return failure(new MemoryError("invalid_input", "supersede needs the full event id (evt_...)"));
      } else if (input.supersedes !== undefined) {
        return failure(new MemoryError("invalid_input", "only a supersede record takes an event id"));
      }
      const text = checked.text;

      return guarded(async () => {
        if (writes >= limits.maxSessionWrites) {
          throw new MemoryError("session_write_cap", `this session already wrote ${limits.maxSessionWrites} records`);
        }
        const locations = locate(aiesHome, key, true);
        await ensureVersion(locations, true);

        const before = readEventsFile(locations.eventsFile, limits.maxEventsFileBytes);
        if (!before.complete || before.events.length >= limits.maxEvents) {
          throw new MemoryError("store_full", `the store holds ${limits.maxEvents} events; supersede or prune it by hand`);
        }
        if (before.events.slice(-limits.dedupWindow).some((event) => event.summary === text)) {
          throw new MemoryError("duplicate", "an identical record already exists among the latest events");
        }
        if (input.kind === "supersede") {
          const target = before.events.find((event) => event.id === input.supersedes);
          if (!target) throw new MemoryError("unknown_event", "no event with that id in this project's memory");
          if (target.type !== "decision") throw new MemoryError("unknown_event", "only a decision can be superseded");
        }

        if (!locations.initialized) await runOperation(locations, { op: "init" });

        switch (input.kind) {
          case "decision":
            await runOperation(locations, { op: "decision", text });
            break;
          case "supersede":
            await runOperation(locations, { op: "decision", text, supersedes: input.supersedes });
            break;
          case "note":
            await runOperation(locations, { op: "note", text });
            break;
          case "failed_attempt":
            await runOperation(locations, { op: "attempt", outcome: "failed", text });
            break;
          case "fix":
            try {
              await runOperation(locations, { op: "fix", text });
            } catch (error) {
              // A fix closes the open issue. With none open, open one with the same text first.
              if (!(error instanceof MemoryError) || error.code !== "command_rejected" || !/no open issue/iu.test(error.detail)) throw error;
              await runOperation(locations, { op: "log", text });
              await runOperation(locations, { op: "fix", text });
            }
            break;
        }
        writes += 1;

        const knownIds = new Set(before.events.map((event) => event.id));
        const after = readEventsFile(locations.eventsFile, limits.maxEventsFileBytes);
        const created = after.events.filter((event) => !knownIds.has(event.id) && event.summary === text).pop();
        return { kind: input.kind, ...(created ? { id: created.id } : {}) };
      });
    },
  };
}
