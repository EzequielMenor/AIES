/**
 * AIES-009: Command `/aies-run`.
 *
 * Provides a minimal, low-friction entry point for bounded task autonomy:
 * - `/aies-run <ticketId>`: Loads ticket, starts work, and enables bounded continuation.
 * - `/aies-run stop`: Disables autonomy immediately.
 * - `/aies-run status`: Displays the current autonomy state.
 * - `/aies-run`: Toggles or starts autonomy on the currently active ticket.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { TicketManager } from "../linear/manager.ts";
import { ticketRunPrompt, deliverAgentInstruction } from "../linear/prompt.ts";
import { describeMcpDiagnostic } from "../mcp/integration.ts";
import type { ContinuationController } from "./controller.ts";
import { AIES_CONTINUATION_PROMPT } from "./policy.ts";
import {
  applyAutonomySync,
  applyModel,
  applyTicketObservationSync,
  createState,
  toSnapshot,
} from "../../aies-runtime/state.ts";
import { renderAutonomyStatus } from "../../aies-ui/summary.ts";

/**
 * The same projection the runtime observer maintains: autonomy state from the
 * controller, the ticket from the manager, the model from the command context.
 * Verification is not available in this file, so its section is omitted rather
 * than guessed.
 */
function autonomyStatusSnapshot(
  controller: ContinuationController,
  ticketManager: TicketManager,
  ctx: ExtensionContext,
): ReturnType<typeof toSnapshot> {
  const now = Date.now();
  let state = createState(now);
  state = applyModel(state, ctx.model);

  const autonomy = controller.getState();
  state = applyAutonomySync(state, {
    enabled: autonomy.enabled,
    ticketId: autonomy.ticketId,
    continuationCount: autonomy.continuationCount,
    stopReason: autonomy.stopReason,
    lastStep: autonomy.lastStepDescription,
  });

  const active = ticketManager.getActiveTicket();
  if (active) {
    state = applyTicketObservationSync(state, {
      active: true,
      identifier: active.identifier,
      title: active.title,
      status: active.status,
      workState: ticketManager.getWorkState(),
    });
  }

  return toSnapshot(state);
}

export function registerAutonomyCommand(
  pi: ExtensionAPI,
  controller: ContinuationController,
  ticketManager: TicketManager,
): void {
  pi.registerCommand("aies-run", {
    description: "Run bounded autonomy workflow on active or specified Linear ticket (/aies-run [ticketId | stop | status])",
    handler: async (args, ctx) => {
      const rawArg = args?.trim();

      // Case 1: `/aies-run stop`
      if (rawArg?.toLowerCase() === "stop") {
        controller.stop("user_stopped");
        ctx.ui.notify("Autonomía AIES detenida por el usuario.", "info");
        return;
      }

      // Case 2: `/aies-run status`
      if (rawArg?.toLowerCase() === "status") {
        ctx.ui.notify(renderAutonomyStatus(autonomyStatusSnapshot(controller, ticketManager, ctx)), "info");
        return;
      }

      // Case 3: `/aies-run` without arguments (toggle or start on active ticket)
      if (!rawArg) {
        const active = ticketManager.getActiveTicket();
        if (!active) {
          ctx.ui.notify(
            "No hay ningún ticket activo. Usa /aies-run <id> (ej. /aies-run EZE-123) para iniciar.",
            "info",
          );
          return;
        }

        if (controller.isEnabled()) {
          controller.stop("user_stopped");
          ctx.ui.notify(`Autonomía detenida para ${active.identifier}.`, "info");
          return;
        }

        const startRes = await ticketManager.startWork();
        if (!startRes.ok) {
          ctx.ui.notify(`No se pudo iniciar el trabajo en ${active.identifier}: ${startRes.message}`, "error");
          return;
        }

        controller.enable(active.identifier);
        deliverAgentInstruction(pi, AIES_CONTINUATION_PROMPT);
        return;
      }

      // Case 4: `/aies-run <ticketId>`
      const ticketId = rawArg;

      const diagnostic = ticketManager.getMcpDiagnostic();
      if (diagnostic && !diagnostic.usable) {
        ctx.ui.notify(
          describeMcpDiagnostic(diagnostic, { mode: ctx.mode }),
          diagnostic.code === "needs_auth" ? "warning" : "error",
        );
        return;
      }

      const current = ticketManager.getActiveTicket();
      let loaded = Boolean(current && current.identifier === ticketId);

      if (!loaded) {
        const loadRes = await ticketManager.loadTicket(ticketId);
        if (loadRes.ok) {
          loaded = true;
        } else if (loadRes.error !== "remote_required") {
          ctx.ui.notify(`Error al cargar ${ticketId}: ${loadRes.message}`, "error");
          return;
        }
      }

      if (loaded) {
        const startRes = await ticketManager.startWork();
        if (startRes.ok) {
          controller.enable(ticketId);
          deliverAgentInstruction(pi, AIES_CONTINUATION_PROMPT);
          return;
        }
        if (startRes.error !== "remote_required") {
          ctx.ui.notify(`Error al iniciar ${ticketId}: ${startRes.message}`, "error");
          return;
        }
      }

      // A Linear call needs the Parent: hand it the load + start sequence and let
      // the autonomy workflow continue once the ticket is active. The instruction
      // travels hidden, so the transcript never shows internal plumbing as input.
      controller.enable(ticketId);
      deliverAgentInstruction(pi, ticketRunPrompt(ticketId, { alreadyActive: loaded }));
    },
  });
}
