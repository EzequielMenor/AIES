/**
 * D33 phase 4, part A: the repo-guard for Plane tickets (D30 amended by D33 item 9).
 *
 * A Plane ticket belongs to a repository when either its project name or its project
 * identifier (`AIES` in `AIES-38`) matches the session repository, or when an explicit
 * `repos` binding names it by either key. An explicit binding always outranks a name
 * match. A ticket without a project stays `unknown` and never blocks. Linear keeps its
 * name-only rule and its exact message, and both are pinned here.
 *
 * Fixtures are real temporary git repositories; the hook test drives the real agents
 * extension with a Plane answer from the offline simulator. No network, no credential,
 * and the profile is a temporary directory of this test.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesAgents, { getActiveTicketManager } from "../extensions/aies-agents/index.ts";
import {
  checkTicketRepo,
  repoGuardBlockReason,
  resetRepoGuardCache,
} from "../extensions/aies-agents/repo-guard.ts";
import { createPlaneMcpSimulator } from "./helpers/plane-mcp-simulator.mjs";
import { planeWorkItem } from "./helpers/plane-fixtures.mjs";

const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;

/** git that never depends on ambient identity, templates or hooks. */
function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "-c", "user.email=aies@example.com", "-c", "user.name=AIES Fixture", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`.trim());
  return (result.stdout ?? "").trim();
}

function makeGitRepo(parent, name) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "fixture baseline"]);
  return realpathSync(root);
}

const PLANE_TICKET = "AIES-38";
const plane = (overrides) => ({ identifier: PLANE_TICKET, tracker: "plane", ...overrides });
const linear = (overrides) => ({ identifier: "EZE-489", ...overrides });

describe("D33 phase 4 (A): repo-guard for Plane tickets", () => {
  let parent;
  let repoAies;
  let repoAlpha;
  let repoBeta;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "aies-plane-repo-"));
    repoAies = makeGitRepo(parent, "AIES");
    repoAlpha = makeGitRepo(parent, "Alpha App");
    repoBeta = makeGitRepo(parent, "Beta Site");
    resetRepoGuardCache();
  });

  afterEach(() => {
    resetRepoGuardCache();
    rmSync(parent, { recursive: true, force: true });
  });

  it("matches the Plane project identifier against the repository", () => {
    const decision = checkTicketRepo(plane({ project: "Agent Workbench", projectIdentifier: "AIES" }), repoAies, { config: { repos: {} } });
    assert.equal(decision.status, "ok");
    assert.equal(decision.tracker, "plane");
  });

  it("matches the Plane project name against the repository, normalised", () => {
    const decision = checkTicketRepo(plane({ project: "Alpha App", projectIdentifier: "ALPHA" }), repoAlpha, { config: { repos: {} } });
    assert.equal(decision.status, "ok");
  });

  it("refuses a Plane project that matches neither its name nor its identifier, and names the Plane project", () => {
    const decision = checkTicketRepo(plane({ project: "Beta Site", projectIdentifier: "BETA" }), repoAlpha, { config: { repos: {} } });
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRepo, "Beta Site");
    const reason = repoGuardBlockReason("aies_delegate", { role: "worker" }, decision, decision.actualRoot);
    assert.ok(reason, "a Worker delegation must be refused under a mismatch");
    assert.equal(
      reason.split("\n")[0],
      `Bloqueado: el ticket AIES-38 pertenece al proyecto de Plane «Beta Site», pero esta sesión corre en «Alpha App» (${repoAlpha}).`,
    );
  });

  it("keeps a Plane ticket without a project unknown, so it never blocks", () => {
    const decision = checkTicketRepo(plane({ project: null, projectIdentifier: null }), repoAlpha, { config: { repos: {} } });
    assert.equal(decision.status, "unknown");
    assert.equal(repoGuardBlockReason("aies_delegate", { role: "worker" }, decision, decision.actualRoot), null);
  });

  it("binds a Plane project by its identifier in the repos table", () => {
    const config = { repos: { BETA: repoBeta } };
    const elsewhere = checkTicketRepo(plane({ project: "Beta Site", projectIdentifier: "BETA" }), repoAlpha, { config });
    assert.equal(elsewhere.status, "mismatch");
    assert.equal(elsewhere.expectedRoot, repoBeta);
    const here = checkTicketRepo(plane({ project: "Beta Site", projectIdentifier: "BETA" }), repoBeta, { config });
    assert.equal(here.status, "ok");
  });

  it("binds a Plane project by its name in the repos table", () => {
    const config = { repos: { "Beta Site": repoBeta } };
    assert.equal(checkTicketRepo(plane({ project: "Beta Site", projectIdentifier: "BETA" }), repoBeta, { config }).status, "ok");
    assert.equal(checkTicketRepo(plane({ project: "Beta Site", projectIdentifier: "BETA" }), repoAlpha, { config }).status, "mismatch");
  });

  it("an explicit binding outranks a name match", () => {
    const config = { repos: { BETA: repoBeta } };
    const decision = checkTicketRepo(plane({ project: "Alpha App", projectIdentifier: "BETA" }), repoAlpha, { config });
    assert.equal(decision.status, "mismatch", "the binding names Beta, so the Alpha name must not pass the guard");
    assert.equal(decision.expectedRoot, repoBeta);
  });

  it("a binding keyed by the name outranks an identifier match", () => {
    const config = { repos: { "Agent Workbench": repoBeta } };
    const decision = checkTicketRepo(plane({ project: "Agent Workbench", projectIdentifier: "AIES" }), repoAies, { config });
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRoot, repoBeta);
  });

  it("keeps Linear's name-only rule: the identifier never matches a Linear ticket", () => {
    const decision = checkTicketRepo(linear({ project: "Beta Site", projectIdentifier: "ALPHA" }), repoAlpha, { config: { repos: {} } });
    assert.equal(decision.status, "mismatch");
  });

  it("keeps Linear's name match and binding exactly as before", () => {
    assert.equal(checkTicketRepo(linear({ project: "Alpha App" }), repoAlpha, { config: { repos: {} } }).status, "ok");
    assert.equal(checkTicketRepo(linear({ project: "Gamma" }), repoAlpha, { config: { repos: { Gamma: repoAlpha } } }).status, "ok");
  });

  it("keeps Linear's block message byte for byte", () => {
    const decision = checkTicketRepo(linear({ project: "Beta Site" }), repoAlpha, { config: { repos: {} } });
    const reason = repoGuardBlockReason("aies_delegate", { role: "worker" }, decision, decision.actualRoot);
    assert.equal(
      reason.split("\n")[0],
      `Bloqueado: el ticket EZE-489 pertenece al repo «Beta Site», pero esta sesión corre en «Alpha App» (${repoAlpha}).`,
    );
    assert.notEqual(decision.tracker, "plane", "a Linear decision never carries the Plane tracker");
  });

  it("keeps a Linear ticket without a project unknown", () => {
    const decision = checkTicketRepo(linear({ project: undefined }), repoAlpha, { config: { repos: {} } });
    assert.equal(decision.status, "unknown");
  });
});

describe("D33 phase 4 (A): the tool_call hook guards a Plane ticket by its identifier", () => {
  let parent;
  let savedAgentDir;
  let agentDir;
  let savedOverride;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "aies-plane-hook-repo-"));
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedOverride = process.env.AIES_ALLOW_REPO_MISMATCH;
    agentDir = join(parent, "profile");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ tracker: "plane" }));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.AIES_ALLOW_REPO_MISMATCH;
    resetRepoGuardCache();
    getActiveTicketManager()?.reset();
  });

  afterEach(() => {
    getActiveTicketManager()?.reset();
    resetRepoGuardCache();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedOverride === undefined) delete process.env.AIES_ALLOW_REPO_MISMATCH;
    else process.env.AIES_ALLOW_REPO_MISMATCH = savedOverride;
    rmSync(parent, { recursive: true, force: true });
  });

  /** The real extension, with the session cwd set to `cwd`. */
  function createHost(cwd) {
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
    const context = { cwd, mode: "print", hasUI: false, getContextUsage: () => undefined };
    return {
      async toolCall(toolName, input) {
        for (const handler of handlers.get("tool_call") ?? []) {
          const result = await handler({ type: "tool_call", toolName, input }, context);
          if (result && result.block) return result;
        }
        return null;
      },
      async toolResult(toolName, input, content) {
        for (const handler of handlers.get("tool_result") ?? []) {
          await handler({ type: "tool_result", toolName, input, content, isError: false }, context);
        }
      },
    };
  }

  /** Load a Plane ticket through the mediated path, answering each directive from the simulator. */
  async function loadPlaneTicket(host, simulator, identifier) {
    const manager = getActiveTicketManager();
    await manager.loadTicket(identifier);
    for (let guard = 0; guard < 10 && manager.getPendingDirective(); guard += 1) {
      const directive = manager.getPendingDirective();
      const input = { server: directive.server, tool: directive.tool, args: structuredClone(directive.args) };
      await host.toolResult("mcp", input, simulator.answer(directive).content);
    }
    return manager.getActiveTicket();
  }

  it("lets a Worker run in the repository the Plane project identifier names", async () => {
    const repo = makeGitRepo(parent, "AIES");
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, project: { id: "5b2f0c1e-7d3a-4f6b-9a8e-1c2d3e4f5a6b", identifier: "AIES", name: "Agent Workbench" } })]);
    const host = createHost(repo);
    const ticket = await loadPlaneTicket(host, simulator, "AIES-38");
    assert.equal(ticket.identifier, "AIES-38");
    assert.equal(ticket.projectIdentifier, "AIES");

    assert.equal(await host.toolCall("aies_delegate", { role: "worker" }), null);
  });

  it("refuses a Worker in a repository that the Plane project does not name, with the Plane wording, until the override is set", async () => {
    const repo = makeGitRepo(parent, "Alpha App");
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, project: { id: "5b2f0c1e-7d3a-4f6b-9a8e-1c2d3e4f5a6b", identifier: "BETA", name: "Beta Site" } })]);
    const host = createHost(repo);
    await loadPlaneTicket(host, simulator, "BETA-38");

    const block = await host.toolCall("aies_delegate", { role: "worker" });
    assert.ok(block, "a Plane mismatch must block the Worker");
    assert.match(block.reason, /proyecto de Plane «Beta Site»/);
    assert.match(block.reason, /AIES_ALLOW_REPO_MISMATCH=1/);

    process.env.AIES_ALLOW_REPO_MISMATCH = "1";
    assert.equal(await host.toolCall("aies_delegate", { role: "worker" }), null, "the explicit override lifts the guard");
  });
});
