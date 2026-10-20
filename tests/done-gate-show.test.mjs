/**
 * EZE-496: `aies_ticket show` reports the real Done Gate diagnosis.
 *
 * The diagnosis and the completion must never disagree, so every scenario checks that
 * `describeDoneGate`, the rendered `show` text and `aies_ticket complete` all reach the
 * same verdict and the same reason. The repositories are real throwaway Git repositories
 * under os.tmpdir(), committed only inside them. The tracker is an offline fake that
 * counts its calls. No network, no credential, no real Plane.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { formatCompactContract } from "../extensions/aies-agents/linear/contract.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { FakePlaneTransport } from "../extensions/aies-agents/linear/plane-transport.ts";
import { PLANE_TRACKER } from "../extensions/aies-agents/linear/tracker.ts";
import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
} from "../extensions/aies-agents/verification.ts";

const PLANE_SELECTION = () => ({ ok: true, tracker: PLANE_TRACKER });
const DESCRIPTION = "## Acceptance Criteria\n- [ ] The Done Gate reads the repository\n";
const CODE = "src/app.ts";
const DOCS = "docs/notes.md";
const HOLD = "no commit todavía";
const FULL_SHA = /[0-9a-f]{40}/u;

/** A verification record with a fresh PASS over `paths`, as the Verify child reports it. */
function freshPass(paths = [CODE]) {
  let state = createVerificationState();
  state = applyWorkUnitChange(state, paths, "worker implemented the change");
  state = applyVerifyStart(state, 1_700_000_000_000);
  return applyVerifyResult(state, { status: "pass", criteria: [] }, 1_700_000_000_100);
}

let root;
let repo;
let savedAgentDir;
let agentDir;

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

/** Counts every call made to the tracker, so a read-only path can prove it made none. */
function countingTransport(fake, calls) {
  return new Proxy(fake, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args) => {
        calls.push(String(prop));
        return value.apply(target, args);
      };
    },
  });
}

/** A manager that reads the repository through the injected probe, loaded on the current tree. */
async function loadedSession({ cwd = repo, getVerification = () => createVerificationState(), calls = [] } = {}) {
  const fake = seededPlane();
  const manager = new TicketManager({
    transport: countingTransport(fake, calls),
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

/**
 * The verdict of `describeDoneGate` must equal the verdict of `evaluateDoneGate`, and the
 * rendered `show` must say the same, with the same structured diagnosis in `details`.
 */
async function assertShowAgrees(manager) {
  const gate = manager.evaluateDoneGate();
  const diagnosis = manager.describeDoneGate();
  const decision = gate.allowed ? "ALLOW" : "DENY";

  assert.equal(diagnosis.decision, decision);
  assert.equal(diagnosis.reason, gate.reason);
  assert.equal(diagnosis.code, gate.code);

  const shown = await createTicketTool(manager).execute("show", { action: "show" }, undefined, undefined, {
    cwd: repo,
  });
  const text = shown.content[0].text;
  assert.equal(shown.isError, false, "a DENY is information, not a tool error");
  assert.ok(text.includes(`Done Gate: ${decision} — ${gate.reason}`), text);
  assert.deepEqual(shown.details.doneGate, diagnosis);
  return { gate, diagnosis, text };
}

/** `aies_ticket complete` must allow exactly when the gate allows, and refuse with the same reason. */
async function assertCompletionAgrees(manager, fake, gate) {
  const result = await manager.completeTicket();
  if (gate.allowed) {
    assert.equal(result.ok, true, result.message);
    assert.equal(await planeState(fake), "Done");
    return;
  }
  assert.equal(result.ok, false);
  assert.equal(result.error, gate.code === "pending_final_action" ? "pending_final_action" : "verify_gate_denied");
  assert.ok(result.message.includes(gate.reason), result.message);
  assert.equal(await planeState(fake), "Todo", "a refused completion changes nothing in the tracker");
}

beforeEach(() => {
  savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "aies-done-gate-show-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  root = mkdtempSync(join(tmpdir(), "aies-done-gate-show-"));
  createRepo();
});

afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe("EZE-496: show and complete reach the same Done Gate verdict", () => {
  it("ALLOW on a clean tree with a known baseline, and complete agrees", async () => {
    const { manager, fake } = await loadedSession();
    const { gate, diagnosis, text } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "ALLOW");
    assert.equal(diagnosis.evidence, "known");
    assert.equal(diagnosis.probe, true);
    assert.match(diagnosis.baseline, /^[0-9a-f]{12}$/u);
    assert.deepEqual(diagnosis.effectivePaths, { items: [], more: 0 });
    assert.match(text, /^Done Gate: ALLOW — Verification not required/mu);
    await assertCompletionAgrees(manager, fake, gate);
  });

  it("ALLOW on a documentation-only dirty tree, and complete agrees", async () => {
    const { manager, fake } = await loadedSession();
    write(DOCS, "# Notes\n\nA clearer sentence.\n");
    const { gate, diagnosis } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "ALLOW");
    assert.deepEqual(diagnosis.detectedPaths.items, [DOCS]);
    await assertCompletionAgrees(manager, fake, gate);
  });

  it("DENY on a behaviour-bearing dirty tree with no PASS, and complete agrees", async () => {
    const { manager, fake } = await loadedSession();
    write(CODE, "export const app = 2;\n");
    const { gate, diagnosis } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "DENY");
    assert.equal(diagnosis.code, "verify_gate_denied");
    assert.match(diagnosis.reason, /Verification required/u);
    assert.deepEqual(diagnosis.detectedPaths.items, [CODE]);
    assert.equal(diagnosis.verificationRequired.required, true);
    assert.equal(diagnosis.verification.status, "none");
    await assertCompletionAgrees(manager, fake, gate);
  });

  it("ALLOW on a dirty tree with a fresh PASS bound to it, and complete agrees", async () => {
    let verification = createVerificationState();
    const { manager, fake } = await loadedSession({ getVerification: () => verification });
    write(CODE, "export const app = 2;\n");
    verification = freshPass([CODE]);
    manager.recordVerifiedState();
    const { gate, diagnosis } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "ALLOW");
    assert.equal(diagnosis.verification.valid, true);
    assert.equal(diagnosis.fingerprint.matches, true);
    assert.equal(diagnosis.fingerprint.verified, diagnosis.fingerprint.current);
    await assertCompletionAgrees(manager, fake, gate);
  });

  it("DENY after an edit made after the PASS, and complete agrees", async () => {
    let verification = createVerificationState();
    const { manager, fake } = await loadedSession({ getVerification: () => verification });
    write(CODE, "export const app = 2;\n");
    verification = freshPass([CODE]);
    manager.recordVerifiedState();
    write(CODE, "export const app = 99;\n");
    const { gate, diagnosis } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "DENY");
    assert.equal(diagnosis.fingerprint.matches, false);
    assert.match(diagnosis.reason, /changed after the Verify PASS/u);
    await assertCompletionAgrees(manager, fake, gate);
  });

  it("DENY on a clean tree while a final step is held, and complete reports the hold", async () => {
    const { manager, fake } = await loadedSession();
    manager.recordUserInput(HOLD);
    const { gate, diagnosis } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "DENY");
    assert.equal(diagnosis.code, "pending_final_action");
    assert.match(diagnosis.reason, /^Pending final action:/u);
    assert.match(diagnosis.pendingFinalAction.quote, /commit/u, "the user's own words are the quote");
    await assertCompletionAgrees(manager, fake, gate);
  });

  it("DENY for a directory outside Git, and complete agrees", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const { manager, fake } = await loadedSession({ cwd: plain });
    const { gate, diagnosis } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "DENY");
    assert.equal(diagnosis.evidence, "unknown");
    assert.equal(diagnosis.baseline, "unknown");
    await assertCompletionAgrees(manager, fake, gate);
  });

  it("DENY for a legacy snapshot without a baseline, and complete agrees", async () => {
    let verification = createVerificationState();
    const session = await loadedSession({ getVerification: () => verification });
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
    const { gate, diagnosis } = await assertShowAgrees(resumed);

    assert.equal(diagnosis.decision, "DENY");
    assert.equal(diagnosis.evidence, "unknown");
    assert.match(diagnosis.unknownReason, /baseline commit was not recorded/u);
    await assertCompletionAgrees(resumed, session.fake, gate);
  });

  it("reports the session-only rule when no probe is wired, and complete agrees", async () => {
    const fake = seededPlane();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => createVerificationState(),
      selectTracker: PLANE_SELECTION,
    });
    assert.equal((await manager.loadTicket("AIES-39")).ok, true);
    write(CODE, "export const app = 2;\n");
    const { gate, diagnosis, text } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "ALLOW", "without a probe an unreported change is invisible, as before");
    assert.equal(diagnosis.probe, false);
    assert.equal(diagnosis.evidence, "not configured");
    assert.equal(diagnosis.baseline, "none");
    assert.equal(diagnosis.fingerprint.current, "unknown");
    assert.match(text, /Git evidence: not configured/u);
    await assertCompletionAgrees(manager, fake, gate);
  });
});

describe("EZE-496: unknown Git evidence fails closed in show", () => {
  it("shows DENY with the unknown reason that complete uses, for a directory outside Git", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    const { manager } = await loadedSession({ cwd: plain });
    const { gate, diagnosis, text } = await assertShowAgrees(manager);

    assert.equal(gate.code, "verify_gate_denied");
    assert.match(gate.reason, /^change state unknown: the baseline commit was not recorded/u);
    assert.match(text, /Git evidence: unknown — the baseline commit was not recorded/u);
    assert.match(diagnosis.unknownReason, /the baseline commit was not recorded/u);
  });

  it("shows DENY when Git fails after the ticket was loaded", async () => {
    const { manager, fake } = await loadedSession();
    renameSync(join(repo, ".git"), join(repo, ".git-away"));
    const { gate, diagnosis, text } = await assertShowAgrees(manager);

    assert.equal(diagnosis.decision, "DENY");
    assert.equal(diagnosis.evidence, "unknown");
    assert.equal(diagnosis.fingerprint.current, "unknown");
    assert.match(diagnosis.unknownReason, /Git could not describe the working tree/u);
    assert.match(text, /Git evidence: unknown — Git could not describe the working tree/u);
    await assertCompletionAgrees(manager, fake, gate);
  });
});

describe("EZE-496: show is read-only", () => {
  /** Everything a show or a diagnosis could disturb, read without changing it. */
  function stateOf(manager, verification, calls) {
    const { persistedAt: _ignored, ...snapshot } = manager.toSnapshot() ?? {};
    return {
      snapshot: JSON.stringify(snapshot),
      verification: JSON.stringify(verification),
      changedPaths: manager.getChangedPaths(),
      pendingFinalAction: manager.getPendingFinalAction(),
      workState: manager.getWorkState(),
      gitStatus: git(["status", "--porcelain"]),
      head: git(["rev-parse", "HEAD"]),
      index: git(["ls-files", "--stage"]),
      refs: git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      stashes: git(["stash", "list"]),
      trackerCalls: [...calls],
    };
  }

  it("changes neither the ticket, the verification record, the Git repository nor the tracker", async () => {
    const calls = [];
    let verification = createVerificationState();
    const { manager } = await loadedSession({ getVerification: () => verification, calls });
    write(CODE, "export const app = 2;\n");
    manager.recordChangedPaths([CODE]);
    verification = freshPass([CODE]);
    // The PASS is deliberately not bound: a diagnosis must not bind it.
    calls.length = 0;
    const before = stateOf(manager, verification, calls);

    const tool = createTicketTool(manager);
    for (let i = 0; i < 3; i += 1) {
      manager.describeDoneGate();
      manager.evaluateDoneGate();
      await tool.execute(`show-${i}`, { action: "show" }, undefined, undefined, { cwd: repo });
    }

    assert.deepEqual(stateOf(manager, verification, calls), before);
    assert.equal(manager.describeDoneGate().decision, "DENY", "still unbound: the PASS was never bound by show");
    assert.equal(manager.toSnapshot().verifiedFingerprint, undefined);
  });

  it("keeps a held final step and its baseline untouched", async () => {
    const calls = [];
    const { manager, fake } = await loadedSession({ calls });
    manager.recordUserInput(HOLD);
    calls.length = 0;
    const before = stateOf(manager, createVerificationState(), calls);

    for (let i = 0; i < 3; i += 1) manager.describeDoneGate();
    assert.deepEqual(stateOf(manager, createVerificationState(), calls), before);
    assert.notEqual(manager.getPendingFinalAction(), null, "the hold still stands");

    const result = await manager.completeTicket();
    assert.equal(result.error, "pending_final_action", "the held step still refuses completion");
    assert.equal(await planeState(fake), "Todo");
  });
});

describe("EZE-496: show does not leak secrets or unbounded output", () => {
  it("caps long path lists at 20 with the number left out", async () => {
    const { manager } = await loadedSession();
    for (let i = 1; i <= 25; i += 1) {
      write(`src/file-${String(i).padStart(2, "0")}.ts`, `export const value${i} = ${i};\n`);
    }
    const diagnosis = manager.describeDoneGate();
    assert.equal(diagnosis.detectedPaths.items.length, 20);
    assert.equal(diagnosis.detectedPaths.more, 5);
    assert.equal(diagnosis.effectivePaths.items.length, 20);
    assert.equal(diagnosis.effectivePaths.more, 5);

    const shown = await createTicketTool(manager).execute("cap", { action: "show" }, undefined, undefined, {
      cwd: repo,
    });
    assert.match(shown.content[0].text, /, \+5 more\n/u);
  });

  it("caps the path list inside a documentation-only reason at 20 with the number left out", async () => {
    const { manager } = await loadedSession();
    for (let i = 1; i <= 25; i += 1) write(`docs/note-${String(i).padStart(2, "0")}.md`, `# Note ${i}\n`);

    const diagnosis = manager.describeDoneGate();
    assert.equal(diagnosis.decision, "ALLOW", "documentation-only still completes");
    for (const text of [diagnosis.reason, diagnosis.verificationRequired.reason]) {
      assert.match(text, /documentation-only change \(/u);
      assert.match(text, /, \+5 more\)/u);
      assert.equal((text.match(/note-\d\d\.md/gu) ?? []).length, 20);
    }
    const shown = await createTicketTool(manager).execute("docs-cap", { action: "show" }, undefined, undefined, {
      cwd: repo,
    });
    const everything = `${shown.content[0].text}\n${JSON.stringify(shown.details)}`;
    for (let i = 21; i <= 25; i += 1) {
      assert.equal(everything.includes(`note-${i}.md`), false, `note-${i}.md is past the cap and stays out`);
    }
  });

  it("shows an unreachable baseline by 12 characters and bounds the Git error text, still DENY", async () => {
    const { manager } = await loadedSession();
    const missing = "1234567890abcdef1234567890abcdef12345678";
    const snapshot = manager.toSnapshot();
    snapshot.baselineRev = missing;
    assert.equal(manager.restoreFromSnapshot(snapshot).ok, true);

    const diagnosis = manager.describeDoneGate();
    assert.equal(diagnosis.decision, "DENY");
    assert.equal(diagnosis.evidence, "unknown");
    const shown = await createTicketTool(manager).execute("bad-base", { action: "show" }, undefined, undefined, {
      cwd: repo,
    });
    const everything = `${shown.content[0].text}\n${JSON.stringify(shown.details)}`;
    assert.equal(everything.includes(missing), false, "the full object name stays out");
    assert.equal(FULL_SHA.test(everything), false);
    assert.equal(diagnosis.reason.length <= 1200, true);
    assert.equal(diagnosis.unknownReason.length <= 1200, true);
    assert.equal(manager.evaluateDoneGate().allowed, false, "complete would refuse as well");
  });

  it("never prints file contents, the repository root, a full sha or an absolute path outside the repository", async () => {
    const { manager } = await loadedSession();
    write(CODE, "export const app = 'SECRET_BODY_MARKER';\n");
    manager.recordChangedPaths([join(repo, "src", "app.ts"), join(root, "elsewhere", "private-notes.md")]);

    const shown = await createTicketTool(manager).execute("leak", { action: "show" }, undefined, undefined, {
      cwd: repo,
    });
    const text = shown.content[0].text;
    const everything = `${text}\n${JSON.stringify(shown.details)}`;

    assert.equal(everything.includes("SECRET_BODY_MARKER"), false, "file contents stay out");
    assert.equal(everything.includes(repo), false, "the repository root stays out");
    assert.equal(everything.includes(root), false, "the temporary root stays out");
    assert.equal(FULL_SHA.test(everything), false, "no full sha");
    assert.match(text, /\.\.\.\/private-notes\.md/u, "an outside path is shown by its file name only");
    assert.deepEqual(shown.details.doneGate.recordedPaths.items, [CODE, ".../private-notes.md"]);
  });
});

describe("EZE-496: the show tool keeps the contract and adds the Done Gate section", () => {
  it("appends the Done Gate section after the existing contract text", async () => {
    const { manager } = await loadedSession();
    write(CODE, "export const app = 2;\n");
    const shown = await createTicketTool(manager).execute("tool", { action: "show" }, undefined, undefined, {
      cwd: repo,
    });
    const text = shown.content[0].text;
    const contract = formatCompactContract(manager.getActiveTicket());

    assert.equal(shown.isError, false);
    assert.match(text, /^Active Ticket \[workState: loaded\]:/u);
    assert.ok(text.includes(contract), "the existing contract text is kept");
    assert.ok(text.indexOf(contract) < text.indexOf("Done Gate: DENY — "), "the section follows the contract");
    assert.deepEqual(shown.details.doneGate, manager.describeDoneGate());
    assert.equal(shown.details.active, true);
  });

  it("keeps show without an active ticket as it was", async () => {
    const manager = new TicketManager({
      transport: seededPlane(),
      getVerification: () => createVerificationState(),
      selectTracker: PLANE_SELECTION,
      changeProbe: { cwd: () => repo },
    });
    const shown = await createTicketTool(manager).execute("none", { action: "show" }, undefined, undefined, {
      cwd: repo,
    });
    assert.equal(shown.isError, false);
    assert.equal(shown.details.active, false);
    assert.equal("doneGate" in shown.details, false);
    assert.doesNotMatch(shown.content[0].text, /Done Gate/u);
  });
});
