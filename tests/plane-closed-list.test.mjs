/**
 * D36 part 1: the closed list of Plane operations, pure.
 *
 * The write guard is deny by default. Only the read actions on any Plane tool, the
 * reference tool `get_pql_reference`, `workitem update` as the exact pending state
 * directive, and `workitem_comment create` pass. Every other Plane write is refused,
 * whatever the tool, the action, the name form the adapter resolves (`plane`, a bare
 * name, `plane_<tool>`, the namespace proxy `mcp__plane`, `mcp__plane_<tool>`), and
 * whatever the session state. The refusal names the Plane UI as the honest next step.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planeWriteBypassReason } from "../extensions/aies-agents/linear/pending-action.ts";
import { PLANE_PROJECT, PLANE_STATES, PLANE_WORKITEM_UUID } from "./helpers/plane-fixtures.mjs";
import { TRUSTED } from "./helpers/mcp-profile.mjs";

const DONE = PLANE_STATES.find((state) => state.name === "Done").id;
const IN_PROGRESS = PLANE_STATES.find((state) => state.name === "In Progress").id;

const ALLOW = () => ({ allowed: true, reason: "Verification not required: docs only" });

const COMPLETE_DIRECTIVE = {
  key: `plane:workitem(action="update",project_id="${PLANE_PROJECT.id}",state="${DONE}",workitem_id="${PLANE_WORKITEM_UUID}")`,
  server: "plane",
  tool: "workitem",
  args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE },
  purpose: "update the ticket workflow state",
};
const START_DIRECTIVE = { ...COMPLETE_DIRECTIVE, args: { ...COMPLETE_DIRECTIVE.args, state: IN_PROGRESS } };

const NOTHING = { pending: null, pendingAction: null, doneGate: ALLOW, trust: TRUSTED };
const COMPLETE = { pending: COMPLETE_DIRECTIVE, pendingAction: "complete", doneGate: ALLOW, trust: TRUSTED };
const START = { pending: START_DIRECTIVE, pendingAction: "start", doneGate: ALLOW, trust: TRUSTED };

/**
 * The writes the closed list refuses, per tool. The first group is the inventory of the
 * analysis; the second group is the tools that were not inspected action by action, where
 * every write is refused (fail closed).
 */
const REFUSED_WRITES = {
  workitem: ["create", "delete", "archive", "manage_assignee", "manage_label"],
  state: ["create", "update", "delete"],
  workitem_comment: ["update", "delete"],
  intake: ["create", "update", "delete"],
  project: ["create", "update", "delete", "archive", "unarchive", "update_features"],
  cycle: ["create", "update", "delete", "complete", "archive", "unarchive", "manage_workitems", "transfer_workitems"],
  module: ["create", "update", "delete", "archive", "unarchive", "manage_workitems"],
  workitem_relation: ["create", "delete", "create_definition", "update_definition", "delete_definition"],
  release: ["create", "update", "delete", "update_changelog", "manage_workitems"],
  milestone: ["create", "update", "delete", "manage_workitems"],
  workitem_property: ["create", "update", "delete", "manage_type_properties", "create_option", "update_option", "delete_option", "set_value", "delete_value"],
  workitem_type: ["create", "update", "delete", "resolve", "import_to_project"],
  template: ["create", "update", "delete"],
  initiative: ["create", "update", "delete", "add_projects", "remove_projects", "manage_workitems"],
  collection: ["create", "update", "delete"],
  customer: ["create", "update", "delete"],
  customer_property: ["create", "update", "delete"],
  customer_request: ["create", "update", "delete"],
  label: ["create", "update", "delete"],
  member: ["create", "update", "delete"],
  page: ["create", "update", "delete"],
  project_estimate: ["create", "update", "delete"],
  release_label: ["create", "update", "delete"],
  release_tag: ["create", "update", "delete"],
  work_log: ["create", "update", "delete"],
  workitem_activity: ["create", "update", "delete"],
  workitem_attachment: ["create", "update", "delete"],
  workitem_link: ["create", "update", "delete"],
  workspace: ["create", "update", "delete"],
};

/** The read actions, allowed on every Plane tool (D36 part 1). */
const READ_ACTIONS = [
  "list", "list_archived", "list_workitems", "list_projects", "list_options", "list_definitions",
  "list_workspace", "list_project", "retrieve", "retrieve_by_identifier", "retrieve_option", "search",
  "count", "get_changelog", "get_features", "get_value", "worklog_summary",
];

/**
 * The ways a trusted profile reaches the same Plane tool and action (D38): the `mcp` proxy with
 * `server: "plane"`, the `mcp` proxy with no server, and the namespace tool `mcp__plane`. A trusted
 * profile has no direct tools, so a prefixed or direct name is not a Plane call (see `mcp-trust.test.mjs`).
 */
function forms(tool, args) {
  return [
    { label: `mcp server plane, ${tool}`, toolName: "mcp", input: { server: "plane", tool, args } },
    { label: `mcp with no server, bare ${tool}`, toolName: "mcp", input: { tool, args } },
    { label: `namespace mcp__plane, ${tool}`, toolName: "mcp__plane", input: { tool, args } },
  ];
}

function refuse(form, context, label) {
  const reason = planeWriteBypassReason(form.toolName, form.input, context);
  assert.ok(reason, `${label}: ${form.label} must be refused`);
  assert.match(reason, /^Bloqueado:/, `${label}: the refusal is in Spanish`);
  return reason;
}

function pass(form, context, label) {
  assert.equal(planeWriteBypassReason(form.toolName, form.input, context), null, `${label}: ${form.label} must pass`);
}

describe("D36 part 1: every Plane write outside the closed list is refused, in every name form", () => {
  for (const [tool, actions] of Object.entries(REFUSED_WRITES)) {
    for (const action of actions) {
      it(`refuses ${tool} ${action} in every session state and every name form`, () => {
        const args = { action, project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE, name: "x" };
        for (const form of forms(tool, args)) {
          refuse(form, NOTHING, `${tool} ${action} with nothing pending`);
          refuse(form, COMPLETE, `${tool} ${action} with the completion pending`);
          refuse(form, START, `${tool} ${action} with the start pending`);
        }
      });
    }
  }

  it("refuses workitem update without a state, even when the directive is pending", () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, name: "Renamed" };
    for (const form of forms("workitem", args)) {
      refuse(form, NOTHING, "update without state");
      refuse(form, COMPLETE, "update without state, completion pending");
    }
  });

  it("refuses an unknown action and a missing action on every tool", () => {
    for (const tool of ["workitem", "state", "intake", "cycle", "workitem_comment", "release"]) {
      for (const args of [{ action: "bulk_transition", project_id: PLANE_PROJECT.id }, { project_id: PLANE_PROJECT.id }, { action: 3 }]) {
        for (const form of forms(tool, args)) refuse(form, COMPLETE, `${tool} with an unknown action`);
      }
    }
  });

  it("refuses a Plane tool that is not in the analysed list, for any action", () => {
    for (const tool of ["workitem_state", "work_items", "bulk_update"]) {
      for (const form of forms(tool, { action: "list", project_id: PLANE_PROJECT.id })) refuse(form, NOTHING, `unknown tool ${tool}`);
    }
  });

  it("refuses a state write with the exact completion directive when the tool is a state, not a workitem", () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, state: DONE, group: "completed" };
    for (const form of forms("state", args)) refuse(form, COMPLETE, "state update naming the completed group");
  });
});

describe("D36 part 1: the reads of every Plane tool pass, in every name form", () => {
  const tools = [...Object.keys(REFUSED_WRITES), "get_pql_reference"];
  for (const tool of tools) {
    it(`allows the read actions on ${tool}`, () => {
      if (tool === "get_pql_reference") {
        for (const form of forms(tool, { query: "state.group = 'started'" })) pass(form, NOTHING, tool);
        return;
      }
      for (const action of READ_ACTIONS) {
        for (const form of forms(tool, { action, project_id: PLANE_PROJECT.id })) pass(form, NOTHING, `${tool} ${action}`);
      }
    });
  }

  it("allows the reference tool with no action at all", () => {
    for (const form of forms("get_pql_reference", undefined)) pass(form, NOTHING, "get_pql_reference");
  });
});

describe("D36 part 1: the three writes that pass are exactly the ones the flow needs", () => {
  it("passes workitem update with the state of the exact pending start directive", () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: IN_PROGRESS };
    for (const form of forms("workitem", args)) pass(form, START, "start directive");
  });

  it("passes workitem update with the state of the exact pending completion directive, while the Done Gate allows it", () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    for (const form of forms("workitem", args)) pass(form, COMPLETE, "completion directive");
  });

  it("refuses the same state write when the Done Gate denies the completion", () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    const denied = { ...COMPLETE, doneGate: () => ({ allowed: false, reason: "no verification" }) };
    for (const form of forms("workitem", args)) refuse(form, denied, "completion directive, gate denied");
  });

  it("refuses a state write that differs from the pending directive in any key", () => {
    const base = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    const variants = [
      { ...base, state: IN_PROGRESS },
      { ...base, workitem_id: "11111111-2222-4333-8444-555555555555" },
      { ...base, extra: "key" },
    ];
    for (const args of variants) {
      for (const form of forms("workitem", args)) refuse(form, COMPLETE, `variant ${JSON.stringify(Object.keys(args))}`);
    }
  });

  it("passes workitem_comment create in every session state and name form", () => {
    const args = { action: "create", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, comment_html: "<p>note</p>" };
    for (const context of [NOTHING, START, COMPLETE]) {
      for (const form of forms("workitem_comment", args)) pass(form, context, "comment create");
    }
  });
});

describe("D36 part 1: the Plane UI is the honest next step of every refusal", () => {
  it("names the Plane UI for a refused write, and says nothing was sent", () => {
    const reason = refuse(forms("project", { action: "update", project_id: PLANE_PROJECT.id })[0], NOTHING, "project update");
    assert.match(reason, /UI de Plane/);
    assert.match(reason, /No se envió ningún cambio/);
  });
});
