/**
 * D40: the startup notice about the tracker and the repository binding.
 *
 * The pure helper is driven with real temporary git repositories and a temporary profile
 * (`PI_CODING_AGENT_DIR`). The session_start handler is driven through the real agents
 * extension with a fake Pi, so the wiring (startup only, UI only, never blocking) is tested
 * where it lives.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import aiesAgents from "../extensions/aies-agents/index.ts";
import { defaultBindScript, describeWorkspaceNotice } from "../extensions/aies-agents/workspace-notice.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;
const BIND_SCRIPT = "/opt/aies/scripts/bind-project.mjs";

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "-c", "user.email=aies@example.com", "-c", "user.name=AIES Fixture", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
}

function makeRepo(parent, name) {
  const root = join(parent, name);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "fixture baseline"]);
  return realpathSync(root);
}

describe("workspace notice: the pure helper", { skip: !GIT_AVAILABLE && "git is not available" }, () => {
  let scratch;
  let agentDir;
  let env;
  let repo;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "aies-notice-")));
    agentDir = join(scratch, "agent");
    mkdirSync(agentDir, { recursive: true });
    env = { PI_CODING_AGENT_DIR: agentDir };
    repo = makeRepo(scratch, "alpha-app");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const writeConfig = (value) => writeFileSync(join(agentDir, "aies.json"), `${JSON.stringify(value, null, 2)}\n`);

  it("reports a bound repository on one info line, from a subdirectory too", () => {
    writeConfig({ tracker: "plane", repos: { AIES: repo } });

    const notice = describeWorkspaceNotice(join(repo, "src"), { env, bindScript: BIND_SCRIPT });

    assert.equal(notice.level, "info");
    assert.equal(notice.message, "Tracker: Plane · este repo está vinculado a AIES");
    assert.equal(notice.message.includes("\n"), false);
  });

  it("matches a binding stored through a symlink to the repository", () => {
    const link = join(scratch, "alpha-link");
    symlinkSync(repo, link);
    writeConfig({ tracker: "plane", repos: { AIES: link } });

    const notice = describeWorkspaceNotice(repo, { env, bindScript: BIND_SCRIPT });

    assert.equal(notice.level, "info");
    assert.match(notice.message, /vinculado a AIES/u);
  });

  it("warns on an unbound repository and prints the exact binding command", () => {
    const notice = describeWorkspaceNotice(repo, { env, bindScript: BIND_SCRIPT });

    assert.equal(notice.level, "warning");
    assert.match(notice.message, /^Tracker: Linear · AVISO: este repo no está vinculado/u);
    assert.ok(
      notice.message.endsWith(`Vincúlalo con: node ${BIND_SCRIPT} <PROJECT_ID> .`),
      notice.message,
    );
  });

  it("does not treat a binding to another repository as this one", () => {
    const other = makeRepo(scratch, "beta-site");
    writeConfig({ tracker: "plane", repos: { BETA: other } });

    const notice = describeWorkspaceNotice(repo, { env, bindScript: BIND_SCRIPT });

    assert.equal(notice.level, "warning");
    assert.match(notice.message, /Tracker: Plane · AVISO/u);
  });

  it("quotes a binding script path that contains spaces so the hint stays pasteable", () => {
    const notice = describeWorkspaceNotice(repo, { env, bindScript: "/Users/me/My Code/AIES/scripts/bind-project.mjs" });

    assert.match(notice.message, /node "\/Users\/me\/My Code\/AIES\/scripts\/bind-project\.mjs" <PROJECT_ID> \.$/u);
  });

  it("warns that ticket work needs a git repository when the cwd is not inside one", () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);

    const notice = describeWorkspaceNotice(plain, { env, bindScript: BIND_SCRIPT });

    assert.equal(notice.level, "warning");
    assert.equal(
      notice.message,
      "Tracker: Linear · AVISO: este directorio no es un repo git. El trabajo de tickets necesita un repo git.",
    );
  });

  it("never throws for a cwd that does not exist", () => {
    const notice = describeWorkspaceNotice(join(scratch, "vanished"), { env, bindScript: BIND_SCRIPT });

    assert.equal(notice.level, "warning");
    assert.match(notice.message, /no es un repo git/u);
  });

  it("names the tracker the profile uses, Linear by default", () => {
    assert.match(describeWorkspaceNotice(repo, { env, bindScript: BIND_SCRIPT }).message, /^Tracker: Linear/u);

    writeConfig({ tracker: "plane" });
    assert.match(describeWorkspaceNotice(repo, { env, bindScript: BIND_SCRIPT }).message, /^Tracker: Plane/u);
  });

  it("flags an unknown tracker value without claiming a label", () => {
    writeConfig({ tracker: "jira", repos: { AIES: repo } });

    const notice = describeWorkspaceNotice(repo, { env, bindScript: BIND_SCRIPT });

    assert.match(notice.message, /^Tracker: no válido en aies\.json · este repo está vinculado a AIES$/u);
  });

  it("treats an unreadable aies.json as an unbound profile instead of failing", () => {
    writeFileSync(join(agentDir, "aies.json"), "{ not json");

    const notice = describeWorkspaceNotice(repo, { env, bindScript: BIND_SCRIPT });

    assert.equal(notice.level, "warning");
    assert.match(notice.message, /no está vinculado/u);
  });

  it("points the default hint at this checkout's scripts/bind-project.mjs", () => {
    assert.equal(defaultBindScript(), join(REPO_ROOT, "scripts", "bind-project.mjs"));
  });
});

describe("workspace notice: the session_start wiring", { skip: !GIT_AVAILABLE && "git is not available" }, () => {
  let scratch;
  let repo;
  let previousAgentDir;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "aies-notice-wiring-")));
    repo = makeRepo(scratch, "alpha-app");
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    // The handler reads the profile from the environment, so point it at a temporary one.
    process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  });

  afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(scratch, { recursive: true, force: true });
  });

  function fakeHost() {
    const handlers = new Map();
    const pi = {
      events: { on: () => () => {}, emit: () => {} },
      on(event, handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      },
      registerTool() {},
      registerCommand() {},
      getAllTools: () => [],
      getActiveTools: () => [],
      appendEntry() {},
      sendUserMessage() {},
    };
    aiesAgents(pi);
    return {
      async emit(event, payload, ctx) {
        for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
      },
    };
  }

  function uiContext(cwd, hasUI = true) {
    const notices = [];
    return {
      notices,
      ctx: { cwd, hasUI, ui: { notify: (message, level) => notices.push({ message, level }) }, sessionManager: { getEntries: () => [] } },
    };
  }

  it("shows the notice once at startup in a UI session", async () => {
    const host = fakeHost();
    const { ctx, notices } = uiContext(repo);

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.equal(notices.length, 1);
    assert.equal(notices[0].level, "warning");
    assert.match(notices[0].message, /^Tracker: Linear · AVISO: este repo no está vinculado/u);
  });

  it("stays silent in a headless session", async () => {
    const host = fakeHost();
    const { ctx, notices } = uiContext(repo, false);

    await host.emit("session_start", { reason: "startup" }, ctx);

    assert.deepEqual(notices, []);
  });

  it("does not repeat the notice on other session reasons", async () => {
    const host = fakeHost();
    const { ctx, notices } = uiContext(repo);

    await host.emit("session_start", { reason: "new" }, ctx);
    await host.emit("session_start", { reason: "resume" }, ctx);

    assert.deepEqual(notices, []);
  });

  it("never blocks startup when the notice cannot be shown", async () => {
    const host = fakeHost();
    const ctx = { cwd: repo, hasUI: true, ui: { notify: () => { throw new Error("ui gone"); } }, sessionManager: { getEntries: () => [] } };

    await host.emit("session_start", { reason: "startup" }, ctx);
  });
});
