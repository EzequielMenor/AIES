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
import { configuredTrackerLabel } from "./tracker.ts";
import type { TicketManager } from "./manager.ts";
import { describePendingFinalAction } from "./pending-action.ts";
import { ticketLoadPrompt, deliverAgentInstruction } from "./prompt.ts";

/** A missing transport is an error; missing authentication is a warning. */
function diagnosticLevel(code: string): "warning" | "error" {
  return code === "needs_auth" ? "warning" : "error";
}

/**
 * The user-only token that drops a held final step the user never asked for. It is a slash
 * command, so the model cannot send it: it is not an `aies_ticket` action and does not
 * change what `force` means.
 */
const CANCEL_PENDING_TOKEN = "cancel-pending";

/**
 * D46: the user-only declaration that the active ticket has no code to verify
 * (`/aies-ticket no-code <reason>`). Slash command, so the model cannot send it.
 */
const NO_CODE_TOKEN = "no-code";

export function registerTicketCommand(pi: ExtensionAPI, manager: TicketManager): void {
  pi.registerCommand("aies-ticket", {
    description: `Activate or show the active ${configuredTrackerLabel()} ticket for this session (/aies-ticket [ticketId] | cancel-pending | no-code <reason>)`,
    handler: async (args, ctx) => {
      const ticketId = args?.trim();

      if (ticketId === NO_CODE_TOKEN || ticketId?.startsWith(`${NO_CODE_TOKEN} `)) {
        const reason = ticketId.slice(NO_CODE_TOKEN.length).trim();
        const declared = manager.declareNoCodeException(reason);
        if (!declared) {
          ctx.ui.notify("Usage: /aies-ticket no-code <reason>. It needs an active ticket and a short justification.", "warning");
          return;
        }
        const snapshot = manager.toSnapshot();
        if (snapshot) {
          try {
            pi.appendEntry("aies-ticket", snapshot);
          } catch {}
        }
        ctx.ui.notify(
          `Recorded: ${declared.ticket} has no code to verify (${declared.reason}). ` +
            "A visible code change, or a failed, blocked or running Verify, still refuses Done.",
          "info",
        );
        return;
      }

      if (ticketId === CANCEL_PENDING_TOKEN) {
        const cancelled = manager.cancelPendingFinalAction();
        if (!cancelled) {
          ctx.ui.notify("No pending final action to cancel: nothing is held on the active ticket.", "info");
          return;
        }
        // Persist the cleared hold now, the same way the session snapshot is written at turn end.
        const snapshot = manager.toSnapshot();
        if (snapshot) {
          try {
            pi.appendEntry("aies-ticket", snapshot);
          } catch {}
        }
        ctx.ui.notify(
          `Cancelled the hold: ${describePendingFinalAction(cancelled)}. ` +
            "Verification, changed paths and the ticket are unchanged; the Done Gate still applies.",
          "info",
        );
        return;
      }

      if (!ticketId) {
        const active = manager.getActiveTicket();
        if (!active) {
          ctx.ui.notify(
            `No active ${configuredTrackerLabel()} ticket in this session. Activate one with /aies-ticket <id> (e.g. /aies-ticket EZE-123).`,
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

      const result = await manager.loadTicket(ticketId, { force });

      if (result.ok) {
        ctx.ui.notify(`Active ticket set to ${result.ticket?.identifier}:\n\n${result.contract}`, "info");
        return;
      }

      if (result.error === "remote_required") {
        // AIES cannot fetch Linear on its own: the Parent does it with the `mcp`
        // proxy tool, following the directive the tool returns. The instruction is
        // internal plumbing, so it travels hidden and never renders as user input.
        ctx.ui.notify(`Cargando ${ticketId} con el agente (llamada MCP de ${configuredTrackerLabel()})...`, "info");
        deliverAgentInstruction(pi, ticketLoadPrompt(ticketId, configuredTrackerLabel()));
        return;
      }

      ctx.ui.notify(result.message ?? `Failed to activate ticket ${ticketId}.`, "error");
    },
  });
}
