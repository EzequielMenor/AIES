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

/** Native tools that change the work unit when the parent uses them directly. */
const PARENT_MUTATION_TOOLS = ["edit", "write"];

export default function aiesAgents(pi: ExtensionAPI): void {
  let routingState: RoutingState = createRoutingState();
  let verification: VerificationState = createVerificationState();
  const governor: ContextGovernor = getContextGovernor();

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
      return;
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

  pi.on("turn_end", async (_event, ctx) => {
    try {
      governor.updateUsage(ctx.getContextUsage());
    } catch {}
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      governor.updateUsage(ctx.getContextUsage());
      await governor.handleSettled(ctx);
    } catch {}
  });

  pi.on("session_compact", async () => {
    governor.onCompactionSuccess();
  });

  pi.on("session_compact_failed", async (event) => {
    governor.onCompactionFailure(event.errorMessage ?? "Compaction failed");
  });

  pi.on("session_start", async (event) => {
    routingState = createRoutingState();
    verification = createVerificationState();
    if (event.reason === "new") {
      governor.reset();
    }
  });
}
