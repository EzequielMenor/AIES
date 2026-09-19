/**
 * Prompts that hand one Linear action to the Parent agent.
 *
 * AIES owns no MCP transport, so a command that cannot finish a Linear operation
 * on its own asks the Parent to do it through `aies_ticket`, which in turn names
 * the exact `mcp` proxy call the adapter needs.
 */

const REMOTE_STEP =
  "If aies_ticket answers remote_required, run exactly the mcp call it names and repeat the same aies_ticket call with `remote` set to the value mcp returned. Repeat until it reports the result.";

/** Load one ticket through the Parent, satisfying every remote directive. */
export function ticketLoadPrompt(ticketId: string): string {
  return [
    `Load Linear ticket ${ticketId} into this session.`,
    "",
    `1. Call aies_ticket with { action: "load", ticketId: "${ticketId}" }.`,
    `2. ${REMOTE_STEP}`,
    "",
    "Do not edit files and do not change the ticket status.",
  ].join("\n");
}

/** Load the ticket when needed, then start work, then let the workflow continue. */
export function ticketRunPrompt(ticketId: string, options: { alreadyActive?: boolean } = {}): string {
  const first = options.alreadyActive
    ? `1. Call aies_ticket with { action: "start" } for the already active ticket ${ticketId}.`
    : `1. Call aies_ticket with { action: "load", ticketId: "${ticketId}" }, then with { action: "start" }.`;
  return [
    `Start bounded autonomy on Linear ticket ${ticketId}.`,
    "",
    first,
    `2. ${REMOTE_STEP}`,
    "",
    "Then continue the AIES workflow for this ticket.",
  ].join("\n");
}
