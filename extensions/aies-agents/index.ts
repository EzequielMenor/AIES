/**
 * AIES agents extension (AIES-004, AIES-005).
 *
 * Registers the `aies_delegate` tool, enforces parent routing guardrails, and
 * owns the verification record: a parent edit or write invalidates a PASS, and
 * the delegate tool itself records Worker runs and verification verdicts.
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

/** Native tools that change the work unit when the parent uses them directly. */
const PARENT_MUTATION_TOOLS = ["edit", "write"];

export default function aiesAgents(pi: ExtensionAPI): void {
  let routingState: RoutingState = createRoutingState();
  let verification: VerificationState = createVerificationState();

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

    // Check hard guardrails before tool execution
    const guard = checkRoutingGuardrail(routingState, {
      toolName: event.toolName,
      input,
    });

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

  pi.on("tool_result", async (event) => {
    if (event.toolName === "aies_delegate") {
      const input = event.input as Record<string, unknown> | undefined;
      const outcome = event.isError ? "failed" : "done";
      routingState = applyRoutingDelegationEnd(
        routingState,
        delegationRole(input),
        outcome,
        Date.now(),
      );
    }
  });

  pi.on("session_start", async () => {
    routingState = createRoutingState();
    verification = createVerificationState();
  });
}
