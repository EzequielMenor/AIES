/**
 * AIES-008: Tool definition for `aies_ticket`.
 *
 * Single controlled parent tool for Linear operations.
 * Exclusively available to Parent AgentSession (never children).
 */

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { formatCompactContract } from "./contract.ts";
import type { TicketManager } from "./manager.ts";

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
        "The ticket action to perform: 'load' activates a ticket, 'start' marks work begun, 'complete' marks Done (requires valid fresh Verify PASS), 'block' marks blocked with evidence, 'comment' adds a compact note, 'show' displays the contract, and 'refresh' syncs remote status.",
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
});

export type TicketParams = Static<typeof TicketParamsSchema>;

export function createTicketTool(manager: TicketManager): ToolDefinition {
  return {
    name: "aies_ticket",
    label: "AIES Ticket",
    description:
      "Manage the active Linear work unit ticket for this session. The Parent session is the sole owner of Linear workflow. Use 'load' to activate an exact ticket, 'start' when beginning implementation, 'complete' to mark Done (strictly enforces valid fresh Verify PASS for behavior changes), 'block' to record a blocker with evidence, and 'show' to inspect the active ticket contract.",
    parameters: TicketParamsSchema,
    async execute(_toolCallId, params: TicketParams, _signal, _onUpdate, _ctx) {
      const action = params.action;

      let result;
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

      const active = manager.getActiveTicket();
      const workState = manager.getWorkState();

      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: result.message ?? `Ticket operation '${action}' failed: ${result.error}` }],
          details: {
            error: result.error,
            ticket: active,
            workState,
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
