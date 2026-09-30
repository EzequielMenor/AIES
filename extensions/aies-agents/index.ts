/**
 * AIES agents extension (AIES-004, AIES-005, AIES-007).
 *
 * Registers the `aies_delegate` tool, enforces parent routing guardrails,
 * governs parent context budgets and compaction, and owns the verification record:
 * a parent edit or write invalidates a PASS, and the delegate tool itself records
 * Worker runs and verification verdicts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDelegateTool, delegationRole } from "./delegate.ts";
import {
  applyRoutingDelegationEnd,
  applyRoutingDelegationStart,
  applyRoutingToolCall,
  checkRoutingGuardrail,
  createRoutingState,
  type RoutingState,
} from "./routing.ts";
import {
  applyWorkUnitChange,
  createVerificationState,
  type VerificationState,
} from "./verification.ts";
import {
  getContextGovernor,
  type ContextGovernor,
} from "./context-governor.ts";
import { TicketManager } from "./linear/manager.ts";
import { createTicketTool } from "./linear/tool.ts";
import { registerTicketCommand } from "./linear/command.ts";
import type { TicketOperationResult, TicketSnapshot } from "./linear/types.ts";
import { AGENTS_CHANNEL, observatory, type ObservatorySnapshot } from "./observatory.ts";
import {
  applyMcpStatusEvent,
  createMcpIntegrationState,
  diagnoseMcpServer,
  MCP_STATUS_CHANNEL,
  type McpIntegrationState,
} from "./mcp/integration.ts";
import {
  ContinuationController,
  getActiveContinuationController,
  registerAutonomyCommand,
  setActiveContinuationController,
  type AutonomySnapshot,
} from "./autonomy/index.ts";
import { resetPermissionTelemetry } from "./permissions.ts";

/** Native tools that change the work unit when the parent uses them directly. */
const PARENT_MUTATION_TOOLS = ["edit", "write"];

/**
 * Model-facing summary appended to a captured `mcp` tool result so the Parent sees
 * the resumed Linear outcome (the loaded contract, the next `remote_required`
 * directive to run, or a clear failure) without a second `aies_ticket` call.
 */
function describeCapturedOutcome(result: TicketOperationResult): string {
  const parts = ["AIES captured this `mcp` result automatically and resumed the pending Linear operation."];
  if (result.contract) parts.push(result.contract);
  if (result.message) parts.push(result.message);
  const instruction =
    result.details && typeof result.details.instruction === "string" ? result.details.instruction : undefined;
  if (instruction) parts.push(instruction);
  return parts.join("\n\n");
}

let activeTicketManager: TicketManager | undefined;

export function getActiveTicketManager(): TicketManager | undefined {
  return activeTicketManager;
}

let activeResetSessionState: (() => void) | undefined;

/**
 * Single, explicit reset boundary for a new AIES session (EZE-485).
 * Resets all session-ephemeral child observations, telemetry counters,
 * active ticket state, autonomy controller state, and routing/verification states.
 */
export function resetSessionState(): void {
  observatory.reset();
  resetPermissionTelemetry();
  getContextGovernor().reset();
  getActiveTicketManager()?.reset();
  getActiveContinuationController()?.reset();
  activeResetSessionState?.();
}

/** The minimal event surface the observatory bridge needs. */
export interface ObservatoryEventSink {
  emit?(channel: string, data: unknown): void;
}

/**
 * Re-publish every observatory mutation on the shared `pi.events` bus. Pi loads
 * each extension through its own module registry, so the registry singleton is
 * not shared with `aies-runtime`; the bus is the documented bridge. The registry
 * already emits exactly once per mutation, so this adds no per-keystroke noise,
 * and the guard keeps a missing bus or a throwing subscriber from ever breaking
 * a child run.
 */
export function publishObservatoryOn(events: ObservatoryEventSink | undefined): () => void {
  const publish = (snapshot: ObservatorySnapshot): void => {
    try {
      events?.emit?.(AGENTS_CHANNEL, snapshot);
    } catch {
      // A broken or absent event bus never breaks a child run.
    }
  };

  try {
    return observatory.subscribe(publish);
  } catch {
    return () => {};
  }
}

export { getActiveContinuationController };


/**
 * Session tool names, or undefined when the host cannot report them. It separates
 * "the MCP adapter is absent" from "the adapter has not reported a status snapshot
 * yet", because only the first one is a real failure.
 */
function sessionToolNames(pi: ExtensionAPI): string[] | undefined {
  try {
    return pi.getAllTools().map((tool) => tool.name);
  } catch {
    return undefined;
  }
}

export default function aiesAgents(pi: ExtensionAPI): void {
  let routingState: RoutingState = createRoutingState();
  let verification: VerificationState = createVerificationState();
  const governor: ContextGovernor = getContextGovernor();

  // The MCP adapter publishes read-only status on a versioned channel. AIES reads
  // it so an unusable Linear transport fails with a real instruction, and resets
  // the sensor per session so a previous session's snapshot cannot decide this
  // one's diagnosis.
  let mcpState: McpIntegrationState = createMcpIntegrationState();
  pi.events.on(MCP_STATUS_CHANNEL, (payload: unknown) => {
    mcpState = applyMcpStatusEvent(mcpState, payload, Date.now());
  });

  function resetLocalAgentState(): void {
    routingState = createRoutingState();
    verification = createVerificationState();
    mcpState = createMcpIntegrationState();
  }
  activeResetSessionState = resetLocalAgentState;

  // The registry watches the children; this bridge lets the UI extension see it.
  // Subscribed once per extension instance and never per event: the registry
  // already emits exactly one snapshot per mutation.
  publishObservatoryOn(pi.events);

  const ticketManager = new TicketManager({
    getVerification: () => verification,
    getMcpDiagnostic: () => diagnoseMcpServer(mcpState, { adapterToolNames: sessionToolNames(pi) }),
  });
  activeTicketManager = ticketManager;

  const controller = new ContinuationController({
    pi,
    getRouting: () => routingState,
    getVerification: () => verification,
    getGovernor: () => governor,
    getTicketManager: () => ticketManager,
  });
  setActiveContinuationController(controller);

  pi.registerTool(createTicketTool(ticketManager));
  registerTicketCommand(pi, ticketManager);
  registerAutonomyCommand(pi, controller, ticketManager);

  pi.registerTool(
    createDelegateTool({
      verification: {
        get: () => verification,
        set: (next) => {
          verification = next;
        },
      },
    }),
  );

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown> | undefined;

    // Check hard guardrails before tool execution (routing limits + context governor ceiling)
    const guard = checkRoutingGuardrail(
      routingState,
      {
        toolName: event.toolName,
        input,
      },
      governor,
    );

    if (guard.block) {
      return { block: true, reason: guard.reason };
    }

    if (event.toolName === "aies_delegate") {
      routingState = applyRoutingDelegationStart(routingState, delegationRole(input), Date.now());
      return;
    }

    // A direct parent edit to a behaviour-bearing path expires an old PASS.
    if (PARENT_MUTATION_TOOLS.includes(event.toolName)) {
      const path = typeof input?.path === "string" ? input.path : "unknown path";
      verification = applyWorkUnitChange(verification, [path], `parent ${event.toolName} on ${path}`);
      if (path !== "unknown path") {
        ticketManager.recordChangedPaths([path]);
      }
    }

    routingState = applyRoutingToolCall(
      routingState,
      { toolName: event.toolName, input },
      ctx.cwd,
    );
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "aies_delegate") {
      const input = event.input as Record<string, unknown> | undefined;
      const outcome = event.isError ? "failed" : "done";
      routingState = applyRoutingDelegationEnd(
        routingState,
        delegationRole(input),
        outcome,
        Date.now(),
      );

      // When Worker completes, record modified paths in active ticket manager
      if (delegationRole(input) === "worker" && !event.isError) {
        const details = event.details as Record<string, unknown> | undefined;
        if (Array.isArray(details?.changes)) {
          const files = (details.changes as Array<{ file?: string }>).map((c) => c.file).filter((f): f is string => Boolean(f));
          ticketManager.recordChangedPaths(files);
        }
      }
      return;
    }

    // Capture Linear errors if aies_ticket was called
    if (event.toolName === "aies_ticket") {
      const details = event.details as Record<string, unknown> | undefined;
      if (details?.error && typeof details.error === "string") {
        controller.setLinearError(details.error);
      } else if (!event.isError) {
        controller.setLinearError(undefined);
      }
    }

    // EZE-490: deterministically capture a `mcp` proxy result that satisfies the
    // pending Linear remote call and resume the operation here, so the Parent never
    // has to copy/serialize the payload back through `remote`. This runs BEFORE the
    // context-governor hygiene filter and only fires for a matching pending call.
    let capturedContent: undefined | (typeof event.content) = undefined;
    if (event.toolName === "mcp" && !event.isError) {
      const input = event.input as { server?: unknown; tool?: unknown; args?: unknown } | undefined;
      if (input && typeof input.tool === "string") {
        const resumed = await ticketManager.captureRemote(
          { server: input.server, tool: input.tool, args: input.args },
          event.content,
        );
        if (resumed) {
          capturedContent = [...event.content, { type: "text", text: describeCapturedOutcome(resumed) }];
        }
      }
    }

    // Feed current context usage to governor
    try {
      governor.updateUsage(ctx.getContextUsage());
    } catch {
      // Degrade silently if context is unavailable
    }

    // Apply tool output hygiene and oversized truncation (handoffs already bypassed)
    const filter = governor.processToolResult({
      toolName: event.toolName,
      content: capturedContent ?? event.content,
      isError: event.isError,
    });

    if (filter.modified || capturedContent) {
      return { content: filter.content };
    }
  });

  pi.on("turn_start", async () => {
    controller.notifyTurnStart();
  });

  pi.on("turn_end", async (_event, ctx) => {
    controller.notifyTurnEnd();
    try {
      governor.updateUsage(ctx.getContextUsage());
    } catch {}
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      governor.updateUsage(ctx.getContextUsage());
      if (governor.isCompactPending() || governor.isCompacting()) {
        await governor.handleSettled(ctx);
        governor.updateUsage(ctx.getContextUsage());
      }
    } catch {}

    // Persist active ticket snapshot to session entry
    const snapshot = ticketManager.toSnapshot();
    if (snapshot) {
      try {
        pi.appendEntry("aies-ticket", snapshot);
      } catch {}
    }

    // Persist autonomy snapshot to session entry
    const autonomySnap = controller.toSnapshot();
    if (autonomySnap) {
      try {
        pi.appendEntry("aies-autonomy", autonomySnap);
      } catch {}
    }

    // Evaluate and trigger bounded continuation
    try {
      await controller.handleSettled(ctx, {
        ticketManager,
        verification,
        routing: routingState,
        governor,
      });
    } catch {}
  });

  pi.on("session_compact", async () => {
    governor.onCompactionSuccess();
  });

  pi.on("session_compact_failed", async (event) => {
    governor.onCompactionFailure(event.errorMessage ?? "Compaction failed");
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "new") {
      resetSessionState();
    } else if (event.reason === "resume" || event.reason === "reload") {
      routingState = createRoutingState();
      verification = createVerificationState();
      try {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type === "custom" && entry.customType === "aies-ticket" && entry.data) {
            ticketManager.restoreFromSnapshot(entry.data as TicketSnapshot);
            break;
          }
        }
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type === "custom" && entry.customType === "aies-autonomy" && entry.data) {
            controller.restoreFromSnapshot(entry.data as AutonomySnapshot);
            break;
          }
        }
      } catch {}
    } else {
      routingState = createRoutingState();
      verification = createVerificationState();
    }
  });
}

