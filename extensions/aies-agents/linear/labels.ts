/**
 * D33 phase 4: the human name of the ticket tracker, for the texts that name it.
 *
 * Linear stays the default, so an absent or unknown tracker reads "Linear" exactly as
 * before, and only a Plane ticket or a Plane server says "Plane". This is a leaf module
 * with no imports from the rest of the workflow, so the contract, the manager, the
 * prompts and the runtime can all read it without a cycle.
 */

/** The label of a tracker id. Absent or unknown is Linear, the default tracker (D33 item 1). */
export function trackerLabel(tracker: string | null | undefined): string {
  return tracker === "plane" ? "Plane" : "Linear";
}

/**
 * The label of the tracker an MCP server name stands for. `plane` is Plane; any other
 * server, including an absent one, keeps the Linear wording it always had.
 */
export function trackerLabelForServer(server: unknown): string {
  return typeof server === "string" && server.trim().toLowerCase() === "plane" ? "Plane" : "Linear";
}
