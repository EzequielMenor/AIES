/**
 * Routing policy and guardrails for the parent session (AIES-004, AIES-005).
 *
 * Implements four routes:
 * - INLINE DIRECT: Trivial work (typo, single comment, 1-2 file reads, localized fix).
 * - EXPLORE: Unknown scope, broad search, or reading >2 files.
 * - WORKER: Non-trivial multi-file changes, test cycles, or editing work units.
 * - VERIFY: Independent proof that a behaviour-bearing change actually works
 *   (AIES-005). It is not a route taken by pressure counters: a change produced
 *   by Worker requires it before the work unit can be considered complete, and
 *   `requiresVerification()` in `verification.ts` is the rule that decides when.
 *
 * Distinguishes:
 * - Soft signals: Informing prompt/model to steer toward delegation.
 * - Hard guardrails: Blocking execution when parent silently exceeds direct limits.
 *
 * Counters reset at each delegation boundary while global AIES-002 telemetry accumulates.
 */

export const ROUTING_THRESHOLDS = {
  EXPLORATION_READS_SOFT: 3,
  EXPLORATION_READS_HARD: 5,
  TOOL_CALLS_SOFT: 7,
  TOOL_CALLS_HARD: 12,
  FILES_INSPECTED_EXPLORE_THRESHOLD: 3,
  MULTI_FILE_CHANGES_WORKER_THRESHOLD: 2,
} as const;

export type RoutingMode = "inline" | "delegated";

/** The child roles a parent may delegate to. Order is the work order, not a rank. */
export type DelegationRole = "explore" | "worker" | "verify";

export interface RoutingState {
  currentMode: RoutingMode;
  toolsSinceBoundary: number;
  readsSinceBoundary: number;
  filesSinceBoundary: string[];
  lastDelegation:
    | {
        role: DelegationRole;
        timestamp: number;
        outcome?: string;
      }
    | undefined;
}

export interface RoutingSignals {
  explorationPressure: "none" | "soft" | "hard";
  toolPressure: "none" | "soft" | "hard";
  contextPressure?: "none" | "amber" | "pressure" | "compact" | "ceiling";
  recommendedAction: "inline" | "explore" | "worker";
  reason?: string;
}

export interface ContextGovernorLike {
  isHeavyWorkAllowed(toolName: string, input?: Record<string, unknown>): { allowed: boolean; reason?: string };
}

export interface GuardrailCheckResult {
  block: boolean;
  reason?: string;
}

export interface ToolCallInputLike {
  toolName: string;
  input?: Record<string, unknown>;
}

const SOURCE_READ_TOOLS = ["read", "view_file"];

function isSourceReadTool(toolName: string): boolean {
  return SOURCE_READ_TOOLS.includes(toolName);
}

function extractFilePath(input?: Record<string, unknown>): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "filePath", "file_path"]) {
    const val = input[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return undefined;
}

export function createRoutingState(): RoutingState {
  return {
    currentMode: "inline",
    toolsSinceBoundary: 0,
    readsSinceBoundary: 0,
    filesSinceBoundary: [],
    lastDelegation: undefined,
  };
}

/**
 * Record a parent tool call in routing state.
 */
export function applyRoutingToolCall(
  state: RoutingState,
  call: ToolCallInputLike,
  _root: string = "",
): RoutingState {
  if (call.toolName === "aies_delegate") {
    // Delegation tool call is not counted as direct execution
    return state;
  }

  const nextFiles = [...state.filesSinceBoundary];
  let nextReads = state.readsSinceBoundary;

  if (isSourceReadTool(call.toolName)) {
    nextReads += 1;
    const filePath = extractFilePath(call.input);
    if (filePath && !nextFiles.includes(filePath)) {
      nextFiles.push(filePath);
    }
  }

  return {
    ...state,
    toolsSinceBoundary: state.toolsSinceBoundary + 1,
    readsSinceBoundary: nextReads,
    filesSinceBoundary: nextFiles,
  };
}

/**
 * Mark the start of a child delegation in routing state.
 */
export function applyRoutingDelegationStart(
  state: RoutingState,
  _role: DelegationRole,
  _now: number,
): RoutingState {
  return {
    ...state,
    currentMode: "delegated",
  };
}

/**
 * Mark the completion of a child delegation in routing state and reset boundary counters.
 */
export function applyRoutingDelegationEnd(
  state: RoutingState,
  role: DelegationRole,
  outcome: string,
  now: number,
): RoutingState {
  return {
    currentMode: "inline",
    toolsSinceBoundary: 0,
    readsSinceBoundary: 0,
    filesSinceBoundary: [],
    lastDelegation: {
      role,
      timestamp: now,
      outcome,
    },
  };
}

/**
 * Evaluate current soft pressure signals and recommendations.
 */
export function evaluateRoutingSignals(
  state: RoutingState,
  contextZone?: "green" | "amber" | "pressure" | "compact" | "ceiling",
): RoutingSignals {
  let explorationPressure: "none" | "soft" | "hard" = "none";
  if (state.readsSinceBoundary >= ROUTING_THRESHOLDS.EXPLORATION_READS_HARD) {
    explorationPressure = "hard";
  } else if (state.readsSinceBoundary >= ROUTING_THRESHOLDS.EXPLORATION_READS_SOFT) {
    explorationPressure = "soft";
  }

  let toolPressure: "none" | "soft" | "hard" = "none";
  if (state.toolsSinceBoundary >= ROUTING_THRESHOLDS.TOOL_CALLS_HARD) {
    toolPressure = "hard";
  } else if (state.toolsSinceBoundary >= ROUTING_THRESHOLDS.TOOL_CALLS_SOFT) {
    toolPressure = "soft";
  }

  let contextPressure: "none" | "amber" | "pressure" | "compact" | "ceiling" = "none";
  if (contextZone && contextZone !== "green") {
    contextPressure = contextZone;
  }

  let recommendedAction: "inline" | "explore" | "worker" = "inline";
  let reason: string | undefined;

  if (explorationPressure === "hard") {
    recommendedAction = "explore";
    reason = `Exploration budget exceeded (${state.readsSinceBoundary} source reads); delegate Explore.`;
  } else if (toolPressure === "hard") {
    recommendedAction = "worker";
    reason = `Tool call budget exceeded (${state.toolsSinceBoundary} calls); re-evaluate and delegate to Worker or Explore.`;
  } else if (state.filesSinceBoundary.length > ROUTING_THRESHOLDS.FILES_INSPECTED_EXPLORE_THRESHOLD) {
    recommendedAction = "explore";
    reason = `More than ${ROUTING_THRESHOLDS.FILES_INSPECTED_EXPLORE_THRESHOLD} files inspected (${state.filesSinceBoundary.length}); delegate Explore.`;
  } else if (contextPressure === "pressure" || contextPressure === "compact" || contextPressure === "ceiling") {
    if (state.readsSinceBoundary > 0 || state.filesSinceBoundary.length > 0) {
      recommendedAction = "explore";
      reason = `Context pressure is ${contextPressure}; delegate Explore to keep parent context lean.`;
    } else {
      recommendedAction = "worker";
      reason = `Context pressure is ${contextPressure}; delegate Worker to keep parent context lean.`;
    }
  } else if (explorationPressure === "soft") {
    recommendedAction = "explore";
    reason = `Soft exploration threshold reached (${state.readsSinceBoundary} source reads); consider delegating to Explore.`;
  } else if (contextPressure === "amber" && state.readsSinceBoundary >= 2) {
    recommendedAction = "explore";
    reason = "Amber context threshold reached; favour Explore for further discovery.";
  } else if (toolPressure === "soft") {
    recommendedAction = "worker";
    reason = `Soft tool threshold reached (${state.toolsSinceBoundary} calls); consider delegating to Worker.`;
  }

  return {
    explorationPressure,
    toolPressure,
    contextPressure,
    recommendedAction,
    reason,
  };
}

/**
 * Enforce hard routing guardrails before a tool executes.
 *
 * Returns { block: true, reason } if the action exceeds hard boundary limits.
 */
export function checkRoutingGuardrail(
  state: RoutingState,
  call: ToolCallInputLike,
  governor?: ContextGovernorLike,
): GuardrailCheckResult {
  // Delegation is always permitted (it is the required escape hatch)
  if (call.toolName === "aies_delegate") {
    return { block: false };
  }

  // Enforce Context Governor operational ceiling & compaction in progress
  if (governor) {
    const heavyCheck = governor.isHeavyWorkAllowed(call.toolName, call.input);
    if (!heavyCheck.allowed) {
      return {
        block: true,
        reason: heavyCheck.reason ?? "parent context ceiling reached; delegate Explore or Worker, or finalize task",
      };
    }
  }

  // Hard stop on direct exploratory reads
  if (
    isSourceReadTool(call.toolName) &&
    state.readsSinceBoundary >= ROUTING_THRESHOLDS.EXPLORATION_READS_HARD
  ) {
    return {
      block: true,
      reason:
        "parent exploration budget exceeded; delegate Explore",
    };
  }

  // Hard budget re-evaluation on parent tool chain
  if (state.toolsSinceBoundary >= ROUTING_THRESHOLDS.TOOL_CALLS_HARD) {
    return {
      block: true,
      reason:
        "parent tool budget exceeded; re-evaluation required: delegate Explore or Worker, or finalize task",
    };
  }

  return { block: false };
}
