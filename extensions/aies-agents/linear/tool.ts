/**
 * AIES-008: Tool definition for `aies_ticket`.
 *
 * Single controlled parent tool for Linear operations.
 * Exclusively available to Parent AgentSession (never children).
 *
 * Linear reachability is never assumed. An operation whose remote call the Parent
 * still has to perform is answered with the exact call to run, and a transport
 * that cannot be used is answered with an instruction that is real for the current
 * session mode.
 */

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { describeMcpDiagnostic, type McpDiagnostic } from "../mcp/integration.ts";
import { formatCompactContract } from "./contract.ts";
import type { TicketManager } from "./manager.ts";
import { readRemoteAnswer } from "./transport.ts";

export const TicketParamsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal("load"),
      Type.Literal("start"),
      Type.Literal("complete"),
      Type.Literal("block"),
      Type.Literal("comment"),
      Type.Literal("show"),
      Type.Literal("refresh"),
    ],
    {
      description:
        "The ticket action to perform: 'load' activates a ticket, 'start' marks work begun, 'complete' marks Done (requires valid fresh Verify PASS), 'block' marks blocked with evidence, 'comment' adds a compact note, 'show' displays the contract, and 'refresh' syncs remote status. Ignored when `remote` is present.",
    },
  ),
  ticketId: Type.Optional(
    Type.String({
      description: "The ticket identifier (e.g. 'EZE-123') to load.",
    }),
  ),
  evidence: Type.Optional(
    Type.String({
      description: "Evidence details when completing or reporting a blocker.",
    }),
  ),
  comment: Type.Optional(
    Type.String({
      description: "Optional compact comment body.",
    }),
  ),
  force: Type.Optional(
    Type.Boolean({
      description: "Force ticket switch even if another ticket is currently in progress.",
    }),
  ),
  remote: Type.Optional(
    Type.Any({
      description:
        "Answer to a pending Linear remote call: the value the `mcp` proxy tool returned for the call named in the directive. Pass it verbatim, optionally wrapped as { key, value }. Never invent it. When present, the pending action is resumed.",
    }),
  ),
});

export type TicketParams = Static<typeof TicketParamsSchema>;

/** Session mode as this tool needs it. Anything unknown is treated as headless. */
function sessionMode(ctx: { mode?: string } | undefined): string {
  return typeof ctx?.mode === "string" ? ctx.mode : "print";
}

function readMcpDiagnostic(details: unknown): McpDiagnostic | null {
  if (!details || typeof details !== "object") return null;
  const mcp = (details as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return null;
  const candidate = mcp as Partial<McpDiagnostic>;
  return typeof candidate.code === "string" && typeof candidate.usable === "boolean" && typeof candidate.server === "string"
    ? (candidate as McpDiagnostic)
    : null;
}

function readInstruction(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const instruction = (details as { instruction?: unknown }).instruction;
  return typeof instruction === "string" && instruction.trim() ? instruction : null;
}

export function createTicketTool(manager: TicketManager): ToolDefinition {
  return {
    name: "aies_ticket",
    label: "AIES Ticket",
    description:
      "Manage the active Linear work unit ticket for this session. The Parent session is the sole owner of Linear workflow. AIES does not speak MCP itself: you perform every Linear read and write with the `mcp` proxy tool. An action that needs the remote answers `remote_required` with the exact `mcp` call to run; run it, then repeat the same action with `remote` set to the value `mcp` returned. Use 'load' to activate an exact ticket, 'start' when beginning implementation, 'complete' to mark Done (strictly enforces valid fresh Verify PASS for behavior changes), 'block' to record a blocker with evidence, and 'show' to inspect the active ticket contract.",
    promptGuidelines: [
      "Linear is reached only through the `mcp` proxy tool: when `aies_ticket` answers `remote_required`, run the exact `mcp` call it names and repeat the same `aies_ticket` action with `remote` set to the value `mcp` returned. Never invent a value.",
    ],
    parameters: TicketParamsSchema,
    async execute(_toolCallId, params: TicketParams, _signal, _onUpdate, ctx) {
      const action = params.action;
      const mode = sessionMode(ctx);

      let result;
      if (params.remote !== undefined) {
        const answer = readRemoteAnswer(params.remote);
        result = await manager.submitRemote(answer.value, answer.key);
      } else {
        switch (action) {
          case "load": {
            if (!params.ticketId) {
              return {
                content: [{ type: "text" as const, text: "Error: ticketId parameter is required for action 'load'." }],
                details: { error: "missing_ticket_id" },
                isError: true,
              };
            }
            result = await manager.loadTicket(params.ticketId, { force: params.force });
            break;
          }

          case "start": {
            result = await manager.startWork();
            break;
          }

          case "complete": {
            result = await manager.completeTicket({
              evidence: params.evidence,
              comment: params.comment,
            });
            break;
          }

          case "block": {
            if (!params.evidence) {
              return {
                content: [{ type: "text" as const, text: "Error: evidence parameter is required when reporting a blocker." }],
                details: { error: "missing_evidence" },
                isError: true,
              };
            }
            result = await manager.blockTicket({
              evidence: params.evidence,
              comment: params.comment,
            });
            break;
          }

          case "comment": {
            if (!params.comment) {
              return {
                content: [{ type: "text" as const, text: "Error: comment parameter is required for action 'comment'." }],
                details: { error: "missing_comment" },
                isError: true,
              };
            }
            result = await manager.addComment(params.comment);
            break;
          }

          case "refresh": {
            result = await manager.refresh();
            break;
          }

          case "show":
          default: {
            const active = manager.getActiveTicket();
            if (!active) {
              return {
                content: [{ type: "text" as const, text: "No Linear ticket currently active in this session. Use action 'load' with a ticketId to activate one." }],
                details: { active: false },
                isError: false,
              };
            }
            const contract = formatCompactContract(active);
            const state = manager.getWorkState();
            return {
              content: [{ type: "text" as const, text: `Active Ticket [workState: ${state}]:\n\n${contract}` }],
              details: {
                active: true,
                ticket: active,
                workState: state,
              },
              isError: false,
            };
          }
        }
      }

      const active = manager.getActiveTicket();
      const workState = manager.getWorkState();

      if (!result.ok) {
        const diagnostic = readMcpDiagnostic(result.details);
        const instruction = readInstruction(result.details);
        const text = diagnostic
          ? describeMcpDiagnostic(diagnostic, { mode })
          : (instruction ?? result.message ?? `Ticket operation '${action}' failed: ${result.error}`);
        return {
          content: [{ type: "text" as const, text }],
          details: {
            error: result.error,
            ticket: active,
            workState,
            ...(result.directive ? { directive: result.directive } : {}),
            ...(diagnostic ? { mcp: diagnostic } : {}),
            ...(instruction ? { instruction } : {}),
          },
          isError: true,
        };
      }

      let responseText = result.message ?? `Ticket operation '${action}' succeeded.`;
      if (result.contract) {
        responseText += `\n\n${result.contract}`;
      }

      return {
        content: [{ type: "text" as const, text: responseText }],
        details: {
          ticket: active,
          workState,
          result,
        },
        isError: false,
      };
    },
  };
}
