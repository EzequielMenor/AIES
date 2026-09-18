/**
 * Context Governor for the AIES Parent session (AIES-007).
 *
 * Single conceptual authority responsible for parent context health:
 * 1. Context budgets & zone calculation (green, amber, pressure, compact, ceiling).
 * 2. Adaptive scaling to provider contextWindow.
 * 3. Proactive compaction coordination at safe boundaries (agent_settled).
 * 4. Single-flight asynchronous compaction with callback promise wrapping.
 * 5. Safe failure handling without infinite loops or session termination.
 * 6. Tool-output hygiene: classification and head+tail truncation of oversized outputs.
 * 7. Preservation of child delegation handoffs, verification state, and permissions.
 * 8. Strict operational ceiling: blocks direct heavy work while keeping delegation available.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompactionResult, ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ContextZone = "green" | "amber" | "pressure" | "compact" | "ceiling";

export interface ContextBudgets {
  targetTokens: number;   // AMBER threshold: >= targetTokens
  pressureTokens: number; // PRESSURE threshold: >= pressureTokens
  compactTokens: number;  // COMPACT threshold: >= compactTokens
  ceilingTokens: number;  // CEILING threshold: >= ceilingTokens
}

export interface OutputLimits {
  largeOutputChars: number;
  oversizedOutputChars: number;
  headChars: number;
  tailChars: number;
}

export interface ContextGovernorConfig {
  targetTokens?: number;
  pressureTokens?: number;
  compactTokens?: number;
  ceilingTokens?: number;
  largeOutputChars?: number;
  oversizedOutputChars?: number;
  headChars?: number;
  tailChars?: number;
}

export interface ContextGovernorTelemetry {
  zone: ContextZone;
  currentTokens: number | null;
  contextWindow: number;
  compactAtTokens: number;
  ceilingTokens: number;
  compactPending: boolean;
  compacting: boolean;
  compactionCount: number;
  lastCompactionAt?: number;
  lastCompactionError?: string;
  compactionFailures: number;
  consecutiveCompactionFailures: number;
  oversizedResults: number;
  truncatedChars: number;
}

export const DEFAULT_CONTEXT_BUDGETS: ContextBudgets = {
  targetTokens: 80_000,
  pressureTokens: 100_000,
  compactTokens: 120_000,
  ceilingTokens: 150_000,
};

export const DEFAULT_OUTPUT_LIMITS: OutputLimits = {
  largeOutputChars: 12_000,
  oversizedOutputChars: 32_000,
  headChars: 6_000,
  tailChars: 6_000,
};

export const CONTEXT_WINDOW_RATIOS = {
  amber: 0.40,
  pressure: 0.50,
  compact: 0.65,
  ceiling: 0.75,
} as const;

/**
 * Structured instructions for Pi's native compaction summarizer.
 * Preserves task state and decisions while discarding verbose transcripts.
 */
export const AIES_COMPACTION_INSTRUCTIONS = `
Focus the compaction summary on the operational state of the task:
- Current task/ticket and objective
- Acceptance criteria and progress against them
- Current stage of execution
- Key architecture and technical decisions made
- Important child delegations and their conclusions/findings
- Modified files and changed paths
- Verification status (PASS/FAIL/BLOCKED, valid/invalid, defects)
- Permissions and sandbox status
- Remaining work and next steps
- Real blockers, if any

Do NOT include:
- Verbose tool output logs or terminal transcripts
- Raw child transcripts or reasoning history
- Discarded hypotheses or dead ends
- Full file contents or oversized command results
`.trim();

/**
 * Pure calculation of context budgets with adaptive scaling for small windows.
 * Guarantees strict monotonicity: 0 < amber < pressure < compact < ceiling <= contextWindow.
 */
export function calculateContextBudgets(
  contextWindow: number = 0,
  config?: ContextGovernorConfig,
): ContextBudgets {
  const baseTarget = config?.targetTokens ?? DEFAULT_CONTEXT_BUDGETS.targetTokens;
  const basePressure = config?.pressureTokens ?? DEFAULT_CONTEXT_BUDGETS.pressureTokens;
  const baseCompact = config?.compactTokens ?? DEFAULT_CONTEXT_BUDGETS.compactTokens;
  const baseCeiling = config?.ceilingTokens ?? DEFAULT_CONTEXT_BUDGETS.ceilingTokens;

  if (contextWindow <= 0 || !Number.isFinite(contextWindow)) {
    let amber = baseTarget;
    let pressure = Math.max(basePressure, amber + 1);
    let compact = Math.max(baseCompact, pressure + 1);
    let ceiling = Math.max(baseCeiling, compact + 1);
    return { targetTokens: amber, pressureTokens: pressure, compactTokens: compact, ceilingTokens: ceiling };
  }

  // Adaptive scaling: min(absolute threshold, ratio * window)
  let amber = Math.min(baseTarget, Math.round(contextWindow * CONTEXT_WINDOW_RATIOS.amber));
  let pressure = Math.min(basePressure, Math.round(contextWindow * CONTEXT_WINDOW_RATIOS.pressure));
  let compact = Math.min(baseCompact, Math.round(contextWindow * CONTEXT_WINDOW_RATIOS.compact));
  let ceiling = Math.min(baseCeiling, Math.round(contextWindow * CONTEXT_WINDOW_RATIOS.ceiling));

  // Guarantee strict monotonicity: 0 < amber < pressure < compact < ceiling
  if (amber <= 0) amber = Math.max(1, Math.floor(contextWindow * 0.1));
  if (pressure <= amber) pressure = amber + 1;
  if (compact <= pressure) compact = pressure + 1;
  if (ceiling <= compact) ceiling = compact + 1;

  // Never exceed contextWindow if ceiling is clamped
  if (ceiling > contextWindow) {
    ceiling = contextWindow;
    if (compact >= ceiling) compact = Math.max(1, ceiling - 1);
    if (pressure >= compact) pressure = Math.max(1, compact - 1);
    if (amber >= pressure) amber = Math.max(1, pressure - 1);
  }

  return {
    targetTokens: amber,
    pressureTokens: pressure,
    compactTokens: compact,
    ceilingTokens: ceiling,
  };
}

/**
 * Pure determination of current context zone given token count and budgets.
 */
export function determineContextZone(
  tokens: number | null | undefined,
  budgets: ContextBudgets,
): ContextZone {
  if (tokens === null || tokens === undefined || tokens < budgets.targetTokens) {
    return "green";
  }
  if (tokens < budgets.pressureTokens) {
    return "amber";
  }
  if (tokens < budgets.compactTokens) {
    return "pressure";
  }
  if (tokens < budgets.ceilingTokens) {
    return "compact";
  }
  return "ceiling";
}

export type OutputClassification = "normal" | "large" | "oversized";

/**
 * Classify tool output size into normal, large, or oversized.
 */
export function classifyOutput(
  charCount: number,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): OutputClassification {
  if (charCount > limits.oversizedOutputChars) return "oversized";
  if (charCount > limits.largeOutputChars) return "large";
  return "normal";
}

/**
 * Truncate a large text string preserving head and tail with a clear truncation banner.
 */
export function truncateOutputText(
  text: string,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): { text: string; truncated: boolean; originalChars: number; truncatedChars: number } {
  const originalChars = text.length;
  if (originalChars <= limits.oversizedOutputChars) {
    return { text, truncated: false, originalChars, truncatedChars: 0 };
  }

  const head = text.slice(0, limits.headChars);
  const tail = text.slice(-limits.tailChars);
  const shownChars = head.length + tail.length;

  const notice = [
    "",
    "[Output truncated by AIES Context Governor]",
    `Original: ${originalChars.toLocaleString("en-US")} chars`,
    `Shown: ${shownChars.toLocaleString("en-US")} chars`,
    "",
    "Refine the command/query or delegate the investigation.",
    "",
  ].join("\n");

  const formatted = `${head}\n${notice}\n${tail}`;
  const truncatedChars = originalChars - formatted.length;

  return {
    text: formatted,
    truncated: true,
    originalChars,
    truncatedChars: Math.max(0, truncatedChars),
  };
}

/**
 * Inspect tool result content and apply head+tail truncation to oversized text blocks.
 * CRITICAL: Results from `aies_delegate` are NEVER truncated!
 */
export function truncateToolResultContent(
  content: unknown,
  toolName: string,
  limits: OutputLimits = DEFAULT_OUTPUT_LIMITS,
): {
  modified: boolean;
  content: any[];
  originalChars: number;
  truncatedChars: number;
  oversizedCount: number;
} {
  // CRITICAL RULE: Child handoffs are NEVER truncated by the generic governor!
  if (toolName === "aies_delegate") {
    return {
      modified: false,
      content: Array.isArray(content) ? content : [],
      originalChars: 0,
      truncatedChars: 0,
      oversizedCount: 0,
    };
  }

  if (!Array.isArray(content)) {
    return { modified: false, content: [], originalChars: 0, truncatedChars: 0, oversizedCount: 0 };
  }

  let modified = false;
  let totalOriginal = 0;
  let totalTruncated = 0;
  let oversizedCount = 0;

  const nextContent = content.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text" && typeof block.text === "string") {
      totalOriginal += block.text.length;
      if (block.text.length > limits.oversizedOutputChars) {
        const res = truncateOutputText(block.text, limits);
        if (res.truncated) {
          modified = true;
          totalTruncated += res.truncatedChars;
          oversizedCount += 1;
          return { ...block, text: res.text };
        }
      }
    }
    return block;
  });

  return {
    modified,
    content: modified ? nextContent : content,
    originalChars: totalOriginal,
    truncatedChars: totalTruncated,
    oversizedCount,
  };
}

const TRIVIAL_CEILING_COMMANDS = new Set([
  "pwd",
  "whoami",
  "date",
  "git status",
  "git branch",
  "git status -s",
  "git status --short",
]);

/**
 * Determine whether a tool invocation constitutes heavy parent work that should be
 * blocked when the session is at or above the operational ceiling.
 */
export function isHeavyParentTool(toolName: string, input?: Record<string, unknown>): boolean {
  if (toolName === "aies_delegate") return false;
  if (["read", "view_file", "edit", "write", "grep", "find", "ls", "tgrep", "glob"].includes(toolName)) {
    return true;
  }
  if (toolName === "bash") {
    const cmd = typeof input?.command === "string" ? input.command.trim() : "";
    if (TRIVIAL_CEILING_COMMANDS.has(cmd)) {
      return false;
    }
    return true;
  }
  return true;
}

function readConfigContext(): ContextGovernorConfig | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const candidates: string[] = [];
  if (agentDir) candidates.push(join(agentDir, "aies.json"));
  candidates.push(join(process.cwd(), "profile", "aies.json"));

  for (const configPath of candidates) {
    if (existsSync(configPath)) {
      try {
        const content = JSON.parse(readFileSync(configPath, "utf8"));
        if (content.context && typeof content.context === "object") {
          return content.context;
        }
      } catch {
        // Fall back to next candidate or default
      }
    }
  }
  return undefined;
}

/**
 * The single conceptual authority for Parent context management.
 */
export class ContextGovernor {
  private config: ContextGovernorConfig;
  private limits: OutputLimits;
  private budgets: ContextBudgets;
  private currentTokens: number | null = null;
  private contextWindow: number = 0;
  private zone: ContextZone = "green";
  private compactPending: boolean = false;
  private compacting: boolean = false;
  private lastCompactionAt?: number;
  private lastCompactionError?: string;
  private compactionCount: number = 0;
  private compactionFailures: number = 0;
  private consecutiveCompactionFailures: number = 0;
  private oversizedResults: number = 0;
  private truncatedChars: number = 0;

  private activeCompactionPromise: Promise<CompactionResult | void> | null = null;

  constructor(config?: ContextGovernorConfig) {
    this.config = config ?? readConfigContext() ?? {};
    this.limits = {
      largeOutputChars: this.config.largeOutputChars ?? DEFAULT_OUTPUT_LIMITS.largeOutputChars,
      oversizedOutputChars: this.config.oversizedOutputChars ?? DEFAULT_OUTPUT_LIMITS.oversizedOutputChars,
      headChars: this.config.headChars ?? DEFAULT_OUTPUT_LIMITS.headChars,
      tailChars: this.config.tailChars ?? DEFAULT_OUTPUT_LIMITS.tailChars,
    };
    this.budgets = calculateContextBudgets(0, this.config);
  }

  /**
   * Update context token usage reported by Pi.
   */
  updateUsage(usage: { tokens?: number | null; contextWindow?: number } | undefined): void {
    if (!usage) return;

    if (typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      this.contextWindow = usage.contextWindow;
      this.budgets = calculateContextBudgets(this.contextWindow, this.config);
    }

    if (usage.tokens !== undefined) {
      this.currentTokens = usage.tokens;
    }

    this.zone = determineContextZone(this.currentTokens, this.budgets);

    // If we have reached compact threshold and not currently compacting, flag compaction as pending
    if ((this.zone === "compact" || this.zone === "ceiling") && !this.compacting) {
      this.compactPending = true;
    }
  }

  getZone(): ContextZone {
    return this.zone;
  }

  getBudgets(): ContextBudgets {
    return { ...this.budgets };
  }

  getCurrentTokens(): number | null {
    return this.currentTokens;
  }

  isCompactPending(): boolean {
    return this.compactPending;
  }

  isCompacting(): boolean {
    return this.compacting;
  }

  /**
   * Determine whether heavy parent work is allowed under current context pressure.
   */
  isHeavyWorkAllowed(toolName: string, input?: Record<string, unknown>): { allowed: boolean; reason?: string } {
    // Delegation is ALWAYS allowed — it is the required path to reduce context pressure.
    if (toolName === "aies_delegate") {
      return { allowed: true };
    }

    // While a compaction is actively running, pause starting heavy direct operations.
    if (this.compacting && isHeavyParentTool(toolName, input)) {
      return {
        allowed: false,
        reason: "Compaction in progress; wait for completion before starting heavy work.",
      };
    }

    // At CEILING, block direct heavy work.
    if (this.zone === "ceiling" && isHeavyParentTool(toolName, input)) {
      if (this.lastCompactionError && this.consecutiveCompactionFailures > 0) {
        return {
          allowed: false,
          reason: `Parent context ceiling reached (${this.currentTokens ?? "unknown"} tokens >= ${this.budgets.ceilingTokens}) and compaction failed; context intervention required: delegate Explore or Worker, or finalize task.`,
        };
      }
      return {
        allowed: false,
        reason: `Parent context ceiling reached (${this.currentTokens ?? "unknown"} tokens >= ${this.budgets.ceilingTokens}); delegate Explore or Worker, or finalize task.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Process a tool result for hygiene and oversized protection.
   */
  processToolResult(event: { toolName: string; content: unknown; isError?: boolean }): {
    modified: boolean;
    content?: any[];
  } {
    const res = truncateToolResultContent(event.content, event.toolName, this.limits);
    if (res.oversizedCount > 0) {
      this.oversizedResults += res.oversizedCount;
      this.truncatedChars += res.truncatedChars;
    }
    return { modified: res.modified, content: res.content };
  }

  /**
   * Handle safe boundary trigger at agent_settled.
   * Runs single-flight compaction wrapped in a Promise to await real onComplete/onError.
   */
  async handleSettled(ctx: ExtensionContext): Promise<CompactionResult | void> {
    if (!this.compactPending && !this.compacting) {
      return;
    }
    if (this.compacting) {
      return this.activeCompactionPromise ?? undefined;
    }

    this.compactPending = false;
    this.compacting = true;
    this.lastCompactionError = undefined;

    const promise = new Promise<CompactionResult | void>((resolve, reject) => {
      try {
        ctx.compact({
          customInstructions: AIES_COMPACTION_INSTRUCTIONS,
          onComplete: (result) => {
            this.compacting = false;
            this.activeCompactionPromise = null;
            this.lastCompactionAt = Date.now();
            this.compactionCount += 1;
            this.consecutiveCompactionFailures = 0;
            this.lastCompactionError = undefined;
            resolve(result);
          },
          onError: (error) => {
            this.compacting = false;
            this.activeCompactionPromise = null;
            this.lastCompactionError = error.message;
            this.compactionFailures += 1;
            this.consecutiveCompactionFailures += 1;
            reject(error);
          },
        });
      } catch (err: any) {
        this.compacting = false;
        this.activeCompactionPromise = null;
        this.lastCompactionError = err?.message || String(err);
        this.compactionFailures += 1;
        this.consecutiveCompactionFailures += 1;
        reject(err);
      }
    });

    this.activeCompactionPromise = promise;

    try {
      return await promise;
    } catch {
      // Compaction failure is recorded on state; do not throw to extension runner.
      return undefined;
    }
  }

  /**
   * Callback for external compaction success event.
   */
  onCompactionSuccess(): void {
    this.compacting = false;
    this.compactPending = false;
    this.activeCompactionPromise = null;
    this.lastCompactionAt = Date.now();
    this.compactionCount += 1;
    this.consecutiveCompactionFailures = 0;
    this.lastCompactionError = undefined;
  }

  /**
   * Callback for external compaction failure event.
   */
  onCompactionFailure(errorMessage: string): void {
    this.compacting = false;
    this.compactPending = false;
    this.activeCompactionPromise = null;
    this.lastCompactionError = errorMessage;
    this.compactionFailures += 1;
    this.consecutiveCompactionFailures += 1;
  }

  /**
   * Export governor telemetry snapshot for observability.
   */
  getTelemetry(): ContextGovernorTelemetry {
    return {
      zone: this.zone,
      currentTokens: this.currentTokens,
      contextWindow: this.contextWindow,
      compactAtTokens: this.budgets.compactTokens,
      ceilingTokens: this.budgets.ceilingTokens,
      compactPending: this.compactPending,
      compacting: this.compacting,
      compactionCount: this.compactionCount,
      lastCompactionAt: this.lastCompactionAt,
      lastCompactionError: this.lastCompactionError,
      compactionFailures: this.compactionFailures,
      consecutiveCompactionFailures: this.consecutiveCompactionFailures,
      oversizedResults: this.oversizedResults,
      truncatedChars: this.truncatedChars,
    };
  }

  /**
   * Reset session-specific state while preserving configured limits.
   */
  reset(): void {
    this.currentTokens = null;
    this.contextWindow = 0;
    this.zone = "green";
    this.compactPending = false;
    this.compacting = false;
    this.lastCompactionAt = undefined;
    this.lastCompactionError = undefined;
    this.consecutiveCompactionFailures = 0;
    this.activeCompactionPromise = null;
    this.budgets = calculateContextBudgets(0, this.config);
  }
}

let globalGovernor: ContextGovernor | undefined;

export function getContextGovernor(config?: ContextGovernorConfig): ContextGovernor {
  if (!globalGovernor) {
    globalGovernor = new ContextGovernor(config);
  }
  return globalGovernor;
}

export function resetContextGovernor(config?: ContextGovernorConfig): ContextGovernor {
  globalGovernor = new ContextGovernor(config);
  return globalGovernor;
}

export function getContextGovernorTelemetry(): ContextGovernorTelemetry {
  return getContextGovernor().getTelemetry();
}
