/**
 * D33 phase 3: the Plane tracker transport, mediated by the Parent, fully offline.
 *
 * (a) FakePlaneTransport passes the same TrackerTransport contract as Linear.
 * (b) HostMediatedPlaneTransport emits the exact `mcp` directives for the server
 *     `plane` and reads the answers the Parent hands back, in the verified shape.
 * (c) Identity is `PROJECT-N`; a work item UUID is never an identity (D33 item 7).
 * (d) Writes carry the state UUID, the comment is HTML-escaped and `cancelled` is
 *     the Plane spelling of a cancelled group.
 *
 * No network, no credential and no real Plane ticket: every answer is a fixture.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizePlaneStates, normalizePlaneWorkItem } from "../extensions/aies-agents/linear/contract.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import {
  FakePlaneTransport,
  HostMediatedPlaneTransport,
  PLANE_MCP_SERVER,
} from "../extensions/aies-agents/linear/plane-transport.ts";
import { PLANE_TRACKER } from "../extensions/aies-agents/linear/tracker.ts";
import { isLinearRemoteRequired, linearRemoteKey } from "../extensions/aies-agents/linear/transport.ts";
import { createVerificationState } from "../extensions/aies-agents/verification.ts";
import {
  PLANE_PROJECT,
  PLANE_WORKITEM_UUID,
  planeRetrieveArgs,
  planeState,
  planeStateList,
  planeWorkItem,
} from "./helpers/plane-fixtures.mjs";
import { runTrackerTransportContract } from "./helpers/tracker-transport-contract.mjs";

const PLANE_SELECTION = () => ({ ok: true, tracker: PLANE_TRACKER });

/** The directive a pending call raises, or a test failure when the call did not need the Parent. */
async function directiveOf(promise) {
  try {
    await promise;
  } catch (error) {
    if (isLinearRemoteRequired(error)) return error.directive;
    throw error;
  }
  assert.fail("expected the call to require a remote answer");
}

async function rejectionOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the call to reject");
}

function answersWith(entries) {
  const answers = {};
  for (const [tool, args, value] of entries) {
    answers[linearRemoteKey(PLANE_MCP_SERVER, tool, args)] = value;
  }
  return answers;
}

runTrackerTransportContract("FakePlaneTransport", () => {
  const transport = new FakePlaneTransport();
  return {
    transport,
    seed: (issue) =>
      transport.seedIssue({
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        state: issue.state?.name,
        project: issue.project,
      }),
  };
});

describe("D33 phase 3: HostMediatedPlaneTransport directives", () => {
  it("names the exact retrieve call for a PROJECT-N identifier", async () => {
    const transport = new HostMediatedPlaneTransport({});
    const directive = await directiveOf(transport.getIssue("AIES-38"));
    assert.equal(directive.server, "plane");
    assert.equal(directive.tool, "workitem");
    assert.deepEqual(directive.args, {
      action: "retrieve_by_identifier",
      workitem_identifier: "AIES-38",
      expand: "state,project",
    });
    assert.equal(directive.key, 'plane:workitem(action="retrieve_by_identifier",expand="state,project",workitem_identifier="AIES-38")');
  });

  it("names the state list call with the project UUID", async () => {
    const transport = new HostMediatedPlaneTransport({});
    const directive = await directiveOf(transport.getStatuses(PLANE_PROJECT.id));
    assert.equal(directive.server, "plane");
    assert.equal(directive.tool, "state");
    assert.deepEqual(directive.args, { action: "list", project_id: PLANE_PROJECT.id });
  });

  it("refuses a project reference that is not a Plane UUID instead of sending it", async () => {
    const transport = new HostMediatedPlaneTransport({});
    const error = await rejectionOf(transport.getStatuses("AIES"));
    assert.equal(error.code, "mcp_unavailable");
    assert.equal(isLinearRemoteRequired(error), false);
  });

  it("writes the state UUID, changing only the state", async () => {
    const answers = answersWith([["workitem", planeRetrieveArgs("AIES-38"), planeWorkItem()]]);
    const transport = new HostMediatedPlaneTransport(answers);
    const inProgress = planeState("In Progress");
    const directive = await directiveOf(transport.updateIssue("AIES-38", { statusId: inProgress.id }));
    assert.equal(directive.tool, "workitem");
    assert.deepEqual(directive.args, {
      action: "update",
      project_id: PLANE_PROJECT.id,
      workitem_id: PLANE_WORKITEM_UUID,
      state: inProgress.id,
    });
  });

  it("resolves a state name to its UUID through the state list before the update", async () => {
    const answers = answersWith([
      ["workitem", planeRetrieveArgs("AIES-38"), planeWorkItem()],
      ["state", { action: "list", project_id: PLANE_PROJECT.id }, planeStateList()],
    ]);
    const transport = new HostMediatedPlaneTransport(answers);
    const directive = await directiveOf(transport.updateIssue("AIES-38", { statusId: "In Progress" }));
    assert.equal(directive.tool, "workitem");
    assert.equal(directive.args.state, planeState("In Progress").id);
    assert.notEqual(directive.args.state, "In Progress", "a name must never reach Plane as a state");
  });

  it("rejects an unknown state name without sending a write", async () => {
    const answers = answersWith([
      ["workitem", planeRetrieveArgs("AIES-38"), planeWorkItem()],
      ["state", { action: "list", project_id: PLANE_PROJECT.id }, planeStateList()],
    ]);
    const transport = new HostMediatedPlaneTransport(answers);
    const error = await rejectionOf(transport.updateIssue("AIES-38", { statusId: "Shipped" }));
    assert.equal(error.code, "invalid_transition");
    assert.equal(isLinearRemoteRequired(error), false);
  });

  it("sends a comment as escaped HTML inside one paragraph, with the work item UUID", async () => {
    const answers = answersWith([["workitem", planeRetrieveArgs("AIES-38"), planeWorkItem()]]);
    const transport = new HostMediatedPlaneTransport(answers);
    const body = '<b>x</b> & "q" \'s\'\nsecond line';
    const directive = await directiveOf(transport.addComment("AIES-38", body));
    assert.equal(directive.tool, "workitem_comment");
    assert.deepEqual(directive.args, {
      action: "create",
      project_id: PLANE_PROJECT.id,
      workitem_id: PLANE_WORKITEM_UUID,
      comment_html: "<p>&lt;b&gt;x&lt;/b&gt; &amp; &quot;q&quot; &#39;s&#39;<br>second line</p>",
    });
  });

  it("refuses a comment on a ticket whose retrieve answer is missing, instead of guessing ids", async () => {
    const transport = new HostMediatedPlaneTransport({});
    const directive = await directiveOf(transport.addComment("AIES-38", "note"));
    assert.equal(directive.tool, "workitem", "the Parent must first retrieve the work item");
    assert.equal(directive.args.action, "retrieve_by_identifier");
  });
});

describe("D33 phase 3: identity is PROJECT-N, never a UUID (D33 item 7, amends D22)", () => {
  it("builds the human identity from project.identifier and sequence_id", () => {
    const normalized = normalizePlaneWorkItem(planeWorkItem({ sequence: 38 }));
    assert.equal(normalized.identifier, "AIES-38");
    assert.equal(normalized.id, "AIES-38", "the normalized id is the human key, never the UUID");
    assert.equal(normalized.planeId, PLANE_WORKITEM_UUID, "the work item UUID stays as an internal field");
    assert.equal(normalized.planeProjectId, PLANE_PROJECT.id);
  });

  it("returns an identity-less payload when only a UUID is present", () => {
    const normalized = normalizePlaneWorkItem({
      id: PLANE_WORKITEM_UUID,
      name: "No human key",
      project: { id: PLANE_PROJECT.id, name: "AIES" },
    });
    assert.equal(normalized.identifier, "");
    assert.equal(normalized.id, "", "the UUID must not become the identity");
  });

  it("refuses to load a work item by UUID before any remote call", async () => {
    const transport = new HostMediatedPlaneTransport({});
    const error = await rejectionOf(transport.getIssue(PLANE_WORKITEM_UUID));
    assert.equal(error.code, "invalid_remote_payload");
    assert.equal(isLinearRemoteRequired(error), false, "a UUID is rejected locally, without asking the Parent");
  });

  it("refuses an answer that names a different work item than the one requested", async () => {
    const answers = answersWith([["workitem", planeRetrieveArgs("AIES-38"), planeWorkItem({ sequence: 39 })]]);
    const transport = new HostMediatedPlaneTransport(answers);
    const error = await rejectionOf(transport.getIssue("AIES-38"));
    assert.equal(error.code, "invalid_remote_payload");
  });

  it("the manager refuses a UUID-only answer as an invalid remote payload and activates nothing", async () => {
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    const first = await manager.loadTicket("AIES-38");
    assert.equal(first.error, "remote_required");
    const result = await manager.submitRemote({
      id: PLANE_WORKITEM_UUID,
      name: "No human key",
      project: { id: PLANE_PROJECT.id, name: "AIES" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_remote_payload");
    assert.equal(manager.getActiveTicket(), null);
  });
});

describe("D33 phase 3: normalization of the verified Plane shape", () => {
  it("maps state.name and state.group to the compact state and statusType", () => {
    const normalized = normalizePlaneWorkItem(planeWorkItem({ stateName: "In Progress" }));
    assert.equal(normalized.state.name, "In Progress");
    assert.equal(normalized.state.type, "started");
    assert.equal(normalized.state.id, planeState("In Progress").id);
    assert.equal(normalized.project.name, "AIES");
    assert.equal(normalized.project.identifier, "AIES");
    assert.equal(normalized.teamId, PLANE_PROJECT.id, "the project UUID is what the state list needs");
  });

  it("prefers description_stripped and falls back to the HTML description", () => {
    assert.equal(normalizePlaneWorkItem(planeWorkItem({ description: "Plain text" })).description, "Plain text");
    const fallback = normalizePlaneWorkItem({ ...planeWorkItem(), description_stripped: undefined, description_html: "<p>Hello <b>world</b></p>" });
    assert.equal(fallback.description, "Hello world");
  });

  it("reads state lists from results[] or a bare array, keeping the cancelled group as Plane spells it", () => {
    const fromResults = normalizePlaneStates(planeStateList());
    assert.equal(fromResults.length, 5);
    assert.deepEqual(
      fromResults.map((status) => [status.name, status.type]),
      [
        ["Backlog", "backlog"],
        ["Todo", "unstarted"],
        ["In Progress", "started"],
        ["Done", "completed"],
        ["Cancelled", "cancelled"],
      ],
    );
    assert.equal(normalizePlaneStates(planeStateList().results).length, 5);
    assert.equal(normalizePlaneStates({ unexpected: true }).length, 0);
  });

  it("drops state entries without an id, name or group instead of inventing them", () => {
    const statuses = normalizePlaneStates({ results: [{ id: "x", name: "No group" }, { name: "No id", group: "started" }] });
    assert.equal(statuses.length, 0);
  });
});

describe("D33 phase 3: manager wiring", () => {
  it("the Plane descriptor names the plane server and the plane tracker", () => {
    assert.equal(PLANE_TRACKER.id, "plane");
    assert.equal(PLANE_TRACKER.mcpServer, "plane");
  });

  it("a configured Plane tracker raises the plane directive, not a Linear one", async () => {
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    const result = await manager.loadTicket("AIES-38");
    assert.equal(result.error, "remote_required");
    assert.equal(result.directive.server, "plane");
    assert.equal(result.directive.tool, "workitem");
  });

  it("a loaded Plane ticket records the plane tracker in its snapshot and keeps the project UUID as its team", async () => {
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    await manager.loadTicket("AIES-38");
    const loaded = await manager.submitRemote({ content: [{ type: "text", text: JSON.stringify(planeWorkItem()) }] });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ticket.identifier, "AIES-38");
    assert.equal(loaded.ticket.tracker, "plane");
    assert.equal(loaded.ticket.team, PLANE_PROJECT.id);
    assert.equal(manager.toSnapshot().tracker, "plane");
  });
});

describe("Phase 5: the `mcp` result shape the hosted Plane server really returns", () => {
  // Observed against real Plane: the work item as one JSON text part, then the same
  // payload again as a second text part, `structuredContent:` followed by `{ result: … }`.
  const realContent = (item) => [
    { type: "text", text: JSON.stringify(item) },
    { type: "text", text: `structuredContent:\n${JSON.stringify({ result: item }, null, 2)}` },
  ];

  it("loads a ticket from the two-part result (JSON part, then structuredContent part)", async () => {
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    await manager.loadTicket("AIES-38");
    const loaded = await manager.captureRemote(
      { server: "plane", tool: "workitem", args: planeRetrieveArgs("AIES-38") },
      realContent(planeWorkItem()),
    );
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ticket.identifier, "AIES-38");
    assert.equal(loaded.ticket.tracker, "plane");
  });

  it("still refuses a two-part result whose first part is not a complete payload", async () => {
    const truncated = JSON.stringify(planeWorkItem()).slice(0, 40);
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    await manager.loadTicket("AIES-38");
    const refused = await manager.captureRemote(
      { server: "plane", tool: "workitem", args: planeRetrieveArgs("AIES-38") },
      [
        { type: "text", text: truncated },
        { type: "text", text: `structuredContent:\n${JSON.stringify({ result: planeWorkItem() })}` },
      ],
    );
    assert.equal(refused.ok, false);
  });

  it("still refuses a two-part result whose payload has no identity", async () => {
    const { sequence_id: _omitted, ...incomplete } = planeWorkItem();
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    await manager.loadTicket("AIES-38");
    const refused = await manager.captureRemote(
      { server: "plane", tool: "workitem", args: planeRetrieveArgs("AIES-38") },
      realContent(incomplete),
    );
    assert.equal(refused.ok, false);
  });
});
