/**
 * Shared execution runner for isolated child agents (Explore, Worker).
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context (no parent history/sentinel leakage).
 * - Isolated from parent extensions (no metric pollution).
 * - Guaranteed session disposal on completion or failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { AiesThinkingLevel } from "../aies-models/capabilities.ts";
import type {
  AgentObservatory,
  BeginAgentInput,
  FinishAgentInput,
  UsageUpdate,
} from "./observatory.ts";
import type { AgentRole } from "./model.ts";

export interface ChildSessionOptions {
  task: string;
  context?: string;
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  model: any;
  modelRuntime?: any;
  /** Capability-valid thinking level for the child session, when one is configured. */
  thinkingLevel?: AiesThinkingLevel;
  tools: string[];
  customTools?: ToolDefinition[];
  signal?: AbortSignal;
  sessionManager?: any;
  /**
   * Session-local presentation registry. When supplied together with `agentId`,
   * the child session is observed through exactly one event listener. It never
   * routes, authorizes or changes what the child does.
   */
  observatory?: AgentObservatory;
  /** The record id returned by `observatory.begin`, when observation is active. */
  agentId?: string;
  /**
   * The role whose `agents.<role>` limits in aies.json apply. Without it only the
   * environment and the defaults apply.
   */
  role?: AgentRole;
  /** Explicit limits. They override the environment, aies.json and the defaults. */
  limits?: Partial<ChildLimits>;
  /** Test seam: builds the child session instead of Pi's `createAgentSession`. */
  sessionFactory?: (options: any) => Promise<{ session: any }>;
}

/** Why a child run was stopped before it completed on its own. */
export type ChildStopReason = "cancelled" | "timeout" | "max_turns";

/**
 * Raised when the parent's signal, the total timeout or the turn limit stops a
 * child run. Runners turn it into a failed handoff; it is never a verdict.
 */
export class ChildSessionStoppedError extends Error {
  readonly reason: ChildStopReason;

  constructor(reason: ChildStopReason, message: string) {
    super(message);
    this.name = "ChildSessionStoppedError";
    this.reason = reason;
  }
}

/** The budget of one child run. */
export interface ChildLimits {
  /** Total wall-clock budget for the run, in milliseconds. */
  timeoutMs: number;
  /** Maximum number of turns (LLM round trips) the child may start. */
  maxTurns: number;
}

/**
 * Total wall-clock budget per child run: 100 minutes. Calibrated from dogfooding:
 * the longest recorded child run was about 33 minutes (Verify, EZE-488), and 3x
 * that is 99 minutes. Explore and Worker durations were never recorded on their
 * own, so this value applies to them too. A calibrar.
 */
export const DEFAULT_CHILD_TIMEOUT_MS = 100 * 60 * 1000;

/**
 * Turn limit per child run. Dogfooding never recorded turn or tool-call counts, so
 * there is no measured basis; 100 is a generous ceiling. A calibrar.
 */
export const DEFAULT_CHILD_MAX_TURNS = 100;

/** A positive safe integer from a number or a numeric string; anything else is `undefined`. */
function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && /^\d+$/u.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Resolve the budget of one child run. Order: environment (`AIES_CHILD_TIMEOUT_MS`,
 * `AIES_CHILD_MAX_TURNS`), then `$AIES_AGENT_DIR/aies.json` (`agents.<role>.timeoutMs`,
 * `agents.<role>.maxTurns`), then the defaults. Invalid values fall through to the
 * next layer.
 */
export function resolveChildLimits(
  role: AgentRole | undefined,
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ChildLimits {
  let config: { timeoutMs?: unknown; maxTurns?: unknown } = {};
  const configPath = join(agentDir, "aies.json");
  if (role && existsSync(configPath)) {
    try {
      const content = JSON.parse(readFileSync(configPath, "utf8"));
      config = content?.agents?.[role] ?? {};
    } catch {
      config = {};
    }
  }

  return {
    timeoutMs:
      parsePositiveInteger(env.AIES_CHILD_TIMEOUT_MS) ??
      parsePositiveInteger(config.timeoutMs) ??
      DEFAULT_CHILD_TIMEOUT_MS,
    maxTurns:
      parsePositiveInteger(env.AIES_CHILD_MAX_TURNS) ??
      parsePositiveInteger(config.maxTurns) ??
      DEFAULT_CHILD_MAX_TURNS,
  };
}

/** The event fields the observatory reads; every other field is ignored. */
export interface ObservableChildEvent {
  type?: unknown;
  toolName?: unknown;
  args?: unknown;
}

/** The minimal AgentSession surface the observatory needs, so a fake can implement it. */
export interface ObservableChildSession {
  subscribe(listener: (event: ObservableChildEvent) => void): () => void;
  getSessionStats(): unknown;
  /** Optional: the child's own context occupancy, as Pi reports it. */
  getContextUsage?(): unknown;
}

import { isSubscriptionOrPlan, observableCost } from "../aies-ui/format.ts";

/**
 * How the child's cost is billed, read passively from the public ModelRuntime API.
 * `isUsingSubscription(provider)` (an OAuth credential of a provider that declares
 * `isSubscription`) means a subscription, so the amount Pi reports is an
 * API-equivalent estimate. A plan provider recognised by `isSubscriptionOrPlan` is
 * also a subscription: that is a heuristic on the provider id (never the model id)
 * that predates this probe. OAuth without a declared subscription (for example a
 * free tier) is not classified (`null`), and no OAuth means `api`. `null` is also the
 * answer when a probe is unavailable, returns a non-boolean or throws.
 */
export function probeChildBilling(
  runtime: unknown,
  model?: { provider?: unknown },
): "subscription" | "api" | null {
  try {
    const provider = typeof model?.provider === "string" ? model.provider : undefined;
    if (provider && isSubscriptionOrPlan(provider)) return "subscription";
    const api = runtime as { isUsingSubscription?: unknown; isUsingOAuth?: unknown } | undefined;
    if (!provider || typeof api?.isUsingSubscription !== "function") return null;
    const subscription: unknown = api.isUsingSubscription.call(runtime, provider);
    if (typeof subscription !== "boolean") return null;
    if (subscription) return "subscription";
    if (typeof api.isUsingOAuth !== "function") return null;
    const oauth: unknown = api.isUsingOAuth.call(runtime, provider);
    if (typeof oauth !== "boolean") return null;
    return oauth ? null : "api";
  } catch {
    return null;
  }
}

/** The lifecycle boundaries that sample the child's own usage once. */
const USAGE_EVENT_TYPES = new Set(["turn_end", "agent_settled", "agent_end"]);

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Read the real usage fields off `SessionStats`: the token breakdown and `cost`. */
function readChildUsage(
  stats: unknown,
  model?: { id?: string; provider?: string },
): UsageUpdate {
  const record = (stats ?? {}) as {
    tokens?: { total?: unknown; input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
    cost?: unknown;
  };
  const tokens = record.tokens;
  const total = tokens?.total;
  const rawCost = typeof record.cost === "number" && Number.isFinite(record.cost) ? record.cost : null;
  return {
    totalTokens: typeof total === "number" && Number.isFinite(total) ? total : 0,
    cost: observableCost(rawCost, model?.id, model?.provider),
    inputTokens: finiteOrNull(tokens?.input),
    outputTokens: finiteOrNull(tokens?.output),
    cacheReadTokens: finiteOrNull(tokens?.cacheRead),
    cacheWriteTokens: finiteOrNull(tokens?.cacheWrite),
  };
}

/**
 * The child's context occupancy exactly as `getContextUsage()` reports it. A
 * `null` field (for example the tokens right after a compaction) stays `null`;
 * nothing is ever derived from the accumulated token totals.
 */
function readChildContext(usage: unknown): UsageUpdate {
  // Anything that is not an object is an unknown reading: all three fields go null.
  if (!usage || typeof usage !== "object") {
    return { contextTokens: null, contextWindow: null, contextPercent: null };
  }
  const record = usage as { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
  return {
    contextTokens: finiteOrNull(record.tokens),
    contextWindow: finiteOrNull(record.contextWindow),
    contextPercent: finiteOrNull(record.percent),
  };
}

/**
 * Attach exactly one event-driven listener to a child session and return its
 * unsubscribe function. Tool lifecycle starts become mechanical activities;
 * turn end / agent settled / agent end sample the child's own stats and context
 * usage. Every read is guarded on its own, so a broken observer, a failing
 * metric or a session that no longer answers can never fail the child run, and a
 * failing context read never discards a good stats sample. No timer and no
 * polling are used.
 */
export function attachChildObservatory(
  session: ObservableChildSession,
  observatory: Pick<AgentObservatory, "observe" | "updateUsage">,
  agentId: string,
  model?: { id?: string; provider?: string },
): () => void {
  const listener = (event: ObservableChildEvent): void => {
    try {
      if (event?.type === "tool_execution_start") {
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        const args =
          event.args && typeof event.args === "object" ? (event.args as Record<string, unknown>) : {};
        observatory.observe(agentId, toolName, args, Date.now());
        return;
      }
      if (typeof event?.type === "string" && USAGE_EVENT_TYPES.has(event.type)) {
        const sample: UsageUpdate = {};
        try {
          Object.assign(sample, readChildUsage(session.getSessionStats(), model));
        } catch {
          // Stats are best effort: the previous sample stays.
        }
        // A context read that is absent, throws or answers nothing usable is an
        // unknown context (null), never the previous reading presented as current.
        try {
          Object.assign(
            sample,
            readChildContext(typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined),
          );
        } catch {
          Object.assign(sample, readChildContext(undefined));
        }
        if (Object.keys(sample).length > 0) observatory.updateUsage(agentId, sample);
      }
    } catch {
      // Observation is presentation only: it must never fail the child run.
    }
  };

  try {
    return session.subscribe(listener);
  } catch {
    return () => {};
  }
}

/** Project a resolved model into the registry's presentation identity. */
export function projectModelIdentity(model: any): {
  modelId: string | null;
  modelLabel: string | null;
  providerId: string | null;
} {
  const modelId = typeof model?.id === "string" && model.id ? model.id : null;
  const modelLabel = typeof model?.name === "string" && model.name ? model.name : modelId;
  const providerId = typeof model?.provider === "string" && model.provider ? model.provider : null;
  return { modelId, modelLabel, providerId };
}

/** Open a record without ever failing a run on a broken observer. */
export function beginChildObservation(
  observatory: AgentObservatory | undefined,
  input: BeginAgentInput,
): string | undefined {
  if (!observatory) return undefined;
  try {
    return observatory.begin(input);
  } catch {
    return undefined;
  }
}

/** Close a record without ever failing a run on a broken observer. */
export function finishChildObservation(
  observatory: AgentObservatory | undefined,
  agentId: string | undefined,
  input: FinishAgentInput,
): void {
  if (!observatory || !agentId) return;
  try {
    observatory.finish(agentId, input);
  } catch {
    // Presentation only.
  }
}

/**
 * Resolve system prompt for a role from agentDir or repo fallback.
 */
export function resolveRoleSystemPrompt(
  role: AgentRole,
  agentDir: string,
  override?: string,
): string {
  if (override) return override;

  const candidatePaths = [
    join(agentDir, "agents", `${role}.md`),
    fileURLToPath(new URL(`../../agents/${role}.md`, import.meta.url)),
  ];

  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        // Continue to fallback
      }
    }
  }

  if (role === "worker") {
    return "You are an isolated worker agent. Implement the assigned work unit and conclude with structured JSON.";
  }

  if (role === "verify") {
    return "You are an isolated verification agent. Inspect the real repository state against the acceptance criteria and conclude with structured JSON.";
  }

  return "You are an isolated read-only explore agent. Investigate the codebase and conclude with structured JSON.";
}

/**
 * Whether a value is a real session `ModelRuntime` rather than the extension's
 * synchronous `ModelRegistry` facade. Only a genuine runtime may be handed to
 * `createAgentSession`; a registry is a resolution source only.
 */
export function isSessionModelRuntime(value: any): boolean {
  return Boolean(value) && typeof value.getAuth === "function" && typeof value.streamSimple === "function";
}

/**
 * Whether a value is the public extension `ModelRegistry` facade: a resolution
 * source that exposes the registered-provider config surface but is not itself a
 * session runtime.
 */
export function isSessionModelRegistry(value: any): boolean {
  return (
    Boolean(value) &&
    !isSessionModelRuntime(value) &&
    typeof value.getRegisteredProviderConfig === "function"
  );
}

/**
 * Build the isolated child `ModelRuntime` when the parent delegated through its
 * public `ModelRegistry` facade and that facade registered the provider the
 * selected child model belongs to (EZE-454).
 *
 * The runtime is built by the public API with the child's own `agentDir` auth and
 * models files, so a stored credential stays readable and `models.json` still
 * applies, and only the one provider config the facade exposes is copied. Child
 * extensions and skills still never load: the resource loader keeps
 * `noExtensions`/`noSkills`, and this runtime only knows the model it was handed.
 *
 * Returns `undefined` when no registered provider config matches, so a facade for
 * a built-in or `models.json` provider keeps Pi's own default child runtime.
 */
export async function createChildModelRuntime(
  agentDir: string,
  model: any,
  registry: any,
): Promise<ModelRuntime | undefined> {
  if (!isSessionModelRegistry(registry)) return undefined;

  const providerId =
    typeof model?.provider === "string" && model.provider ? model.provider : undefined;
  if (!providerId) return undefined;

  let config: any;
  let nativeProvider: any;
  try {
    config = registry.getRegisteredProviderConfig(providerId);
    if (!config && typeof registry.getRegisteredNativeProvider === "function") {
      nativeProvider = registry.getRegisteredNativeProvider(providerId);
    }
  } catch {
    return undefined;
  }
  if (!config && !nativeProvider) return undefined;

  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  if (config) runtime.registerProvider(providerId, config);
  else runtime.registerNativeProvider(nativeProvider);
  return runtime;
}

/**
 * Run one prompt under the parent's signal, the total timeout and the turn limit.
 *
 * The first stop wins: it rejects the run at once and asks the child to abort. It
 * does not wait for the abort to settle, because Pi's `abort()` waits for an idle
 * agent that a hung child never reaches. Listeners, the timer and the event
 * subscription are always retired.
 */
async function promptWithLimits(
  session: any,
  promptText: string,
  controls: { signal?: AbortSignal; limits: ChildLimits },
): Promise<void> {
  const { signal, limits } = controls;
  if (signal?.aborted) {
    throw new ChildSessionStoppedError("cancelled", "Child agent cancelled by the user before starting");
  }

  let stopped: ChildSessionStoppedError | undefined;
  let rejectStop: (error: ChildSessionStoppedError) => void = () => {};
  const stopSignal = new Promise<never>((_resolve, reject) => {
    rejectStop = reject;
  });
  // The stop may win the race while the prompt is still pending; never leave it unhandled.
  stopSignal.catch(() => {});

  const stop = (reason: ChildStopReason, message: string): void => {
    if (stopped) return;
    stopped = new ChildSessionStoppedError(reason, message);
    rejectStop(stopped);
    try {
      Promise.resolve(session.abort()).catch(() => {});
    } catch {
      // A session that cannot abort still loses the race above.
    }
  };

  const onAbort = (): void => {
    stop("cancelled", "Child agent cancelled by the user before completing");
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    stop("timeout", `Child agent timed out after ${limits.timeoutMs} ms (total timeout)`);
  }, limits.timeoutMs);

  let turns = 0;
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = session.subscribe((event: { type?: unknown }) => {
      if (event?.type !== "turn_start") return;
      turns += 1;
      if (turns > limits.maxTurns) {
        stop("max_turns", `Child agent exceeded the turn limit of ${limits.maxTurns} turns`);
      }
    });

    const running = Promise.resolve(session.prompt(promptText));
    running.catch(() => {});
    await Promise.race([running, stopSignal]);
    if (stopped) throw stopped;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      unsubscribe?.();
    } catch {
      // Unsubscribe errors must not mask execution results
    }
  }
}

/**
 * Execute an isolated child AgentSession turn and return the assistant's final text.
 *
 * A run stopped by the parent's signal, the total timeout or the turn limit throws
 * `ChildSessionStoppedError` (with `reason`) after the child has been aborted. The
 * session is always disposed.
 */
export async function executeChildSession(options: ChildSessionOptions): Promise<string> {
  const {
    task,
    context,
    cwd,
    agentDir,
    systemPrompt,
    model,
    modelRuntime,
    thinkingLevel,
    tools,
    customTools = [],
    signal,
    sessionManager: customSessionManager,
    observatory,
    agentId,
    role,
    sessionFactory,
  } = options;

  const configured = resolveChildLimits(role, agentDir);
  const limits: ChildLimits = {
    timeoutMs: options.limits?.timeoutMs ?? configured.timeoutMs,
    maxTurns: options.limits?.maxTurns ?? configured.maxTurns,
  };

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
  });
  await resourceLoader.reload();

  const sessionManager = customSessionManager ?? SessionManager.inMemory(cwd);

  // A genuine runtime is used untouched. A public `ModelRegistry` facade is a
  // resolution source that a child runtime cannot authenticate an
  // extension-registered provider with, so the child gets its own isolated
  // runtime carrying exactly the selected model's registered provider config.
  const childRuntime = isSessionModelRuntime(modelRuntime)
    ? modelRuntime
    : await createChildModelRuntime(agentDir, model, modelRuntime);

  const createSession: (options: any) => Promise<{ session: any }> = sessionFactory ?? createAgentSession;
  const { session } = await createSession({
    cwd,
    agentDir,
    model,
    modelRuntime: childRuntime,
    thinkingLevel,
    resourceLoader,
    sessionManager,
    customTools,
    tools,
  });

  if (observatory && agentId) {
    try {
      observatory.updateUsage(agentId, { billing: probeChildBilling(childRuntime, model) });
    } catch {
      // Billing is presentation only.
    }
  }

  const unsubscribe =
    observatory && agentId ? attachChildObservatory(session, observatory, agentId, model) : undefined;

  let promptText = `TASK: ${task}`;
  if (context && context.trim()) {
    promptText += `\n\nCONTEXT:\n${context.trim()}`;
  }

  try {
    await promptWithLimits(session, promptText, { signal, limits });
    return session.getLastAssistantText() ?? "";
  } finally {
    try {
      unsubscribe?.();
    } catch {
      // Unsubscribe errors must not mask execution results
    }
    try {
      session.dispose();
    } catch {
      // Dispose errors must not mask execution results
    }
  }
}
