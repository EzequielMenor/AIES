/**
 * EZE-489: cross-repository ticket guard.
 *
 * The real defect (EZE-488) was a session launched in the wrong workspace: the
 * active ticket belonged to another repository, the Worker was sandboxed to the
 * wrong root and blocked, and the Parent then implemented directly in the other
 * repository with no guard at all. This suite proves the guard closes that hole:
 *
 * 1. The ticket project matched against the session git toplevel resolves "ok"
 *    and the real `tool_call` hook lets a Worker delegation through.
 * 2. A mismatch blocks the delegation with an actionable Spanish reason.
 * 3. Worker containment still refuses paths inside the other repository.
 * 4. The Parent cannot bypass the guard with `edit`, `write`, or a mutating
 *    `bash`, while read-only inspection stays available.
 * 5. The blocked sequence leaves both repositories byte-for-byte untouched.
 * 6. The message names the ticket, both repos, the real roots and the relaunch
 *    command, including a resolvable sibling workspace.
 * 7. Symlinked workspaces and explicit `repos` bindings produce no false positive.
 * 8. A ticket without a project is "unknown" and never blocks; the documented
 *    `AIES_ALLOW_REPO_MISMATCH=1` override disables the guard.
 *
 * Fixtures are real temporary git repositories, so the guard resolves the same
 * way it does in a live session. Everything is skipped cleanly if `git` is
 * unavailable, and no test touches `~/.pi` or the default profile.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesAgents, { getActiveTicketManager, resetSessionState } from "../extensions/aies-agents/index.ts";
import { setActiveContinuationController } from "../extensions/aies-agents/autonomy/controller.ts";
import {
  createContainedEditToolDefinition,
  createContainedWriteToolDefinition,
} from "../extensions/aies-agents/contained-tools.ts";
import {
  checkTicketRepo,
  normalizeRepoName,
  readRepoGuardConfig,
  repoGuardBlockReason,
  resetRepoGuardCache,
  resolveRepoIdentity,
  resolveWorkspaceRoot,
} from "../extensions/aies-agents/repo-guard.ts";

const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;
const REPO_A_PROJECT = "Alpha App";
const REPO_B_PROJECT = "Beta Site";
const TICKET_ID = "EZE-489";

/** git that never depends on ambient identity, templates or hooks. */
function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    [
      "-c",
      "init.templateDir=",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "user.email=aies@example.com",
      "-c",
      "user.name=AIES Fixture",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? result.error?.message ?? ""}`.trim());
  }
  return (result.stdout ?? "").trim();
}

function makeGitRepo(parent, name, files = {}) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "fixture baseline"]);
  return realpathSync(root);
}

/** Snapshot of a repository: HEAD, branch, tracked status and top-level listing. */
function repoState(root) {
  return {
    head: runGit(root, ["rev-parse", "HEAD"]),
    branch: runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]),
    status: runGit(root, ["status", "--porcelain"]),
    entries: readdirSync(root).filter((entry) => entry !== ".git").sort(),
  };
}

function fixtureTicket(overrides = {}) {
  return {
    id: `01a0f${TICKET_ID}`,
    identifier: TICKET_ID,
    title: "Cross-repo ticket guard",
    description: "The guard must stop a Parent session working the wrong repository.",
    acceptanceCriteria: ["mismatch blocks worker delegation"],
    status: "Todo",
    project: REPO_B_PROJECT,
    loadedAt: 1_700_000_000_000,
    ...overrides,
  };
}

/** Drive the real agents extension and read what its `tool_call` handlers answer. */
function createAgentsHost() {
  const handlers = new Map();
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "bash" }];
    },
    getActiveTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "bash" }];
    },
    appendEntry() {},
    sendUserMessage() {},
  };
  aiesAgents(pi);

  return {
    pi,
    /** Returns every handler result; `undefined` means the call was not blocked. */
    async toolCall(toolName, input = {}, cwd) {
      const results = [];
      for (const handler of handlers.get("tool_call") ?? []) {
        results.push(await handler({ type: "tool_call", toolName, input }, { cwd, mode: "print", hasUI: false }));
      }
      return results;
    },
    async blockOf(toolName, input, cwd) {
      const results = await this.toolCall(toolName, input, cwd);
      return results.find((result) => result && result.block) ?? null;
    },
  };
}

function loadTicket(manager, ticket) {
  manager.restoreFromSnapshot({
    ticketId: ticket.identifier,
    activeTicket: ticket,
    workState: "loaded",
    lastKnownLinearStatus: ticket.status,
    changedPaths: [],
    persistedAt: ticket.loadedAt,
  });
}

function blocked(result) {
  return Boolean(result && result.block === true && typeof result.reason === "string");
}

/** Escape a filesystem path so it can be matched literally inside a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The unresolvable-path fallback must name the deterministic `repos` binding (with
 * an absolute path) in `$PI_CODING_AGENT_DIR/aies.json`, and must never invent a
 * relaunch path for a root the guard could not resolve.
 */
function assertBindingFallback(reason, expectedRepo) {
  assert.match(reason, /Si no se pudo resolver el path/u);
  assert.match(reason, /\$PI_CODING_AGENT_DIR\/aies\.json/u);
  assert.match(reason, /\{\s*"repos"\s*:/u);
  assert.match(reason, new RegExp(`"${escapeRegExp(expectedRepo)}"\\s*:\\s*"\\/[^"]+"`, "u"));
  assert.ok(!/cd\s+\S+\s+&&\s+aies/u.test(reason), "the fallback must not fabricate a relaunch path");
}

describe("EZE-489 cross-repo ticket guard", () => {
  let workspace;
  let repoA;
  let repoB;
  let agentDir;
  let savedAgentDir;
  let savedOverride;
  let savedCwd;

  beforeEach(() => {
    savedCwd = process.cwd();
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedOverride = process.env.AIES_ALLOW_REPO_MISMATCH;
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.AIES_ALLOW_REPO_MISMATCH;

    workspace = mkdtempSync(join(tmpdir(), "aies-repo-guard-"));
    agentDir = join(workspace, "profile");
    mkdirSync(agentDir, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    repoA = makeGitRepo(workspace, "Alpha-App", { "src/app.ts": "export const app = 1;\n" });
    repoB = makeGitRepo(workspace, "Beta-Site", { "src/site.ts": "export const site = 1;\n" });

    resetRepoGuardCache();
    setActiveContinuationController(undefined);
    resetSessionState();
  });

  afterEach(() => {
    resetSessionState();
    setActiveContinuationController(undefined);
    resetRepoGuardCache();
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedOverride === undefined) delete process.env.AIES_ALLOW_REPO_MISMATCH;
    else process.env.AIES_ALLOW_REPO_MISMATCH = savedOverride;
    process.chdir(savedCwd);
    rmSync(workspace, { recursive: true, force: true });
  });

  it("normalizes repo names by lowercasing and dropping spaces, dashes, dots and underscores", { skip: !GIT_AVAILABLE }, () => {
    assert.equal(normalizeRepoName("Mi-Porfolio"), "miporfolio");
    assert.equal(normalizeRepoName("AIES Core"), "aiescore");
    assert.equal(normalizeRepoName("Beta.Site"), "betasite");
    assert.equal(normalizeRepoName(REPO_B_PROJECT), normalizeRepoName("beta_site"));
  });

  it("resolves the session root to the git toplevel and the identity is cached per cwd", { skip: !GIT_AVAILABLE }, () => {
    const nested = join(repoA, "src");
    assert.equal(resolveWorkspaceRoot(nested), repoA);
    assert.deepEqual(resolveRepoIdentity(nested), { root: repoA, name: "Alpha-App" });
    // A cwd that is not a repository falls back to its realpath instead of throwing.
    const plain = join(workspace, "not-a-repo");
    mkdirSync(plain, { recursive: true });
    assert.equal(resolveWorkspaceRoot(plain), realpathSync(plain));
    assert.equal(resolveWorkspaceRoot(join(workspace, "missing-dir")), join(workspace, "missing-dir"));
  });

  it("reads the optional repos binding from $PI_CODING_AGENT_DIR/aies.json and never throws", { skip: !GIT_AVAILABLE }, () => {
    assert.deepEqual(readRepoGuardConfig(), { repos: {} }, "absent file is an empty table");
    writeFileSync(join(agentDir, "aies.json"), "not json at all");
    assert.deepEqual(readRepoGuardConfig(), { repos: {} }, "unparsable file is an empty table");
    writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ repos: { AIES: repoA } }));
    assert.deepEqual(readRepoGuardConfig(), { repos: { AIES: repoA } });
    assert.deepEqual(readRepoGuardConfig({}), { repos: {} }, "no agent dir means no bindings");
  });

  it("1. ticket project matching the session repo is ok and the hook does not block a Worker delegation", { skip: !GIT_AVAILABLE }, async () => {
    const host = createAgentsHost();
    const manager = getActiveTicketManager();
    loadTicket(manager, fixtureTicket({ project: REPO_A_PROJECT }));

    const decision = checkTicketRepo({ identifier: TICKET_ID, project: REPO_A_PROJECT }, repoA);
    assert.equal(decision.status, "ok");
    assert.equal(decision.actualRoot, repoA);
    assert.equal(repoGuardBlockReason("aies_delegate", { role: "worker" }, decision, repoA), null);

    const block = await host.blockOf("aies_delegate", { role: "worker", task: "Implement the guard" }, repoA);
    assert.equal(block, null, "a same-repo Worker delegation must not be blocked");
  });

  it("2. ticket project of another repo is a mismatch and the hook blocks the Worker delegation", { skip: !GIT_AVAILABLE }, async () => {
    const host = createAgentsHost();
    const manager = getActiveTicketManager();
    loadTicket(manager, fixtureTicket({ project: REPO_B_PROJECT }));

    const decision = checkTicketRepo({ identifier: TICKET_ID, project: REPO_B_PROJECT }, repoA);
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRepo, REPO_B_PROJECT);
    assert.equal(decision.actualRepo, "Alpha-App");

    const block = await host.blockOf("aies_delegate", { role: "worker", task: "Implement the guard" }, repoA);
    assert.ok(blocked(block), "a wrong-repo Worker delegation must be blocked");
    assert.match(block.reason, /Bloqueado:/);
    assert.match(block.reason, new RegExp(TICKET_ID, "u"));
    assert.match(block.reason, new RegExp(REPO_B_PROJECT, "u"));
    assert.match(block.reason, new RegExp(repoA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
  });

  it("3. Worker containment refuses a path inside repo B when the workspace root is repo A", { skip: !GIT_AVAILABLE }, async () => {
    const target = join(repoB, "src", "site.ts");
    const writeTool = createContainedWriteToolDefinition(repoA);
    const editTool = createContainedEditToolDefinition(repoA);

    const writeResult = await writeTool.execute("call-write", { path: target, content: "export const site = 2;\n" });
    assert.equal(writeResult.isError, true);
    assert.match(writeResult.content[0].text, /outside workspace root/u);

    const editResult = await editTool.execute("call-edit", {
      path: target,
      edits: [{ oldText: "site = 1", newText: "site = 2" }],
    });
    assert.equal(editResult.isError, true);
    assert.match(editResult.content[0].text, /outside workspace root/u);

    assert.equal(readFileSync(target, "utf8"), "export const site = 1;\n", "repo B stays untouched");
  });

  it("4. the Parent cannot bypass the guard with edit, write or a mutating bash, and read-only bash stays allowed", { skip: !GIT_AVAILABLE }, async () => {
    const host = createAgentsHost();
    loadTicket(getActiveTicketManager(), fixtureTicket({ project: REPO_B_PROJECT }));

    for (const toolName of ["edit", "write"]) {
      const block = await host.blockOf(toolName, { path: join(repoB, "src", "site.ts") }, repoA);
      assert.ok(blocked(block), `${toolName} on an absolute repo B path must be blocked`);
    }

    for (const command of ["git checkout -b feature/x", "git commit -m wip", "git branch feature/x", "echo x > f"]) {
      const block = await host.blockOf("bash", { command }, repoA);
      assert.ok(blocked(block), `bash "${command}" must be blocked under a repo mismatch`);
    }

    for (const command of ["git status", "git log", "ls", "git branch", "git branch --show-current"]) {
      const block = await host.blockOf("bash", { command }, repoA);
      assert.equal(block, null, `read-only bash "${command}" must stay allowed`);
    }

    const explore = await host.blockOf("aies_delegate", { role: "explore", task: "Map repo B" }, repoA);
    assert.equal(explore, null, "Explore stays allowed: reading the other repo is the diagnosis");
  });

  it("5. the blocked sequence leaves both repos with the same HEAD, branch and files", { skip: !GIT_AVAILABLE }, async () => {
    const host = createAgentsHost();
    loadTicket(getActiveTicketManager(), fixtureTicket({ project: REPO_B_PROJECT }));

    const beforeA = repoState(repoA);
    const beforeB = repoState(repoB);

    const sequence = [
      ["aies_delegate", { role: "worker", task: "Implement the guard" }],
      ["aies_ticket", { action: "start", ticketId: TICKET_ID }],
      ["edit", { path: join(repoB, "src", "site.ts"), edits: [{ oldText: "site = 1", newText: "site = 2" }] }],
      ["write", { path: join(repoB, "escape.ts"), content: "x\n" }],
      ["bash", { command: "git checkout -b feature/escape" }],
      ["bash", { command: "git branch feature/escape" }],
      ["bash", { command: "echo leaked > leaked.txt" }],
      ["bash", { command: `echo leaked > ${join(repoB, "leaked2.txt")}` }],
    ];

    for (const [toolName, input] of sequence) {
      const block = await host.blockOf(toolName, input, repoA);
      if (toolName === "aies_delegate" || toolName === "aies_ticket" || toolName === "edit" || toolName === "write") {
        assert.ok(blocked(block), `${toolName} must be blocked`);
      }
    }

    assert.deepEqual(repoState(repoA), beforeA, "repo A must be untouched");
    assert.deepEqual(repoState(repoB), beforeB, "repo B must be untouched: no branch, no commit, no new file");
    assert.equal(existsSync(join(repoB, "escape.ts")), false);
    assert.equal(existsSync(join(repoB, "leaked.txt")), false);
    assert.equal(existsSync(join(repoB, "leaked2.txt")), false);
  });

  it("6. the reason names the ticket, both repos and the relaunch, resolving a sibling workspace when present", { skip: !GIT_AVAILABLE }, async () => {
    const host = createAgentsHost();
    loadTicket(getActiveTicketManager(), fixtureTicket({ project: REPO_B_PROJECT }));

    const block = await host.blockOf("aies_delegate", { role: "worker", task: "Implement the guard" }, repoA);
    assert.ok(blocked(block));
    assert.match(block.reason, new RegExp(TICKET_ID, "u"));
    assert.match(block.reason, new RegExp(REPO_B_PROJECT, "u"));
    assert.match(block.reason, /Alpha-App/u);
    assert.match(block.reason, new RegExp(repoA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
    assert.match(block.reason, /No se deleg[oó] ning[uú]n Worker y no se modific[oó] ning[uú]n archivo\./u);
    assert.match(block.reason, new RegExp(`aies_ticket load ${TICKET_ID}`, "u"));
    assert.match(block.reason, new RegExp(`cd ${repoB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} && aies`, "u"));
    assert.match(block.reason, /AIES_ALLOW_REPO_MISMATCH=1/u);
    assert.ok(
      !/Si no se pudo resolver el path/u.test(block.reason),
      "the unresolvable-path line is only for an unknown expected root",
    );

    const unknown = await host.blockOf("aies_ticket", { action: "start", ticketId: TICKET_ID }, repoA);
    assert.ok(blocked(unknown), "`aies_ticket start` is the earliest work-unit boundary");
    const read = await host.blockOf("aies_ticket", { action: "load", ticketId: TICKET_ID }, repoA);
    assert.equal(read, null, "`load` is diagnostic and must never be blocked");
  });

  it("6b. an expected root that cannot be resolved falls back to the explicit relaunch instruction", { skip: !GIT_AVAILABLE }, async () => {
    const decision = checkTicketRepo({ identifier: TICKET_ID, project: "Gamma Service" }, repoA);
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRoot, undefined);

    const reason = repoGuardBlockReason("edit", { path: join(repoA, "src", "app.ts") }, decision, repoA);
    assert.ok(reason);
    assert.match(reason, /Gamma Service/u);
    assertBindingFallback(reason, "Gamma Service");
  });

  it("6c. a unique match two levels under the parent of the session root resolves the relaunch path", { skip: !GIT_AVAILABLE }, async () => {
    // Not a sibling: the expected repo sits one level deeper than the session root.
    const nested = makeGitRepo(join(workspace, "Developer"), "Gamma-Svc", { "src/gamma.ts": "export const g = 1;\n" });
    assert.equal(basename(dirname(nested)), "Developer");

    const decision = checkTicketRepo({ identifier: TICKET_ID, project: "Gamma Svc" }, repoA);
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRoot, nested);

    const host = createAgentsHost();
    loadTicket(getActiveTicketManager(), fixtureTicket({ project: "Gamma Svc" }));
    const block = await host.blockOf("aies_delegate", { role: "worker", task: "Implement" }, repoA);
    assert.ok(blocked(block));
    assert.match(block.reason, new RegExp(`cd ${escapeRegExp(nested)} && aies`, "u"));
    assert.match(block.reason, new RegExp(`aies_ticket load ${TICKET_ID}`, "u"));
    assert.ok(!/Si no se pudo resolver el path/u.test(block.reason), "a resolved root never falls back");
  });

  it("6d. two candidates with the same normalized name are ambiguous and leave the root unresolved", { skip: !GIT_AVAILABLE }, () => {
    const first = makeGitRepo(join(workspace, "Developer"), "Gamma-Service");
    const second = makeGitRepo(join(workspace, "Work"), "gamma_service");
    assert.notEqual(first, second);
    assert.equal(normalizeRepoName(basename(first)), normalizeRepoName(basename(second)));

    const decision = checkTicketRepo({ identifier: TICKET_ID, project: "Gamma Service" }, repoA);
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRoot, undefined, "an ambiguous filesystem must not pick a path");

    const reason = repoGuardBlockReason("edit", { path: join(repoA, "src", "app.ts") }, decision, repoA);
    assert.ok(reason);
    assert.ok(!reason.includes(`cd ${first}`), "the first candidate must not be presented as the answer");
    assert.ok(!reason.includes(`cd ${second}`), "the second candidate must not be presented as the answer");
    assertBindingFallback(reason, "Gamma Service");
  });

  it("6e. a candidate reached through a symlink resolves to its realpath", { skip: !GIT_AVAILABLE }, () => {
    const target = makeGitRepo(join(workspace, "Targets"), "Delta-Api");
    const link = join(workspace, "Delta-Api");
    symlinkSync(target, link, "dir");
    assert.equal(realpathSync(link), target, "fixture really reaches the repo through a symlink");

    const decision = checkTicketRepo({ identifier: TICKET_ID, project: "Delta API" }, repoA);
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRoot, target);
    assert.notEqual(decision.expectedRoot, link, "the message never carries the symlinked path");
  });

  it("6f. a cwd that no longer exists never throws and keeps a valid block reason", { skip: !GIT_AVAILABLE }, () => {
    // Direct child of the workspace: the bounded lookup still finds the unique repo B.
    const missing = join(workspace, "gone-dir");
    assert.equal(existsSync(missing), false);

    const decision = checkTicketRepo({ identifier: TICKET_ID, project: REPO_B_PROJECT }, missing);
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.actualRoot, missing);
    assert.equal(decision.expectedRoot, repoB);

    const reason = repoGuardBlockReason("aies_delegate", { role: "worker" }, decision, missing);
    assert.ok(reason && reason.includes("Bloqueado:"), "a valid block reason survives a missing cwd");
    assert.ok(reason.includes(TICKET_ID));
    assert.ok(reason.includes(`cd ${repoB} && aies`));

    // Two levels below an existing parent there is nothing to read: no throw, fallback.
    const deep = checkTicketRepo({ identifier: TICKET_ID, project: REPO_B_PROJECT }, join(missing, "deeper"));
    assert.equal(deep.status, "mismatch");
    assert.equal(deep.expectedRoot, undefined);
    const deepReason = repoGuardBlockReason("write", { path: "leak.ts" }, deep, workspace);
    assert.ok(deepReason);
    assertBindingFallback(deepReason, REPO_B_PROJECT);
  });

  it("6g. ambiguity across levels (one candidate at level 1, another at level 2) leaves the root unresolved", { skip: !GIT_AVAILABLE }, () => {
    // Level 1 candidate: direct child of dirname(repoA) which is workspace.
    const level1 = makeGitRepo(workspace, "Gamma-Service");
    // Level 2 candidate: child of a child of workspace, different dir.
    const level2 = makeGitRepo(join(workspace, "Developer"), "gamma_service");
    assert.notEqual(level1, level2);
    assert.equal(normalizeRepoName(basename(level1)), normalizeRepoName(basename(level2)));

    const decision = checkTicketRepo({ identifier: TICKET_ID, project: "Gamma Service" }, repoA);
    assert.equal(decision.status, "mismatch");
    assert.equal(decision.expectedRoot, undefined, "cross-level ambiguity must not produce a path");

    const reason = repoGuardBlockReason("edit", { path: join(repoA, "src", "app.ts") }, decision, repoA);
    assert.ok(reason);
    assert.ok(!reason.includes(`cd ${level1}`), "the level 1 candidate must not be presented as the answer");
    assert.ok(!reason.includes(`cd ${level2}`), "the level 2 candidate must not be presented as the answer");
    assertBindingFallback(reason, "Gamma Service");
  });

  it("7. a symlinked workspace and an explicit repos binding resolve to ok with no false positive", { skip: !GIT_AVAILABLE }, async () => {
    const link = join(workspace, "alpha-link");
    symlinkSync(repoA, link, "dir");
    const linked = realpathSync(link);
    assert.notEqual(link, repoA, "fixture really exercises a symlinked cwd");
    assert.equal(linked, repoA);

    const viaSymlink = checkTicketRepo({ identifier: TICKET_ID, project: REPO_A_PROJECT }, link);
    assert.equal(viaSymlink.status, "ok");
    assert.equal(viaSymlink.actualRoot, repoA);

    // An explicit binding keyed by a project name the directory does not match.
    writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ repos: { "Gamma Service": repoA } }));
    resetRepoGuardCache();
    const bound = checkTicketRepo({ identifier: TICKET_ID, project: "Gamma Service" }, link);
    assert.equal(bound.status, "ok");
    assert.equal(bound.expectedRoot, repoA);

    const host = createAgentsHost();
    loadTicket(getActiveTicketManager(), fixtureTicket({ project: "Gamma Service" }));
    const block = await host.blockOf("aies_delegate", { role: "worker", task: "Implement" }, link);
    assert.equal(block, null, "a bound repo reached through a symlink must not be blocked");
    assert.equal(basename(repoA), "Alpha-App");
  });

  it("8. a ticket without a project is unknown and never blocks; the override disables a real mismatch", { skip: !GIT_AVAILABLE }, async () => {
    const decision = checkTicketRepo({ identifier: TICKET_ID, project: undefined }, repoA);
    assert.equal(decision.status, "unknown");
    assert.equal(decision.reason === undefined || typeof decision.reason === "string", true);
    assert.equal(decision.actualRoot, repoA);
    assert.equal(decision.actualRepo, "Alpha-App");
    assert.equal(
      repoGuardBlockReason("aies_delegate", { role: "worker" }, decision, repoA),
      null,
      "unknown must never block",
    );

    const host = createAgentsHost();
    loadTicket(getActiveTicketManager(), fixtureTicket({ project: undefined }));
    const noProject = await host.blockOf("aies_delegate", { role: "worker", task: "Implement" }, repoA);
    assert.equal(noProject, null, "a project-less ticket keeps working exactly as before");

    loadTicket(getActiveTicketManager(), fixtureTicket({ project: REPO_B_PROJECT }));
    const mismatch = await host.blockOf("aies_delegate", { role: "worker", task: "Implement" }, repoA);
    assert.ok(blocked(mismatch), "the fixture really is a mismatch before the override");

    process.env.AIES_ALLOW_REPO_MISMATCH = "1";
    resetRepoGuardCache();
    const overridden = await host.blockOf("aies_delegate", { role: "worker", task: "Implement" }, repoA);
    assert.equal(overridden, null, "the documented explicit override must disable the guard");
  });
});
