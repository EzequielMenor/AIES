/**
 * Plane fixtures in the shape the hosted Plane MCP server returns (D33, verified
 * by reading only). Shared by the D33 phase 3 offline tests; nothing here touches
 * the network or a credential.
 */

export const PLANE_PROJECT = Object.freeze({
  id: "5b2f0c1e-7d3a-4f6b-9a8e-1c2d3e4f5a6b",
  identifier: "AIES",
  name: "AIES",
});

/** Default workflow states of a Plane project, with UUIDs and groups as Plane reports them. */
export const PLANE_STATES = Object.freeze([
  { id: "c0a1f000-0000-4000-8000-000000000001", name: "Backlog", group: "backlog" },
  { id: "c0a1f000-0000-4000-8000-000000000002", name: "Todo", group: "unstarted" },
  { id: "c0a1f000-0000-4000-8000-000000000003", name: "In Progress", group: "started" },
  { id: "c0a1f000-0000-4000-8000-000000000004", name: "Done", group: "completed" },
  { id: "c0a1f000-0000-4000-8000-000000000005", name: "Cancelled", group: "cancelled" },
]);

export const PLANE_WORKITEM_UUID = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";

export function planeState(name) {
  const state = PLANE_STATES.find((candidate) => candidate.name === name);
  if (!state) throw new Error(`fixture has no Plane state named ${name}`);
  return { ...state };
}

/** A `workitem retrieve_by_identifier` answer with `expand=state,project`. */
export function planeWorkItem({
  sequence = 38,
  title = "Map the Plane work item contract",
  stateName = "Todo",
  description = "## Acceptance Criteria\n- [ ] Plane identity is PROJECT-N\n- [ ] Done Gate holds on Plane\n",
  project = PLANE_PROJECT,
} = {}) {
  return {
    id: PLANE_WORKITEM_UUID,
    sequence_id: sequence,
    name: title,
    description_html: `<p>${description.split("\n")[0]}</p>`,
    description_stripped: description,
    priority: "none",
    project: { ...project },
    state: planeState(stateName),
  };
}

/** A `state list` answer: `results[]` with the fields Plane returns. */
export function planeStateList() {
  return {
    results: PLANE_STATES.map((state, index) => ({
      ...state,
      project: PLANE_PROJECT.id,
      sequence: (index + 1) * 10000,
      default: state.name === "Todo",
    })),
  };
}

/** The exact `mcp` arguments the retrieve call must carry. */
export function planeRetrieveArgs(identifier) {
  return { action: "retrieve_by_identifier", workitem_identifier: identifier, expand: "state,project" };
}
