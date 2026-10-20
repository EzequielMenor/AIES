/**
 * D40: `bin/aies --aies-info` reports the project root of the launch directory and the
 * tracker of the profile. Both lines are read-only and the rest of the output is unchanged.
 *
 * Each run uses a temporary AIES_HOME and launches from a temporary directory, so the
 * results depend only on the fixtures.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const LAUNCHER = fileURLToPath(new URL("../bin/aies", import.meta.url));
const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;

function info(cwd, home) {
  const env = { ...process.env, AIES_HOME: home };
  delete env.AIES_EPHEMERAL;
  const result = spawnSync(LAUNCHER, ["--aies-info"], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, `launcher failed:\n${result.stderr}`);
  const values = {};
  for (const line of result.stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return values;
}

describe("aies --aies-info: project root and tracker", { skip: !GIT_AVAILABLE && "git is not available" }, () => {
  let scratch;
  let home;
  let repo;
  let plain;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "aies-info-project-")));
    home = join(scratch, "home");
    repo = join(scratch, "alpha-app");
    plain = join(scratch, "plain");
    mkdirSync(repo, { recursive: true });
    mkdirSync(plain, { recursive: true });
    const git = (args) => spawnSync("git", ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo });
    git(["init", "-q", "-b", "main"]);
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("reports the git toplevel of the launch directory and the linear default", () => {
    const values = info(join(repo), home);

    assert.equal(values.AIES_PROJECT_ROOT, realpathSync(repo));
    assert.equal(values.tracker, "linear");
  });

  it("reports the toplevel even from a subdirectory of the repository", () => {
    mkdirSync(join(repo, "src", "deep"), { recursive: true });

    const values = info(join(repo, "src", "deep"), home);

    assert.equal(values.AIES_PROJECT_ROOT, realpathSync(repo));
  });

  it("reports none outside a git repository", () => {
    const values = info(plain, home);

    assert.equal(values.AIES_PROJECT_ROOT, "none");
  });

  it("reports the tracker the profile declares", () => {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(join(home, "agent", "aies.json"), `${JSON.stringify({ tracker: "plane", repos: {} })}\n`);

    const values = info(repo, home);

    assert.equal(values.tracker, "plane");
  });

  it("reports an unreadable aies.json as invalid instead of failing", () => {
    mkdirSync(join(home, "agent"), { recursive: true });
    writeFileSync(join(home, "agent", "aies.json"), "{ not json");

    const values = info(repo, home);

    assert.equal(values.tracker, "invalid");
  });

  it("keeps the existing lines in place", () => {
    const env = { ...process.env, AIES_HOME: home };
    delete env.AIES_EPHEMERAL;
    const result = spawnSync(LAUNCHER, ["--aies-info"], { cwd: repo, env, encoding: "utf8" });
    const keys = result.stdout.split("\n").filter(Boolean).map((line) => line.split("=")[0]);

    assert.deepEqual(keys.slice(0, 5), ["AIES_REPO", "AIES_HOME", "PI_CODING_AGENT_DIR", "AIES_PROJECT_ROOT", "tracker"]);
    assert.equal(keys.includes("pi_bin"), true);
    assert.equal(keys.includes("pi_version"), true);
  });
});
