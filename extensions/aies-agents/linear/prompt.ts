/**
 * Prompts that hand one internal AIES action to the Parent agent, plus the one
 * delivery helper every such hand-off shares.
 *
 * AIES owns no MCP transport, so a command that cannot finish a Linear operation
 * on its own asks the Parent to do it through `aies_ticket`, which in turn names
 * the exact `mcp` proxy call the adapter needs.
 *
 * These are internal instructions, never user input: they travel through Pi's
 * public custom-message path with `display: false`, so the model still sees them
 * and the turn still runs while the human transcript stays clean.
 */

const REMOTE_STEP =
  "If aies_ticket answers remote_required, run the exact mcp call it names; AIES captures the result automatically, so pass `remote` only as a fallback.";

/** Load one ticket through the Parent, satisfying every remote directive. */
export function ticketLoadPrompt(ticketId: string): string {
  return [
    `Load Linear ticket ${ticketId}: call aies_ticket with { action: "load", ticketId: "${ticketId}" }.`,
    REMOTE_STEP,
    "Do not edit files or change ticket status.",
  ].join(" ");
}

/**
 * Pi custom-message type for every internal AIES instruction. Custom messages
 * participate in LLM context; `display: false` keeps them out of the transcript.
 */
export const AIES_INSTRUCTION_TYPE = "aies-instruction";

/** The slice of the public Pi API this delivery needs. */
export interface InstructionDelivery {
  /** Pi 0.86.1 public hidden custom-message path, with turn control. */
  sendMessage?(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): unknown;
  /** Public user-message path; renders as user input, used only as a fallback. */
  sendUserMessage?(content: string, options?: { deliverAs?: "steer" | "followUp" }): unknown;
}

/**
 * Hand one internal instruction to the Parent model without rendering it as
 * ordinary user input. Pi 0.86.1's public `sendMessage` custom-message path keeps
 * the content in LLM context and `triggerTurn` keeps the continuation a real
 * turn, while `display: false` keeps it out of the human transcript.
 *
 * Prefers the hidden path. Only when the host predates it falls back to the
 * previous public user message, so bounded autonomy still runs on an older host;
 * AIES never invents a private interception. Returns whether an instruction was
 * delivered.
 */
export function deliverAgentInstruction(pi: InstructionDelivery | undefined, content: string): boolean {
  if (pi && typeof pi.sendMessage === "function") {
    try {
      pi.sendMessage(
        { customType: AIES_INSTRUCTION_TYPE, content, display: false, details: { kind: "instruction" } },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      return true;
    } catch {
      return false;
    }
  }

  if (pi && typeof pi.sendUserMessage === "function") {
    try {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/** Load the ticket when needed, then start work, then let the workflow continue. */
export function ticketRunPrompt(ticketId: string, options: { alreadyActive?: boolean } = {}): string {
  const first = options.alreadyActive
    ? `call aies_ticket with { action: "start" }`
    : `call aies_ticket with { action: "load", ticketId: "${ticketId}" }, then with { action: "start" }`;
  return [
    `Start bounded autonomy on Linear ticket ${ticketId}:`,
    `${first}.`,
    REMOTE_STEP,
    "Then continue the AIES workflow for this ticket.",
  ].join(" ");
}
