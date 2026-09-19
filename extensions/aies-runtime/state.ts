/**
 * Session metrics for the AIES runtime observer (AIES-002).
 *
 * Pure by construction: no Pi import, no I/O, no timers, no decisions. `index.ts`
 * feeds it Pi events, `status.ts` renders what comes out, and the tests drive it
 * directly. This phase measures and never governs: nothing here can block a tool
 * call, change routing or trigger compaction.
 */

import { aggregateUsage, normalizeUsage, type UsageBucket } from "./usage.ts";
import type { AgentRecord } from "../aies-agents/observatory.ts";

/** Version of the persisted shape. Bump it only with a compatible reader. */
export const STATE_VERSION = 1;

/** Native tools Pi uses to hand file contents to the model. */
const SOURCE_READ_TOOLS: readonly string[] = ["read", "view_file"];

/** Native tools Pi uses to look around without opening a whole file. */
const SEARCH_TOOLS: readonly string[] = ["grep", "find", "ls", "glob", "codegraph", "tgrep"];

/**
 * Leading commands that only look at state. This is a deliberately small list for
 * a counter, not a shell parser: anything it does not recognise is just a tool
 * call, which is a correct fallback.
 */
const SHELL_INSPECTION_COMMANDS: readonly string[] = [
  "cat", "sed", "awk", "grep", "egrep", "fgrep", "rg", "ag", "head", "tail",
  "less", "more", "ls", "ll", "tree", "find", "fd", "wc", "sort", "uniq",
  "column", "stat", "file", "du", "df", "realpath", "dirname", "basename",
  "pwd", "git", "diff", "strings", "bat", "batcat", "jq", "yq", "md5", "sha1sum", "shasum",
];

/** `git` only inspects through these subcommands; `git commit` is not a read. */
const GIT_INSPECTION_SUBCOMMANDS: readonly string[] = [
  "status", "diff", "log", "show", "blame", "ls-files", "ls-tree", "cat-file",
  "shortlog", "describe", "rev-parse", "grep",
];

/** Identity of the session the numbers belong to. */
export interface SessionState {
  sessionId: string | undefined;
  sessionFile: string | undefined;
  /** Wall-clock start of the observed session, in epoch milliseconds. */
  startedAt: number;
  /** Last wall-clock observation, in epoch milliseconds. */
  lastEventAt: number;
  /** When a persisted snapshot was taken over into this run, if it was. */
  resumedAt: number | undefined;
  /** Last stop reason reported by Pi, when the session reached a final state. */
  stopReason: string | undefined;
}

/** Context pressure. Tokens come from Pi; this module never estimates them. */
export interface ContextState {
  /** Null when Pi cannot answer yet (e.g. right after a compaction). */
  currentTokens: number | null;
  peakTokens: number;
  contextWindow: number;
  /** Context window in force when `peakTokens` was sampled. */
  peakContextWindow: number;
  usagePercent: number | null;
}

/** Direct tool activity of the parent session. */
export interface ToolsState {
  calls: number;
  results: number;
  errors: number;
  callsByName: Record<string, number>;
}

/** Delegations launched from the parent session (AIES-003). */
export interface DelegationsState {
  total: number;
  byRole: Record<string, number>;
  byOutcome: Record<string, number>;
  activeRole: string | undefined;
  activeStartedAt: number | undefined;
  /** The delegation task text observed with the active child, when it was reported. */
  activeTask: string | undefined;
  lastOutcome: string | undefined;
  lastDurationMs: number | undefined;
}

/**
 * The child delegation currently running, or the most recent one. Shaped like the
 * UI's activity record but owned by the runtime: `aies-ui` never imports state and
 * `state.ts` never imports `aies-ui`. Every fact is optional; a missing one is
 * omitted by the renderer instead of guessed.
 */
export interface ActivityState {
  role: string;
  task: string;
  startedAt: number;
  finishedAt?: number;
  outcome?: string;
  summary?: string;
  evidenceCount?: number;
  changedFiles?: number;
  checksPassed?: number;
  checksTotal?: number;
  criteriaPassed?: number;
  criteriaTotal?: number;
  blockingDefects?: number;
  model?: string;
}

/**
 * Independent verification as the parent session reported it (AIES-005).
 *
 * The observer never decides verification: it counts the runs it sees, records
 * the verdict the authority reported, and measures how long a run took. The one
 * derived field is `mutationsSincePass`, which is what makes an old PASS visible
 * as stale in the footer after the artifact changed.
 */
export interface VerificationState {
  status: "none" | "pass" | "fail" | "blocked" | "protocol_error";
  /** Verification runs started, counted here. */
  attempts: number;
  /** Repair cycles reported by the verification policy. */
  repairs: number;
  maxRepairs: number;
  /** Whether the authority still considers its last PASS valid. */
  valid: boolean;
  /** Whether a behaviour-bearing change is waiting for verification. */
  awaiting: boolean;
  lastDurationMs: number | undefined;
  /** Parent mutations observed since the last reported PASS. */
  mutationsSincePass: number;
}

/** How much the parent looked at, and how much it swallowed doing that. */
export interface ExplorationState {
  /** Distinct paths handed to the native file-reading tools. */
  filesInspected: string[];
  /** Calls to the native tools that open source files. */
  sourceReads: number;
  /** Calls to the native tools that search or list. */
  searches: number;
  /** `bash` calls whose command is an obvious inspection command. */
  shellInspections: number;
  /** Approximate characters Pi handed back to the model. */
  outputChars: number;
  largestOutputChars: number;
}

/** Permissions state tracked for observability (AIES-006). */
export interface PermissionsState {
  sandbox: "active" | "unavailable" | "disabled";
  worker: "workspace-write";
  verify: "source-read-only";
  network: "disabled" | "restricted";
  denials: number;
  approvals: number;
  sandboxFailures: number;
}

/** Context Governor state tracked for observability (AIES-007). */
export interface ContextGovernorState {
  zone: "green" | "amber" | "pressure" | "compact" | "ceiling";
  currentTokens: number | null;
  compactAtTokens: number;
  ceilingTokens: number;
  compactPending: boolean;
  compacting: boolean;
  compactionCount: number;
  oversizedResults: number;
  truncatedChars: number;
  lastCompactionError?: string;
}

/** Linear ticket state tracked for observability (AIES-008). */
export interface TicketObservationState {
  active: boolean;
  identifier?: string;
  title?: string;
  status?: string;
  workState?: "loaded" | "working" | "verification_required" | "verified" | "blocked" | "complete";
  validVerify?: boolean;
}

/** Autonomy state tracked for observability (AIES-009). */
export interface AutonomyObservationState {
  enabled: boolean;
  ticketId?: string | null;
  continuationCount: number;
  stopReason?: string | null;
  lastStep?: string;
}

/**
 * Run-scoped usage telemetry (AIES-010C): the Parent, child and total token and
 * cost numbers of the current AIES run, plus the baseline they are measured
 * against.
 *
 * `baseline` is the Parent cumulative usage captured by the current run's first
 * sample; `main` is the Parent usage since that baseline and never includes a
 * child. `agents` is the observatory's child aggregate and `total` is
 * `main + agents`, counted once. An unknown cost stays `null` end to end.
 */
export interface RunUsageState {
  /** Parent cumulative usage at the current run's first sample; null until sampled. */
  baseline: UsageBucket | null;
  /** Parent usage since the run baseline. */
  main: UsageBucket;
  /** Aggregate of the observatory's child records. */
  agents: UsageBucket;
  /** `main + agents`, counted once. */
  total: UsageBucket;
  /** Whether a ticket run is currently active. */
  active: boolean;
  /** Wall-clock start of the current run, when one was recorded. */
  startedAt: number | undefined;
}

/** Everything AIES measures about one parent session. */
export interface AiesState {
  version: number;
  session: SessionState;
  context: ContextState;
  tools: ToolsState;
  delegations: DelegationsState;
  verification: VerificationState;
  exploration: ExplorationState;
  permissions: PermissionsState;
  contextGovernor: ContextGovernorState;
  ticket: TicketObservationState;
  autonomy?: AutonomyObservationState;
  /** Current-run usage numbers plus the baseline they are measured against. */
  runUsage: RunUsageState;
  /**
   * The live observatory projection for the UI: a bounded, transcript-free copy.
   * It is ephemeral presentation state, held for the current session only and
   * never written to or read from the persisted snapshot.
   */
  agents: readonly AgentRecord[];
  /** Active or most recent child activity, absent when none was observed. */
  activity?: ActivityState;
  compactionCount: number;
  activeToolCount: number;
  model: { id: string; provider: string; label: string } | undefined;
}


/** Tool call input as far as the observer trusts it: every field is optional. */
export interface ToolCallLike {
  toolName: string;
  input?: Record<string, unknown>;
}

/** Tool result reduced to what the observer measures. */
export interface ToolResultLike {
  content?: unknown;
  isError?: boolean;
}

/** One `ctx.getContextUsage()` sample. */
export interface ContextUsageLike {
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

export function createState(now: number): AiesState {
  return {
    version: STATE_VERSION,
    session: {
      sessionId: undefined,
      sessionFile: undefined,
      startedAt: now,
      lastEventAt: now,
      resumedAt: undefined,
      stopReason: undefined,
    },
    context: {
      currentTokens: null,
      peakTokens: 0,
      contextWindow: 0,
      peakContextWindow: 0,
      usagePercent: null,
    },
    tools: { calls: 0, results: 0, errors: 0, callsByName: {} },
    delegations: {
      total: 0,
      byRole: {},
      byOutcome: {},
      activeRole: undefined,
      activeStartedAt: undefined,
      activeTask: undefined,
      lastOutcome: undefined,
      lastDurationMs: undefined,
    },
    verification: {
      status: "none",
      attempts: 0,
      repairs: 0,
      maxRepairs: 0,
      valid: false,
      awaiting: false,
      lastDurationMs: undefined,
      mutationsSincePass: 0,
    },
    exploration: {
      filesInspected: [],
      sourceReads: 0,
      searches: 0,
      shellInspections: 0,
      outputChars: 0,
      largestOutputChars: 0,
    },
    permissions: {
      sandbox: "active",
      worker: "workspace-write",
      verify: "source-read-only",
      network: "disabled",
      denials: 0,
      approvals: 0,
      sandboxFailures: 0,
    },
    contextGovernor: {
      zone: "green",
      currentTokens: null,
      compactAtTokens: 120_000,
      ceilingTokens: 150_000,
      compactPending: false,
      compacting: false,
      compactionCount: 0,
      oversizedResults: 0,
      truncatedChars: 0,
      lastCompactionError: undefined,
    },
    ticket: { active: false },
    autonomy: undefined,
    runUsage: emptyRunUsage(),
    agents: [],
    activity: undefined,
    compactionCount: 0,
    activeToolCount: 0,
    model: undefined,
  };
}

/** A run-local usage state with nothing measured yet. */
function emptyRunUsage(): RunUsageState {
  return {
    baseline: null,
    main: { totalTokens: 0, cost: null },
    agents: { totalTokens: 0, cost: 0 },
    total: { totalTokens: 0, cost: null },
    active: false,
    startedAt: undefined,
  };
}


function cloneState(state: AiesState): AiesState {
  return {
    ...state,
    session: { ...state.session },
    context: { ...state.context },
    tools: { ...state.tools, callsByName: { ...state.tools.callsByName } },
    delegations: {
      ...state.delegations,
      byRole: { ...state.delegations.byRole },
      byOutcome: { ...state.delegations.byOutcome },
    },
    verification: { ...state.verification },
    exploration: { ...state.exploration, filesInspected: [...state.exploration.filesInspected] },
    permissions: { ...state.permissions },
    contextGovernor: { ...state.contextGovernor },
    ticket: { ...state.ticket },
    runUsage: {
      baseline: state.runUsage.baseline ? { ...state.runUsage.baseline } : null,
      main: { ...state.runUsage.main },
      agents: { ...state.runUsage.agents },
      total: { ...state.runUsage.total },
      active: state.runUsage.active,
      startedAt: state.runUsage.startedAt,
    },
    agents: [...state.agents],
    activity: state.activity ? { ...state.activity } : undefined,
  };
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * Collapse the spellings of one file (`docs/x.md`, `./docs/x.md`,
 * `/repo/docs/x.md`) into a single key. A path outside the repository keeps its
 * own spelling: there is nothing sane to relativize it against.
 */
export function normalizePath(rawPath: string, root: string): string {
  const trimmed = rawPath.trim().replace(/\\/gu, "/");
  if (!trimmed) return "";

  let key = trimmed.startsWith("~/") ? trimmed.slice(2) : trimmed;
  const rootKey = root.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (rootKey && key.startsWith(`${rootKey}/`)) key = key.slice(rootKey.length + 1);
  else if (rootKey && key === rootKey) return "";
  while (key.startsWith("./")) key = key.slice(2);
  if (key.startsWith("/")) return key;

  const escaped = key.startsWith("../");
  const segments: string[] = [];
  for (const segment of key.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length && segments[segments.length - 1] !== "..") {
        segments.pop();
        continue;
      }
      if (!escaped) return trimmed;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function inspectedPath(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!SOURCE_READ_TOOLS.includes(toolName) || !input) return undefined;
  for (const key of ["path", "filePath", "file_path"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * First word of a shell command, with leading `VAR=value` assignments and a
 * `cd <dir> &&` prefix skipped. Heuristic on purpose: the quoted and substituted
 * remainder is never analysed.
 */
export function shellHeadWord(command: string): string {
  const tokens = command.trim().split(/[\s;|&\n()]+/u).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) continue;
    if (token === "cd") {
      index += 1;
      continue;
    }
    return token;
  }
  return "";
}

/** Small and explicit: does this command only look at state? */
export function isInspectionCommand(command: string): boolean {
  const head = shellHeadWord(command);
  if (!head) return false;

  const binary = head.split("/").pop() ?? head;
  if (!SHELL_INSPECTION_COMMANDS.includes(binary)) return false;
  if (binary !== "git") return true;

  const subcommand = command.trim().split(/[\s;|&\n()]+/u).filter(Boolean)[1];
  return typeof subcommand === "string" && GIT_INSPECTION_SUBCOMMANDS.includes(subcommand);
}

/**
 * Observe a parent tool call. Total by construction: an unknown tool only bumps
 * the generic counters, and no input shape can throw.
 */
export function applyToolCall(state: AiesState, call: ToolCallLike, now: number, root: string): AiesState {
  const next = cloneState(state);
  const { toolName, input } = call;

  next.tools.calls += 1;
  next.tools.callsByName[toolName] = (next.tools.callsByName[toolName] ?? 0) + 1;
  next.session.lastEventAt = now;

  if (SOURCE_READ_TOOLS.includes(toolName)) next.exploration.sourceReads += 1;
  else if (SEARCH_TOOLS.includes(toolName)) next.exploration.searches += 1;
  else if (toolName === "bash" && typeof input?.command === "string" && isInspectionCommand(input.command)) {
    next.exploration.shellInspections += 1;
  }

  const path = inspectedPath(toolName, input);
  if (path) {
    const normalized = normalizePath(path, root);
    if (normalized && !next.exploration.filesInspected.includes(normalized)) {
      next.exploration.filesInspected.push(normalized);
    }
  }
  return next;
}

/**
 * Characters Pi put on screen for one result. Images carry base64 in `data`, so
 * they are counted in the same unit; anything unrecognised counts as nothing.
 */
function outputSize(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;

  let total = 0;
  for (const part of content) {
    if (typeof part === "string") {
      total += part.length;
      continue;
    }
    if (!part || typeof part !== "object") continue;

    const block = part as { type?: unknown; text?: unknown; data?: unknown };
    if (typeof block.text === "string") total += block.text.length;
    else if (block.type === "image" && typeof block.data === "string") total += block.data.length;
  }
  return total;
}

/** Observe a parent tool result. Results are measured, never modified. */
export function applyToolResult(state: AiesState, result: ToolResultLike, now: number): AiesState {
  const next = cloneState(state);
  const chars = outputSize(result.content);

  next.tools.results += 1;
  if (result.isError) next.tools.errors += 1;
  next.exploration.outputChars += chars;
  if (chars > next.exploration.largestOutputChars) next.exploration.largestOutputChars = chars;
  next.session.lastEventAt = now;
  return next;
}

/**
 * Feed one `ctx.getContextUsage()` sample. `peakTokens` is monotonic: it never
 * falls, not when the current usage drops, not after a compaction and not when
 * the model changes. The window it was measured against is kept with it, so a
 * peak inherited from a larger window is still read correctly.
 */
export function applyContextUsage(state: AiesState, usage: ContextUsageLike | null | undefined): AiesState {
  if (!usage) return state;

  const window = positive(usage.contextWindow) ?? 0;
  const tokens = positive(usage.tokens);
  const percent = typeof usage.percent === "number" && Number.isFinite(usage.percent) ? usage.percent : null;
  if (window === 0 && tokens === null && percent === null) return state;

  const next = cloneState(state);
  next.context.contextWindow = window;
  next.context.currentTokens = tokens;
  next.context.usagePercent = percent;

  if (tokens !== null && tokens > next.context.peakTokens) {
    next.context.peakTokens = tokens;
    next.context.peakContextWindow = window;
  }
  return next;
}

/** Count a compaction that actually happened. */
export function applyCompaction(state: AiesState, now: number): AiesState {
  const next = cloneState(state);
  next.compactionCount += 1;
  next.session.lastEventAt = now;
  return next;
}

/** Record the start of a child agent delegation, with its task text when known. */
export function applyDelegationStart(state: AiesState, role: string, now: number, task?: string): AiesState {
  const next = cloneState(state);
  next.delegations.total += 1;
  next.delegations.byRole[role] = (next.delegations.byRole[role] ?? 0) + 1;
  next.delegations.activeRole = role;
  next.delegations.activeStartedAt = now;
  const taskText = typeof task === "string" ? task : undefined;
  next.delegations.activeTask = taskText;
  next.activity = { role, task: taskText ?? "", startedAt: now };
  next.session.lastEventAt = now;
  return next;
}

/** Record the completion or settlement of a child agent delegation. */
export function applyDelegationEnd(state: AiesState, outcome: string, now: number): AiesState {
  const next = cloneState(state);
  const duration = state.delegations.activeStartedAt
    ? Math.max(0, now - state.delegations.activeStartedAt)
    : undefined;
  next.delegations.lastDurationMs = duration;
  next.delegations.activeRole = undefined;
  next.delegations.activeStartedAt = undefined;
  next.delegations.activeTask = undefined;
  next.delegations.lastOutcome = outcome;
  next.delegations.byOutcome[outcome] = (next.delegations.byOutcome[outcome] ?? 0) + 1;
  next.session.lastEventAt = now;

  // A verification run reports its own verdict; its duration is ours to measure.
  if (state.delegations.activeRole === "verify") {
    next.verification.lastDurationMs = duration;
  }

  // The active card becomes the finished card the widget keeps for its TTL.
  if (next.activity && next.activity.finishedAt === undefined) {
    next.activity = { ...next.activity, finishedAt: now, outcome };
  }
  return next;
}

/**
 * Store the facts the delegation tool reported on the active (or last) activity
 * record. Every field is validated: an unreadable report changes nothing.
 */
export function applyActivityFacts(state: AiesState, facts: unknown): AiesState {
  if (!facts || typeof facts !== "object" || Array.isArray(facts) || !state.activity) return state;
  const source = facts as Record<string, unknown>;

  const next = cloneState(state);
  const activity: ActivityState = { ...(next.activity as ActivityState) };

  const counts = [
    "evidenceCount",
    "changedFiles",
    "checksPassed",
    "checksTotal",
    "criteriaPassed",
    "criteriaTotal",
    "blockingDefects",
  ] as const;
  for (const key of counts) {
    const parsed = positive(source[key]);
    if (parsed !== null) activity[key] = parsed;
  }
  if (typeof source.summary === "string" && source.summary) activity.summary = source.summary;

  next.activity = activity;
  return next;
}

/** Count the start of a verification run. */
export function applyVerificationStart(state: AiesState): AiesState {
  const next = cloneState(state);
  next.verification.attempts += 1;
  return next;
}

/**
 * Record the verification facts the authority reported through the delegation
 * tool. Every field is validated: an unreadable report changes nothing.
 */
export function applyVerificationReport(state: AiesState, report: unknown): AiesState {
  if (!report || typeof report !== "object" || Array.isArray(report)) return state;

  const source = report as Record<string, unknown>;
  const status =
    source.status === "pass" || source.status === "fail" || source.status === "blocked" || source.status === "protocol_error"
      ? source.status
      : "none";

  const next = cloneState(state);
  next.verification.status = status;
  next.verification.valid = source.valid === true;
  next.verification.awaiting = source.awaitingVerification === true;
  next.verification.repairs = positive(source.repairs) ?? next.verification.repairs;
  next.verification.maxRepairs = positive(source.maxRepairs) ?? next.verification.maxRepairs;

  // A new verdict starts counting mutations from that point again.
  next.verification.mutationsSincePass = 0;
  return next;
}

/** Observe a direct parent mutation: an old PASS stops describing the artifact. */
export function applyParentMutation(state: AiesState): AiesState {
  const next = cloneState(state);
  next.verification.mutationsSincePass += 1;
  if (next.verification.status === "pass") next.verification.valid = false;
  return next;
}

/** Remember which model is running, so a peak can be attributed to it. */
export function applyModel(state: AiesState, model: { id?: unknown; provider?: unknown; name?: unknown } | null | undefined): AiesState {
  if (!model || typeof model.id !== "string" || !model.id) return state;

  const next = cloneState(state);
  next.model = {
    id: model.id,
    provider: typeof model.provider === "string" && model.provider ? model.provider : "unknown",
    label: typeof model.name === "string" && model.name ? model.name : model.id,
  };
  return next;
}

/** Record the tool surface reported by Pi. */
export function applyActiveToolCount(state: AiesState, count: number | null | undefined): AiesState {
  const value = positive(count);
  if (value === null) return state;

  const next = cloneState(state);
  next.activeToolCount = value;
  return next;
}

export function applySessionMeta(
  state: AiesState,
  meta: { sessionId?: unknown; sessionFile?: unknown },
): AiesState {
  const next = cloneState(state);
  if (typeof meta.sessionId === "string" && meta.sessionId) next.session.sessionId = meta.sessionId;
  if (typeof meta.sessionFile === "string" && meta.sessionFile) next.session.sessionFile = meta.sessionFile;
  return next;
}

export function applyStopReason(state: AiesState, reason: unknown, now: number): AiesState {
  if (typeof reason !== "string" || !reason) return state;

  const next = cloneState(state);
  next.session.stopReason = reason;
  next.session.lastEventAt = now;
  return next;
}

/** Stamp the moment a persisted snapshot was taken over into this run. */
export function applyResumedAt(state: AiesState, now: number): AiesState {
  const next = cloneState(state);
  next.session.resumedAt = now;
  if (next.autonomy) {
    next.autonomy.enabled = false;
  }
  return next;
}

/**
 * Start (or restart) the current run. It clears the numbers and drops the Parent
 * usage baseline, so the next `applyRunUsage` captures the run's own zero and the
 * panel reports current-run telemetry instead of whole-session lifetime.
 */
export function applyRunStart(state: AiesState, now: number): AiesState {
  const next = cloneState(state);
  next.runUsage = {
    baseline: null,
    main: { totalTokens: 0, cost: null },
    agents: { totalTokens: 0, cost: 0 },
    total: { totalTokens: 0, cost: null },
    active: true,
    startedAt: now,
  };
  next.session.lastEventAt = now;
  return next;
}

/**
 * Fold one Parent usage sample and the observatory snapshot into the run
 * telemetry through the existing pure `aggregateUsage`.
 *
 * `parentUsage` is the Parent session's cumulative usage, read from the only real
 * Pi surface that exposes it (assistant `usage` records). No child token can hide
 * in it: a delegated child runs in an isolated in-memory session and
 * `aies_delegate` returns no nested usage, so Main is Parent-only and Agents is
 * the registry, never a mix. The first sample after a run start becomes the
 * baseline; every later sample reports the delta since then. A missing Parent
 * sample (null/undefined) keeps the last known Main instead of flashing a zero.
 */
export function applyRunUsage(
  state: AiesState,
  parentUsage: UsageBucket | null | undefined,
  agentsSnapshot: readonly AgentRecord[] | null | undefined,
  now: number,
): AiesState {
  const next = cloneState(state);
  const current = next.runUsage;

  let baseline = current.baseline;
  let main: UsageBucket;
  if (parentUsage === null || parentUsage === undefined) {
    // No fresh Parent sample (Pi could not answer): keep the last known Main
    // rather than flashing a zero. A run start still waits for its baseline.
    main = { ...current.main };
  } else {
    const parent = normalizeUsage(parentUsage);
    baseline = current.active && current.baseline === null ? parent : current.baseline;
    main = baseline
      ? {
          totalTokens: Math.max(0, parent.totalTokens - baseline.totalTokens),
          cost:
            parent.cost !== null && baseline.cost !== null
              ? Math.max(0, parent.cost - baseline.cost)
              : null,
        }
      : parent;
  }

  const childBuckets = (agentsSnapshot ?? []).map((record) => ({
    totalTokens: record.totalTokens,
    cost: record.cost,
  }));
  const aggregate = aggregateUsage(main, childBuckets);

  next.runUsage = {
    baseline,
    main: aggregate.main,
    agents: aggregate.agents,
    total: aggregate.total,
    active: current.active,
    startedAt: current.startedAt,
  };
  next.session.lastEventAt = now;
  return next;
}

/**
 * Store the immutable observatory projection for the UI. It is a bounded,
 * transcript-free copy held in memory for the current session only: the persisted
 * snapshot never carries it and a resumed session starts with an empty registry,
 * so a finished child is never resurrected as if it were still running.
 */
export function applyAgents(state: AiesState, snapshot: readonly AgentRecord[] | null | undefined): AiesState {
  const next = cloneState(state);
  next.agents = Array.isArray(snapshot) ? [...snapshot] : [];
  return next;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry && !out.includes(entry)) out.push(entry);
  }
  return out;
}

function countMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const count = positive(raw);
    if (count !== null && count > 0) out[key] = count;
  }
  return out;
}

/** An exact cost value, never truncated: fractional costs must survive a round trip. */
function finiteCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read a persisted usage bucket, or `null` when the value is not one. */
function usageBucketOf(value: unknown): UsageBucket | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const totalTokens = positive(source.totalTokens);
  if (totalTokens === null && !("cost" in source)) return null;
  return { totalTokens: totalTokens ?? 0, cost: finiteCost(source.cost) };
}

/** The persisted projection of the state; everything the UI shows derives from it. */
export interface AiesSnapshot {
  version: number;
  startedAt: number;
  lastEventAt: number;
  resumedAt: number | undefined;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  stopReason: string | undefined;
  contextTokens: number | null;
  peakContextTokens: number;
  contextWindow: number;
  peakContextWindow: number;
  usagePercent: number | null;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  toolCallsByName: Record<string, number>;
  filesInspected: string[];
  sourceReads: number;
  searchCalls: number;
  shellInspections: number;
  outputChars: number;
  largestOutputChars: number;
  compactionCount: number;
  activeToolCount: number;
  model: AiesState["model"];
  delegations: {
    total: number;
    byRole: Record<string, number>;
    byOutcome: Record<string, number>;
    activeRole: string | undefined;
    activeStartedAt: number | undefined;
    activeTask: string | undefined;
    lastOutcome: string | undefined;
    lastDurationMs: number | undefined;
  };
  verification: {
    status: "none" | "pass" | "fail" | "blocked" | "protocol_error";
    attempts: number;
    repairs: number;
    maxRepairs: number;
    valid: boolean;
    awaiting: boolean;
    lastDurationMs: number | undefined;
    mutationsSincePass: number;
  };
  permissions: {
    sandbox: "active" | "unavailable" | "disabled";
    worker: "workspace-write";
    verify: "source-read-only";
    network: "disabled" | "restricted";
    denials: number;
    approvals: number;
    sandboxFailures: number;
  };
  contextGovernor?: ContextGovernorState;
  ticket?: TicketObservationState;
  autonomy?: AutonomyObservationState;
  runUsage: RunUsageState;
  activity?: ActivityState;
}


export function toSnapshot(state: AiesState): AiesSnapshot {
  return {
    version: STATE_VERSION,
    startedAt: state.session.startedAt,
    lastEventAt: state.session.lastEventAt,
    resumedAt: state.session.resumedAt,
    sessionId: state.session.sessionId,
    sessionFile: state.session.sessionFile,
    stopReason: state.session.stopReason,
    contextTokens: state.context.currentTokens,
    peakContextTokens: state.context.peakTokens,
    contextWindow: state.context.contextWindow,
    peakContextWindow: state.context.peakContextWindow,
    usagePercent: state.context.usagePercent,
    toolCalls: state.tools.calls,
    toolResults: state.tools.results,
    toolErrors: state.tools.errors,
    toolCallsByName: { ...state.tools.callsByName },
    filesInspected: [...state.exploration.filesInspected],
    sourceReads: state.exploration.sourceReads,
    searchCalls: state.exploration.searches,
    shellInspections: state.exploration.shellInspections,
    outputChars: state.exploration.outputChars,
    largestOutputChars: state.exploration.largestOutputChars,
    compactionCount: state.compactionCount,
    activeToolCount: state.activeToolCount,
    model: state.model ? { ...state.model } : undefined,
    delegations: {
      total: state.delegations.total,
      byRole: { ...state.delegations.byRole },
      byOutcome: { ...state.delegations.byOutcome },
      activeRole: state.delegations.activeRole,
      activeStartedAt: state.delegations.activeStartedAt,
      activeTask: state.delegations.activeTask,
      lastOutcome: state.delegations.lastOutcome,
      lastDurationMs: state.delegations.lastDurationMs,
    },
    verification: { ...state.verification },
    permissions: { ...state.permissions },
    contextGovernor: { ...state.contextGovernor },
    ticket: state.ticket.active ? { ...state.ticket } : undefined,
    autonomy: state.autonomy ? { ...state.autonomy } : undefined,
    runUsage: {
      baseline: state.runUsage.baseline ? { ...state.runUsage.baseline } : null,
      main: { ...state.runUsage.main },
      agents: { ...state.runUsage.agents },
      total: { ...state.runUsage.total },
      active: state.runUsage.active,
      startedAt: state.runUsage.startedAt,
    },
    activity: state.activity ? { ...state.activity } : undefined,
  };
}


/**
 * Rebuild state from a persisted shape, keeping only what is understood. A Pi
 * session is append-only, so several snapshots can describe one session and the
 * newest one is the truth. `fallbackStartedAt` covers an older shape without a
 * timestamp. An unreadable payload degrades to an empty state, never a throw.
 */
export function fromSnapshot(value: unknown, fallbackStartedAt: number): AiesState {
  const source = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  const state = createState(positive(source.startedAt) ?? fallbackStartedAt);

  state.session.lastEventAt = positive(source.lastEventAt) ?? state.session.startedAt;
  state.session.resumedAt = positive(source.resumedAt) ?? undefined;
  state.session.sessionId = text(source.sessionId);
  state.session.sessionFile = text(source.sessionFile);
  state.session.stopReason = text(source.stopReason);

  const tokens = positive(source.contextTokens);
  state.context.currentTokens = tokens;
  state.context.peakTokens = positive(source.peakContextTokens) ?? tokens ?? 0;
  state.context.contextWindow = positive(source.contextWindow) ?? 0;
  state.context.peakContextWindow = positive(source.peakContextWindow) ?? state.context.contextWindow;
  state.context.usagePercent = typeof source.usagePercent === "number" && Number.isFinite(source.usagePercent) ? source.usagePercent : null;

  state.tools.calls = positive(source.toolCalls) ?? 0;
  state.tools.results = positive(source.toolResults) ?? 0;
  state.tools.errors = positive(source.toolErrors) ?? 0;
  state.tools.callsByName = countMap(source.toolCallsByName);

  const rawDelegations = (source.delegations && typeof source.delegations === "object" && !Array.isArray(source.delegations)
    ? source.delegations
    : {}) as Record<string, unknown>;
  state.delegations = {
    total: positive(rawDelegations.total) ?? 0,
    byRole: countMap(rawDelegations.byRole),
    byOutcome: countMap(rawDelegations.byOutcome),
    activeRole: text(rawDelegations.activeRole),
    activeStartedAt: positive(rawDelegations.activeStartedAt) ?? undefined,
    activeTask: text(rawDelegations.activeTask),
    lastOutcome: text(rawDelegations.lastOutcome),
    lastDurationMs: positive(rawDelegations.lastDurationMs) ?? undefined,
  };

  const rawVerification = (source.verification && typeof source.verification === "object" && !Array.isArray(source.verification)
    ? source.verification
    : {}) as Record<string, unknown>;
  state.verification = {
    status:
      rawVerification.status === "pass" || rawVerification.status === "fail" || rawVerification.status === "blocked" || rawVerification.status === "protocol_error"
        ? rawVerification.status
        : "none",
    attempts: positive(rawVerification.attempts) ?? 0,
    repairs: positive(rawVerification.repairs) ?? 0,
    maxRepairs: positive(rawVerification.maxRepairs) ?? 0,
    valid: rawVerification.valid === true,
    awaiting: rawVerification.awaiting === true,
    lastDurationMs: positive(rawVerification.lastDurationMs) ?? undefined,
    mutationsSincePass: positive(rawVerification.mutationsSincePass) ?? 0,
  };

  const rawPerms = (source.permissions && typeof source.permissions === "object" && !Array.isArray(source.permissions)
    ? source.permissions
    : {}) as Record<string, unknown>;
  state.permissions = {
    sandbox:
      rawPerms.sandbox === "active" || rawPerms.sandbox === "unavailable" || rawPerms.sandbox === "disabled"
        ? rawPerms.sandbox
        : "active",
    worker: "workspace-write",
    verify: "source-read-only",
    network: "disabled",
    denials: positive(rawPerms.denials) ?? 0,
    approvals: positive(rawPerms.approvals) ?? 0,
    sandboxFailures: positive(rawPerms.sandboxFailures) ?? 0,
  };

  state.exploration.filesInspected = stringList(source.filesInspected);
  state.exploration.sourceReads = positive(source.sourceReads) ?? 0;
  state.exploration.searches = positive(source.searchCalls) ?? 0;
  state.exploration.shellInspections = positive(source.shellInspections) ?? 0;
  state.exploration.outputChars = positive(source.outputChars) ?? 0;
  state.exploration.largestOutputChars = positive(source.largestOutputChars) ?? 0;

  state.compactionCount = positive(source.compactionCount) ?? 0;
  state.activeToolCount = positive(source.activeToolCount) ?? 0;
  state.version = positive(source.version) ?? STATE_VERSION;

  const rawGov = (source.contextGovernor && typeof source.contextGovernor === "object" && !Array.isArray(source.contextGovernor)
    ? source.contextGovernor
    : {}) as Record<string, unknown>;
  const validZones = ["green", "amber", "pressure", "compact", "ceiling"];
  state.contextGovernor = {
    zone: typeof rawGov.zone === "string" && validZones.includes(rawGov.zone) ? (rawGov.zone as any) : "green",
    currentTokens: positive(rawGov.currentTokens),
    compactAtTokens: positive(rawGov.compactAtTokens) ?? 120_000,
    ceilingTokens: positive(rawGov.ceilingTokens) ?? 150_000,
    compactPending: rawGov.compactPending === true,
    compacting: rawGov.compacting === true,
    compactionCount: positive(rawGov.compactionCount) ?? state.compactionCount,
    oversizedResults: positive(rawGov.oversizedResults) ?? 0,
    truncatedChars: positive(rawGov.truncatedChars) ?? 0,
    lastCompactionError: text(rawGov.lastCompactionError),
  };

  const model = source.model;
  if (model && typeof model === "object") {
    const entry = model as Record<string, unknown>;
    state.model = applyModel(state, entry).model;
  }

  const rawTicket = (source.ticket && typeof source.ticket === "object" && !Array.isArray(source.ticket)
    ? source.ticket
    : {}) as Record<string, unknown>;
  state.ticket = {
    active: rawTicket.active === true,
    identifier: text(rawTicket.identifier),
    title: text(rawTicket.title),
    status: text(rawTicket.status),
    workState: typeof rawTicket.workState === "string" ? (rawTicket.workState as any) : undefined,
    validVerify: rawTicket.validVerify === true,
  };

  const rawAutonomy = (source.autonomy && typeof source.autonomy === "object" && !Array.isArray(source.autonomy)
    ? source.autonomy
    : undefined) as Record<string, unknown> | undefined;
  if (rawAutonomy) {
    state.autonomy = {
      enabled: rawAutonomy.enabled === true,
      ticketId: text(rawAutonomy.ticketId),
      continuationCount: positive(rawAutonomy.continuationCount) ?? 0,
      stopReason: text(rawAutonomy.stopReason),
      lastStep: text(rawAutonomy.lastStep),
    };
  }

  // Run usage is cumulative session telemetry, so it survives a resume. Child
  // records do NOT: the `agents` projection is intentionally never read back here,
  // so a resumed session cannot resurrect a finished child as if it were live.
  const rawRunUsage = (source.runUsage && typeof source.runUsage === "object" && !Array.isArray(source.runUsage)
    ? source.runUsage
    : undefined) as Record<string, unknown> | undefined;
  if (rawRunUsage) {
    const main = usageBucketOf(rawRunUsage.main) ?? { totalTokens: 0, cost: null };
    const agents = usageBucketOf(rawRunUsage.agents) ?? { totalTokens: 0, cost: 0 };
    const total = usageBucketOf(rawRunUsage.total) ?? {
      totalTokens: main.totalTokens + agents.totalTokens,
      cost: main.cost !== null && agents.cost !== null ? main.cost + agents.cost : null,
    };
    state.runUsage = {
      baseline: usageBucketOf(rawRunUsage.baseline),
      main,
      agents,
      total,
      active: rawRunUsage.active === true,
      startedAt: positive(rawRunUsage.startedAt) ?? undefined,
    };
  }

  const rawActivity = (source.activity && typeof source.activity === "object" && !Array.isArray(source.activity)
    ? source.activity
    : undefined) as Record<string, unknown> | undefined;
  if (rawActivity) {
    const role = text(rawActivity.role);
    const startedAt = positive(rawActivity.startedAt);
    if (role && startedAt !== null) {
      const activity: ActivityState = { role, task: typeof rawActivity.task === "string" ? rawActivity.task : "", startedAt };
      const finishedAt = positive(rawActivity.finishedAt);
      if (finishedAt !== null) activity.finishedAt = finishedAt;
      const outcome = text(rawActivity.outcome);
      if (outcome) activity.outcome = outcome;
      const summary = text(rawActivity.summary);
      if (summary) activity.summary = summary;
      for (const key of ["evidenceCount", "changedFiles", "checksPassed", "checksTotal", "criteriaPassed", "criteriaTotal", "blockingDefects"] as const) {
        const parsed = positive(rawActivity[key]);
        if (parsed !== null) activity[key] = parsed;
      }
      const model = text(rawActivity.model);
      if (model) activity.model = model;
      state.activity = activity;
    }
  }

  return state;
}


export function applyPermissionDenial(state: AiesState): AiesState {
  const next = cloneState(state);
  next.permissions.denials++;
  return next;
}

export function applyApprovalRequest(state: AiesState): AiesState {
  const next = cloneState(state);
  next.permissions.approvals++;
  return next;
}

export function applySandboxFailure(state: AiesState): AiesState {
  const next = cloneState(state);
  next.permissions.sandboxFailures++;
  return next;
}

export function applyPermissionsSync(
  state: AiesState,
  update: {
    sandbox?: "active" | "unavailable" | "disabled";
    denials?: number;
    approvals?: number;
    sandboxFailures?: number;
  },
): AiesState {
  const next = cloneState(state);
  if (update.sandbox) next.permissions.sandbox = update.sandbox;
  if (typeof update.denials === "number") next.permissions.denials = update.denials;
  if (typeof update.approvals === "number") next.permissions.approvals = update.approvals;
  if (typeof update.sandboxFailures === "number") next.permissions.sandboxFailures = update.sandboxFailures;
  return next;
}

export function applyContextGovernorSync(
  state: AiesState,
  update?: Partial<ContextGovernorState>,
): AiesState {
  if (!update) return state;
  const next = cloneState(state);
  next.contextGovernor = {
    ...next.contextGovernor,
    ...update,
  };
  return next;
}

export function applyTicketObservationSync(
  state: AiesState,
  update?: Partial<TicketObservationState>,
): AiesState {
  if (!update) return state;
  const next = cloneState(state);
  next.ticket = {
    ...next.ticket,
    ...update,
  };
  return next;
}

export function applyAutonomySync(
  state: AiesState,
  update?: Partial<AutonomyObservationState>,
): AiesState {
  if (!update) return state;
  const next = cloneState(state);
  next.autonomy = {
    enabled: typeof update.enabled === "boolean" ? update.enabled : (next.autonomy?.enabled ?? false),
    ticketId: update.ticketId !== undefined ? update.ticketId : (next.autonomy?.ticketId ?? null),
    continuationCount: typeof update.continuationCount === "number" ? update.continuationCount : (next.autonomy?.continuationCount ?? 0),
    stopReason: update.stopReason !== undefined ? update.stopReason : (next.autonomy?.stopReason ?? null),
    lastStep: update.lastStep ?? next.autonomy?.lastStep,
  };
  return next;
}


