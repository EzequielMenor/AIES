/**
 * Delegation tool (aies_delegate) for AIES (AIES-004).
 *
 * Exposes a single tool for parent sessions to launch isolated child agents.
 * Supports:
 * - "explore": isolated read-only investigation with scoped search tools.
 * - "worker": isolated implementation with workspace editing and guarded bash.
 */

import { Type, type Static } from "typebox";
import { getAgentDir, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { runExploreAgent } from "./explore.ts";
import {
  formatExploreHandoff,
  formatWorkerHandoff,
  type ExploreHandoff,
  type WorkerHandoff,
} from "./handoff.ts";
import { runWorkerAgent } from "./worker.ts";

export const DelegateParamsSchema = Type.Object({
  role: Type.Union([Type.Literal("explore"), Type.Literal("worker")], {
    description: "The agent role to delegate to ('explore' or 'worker')",
  }),
  task: Type.String({
    description: "The specific investigation task or implementation work unit for the child agent",
  }),
  context: Type.Optional(
    Type.String({
      description: "Optional background context, acceptance criteria, or findings from Explore",
    }),
  ),
});

export type DelegateParams = Static<typeof DelegateParamsSchema>;
export type DelegateHandoff = ExploreHandoff | WorkerHandoff;

export function createDelegateTool(): ToolDefinition<typeof DelegateParamsSchema, DelegateHandoff> {
  return {
    name: "aies_delegate",
    label: "AIES Delegate",
    description:
      "Delegate a task to an isolated child agent without polluting parent context. Use 'explore' for investigation and 'worker' for implementation and tests.",
    promptSnippet:
      "aies_delegate: Delegate an exploration ('explore') or implementation ('worker') task to an isolated child agent.",
    promptGuidelines: [
      "Use aies_delegate({ role: 'explore', ... }) when investigating the codebase or checking >2 files.",
      "Use aies_delegate({ role: 'worker', ... }) when implementing concrete changes, editing files, or running tests.",
      "Do NOT implement substantial multi-file changes directly in the parent session.",
    ],
    parameters: DelegateParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const { role, task, context } = params;
      const agentDir = getAgentDir();

      if (role === "explore") {
        const handoff = await runExploreAgent({
          task,
          context,
          cwd: ctx.cwd,
          agentDir,
          parentModel: ctx.model,
          signal,
        });

        return {
          content: [{ type: "text", text: formatExploreHandoff(handoff) }],
          details: handoff,
        };
      }

      if (role === "worker") {
        const handoff = await runWorkerAgent({
          task,
          context,
          cwd: ctx.cwd,
          agentDir,
          parentModel: ctx.model,
          signal,
        });

        return {
          content: [{ type: "text", text: formatWorkerHandoff(handoff) }],
          details: handoff,
        };
      }

      throw new Error(
        `Unsupported delegation role: "${role}". Only "explore" and "worker" are supported.`,
      );
    },
  };
}
