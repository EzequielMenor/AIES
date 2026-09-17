/**
 * Delegation tool (aies_delegate) for AIES.
 *
 * Exposes a single tool for parent sessions to launch isolated child agents.
 * In AIES-003, only the "explore" role is supported.
 */

import { Type, type Static } from "typebox";
import { getAgentDir, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { runExploreAgent } from "./explore.ts";
import { formatExploreHandoff, type ExploreHandoff } from "./handoff.ts";

export const DelegateParamsSchema = Type.Object({
  role: Type.Literal("explore", {
    description: "The agent role to delegate to (only 'explore' is supported in AIES-003)",
  }),
  task: Type.String({
    description: "The specific investigation task or question for the child agent",
  }),
  context: Type.Optional(
    Type.String({
      description: "Optional background context or hints from the parent session",
    }),
  ),
});

export type DelegateParams = Static<typeof DelegateParamsSchema>;

export function createDelegateTool(): ToolDefinition<typeof DelegateParamsSchema, ExploreHandoff> {
  return {
    name: "aies_delegate",
    label: "AIES Delegate",
    description:
      "Delegate an investigation or exploration task to an isolated child agent. The child agent runs with fresh context and read-only tools, returning a concise structured handoff.",
    promptSnippet:
      "aies_delegate: Delegate an exploration task to an isolated child agent without polluting parent context.",
    promptGuidelines: [
      "Use aies_delegate when exploring the codebase, investigating questions, or checking files that would otherwise fill the context window.",
    ],
    parameters: DelegateParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const { role, task, context } = params;

      if (role !== "explore") {
        throw new Error(`Unsupported delegation role: "${role}". Only "explore" is supported.`);
      }

      const agentDir = getAgentDir();

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
    },
  };
}
