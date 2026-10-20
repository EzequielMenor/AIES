/**
 * D38 attribution: which calls reach Plane, read from a trusted profile by exact string equality.
 *
 * The guard no longer rebuilds the names the adapter gives a server (the aliases, prefixes, suffixes and
 * hashes of the rounds before D38). Under a trusted profile a call is Plane when the `mcp` proxy names
 * `server: "plane"` (after trimming) or when the tool is the namespace `mcp__plane`. A server the profile
 * does not declare is refused. Under an untrusted profile nothing but Pi and AIES tools runs.
 *
 * The profiles are temporary directories written by `tests/helpers/mcp-profile.mjs`, judged by
 * `evaluateMcpTrust`. No network, no credential.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { holdBypassReason, planeWriteBypassReason } from "../extensions/aies-agents/linear/pending-action.ts";
import { evaluateMcpTrust } from "../extensions/aies-agents/mcp/trust.ts";
import { PLANE_PROJECT, PLANE_STATES, PLANE_WORKITEM_UUID } from "./helpers/plane-fixtures.mjs";
import { templateProfile, trustedProfile, writeProfile } from "./helpers/mcp-profile.mjs";

const DONE = PLANE_STATES.find((state) => state.name === "Done").id;
const IN_PROGRESS = PLANE_STATES.find((state) => state.name === "In Progress").id;
const ALLOW = () => ({ allowed: true, reason: "Verification not required: docs only" });

const stateUpdate = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
const retrieve = { action: "retrieve_by_identifier", workitem_identifier: "AIES-38" };
const START_DIRECTIVE = {
  key: `plane:workitem(action="update",project_id="${PLANE_PROJECT.id}",state="${IN_PROGRESS}",workitem_id="${PLANE_WORKITEM_UUID}")`,
  server: "plane",
  tool: "workitem",
  args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: IN_PROGRESS },
  purpose: "update the ticket workflow state",
};
const NOTHING = { pending: null, pendingAction: null, doneGate: ALLOW };
const START = { pending: START_DIRECTIVE, pendingAction: "start", doneGate: ALLOW };
const HOLD = { kind: "completion", quote: "no cierres el ticket todavía" };

const PLANE_URL = "https://mcp.plane.so/http/mcp";
const profiles = [];

/** A profile written for this test; every one is removed after the file. */
function profileWith(servers, settings) {
  const profile = writeProfile({ "mcp-adapter.json": { ...templateProfile(), mcpServers: servers, ...(settings ? { settings } : {}) } });
  profiles.push(profile);
  return profile;
}

after(() => {
  for (const profile of profiles) profile.cleanup();
});

const trusted = trustedProfile();
profiles.push(trusted);

const TRUSTED = { ...NOTHING, trust: trusted.trust };
const withStart = { ...START, trust: trusted.trust };

function refuse(toolName, input, context, label) {
  const reason = planeWriteBypassReason(toolName, input, context);
  assert.match(reason ?? "", /^Bloqueado:/u, `${label}: must be refused`);
  return reason;
}

function pass(toolName, input, context, label) {
  assert.equal(planeWriteBypassReason(toolName, input, context), null, `${label}: must pass`);
}

describe("D38 attribution: server plane is exact, after trimming", () => {
  it("reads and the exact directive pass, and a state write without a directive is refused", () => {
    pass("mcp", { server: "plane", tool: "workitem", args: retrieve }, TRUSTED, "plane read");
    refuse("mcp", { server: "plane", tool: "workitem", args: stateUpdate }, TRUSTED, "plane state write, no directive");
    pass("mcp", { server: "plane", tool: "workitem", args: START_DIRECTIVE.args }, withStart, "plane exact start directive");
  });

  it("trims surrounding spaces, so ' plane ' is the declared server", () => {
    pass("mcp", { server: " plane ", tool: "workitem", args: retrieve }, TRUSTED, "padded plane read");
  });

  it("refuses a server spelled with other case or as another name, reads included, because it is not declared", () => {
    for (const server of ["Plane", "PLANE", "plane-dev", "miplane", "planeKey", "plane_extra", "_plane", "mcp_plane"]) {
      refuse("mcp", { server, tool: "workitem", args: retrieve }, TRUSTED, `undeclared server ${JSON.stringify(server)}`);
      refuse("mcp", { server, tool: "workitem", args: stateUpdate }, TRUSTED, `undeclared server ${JSON.stringify(server)}, state write`);
    }
  });

  it("refuses a server that is not text", () => {
    refuse("mcp", { server: 1, tool: "workitem", args: retrieve }, TRUSTED, "numeric server");
    refuse("mcp", { server: ["plane"], tool: "workitem", args: retrieve }, TRUSTED, "array server");
  });
});

describe("D38 attribution: the namespace tool is Plane by its exact name", () => {
  it("mcp__plane is read by the Plane rules, and its state write is refused without a directive", () => {
    pass("mcp__plane", { tool: "workitem", args: retrieve }, TRUSTED, "namespace read");
    refuse("mcp__plane", { tool: "workitem", args: stateUpdate }, TRUSTED, "namespace state write");
  });

  it("the exact directive passes through mcp__plane, as it does through server plane", () => {
    pass("mcp__plane", { tool: "workitem", args: START_DIRECTIVE.args }, withStart, "namespace exact start directive");
  });

  it("a name that differs by case or by an extra prefix is not that namespace, and is not a tool of a trusted profile", () => {
    for (const name of ["Mcp__Plane", "mcp__Plane", "mcp___plane", "mcp__plane_extra", "mcp__miplane"]) {
      pass(name, { tool: "workitem", args: stateUpdate }, TRUSTED, `${name} is not attributed`);
    }
  });

  it("the Linear namespace mcp__linear is Linear, and is not read by the Plane rules", () => {
    pass("mcp__linear", { tool: "save_issue", args: { id: "EZE-496", state: "Done" } }, TRUSTED, "linear namespace");
  });
});

describe("D38 attribution: Linear and the Pi and AIES tools are not affected by the Plane rules", () => {
  it("Linear's explicit server, and its four workflow tools with no server, pass", () => {
    pass("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-496", state: "Done" } }, TRUSTED, "linear save_issue");
    pass("mcp", { server: "linear", tool: "get_issue", args: { id: "EZE-496" } }, TRUSTED, "linear get_issue");
    pass("mcp", { tool: "get_issue", args: { id: "EZE-496" } }, TRUSTED, "workflow tool with no server");
    pass("mcp", { tool: "list_issue_statuses", args: {} }, TRUSTED, "workflow tool list with no server");
  });

  it("Pi's built-in tools and the AIES tools pass", () => {
    for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "tgrep", "aies_ticket", "aies_delegate", "aies_verify_complete"]) {
      pass(name, { path: "README.md" }, TRUSTED, name);
    }
  });
});

describe("D38 attribution: the hold names Plane by the same exact rule", () => {
  it("a hold refuses the state write through server plane and through mcp__plane", () => {
    assert.ok(holdBypassReason("mcp", { server: "plane", tool: "workitem", args: stateUpdate }, null, HOLD, trusted.trust), "server plane");
    assert.ok(holdBypassReason("mcp__plane", { tool: "workitem", args: stateUpdate }, null, HOLD, trusted.trust), "namespace");
    assert.equal(holdBypassReason("mcp", { server: "plane", tool: "workitem", args: retrieve }, null, HOLD, trusted.trust), null, "a read is not held");
  });

  it("an undeclared spelling is not held as Plane, and the write guard refuses it instead", () => {
    const input = { server: "Plane", tool: "workitem", args: stateUpdate };
    assert.equal(holdBypassReason("mcp", input, null, HOLD, trusted.trust), null);
    refuse("mcp", input, TRUSTED, "the write guard refuses the undeclared spelling");
  });
});

describe("D38 attribution: a profile that declares anything beyond the template is not trusted", () => {
  it("an alias pointed at the Plane endpoint makes Linear and every MCP call refused", () => {
    const profile = profileWith({
      linear: { url: "https://mcp.linear.app/mcp", auth: "oauth", lifecycle: "lazy" },
      plane: { url: PLANE_URL, auth: "oauth", lifecycle: "lazy" },
      "plane-dev": { url: PLANE_URL, auth: "oauth", lifecycle: "lazy" },
    });
    assert.equal(profile.trust.trusted, false);
    const context = { ...NOTHING, trust: profile.trust };
    refuse("mcp", { server: "linear", tool: "get_issue", args: { id: "EZE-496" } }, context, "linear on an untrusted profile");
    refuse("mcp", { server: "plane", tool: "workitem", args: retrieve }, context, "plane read on an untrusted profile");
    pass("read", { path: "README.md" }, context, "a Pi tool still runs");
  });

  it("a Plane server whose url differs from the template is not trusted", () => {
    const profile = profileWith({
      linear: { url: "https://mcp.linear.app/mcp", auth: "oauth", lifecycle: "lazy" },
      plane: { url: "https://plane.example.com/mcp", auth: "oauth", lifecycle: "lazy" },
    });
    assert.equal(profile.trust.trusted, false);
  });

  it("directTools on a Plane server, or in the settings, is not trusted, and the MCP_DIRECT_TOOLS variable is not trusted either", () => {
    const onServer = profileWith({
      linear: { url: "https://mcp.linear.app/mcp", auth: "oauth", lifecycle: "lazy" },
      plane: { url: PLANE_URL, auth: "oauth", lifecycle: "lazy", directTools: true },
    });
    assert.equal(onServer.trust.trusted, false);
    const inSettings = profileWith(templateProfile().mcpServers, { toolPrefix: "server", directTools: true });
    assert.equal(inSettings.trust.trusted, false);
    const env = { PI_CODING_AGENT_DIR: trusted.dir, PI_MCP_CONFIG_MODE: "exclusive" };
    assert.equal(evaluateMcpTrust(env, ["node", "pi"]).trusted, true, "the trusted profile itself is trusted");
    assert.equal(evaluateMcpTrust({ ...env, MCP_DIRECT_TOOLS: "plane" }, ["node", "pi"]).trusted, false, "a set MCP_DIRECT_TOOLS is not trusted");
    assert.equal(evaluateMcpTrust({ ...env, MCP_DIRECT_TOOLS: "   " }, ["node", "pi"]).trusted, true, "a blank MCP_DIRECT_TOOLS is trusted");
  });
});
