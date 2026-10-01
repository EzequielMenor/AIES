/**
 * Session-local Agent Observatory registry (AIES-010C).
 *
 * Pure presentation state for the AIES workflow. The registry observes child
 * agents; it never routes, authorizes, persists, retries or changes their
 * prompts. It holds no transcript, no reasoning and no authority, and it imports
 * nothing: no Pi, no filesystem, no clock of its own.
 *
 * Activity wording is mechanical — a Spanish verb derived from the tool name and
 * its argument (`Leyendo`, `Buscando`, `Editando`, `Ejecutando`, `Comprobando`) —
 * so a child can never narrate into the UI. Callers pass explicit timestamps.
 */

/** Where a child is in its own lifecycle. */
export type AgentStatus = "running" | "completed" | "failed" | "blocked";

/** How many mechanical activity entries a record keeps. */
export const MAX_ACTIVITIES = 5;

/**
 * The stable `pi.events` channel that carries observatory snapshots between
 * extensions. Pi loads each extension through its own module registry, so the
 * `observatory` singleton below is **not** shared across an extension boundary;
 * this channel is the documented inter-extension wire replacement for it.
 */
export const AGENTS_CHANNEL = "aies:agents";

const ACTIVITY_TEXT_MAX = 80;
const COMMAND_MAX = 60;
const RESULT_MAX = 160;
const PATH_SEGMENTS = 2;

/** One mechanically worded tool event. */
export interface AgentActivity {
  tool: string;
  text: string;
  at: number;
}

/** One observed child. A snapshot freezes every field, array and entry. */
export interface AgentRecord {
  id: string;
  role: string;
  status: AgentStatus;
  startedAt: number;
  finishedAt: number | null;
  modelId: string | null;
  modelLabel: string | null;
  providerId: string | null;
  providerLabel: string | null;
  currentActivity: string | null;
  totalTokens: number;
  cost: number | null;
  toolCount: number;
  changedPaths: string[];
  activities: AgentActivity[];
  result: string | null;
}

/** A snapshot is the immutable projection the UI renders. */
export type ObservatorySnapshot = readonly AgentRecord[];

/** A subscriber is notified with a fresh immutable snapshot on every mutation. */
export type ObservatoryListener = (snapshot: ObservatorySnapshot) => void;

export interface BeginAgentInput {
  role: string;
  modelId?: string | null;
  modelLabel?: string | null;
  providerId?: string | null;
  providerLabel?: string | null;
  /** Explicit start timestamp; the caller owns the clock. */
  at?: number;
}

export interface FinishAgentInput {
  status?: Exclude<AgentStatus, "running">;
  result?: string | null;
  /** Paths observed, modified or relevant to this child run. */
  paths?: readonly string[];
  /** Explicit finish timestamp; the caller owns the clock. */
  at?: number;
}

export interface UsageUpdate {
  totalTokens?: number | null;
  cost?: number | null;
}

const PATH_KEYS = ["path", "filePath", "file_path"] as const;

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function timestampOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  if (flat.length <= max) return flat;
  if (max <= 1) return max === 1 ? "…" : "";
  return `${flat.slice(0, max - 1)}…`;
}

function argString(args: Record<string, unknown> | null | undefined, keys: readonly string[]): string {
  if (!args) return "";
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

function pathArg(args: Record<string, unknown> | null | undefined): string {
  return argString(args, PATH_KEYS);
}

/**
 * The safe short form of a path: backslashes normalised, whitespace collapsed and
 * only the last two segments kept, so an absolute home prefix never reaches the UI.
 */
export function shortPath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const flat = raw.replace(/\\/gu, "/").replace(/\s+/gu, " ").trim();
  if (!flat) return "";
  const segments = flat
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== ".");
  if (!segments.length) return "";
  return segments.slice(-PATH_SEGMENTS).join("/");
}

/** The first non-empty command line, collapsed and bounded; a multi-line command never leaks through. */
export function firstCommandLine(command: unknown): string {
  if (typeof command !== "string") return "";
  const firstLine = command.split(/\r?\n/u).find((line) => line.trim()) ?? "";
  return clipText(firstLine, COMMAND_MAX);
}

/** Classify a bash command line into a safe, human Spanish category. */
export function classifyBashCommand(command: string): string {
  const flat = command.toLowerCase();

  // Test execution
  if (
    /\b(npm\s+(?:run\s+)?test|node\s+--test|pnpm\s+(?:run\s+)?test|yarn\s+test|bun\s+test|pytest|vitest|jest|cargo\s+test|go\s+test)\b/u.test(
      flat,
    )
  ) {
    return "Ejecutando tests";
  }

  // Git state inspection
  if (/\bgit\s+(?:status|diff|log|show|branch|check)\b/u.test(flat)) {
    return "Comprobando estado Git";
  }

  // Fixture preparation
  if (/\bfixtures?\b/u.test(flat) && (/\b(mkdir|touch|cp|echo|cat|printf)\b/u.test(flat) || />/u.test(flat))) {
    return "Preparando fixture";
  }

  // File modification
  if (
    /\b(sed|awk|patch|cp|mv|rm|touch)\b/u.test(flat) ||
    /(?:>>?)\s*[^&|;\s]+/u.test(flat)
  ) {
    return "Modificando archivos";
  }

  // File reading
  if (/\b(cat|head|tail|less|more|bat|xxd)\b/u.test(flat)) {
    return "Leyendo archivos";
  }

  // Searching references
  if (/\b(grep|rg|ripgrep|ag|find|locate|fd)\b/u.test(flat)) {
    return "Buscando referencias";
  }

  return "Ejecutando comando";
}

/**
 * Derive the Spanish activity text from the tool and its argument. The result is
 * always one bounded line and never child-authored prose.
 */
export function describeActivity(
  toolName: unknown,
  args?: Record<string, unknown> | null,
): string | null {
  const tool = typeof toolName === "string" ? toolName.trim() : "";
  if (!tool) return null;

  const path = shortPath(pathArg(args));
  const command = firstCommandLine(argString(args, ["command"]));
  const pattern = clipText(argString(args, ["pattern"]), COMMAND_MAX);

  switch (tool) {
    case "read":
      return path ? `Leyendo ${path}` : "Leyendo archivos";
    case "grep":
      return path ? `Buscando ${path}` : pattern ? `Buscando ${pattern}` : "Buscando referencias";
    case "find":
      return path ? `Buscando ${path}` : "Buscando referencias";
    case "ls":
      return path && path !== "." ? `Listando ${path}` : "Consultando archivo";
    case "edit":
    case "write":
      return path ? `Editando ${path}` : "Modificando archivos";
    case "bash":
      return command ? classifyBashCommand(command) : "Ejecutando comando";
    case "aies_verify_complete":
      return "Comprobando el veredicto";
    default:
      return "Ejecutando comando";
  }
}

/** The mutated path of an edit or write, normalised; any other tool mutates nothing observable. */
export function changedPathOf(
  toolName: unknown,
  args?: Record<string, unknown> | null,
): string | null {
  const tool = typeof toolName === "string" ? toolName.trim() : "";
  if (tool !== "edit" && tool !== "write") return null;
  const raw = pathArg(args).replace(/\\/gu, "/").replace(/\s+/gu, " ").trim().replace(/^\.\//u, "");
  return raw || null;
}

function freezeRecord(record: AgentRecord): AgentRecord {
  const activities = Object.freeze(record.activities.map((activity) => Object.freeze({ ...activity })));
  const changedPaths = Object.freeze([...record.changedPaths]);
  return Object.freeze({ ...record, activities, changedPaths }) as AgentRecord;
}

/**
 * One observatory per Parent session. Ordinals are per role, so a role keeps a
 * stable `<role>-<ordinal>` sequence within the run.
 */
export class AgentObservatory {
  private records: AgentRecord[] = [];
  private ordinals = new Map<string, number>();
  private listeners = new Set<ObservatoryListener>();

  /** Clear the run. Subscribers stay attached; ordinals restart with the session. */
  reset(): void {
    this.records = [];
    this.ordinals.clear();
    this.emit();
  }

  /** Open a running record and return its stable id. */
  begin(input: BeginAgentInput): string {
    const role = stringOrNull(input?.role) ?? "agent";
    const ordinal = (this.ordinals.get(role) ?? 0) + 1;
    this.ordinals.set(role, ordinal);
    const id = `${role}-${ordinal}`;

    const modelId = stringOrNull(input?.modelId);
    const providerId = stringOrNull(input?.providerId);

    this.records.push({
      id,
      role,
      status: "running",
      startedAt: timestampOf(input?.at),
      finishedAt: null,
      modelId,
      modelLabel: stringOrNull(input?.modelLabel) ?? modelId,
      providerId,
      providerLabel: stringOrNull(input?.providerLabel) ?? providerId,
      currentActivity: null,
      totalTokens: 0,
      cost: null,
      toolCount: 0,
      changedPaths: [],
      activities: [],
      result: null,
    });

    this.emit();
    return id;
  }

  /** Record one observed tool call: count, mechanical wording, activity ring and changed paths. */
  observe(
    id: string,
    toolName: string,
    args?: Record<string, unknown> | null,
    at?: number,
  ): void {
    const record = this.find(id);
    if (!record) return;

    const tool = typeof toolName === "string" ? toolName.trim() : "";
    record.toolCount += 1;

    const text = describeActivity(tool, args);
    if (text) {
      record.currentActivity = text;
      record.activities.unshift({ tool: tool || "unknown", text, at: timestampOf(at) });
      if (record.activities.length > MAX_ACTIVITIES) record.activities.length = MAX_ACTIVITIES;
    }

    const changed = changedPathOf(tool, args);
    if (changed && !record.changedPaths.includes(changed)) record.changedPaths.push(changed);

    this.emit();
  }

  /** Replace the observed usage sample. An absent field keeps the previous value. */
  updateUsage(id: string, usage: UsageUpdate | null | undefined): void {
    const record = this.find(id);
    if (!record || !usage) return;

    if ("totalTokens" in usage) {
      record.totalTokens =
        typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
          ? usage.totalTokens
          : 0;
    }
    if ("cost" in usage) {
      record.cost =
        typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
    }

    this.emit();
  }

  /** Close a record with its outcome and a compact, single-line result. */
  finish(id: string, input: FinishAgentInput = {}): void {
    const record = this.find(id);
    if (!record) return;

    const status = input.status;
    record.status = status === "failed" || status === "blocked" || status === "completed" ? status : "completed";
    record.finishedAt = timestampOf(input.at);
    record.result = input.result == null ? null : clipText(String(input.result), RESULT_MAX) || null;
    record.currentActivity = null;

    if (Array.isArray(input.paths)) {
      for (const p of input.paths) {
        if (typeof p === "string" && p.trim()) {
          const normalized = p.trim().replace(/\\/gu, "/").replace(/^\.\//u, "");
          if (!record.changedPaths.includes(normalized)) {
            record.changedPaths.push(normalized);
          }
        }
      }
    }

    this.emit();
  }

  /** The immutable projection: a fresh frozen copy that cannot corrupt the registry. */
  snapshot(): ObservatorySnapshot {
    return Object.freeze(this.records.map(freezeRecord));
  }

  /** Register a listener and return its unsubscribe function. */
  subscribe(listener: ObservatoryListener): () => void {
    if (typeof listener === "function") this.listeners.add(listener);
    return () => this.unsubscribe(listener);
  }

  /** Remove a previously registered listener. */
  unsubscribe(listener: ObservatoryListener): void {
    this.listeners.delete(listener);
  }

  private find(id: string): AgentRecord | undefined {
    return this.records.find((record) => record.id === id);
  }

  private emit(): void {
    if (!this.listeners.size) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A broken listener never breaks the registry or the run.
      }
    }
  }
}

/** The session-local singleton the extension observes through. */
export const observatory = new AgentObservatory();
