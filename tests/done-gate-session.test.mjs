/**
 * EZE-496: the Done Gate reads what Git shows, not only what this session reported.
 *
 * A change made with bash or git, or in an earlier session, used to be invisible, so a
 * ticket with real changes could complete with no Verify PASS. These tests run against
 * real throwaway git repositories under os.tmpdir(), committed only inside them. The
 * tracker is an offline fake and the direct Linear guard runs through the real
 * `tool_call` hook of the agents extension. No network, no credential, no real Plane.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesAgents, { getActiveTicketManager } from "../extensions/aies-agents/index.ts";
import { captureBaseline, collectChanges } from "../extensions/aies-agents/linear/change-evidence.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { isDirectLinearCompletion, planeWriteBypassReason } from "../extensions/aies-agents/linear/pending-action.ts";
import { FakeLinearTransport } from "../extensions/aies-agents/linear/transport.ts";
import { FakePlaneTransport } from "../extensions/aies-agents/linear/plane-transport.ts";
import { PLANE_TRACKER } from "../extensions/aies-agents/linear/tracker.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
} from "../extensions/aies-agents/verification.ts";
import { PLANE_PROJECT, PLANE_STATES, PLANE_WORKITEM_UUID } from "./helpers/plane-fixtures.mjs";
import { TRUSTED, templateProfile } from "./helpers/mcp-profile.mjs";

const PLANE_SELECTION = () => ({ ok: true, tracker: PLANE_TRACKER });
const DESCRIPTION = "## Acceptance Criteria\n- [ ] The Done Gate reads the repository\n";
const CODE = "src/app.ts";
const DOCS = "docs/notes.md";
const HEX = /^[0-9a-f]{40,64}$/u;

/** A verification record with a fresh PASS over `paths`, as the Verify child reports it. */
function freshPass(paths = [CODE]) {
  let state = createVerificationState();
  state = applyWorkUnitChange(state, paths, "worker implemented the change");
  state = applyVerifyStart(state, 1_700_000_000_000);
  return applyVerifyResult(state, { status: "pass", criteria: [] }, 1_700_000_000_100);
}

let root;
let repo;

/** Git with a fixed identity and no hooks: the user's global template hook must not run in a throwaway repo. */
function git(args, cwd = repo) {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      `core.hooksPath=${join(root, "no-hooks")}`,
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function write(relPath, content) {
  const full = join(repo, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitAll(message) {
  git(["add", "-A"]);
  git(["commit", "-q", "-m", message]);
}

/** A repository with two committed files: one behaviour-bearing, one documentation. */
function createRepo() {
  repo = join(root, "repo");
  mkdirSync(repo);
  git(["init", "-q"]);
  write(CODE, "export const app = 1;\n");
  write(DOCS, "# Notes\n");
  commitAll("chore: seed the repository");
}

function seededPlane() {
  const fake = new FakePlaneTransport();
  fake.seedIssue({ identifier: "AIES-39", title: "Done Gate evidence", description: DESCRIPTION, state: "Todo" });
  return fake;
}

/** A manager that reads the repository through the injected probe, loaded on the current tree. */
async function loadedManager({ fake = seededPlane(), getVerification, cwd = repo } = {}) {
  const manager = new TicketManager({
    transport: fake,
    getVerification,
    selectTracker: PLANE_SELECTION,
    changeProbe: { cwd: () => cwd },
  });
  const load = await manager.loadTicket("AIES-39");
  assert.equal(load.ok, true, load.message);
  return { manager, fake };
}

async function planeState(fake) {
  return (await fake.getIssue("AIES-39")).state.name;
}

describe("EZE-496: change evidence primitives", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aies-done-gate-evidence-"));
    createRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("captures HEAD as the baseline of a repository with commits", () => {
    const baseline = captureBaseline(repo);
    assert.equal(baseline.ok, true);
    assert.equal(baseline.head, git(["rev-parse", "HEAD"]));
  });

  it("uses the empty tree as the baseline of a repository without commits", () => {
    const unborn = join(root, "unborn");
    mkdirSync(unborn);
    git(["init", "-q"], unborn);
    const baseline = captureBaseline(unborn);
    assert.equal(baseline.ok, true);
    assert.match(baseline.head, HEX);

    mkdirSync(join(unborn, "src"));
    writeFileSync(join(unborn, CODE), "export const app = 2;\n");
    git(["add", "-A"], unborn);
    const changes = collectChanges(unborn, baseline.head);
    assert.equal(changes.known, true);
    assert.deepEqual(changes.paths, [CODE]);
  });

  it("refuses a directory that is not a Git work tree", () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const baseline = captureBaseline(plain);
    assert.equal(baseline.ok, false);
    assert.match(baseline.reason, /not|unavailable/u);
  });

  it("keeps the old path of a rename, so a code file moved to docs still counts", () => {
    const baseline = captureBaseline(repo);
    git(["mv", CODE, "docs/app.md"]);
    const changes = collectChanges(repo, baseline.head);
    assert.equal(changes.known, true);
    assert.deepEqual(changes.paths, ["docs/app.md", CODE]);
  });

  it("reports nothing and the same fingerprint on a clean tree", () => {
    const baseline = captureBaseline(repo);
    const first = collectChanges(repo, baseline.head);
    const second = collectChanges(repo, baseline.head);
    assert.deepEqual(first.paths, []);
    assert.equal(first.known, true);
    assert.equal(first.fingerprint, second.fingerprint);
  });

  it("changes the fingerprint when a file changes content and keeps it when the same change is committed", () => {
    const baseline = captureBaseline(repo);
    write(CODE, "export const app = 2;\n");
    const edited = collectChanges(repo, baseline.head);
    write(CODE, "export const app = 3;\n");
    const editedAgain = collectChanges(repo, baseline.head);
    assert.notEqual(edited.fingerprint, editedAgain.fingerprint);

    write(CODE, "export const app = 2;\n");
    const beforeCommit = collectChanges(repo, baseline.head);
    commitAll("feat: change the app");
    const afterCommit = collectChanges(repo, baseline.head);
    assert.equal(afterCommit.fingerprint, beforeCommit.fingerprint, "a commit of the same change is the same state");
    assert.deepEqual(afterCommit.paths, [CODE], "a commit made after the baseline is still a change");
  });
});

describe("EZE-496: the Done Gate sees the repository, not only the session", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aies-done-gate-"));
    createRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("completes a clean tree with a known baseline without Verify (no change to prove)", async () => {
    const { manager, fake } = await loadedManager({ getVerification: () => createVerificationState() });
    const result = await manager.completeTicket();
    assert.equal(result.ok, true, result.message);
    assert.equal(await planeState(fake), "Done");
  });

  it("completes a documentation-only dirty tree without Verify", async () => {
    const { manager, fake } = await loadedManager({ getVerification: () => createVerificationState() });
    write(DOCS, "# Notes\n\nA clearer sentence.\n");
    const result = await manager.completeTicket();
    assert.equal(result.ok, true, result.message);
    assert.equal(await planeState(fake), "Done");
  });

  const UNREPORTED_CHANGES = [
    ["an unstaged edit made outside AIES", () => write(CODE, "export const app = 2;\n")],
    [
      "a staged edit made outside AIES",
      () => {
        write(CODE, "export const app = 2;\n");
        git(["add", CODE]);
      },
    ],
    ["a brand-new untracked file", () => write("src/new-module.ts", "export const extra = true;\n")],
    [
      "a commit made after the baseline",
      () => {
        write(CODE, "export const app = 2;\n");
        commitAll("feat: change made by bash");
      },
    ],
  ];

  for (const [label, mutate] of UNREPORTED_CHANGES) {
    it(`denies completion without a PASS for ${label}`, async () => {
      const { manager, fake } = await loadedManager({ getVerification: () => createVerificationState() });
      mutate();

      assert.deepEqual(manager.getChangedPaths(), [], "nothing was reported to the session");
      const result = await manager.completeTicket();
      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_gate_denied");
      assert.match(result.message, /Verification required/u);
      assert.equal(await planeState(fake), "Todo", "Plane keeps its state");
    });
  }

  it("completes a behaviour-bearing change once a fresh PASS is bound to it", async () => {
    let verification = createVerificationState();
    const { manager, fake } = await loadedManager({ getVerification: () => verification });
    write(CODE, "export const app = 2;\n");
    verification = freshPass([CODE]);
    manager.recordVerifiedState();

    const result = await manager.completeTicket();
    assert.equal(result.ok, true, result.message);
    assert.equal(await planeState(fake), "Done");
  });

  it("keeps a PASS valid when the same change is committed afterwards", async () => {
    let verification = createVerificationState();
    const { manager, fake } = await loadedManager({ getVerification: () => verification });
    write(CODE, "export const app = 2;\n");
    verification = freshPass([CODE]);
    manager.recordVerifiedState();
    commitAll("feat: verified change");

    const result = await manager.completeTicket();
    assert.equal(result.ok, true, result.message);
    assert.equal(await planeState(fake), "Done");
  });

  it("denies completion when a PASS was recorded but never bound to the changes", async () => {
    let verification = createVerificationState();
    const { manager, fake } = await loadedManager({ getVerification: () => verification });
    write(CODE, "export const app = 2;\n");
    verification = freshPass([CODE]);

    const result = await manager.completeTicket();
    assert.equal(result.error, "verify_gate_denied");
    assert.match(result.message, /not bound to the current changes/u);
    assert.equal(await planeState(fake), "Todo");
  });

  it("denies completion when a file changes after the PASS", async () => {
    let verification = createVerificationState();
    const { manager, fake } = await loadedManager({ getVerification: () => verification });
    write(CODE, "export const app = 2;\n");
    verification = freshPass([CODE]);
    manager.recordVerifiedState();

    write(CODE, "export const app = 99;\n");
    const result = await manager.completeTicket();
    assert.equal(result.error, "verify_gate_denied");
    assert.match(result.message, /changed after the Verify PASS/u);
    assert.equal(await planeState(fake), "Todo");
  });

  it("denies completion after a session change until a new Verify PASS", async () => {
    let verification = createVerificationState();
    const session = await loadedManager({ getVerification: () => verification });
    write(CODE, "export const app = 2;\n");
    verification = freshPass([CODE]);
    session.manager.recordVerifiedState();
    const snapshot = JSON.parse(JSON.stringify(session.manager.toSnapshot()));
    assert.match(snapshot.baselineRev, HEX);
    assert.match(snapshot.verifiedFingerprint, /^[0-9a-f]{64}$/u);

    // A new session: Verify state is not persisted, so the record starts empty.
    const resumed = new TicketManager({
      transport: session.fake,
      getVerification: () => createVerificationState(),
      selectTracker: PLANE_SELECTION,
      changeProbe: { cwd: () => repo },
    });
    assert.equal(resumed.restoreFromSnapshot(snapshot).ok, true);
    const result = await resumed.completeTicket();
    assert.equal(result.error, "verify_gate_denied");
    assert.match(result.message, /Verification required/u);
    assert.equal(await planeState(session.fake), "Todo");
  });

  it("denies completion of a dirty tree loaded again in a new session", async () => {
    write(CODE, "export const app = 2;\n");
    const fake = seededPlane();
    const { manager } = await loadedManager({ fake, getVerification: () => createVerificationState() });
    assert.equal(manager.getActiveTicket().identifier, "AIES-39");

    const reloaded = await loadedManager({ fake, getVerification: () => createVerificationState() });
    const result = await reloaded.manager.completeTicket();
    assert.equal(result.error, "verify_gate_denied");
    assert.equal(await planeState(fake), "Todo");
  });

  it("refuses a directory outside Git as an unknown change state, even with nothing to report", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const { manager, fake } = await loadedManager({ cwd: plain, getVerification: () => createVerificationState() });
    const result = await manager.completeTicket();
    assert.equal(result.error, "verify_gate_denied");
    assert.match(result.message, /change state unknown/u);
    assert.equal(await planeState(fake), "Todo");
  });

  it("refuses a recorded change outside Git as unknown, even with a fresh PASS", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    let verification = createVerificationState();
    const { manager, fake } = await loadedManager({ cwd: plain, getVerification: () => verification });
    manager.recordChangedPaths([CODE]);
    verification = freshPass([CODE]);
    manager.recordVerifiedState();

    const result = await manager.completeTicket();
    assert.equal(result.error, "verify_gate_denied");
    assert.match(result.message, /change state unknown/u);
    assert.equal(await planeState(fake), "Todo");
  });

  it("refuses a snapshot written before the change evidence existed", async () => {
    let verification = createVerificationState();
    const session = await loadedManager({ getVerification: () => verification });
    session.manager.recordChangedPaths([CODE]);
    verification = freshPass([CODE]);
    const legacy = JSON.parse(JSON.stringify(session.manager.toSnapshot()));
    delete legacy.baselineRev;
    delete legacy.verifiedFingerprint;

    const resumed = new TicketManager({
      transport: session.fake,
      getVerification: () => verification,
      selectTracker: PLANE_SELECTION,
      changeProbe: { cwd: () => repo },
    });
    assert.equal(resumed.restoreFromSnapshot(legacy).ok, true);
    const result = await resumed.completeTicket();
    assert.equal(result.error, "verify_gate_denied");
    assert.match(result.message, /change state unknown/u);
    assert.equal(await planeState(session.fake), "Todo");
  });

  it("leaves the gate unchanged when no probe is wired (the session-only rule)", async () => {
    const fake = seededPlane();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => createVerificationState(),
      selectTracker: PLANE_SELECTION,
    });
    await manager.loadTicket("AIES-39");
    write(CODE, "export const app = 2;\n");
    const hidden = await manager.completeTicket();
    assert.equal(hidden.ok, true, "without a probe an unreported change is invisible, as before");
  });
});

describe("EZE-496: direct completions are guarded by the same Done Gate", () => {
  const DONE = PLANE_STATES.find((state) => state.name === "Done").id;
  const COMPLETE_DIRECTIVE = {
    key: `plane:workitem(action="update",project_id="${PLANE_PROJECT.id}",state="${DONE}",workitem_id="${PLANE_WORKITEM_UUID}")`,
    server: "plane",
    tool: "workitem",
    args: { action: "update", project_id: PLANE_PROJECT.id, workitem_id: PLANE_WORKITEM_UUID, state: DONE },
    purpose: "update the ticket workflow state",
  };
  const stateWrite = { server: "plane", tool: "workitem", args: { ...COMPLETE_DIRECTIVE.args } };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "aies-done-gate-direct-"));
    createRepo();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a Plane state write for completion while the gate denies, and passes it once the gate allows", async () => {
    const { manager } = await loadedManager({ getVerification: () => createVerificationState() });
    const context = (doneGate) => ({
      pending: COMPLETE_DIRECTIVE,
      pendingAction: "complete",
      doneGate,
      trust: TRUSTED,
    });

    assert.equal(
      planeWriteBypassReason("mcp", stateWrite, context(() => manager.evaluateDoneGate())),
      null,
      "a clean tree passes the state write the directive names",
    );

    write(CODE, "export const app = 2;\n");
    const reason = planeWriteBypassReason("mcp", stateWrite, context(() => manager.evaluateDoneGate()));
    assert.ok(reason, "a state write over an unreported change is refused");
    assert.match(reason, /^Bloqueado:/u);
  });

  it("recognises a direct Linear Done by the active ticket and a completed name", () => {
    const active = { identifier: "EZE-496", id: "issue-eze-496" };
    assert.equal(
      isDirectLinearCompletion("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-496", state: "Done" } }, active),
      true,
    );
    assert.equal(
      isDirectLinearCompletion("mcp", { server: "linear", tool: "save_issue", args: { id: "EZE-496", state: "In Progress" } }, active),
      false,
    );
  });

  describe("through the real tool_call hook of the agents extension", () => {
    let savedAgentDir;
    let savedMode;
    let savedCwd;
    let agentDir;
    let linear;
    let host;

    /** The Parent's tool_call handlers, as Pi calls them for this session. */
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
        /** The first block a `tool_call` handler returns, or null when the call may run. */
        async toolCall(toolName, input) {
          const ctx = { cwd: repo, mode: "print", hasUI: false, getContextUsage: () => undefined };
          for (const handler of handlers.get("tool_call") ?? []) {
            const result = await handler({ type: "tool_call", toolName, input }, ctx);
            if (result && result.block) return result;
          }
          return null;
        },
      };
    }

    const linearSave = { server: "linear", tool: "save_issue", args: { id: "EZE-496", state: "Done" } };

    beforeEach(() => {
      savedAgentDir = process.env.PI_CODING_AGENT_DIR;
      savedMode = process.env.PI_MCP_CONFIG_MODE;
      savedCwd = process.cwd();
      agentDir = mkdtempSync(join(tmpdir(), "aies-done-gate-agent-"));
      writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ tracker: "linear" }));
      // D38: a trusted MCP profile, so the Linear call reaches the Done Gate instead of the profile refusal.
      writeFileSync(join(agentDir, "mcp-adapter.json"), JSON.stringify(templateProfile()));
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_MCP_CONFIG_MODE = "exclusive";
      process.chdir(repo);
      linear = new FakeLinearTransport([
        {
          id: "issue-eze-496",
          identifier: "EZE-496",
          title: "Done Gate over Linear",
          description: DESCRIPTION,
          state: { id: "status-todo", name: "Todo", type: "unstarted" },
        },
      ]);
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
    });

    it("blocks a direct Linear Done over an unreported change, and leaves the ticket open", async () => {
      const manager = getActiveTicketManager();
      manager.setTransport(linear);
      assert.equal((await manager.loadTicket("EZE-496")).ok, true);

      write(CODE, "export const app = 2;\n");
      const block = await host.toolCall("mcp", linearSave);
      assert.ok(block, "a direct Done over an unreported change must be refused");
      assert.match(block.reason, /^Bloqueado: no se cierra EZE-496 en Linear/u);
      assert.match(block.reason, /aies_ticket action "complete"/u);
      assert.equal((await linear.getIssue("EZE-496")).state.name, "Todo", "Linear keeps its state");
    });

    it("lets a direct Linear Done through when the gate allows it (no change to prove)", async () => {
      const manager = getActiveTicketManager();
      manager.setTransport(linear);
      assert.equal((await manager.loadTicket("EZE-496")).ok, true);

      assert.equal(await host.toolCall("mcp", linearSave), null);
    });
  });
});
