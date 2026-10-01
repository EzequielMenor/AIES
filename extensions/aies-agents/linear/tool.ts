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
        "Fallback answer to a pending Linear remote call: the value the `mcp` proxy tool returned for the call named in the directive. AIES normally captures that result automatically and resumes the action, so you rarely need this; pass it verbatim only when the action is not resumed on its own, optionally wrapped as { key, value }. Never invent it.",
    }),
  ),
});

export type TicketParams = Static<typeof TicketParamsSchema>;

/**
 * Presentation only (AIES-010B). These helpers project structured args/details
 * into one compact Spanish row and expose the original text on expansion. They
 * never touch execution, `content`, `details`, error flags or the schema.
 */

/** Minimal structural `Component`: Pi renders whatever `render(width)` returns. */
interface ToolRowComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** A row that occupies no space, so Pi hides the tool line entirely. */
const EMPTY_ROW: ToolRowComponent = { render: () => [], invalidate() {} };

function textRow(text: string): ToolRowComponent {
  const lines = text.length > 0 ? text.split("\n") : [];
  return { render: () => lines, invalidate() {} };
}

/** The slice of Pi's theme this projection uses; colors always come from the host. */
interface RowTheme {
  fg(color: string, text: string): string;
}

const TICKET_ACTION_VERB: Record<string, string> = {
  load: "cargando",
  start: "iniciando",
  complete: "completando",
  block: "bloqueando",
  comment: "comentando",
  show: "mostrando",
  refresh: "actualizando",
};

const TICKET_ACTION_DONE: Record<string, string> = {
  load: "cargado",
  start: "iniciado",
  complete: "completado",
  block: "bloqueado",
  comment: "comentado",
  show: "mostrado",
  refresh: "actualizado",
};

/**
 * Collapsed rows are AIES-owned copy, so an internal code never reaches the user.
 * Every code the workflow or the transport can emit maps to one short Spanish phrase.
 */
const TICKET_ERROR_MESSAGE: Record<string, string> = {
  // Validation
  missing_ticket_id: "falta el ID del ticket",
  missing_evidence: "falta la evidencia",
  missing_comment: "falta el comentario",
  empty_comment: "el comentario está vacío",
  invalid_id: "ID de ticket inválido",
  unsupported_action: "acción no soportada",
  // MCP, auth, network and permissions
  mcp_unavailable: "MCP no disponible",
  auth_unavailable: "autenticación requerida",
  network_failure: "falló la red",
  permission_denied: "sin permisos",
  // Ticket state
  not_found: "ticket no encontrado",
  invalid_remote_payload: "respuesta inválida de Linear",
  invalid_transition: "transición inválida",
  remote_conflict: "conflicto remoto",
  no_pending_remote: "sin operación pendiente",
  remote_mismatch: "respuesta para otra petición",
  no_active_ticket: "no hay ticket activo",
  ticket_in_progress: "otro ticket en curso",
  verify_gate_denied: "verificación denegada",
  sync_error: "error de sincronización",
  comment_failed: "no se pudo comentar",
  refresh_failed: "no se pudo actualizar",
};

/** Safe fallback: an unknown or future code never becomes the visible row. */
const TICKET_ERROR_FALLBACK = "falló la operación";

/**
 * The runtime owns the single DONE/BLOCKED summary card, so a successful terminal
 * action must not make the Parent write a second human-facing report. This concise
 * model-visible instruction is appended only to a successful `complete`/`block`
 * result; it never alters the structured details or the manager's own semantics.
 */
const TICKET_TERMINAL_STOP_INSTRUCTION =
  "AIES runtime owns the only DONE/BLOCKED summary. End the turn now with no user-facing completion or blocker prose.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The ticket identity: call args first, structured details second. */
function ticketIdentifier(args: Record<string, unknown>, details: unknown): string | undefined {
  const fromArgs = nonEmptyString(args.ticketId);
  if (fromArgs) return fromArgs;
  const ticket = asRecord(asRecord(details)?.ticket);
  return ticket ? nonEmptyString(ticket.identifier) : undefined;
}

function ticketAction(args: Record<string, unknown>): string {
  return nonEmptyString(args.action) ?? "show";
}

/** The pending line: one short row while the operation is in flight. */
function ticketPendingRow(args: Record<string, unknown>, theme: RowTheme): string {
  const id = ticketIdentifier(args, undefined);
  const verb = TICKET_ACTION_VERB[ticketAction(args)] ?? "consultando";
  const label = id ? `${id} · ${verb}` : `Linear · ${verb}`;
  return theme.fg("warning", `⟳ ${label}…`);
}

/** The Parent-mediated handoff: a compact Linear row, never an error dump. */
function ticketHandoffRow(details: Record<string, unknown>, theme: RowTheme): string {
  const directive = asRecord(details.directive);
  const tool = directive ? nonEmptyString(directive.tool) : undefined;
  return theme.fg("accent", tool ? `→ Linear · ${tool}` : "→ Linear");
}

/**
 * A real ticket error stays visible when collapsed; the detail lives in the
 * expanded view. The row always speaks Spanish: known codes are mapped, any
 * other code degrades to a safe phrase instead of printing the raw identifier.
 */
function ticketErrorRow(args: Record<string, unknown>, details: Record<string, unknown>, theme: RowTheme): string {
  const id = ticketIdentifier(args, details);
  const code = nonEmptyString(details.error);
  const message = (code && TICKET_ERROR_MESSAGE[code]) || TICKET_ERROR_FALLBACK;
  return theme.fg("error", `✗ ${id ? `${id} · ` : ""}${message}`);
}

/** The normal collapsed flow: identity, action and outcome, never the contract. */
function ticketDoneRow(args: Record<string, unknown>, details: Record<string, unknown>, theme: RowTheme): string {
  if (details.active === false) return theme.fg("muted", "Linear · sin ticket activo");
  const id = ticketIdentifier(args, details);
  const done = TICKET_ACTION_DONE[ticketAction(args)] ?? "listo";
  return theme.fg("success", `✓ ${id ? `${id} · ` : ""}${done}`);
}

/** The complete text Pi handed back, unchanged. */
function resultText(result: { content?: ReadonlyArray<{ type?: string; text?: string }> }): string {
  const parts: string[] = [];
  for (const block of result?.content ?? []) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

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
      "Manage the active Linear work unit ticket for this session. The Parent session is the sole owner of Linear workflow. AIES does not speak MCP itself: you perform every Linear read and write with the `mcp` proxy tool. An action that needs the remote answers `remote_required` with the exact `mcp` call to run; run it and AIES captures the result automatically and resumes the action, so you do not have to copy the value back. Only if an action is not resumed on its own should you repeat it with `remote` set to the value `mcp` returned (fallback). Use 'load' to activate an exact ticket, 'start' when beginning implementation, 'complete' to mark Done (strictly enforces valid fresh Verify PASS for behavior changes), 'block' to record a blocker with evidence, and 'show' to inspect the active ticket contract.",
    promptGuidelines: [
      "Linear is reached only through the `mcp` proxy tool: when `aies_ticket` answers `remote_required`, run exactly the `mcp` call it names; AIES captures that result automatically and resumes the pending action, so do not re-pass it. Only as a fallback, if the action is not resumed, repeat the same `aies_ticket` action with `remote` set to the value `mcp` returned. Never invent a value.",
    ],
    renderShell: "self",
    renderCall(args, theme, context) {
      // While the operation is in flight, one short pending row. Once settled, the
      // result slot carries the whole flow so the call chrome disappears.
      if (context?.isPartial === false) return EMPTY_ROW;
      return textRow(ticketPendingRow(args as Record<string, unknown>, theme as unknown as RowTheme));
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const args = (context?.args ?? {}) as Record<string, unknown>;
      const paint = theme as unknown as RowTheme;
      if (isPartial) return textRow(ticketPendingRow(args, paint));
      if (expanded) return textRow(resultText(result));

      const details = asRecord(result.details);
      const error = details ? nonEmptyString(details.error) : undefined;
      if (error) {
        return textRow(
          error === "remote_required" ? ticketHandoffRow(details!, paint) : ticketErrorRow(args, details!, paint),
        );
      }
      // A host-level thrown error arrives as `details: {}` with the render context
      // flag set. It must stay visible: only a proven non-error terminal result may
      // collapse, or an unexpected fault would disappear behind the runtime card.
      if (context?.isError === true) return textRow(ticketErrorRow(args, details ?? {}, paint));
      // A successful terminal action collapses to nothing: the runtime DONE/BLOCKED
      // summary card is the sole normal owner of that headline. Errors above and the
      // expanded raw output stay visible and unchanged.
      const action = ticketAction(args);
      if (action === "complete" || action === "block") return EMPTY_ROW;
      return textRow(ticketDoneRow(args, details ?? {}, paint));
    },
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
      if (action === "complete" || action === "block") {
        responseText += `\n\n${TICKET_TERMINAL_STOP_INSTRUCTION}`;
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
