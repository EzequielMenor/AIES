/**
 * D33 phase 4 (part C): the decision table of the Plane write guard, pure.
 *
 * Every row of the table in the handoff is pinned here: a call that changes or may
 * change a work item's workflow state is refused unless it is the exact directive
 * `aies_ticket` has pending and the Done Gate still allows it; `state` and `intake`
 * writes are refused always; an action the guard does not know is refused; reads and
 * comment creation pass, and every other Plane write is refused (D36 part 1, closed
 * list). Linear is never classified by these rules.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { planeWriteBypassReason } from "../extensions/aies-agents/linear/pending-action.ts";
import { PLANE_PROJECT, PLANE_STATES, PLANE_WORKITEM_UUID } from "./helpers/plane-fixtures.mjs";
import { TRUSTED, UNTRUSTED } from "./helpers/mcp-profile.mjs";

const DONE = PLANE_STATES.find((state) => state.name === "Done").id;
const IN_PROGRESS = PLANE_STATES.find((state) => state.name === "In Progress").id;
const BACKLOG = PLANE_STATES.find((state) => state.name === "Backlog").id;
const OTHER_WORKITEM = "11111111-2222-4333-8444-555555555555";

const ALLOW = () => ({ allowed: true, reason: "Verification not required: docs only" });
const DENY = () => ({ allowed: false, reason: "Verification required: no verification run has been executed (status: none)" });

/** The directive `complete` emits for the state write (`workitem update` with `state`). */
const COMPLETE_DIRECTIVE = {
  key: `plane:workitem(action="update",project_id="${PLANE_PROJECT.id}",state="${DONE}",workitem_id="${PLANE_WORKITEM_UUID}")`,
  server: "plane",
  tool: "workitem",
  args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE },
  purpose: "update the ticket workflow state",
};

const START_DIRECTIVE = { ...COMPLETE_DIRECTIVE, args: { ...COMPLETE_DIRECTIVE.args, state: IN_PROGRESS } };

const NOTHING_PENDING = { pending: null, pendingAction: null, doneGate: ALLOW, trust: TRUSTED };
const COMPLETE_ALLOWED = { pending: COMPLETE_DIRECTIVE, pendingAction: "complete", doneGate: ALLOW, trust: TRUSTED };
const COMPLETE_GATE_DENIED = { pending: COMPLETE_DIRECTIVE, pendingAction: "complete", doneGate: DENY, trust: TRUSTED };
const START_PENDING = { pending: START_DIRECTIVE, pendingAction: "start", doneGate: DENY, trust: TRUSTED };

const mcp = (server, tool, args) => ({ server, tool, args });
const stateUpdate = (overrides = {}) => ({
  action: "update",
  project_id: PLANE_PROJECT.id,
  workitem_id: PLANE_WORKITEM_UUID,
  state: DONE,
  ...overrides,
});

function assertBlocked(input, context, label) {
  const reason = planeWriteBypassReason("mcp", input, context);
  assert.ok(reason, `${label} must be refused`);
  assert.match(reason, /^Bloqueado:/, `${label}: the refusal is in Spanish and starts with Bloqueado`);
  return reason;
}

function assertAllowed(input, context, label) {
  assert.equal(planeWriteBypassReason("mcp", input, context), null, `${label} must pass`);
}

describe("D33 phase 4 (C): a Plane state write needs the exact pending directive and a live Done Gate", () => {
  it("refuses a state write when nothing is pending", () => {
    assertBlocked(mcp("plane", "workitem", stateUpdate()), NOTHING_PENDING, "update with state, no directive");
  });

  it("refuses the same write when its args arrive as an encoded JSON string", () => {
    assertBlocked(mcp("plane", "workitem", JSON.stringify(stateUpdate())), NOTHING_PENDING, "encoded update with state");
  });

  it("normalises server, tool and action: case and surrounding spaces do not open a bypass", () => {
    assertBlocked(mcp(" PLANE ", "Workitem ", stateUpdate({ action: " UPDATE " })), NOTHING_PENDING, "case and spaces, no directive");
    assertBlocked(mcp("Plane", " workitem", JSON.stringify(stateUpdate({ action: "Update" }))), NOTHING_PENDING, "case and spaces, encoded");
  });

  it("refuses an update whose state is nested under another key", () => {
    assertBlocked(mcp("plane", "workitem", { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, data: { state: DONE } }), COMPLETE_ALLOWED, "nested state");
  });

  it("refuses an update with a state under a state-like alias key", () => {
    const base = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID };
    assertBlocked(mcp("plane", "workitem", { ...base, state_id: DONE }), COMPLETE_ALLOWED, "state_id alias");
    assertBlocked(mcp("plane", "workitem", { ...base, status: DONE }), COMPLETE_ALLOWED, "status alias");
  });

  it("refuses a state write to another work item, another state, another project or with an extra key", () => {
    assertBlocked(mcp("plane", "workitem", stateUpdate({ workitem_id: OTHER_WORKITEM })), COMPLETE_ALLOWED, "another work item");
    assertBlocked(mcp("plane", "workitem", stateUpdate({ state: BACKLOG })), COMPLETE_ALLOWED, "another state");
    assertBlocked(mcp("plane", "workitem", stateUpdate({ project_id: OTHER_WORKITEM })), COMPLETE_ALLOWED, "another project");
    assertBlocked(mcp("plane", "workitem", stateUpdate({ name: "Renamed" })), COMPLETE_ALLOWED, "extra key");
  });

  it("refuses the exact directive when the Done Gate denies the completion", () => {
    assertBlocked(mcp("plane", "workitem", stateUpdate()), COMPLETE_GATE_DENIED, "exact directive, gate denied");
  });

  it("refuses the exact directive when it was not issued by complete or start", () => {
    const context = { pending: COMPLETE_DIRECTIVE, pendingAction: "refresh", doneGate: ALLOW, trust: TRUSTED };
    assertBlocked(mcp("plane", "workitem", stateUpdate()), context, "exact directive from an unexpected action");
  });

  it("allows the exact directive that complete emits once the Done Gate allows it", () => {
    assertAllowed(mcp("plane", "workitem", stateUpdate()), COMPLETE_ALLOWED, "exact complete directive");
    assertAllowed(mcp("plane", "workitem", JSON.stringify(stateUpdate())), COMPLETE_ALLOWED, "exact complete directive, encoded");
    // D38: the server is compared exactly after trimming, so " PLANE " is not the declared server `plane`.
    assertBlocked(mcp(" PLANE ", "Workitem", stateUpdate({ action: "UPDATE" })), COMPLETE_ALLOWED, "server spelled differently is undeclared");
  });

  it("allows the exact directive that start emits, which never asks the Done Gate", () => {
    const startWrite = mcp("plane", "workitem", stateUpdate({ state: IN_PROGRESS }));
    assertAllowed(startWrite, START_PENDING, "exact start directive");
  });

  it("refuses a start-state write that is not the directive start emitted", () => {
    assertBlocked(mcp("plane", "workitem", stateUpdate({ state: DONE })), START_PENDING, "start directive used to complete");
  });
});

describe("D33 phase 4 (C): state and intake writes are refused in every session", () => {
  const stateCalls = {
    update: { action: "update", project_id: PLANE_PROJECT.id, state: DONE },
    delete: { action: "delete", project_id: PLANE_PROJECT.id, state: BACKLOG },
    create: { action: "create", project_id: PLANE_PROJECT.id, group: "completed", name: "Closed" },
  };

  for (const [name, args] of Object.entries(stateCalls)) {
    it(`refuses state ${name}, with or without a pending directive, and asks for the Plane UI`, () => {
      const reason = assertBlocked(mcp("plane", "state", args), COMPLETE_ALLOWED, `state ${name}`);
      assert.match(reason, /UI de Plane/);
      assertBlocked(mcp("plane", "state", args), NOTHING_PENDING, `state ${name}, nothing pending`);
    });
  }

  it("allows the state list, which only reads", () => {
    assertAllowed(mcp("plane", "state", { action: "list", project_id: PLANE_PROJECT.id }), NOTHING_PENDING, "state list");
  });

  it("refuses every intake write, including creation, and allows intake reads (D36 part 1)", () => {
    const update = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, status: 1 };
    const remove = { action: "delete", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID };
    assertBlocked(mcp("plane", "intake", update), COMPLETE_ALLOWED, "intake update accept or decline");
    assertBlocked(mcp("plane", "intake", remove), COMPLETE_ALLOWED, "intake delete");
    assertAllowed(mcp("plane", "intake", { action: "list", project_id: PLANE_PROJECT.id }), NOTHING_PENDING, "intake list");
    assertBlocked(mcp("plane", "intake", { action: "create", project_id: PLANE_PROJECT.id, name: "New idea" }), NOTHING_PENDING, "intake create");
  });
});

describe("D33 phase 4 (C): unknown actions and tools fail closed", () => {
  it("refuses an unknown, missing or non-string action of workitem, state and intake", () => {
    for (const tool of ["workitem", "state", "intake"]) {
      assertBlocked(mcp("plane", tool, { action: "bulk_transition", project_id: PLANE_PROJECT.id, state: DONE }), NOTHING_PENDING, `${tool} unknown action`);
      assertBlocked(mcp("plane", tool, { project_id: PLANE_PROJECT.id, state: DONE }), NOTHING_PENDING, `${tool} missing action`);
      assertBlocked(mcp("plane", tool, { action: 7, project_id: PLANE_PROJECT.id }), NOTHING_PENDING, `${tool} non-string action`);
    }
  });

  it("refuses a guarded call whose args cannot be read as an object", () => {
    assertBlocked(mcp("plane", "workitem", "not json"), NOTHING_PENDING, "unparseable args");
    assertBlocked(mcp("plane", "workitem", "[1,2]"), NOTHING_PENDING, "array args");
  });

  it("refuses a Plane tool that is not in the analysed list", () => {
    assertBlocked(mcp("plane", "workitem_state", { action: "update", state: DONE }), COMPLETE_ALLOWED, "unlisted Plane tool");
  });

  it("refuses a guarded tool sent with no server, because it may still reach Plane", () => {
    assertBlocked(mcp("", "workitem", stateUpdate()), NOTHING_PENDING, "no server, workitem update with state");
  });

  it("applies the same rules through the namespace tool mcp__plane, and refuses a direct mcp__plane__<tool> on an untrusted profile", () => {
    const direct = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    assert.match(planeWriteBypassReason("mcp__plane", { tool: "workitem", args: direct }, NOTHING_PENDING) ?? "", /^Bloqueado:/, "a namespace state write is refused without a directive");
    assert.equal(planeWriteBypassReason("mcp__plane", { tool: "workitem", args: { action: "retrieve", project_id: PLANE_PROJECT.id } }, NOTHING_PENDING), null);
    // D38: a direct name is not a Plane tool of a trusted profile; on an untrusted one nothing but Pi and AIES runs.
    assert.match(planeWriteBypassReason("mcp__plane__workitem", direct, { ...NOTHING_PENDING, trust: UNTRUSTED }) ?? "", /^Bloqueado:/, "a direct name on an untrusted profile is refused");
  });
});

describe("D33 phase 4 (C), narrowed by D36 part 1: reads and comment creation pass", () => {
  it("never refuses a Plane read of a work item", () => {
    for (const action of ["list", "list_archived", "retrieve", "retrieve_by_identifier", "search", "count"]) {
      assertAllowed(mcp("plane", "workitem", { action, project_id: PLANE_PROJECT.id, workitem_identifier: "AIES-38" }), NOTHING_PENDING, `workitem ${action}`);
      assertAllowed(mcp("plane", "Workitem", JSON.stringify({ action: action.toUpperCase() })), NOTHING_PENDING, `workitem ${action}, encoded and cased action`);
    }
  });

  it("refuses an update without a state, in any session state (D36 part 1: the closed list)", () => {
    assertBlocked(mcp("plane", "workitem", { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, name: "Renamed" }), NOTHING_PENDING, "rename");
    assertBlocked(mcp("plane", "workitem", { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, name: "Renamed" }), COMPLETE_GATE_DENIED, "rename while gate denied");
  });

  it("refuses the label, assignee, archive and delete actions, which the closed list does not allow", () => {
    for (const action of ["manage_assignee", "manage_label", "archive", "delete"]) {
      assertBlocked(mcp("plane", "workitem", { action, project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID }), NOTHING_PENDING, `workitem ${action}`);
    }
  });

  it("refuses creating a work item, even without a state (D36 part 1)", () => {
    assertBlocked(mcp("plane", "workitem", { action: "create", project_id: PLANE_PROJECT.id, name: "New", state: DONE }), NOTHING_PENDING, "create with state");
    assertBlocked(mcp("plane", "workitem", { action: "create", project_id: PLANE_PROJECT.id, name: "New" }), NOTHING_PENDING, "create without state");
  });

  it("allows comment create with any session state, and refuses every write of the other Plane tools", () => {
    assertAllowed(mcp("plane", "workitem_comment", { action: "create", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, comment_html: "<p>note</p>" }), NOTHING_PENDING, "comment");
    assertAllowed(mcp("plane", "workitem_comment", { action: "create", project_id: PLANE_PROJECT.id }), COMPLETE_GATE_DENIED, "comment while gate denied");
    for (const tool of ["cycle", "module", "release", "initiative", "milestone", "workitem_property", "workitem_relation", "workitem_type", "template", "project", "label", "member", "page"]) {
      assertBlocked(mcp("plane", tool, { action: "update", project_id: PLANE_PROJECT.id }), NOTHING_PENDING, tool);
    }
  });
});

describe("D33 phase 4 (C): Linear and other tools are not classified by the Plane rules", () => {
  it("does not classify a Linear call, with or without a state", () => {
    assertAllowed(mcp("linear", "save_issue", { id: "EZE-496", state: "Done" }), NOTHING_PENDING, "linear save_issue Done");
    assertAllowed(mcp("linear", "workitem", { action: "update", state: DONE }), NOTHING_PENDING, "linear tool named workitem");
  });

  it("does not classify a non-mcp tool", () => {
    assert.equal(planeWriteBypassReason("edit", { path: "README.md" }, NOTHING_PENDING), null);
  });
});

describe("D33 phase 4 (C): an encoded args string that repeats a key is unreadable, so it fails closed", () => {
  const P = PLANE_PROJECT.id;
  const W = PLANE_WORKITEM_UUID;

  it("refuses a read whose encoded args repeat the action, because the adapter may keep the write", () => {
    const encoded = `{"action":"retrieve","action":"update","project_id":"${P}","workitem_id":"${W}","state":"${DONE}"}`;
    assertBlocked(mcp("plane", "workitem", encoded), NOTHING_PENDING, "repeated action");
  });

  it("refuses a state write whose encoded args repeat the state, even when the last copy is the directive", () => {
    const encoded = `{"action":"update","project_id":"${P}","workitem_id":"${W}","state":"${DONE}","state":"${IN_PROGRESS}"}`;
    assertBlocked(mcp("plane", "workitem", encoded), START_PENDING, "repeated state, directive last");
    const reversed = `{"action":"update","project_id":"${P}","workitem_id":"${W}","state":"${IN_PROGRESS}","state":"${DONE}"}`;
    assertBlocked(mcp("plane", "workitem", reversed), COMPLETE_ALLOWED, "repeated state, directive first");
  });

  it("refuses a repeated key that differs only by an escape sequence", () => {
    const encoded = `{"action":"update","project_id":"${P}","workitem_id":"${W}","sta\\u0074e":"${DONE}","state":"${IN_PROGRESS}"}`;
    assertBlocked(mcp("plane", "workitem", encoded), START_PENDING, "escaped repeated state");
  });

  it("still allows the exact directive when the encoded args name each key once", () => {
    const encoded = `{"action":"update","project_id":"${P}","workitem_id":"${W}","state":"${DONE}"}`;
    assertAllowed(mcp("plane", "workitem", encoded), COMPLETE_ALLOWED, "single keys, exact directive");
  });
});

describe("D33 phase 4 (C): a script that could chain Plane calls is refused under Plane only", () => {
  it("refuses mcpScript in a Plane session, whatever the script says", () => {
    const context = { ...NOTHING_PENDING, tracker: "plane" };
    const reason = planeWriteBypassReason("mcpScript", { script: "list then update" }, context);
    assert.match(reason ?? "", /^Bloqueado:/);
    assert.match(reason ?? "", /mcpScript/);
  });

  it("refuses mcpScript under Linear too, because a script can reach the Plane server from any profile", () => {
    assert.match(planeWriteBypassReason("mcpScript", { script: "x" }, { ...NOTHING_PENDING, tracker: "linear" }) ?? "", /^Bloqueado:/);
    assert.match(planeWriteBypassReason("mcpScript", { script: "x" }, NOTHING_PENDING) ?? "", /^Bloqueado:/);
  });
});
