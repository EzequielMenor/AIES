/**
 * Automatic learnings after a confirmed Done (D42, phase 3). Node only: no Pi import, so tests drive it
 * directly and `aies-agents` can call it without loading the memory extension.
 *
 * The runtime, never the model, decides whether anything is stored and where. The Parent only proposes
 * up to three short lessons with `aies_ticket complete`; this module stores them when ALL of these hold,
 * evaluated here at the moment of writing:
 *   1. the ticket belongs to the repository bound to a project (the same scope and `checkTicketRepo` rules
 *      the other memory paths use; fail closed, the target project is the bound key, not a model input);
 *   2. Verify holds a real PASS that is still current (status pass, verified revision equals the revision);
 *   3. the Done Gate authorized the completion;
 *   4. the tracker confirmed Done by reading the work item back (Plane only) and the final state is of the
 *      `completed` type;
 *   5. `memory.writes` is true in the profile (default false: nothing is written).
 *
 * Guarantees and limits, in short:
 * - Completion is independent of this module. The caller closes the ticket first and only then calls
 *   `commitLearnings`; a failure here never undoes Done and never repeats a tracker operation.
 * - Every record ends with a provenance suffix `[aies ticket=<id> rev=<n> src=verify-pass id=<hash>]`. The
 *   text is clipped to make room for it, the suffix never is. The hash covers project key, ticket, Verify
 *   revision, kind and the normalised text, so the same lesson from the same completion has the same id.
 * - Idempotence: before writing, the log is read for that id (and for the same text already stored), so a
 *   repeated completion, a retry or a restart stores nothing twice.
 * - A per-project lock file (`O_EXCL`, in the store directory, outside every repository) serialises the
 *   check-then-write cycle between sessions of this user on this machine. It expires by age (so a crashed
 *   holder cannot block for ever) and a waiter gives up after a short wait instead of blocking. Limits: it is
 *   advisory (a process that ignores it is not stopped), a takeover of a stale lock is best effort (two
 *   processes taking over the same stale lock at the same instant can both proceed), and it is not meant for
 *   network file systems. The exact-duplicate check of `MemoryStore.record` is a second line of defence.
 * - Automatic writes never supersede. A decision on a topic that already has a different live decision is
 *   not written and is reported as a conflict, so the user decides with `/memory supersede`.
 * - If ProjectMem is unavailable the lessons are kept in small JSON files under
 *   `$AIES_HOME/memory/<key>/_pending/` (already past the secret guards) and the user recovers them with
 *   `/memory retry`, which needs no new Plane operation. Pending files are as trusted as the store itself.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import type { DoneCompletion, DoneFollowUp } from "../aies-agents/linear/manager.ts";
import { checkTicketRepo, readRepoGuardConfig, samePath } from "../aies-agents/repo-guard.ts";
import { checkWriteText, MAX_SUMMARY_CHARS } from "./guards.ts";
import { readMemoryConfig, resolveMemoryScope } from "./scope.ts";
import { createMemoryStore, storeDirectory, type MemoryStore, type MemoryStoreOptions, type RecordKind } from "./store.ts";

/** Lessons one completion may store. */
export const MAX_LEARNINGS = 3;

export const LEARNING_KINDS = ["decision", "fix", "failed_attempt", "note"] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];

/** The longest raw text accepted before the runtime clips it to make room for the provenance. */
const MAX_RAW_LEARNING_CHARS = 800;

const PENDING_DIR = "_pending";
const LOCK_FILE = "_lock";
export const MAX_PENDING_FILES = 20;
export const MAX_PENDING_BYTES = 8 * 1024;
export const PENDING_TTL_MS = 14 * 24 * 60 * 60 * 1000;
/** The reason shown when Done was not confirmed by a read of the tracker; it is also told to the user. */
const UNCONFIRMED_DONE = "Done no confirmado por lectura del tracker";
const FOREIGN = "de otro proyecto";
const PENDING_NAME = /^p-[0-9a-f]{12}\.json$/u;

const TICKET_ID = /^[A-Za-z][A-Za-z0-9]{0,15}-[1-9][0-9]{0,8}$/u;
const LEARNING_ID = /^[0-9a-f]{12}$/u;
const PROVENANCE = / \[aies ticket=\S+ rev=\d+ src=verify-pass id=([0-9a-f]{12})\]$/u;

// ---------------------------------------------------------------------------------------------
// Shapes shared with the ticket manager
// ---------------------------------------------------------------------------------------------

export interface LearnTicket {
  identifier: string;
  project?: string;
  projectIdentifier?: string;
  tracker?: string;
}

export interface LearnVerification {
  status: string;
  revision: number;
  verifiedRevision: number | undefined;
}

/** What the manager knows about the completion it just finished (conditions 3 and 4, and the gate-time PASS). */
export interface DoneConfirmation {
  tracker: string;
  /** The tracker state was read back after the write (Plane only). */
  readBackConfirmed: boolean;
  /** The type of the state read back; must be `completed`. */
  stateType: string | undefined;
  /** The Done Gate authorized this completion. */
  gateAllowed: boolean;
  /** The Verify record the gate judged. */
  verification: LearnVerification;
}

export interface LockOptions {
  /** How long a waiter waits for the lock before giving up. */
  waitMs: number;
  /** A lock older than this is taken over. */
  staleMs: number;
  pollMs: number;
}

export const DEFAULT_LOCK: Readonly<LockOptions> = Object.freeze({ waitMs: 3000, staleMs: 60_000, pollMs: 25 });

export interface LearnEnvironment {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Test seams: forwarded to the store (runner, limits). */
  storeOptions?: Partial<MemoryStoreOptions>;
  lock?: Partial<LockOptions>;
  now?: () => number;
}

export interface CommitInput extends LearnEnvironment {
  ticket: LearnTicket;
  /** The Verify record as it stands now, at the moment of writing. */
  verification: LearnVerification;
  doneConfirmation: DoneConfirmation;
  /** What the Parent proposed; untrusted and validated here. */
  learnings: unknown;
}

export interface LearnOutcome {
  /** none: nothing was proposed. skipped: proposed, but a condition failed. done: the batch was processed. */
  status: "none" | "skipped" | "done";
  written: number;
  existing: number;
  conflicts: number;
  rejected: number;
  rejectedReasons: string[];
  omitted: number;
  pending: number;
  /** One short line for the tool result and the user; empty for `none`. */
  line: string;
  level: "info" | "warning";
}

// ---------------------------------------------------------------------------------------------
// Text rules
// ---------------------------------------------------------------------------------------------

/** Lower case, single spaces, no trailing punctuation: the form the id and the comparisons use. */
export function normalizeLearningText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim().replace(/[.;]+$/u, "");
}

/** Stable id of one learning: project key, ticket, Verify revision, kind and normalised text. */
export function learningId(projectKey: string, ticket: string, revision: number, kind: LearningKind, text: string): string {
  const basis = [projectKey, ticket, String(revision), kind, normalizeLearningText(text)].join("\u0000");
  return createHash("sha256").update(basis).digest("hex").slice(0, 12);
}

export function provenanceSuffix(ticket: string, revision: number, id: string): string {
  return `[aies ticket=${ticket} rev=${revision} src=verify-pass id=${id}]`;
}

/** The text of a stored summary without its provenance suffix. */
export function stripProvenance(summary: string): string {
  return summary.replace(PROVENANCE, "");
}

/** A summary that only reports a Verify verdict is not a lesson. */
const VERDICT_PATTERNS: readonly RegExp[] = [
  /\bverif\w*[\s:_-]*(?:pass(?:ed)?|fail(?:ed|ure)?|blocked)\b/iu,
  /\b(?:pass(?:ed)?|fail(?:ed)?|blocked)\b.{0,40}\bverif\w*/iu,
  /\bverif\w*\b.{0,40}\b(?:pass(?:ed)?|fail(?:ed)?|blocked)\b/iu,
  /(?<!\p{L})verificaci[oó]n(?!\p{L}).{0,40}(?<!\p{L})(?:pas[oó]|aprobad\w*|correcta|fall[oó])(?!\p{L})/iu,
  /(?<!\p{L})(?:pas[oó]|aprob\w*)(?!\p{L}).{0,40}(?<!\p{L})verif\w*/iu,
  /^\W*(?:pass|fail|ok|done)\W*$/iu,
  /\bdone gate\b.{0,30}\b(?:allow\w*|pass\w*|autoriz\w*)\b/iu,
];

export function looksLikeVerdict(text: string): boolean {
  return VERDICT_PATTERNS.some((pattern) => pattern.test(text));
}

function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** The topic of a decision: the words before the first `: `, when they look like a short subject. */
function decisionTopic(text: string): { topic: string; body: string } | undefined {
  const match = /^([^:]{3,80}):\s+(\S[\s\S]*)$/u.exec(text);
  if (!match) return undefined;
  const topic = normalizeLearningText(match[1]);
  if (topic.split(" ").length > 8) return undefined;
  return { topic, body: normalizeLearningText(match[2]) };
}

const EVENT_TYPE: Readonly<Record<LearningKind, string>> = {
  decision: "decision",
  fix: "fix",
  failed_attempt: "attempt",
  note: "note",
};

const RECORD_KIND: Readonly<Record<LearningKind, RecordKind>> = {
  decision: "decision",
  fix: "fix",
  failed_attempt: "failed_attempt",
  note: "note",
};

// ---------------------------------------------------------------------------------------------
// Preparing a batch
// ---------------------------------------------------------------------------------------------

interface PreparedItem {
  kind: LearningKind;
  /** The lesson without provenance, already clipped. */
  text: string;
  /** The text with the provenance suffix: what the store records. */
  summary: string;
  id: string;
}

interface PreparedBatch {
  items: PreparedItem[];
  rejected: string[];
  omitted: number;
}

/** Build one item from a clean kind and text, or return the reason it is not storable. */
function buildItem(
  projectKey: string,
  ticket: string,
  revision: number,
  kind: unknown,
  rawText: unknown,
): { ok: true; item: PreparedItem } | { ok: false; reason: string } {
  if (typeof kind !== "string" || !(LEARNING_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: "tipo no válido" };
  const checked = checkWriteText(rawText, MAX_RAW_LEARNING_CHARS);
  if (!checked.ok) {
    return { ok: false, reason: checked.reason.includes("looks like it contains") ? "contenido sensible" : "texto no válido" };
  }
  if (looksLikeVerdict(checked.text)) return { ok: false, reason: "veredicto de Verify" };

  const learningKind = kind as LearningKind;
  // The id covers the provenance-free text, but the length of the suffix depends on the id only by its
  // fixed width, so a placeholder of the same width fixes the room before the id is known.
  const room = MAX_SUMMARY_CHARS - provenanceSuffix(ticket, revision, "0".repeat(12)).length - 1;
  if (room < 40) return { ok: false, reason: "texto no válido" };
  const text = clipChars(checked.text, room);
  const id = learningId(projectKey, ticket, revision, learningKind, text);
  return { ok: true, item: { kind: learningKind, text, summary: `${text} ${provenanceSuffix(ticket, revision, id)}`, id } };
}

/** Only the first `MAX_LEARNINGS` entries are examined; the rest are counted as omitted, in order. */
function prepareBatch(raw: readonly unknown[], projectKey: string, ticket: string, revision: number): PreparedBatch {
  const items: PreparedItem[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  raw.slice(0, MAX_LEARNINGS).forEach((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      rejected.push("formato no válido");
      return;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("summary")) {
      rejected.push("formato no válido");
      return;
    }
    const record = entry as { kind?: unknown; summary?: unknown };
    const built = buildItem(projectKey, ticket, revision, record.kind, record.summary);
    if (!built.ok) {
      rejected.push(built.reason);
      return;
    }
    if (seen.has(built.item.id)) {
      rejected.push("duplicado en el lote");
      return;
    }
    seen.add(built.item.id);
    items.push(built.item);
  });
  return { items, rejected, omitted: Math.max(0, raw.length - MAX_LEARNINGS) };
}

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

function passIsCurrent(verification: LearnVerification): boolean {
  return verification.status === "pass" && verification.verifiedRevision !== undefined && verification.verifiedRevision === verification.revision;
}

type Gate = { ok: true; key: string; aiesHome: string } | { ok: false; reason: string };

/** Conditions 1 to 5, in the order of the cheapest check first. */
function checkConditions(input: CommitInput, env: NodeJS.ProcessEnv): Gate {
  if (!readMemoryConfig(env).writes) return { ok: false, reason: "escrituras automáticas desactivadas" };

  const done = input.doneConfirmation;
  if (input.ticket.tracker !== "plane" || done.tracker !== "plane" || !done.readBackConfirmed || done.stateType !== "completed") {
    return { ok: false, reason: UNCONFIRMED_DONE };
  }
  if (!done.gateAllowed) return { ok: false, reason: "el Done Gate no autorizó el cierre" };
  if (!passIsCurrent(input.verification) || !passIsCurrent(done.verification) || input.verification.revision !== done.verification.revision) {
    return { ok: false, reason: "no hay un PASS de Verify vigente" };
  }
  if (!TICKET_ID.test(input.ticket.identifier)) return { ok: false, reason: "identificador de ticket no válido" };

  if (env.AIES_ALLOW_REPO_MISMATCH === "1") return { ok: false, reason: "la comprobación de repositorio está desactivada" };
  const scope = resolveMemoryScope(input.cwd, env);
  if (!scope.ok) return { ok: false, reason: scope.reason };
  const names = [input.ticket.project, input.ticket.projectIdentifier].map((name) => (typeof name === "string" ? name.trim() : ""));
  if (!names.includes(scope.key)) return { ok: false, reason: "el proyecto del ticket no es el vinculado a este repositorio" };
  if (!readRepoGuardConfig(env).repos[scope.key]) return { ok: false, reason: "este repositorio no tiene un vínculo explícito" };
  const decision = checkTicketRepo(
    {
      identifier: input.ticket.identifier,
      project: input.ticket.project,
      projectIdentifier: input.ticket.projectIdentifier,
      tracker: "plane",
    },
    input.cwd,
    { env },
  );
  if (decision.status !== "ok" || !decision.expectedRoot || !samePath(decision.expectedRoot, scope.root)) {
    return { ok: false, reason: "el ticket pertenece a otro repositorio" };
  }
  return { ok: true, key: scope.key, aiesHome: scope.aiesHome };
}

// ---------------------------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------------------------

function errno(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

type Locked<T> = { ok: true; value: T } | { ok: false; reason: "busy" | "unsafe" };

/**
 * Run `task` holding `<storeDir>/_lock`. Created with `O_EXCL`; an existing lock older than `staleMs` is
 * removed and the attempt repeats; a waiter gives up after `waitMs`. The lock is released only if the file
 * still carries this holder's token.
 */
async function withProjectLock<T>(storeDir: string, options: LockOptions, task: () => Promise<T>): Promise<Locked<T>> {
  const path = join(storeDir, LOCK_FILE);
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (errno(error) !== "EEXIST") return { ok: false, reason: "unsafe" };
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch (statError) {
        if (errno(statError) === "ENOENT") continue;
        return { ok: false, reason: "unsafe" };
      }
      if (!stat.isFile()) return { ok: false, reason: "unsafe" };
      if (Date.now() - stat.mtimeMs > options.staleMs) {
        try {
          unlinkSync(path);
        } catch {
          // Someone else removed it first; the next attempt decides.
        }
        continue;
      }
      if (Date.now() >= deadline) return { ok: false, reason: "busy" };
      await sleep(options.pollMs);
    }
  }
  try {
    return { ok: true, value: await task() };
  } finally {
    try {
      if (readFileSync(path, "utf8") === token) unlinkSync(path);
    } catch {
      // Already gone or taken over: nothing of ours is left to release.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Placing one item in the store
// ---------------------------------------------------------------------------------------------

type Placement =
  | { kind: "written" }
  | { kind: "existing" }
  | { kind: "conflict" }
  | { kind: "rejected"; reason: string }
  | { kind: "pending" };

function classifyFailure(code: string): Placement {
  switch (code) {
    case "duplicate":
      return { kind: "existing" };
    case "invalid_input":
      return { kind: "rejected", reason: "contenido no válido" };
    case "command_rejected":
    case "unknown_event":
      return { kind: "rejected", reason: "ProjectMem lo rechazó" };
    case "store_full":
      return { kind: "rejected", reason: "almacén lleno" };
    case "invalid_key":
    case "store_unsafe":
      return { kind: "rejected", reason: "almacén no seguro" };
    default:
      // Unavailable, timed out, circuit open or the session write cap: the lesson is kept for a retry.
      return { kind: "pending" };
  }
}

/**
 * The check-then-write cycle for one item. The caller holds the project lock. Nothing here supersedes:
 * a different live decision on the same topic is a conflict, left for the user.
 */
async function placeItem(store: MemoryStore, item: PreparedItem): Promise<Placement> {
  const log = await store.all();
  if (!log.ok) return classifyFailure(log.error.code);
  if (!log.value.complete) return { kind: "rejected", reason: "almacén lleno" };

  const type = EVENT_TYPE[item.kind];
  const wanted = normalizeLearningText(item.text);
  const topic = item.kind === "decision" ? decisionTopic(item.text) : undefined;
  for (const event of log.value.events) {
    // The provenance is the exact suffix of the summary: a marker in the middle of a text counts for nothing.
    if (PROVENANCE.exec(event.summary)?.[1] === item.id) return { kind: "existing" };
    if (event.superseded || event.type !== type) continue;
    const stored = stripProvenance(event.summary);
    if (normalizeLearningText(stored) === wanted) return { kind: "existing" };
    if (topic) {
      const other = decisionTopic(stored);
      if (other && other.topic === topic.topic && other.body !== topic.body) return { kind: "conflict" };
    }
  }

  const recorded = await store.record({ kind: RECORD_KIND[item.kind], summary: item.summary });
  if (recorded.ok) return { kind: "written" };
  return classifyFailure(recorded.error.code);
}

// ---------------------------------------------------------------------------------------------
// Pending files
// ---------------------------------------------------------------------------------------------

interface PendingItem {
  kind: LearningKind;
  text: string;
  id: string;
}

interface PendingFile {
  v: 1;
  project: string;
  ticket: string;
  rev: number;
  createdAt: number;
  items: PendingItem[];
}

function pendingName(ticket: string, revision: number): string {
  return `p-${createHash("sha256").update(`${ticket}\u0000${revision}`).digest("hex").slice(0, 12)}.json`;
}

/** The pending directory, created on demand; a symlink or a path outside the store is refused. */
function ensurePendingDir(storeDir: string, create: boolean): string | undefined {
  const dir = join(storeDir, PENDING_DIR);
  try {
    let stat: ReturnType<typeof lstatSync> | null = null;
    try {
      stat = lstatSync(dir);
    } catch (error) {
      if (errno(error) !== "ENOENT") return undefined;
    }
    if (stat === null) {
      if (!create) return undefined;
      mkdirSync(dir, { mode: 0o700 });
    } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return undefined;
    }
    return realpathSync.native(dir) === join(realpathSync.native(storeDir), PENDING_DIR) ? dir : undefined;
  } catch {
    return undefined;
  }
}

function listPendingNames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => PENDING_NAME.test(name))
      .filter((name) => {
        try {
          return lstatSync(join(dir, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

function readSmallFile(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_PENDING_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

type PendingRead = { ok: true; file: PendingFile } | { ok: false; reason: string };

/** Strict validation: a pending file that does not match exactly is discarded, never repaired. */
function parsePending(text: string | undefined, key: string, now: number): PendingRead {
  if (text === undefined) return { ok: false, reason: "ilegible o demasiado grande" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "JSON no válido" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "formato no válido" };
  const record = value as Record<string, unknown>;
  const names = Object.keys(record).sort().join(",");
  if (names !== "createdAt,items,project,rev,ticket,v") return { ok: false, reason: "formato no válido" };
  if (record.project !== key) return { ok: false, reason: FOREIGN };
  if (record.v !== 1) return { ok: false, reason: "versión no válida" };
  if (typeof record.ticket !== "string" || !TICKET_ID.test(record.ticket)) return { ok: false, reason: "ticket no válido" };
  if (typeof record.rev !== "number" || !Number.isInteger(record.rev) || record.rev < 0 || record.rev > 1_000_000_000) {
    return { ok: false, reason: "revisión no válida" };
  }
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) return { ok: false, reason: "fecha no válida" };
  if (now - record.createdAt > PENDING_TTL_MS || record.createdAt - now > 24 * 60 * 60 * 1000) return { ok: false, reason: "caducado" };
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > MAX_LEARNINGS) return { ok: false, reason: "elementos no válidos" };

  const items: PendingItem[] = [];
  for (const entry of record.items as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, reason: "elementos no válidos" };
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "id,kind,text") return { ok: false, reason: "elementos no válidos" };
    const built = buildItem(key, record.ticket, record.rev, item.kind, item.text);
    if (!built.ok || built.item.text !== item.text || built.item.id !== item.id || typeof item.id !== "string" || !LEARNING_ID.test(item.id)) {
      return { ok: false, reason: "elemento alterado o no válido" };
    }
    items.push({ kind: built.item.kind, text: built.item.text, id: built.item.id });
  }
  return { ok: true, file: { v: 1, project: key, ticket: record.ticket, rev: record.rev, createdAt: record.createdAt, items } };
}

function toPrepared(file: PendingFile, item: PendingItem): PreparedItem {
  return { kind: item.kind, text: item.text, id: item.id, summary: `${item.text} ${provenanceSuffix(file.ticket, file.rev, item.id)}` };
}

function writePendingFile(dir: string, name: string, file: PendingFile): boolean {
  const body = JSON.stringify(file);
  if (Buffer.byteLength(body) > MAX_PENDING_BYTES) return false;
  const temporary = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    renameSync(temporary, join(dir, name));
    return true;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // Nothing was created.
    }
    return false;
  }
}

/** Keep `items` for a later retry. Returns how many were saved; the file for the same ticket and revision is merged. */
function savePending(storeDir: string, key: string, ticket: string, revision: number, items: PreparedItem[], now: number): number {
  if (items.length === 0) return 0;
  const dir = ensurePendingDir(storeDir, true);
  if (!dir) return 0;
  const name = pendingName(ticket, revision);
  const names = listPendingNames(dir);
  if (!names.includes(name) && names.length >= MAX_PENDING_FILES) return 0;

  const merged: PendingItem[] = [];
  let createdAt = now;
  if (names.includes(name)) {
    const existing = parsePending(readSmallFile(join(dir, name)), key, now);
    if (existing.ok) {
      merged.push(...existing.file.items);
      createdAt = existing.file.createdAt;
    }
  }
  let saved = 0;
  for (const item of items) {
    if (merged.some((known) => known.id === item.id)) {
      saved += 1;
      continue;
    }
    if (merged.length >= MAX_LEARNINGS) continue;
    merged.push({ kind: item.kind, text: item.text, id: item.id });
    saved += 1;
  }
  const ok = writePendingFile(dir, name, { v: 1, project: key, ticket, rev: revision, createdAt, items: merged });
  return ok ? saved : 0;
}

/** Pending files of a project, for the status line. Any problem counts as none. */
export function countPending(aiesHome: string, key: string): number {
  const located = storeDirectory(aiesHome, key, false);
  if (!located.ok || !located.value.exists) return 0;
  const dir = ensurePendingDir(located.value.storeDir, false);
  return dir ? listPendingNames(dir).length : 0;
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

function emptyOutcome(status: LearnOutcome["status"]): LearnOutcome {
  return { status, written: 0, existing: 0, conflicts: 0, rejected: 0, rejectedReasons: [], omitted: 0, pending: 0, line: "", level: "info" };
}

function summarize(outcome: LearnOutcome, extra: string[] = []): LearnOutcome {
  const parts = [`${outcome.written} guardados`];
  if (outcome.existing > 0) parts.push(`${outcome.existing} ya existentes`);
  if (outcome.conflicts > 0) parts.push(`${outcome.conflicts} en conflicto con una decisión vigente (decide con /memory supersede)`);
  if (outcome.rejected > 0) parts.push(`${outcome.rejected} rechazados (${[...new Set(outcome.rejectedReasons)].join(", ")})`);
  if (outcome.omitted > 0) parts.push(`${outcome.omitted} omitidos (máximo ${MAX_LEARNINGS})`);
  if (outcome.pending > 0) parts.push(`${outcome.pending} pendientes (recupera con /memory retry)`);
  parts.push(...extra);
  return { ...outcome, line: `memoria: ${parts.join(", ")}`, level: outcome.pending > 0 || outcome.conflicts > 0 ? "warning" : "info" };
}

function tally(outcome: LearnOutcome, placement: Placement): void {
  switch (placement.kind) {
    case "written":
      outcome.written += 1;
      break;
    case "existing":
      outcome.existing += 1;
      break;
    case "conflict":
      outcome.conflicts += 1;
      break;
    case "rejected":
      outcome.rejected += 1;
      outcome.rejectedReasons.push(placement.reason);
      break;
    case "pending":
      outcome.pending += 1;
      break;
  }
}

function lockOptions(input: LearnEnvironment): LockOptions {
  return { ...DEFAULT_LOCK, ...input.lock };
}

// ---------------------------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------------------------

/**
 * Store the lessons of a completed ticket when every condition holds. Never throws; never touches the
 * tracker. The returned `line` is for the tool result and, when `level` is a warning, for the user.
 */
export async function commitLearnings(input: CommitInput): Promise<LearnOutcome> {
  try {
    return await commitUnsafe(input);
  } catch {
    return { ...emptyOutcome("skipped"), line: "memoria: aprendizajes no guardados (fallo inesperado)" };
  }
}

async function commitUnsafe(input: CommitInput): Promise<LearnOutcome> {
  const env = input.env ?? process.env;
  const now = input.now ?? Date.now;
  const raw = input.learnings;
  if (raw === undefined || raw === null || (Array.isArray(raw) && raw.length === 0)) return emptyOutcome("none");
  const skipped = (reason: string): LearnOutcome => ({
    ...emptyOutcome("skipped"),
    line: `memoria: aprendizajes no guardados (${reason})`,
    // An unconfirmed Done may mean a forged or missing read-back: that one the user is told about.
    level: reason === UNCONFIRMED_DONE ? "warning" : "info",
  });
  if (!Array.isArray(raw)) return skipped("formato no válido");

  const gate = checkConditions(input, env);
  if (!gate.ok) return skipped(gate.reason);

  const revision = input.verification.revision;
  const batch = prepareBatch(raw, gate.key, input.ticket.identifier, revision);
  const outcome = emptyOutcome("done");
  outcome.omitted = batch.omitted;
  outcome.rejected = batch.rejected.length;
  outcome.rejectedReasons = [...batch.rejected];
  if (batch.items.length === 0) return summarize(outcome);

  const located = storeDirectory(gate.aiesHome, gate.key, true);
  if (!located.ok) {
    const placement = classifyFailure(located.error.code);
    for (const _item of batch.items) tally(outcome, placement.kind === "pending" ? { kind: "rejected", reason: "memoria no disponible" } : placement);
    return summarize(outcome);
  }
  const { storeDir } = located.value;
  const store = createMemoryStore({ aiesHome: gate.aiesHome, projectKey: gate.key, env, ...input.storeOptions });

  // Items that need a retry, in order: either ProjectMem failed or the lock could not be taken.
  const toKeep: PreparedItem[] = [];
  const locked = await withProjectLock(storeDir, lockOptions(input), async () => {
    let unavailable = false;
    for (const item of batch.items) {
      if (unavailable) {
        toKeep.push(item);
        continue;
      }
      const placement = await placeItem(store, item);
      if (placement.kind === "pending") {
        unavailable = true;
        toKeep.push(item);
      } else {
        tally(outcome, placement);
      }
    }
    savePendingInto(outcome, storeDir, gate.key, input.ticket.identifier, revision, toKeep, now());
  });
  if (!locked.ok) {
    if (locked.reason === "unsafe") {
      for (const _item of batch.items) tally(outcome, { kind: "rejected", reason: "almacén no seguro" });
    } else {
      savePendingInto(outcome, storeDir, gate.key, input.ticket.identifier, revision, batch.items, now());
    }
  }
  return summarize(outcome);
}

/**
 * The `afterDone` hook of the ticket manager: the one place where a completion reaches project memory.
 * `cwd` and the environment are read when the hook runs, so a session always uses its own repository.
 */
export function learningsAfterDone(options: {
  cwd: () => string;
  env?: NodeJS.ProcessEnv;
  storeOptions?: Partial<MemoryStoreOptions>;
  lock?: Partial<LockOptions>;
  now?: () => number;
}): (done: DoneCompletion) => Promise<DoneFollowUp | undefined> {
  return async (done) => {
    const outcome = await commitLearnings({
      ticket: done.ticket,
      verification: done.verification,
      doneConfirmation: done.confirmation,
      learnings: done.learnings,
      cwd: options.cwd(),
      env: options.env ?? process.env,
      storeOptions: options.storeOptions,
      lock: options.lock,
      now: options.now,
    });
    if (outcome.status === "none") return undefined;
    return {
      line: outcome.line,
      // A skipped batch (a condition failed) is told to the Parent only, unless it is a warning; a processed one also reaches the user.
      ...(outcome.status === "done" || outcome.level === "warning" ? { notify: { message: outcome.line, level: outcome.level } } : {}),
    };
  };
}

function savePendingInto(outcome: LearnOutcome, storeDir: string, key: string, ticket: string, revision: number, items: PreparedItem[], now: number): void {
  if (items.length === 0) return;
  const saved = savePending(storeDir, key, ticket, revision, items, now);
  outcome.pending += saved;
  for (let lost = saved; lost < items.length; lost += 1) tally(outcome, { kind: "rejected", reason: "no se pudo guardar el pendiente" });
}

// ---------------------------------------------------------------------------------------------
// Retry (the user's command)
// ---------------------------------------------------------------------------------------------

export interface RetryOutcome extends LearnOutcome {
  /** Pending files dropped because they were expired or invalid. */
  discarded: number;
  discardedReasons: string[];
  /** Pending files that name another project than the one bound here: left untouched, never written. */
  foreign: number;
}

/**
 * `/memory retry`: store the pending lessons of the project bound to `cwd`. It repeats the same dedupe and
 * conflict checks and uses the provenance written when the lessons were queued; it asks nothing of the
 * tracker. Expired or invalid files are removed and reported.
 */
export async function retryPending(input: LearnEnvironment): Promise<RetryOutcome> {
  try {
    return await retryUnsafe(input);
  } catch {
    return { ...emptyOutcome("skipped"), discarded: 0, discardedReasons: [], foreign: 0, line: "memoria: el reintento falló de forma inesperada" };
  }
}

async function retryUnsafe(input: LearnEnvironment): Promise<RetryOutcome> {
  const env = input.env ?? process.env;
  const now = (input.now ?? Date.now)();
  const base = (outcome: LearnOutcome): RetryOutcome => ({ ...outcome, discarded: 0, discardedReasons: [], foreign: 0 });

  const scope = resolveMemoryScope(input.cwd, env);
  if (!scope.ok) return base({ ...emptyOutcome("skipped"), line: `memoria: no disponible (${scope.reason})`, level: "warning" });
  // Retrying is a write, so it needs the same switch as the first attempt.
  if (!readMemoryConfig(env).writes) {
    return base({ ...emptyOutcome("skipped"), line: "memoria: no se reintenta (memory.writes no está activado); los pendientes se conservan", level: "warning" });
  }
  const located = storeDirectory(scope.aiesHome, scope.key, false);
  if (!located.ok || !located.value.exists) return base({ ...emptyOutcome("none"), line: "memoria: no hay aprendizajes pendientes" });
  const { storeDir } = located.value;
  const dir = ensurePendingDir(storeDir, false);
  if (!dir || listPendingNames(dir).length === 0) return base({ ...emptyOutcome("none"), line: "memoria: no hay aprendizajes pendientes" });

  const store = createMemoryStore({ aiesHome: scope.aiesHome, projectKey: scope.key, env, ...input.storeOptions });
  const outcome: RetryOutcome = { ...emptyOutcome("done"), discarded: 0, discardedReasons: [], foreign: 0 };

  const locked = await withProjectLock(storeDir, lockOptions(input), async () => {
    let unavailable = false;
    for (const name of listPendingNames(dir)) {
      const path = join(dir, name);
      const read = parsePending(readSmallFile(path), scope.key, now);
      if (!read.ok && read.reason === FOREIGN) {
        // Another project's lesson never gets written here, and is not deleted either: it is left for the user.
        outcome.foreign += 1;
        continue;
      }
      if (!read.ok) {
        outcome.discarded += 1;
        outcome.discardedReasons.push(read.reason);
        try {
          unlinkSync(path);
        } catch {
          // A file that cannot be removed is reported again next time.
        }
        continue;
      }
      const kept: PendingItem[] = [];
      for (const item of read.file.items) {
        if (unavailable) {
          kept.push(item);
          outcome.pending += 1;
          continue;
        }
        const placement = await placeItem(store, toPrepared(read.file, item));
        if (placement.kind === "pending") {
          unavailable = true;
          kept.push(item);
          outcome.pending += 1;
        } else {
          tally(outcome, placement);
        }
      }
      if (kept.length === 0) {
        try {
          unlinkSync(path);
        } catch {
          // Reported again next time; the dedupe makes that harmless.
        }
      } else if (kept.length !== read.file.items.length) {
        writePendingFile(dir, name, { ...read.file, items: kept });
      }
    }
  });
  if (!locked.ok) {
    return base({
      ...emptyOutcome("skipped"),
      line: locked.reason === "busy" ? "memoria: otra sesión está escribiendo; reintenta en unos segundos" : "memoria: el almacén no es seguro",
      level: "warning",
    });
  }

  const extra = outcome.discarded > 0 ? [`${outcome.discarded} descartados (${[...new Set(outcome.discardedReasons)].join(", ")})`] : [];
  if (outcome.foreign > 0) extra.push(`${outcome.foreign} ignorados (${FOREIGN}; no se escriben aquí)`);
  const summary = summarize(outcome, extra);
  return { ...outcome, ...summary, level: outcome.foreign > 0 ? "warning" : summary.level };
}
