/**
 * AIES-008: Command `/aies-ticket`.
 *
 * Provides a low-friction interactive command for developers in the Parent session:
 * - `/aies-ticket <id>`: Activates the requested Linear ticket and displays its contract.
 * - `/aies-ticket`: Displays the currently active ticket and its state.
 *
 * When the ticket cannot be fetched in-process, the command hands the Linear call to
 * the Parent instead of failing with a directive the user cannot act on.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { describeMcpDiagnostic } from "../mcp/integration.ts";
import { formatCompactContract } from "./contract.ts";
import type { TicketManager } from "./manager.ts";
import { ticketLoadPrompt } from "./prompt.ts";

/** A missing transport is an error; missing authentication is a warning. */
function diagnosticLevel(code: string): "warning" | "error" {
  return code === "needs_auth" ? "warning" : "error";
}

export function registerTicketCommand(pi: ExtensionAPI, manager: TicketManager): void {
  pi.registerCommand("aies-ticket", {
    description: "Activate or show the active Linear ticket for this session (/aies-ticket [ticketId])",
    handler: async (args, ctx) => {
      const ticketId = args?.trim();

      if (!ticketId) {
        const active = manager.getActiveTicket();
        if (!active) {
          ctx.ui.notify(
            "No active Linear ticket in this session. Activate one with /aies-ticket <id> (e.g. /aies-ticket EZE-123).",
            "info",
          );
          return;
        }

        const contract = formatCompactContract(active);
        const workState = manager.getWorkState();
        ctx.ui.notify(`Active Ticket [${workState}]:\n\n${contract}`, "info");
        return;
      }

      const diagnostic = manager.getMcpDiagnostic();
      if (diagnostic && !diagnostic.usable) {
        ctx.ui.notify(describeMcpDiagnostic(diagnostic, { mode: ctx.mode }), diagnosticLevel(diagnostic.code));
        return;
      }

      // Check if ticket is in progress and prompt confirmation if UI available
      const current = manager.getActiveTicket();
      const currentWorkState = manager.getWorkState();
      let force = false;

      if (
        current &&
        current.identifier !== ticketId &&
        (currentWorkState === "working" || currentWorkState === "verification_required")
      ) {
        if (ctx.hasUI && ctx.ui.confirm) {
          const confirmed = await ctx.ui.confirm(
            "Switch Active Ticket",
            `Ticket ${current.identifier} is currently in progress (${currentWorkState}). Do you want to switch to ${ticketId}?`,
          );
          if (!confirmed) {
            ctx.ui.notify(`Switch to ${ticketId} cancelled. Current ticket remains ${current.identifier}.`, "info");
            return;
          }
          force = true;
        }
      }

      ctx.ui.notify(`Loading Linear ticket ${ticketId}...`, "info");
      const result = await manager.loadTicket(ticketId, { force });

      if (result.ok) {
        ctx.ui.notify(`Active ticket set to ${result.ticket?.identifier}:\n\n${result.contract}`, "info");
        return;
      }

      if (result.error === "remote_required") {
        // AIES cannot fetch Linear on its own: the Parent does it with the `mcp`
        // proxy tool, following the directive the tool returns.
        ctx.ui.notify(`Cargando ${ticketId} con el agente (llamada MCP de Linear)...`, "info");
        pi.sendUserMessage(ticketLoadPrompt(ticketId), { deliverAs: "followUp" });
        return;
      }

      ctx.ui.notify(result.message ?? `Failed to activate ticket ${ticketId}.`, "error");
    },
  });
}
