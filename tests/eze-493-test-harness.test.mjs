/**
 * EZE-493: explicit test harness — temporary profile per execution and
 * nested sandbox-runtime compatibility.
 *
 * Pins:
 * 1. Nested detection triggers only on a nesting marker: `SANDBOX_RUNTIME=1`
 *    (stamped by @anthropic-ai/sandbox-runtime on its sandboxed children) or
 *    the explicit `AIES_TEST_NESTED_SANDBOX` option. A plain run keeps full
 *    coverage, so a real incapacity on the host can never turn into a pass.
 * 2. The harness runs every execution against a temporary profile: the ambient
 *    Pi/AIES pointers are stripped and the Pi pointers are pinned inside that
 *    temporary profile (undefined, Pi falls back to ~/.pi/agent), and the
 *    canonical launcher fallback resolves inside a redirected HOME: no run
 *    touches the real profile.
 * 3. Real failures keep propagating through the harness — including with the
 *    nested-sandbox option set. The option skips only the marked tests, and a
 *    skip is reported as skipped (`# skipped`), never recorded as a pass.
 *
 * Fixtures are created in temporary directories and the harness is invoked
 * with explicit file arguments: the full suite is never run here.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { isNestedSandboxActive, nestedSandboxSkip } from "./helpers/nested-sandbox.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const HARNESS = join(REPO, "scripts", "test-harness.sh");
const LAUNCHER = join(REPO, "bin", "aies");
const HELPER = join(REPO, "tests", "helpers", "nested-sandbox.mjs");
const REAL_CANONICAL = join(homedir(), ".local", "share", "aies");
const PI_PROFILE = join(homedir(), ".pi", "agent");

const tempRoots = [];

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "aies-eze493-"));
  tempRoots.push(root);
  return root;
}

after(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

function writeFixture(name, body) {
  const file = join(makeTempRoot(), name);
  writeFileSync(file, body);
  return file;
}

function harnessEnv(envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  // The outer `node --test` marks its children with NODE_TEST_CONTEXT; a
  // nested runner inheriting it reports failures through the child protocol
  // and exits 0, which would hide real failures from these checks.
  delete env.NODE_TEST_CONTEXT;
  return env;
}

function runHarness(args, envOverrides = {}) {
  return spawnSync("bash", [HARNESS, ...args], {
    env: harnessEnv(envOverrides),
    encoding: "utf8",
    cwd: REPO,
  });
}

function parseInfo(stdout) {
  const info = {};
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) info[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return info;
}

/** A test file that fails unless the harness sanitized the environment. */
const PROFILE_FIXTURE = `
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the harness provides a temporary profile and pins the ambient pointers", () => {
  const home = process.env.AIES_HOME;
  assert.ok(home, "the harness must export AIES_HOME");
  assert.ok(home.startsWith(tmpdir()), "AIES_HOME must live under the temporary directory: " + home);
  assert.notEqual(home, join(homedir(), ".local", "share", "aies"), "AIES_HOME must not be the real profile");
  assert.equal(
    process.env.PI_CODING_AGENT_DIR,
    join(home, "agent"),
    "PI_CODING_AGENT_DIR must be pinned inside the temporary AIES_HOME",
  );
  assert.equal(
    process.env.PI_CODING_AGENT_SESSION_DIR,
    join(home, "agent", "sessions"),
    "PI_CODING_AGENT_SESSION_DIR must be pinned inside the temporary AIES_HOME",
  );
  assert.equal(process.env.AIES_EPHEMERAL, undefined, "AIES_EPHEMERAL must be stripped");
});
`;

/**
 * Focused in-execution check: the Pi pointers must carry the exact controlled
 * values the harness pinned inside its temporary AIES_HOME (undefined would
 * send Pi to ~/.pi/agent, the real profile).
 */
const PI_POINTERS_FIXTURE = `
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("the harness pins the Pi pointers inside its temporary AIES_HOME", () => {
  const home = process.env.AIES_HOME;
  assert.ok(home && home.startsWith(tmpdir()), "AIES_HOME must be temporary: " + home);
  assert.notEqual(home, join(homedir(), ".local", "share", "aies"), "AIES_HOME must not be the real profile");

  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.equal(agentDir, join(home, "agent"), "PI_CODING_AGENT_DIR must be the temporary profile's agent dir");
  assert.ok(existsSync(agentDir), "the pinned agent dir must exist so Pi never creates one elsewhere");

  const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  assert.equal(
    sessionDir,
    join(home, "agent", "sessions"),
    "PI_CODING_AGENT_SESSION_DIR must be pinned under the same temporary agent dir",
  );
  assert.ok(existsSync(sessionDir), "the pinned session dir must exist so Pi never creates one elsewhere");
});
`;

/**
 * The inverse assertion: with hostile ambient pointers injected, every profile
 * path visible during execution must stay inside the temporary home and away
 * from the real Pi/AIES locations under the real home directory.
 */
const NO_AMBIENT_FIXTURE = `
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const REAL_LOCATIONS = [join(homedir(), ".pi"), join(homedir(), ".local", "share", "aies")];

test("no ambient real path is selected", () => {
  const home = process.env.AIES_HOME;
  assert.ok(home, "AIES_HOME must be defined");
  assert.ok(home.startsWith(tmpdir()), "AIES_HOME must be temporary: " + home);

  for (const name of ["AIES_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]) {
    const value = process.env[name];
    assert.ok(value, name + " must be defined");
    assert.ok(
      value === home || value.startsWith(home + "/"),
      name + " must live inside the temporary AIES_HOME: " + value,
    );
    for (const real of REAL_LOCATIONS) {
      assert.ok(
        value !== real && !value.startsWith(real + "/"),
        name + " must not resolve inside the ambient real profile " + real + ": " + value,
      );
    }
  }
  assert.equal(process.env.AIES_EPHEMERAL, undefined, "AIES_EPHEMERAL must be stripped");
});
`;

/** A test file with one unconditionally failing assertion. */
const FAILING_FIXTURE = `
import assert from "node:assert/strict";
import { test } from "node:test";

test("a real regression must fail the harness", () => {
  assert.equal("actual", "expected");
});
`;

/**
 * Two tests: one marked with the nested-sandbox skip whose body would fail if
 * it ever executed, and one unconditional regression. The marked one must be
 * skipped (not run, not passed) while the regression keeps failing.
 */
const MIXED_FIXTURE = `
import assert from "node:assert/strict";
import { test } from "node:test";
import { nestedSandboxSkip } from ${JSON.stringify(pathToFileURL(HELPER).href)};

test("marked os enforcement test", { skip: nestedSandboxSkip() }, () => {
  assert.fail("the marked test must not execute while its skip is active");
});

test("unmarked real regression", () => {
  assert.equal("actual", "expected");
});
`;

describe("EZE-493 nested-sandbox detection", () => {
  it("stays off without a nesting marker and honours the explicit option in both directions", () => {
    assert.equal(isNestedSandboxActive({}), false, "a plain run must keep full coverage");
    assert.equal(isNestedSandboxActive({ SANDBOX_RUNTIME: "1" }), true, "the runtime marker enables nesting mode");
    assert.equal(isNestedSandboxActive({ AIES_TEST_NESTED_SANDBOX: "1" }), true, "the explicit option enables it too");
    assert.equal(
      isNestedSandboxActive({ SANDBOX_RUNTIME: "1", AIES_TEST_NESTED_SANDBOX: "0" }),
      false,
      "AIES_TEST_NESTED_SANDBOX=0 forces the enforcement tests to run (and fail loudly under nesting)",
    );
  });

  it("returns a skip reason only while nesting is active", () => {
    assert.equal(nestedSandboxSkip({}), false, "without a marker there is nothing to skip");
    const reason = nestedSandboxSkip({ SANDBOX_RUNTIME: "1" });
    assert.equal(typeof reason, "string");
    assert.match(reason, /nested sandbox-runtime/);
    assert.match(reason, /EZE-493/);
  });
});

describe("EZE-493 harness: temporary profile per execution", () => {
  it("runs tests with a temporary AIES_HOME and the ambient pointers pinned to it", () => {
    const fixture = writeFixture("profile.test.mjs", PROFILE_FIXTURE);
    // Hostile ambient, exactly what a launched session or an outer sandbox
    // hands to the test process: the real AIES profile and a Pi profile.
    const result = runHarness([fixture], {
      AIES_HOME: REAL_CANONICAL,
      PI_CODING_AGENT_DIR: join(PI_PROFILE),
      PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
      AIES_EPHEMERAL: "1",
    });
    assert.equal(result.status, 0, `harness run failed:\n${result.stdout}\n${result.stderr}`);
  });

  it("proves the fixture is not vacuous: without the harness the ambient profile is used", () => {
    const fixture = writeFixture("profile.test.mjs", PROFILE_FIXTURE);
    const result = spawnSync("node", ["--test", fixture], {
      env: harnessEnv({
        AIES_HOME: REAL_CANONICAL,
        PI_CODING_AGENT_DIR: "/tmp/aies-eze493-nonexistent-pi",
        PI_CODING_AGENT_SESSION_DIR: "/tmp/aies-eze493-nonexistent-pi/sessions",
        AIES_EPHEMERAL: "1",
      }),
      encoding: "utf8",
      cwd: REPO,
    });
    assert.notEqual(result.status, 0, "plain node --test with ambient pointers must fail the fixture");
    assert.match(result.stdout, /# fail 1/);
  });

  it("resolves the canonical launcher fallback inside a redirected HOME, never the real profile", () => {
    const childHome = mkdtempSync(join(tmpdir(), "aies-eze493-canonical-"));
    try {
      const env = {
        ...process.env,
        HOME: childHome,
        PI_CODING_AGENT_DIR: PI_PROFILE,
        PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
      };
      delete env.AIES_HOME;

      const result = spawnSync(LAUNCHER, ["--aies-info"], { env, encoding: "utf8" });
      assert.equal(result.status, 0, `launcher failed:\n${result.stderr}`);

      const info = parseInfo(result.stdout);
      assert.equal(info.AIES_HOME, join(childHome, ".local", "share", "aies"));
      assert.equal(info.PI_CODING_AGENT_DIR, join(childHome, ".local", "share", "aies", "agent"));
      assert.notEqual(info.AIES_HOME, REAL_CANONICAL, "the canonical fallback must not resolve the real profile");
      assert.notEqual(info.PI_CODING_AGENT_DIR, PI_PROFILE, "hostile ambient Pi pointers must be overridden");
    } finally {
      rmSync(childHome, { recursive: true, force: true });
    }
  });
});

describe("EZE-493 harness: the Pi pointers never fall back to the real profile", () => {
  it("pins PI_CODING_AGENT_DIR and the session dir inside the temporary AIES_HOME during execution", () => {
    const fixture = writeFixture("pi-pointers.test.mjs", PI_POINTERS_FIXTURE);
    // Hostile ambient pointing at the real Pi profile: stripping alone would
    // let Pi resolve ~/.pi/agent (auth.json.lock), so the values must be
    // re-pinned to the harness's temporary profile before tests run.
    const result = runHarness([fixture], {
      AIES_HOME: REAL_CANONICAL,
      PI_CODING_AGENT_DIR: PI_PROFILE,
      PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
      AIES_EPHEMERAL: "1",
    });
    assert.equal(result.status, 0, `harness run failed:\n${result.stdout}\n${result.stderr}`);
  });

  it("selects no ambient real path: profile, agent dir and session dir stay in the temporary home", () => {
    const fixture = writeFixture("no-ambient.test.mjs", NO_AMBIENT_FIXTURE);
    const result = runHarness([fixture], {
      AIES_HOME: REAL_CANONICAL,
      PI_CODING_AGENT_DIR: PI_PROFILE,
      PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
      AIES_EPHEMERAL: "1",
    });
    assert.equal(result.status, 0, `harness run failed:\n${result.stdout}\n${result.stderr}`);
  });

  it("proves the no-ambient fixture is not vacuous: plain node --test keeps the ambient paths", () => {
    const fixture = writeFixture("no-ambient.test.mjs", NO_AMBIENT_FIXTURE);
    const result = spawnSync("node", ["--test", fixture], {
      env: harnessEnv({
        AIES_HOME: REAL_CANONICAL,
        PI_CODING_AGENT_DIR: PI_PROFILE,
        PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
        AIES_EPHEMERAL: "1",
      }),
      encoding: "utf8",
      cwd: REPO,
    });
    assert.notEqual(result.status, 0, "without the harness the ambient real paths must fail the fixture");
    assert.match(result.stdout, /# fail 1/);
  });
});

describe("EZE-493 harness: real failures keep propagating", () => {
  it("propagates a failing test as a non-zero exit", () => {
    const fixture = writeFixture("fail.test.mjs", FAILING_FIXTURE);
    const result = runHarness([fixture]);
    assert.notEqual(result.status, 0, "the harness must fail when a test fails");
    assert.match(result.stdout, /# fail 1/);
  });

  it("still propagates the failure with --nested-sandbox set", () => {
    const fixture = writeFixture("fail.test.mjs", FAILING_FIXTURE);
    const result = runHarness(["--nested-sandbox", fixture]);
    assert.notEqual(result.status, 0, "the nested-sandbox option must not swallow real failures");
    assert.match(result.stdout, /# fail 1/);
  });

  it("with nesting active, skips only the marked test and still fails on the real regression", () => {
    const fixture = writeFixture("mixed.test.mjs", MIXED_FIXTURE);
    const result = runHarness([fixture], { AIES_TEST_NESTED_SANDBOX: "1" });
    assert.notEqual(result.status, 0, "the unmarked regression must fail the run");
    assert.match(result.stdout, /# skipped 1/, "the marked test must be reported as skipped");
    assert.match(result.stdout, /# fail 1/, "only the real regression fails; the marked test did not execute");
  });

  it("without nesting, runs the marked test instead of skipping it", () => {
    const fixture = writeFixture("mixed.test.mjs", MIXED_FIXTURE);
    const result = runHarness([fixture], { AIES_TEST_NESTED_SANDBOX: "0" });
    assert.notEqual(result.status, 0, "the marked test runs and its body must fail, as does the regression");
    assert.match(result.stdout, /# skipped 0/, "nothing may be skipped without a nesting marker");
    assert.match(result.stdout, /# fail 2/, "both tests fail when neither is skipped");
  });
});

/** Run the canonical `npm test` command the way a developer or Verify runs it. */
function runNpmTest(args, envOverrides = {}) {
  return spawnSync("npm", ["test", "--", ...args], {
    env: harnessEnv(envOverrides),
    encoding: "utf8",
    cwd: REPO,
  });
}

describe("EZE-493 canonical gates run through the harness", () => {
  it("npm test is wired to the harness, not to a bare node --test", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
    assert.equal(
      pkg.scripts.test,
      "bash scripts/test-harness.sh",
      "npm test must create a temporary profile per execution (EZE-493)",
    );
  });

  it("npm run check:isolation runs its automated checks through the harness", () => {
    const script = readFileSync(join(REPO, "scripts", "check-isolation.sh"), "utf8");
    assert.match(
      script,
      /scripts\/test-harness\.sh/,
      "check-isolation.sh must route its automated checks through the harness (EZE-493)",
    );
    assert.doesNotMatch(
      script,
      /^\s*node --test\s*$/m,
      "check-isolation.sh must not run node --test outside the harness (EZE-493)",
    );
  });

  it("npm test gives the execution a temporary profile with the ambient pointers pinned to it", () => {
    const fixture = writeFixture("profile.test.mjs", PROFILE_FIXTURE);
    const result = runNpmTest([fixture], {
      AIES_HOME: REAL_CANONICAL,
      PI_CODING_AGENT_DIR: PI_PROFILE,
      PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
      AIES_EPHEMERAL: "1",
    });
    assert.equal(result.status, 0, `npm test failed:\n${result.stdout}\n${result.stderr}`);
  });

  it("npm test propagates a real regression as a non-zero exit", () => {
    const fixture = writeFixture("fail.test.mjs", FAILING_FIXTURE);
    const result = runNpmTest([fixture]);
    assert.notEqual(result.status, 0, "npm test must fail when a test fails");
    assert.match(result.stdout, /# fail 1/, "the TAP failure must reach npm's stdout unchanged");
  });
});

describe("EZE-493 AIES_TEST_REPO: the same command against another checkout", () => {
  it("runs node --test in the named checkout, isolated and with the same guarantees", () => {
    const base = makeTempRoot();
    writeFileSync(
      join(base, "base-only.test.mjs"),
      `
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("runs in the AIES_TEST_REPO checkout under a temporary profile", () => {
  // pwd -P resolves symlinks (/tmp -> /private/tmp on macOS): compare real paths.
  assert.equal(realpathSync(process.cwd()), realpathSync(${JSON.stringify(base)}), "the harness must cd into AIES_TEST_REPO");
  const home = process.env.AIES_HOME;
  assert.ok(home && home.startsWith(tmpdir()), "AIES_HOME must be temporary: " + home);
  assert.equal(
    process.env.PI_CODING_AGENT_DIR,
    join(home, "agent"),
    "PI_CODING_AGENT_DIR must be pinned inside the temporary AIES_HOME",
  );
});
`,
    );
    const result = spawnSync("bash", [HARNESS, "base-only.test.mjs"], {
      env: harnessEnv({ AIES_TEST_REPO: base }),
      encoding: "utf8",
      cwd: REPO,
    });
    assert.equal(
      result.status,
      0,
      `the base-ref command must run the named checkout:\n${result.stdout}\n${result.stderr}`,
    );
    // Not vacuous: without honoring AIES_TEST_REPO the file would not be found in this repo.
    assert.doesNotMatch(result.stdout, /Could not find/u);
  });

  it("fails loudly when AIES_TEST_REPO is not a directory", () => {
    const missing = join(REPO, "no-such-checkout-eze493");
    const result = spawnSync("bash", [HARNESS], {
      env: harnessEnv({ AIES_TEST_REPO: missing }),
      encoding: "utf8",
      cwd: REPO,
    });
    assert.notEqual(result.status, 0, "a wrong AIES_TEST_REPO must fail, never fall back silently");
    assert.match(result.stderr, /AIES_TEST_REPO/u, "the error must name the offending variable");
  });
});
