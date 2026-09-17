/**
 * Session metrics for the AIES runtime observer (AIES-002).
 *
 * Pure by construction: no Pi import, no I/O, no timers, no decisions. `index.ts`
 * feeds it Pi events, `status.ts` renders what comes out, and the tests drive it
 * directly. This phase measures and never governs: nothing here can block a tool
 * call, change routing or trigger compaction.
 */

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
  lastOutcome: string | undefined;
  lastDurationMs: number | undefined;
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

/** Everything AIES measures about one parent session. */
export interface AiesState {
  version: number;
  session: SessionState;
  context: ContextState;
  tools: ToolsState;
  delegations: DelegationsState;
  exploration: ExplorationState;
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
      lastOutcome: undefined,
      lastDurationMs: undefined,
    },
    exploration: {
      filesInspected: [],
      sourceReads: 0,
      searches: 0,
      shellInspections: 0,
      outputChars: 0,
      largestOutputChars: 0,
    },
    compactionCount: 0,
    activeToolCount: 0,
    model: undefined,
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
    exploration: { ...state.exploration, filesInspected: [...state.exploration.filesInspected] },
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

/** Record the start of a child agent delegation. */
export function applyDelegationStart(state: AiesState, role: string, now: number): AiesState {
  const next = cloneState(state);
  next.delegations.total += 1;
  next.delegations.byRole[role] = (next.delegations.byRole[role] ?? 0) + 1;
  next.delegations.activeRole = role;
  next.delegations.activeStartedAt = now;
  next.session.lastEventAt = now;
  return next;
}

/** Record the completion or settlement of a child agent delegation. */
export function applyDelegationEnd(state: AiesState, outcome: string, now: number): AiesState {
  const next = cloneState(state);
  next.delegations.lastDurationMs = state.delegations.activeStartedAt
    ? Math.max(0, now - state.delegations.activeStartedAt)
    : undefined;
  next.delegations.activeRole = undefined;
  next.delegations.activeStartedAt = undefined;
  next.delegations.lastOutcome = outcome;
  next.delegations.byOutcome[outcome] = (next.delegations.byOutcome[outcome] ?? 0) + 1;
  next.session.lastEventAt = now;
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
    lastOutcome: string | undefined;
    lastDurationMs: number | undefined;
  };
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
      lastOutcome: state.delegations.lastOutcome,
      lastDurationMs: state.delegations.lastDurationMs,
    },
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
    lastOutcome: text(rawDelegations.lastOutcome),
    lastDurationMs: positive(rawDelegations.lastDurationMs) ?? undefined,
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

  const model = source.model;
  if (model && typeof model === "object") {
    const entry = model as Record<string, unknown>;
    state.model = applyModel(state, entry).model;
  }

  return state;
}
