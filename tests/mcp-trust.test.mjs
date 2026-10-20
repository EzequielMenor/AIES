/**
 * D38: the trust in the MCP profile the adapter loads, and the guards that depend on it.
 *
 * (a) profiles that are trusted; (b) profiles that are not, and why; (c) on an untrusted profile no tool
 * outside Pi's and AIES's own runs, whatever its name, with no use of the adapter's naming rules; (d) the
 * session snapshot; (e) a small matrix on a trusted profile; (g) every AIES tool name is listed in NON_MCP_TOOL_NAMES.
 *
 * Profiles are temporary directories (`tests/helpers/mcp-profile.mjs`). No network, no credential.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { holdBypassReason, planeWriteBypassReason } from "../extensions/aies-agents/linear/pending-action.ts";
import {
  currentMcpTrust,
  evaluateMcpTrust,
  initMcpTrust,
  NON_MCP_TOOL_NAMES,
} from "../extensions/aies-agents/mcp/trust.ts";
import { QUIET_TOOL_NAMES } from "../extensions/aies-ui/tools.ts";
import { PLANE_PROJECT, PLANE_STATES, PLANE_WORKITEM_UUID } from "./helpers/plane-fixtures.mjs";
import { templateProfile, UNTRUSTED, writeProfile } from "./helpers/mcp-profile.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ARGV = ["node", "pi"];
const DONE = PLANE_STATES.find((state) => state.name === "Done").id;
const IN_PROGRESS = PLANE_STATES.find((state) => state.name === "In Progress").id;
const ALLOW = () => ({ allowed: true, reason: "Verification not required: docs only" });
const DENY = () => ({ allowed: false, reason: "Verification required: no verification run has been executed (status: none)" });
const PLANE_URL = "https://mcp.plane.so/http/mcp";
const LINEAR_URL = "https://mcp.linear.app/mcp";

const stateUpdate = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
const retrieve = { action: "retrieve_by_identifier", workitem_identifier: "AIES-38", expand: "state,project" };
const START_ARGS = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: IN_PROGRESS };
const DIRECTIVE = (args, action) => ({
  key: `plane:workitem(action="update",state="${args.state}")`,
  server: "plane",
  tool: "workitem",
  args,
  purpose: "update the ticket workflow state",
  action,
});
const NOTHING = { pending: null, pendingAction: null, doneGate: ALLOW };
const HOLD = { kind: "completion", quote: "no cierres el ticket todavía" };

/** Every profile this file writes, removed after the file. */
const made = [];
after(() => {
  for (const profile of made) profile.cleanup();
});

function make(files, options) {
  const profile = writeProfile(files, options);
  made.push(profile);
  return profile;
}

/** A copy of the template that `edit` mutates before it is written. */
function template(edit = () => {}) {
  const profile = templateProfile();
  edit(profile);
  return profile;
}

/** The verdict for a profile's directory with some environment variables changed (`undefined` removes one). */
function verdictWith(profile, change = {}, argv = ARGV) {
  const env = { ...profile.env };
  for (const [name, value] of Object.entries(change)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return evaluateMcpTrust(env, argv);
}

// ---------------------------------------------------------------------------------------------------------------
// (d) first: the snapshot reads the process-wide state, so it runs before any test that starts the extension.
// ---------------------------------------------------------------------------------------------------------------

describe("(d) the session snapshot: the profile is judged at start, and only an unchanged profile keeps its trust", () => {
  it("without a snapshot the profile is untrusted (fail closed)", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    assert.equal(currentMcpTrust(profile.env, ARGV).trusted, false);
  });

  it("a hostile profile at start that is repaired later stays untrusted", () => {
    const profile = make({ "mcp-adapter.json": template((p) => (p.mcpServers["plane-dev"] = { url: PLANE_URL, auth: "oauth" })) });
    assert.equal(initMcpTrust(profile.env, ARGV).trusted, false);
    writeFileSync(join(profile.dir, "mcp-adapter.json"), JSON.stringify(templateProfile()));
    assert.equal(currentMcpTrust(profile.env, ARGV).trusted, false, "the adapter did not reload, so the repair cannot raise trust");
  });

  it("a trusted profile that is unchanged stays trusted, with its servers", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    assert.equal(initMcpTrust(profile.env, ARGV).trusted, true);
    const trust = currentMcpTrust(profile.env, ARGV);
    assert.equal(trust.trusted, true);
    assert.deepEqual([...trust.servers].sort(), ["linear", "plane"]);
  });

  it("a trusted profile that is changed after start is blocked, with the reason that it changed", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    initMcpTrust(profile.env, ARGV);
    writeFileSync(join(profile.dir, "mcp-adapter.json"), JSON.stringify(template((p) => (p.mcpServers["plane-dev"] = { url: PLANE_URL, auth: "oauth" }))));
    const trust = currentMcpTrust(profile.env, ARGV);
    assert.equal(trust.trusted, false);
    assert.match(trust.reason, /cambió después de arrancar/u);
  });

  it("a legacy mcp.json added after start blocks the session, even when it is valid", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    initMcpTrust(profile.env, ARGV);
    writeFileSync(join(profile.dir, "mcp.json"), JSON.stringify(templateProfile()));
    assert.equal(currentMcpTrust(profile.env, ARGV).trusted, false);
  });

  it("a profile that is edited and then restored to its start content is trusted again", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    initMcpTrust(profile.env, ARGV);
    writeFileSync(join(profile.dir, "mcp-adapter.json"), "{}");
    assert.equal(currentMcpTrust(profile.env, ARGV).trusted, false);
    writeFileSync(join(profile.dir, "mcp-adapter.json"), JSON.stringify(templateProfile()));
    assert.equal(currentMcpTrust(profile.env, ARGV).trusted, true, "the digest of the files decides, not the history");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (a) trusted profiles
// ---------------------------------------------------------------------------------------------------------------

describe("(a) profiles that are trusted", () => {
  const cases = [
    ["the whole template", () => make({ "mcp-adapter.json": templateProfile() }), ["linear", "plane"]],
    ["only plane (a subset: mcpExcluded)", () => make({ "mcp-adapter.json": templateProfile(["plane"]) }), ["plane"]],
    ["only linear (a subset)", () => make({ "mcp-adapter.json": templateProfile(["linear"]) }), ["linear"]],
    ["no server at all", () => make({ "mcp-adapter.json": { settings: templateProfile().settings, mcpServers: {} } }), []],
    [
      "the real profile: linear with directTools false",
      () => make({ "mcp-adapter.json": template((p) => (p.mcpServers.linear.directTools = false)) }),
      ["linear", "plane"],
    ],
    [
      "a server disabled",
      () => make({ "mcp-adapter.json": template((p) => (p.mcpServers.plane.disabled = true)) }),
      ["linear", "plane"],
    ],
    [
      "a different lifecycle string",
      () => make({ "mcp-adapter.json": template((p) => (p.mcpServers.linear.lifecycle = "eager")) }),
      ["linear", "plane"],
    ],
    [
      "a legacy mcp.json identical to the template",
      () => make({ "mcp-adapter.json": templateProfile(), "mcp.json": templateProfile() }),
      ["linear", "plane"],
    ],
    ["a blank legacy mcp.json", () => make({ "mcp-adapter.json": templateProfile(), "mcp.json": "  \n" }), ["linear", "plane"]],
    [
      "settings that are the template's, with toolPrefix server and directTools false",
      () => make({ "mcp-adapter.json": template((p) => Object.assign(p.settings, { toolPrefix: "server", directTools: false })) }),
      ["linear", "plane"],
    ],
  ];

  for (const [label, build, servers] of cases) {
    it(`trusted: ${label}`, () => {
      const profile = build();
      assert.equal(profile.trust.trusted, true, `${label}: ${profile.trust.reason}`);
      assert.equal(profile.trust.reason, "");
      assert.deepEqual([...profile.trust.servers].sort(), servers);
    });
  }

  it("trusted through --mcp-config: the path the adapter reads in argv, with no mcp-adapter.json beside it", () => {
    const profile = make({ "custom.json": templateProfile() });
    const argv = ["node", "pi", "--mcp-config", join(profile.dir, "custom.json")];
    assert.equal(evaluateMcpTrust(profile.env, argv).trusted, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (b) profiles that are not trusted
// ---------------------------------------------------------------------------------------------------------------

describe("(b) profiles that are not trusted, and the reason is short and never echoes the file", () => {
  const cases = [
    ["an alias named plane-dev with the Plane url", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers["plane-dev"] = { url: PLANE_URL, auth: "oauth", lifecycle: "lazy" })) })],
    ["an alias named Plane", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.Plane = { url: PLANE_URL, auth: "oauth", lifecycle: "lazy" })) })],
    ["an alias named linear_x", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.linear_x = { url: LINEAR_URL, auth: "oauth", lifecycle: "lazy" })) })],
    ["an alias named miplane", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.miplane = { url: PLANE_URL, auth: "oauth", lifecycle: "lazy" })) })],
    ["an alias named aies_x", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.aies_x = { url: PLANE_URL, auth: "oauth", lifecycle: "lazy" })) })],
    ["a plane server with another url", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.plane.url = "https://plane.example.com/mcp")) })],
    ["a linear server with a different auth", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.linear.auth = "bearer")) })],
    ["a global toolPrefix", () => ({ "mcp-adapter.json": template((p) => (p.settings.toolPrefix = "short")) })],
    ["a toolPrefix on one server", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.plane.toolPrefix = "none")) })],
    ["directTools true on plane", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.plane.directTools = true)) })],
    ["directTools as the string \"false\"", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.linear.directTools = "false")) })],
    ["directTools true in the settings", () => ({ "mcp-adapter.json": template((p) => (p.settings.directTools = true)) })],
    ["imports with an entry", () => ({ "mcp-adapter.json": { ...template(), imports: ["other"] } })],
    ["imports, even empty", () => ({ "mcp-adapter.json": { ...template(), imports: [] } })],
    ["claudePlugins", () => ({ "mcp-adapter.json": { ...template(), claudePlugins: [] } })],
    ["mcp-servers with a server", () => ({ "mcp-adapter.json": { ...template(), "mcp-servers": { x: {} } } })],
    ["agentPluginPaths in the settings", () => ({ "mcp-adapter.json": template((p) => (p.settings.agentPluginPaths = ["/x"])) })],
    ["an unknown top-level key", () => ({ "mcp-adapter.json": { ...template(), pluginDirs: ["/x"] } })],
    ["a command on a server", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.plane.command = "npx")) })],
    ["args on a server", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.plane.args = ["x"])) })],
    ["env on a server", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.linear.env = { X: "1" })) })],
    ["headers on a server", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.linear.headers = { X: "1" })) })],
    ["lifecycle that is not text", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.linear.lifecycle = 3)) })],
    ["disabled that is not a boolean", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.plane.disabled = "yes")) })],
    ["a server definition that is not an object", () => ({ "mcp-adapter.json": template((p) => (p.mcpServers.plane = "x")) })],
    ["mcpServers that is an array", () => ({ "mcp-adapter.json": { ...template(), mcpServers: [] } })],
    ["settings that is not an object", () => ({ "mcp-adapter.json": { ...template(), settings: "x" } })],
    ["a corrupt JSON file", () => ({ "mcp-adapter.json": "{ not json" })],
    ["a JSON array instead of an object", () => ({ "mcp-adapter.json": "[]" })],
    ["a blank mcp-adapter.json", () => ({ "mcp-adapter.json": "  " })],
    ["a corrupt legacy mcp.json, with a valid main file", () => ({ "mcp-adapter.json": templateProfile(), "mcp.json": "{" })],
    ["a legacy mcp.json with an alias, with a valid main file", () => ({ "mcp-adapter.json": templateProfile(), "mcp.json": { mcpServers: { "plane-dev": { url: PLANE_URL, auth: "oauth" } } } })],
    ["no mcp-adapter.json at all", () => ({ "mcp.json": templateProfile() })],
  ];

  for (const [label, files] of cases) {
    it(`untrusted: ${label}`, () => {
      const profile = make(files());
      assert.equal(profile.trust.trusted, false, label);
      assert.notEqual(profile.trust.reason, "", label);
      assert.equal(profile.trust.servers.size, 0, "an untrusted profile declares no servers for the guard");
      assert.doesNotMatch(profile.trust.reason, /plane-dev|Plane|miplane|linear_x|aies_x|https?:|mcp\.json|mcp-adapter/u, "the reason does not echo the file");
    });
  }

  it("untrusted: a --mcp-config path that does not exist, with a valid profile beside it", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    assert.equal(evaluateMcpTrust(profile.env, ["node", "pi", "--mcp-config", join(profile.dir, "missing.json")]).trusted, false);
  });

  it("untrusted: a --mcp-config path that is a corrupt file", () => {
    const profile = make({ "bad.json": "{" });
    assert.equal(evaluateMcpTrust(profile.env, ["node", "pi", "--mcp-config", join(profile.dir, "bad.json")]).trusted, false);
  });

  it("untrusted: any mode but exactly exclusive, including the unset one and the other case", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    for (const mode of ["shared", "Exclusive", " exclusive ", ""]) {
      assert.equal(verdictWith(profile, { PI_MCP_CONFIG_MODE: mode }).trusted, false, `mode ${JSON.stringify(mode)}`);
    }
    assert.equal(verdictWith(profile, { PI_MCP_CONFIG_MODE: undefined }).trusted, false, "unset");
  });

  it("untrusted: MCP_DIRECT_TOOLS set to anything that is not blank", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    assert.equal(verdictWith(profile, { MCP_DIRECT_TOOLS: "plane" }).trusted, false);
    assert.equal(verdictWith(profile, { MCP_DIRECT_TOOLS: "true" }).trusted, false);
    assert.equal(verdictWith(profile, { MCP_DIRECT_TOOLS: "   " }).trusted, true, "blank is not direct tools");
  });

  it("untrusted: no PI_CODING_AGENT_DIR, so the profile cannot be located", () => {
    const profile = make({ "mcp-adapter.json": templateProfile() });
    assert.equal(verdictWith(profile, { PI_CODING_AGENT_DIR: undefined }).trusted, false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (c) property: on an untrusted profile nothing but Pi's and AIES's own tools runs
// ---------------------------------------------------------------------------------------------------------------

const PROPERTY_NAMES = [
  "workitem", "mcp__plane", "plane_workitem", "mcp", "linear_save_issue", "mcpScript", "mcpscript", "MCPSCRIPT",
  "mcp Script", " mcpScript ", "mcp_script", "mcp-script", "mcp.script", "Plane", "plane", "PLANE", "linear",
  "linear_get_issue", "mcp__linear", "mcp__linear_save_issue", "mcp___plane", "_plane_workitem",
  "plane-dev_workitem", "miplane_workitem", "aies_x", "AIES_TICKET", "aies_ticket_x", "Read", "READ", "read ",
  "edit_file", "tgrep_x", "list_issue_statuses", "save_comment", "get_pql_reference", "workitem_comment",
  "mcp__plane__workitem", "mcp-plane", "mcp.plane", "x", "foo", "some_tool", "", "   ",
];

const PROPERTY_INPUTS = [
  undefined,
  {},
  { server: "plane", tool: "workitem", args: stateUpdate },
  { tool: "workitem", args: stateUpdate },
  { tool: "get_issue", args: { id: "EZE-1" } },
  { server: "linear", tool: "save_issue", args: { id: "EZE-1", state: "Done" } },
  { action: "install", server: "plane" },
  { action: "search" },
  { server: "plane", tool: "workitem", args: retrieve },
  { path: "README.md" },
];

/** Deterministic combinations of name parts: a broader net than the list above, with no adapter rule in it. */
const PARTS = ["mcp", "plane", "linear", "workitem", "aies", "_", "-", " ", "__", "save_issue", "state", "x"];
function generatedNames() {
  const names = [];
  for (const a of PARTS) {
    for (const b of PARTS) {
      names.push(`${a}${b}`);
      for (const c of PARTS) names.push(`${a}${b}${c}`);
    }
  }
  return names;
}

describe("(c) property: on an untrusted profile, a tool outside Pi and AIES is refused whatever its name", () => {
  const untrustedContext = { ...NOTHING, trust: UNTRUSTED };
  const names = [...new Set([...PROPERTY_NAMES, ...generatedNames()])].filter((name) => !NON_MCP_TOOL_NAMES.has(name));

  it("refuses every name that is not Pi's or AIES's, for every input shape", () => {
    const passed = [];
    for (const name of names) {
      for (const input of PROPERTY_INPUTS) {
        if (planeWriteBypassReason(name, input, untrustedContext) === null) passed.push(name);
      }
    }
    assert.deepEqual([...new Set(passed)], [], "no name outside Pi and AIES may run on an untrusted profile");
  });

  it("lets Pi's built-in tools and AIES's own tools through, whatever the input", () => {
    for (const name of NON_MCP_TOOL_NAMES) {
      for (const input of PROPERTY_INPUTS) {
        assert.equal(planeWriteBypassReason(name, input, untrustedContext), null, `${name} must pass`);
      }
    }
  });

  it("refuses an untrusted call with a Spanish reason that says the profile is not the one AIES knows", () => {
    const reason = planeWriteBypassReason("linear_get_issue", undefined, { ...NOTHING, trust: { ...UNTRUSTED, reason: "perfil de prueba" } });
    assert.match(reason, /^Bloqueado:/u);
    assert.match(reason, /no es el que AIES conoce/u);
    assert.match(reason, /mcp-adapter\.json/u, "the next step names the file to restore");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// (e) a matrix on a trusted profile
// ---------------------------------------------------------------------------------------------------------------------

describe("(e) the matrix on a trusted profile", () => {
  const trust = make({ "mcp-adapter.json": templateProfile() }).trust;
  const context = (extra = {}) => ({ ...NOTHING, trust, ...extra });
  const startContext = (extra = {}) => context({ pending: DIRECTIVE(START_ARGS, "start"), pendingAction: "start", ...extra });
  const completeContext = (extra = {}) =>
    context({ pending: DIRECTIVE({ ...START_ARGS, state: DONE }, "complete"), pendingAction: "complete", doneGate: ALLOW, ...extra });

  it("reads pass on server plane, and through the namespace", () => {
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem", args: retrieve }, context()), null);
    assert.equal(planeWriteBypassReason("mcp__plane", { tool: "workitem", args: retrieve }, context()), null);
  });

  it("writes on Plane that are not on the list are refused", () => {
    for (const args of [
      { action: "delete", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID },
      { action: "create", project_id: PLANE_PROJECT.id, name: "x" },
      { action: "archive", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID },
    ]) {
      assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem", args }, startContext()) ?? "", /^Bloqueado:/u, args.action);
    }
    assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "state", args: { action: "create", project_id: PLANE_PROJECT.id } }, context()) ?? "", /^Bloqueado:/u);
    assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem_comment", args: { action: "delete" } }, context()) ?? "", /^Bloqueado:/u);
  });

  it("the adapter's listed form plane_<tool> is read as <tool> on server plane or with no server, and gets the same rules", () => {
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "plane_project", args: { action: "list", per_page: 100 } }, context()), null);
    assert.equal(planeWriteBypassReason("mcp", { tool: "plane_project", args: { action: "list", per_page: 100 } }, context()), null, "no server");
    assert.match(planeWriteBypassReason("mcp", { tool: "plane_workitem", args: { action: "delete", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID } }, startContext()) ?? "", /^Bloqueado:/u, "no server, write");
    assert.match(planeWriteBypassReason("mcp", { tool: "plane_workitem", args: { ...START_ARGS } }, context()) ?? "", /^Bloqueado:/u, "no server, no directive");
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "plane_workitem", args: retrieve }, context()), null);
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "plane_workitem_comment", args: { action: "create", comment_html: "<p>x</p>" } }, context()), null);
    // The same writes are refused through the prefixed name, and the exact directive passes only as for the bare name.
    assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "plane_workitem", args: { action: "delete", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID } }, startContext()) ?? "", /^Bloqueado:/u);
    assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "plane_workitem", args: { ...START_ARGS } }, context()) ?? "", /^Bloqueado:/u);
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "plane_workitem", args: { ...START_ARGS } }, startContext()), null);
    // Anything else with the prefix stays unknown: unknown tool, doubled prefix, another server.
    for (const input of [
      { server: "plane", tool: "plane_nope", args: retrieve },
      { server: "plane", tool: "plane_plane_workitem", args: retrieve },
      { tool: "plane_plane_workitem", args: retrieve },
      { server: "linear", tool: "plane_workitem", args: { ...START_ARGS } },
    ]) {
      const reason = planeWriteBypassReason("mcp", input, context());
      if (input.server === "linear") assert.equal(reason, null, "a declared other server is not Plane");
      else assert.match(reason ?? "", /^Bloqueado:/u, JSON.stringify(input));
    }
  });

  describe("the listed form plane_<tool>, on server plane and with no server", () => {
    const doneArgs = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    const comment = { action: "create", comment_html: "<p>x</p>" };
    // The same call twice: with `server: "plane"` and with no server at all (the model often omits it).
    const forms = [
      ["server plane", (tool, args) => ({ server: "plane", tool, args })],
      ["no server", (tool, args) => ({ tool, args })],
    ];

    for (const [label, call] of forms) {
      it(`${label}: a read passes, a comment create passes, and a read of the prefixed tool is read as the bare one`, () => {
        // Regression: the prefixed name passes only because the guard strips the exact `plane_` prefix of a known tool.
        // Without that branch `plane_project` would be an unknown tool and refused.
        assert.equal(planeWriteBypassReason("mcp", call("plane_project", { action: "list", per_page: 100 }), context()), null);
        assert.equal(planeWriteBypassReason("mcp", call("plane_workitem", retrieve), context()), null);
        assert.equal(planeWriteBypassReason("mcp", call("plane_workitem_comment", comment), context()), null);
        assert.match(
          planeWriteBypassReason("mcp", call("plane_workitem_comment", { action: "delete" }), context()) ?? "",
          /^Bloqueado:/u,
          "a comment delete stays refused",
        );
      });

      it(`${label}: a state update passes only with the exact directive, and completion only while the Done Gate allows it`, () => {
        assert.equal(planeWriteBypassReason("mcp", call("plane_workitem", { ...START_ARGS }), startContext()), null, "exact start directive");
        assert.match(planeWriteBypassReason("mcp", call("plane_workitem", { ...START_ARGS }), context()) ?? "", /aies_ticket/u, "no directive");
        assert.match(planeWriteBypassReason("mcp", call("plane_workitem", doneArgs), startContext()) ?? "", /^Bloqueado:/u, "completion with the start directive");
        assert.equal(planeWriteBypassReason("mcp", call("plane_workitem", doneArgs), completeContext()), null, "completion, gate allows");
        assert.match(
          planeWriteBypassReason("mcp", call("plane_workitem", doneArgs), completeContext({ doneGate: DENY })) ?? "",
          /Done Gate/u,
          "completion, gate denies",
        );
        for (const action of ["create", "delete", "archive"]) {
          assert.match(
            planeWriteBypassReason("mcp", call("plane_workitem", { action, project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, name: "x" }), startContext()) ?? "",
            /^Bloqueado:/u,
            `${action} stays refused`,
          );
        }
      });

      it(`${label}: a hold refuses the prefixed state move, and leaves a prefixed comment and read alone`, () => {
        assert.ok(holdBypassReason("mcp", call("plane_workitem", doneArgs), null, HOLD, trust), "state move under hold");
        assert.equal(holdBypassReason("mcp", call("plane_workitem_comment", comment), null, HOLD, trust), null);
        assert.equal(holdBypassReason("mcp", call("plane_workitem", retrieve), null, HOLD, trust), null);
        // A prefixed name the guard does not know is not a state move it could let through: the write guard refuses it.
        assert.match(planeWriteBypassReason("mcp", call("plane_nope", doneArgs), startContext()) ?? "", /^Bloqueado:/u);
      });

      it(`${label}: names that are not exactly plane_<known tool> stay unknown and are refused, even with a directive`, () => {
        for (const tool of [
          "plane_nope", "plane_plane_workitem", "plane-workitem", "plane workitem", "plane_ workitem", "plane__workitem",
          "linear_workitem", "plane_save_issue", "plane_get_issue", "plane_", "plane", "workitem_plane",
        ]) {
          assert.match(
            planeWriteBypassReason("mcp", call(tool, { ...START_ARGS }), startContext()) ?? "",
            /^Bloqueado:/u,
            `${tool} must not pass as a state move`,
          );
        }
      });

      it(`${label}: capitals and spaces around a known name get the bare tool's rules, never looser`, () => {
        for (const tool of ["Plane_Workitem", "PLANE_WORKITEM", " plane_workitem "]) {
          assert.match(planeWriteBypassReason("mcp", call(tool, { ...START_ARGS }), context()) ?? "", /aies_ticket/u, `${tool}: no directive`);
          assert.match(planeWriteBypassReason("mcp", call(tool, { action: "delete", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID }), startContext()) ?? "", /^Bloqueado:/u, `${tool}: delete`);
        }
      });
    }

    it("an undeclared server with a prefixed name is refused, and so is a server spelt with capitals", () => {
      for (const server of ["Plane", " PLANE ", "plane-dev", "plane_dev", "miplane", "linear_x"]) {
        assert.match(
          planeWriteBypassReason("mcp", { server, tool: "plane_workitem", args: retrieve }, context()) ?? "",
          /no está declarado/u,
          `server ${server}`,
        );
      }
    });

    it("the prefix is read once: plane_plane_workitem is not plane_workitem, on either form", () => {
      assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "plane_plane_workitem", args: retrieve }, context()) ?? "", /^Bloqueado:/u);
      assert.match(planeWriteBypassReason("mcp", { tool: "plane_plane_workitem", args: retrieve }, context()) ?? "", /^Bloqueado:/u);
    });
  });

  it("a comment create passes", () => {
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem_comment", args: { action: "create", comment_html: "<p>x</p>" } }, context()), null);
  });

  it("a state update with the exact directive that start issued passes", () => {
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem", args: { ...START_ARGS } }, startContext()), null);
  });

  it("a state update without a directive is refused", () => {
    assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem", args: { ...START_ARGS } }, context()) ?? "", /aies_ticket/u);
  });

  it("a state update with the completion directive passes while the Done Gate allows it, and is refused when it does not", () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    assert.equal(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem", args }, completeContext()), null);
    assert.match(planeWriteBypassReason("mcp", { server: "plane", tool: "workitem", args }, completeContext({ doneGate: DENY })) ?? "", /Done Gate/u);
  });

  it("a hold refuses the state move, and leaves a comment and a read alone", () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    assert.ok(holdBypassReason("mcp", { server: "plane", tool: "workitem", args }, null, HOLD, trust), "state move under hold");
    assert.equal(holdBypassReason("mcp", { server: "plane", tool: "workitem_comment", args: { action: "create" } }, null, HOLD, trust), null);
    assert.equal(holdBypassReason("mcp", { server: "plane", tool: "workitem", args: retrieve }, null, HOLD, trust), null);
  });

  it("Linear's get_issue and save_issue behave as before: passed, and a completion is held against the active ticket", () => {
    assert.equal(planeWriteBypassReason("mcp", { server: "linear", tool: "get_issue", args: { id: "EZE-503" } }, context()), null);
    assert.equal(planeWriteBypassReason("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-503", state: "In Progress" } }, context()), null);
    assert.equal(planeWriteBypassReason("mcp", { tool: "get_issue", args: { id: "EZE-503" } }, context()), null);
    const active = { identifier: "EZE-503" };
    assert.ok(holdBypassReason("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-503", state: "Done" } }, active, HOLD, trust));
    assert.equal(holdBypassReason("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-503", state: "Done" } }, null, HOLD, trust), null);
  });

  it("mcpScript is refused whatever its spelling, and install is refused under every server", () => {
    for (const name of ["mcpScript", "mcpscript", "MCP_SCRIPT", "mcp script", " mcpScript "]) {
      assert.match(planeWriteBypassReason(name, { script: "x" }, context()) ?? "", /^Bloqueado:/u, name);
    }
    for (const server of ["plane", "linear", undefined]) {
      assert.match(planeWriteBypassReason("mcp", { server, action: "install", url: "x" }, context()) ?? "", /^Bloqueado:/u, `install under ${server}`);
    }
  });

  it("capitalised spellings are not attributed: the tool name Plane passes, and the server Plane is refused as undeclared", () => {
    assert.equal(planeWriteBypassReason("Plane", { tool: "workitem", args: stateUpdate }, context()), null, "no tool is named Plane");
    assert.match(planeWriteBypassReason("mcp", { server: "Plane", tool: "workitem", args: retrieve }, context()) ?? "", /no está declarado/u);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// (g) the AIES tool names
// ---------------------------------------------------------------------------------------------------------------

const EXTENSIONS = join(REPO, "extensions");

/** Every `.ts` file under a directory, recursively. */
function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("(g) every tool AIES registers is listed in NON_MCP_TOOL_NAMES, so a new one cannot slip past the guard", () => {
  const sources = tsFiles(EXTENSIONS).map((path) => [path.slice(REPO.length + 1), readFileSync(path, "utf-8")]);

  it("every aies_* name in extensions/ is listed", () => {
    const found = new Set();
    for (const [, text] of sources) {
      for (const match of text.matchAll(/\baies_[a-z][a-z_]*[a-z]\b/gu)) found.add(match[0]);
    }
    assert.ok(found.size > 0, "the scan finds the AIES tools");
    const unlisted = [...found].filter((name) => !NON_MCP_TOOL_NAMES.has(name));
    assert.deepEqual(unlisted, [], "add the new aies_* tool to NON_MCP_TOOL_NAMES in extensions/aies-agents/mcp/trust.ts");
  });

  it("every name given to pi.registerTool({ name, ... }) is listed, and an unresolvable name fails the test", () => {
    const registered = new Set();
    const unresolved = [];
    for (const [path, text] of sources) {
      for (const match of text.matchAll(/registerTool\(\s*\{/gu)) {
        const window = text.slice(match.index, match.index + 600);
        // `name: "x"`, `name: someConst`, or the shorthand `name,` of a loop variable.
        const named = /\bname\s*(?::\s*(?:"([^"]+)"|([A-Za-z_]\w*))|(,))/u.exec(window);
        if (!named) {
          unresolved.push(`${path}: no name`);
        } else if (named[1]) {
          registered.add(named[1]);
        } else {
          const identifier = named[2] ?? "name";
          const constant = new RegExp(`const\\s+${identifier}\\s*=\\s*"([^"]+)"`, "u").exec(text);
          if (constant) registered.add(constant[1]);
          else if (identifier === "name" && text.includes("QUIET_TOOL_NAMES")) for (const quiet of QUIET_TOOL_NAMES) registered.add(quiet);
          else unresolved.push(`${path}: name ${identifier}`);
        }
      }
    }
    assert.deepEqual(unresolved, [], "every registered name must be resolvable by this scan");
    assert.ok(QUIET_TOOL_NAMES.every((name) => registered.has(name)), "the scan sees the quiet Pi tools registered by name");
    assert.deepEqual([...registered].filter((name) => !NON_MCP_TOOL_NAMES.has(name)), []);
  });
});
