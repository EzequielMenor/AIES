import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DESIGN_CONTEXT = "aies-design-context";
const DESIGN_KICKOFF = "aies-design-kickoff";

const DONE_MARKER = "AIES_DESIGN_DONE";

const WORKFLOW = `AIES design workflow is active and opt-in for this objective only. First classify it as a new product, redesign, or improvement. Before asking product questions or proposing design, inspect the real project with the read-only tools you already have: structure, README and relevant docs, existing UI, styles, and assets. Report concrete findings, not filenames alone. Never ask the user something the project can answer. If, after that, relevant context is still missing or the project is too large to read directly, and the aies_delegate tool is available, delegate the discovery to it with role "explore"; otherwise keep reading yourself. Use that context to ask only unresolved product questions, then propose an appropriately scoped design. Do not create a full design system. Stay within the design objective; do not modify files unless explicitly asked. Stop immediately when the user cancels or exits. When you have delivered the proposal and are not waiting for an answer, end your final message with a last line containing exactly ${DONE_MARKER}; that closes the workflow. Completion or cancellation ends this workflow; ordinary session behavior must resume without design instructions.`;

/** The text of an assistant message, whatever shape its content has. */
function assistantText(message: unknown): string {
  const record = message as { role?: string; content?: unknown } | undefined;
  if (record?.role !== "assistant") return "";
  if (typeof record.content === "string") return record.content;
  if (!Array.isArray(record.content)) return "";
  return record.content
    .map((part) => (part && typeof part === "object" && (part as { type?: string }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

export default function aiesDesign(pi: ExtensionAPI): void {
  let active = false;
  let workflowId: string | undefined;

  function stop(): void {
    active = false;
    workflowId = undefined;
  }

  function cancel(ctx: { isIdle(): boolean; abort(): void }): void {
    stop();
    if (!ctx.isIdle()) ctx.abort();
  }

  function isTextCancellation(text: string): boolean {
    return /^(?:cancel|cancel design|stop design|exit design|finish design(?: workflow)?)$/i.test(text.trim());
  }

  pi.registerCommand("aies-design", {
    description: "Start an opt-in design workflow, or use cancel/exit/complete to finish",
    handler: async (args, ctx) => {
      const value = args?.trim() ?? "";
      const action = value.toLowerCase();
      if (["cancel", "exit", "complete", "done"].includes(action)) {
        if (active) {
          cancel(ctx);
          ctx.ui.notify("Flujo de diseño finalizado. La sesión normal continúa.", "info");
        } else {
          ctx.ui.notify("No hay un flujo de diseño activo.", "info");
        }
        return;
      }

      if (!value) {
        ctx.ui.notify("Indica el objetivo: /aies-design <objetivo> (o cancel/exit/complete).", "info");
        return;
      }

      if (active) cancel(ctx);
      active = true;
      workflowId = randomUUID();
      const current = workflowId;
      const kickoff = {
        customType: DESIGN_KICKOFF,
        content: `Objetivo de diseño: ${value}\n\n${WORKFLOW}`,
        display: true,
        details: { workflowId: current },
      };
      // Each kickoff belongs only to its workflow: context drops any kickoff whose
      // id is not the active one. An idle session starts the turn now. A busy one
      // must not get a queued follow-up: an extension cannot withdraw it, so a
      // cancel would still be followed by a turn. It rides along with the next
      // user message instead, which no cancel can turn into a residual turn.
      if (ctx.isIdle()) {
        pi.sendMessage(kickoff, { triggerTurn: true });
      } else {
        pi.sendMessage(kickoff, { deliverAs: "nextTurn" });
        ctx.ui.notify("Flujo de diseño preparado: empezará con tu próximo mensaje.", "info");
      }
    },
  });

  pi.on("input", (event, ctx) => {
    if (!active || !isTextCancellation(event.text)) return;
    cancel(ctx);
    ctx.ui.notify("Flujo de diseño finalizado. La sesión normal continúa.", "info");
    return { action: "handled" };
  });

  // Closing is the model's call, made explicit: the proposal's last line carries
  // the marker. Anything else (a quoted instruction, a mid-text mention) is ignored.
  pi.on("agent_end", (event, ctx) => {
    if (!active) return;
    const messages = (event as { messages?: unknown[] }).messages ?? [];
    const last = [...messages].reverse().find((message) => assistantText(message).trim() !== "");
    if (!last || !new RegExp(`(?:^|\\n)${DONE_MARKER}\\s*$`).test(assistantText(last))) return;
    stop();
    ctx.ui.notify("Flujo de diseño completado. La sesión normal continúa.", "info");
  });

  pi.on("before_agent_start", () => {
    if (!active || workflowId === undefined) return;
    return {
      message: {
        customType: DESIGN_CONTEXT,
        content: WORKFLOW,
        display: false,
        details: { workflowId },
      },
    };
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter((message) => {
      const custom = message as { customType?: string; details?: { workflowId?: string } };
      if (custom.customType !== DESIGN_CONTEXT && custom.customType !== DESIGN_KICKOFF) return true;
      return active && custom.details?.workflowId === workflowId;
    });
    return messages.length === event.messages.length ? undefined : { messages };
  });

  pi.on("session_start", () => stop());
  pi.on("session_shutdown", () => stop());
}
