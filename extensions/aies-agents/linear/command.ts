/**
 * AIES-008: Command `/aies-ticket`.
 *
 * Provides a low-friction interactive command for developers in the Parent session:
 * - `/aies-ticket <id>`: Activates the requested Linear ticket and displays its contract.
 * - `/aies-ticket`: Displays the currently active ticket and its state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatCompactContract } from "./contract.ts";
import type { TicketManager } from "./manager.ts";

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

      if (!result.ok) {
        ctx.ui.notify(result.message ?? `Failed to activate ticket ${ticketId}.`, "error");
        return;
      }

      ctx.ui.notify(`Active ticket set to ${result.ticket?.identifier}:\n\n${result.contract}`, "info");
    },
  });
}
