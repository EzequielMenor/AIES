/**
 * D33 phase 4, part C (follow-up): every name the pi-mcp-adapter resolves to a Plane
 * tool must meet the Plane rules, whatever form the Parent uses to reach it.
 *
 * The adapter routes a call without `server` by its name (displayed name, original
 * name, the `plane_` server prefix, then the `mcp__plane_` candidate forms), routes a
 * direct tool `plane_<tool>` and the namespace proxy `mcp__plane` with `{tool, args}`,
 * and routes the `mcp` gateway modes (search, describe, connect, auth, list, status)
 * without executing any tool. These tests pin that model, fail closed on what they
 * cannot attribute, and keep every explicit non-Plane server untouched.
 *
 * Pure: it drives `planeWriteBypassReason` and `isDirectPlaneStateWrite` only.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDirectPlaneStateWrite, planeWriteBypassReason } from "../extensions/aies-agents/linear/pending-action.ts";
import { PLANE_PROJECT, PLANE_STATES, PLANE_WORKITEM_UUID } from "./helpers/plane-fixtures.mjs";
import { TRUSTED } from "./helpers/mcp-profile.mjs";

const DONE = PLANE_STATES.find((state) => state.name === "Done").id;
const IN_PROGRESS = PLANE_STATES.find((state) => state.name === "In Progress").id;
const BACKLOG = PLANE_STATES.find((state) => state.name === "Backlog").id;
const OTHER_WORKITEM = "11111111-2222-4333-8444-555555555555";

const ALLOW = () => ({ allowed: true, reason: "Verification not required: docs only" });
const DENY = () => ({ allowed: false, reason: "Verification required: no verification run has been executed (status: none)" });

const COMPLETE_DIRECTIVE = {
  key: `plane:workitem(action="update",project_id="${PLANE_PROJECT.id}",state="${DONE}",workitem_id="${PLANE_WORKITEM_UUID}")`,
  server: "plane",
  tool: "workitem",
  args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE },
  purpose: "update the ticket workflow state",
};
const START_DIRECTIVE = { ...COMPLETE_DIRECTIVE, args: { ...COMPLETE_DIRECTIVE.args, state: IN_PROGRESS } };

const NOTHING = { pending: null, pendingAction: null, doneGate: ALLOW, trust: TRUSTED };
const COMPLETE_ALLOWED = { pending: COMPLETE_DIRECTIVE, pendingAction: "complete", doneGate: ALLOW, trust: TRUSTED };
const START_PENDING = { pending: START_DIRECTIVE, pendingAction: "start", doneGate: DENY, trust: TRUSTED };

const stateUpdate = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
const retrieve = { action: "retrieve_by_identifier", workitem_identifier: "AIES-38", expand: "state,project" };

/** A gateway call of the `mcp` proxy: no tool name in the event, the name lives in `tool`. */
const proxy = (input) => ({ ...input });

function blocked(toolName, input, context, label) {
  const reason = planeWriteBypassReason(toolName, input, context);
  assert.ok(reason, `${label} must be refused`);
  assert.match(reason, /^Bloqueado:/, `${label}: the refusal is in Spanish`);
  return reason;
}

function allowed(toolName, input, context, label) {
  assert.equal(planeWriteBypassReason(toolName, input, context), null, `${label} must pass`);
}

describe("D38: on a trusted profile a prefixed name is not a Plane tool, and server plane is exact", () => {
  it("refuses a state write named plane_workitem with no server: it is not a tool of the closed list", () => {
    blocked("mcp", proxy({ tool: "plane_workitem", args: stateUpdate }), NOTHING, "plane_workitem update with state");
  });

  it("refuses the same write under every name form, encoded or not, with no server", () => {
    const forms = ["mcp__plane_workitem", "PLANE_WORKITEM", " plane-workitem ", "plane__workitem", "Plane.Workitem", "mcp__plane__workitem"];
    for (const tool of forms) {
      blocked("mcp", proxy({ tool, args: stateUpdate }), NOTHING, `name form ${tool}`);
      blocked("mcp", proxy({ tool, args: JSON.stringify(stateUpdate) }), NOTHING, `encoded args, name form ${tool}`);
    }
  });

  it("refuses the bare workitem update with no server, because it is not Linear's and has no state directive", () => {
    blocked("mcp", proxy({ tool: "workitem", args: stateUpdate }), NOTHING, "bare workitem update with state");
  });

  it("refuses state and intake writes named with the Plane prefix", () => {
    blocked("mcp", proxy({ tool: "plane_state", args: { action: "delete", project_id: PLANE_PROJECT.id, state: BACKLOG } }), NOTHING, "plane_state delete");
    blocked("mcp", proxy({ tool: "plane_intake", args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, status: 1 } }), NOTHING, "plane_intake update");
  });

  it("allows the exact start and complete directives through the proxy with server plane", () => {
    allowed("mcp", proxy({ server: "plane", tool: "workitem", args: stateUpdate }), COMPLETE_ALLOWED, "complete directive through server plane");
    allowed("mcp", proxy({ server: "plane", tool: "workitem", args: { ...stateUpdate, state: IN_PROGRESS } }), START_PENDING, "start directive through server plane");
  });

  it("refuses a server plane write that differs from the pending directive, and a completion the gate denies", () => {
    blocked("mcp", proxy({ server: "plane", tool: "workitem", args: { ...stateUpdate, workitem_id: OTHER_WORKITEM } }), COMPLETE_ALLOWED, "server plane, other work item");
    blocked("mcp", proxy({ server: "plane", tool: "workitem", args: { ...stateUpdate, state: BACKLOG } }), COMPLETE_ALLOWED, "server plane, other state");
    blocked("mcp", proxy({ server: "plane", tool: "workitem", args: stateUpdate }), { ...COMPLETE_ALLOWED, doneGate: DENY }, "server plane, gate denied");
  });

  it("allows Plane reads and comments through server plane", () => {
    allowed("mcp", proxy({ server: "plane", tool: "workitem", args: retrieve }), NOTHING, "server plane workitem retrieve");
    allowed("mcp", proxy({ server: "plane", tool: "workitem_comment", args: { action: "create", comment_html: "<p>x</p>" } }), NOTHING, "server plane comment create");
    allowed("mcp", proxy({ server: "plane", tool: "state", args: { action: "list", project_id: PLANE_PROJECT.id } }), NOTHING, "server plane state list");
  });
});

describe("D38: the namespace proxy mcp__plane is Plane by its exact name, with {tool, args}", () => {
  it("refuses a namespace proxy state write, encoded or not, and a state delete", () => {
    blocked("mcp__plane", { tool: "workitem", args: stateUpdate }, NOTHING, "namespace proxy state write");
    blocked("mcp__plane", { tool: "workitem", args: JSON.stringify(stateUpdate) }, NOTHING, "namespace proxy encoded state write");
    blocked("mcp__plane", { tool: "state", args: { action: "delete", project_id: PLANE_PROJECT.id } }, NOTHING, "namespace proxy state delete");
  });

  it("allows namespace reads and the comment create, and refuses a prefixed tool name", () => {
    allowed("mcp__plane", { tool: "workitem", args: retrieve }, NOTHING, "namespace proxy retrieve");
    allowed("mcp__plane", { tool: "state", args: { action: "list", project_id: PLANE_PROJECT.id } }, NOTHING, "namespace proxy state list");
    allowed("mcp__plane", { tool: "workitem_comment", args: { action: "create" } }, NOTHING, "namespace proxy comment");
    blocked("mcp__plane", { tool: "plane_workitem", args: retrieve }, NOTHING, "namespace proxy, prefixed tool name");
  });

  it("applies the exact directive through the namespace proxy, and refuses it when the gate denies", () => {
    allowed("mcp__plane", { tool: "workitem", args: stateUpdate }, COMPLETE_ALLOWED, "namespace proxy exact directive");
    blocked("mcp__plane", { tool: "workitem", args: stateUpdate }, { ...COMPLETE_ALLOWED, doneGate: DENY }, "namespace proxy, gate denied");
  });

  it("refuses a namespace proxy call that names no tool", () => {
    blocked("mcp__plane", { args: stateUpdate }, NOTHING, "namespace proxy without tool");
  });
});

describe("D33 phase 4 (C): gateway modes of the mcp proxy with server plane run no tool and stay open", () => {
  it("allows the discovery, usage and auth modes", () => {
    allowed("mcp", { server: "plane", search: "workitem" }, NOTHING, "search");
    allowed("mcp", { server: "plane", describe: "workitem" }, NOTHING, "describe");
    allowed("mcp", { server: "plane", instructions: "plane" }, NOTHING, "instructions");
    allowed("mcp", { server: "plane", connect: "plane" }, NOTHING, "connect");
    allowed("mcp", { server: "plane" }, NOTHING, "list the server");
    allowed("mcp", {}, NOTHING, "status");
    allowed("mcp", { server: "plane", action: "auth-start" }, NOTHING, "auth-start");
    allowed("mcp", { server: "plane", action: "auth-complete", args: { code: "abc" } }, NOTHING, "auth-complete");
    allowed("mcp", { server: "plane", action: "ui-messages" }, NOTHING, "ui-messages");
  });

  it("refuses the install action, which rewires a server definition", () => {
    blocked("mcp", { server: "plane", action: "install", url: "https://example.invalid/mcp" }, NOTHING, "install");
  });

  it("refuses an unknown gateway action with server plane", () => {
    blocked("mcp", { server: "plane", action: "frobnicate" }, NOTHING, "unknown gateway action");
    blocked("mcp", { server: "plane", action: "AUTH-START", tool: "workitem", args: stateUpdate }, NOTHING, "cased gateway action with a tool");
  });

  it("lets a tool win over a mode, as the adapter does, so a state write behind search is refused", () => {
    blocked("mcp", { server: "plane", search: "x", tool: "workitem", args: stateUpdate }, NOTHING, "search and tool together");
  });
});

describe("D33 phase 4 (C): explicit servers other than plane are not classified as Plane", () => {
  it("leaves an explicit linear server alone, even under a Plane-looking name", () => {
    allowed("mcp", { server: "linear", tool: "plane_workitem", args: stateUpdate }, NOTHING, "linear server, plane-prefixed name");
    allowed("mcp", { server: "linear", tool: "workitem", args: stateUpdate }, NOTHING, "linear server, bare workitem");
    blocked("mcp", { server: "linear", action: "install", url: "x" }, NOTHING, "linear server, install is refused with any server");
  });

  it("leaves a declared custom server alone, and refuses one the profile does not declare", () => {
    const withEngram = { ...NOTHING, trust: { trusted: true, servers: new Set(["linear", "plane", "engram"]), reason: "" } };
    allowed("mcp", { server: "engram", tool: "workitem", args: stateUpdate }, withEngram, "declared custom server, bare workitem");
    blocked("mcp", { server: "engram", tool: "workitem", args: stateUpdate }, NOTHING, "undeclared custom server");
  });

  it("keeps the Linear workflow tools with no server as Linear", () => {
    allowed("mcp", { tool: "save_issue", args: { id: "EZE-496", state: "Done" } }, NOTHING, "linear save_issue with no server");
    allowed("mcp", { tool: "get_issue", args: { id: "EZE-496" } }, NOTHING, "linear get_issue with no server");
    blocked("mcp", { tool: "linear_save_issue", args: { id: "EZE-496", state: "Done" } }, NOTHING, "linear-prefixed name with no server is not a workflow tool");
  });

  it("refuses a tool with no server that it cannot attribute to a declared server, because it could be Plane", () => {
    blocked("mcp", { tool: "list_projects", args: {} }, NOTHING, "unattributed tool with no server");
  });
});

describe("D33 phase 4 (C): a script can chain Plane calls, so mcpScript is refused whatever the tracker", () => {
  for (const tracker of ["plane", "linear", undefined]) {
    it(`refuses mcpScript when the tracker is ${tracker ?? "not selected"}`, () => {
      blocked("mcpScript", { script: "list then update" }, { ...NOTHING, tracker }, `mcpScript, tracker ${tracker}`);
    });
  }
});

describe("D33 phase 4 (C): the hold predicate and the directive guard read the same names", () => {
  it("recognises a server plane or namespace state write, and holds an unknown Plane tool with no server", () => {
    assert.equal(isDirectPlaneStateWrite("mcp", { server: "plane", tool: "workitem", args: stateUpdate }, TRUSTED), true);
    assert.equal(isDirectPlaneStateWrite("mcp__plane", { tool: "workitem", args: stateUpdate }, TRUSTED), true);
    assert.equal(isDirectPlaneStateWrite("mcp", { tool: "plane_workitem", args: stateUpdate }, TRUSTED), true);
    assert.equal(isDirectPlaneStateWrite("mcp", { server: "plane", tool: "workitem", args: retrieve }, TRUSTED), false);
    assert.equal(isDirectPlaneStateWrite("mcp", { server: "linear", tool: "workitem", args: stateUpdate }, TRUSTED), false);
    assert.equal(isDirectPlaneStateWrite("plane_workitem", stateUpdate, TRUSTED), false, "not a tool of a trusted profile");
  });
});

describe("D33 phase 4 (C, follow-up 2): install is refused with any server, so no alias can be registered", () => {
  const URL_INPUT = { action: "install", url: "https://mcp.plane.so/http/mcp" };

  it("refuses install under the plane server, with no server, and under the linear server", () => {
    blocked("mcp", { server: "plane", ...URL_INPUT }, NOTHING, "install under plane");
    blocked("mcp", { ...URL_INPUT }, NOTHING, "install with no server");
    blocked("mcp", { server: "linear", ...URL_INPUT }, NOTHING, "install under linear");
  });

  it("refuses install under an arbitrary alias that would name the Plane endpoint", () => {
    blocked("mcp", { server: "plane2", ...URL_INPUT }, NOTHING, "install under alias plane2");
    blocked("mcp", { server: "engram", ...URL_INPUT }, NOTHING, "install under a custom server");
  });

  it("refuses install whatever the case or the spacing of the action and the server", () => {
    blocked("mcp", { server: "plane2", action: "INSTALL", url: "x" }, NOTHING, "upper-case INSTALL");
    blocked("mcp", { server: " Plane2 ", action: " install ", url: "x" }, NOTHING, "spaced install");
    blocked("mcp", { server: "", action: "Install", url: "x" }, NOTHING, "mixed-case install, no server");
  });

  it("refuses install even when a Plane state write rides along in the same call", () => {
    blocked("mcp", { server: "plane2", action: "install", url: "x", tool: "workitem", args: stateUpdate }, NOTHING, "install with a tool");
  });

  it("keeps the discovery modes and the auth actions open under plane", () => {
    allowed("mcp", { server: "plane", search: "workitem" }, NOTHING, "search");
    allowed("mcp", { server: "plane", describe: "workitem" }, NOTHING, "describe");
    allowed("mcp", { server: "plane", connect: "plane" }, NOTHING, "connect");
    allowed("mcp", { server: "plane", action: "auth-start" }, NOTHING, "auth-start");
    allowed("mcp", { server: "plane", action: "auth-complete", args: { code: "abc" } }, NOTHING, "auth-complete");
    allowed("mcp", { server: "plane", action: "ui-messages" }, NOTHING, "ui-messages");
  });

  it("keeps Linear's own calls with explicit server linear free of the Plane tool and arg rules", () => {
    allowed("mcp", { server: "linear", tool: "plane_workitem", args: stateUpdate }, NOTHING, "linear server, plane-like tool");
    allowed("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-496", state: "Done" } }, NOTHING, "linear save_issue");
  });
});
