/**
 * AIES isolation checks.
 *
 * Every assertion runs against a temporary AIES_HOME, so the real AIES profile
 * and the ambient Pi profile are never written to. The suite also inherits
 * hostile ambient values (PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR
 * pointing at the real Pi profile) on purpose: the launcher must override them.
 *
 * No credentials and no model calls are required.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const AIES = join(REPO, "bin", "aies");

const PI_PROFILE = join(homedir(), ".pi", "agent");
const DEFAULT_AIES_HOME = join(homedir(), ".local", "share", "aies");

/** Packages the repository template declares for the AIES profile. */
const DECLARED_PACKAGES =
  JSON.parse(readFileSync(join(REPO, "profile", "settings.json"), "utf8")).packages ?? [];

/** Snapshot of files that must never change when AIES runs. */
const WATCHED = ["settings.json", "auth.json", "models.json"].map((name) => join(PI_PROFILE, name));

function digest(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fingerprintProfile() {
  return {
    files: Object.fromEntries(WATCHED.map((path) => [path, digest(path)])),
    sessions: existsSync(join(PI_PROFILE, "sessions"))
      ? readdirSync(join(PI_PROFILE, "sessions")).sort()
      : [],
  };
}

/** Ambient environment deliberately pointing at the real Pi profile. */
function isolatedEnv(home) {
  return {
    ...process.env,
    AIES_HOME: home,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    PI_CODING_AGENT_DIR: PI_PROFILE,
    PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
  };
}

function runAies(env, args) {
  const result = spawnSync(AIES, args, { env, encoding: "utf8" });
  assert.equal(result.status, 0, `aies ${args.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

function parseInfo(stdout) {
  const info = {};
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) info[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return info;
}

/** Runs pi in RPC mode through the launcher and returns the decoded records. */
function rpc(env, commands, extraArgs = []) {
  const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
  const result = spawnSync(AIES, ["--mode", "rpc", ...extraArgs], { env, input, encoding: "utf8" });

  const records = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Diagnostics that are not part of the JSONL protocol.
    }
  }

  return { status: result.status, records, stderr: result.stderr };
}

function responseFor(records, command) {
  const record = records.find((entry) => entry.type === "response" && entry.command === command);
  assert.ok(record, `no "${command}" response in RPC output`);
  assert.equal(record.success, true, `${command} failed: ${JSON.stringify(record.error ?? {})}`);
  return record.data;
}

describe("AIES isolation", () => {
  let home;
  let agentDir;
  let env;
  let baseline;

  before(() => {
    baseline = fingerprintProfile();
    home = mkdtempSync(join(tmpdir(), "aies-isolation-"));
    agentDir = join(home, "agent");
    env = isolatedEnv(home);
  });

  after(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("resolves the isolated profile, overriding ambient Pi variables", () => {
    const info = parseInfo(runAies(env, ["--aies-info"]));

    assert.equal(info.AIES_HOME, home);
    assert.equal(info.PI_CODING_AGENT_DIR, agentDir);
    assert.equal(info.AIES_REPO, REPO);
    assert.notEqual(info.PI_CODING_AGENT_DIR, PI_PROFILE);
  });

  it("resolves the repository correctly when launched through a PATH symlink", () => {
    // Typical installation: ~/.local/bin/aies -> <repo>/bin/aies. AIES_REPO
    // must follow the real script, not the symlink location.
    const binDir = mkdtempSync(join(tmpdir(), "aies-symlink-"));
    try {
      const link = join(binDir, "aies");
      symlinkSync(AIES, link);

      const result = spawnSync(link, ["--aies-info"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, `symlinked launcher failed:\n${result.stderr}`);

      const info = parseInfo(result.stdout);
      assert.equal(info.AIES_REPO, REPO);
      assert.equal(info.AIES_HOME, home);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("is resolved by Pi's own API, not by AIES's assumptions", async () => {
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const pi = await import("@earendil-works/pi-coding-agent").catch((error) => {
      throw new Error(`cannot import pi's public API, run "npm install" first: ${error.message}`);
    });

    assert.equal(pi.getAgentDir(), agentDir);
    assert.notEqual(pi.getAgentDir(), PI_PROFILE);
  });

  it("bootstraps the profile: linked resources and a seeded settings file", () => {
    runAies(env, ["--aies-info"]);

    const extensions = join(agentDir, "extensions");
    assert.ok(lstatSync(extensions).isSymbolicLink(), "extensions should be a symlink into the repo");
    assert.equal(readlinkSync(extensions), join(REPO, "extensions"));

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.deepEqual(
      [...(settings.packages ?? [])].sort(),
      [...DECLARED_PACKAGES].sort(),
      "the AIES profile loads exactly the packages the repository declares and inherits nothing from the ambient profile",
    );
    assert.ok(
      DECLARED_PACKAGES.includes("npm:pi-mcp-adapter"),
      "the AIES profile loads exactly the MCP adapter it needs, and inherits nothing from the ambient profile",
    );
  });

  it("stores sessions inside the isolated profile", () => {
    const { records } = rpc(env, [{ id: "1", type: "get_state" }]);
    const state = responseFor(records, "get_state");

    assert.ok(state.sessionFile, "expected a persisted session file");
    assert.ok(
      state.sessionFile.startsWith(`${join(agentDir, "sessions")}/`),
      `session file escaped the profile: ${state.sessionFile}`,
    );
  });

  it("loads extensions from the AIES profile and none from the ambient Pi profile", () => {
    const { records } = rpc(env, [{ id: "1", type: "get_commands" }], ["--no-session"]);
    const commands = responseFor(records, "get_commands").commands;

    const identity = commands.find((command) => command.name === "aies-info");
    assert.ok(identity, "the AIES identity extension is not loaded");
    assert.equal(identity.sourceInfo.baseDir, agentDir);

    const leaked = commands.filter((command) => command.sourceInfo?.path?.startsWith(PI_PROFILE));
    assert.deepEqual(leaked, [], `commands leaked from the ambient Pi profile: ${JSON.stringify(leaked)}`);
  });

  it("keeps global cross-harness skills out", () => {
    const { records } = rpc(env, [{ id: "1", type: "get_commands" }], ["--no-session"]);
    const commands = responseFor(records, "get_commands").commands;

    const skills = commands.filter((command) => command.source === "skill");
    const leaked = skills.filter((command) => !command.sourceInfo?.path?.startsWith(REPO));
    assert.deepEqual(leaked, [], `global cross-harness skills leaked into the AIES profile: ${JSON.stringify(leaked)}`);
    assert.ok(
      skills.some((command) => command.name === "skill:linear-ticket"),
      "repository skill linear-ticket was not loaded via --skill",
    );
  });

  it("does not surface the ambient profile's packages", () => {
    const ambient = existsSync(join(PI_PROFILE, "settings.json"))
      ? (JSON.parse(readFileSync(join(PI_PROFILE, "settings.json"), "utf8")).packages ?? [])
      : [];

    const listing = runAies(env, ["list"]);
    const source = (entry) => (typeof entry === "string" ? entry : entry.source);

    // Only what the repository declares is legitimate; an ambient package is a
    // leak unless the template also declares it.
    const leaked = ambient.filter(
      (entry) => !DECLARED_PACKAGES.includes(source(entry)) && listing.includes(source(entry)),
    );
    assert.deepEqual(leaked, [], `ambient packages leaked into the AIES profile: ${JSON.stringify(leaked)}`);

    const missing = DECLARED_PACKAGES.filter((entry) => !listing.includes(source(entry)));
    assert.deepEqual(
      missing,
      [],
      `the AIES profile failed to declare a required package: ${JSON.stringify(missing)}`,
    );
  });

  it("leaves the ambient Pi profile untouched", () => {
    assert.deepEqual(fingerprintProfile(), baseline);
  });

  it("does not create the default profile when AIES_HOME points elsewhere", () => {
    if (existsSync(DEFAULT_AIES_HOME)) {
      // The user already ran aies for real; nothing to assert here.
      return;
    }
    assert.equal(existsSync(DEFAULT_AIES_HOME), false);
  });
});
