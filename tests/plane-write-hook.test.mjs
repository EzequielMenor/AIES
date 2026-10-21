/**
 * D33 phase 4 (part C): the Plane write guard, driven through the real agents
 * extension's `tool_call` and `tool_result` handlers.
 *
 * The Parent's `mcp` calls are answered by the offline Plane simulator, exactly as
 * the adapter would answer them. A state write reaches Plane only when it matches the
 * directive `aies_ticket` has pending; every other write is refused by the hook and
 * the simulator keeps the work item where it was. No network, no credential, and the
 * profile is a temporary directory of this test.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesAgents, { getActiveTicketManager } from "../extensions/aies-agents/index.ts";
import { createPlaneMcpSimulator } from "./helpers/plane-mcp-simulator.mjs";
import { PLANE_PROJECT, PLANE_STATES, PLANE_WORKITEM_UUID, planeWorkItem } from "./helpers/plane-fixtures.mjs";
import { templateProfile } from "./helpers/mcp-profile.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const DESCRIPTION = "## Acceptance Criteria\n- [ ] The Plane write guard holds\n";
const DONE = PLANE_STATES.find((state) => state.name === "Done").id;
const BACKLOG = PLANE_STATES.find((state) => state.name === "Backlog").id;
const TODO = PLANE_STATES.find((state) => state.name === "Todo").id;
const OTHER_WORKITEM = "11111111-2222-4333-8444-555555555555";

/**
 * A committed, clean throwaway repository. The Done Gate reads the working tree of the
 * session (EZE-496), so the hook runs in one that has no change of its own to report.
 */
function createCleanRepo(dir) {
  const repoDir = join(dir, "repo");
  mkdirSync(repoDir);
  const git = (...args) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(dir, "no-hooks")}`, ...args],
      { cwd: repoDir, stdio: ["ignore", "pipe", "pipe"] },
    );
  git("init", "-q");
  writeFileSync(join(repoDir, "README.md"), "# Throwaway\n");
  git("add", "-A");
  git("commit", "-q", "-m", "chore: seed");
  return repoDir;
}

function hookContext() {
  return { cwd: REPO, mode: "print", hasUI: false, getContextUsage: () => undefined };
}

/** The real extension, with the handlers Pi would call for the Parent's session. */
function createHost() {
  const handlers = new Map();
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    getActiveTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    appendEntry() {},
    sendUserMessage() {},
  };
  aiesAgents(pi);
  return {
    async input(text) {
      for (const handler of handlers.get("input") ?? []) {
        await handler({ type: "input", text, source: "interactive" }, hookContext());
      }
    },
    /** The first block a `tool_call` handler returns, or null when the call may run. */
    async toolCall(toolName, input) {
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = await handler({ type: "tool_call", toolName, input }, hookContext());
        if (result && result.block) return result;
      }
      return null;
    },
    /** The `tool_result` handlers, which capture the answer of a pending `mcp` call. */
    async toolResult(toolName, input, content) {
      for (const handler of handlers.get("tool_result") ?? []) {
        await handler({ type: "tool_result", toolName, input, content, isError: false }, hookContext());
      }
    },
  };
}

function workitemCall(args) {
  return { server: "plane", tool: "workitem", args };
}

function stateWrite(state, workitem = PLANE_WORKITEM_UUID) {
  return workitemCall({ action: "update", project_id: PLANE_PROJECT.id, workitem_id: workitem, state });
}

/**
 * Answer the pending `mcp` directives the way the Parent does, one by one, through the
 * hook. Every call the Parent makes for the directive must pass the hook; `stopBefore`
 * halts the drive when the pending directive matches it, so a test can attack that
 * exact moment.
 */
async function drive(host, simulator, manager, stopBefore = () => false) {
  for (let guard = 0; guard < 20; guard += 1) {
    const directive = manager.getPendingDirective();
    if (!directive || stopBefore(directive)) return directive;
    const input = { server: directive.server, tool: directive.tool, args: structuredClone(directive.args) };
    const block = await host.toolCall("mcp", input);
    assert.equal(block, null, `the Parent's answer to ${directive.tool} ${directive.args.action} must pass: ${block?.reason}`);
    await host.toolResult("mcp", input, simulator.answer(directive).content);
  }
  assert.fail("the mediated operation did not settle");
}

const isStateUpdate = (directive) => directive.tool === "workitem" && directive.args.action === "update";

/** Load the ticket and start it, answering every directive through the hook. */
async function loadAndStart(host, simulator, manager) {
  await manager.loadTicket("AIES-38");
  await drive(host, simulator, manager);
  await manager.startWork();
  await drive(host, simulator, manager);
}

describe("D33 phase 4 (C): the Plane write guard through the real hook", () => {
  let savedAgentDir;
  let savedMode;
  let agentDir;
  let simulator;
  let host;
  let savedCwd;
  let repoRoot;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedMode = process.env.PI_MCP_CONFIG_MODE;
    savedCwd = process.cwd();
    repoRoot = mkdtempSync(join(tmpdir(), "aies-plane-hook-repo-"));
    process.chdir(createCleanRepo(repoRoot));
    agentDir = mkdtempSync(join(tmpdir(), "aies-plane-hook-"));
    writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ tracker: "plane" }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // D38: a trusted MCP profile, the repo template in exclusive mode (the hook refuses anything else).
    writeFileSync(join(agentDir, "mcp-adapter.json"), JSON.stringify(templateProfile()));
    process.env.PI_MCP_CONFIG_MODE = "exclusive";
    simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, description: DESCRIPTION })]);
    host = createHost();
    getActiveTicketManager().reset();
  });

  afterEach(() => {
    getActiveTicketManager().reset();
    process.chdir(savedCwd);
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedMode === undefined) delete process.env.PI_MCP_CONFIG_MODE;
    else process.env.PI_MCP_CONFIG_MODE = savedMode;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function stateOf() {
    return simulator.workItem(PLANE_WORKITEM_UUID).state.name;
  }

  it("refuses a state write when no directive is pending, and Plane keeps its state", async () => {
    const manager = getActiveTicketManager();
    await manager.loadTicket("AIES-38");
    await drive(host, simulator, manager);
    assert.equal(manager.getActiveTicket().identifier, "AIES-38");

    const block = await host.toolCall("mcp", stateWrite(DONE));
    assert.ok(block, "a state write with no pending directive must be refused by the hook");
    assert.match(block.reason, /Bloqueado/);
    assert.equal(stateOf(), "Todo");
  });

  it("completes the ticket end to end through the real hook, with every Parent call passing the guard", async () => {
    const manager = getActiveTicketManager();
    await manager.loadTicket("AIES-38");
    await drive(host, simulator, manager);

    await manager.startWork();
    await drive(host, simulator, manager);
    assert.equal(stateOf(), "In Progress");

    manager.recordChangedPaths(["docs/notes.md"]);
    manager.declareNoCodeException("test fixture: documentation only");
    await manager.completeTicket();
    await drive(host, simulator, manager);

    assert.equal(stateOf(), "Done");
    assert.equal(simulator.comments.length, 1);
    assert.equal(manager.getActiveTicket().statusType, "completed");
  });

  it("refuses every other workitem, state, project or extra key while the exact directive is pending", async () => {
    const manager = getActiveTicketManager();
    await loadAndStart(host, simulator, manager);
    manager.recordChangedPaths(["docs/notes.md"]);
    manager.declareNoCodeException("test fixture: documentation only");
    await manager.completeTicket();

    const pending = await drive(host, simulator, manager, isStateUpdate);
    assert.ok(pending && isStateUpdate(pending), "the complete operation must be waiting for its state write");

    const attacks = [
      ["another work item", stateWrite(DONE, OTHER_WORKITEM)],
      ["another state", stateWrite(BACKLOG)],
      ["another project", workitemCall({ action: "update", project_id: OTHER_WORKITEM, workitem_id: PLANE_WORKITEM_UUID, state: DONE })],
      ["an extra key", workitemCall({ ...pending.args, name: "Renamed while closing" })],
    ];
    for (const [label, input] of attacks) {
      const block = await host.toolCall("mcp", input);
      assert.ok(block, `a state write to ${label} must be refused while the directive is pending`);
    }
    assert.equal(stateOf(), "In Progress", "no refused attempt changed the work item");

    assert.equal(await host.toolCall("mcp", workitemCall({ ...pending.args })), null, "the exact directive still passes");
    await host.toolResult("mcp", workitemCall({ ...pending.args }), simulator.answer(pending).content);
    await drive(host, simulator, manager);
    assert.equal(stateOf(), "Done");
  });

  it("refuses the exact directive when the Done Gate no longer allows completion", async () => {
    const manager = getActiveTicketManager();
    await loadAndStart(host, simulator, manager);
    manager.recordChangedPaths(["docs/notes.md"]);
    manager.declareNoCodeException("test fixture: documentation only");
    await manager.completeTicket();
    const pending = await drive(host, simulator, manager, isStateUpdate);
    assert.ok(isStateUpdate(pending));

    // The Parent changes behaviour-bearing code after the directive was issued.
    const edit = await host.toolCall("edit", { path: "extensions/aies-agents/linear/manager.ts" });
    assert.equal(edit, null, "the edit itself is not what this guard refuses");

    const block = await host.toolCall("mcp", workitemCall({ ...pending.args }));
    assert.ok(block, "completion must not run on a directive whose Done Gate has closed");
    assert.match(block.reason, /Done Gate/);
    assert.equal(stateOf(), "In Progress");
  });

  it("a hold stands against the exact directive that was pending", async () => {
    const manager = getActiveTicketManager();
    await loadAndStart(host, simulator, manager);
    manager.recordChangedPaths(["docs/notes.md"]);
    manager.declareNoCodeException("test fixture: documentation only");
    await manager.completeTicket();
    const pending = await drive(host, simulator, manager, isStateUpdate);
    assert.ok(isStateUpdate(pending));

    await host.input("no lo cierres todavía, quiero revisarlo antes");
    const block = await host.toolCall("mcp", workitemCall({ ...pending.args }));
    assert.ok(block, "a hold outranks the pending directive");
    assert.match(block.reason, /Plane/);
    assert.equal(stateOf(), "In Progress");
  });

  it("refuses state, intake and unknown writes during the authorised flow", async () => {
    const manager = getActiveTicketManager();
    await loadAndStart(host, simulator, manager);
    manager.recordChangedPaths(["docs/notes.md"]);
    manager.declareNoCodeException("test fixture: documentation only");
    await manager.completeTicket();
    await drive(host, simulator, manager, isStateUpdate);

    const refused = [
      ["state update", { server: "plane", tool: "state", args: { action: "update", project_id: PLANE_PROJECT.id, state: DONE } }],
      ["state delete", { server: "plane", tool: "state", args: { action: "delete", project_id: PLANE_PROJECT.id, state: BACKLOG } }],
      ["state create", { server: "plane", tool: "state", args: { action: "create", project_id: PLANE_PROJECT.id, group: "completed" } }],
      ["intake update", { server: "plane", tool: "intake", args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, status: 1 } }],
      ["intake delete", { server: "plane", tool: "intake", args: { action: "delete", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID } }],
      ["unknown workitem action", workitemCall({ action: "bulk_transition", project_id: PLANE_PROJECT.id, state: DONE })],
    ];
    for (const [label, input] of refused) {
      const block = await host.toolCall("mcp", input);
      assert.ok(block, `${label} must be refused by the hook`);
      assert.match(block.reason, /Bloqueado/);
    }
    assert.equal(stateOf(), "In Progress");
  });

  it("lets the Parent comment and read while a directive is pending", async () => {
    const manager = getActiveTicketManager();
    await loadAndStart(host, simulator, manager);
    manager.recordChangedPaths(["docs/notes.md"]);
    manager.declareNoCodeException("test fixture: documentation only");
    await manager.completeTicket();
    await drive(host, simulator, manager, isStateUpdate);

    const comment = await host.toolCall("mcp", {
      server: "plane",
      tool: "workitem_comment",
      args: { action: "create", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, comment_html: "<p>note</p>" },
    });
    const read = await host.toolCall("mcp", workitemCall({ action: "retrieve_by_identifier", workitem_identifier: "AIES-38", expand: "state,project" }));
    assert.equal(comment, null);
    assert.equal(read, null);
  });

  it("leaves Linear's calls untouched by the Plane rules", async () => {
    const block = await host.toolCall("mcp", {
      server: "linear",
      tool: "save_issue",
      args: { id: "EZE-496", state: "Done" },
    });
    assert.equal(block, null, "without a hold, a Linear call is not refused by the Plane guard");
  });
});

describe("D33 phase 4 (C, follow-up): the real hook and the names the adapter resolves", () => {
  let savedAgentDir;
  let savedMode;
  let agentDir;

  function profile(config) {
    writeFileSync(join(agentDir, "aies.json"), JSON.stringify(config));
  }

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedMode = process.env.PI_MCP_CONFIG_MODE;
    agentDir = mkdtempSync(join(tmpdir(), "aies-plane-hook-names-"));
    profile({ tracker: "plane" });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // D38: a trusted MCP profile, the repo template in exclusive mode (the hook refuses anything else).
    writeFileSync(join(agentDir, "mcp-adapter.json"), JSON.stringify(templateProfile()));
    process.env.PI_MCP_CONFIG_MODE = "exclusive";
    getActiveTicketManager().reset();
  });

  afterEach(() => {
    getActiveTicketManager().reset();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedMode === undefined) delete process.env.PI_MCP_CONFIG_MODE;
    else process.env.PI_MCP_CONFIG_MODE = savedMode;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("refuses a state write named plane_workitem with no server, and the hold refuses it too", async () => {
    const host = createHost();
    const input = { tool: "plane_workitem", args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE } };
    assert.ok(await host.toolCall("mcp", input), "a prefixed state write with no directive is refused");
    await host.input("no lo cierres todavía, quiero revisarlo antes");
    assert.ok(await host.toolCall("mcp", input), "a hold refuses the prefixed state write as well");
  });

  it("refuses a namespace mcp__plane state write, and a direct plane_<tool> on a profile that is not trusted", async () => {
    const args = { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE };
    assert.ok(await createHost().toolCall("mcp__plane", { tool: "workitem", args }));
    // D38: a trusted profile has no direct tools; on a profile that is not exclusive nothing but Pi and AIES runs.
    process.env.PI_MCP_CONFIG_MODE = "shared";
    assert.ok(await createHost().toolCall("plane_workitem", args), "a direct state write is refused");
    assert.ok(await createHost().toolCall("plane_workitem", { action: "retrieve_by_identifier", workitem_identifier: "AIES-38" }), "even a read");
  });

  it("refuses mcpScript under a Linear profile and under an unusable profile, and under Plane", async () => {
    profile({ tracker: "linear" });
    assert.ok(await createHost().toolCall("mcpScript", { script: "x" }), "mcpScript under linear is refused");
    profile({ tracker: "jira" });
    assert.ok(await createHost().toolCall("mcpScript", { script: "x" }), "mcpScript under an unknown tracker is refused");
    profile({});
    assert.ok(await createHost().toolCall("mcpScript", { script: "x" }), "mcpScript with no tracker key is refused");
  });

  it("lets the gateway discovery and auth modes through the hook", async () => {
    const host = createHost();
    assert.equal(await host.toolCall("mcp", { server: "plane", search: "workitem" }), null);
    assert.equal(await host.toolCall("mcp", { server: "plane", action: "auth-start" }), null);
    assert.equal(await host.toolCall("mcp", { server: "plane" }), null);
    assert.ok(await host.toolCall("mcp", { server: "plane", action: "install", url: "https://example.invalid/mcp" }));
  });
});

describe("D33 phase 4 (C, follow-up 2): the hook refuses install before the adapter can register an alias", () => {
  let savedAgentDir;
  let savedMode;
  let agentDir;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedMode = process.env.PI_MCP_CONFIG_MODE;
    agentDir = mkdtempSync(join(tmpdir(), "aies-plane-hook-install-"));
    writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ tracker: "plane" }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // D38: a trusted MCP profile, the repo template in exclusive mode (the hook refuses anything else).
    writeFileSync(join(agentDir, "mcp-adapter.json"), JSON.stringify(templateProfile()));
    process.env.PI_MCP_CONFIG_MODE = "exclusive";
    getActiveTicketManager().reset();
  });

  afterEach(() => {
    getActiveTicketManager().reset();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedMode === undefined) delete process.env.PI_MCP_CONFIG_MODE;
    else process.env.PI_MCP_CONFIG_MODE = savedMode;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("refuses an install that aims an alias at the Plane endpoint, so the alias is never registered", async () => {
    const host = createHost();
    const install = { server: "plane2", action: "install", url: "https://mcp.plane.so/http/mcp" };
    const block = await host.toolCall("mcp", install);
    assert.ok(block, "install with any server is refused by the hook");
    assert.match(block.reason, /Bloqueado/);
    assert.match(block.reason, /configurá los servidores MCP a mano|seed del perfil/);
  });

  it("refuses the install under the plane server and under the linear server too", async () => {
    const host = createHost();
    assert.ok(await host.toolCall("mcp", { server: "plane", action: "install", url: "https://mcp.plane.so/http/mcp" }));
    assert.ok(await host.toolCall("mcp", { server: "linear", action: "install", url: "https://mcp.linear.app/mcp" }));
  });
});
