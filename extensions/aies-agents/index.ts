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
import type { TicketSnapshot } from "./linear/types.ts";
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

/** Native tools that change the work unit when the parent uses them directly. */
const PARENT_MUTATION_TOOLS = ["edit", "write"];

let activeTicketManager: TicketManager | undefined;

export function getActiveTicketManager(): TicketManager | undefined {
  return activeTicketManager;
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
  pi.on("session_start", () => {
    mcpState = createMcpIntegrationState();
  });

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

    // Feed current context usage to governor
    try {
      governor.updateUsage(ctx.getContextUsage());
    } catch {
      // Degrade silently if context is unavailable
    }

    // Apply tool output hygiene and oversized truncation (handoffs already bypassed)
    const filter = governor.processToolResult({
      toolName: event.toolName,
      content: event.content,
      isError: event.isError,
    });

    if (filter.modified) {
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
    routingState = createRoutingState();
    verification = createVerificationState();
    if (event.reason === "new") {
      governor.reset();
      ticketManager.reset();
      controller.reset();
    } else if (event.reason === "resume" || event.reason === "reload") {
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
    }
  });
}

