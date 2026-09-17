/**
 * AIES agents extension (AIES-004).
 *
 * Registers the `aies_delegate` tool and enforces parent routing guardrails.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDelegateTool } from "./delegate.ts";
import {
  applyRoutingDelegationEnd,
  applyRoutingDelegationStart,
  applyRoutingToolCall,
  checkRoutingGuardrail,
  createRoutingState,
  type RoutingState,
} from "./routing.ts";

export default function aiesAgents(pi: ExtensionAPI): void {
  let routingState: RoutingState = createRoutingState();

  pi.registerTool(createDelegateTool());

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown> | undefined;

    // Check hard guardrails before tool execution
    const guard = checkRoutingGuardrail(routingState, {
      toolName: event.toolName,
      input,
    });

    if (guard.block) {
      return { block: true, reason: guard.reason };
    }

    if (event.toolName === "aies_delegate") {
      const role = (input?.role === "worker" ? "worker" : "explore") as "explore" | "worker";
      routingState = applyRoutingDelegationStart(routingState, role, Date.now());
    } else {
      routingState = applyRoutingToolCall(
        routingState,
        { toolName: event.toolName, input },
        ctx.cwd,
      );
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName === "aies_delegate") {
      const input = event.input as Record<string, unknown> | undefined;
      const role = (input?.role === "worker" ? "worker" : "explore") as "explore" | "worker";
      const outcome = event.isError ? "failed" : "done";
      routingState = applyRoutingDelegationEnd(routingState, role, outcome, Date.now());
    }
  });

  pi.on("session_start", async () => {
    routingState = createRoutingState();
  });
}
