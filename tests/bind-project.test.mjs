/**
 * D40: `scripts/bind-project.mjs`, the explicit repository <-> tracker project binding.
 *
 * Every run passes its own temporary `--aies-home`, so no test touches the real profile.
 * Fixtures are real temporary git repositories, so the root the script stores is the root
 * git reports. The script is driven as a child process, the way a user runs `npm run bind`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/bind-project.mjs", import.meta.url));
const GIT_AVAILABLE = spawnSync("git", ["--version"]).status === 0;

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

/** Runs the script with a clean environment and an explicit temporary profile. */
function bind(args, { cwd, home, env = {} } = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.AIES_EPHEMERAL;
  delete childEnv.AIES_HOME;
  const result = spawnSync(process.execPath, [SCRIPT, ...args, "--aies-home", home], {
    cwd,
    env: childEnv,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function readConfig(configPath) {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

function backupsOf(agentDir) {
  return readdirSync(agentDir).filter((entry) => entry.startsWith("aies.json.bak-"));
}

describe("bind-project: binding a repository to a project", { skip: !GIT_AVAILABLE && "git is not available" }, () => {
  let scratch;
  let home;
  let agentDir;
  let configPath;
  let repoA;
  let repoB;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "aies-bind-test-")));
    home = join(scratch, "home");
    agentDir = join(home, "agent");
    configPath = join(agentDir, "aies.json");
    mkdirSync(agentDir, { recursive: true });
    repoA = makeRepo(scratch, "alpha-app");
    repoB = makeRepo(scratch, "beta-site");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("binds the repository root and stores the project identifier in uppercase", () => {
    const result = bind(["aies", repoA], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readConfig(configPath), { repos: { AIES: repoA } });
    assert.match(result.stdout, /Vinculado AIES/u);
  });

  it("defaults the repository to the current directory and stores its git toplevel, not the subdirectory", () => {
    const result = bind(["ALPHA"], { cwd: join(repoA, "src"), home });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readConfig(configPath).repos.ALPHA, repoA);
  });

  it("refuses a directory outside any git work tree and writes nothing", () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);

    const result = bind(["AIES", plain], { cwd: scratch, home });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no está dentro de un repo git/u);
    assert.equal(readdirSync(agentDir).includes("aies.json"), false);
  });

  it("refuses a profile that was never created and tells the user to run aies once", () => {
    const freshHome = join(scratch, "never-run");

    const result = bind(["AIES", repoA], { cwd: scratch, home: freshHome });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Ejecuta `aies` una vez/u);
    assert.equal(existsSync(join(freshHome, "agent")), false, "the script must not create the profile");
  });

  it("rejects an identifier outside the allowed shape with a usage error", () => {
    for (const identifier of ["9ABC", "A-B", "", "with space"]) {
      const result = bind([identifier, repoA], { cwd: scratch, home });
      assert.equal(result.status, 2, `identifier ${JSON.stringify(identifier)} must be refused`);
    }
    assert.equal(readdirSync(agentDir).includes("aies.json"), false);
  });

  it("refuses a path already bound to another project unless --force replaces it", () => {
    assert.equal(bind(["ALPHA", repoA], { cwd: scratch, home }).status, 0);
    const before = readConfig(configPath);

    const refused = bind(["BETA", repoA], { cwd: scratch, home });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /ya está vinculada a ALPHA/u);
    assert.match(refused.stderr, /--force/u);
    assert.deepEqual(readConfig(configPath), before);

    const forced = bind(["BETA", repoA, "--force"], { cwd: scratch, home });
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stdout, /sustituido: ALPHA/u);
    assert.deepEqual(readConfig(configPath), { repos: { BETA: repoA } });
  });

  it("refuses a project already bound to another path unless --force replaces it", () => {
    assert.equal(bind(["AIES", repoA], { cwd: scratch, home }).status, 0);

    const refused = bind(["AIES", repoB], { cwd: scratch, home });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /AIES ya está vinculado a/u);
    assert.equal(readConfig(configPath).repos.AIES, repoA);

    const forced = bind(["AIES", repoB, "--force"], { cwd: scratch, home });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(readConfig(configPath).repos.AIES, repoB);
  });

  it("treats re-binding the same pair as a no-op that writes no backup", () => {
    assert.equal(bind(["AIES", repoA], { cwd: scratch, home }).status, 0);

    const again = bind(["AIES", repoA], { cwd: scratch, home });

    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /Nada que cambiar/u);
    assert.deepEqual(backupsOf(agentDir), []);
  });

  it("preserves every unrelated key and writes two-space JSON", () => {
    writeFileSync(
      configPath,
      `${JSON.stringify({ model: "x-model", nested: { list: [1, 2] }, repos: { BETA: "/elsewhere/beta" } }, null, 2)}\n`,
    );

    const result = bind(["AIES", repoA], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(configPath, "utf8");
    assert.equal(text.startsWith('{\n  "model": "x-model",\n  "nested": {\n    "list": [\n'), true, text);
    assert.equal(text.endsWith("}\n"), true);
    assert.deepEqual(readConfig(configPath), {
      model: "x-model",
      nested: { list: [1, 2] },
      repos: { BETA: "/elsewhere/beta", AIES: repoA },
    });
  });

  it("creates a timestamped backup holding the previous content before it writes", () => {
    const previous = `${JSON.stringify({ repos: { BETA: "/elsewhere/beta" } }, null, 2)}\n`;
    writeFileSync(configPath, previous);

    const result = bind(["AIES", repoA], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    const backups = backupsOf(agentDir);
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^aies\.json\.bak-\d{4}-\d{2}-\d{2}T/u);
    assert.equal(readFileSync(join(agentDir, backups[0]), "utf8"), previous);
  });

  it("keeps the file mode of an existing aies.json", { skip: process.platform === "win32" }, () => {
    writeFileSync(configPath, "{}\n");
    chmodSync(configPath, 0o600);

    const result = bind(["AIES", repoA], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
  });

  it("refuses an unparseable aies.json and leaves it byte-for-byte untouched", () => {
    const broken = "{ not json";
    writeFileSync(configPath, broken);

    const result = bind(["AIES", repoA], { cwd: scratch, home });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no es JSON válido/u);
    assert.equal(readFileSync(configPath, "utf8"), broken);
    assert.deepEqual(backupsOf(agentDir), []);
  });
});

describe("bind-project: the tracker key", { skip: !GIT_AVAILABLE && "git is not available" }, () => {
  let scratch;
  let home;
  let agentDir;
  let configPath;
  let repo;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "aies-bind-tracker-")));
    home = join(scratch, "home");
    agentDir = join(home, "agent");
    configPath = join(agentDir, "aies.json");
    mkdirSync(agentDir, { recursive: true });
    repo = makeRepo(scratch, "alpha-app");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("--tracker plane sets the key when the profile has none", () => {
    const result = bind(["AIES", repo, "--tracker", "plane"], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readConfig(configPath), { repos: { AIES: repo }, tracker: "plane" });
  });

  it("--tracker plane keeps an existing plane and only the repository binding changes", () => {
    writeFileSync(configPath, `${JSON.stringify({ tracker: "plane" }, null, 2)}\n`);

    const result = bind(["AIES", repo, "--tracker", "plane"], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readConfig(configPath), { tracker: "plane", repos: { AIES: repo } });
    assert.equal(backupsOf(agentDir).length, 1);
  });

  it("--tracker plane on an already plane profile with the same binding changes nothing", () => {
    writeFileSync(configPath, `${JSON.stringify({ tracker: "plane", repos: { AIES: repo } }, null, 2)}\n`);

    const result = bind(["AIES", repo, "--tracker", "plane"], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nada que cambiar/u);
    assert.equal(backupsOf(agentDir).length, 0);
  });

  it("--tracker plane refuses to switch an explicit linear without --force", () => {
    const original = `${JSON.stringify({ tracker: "linear" }, null, 2)}\n`;
    writeFileSync(configPath, original);

    const refused = bind(["AIES", repo, "--tracker", "plane"], { cwd: scratch, home });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /sin --force/u);
    assert.equal(readFileSync(configPath, "utf8"), original);
    assert.deepEqual(backupsOf(agentDir), []);

    const forced = bind(["AIES", repo, "--tracker", "plane", "--force"], { cwd: scratch, home });
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(readConfig(configPath).tracker, "plane");
  });

  it("accepts only plane as a --tracker value", () => {
    const result = bind(["AIES", repo, "--tracker", "jira"], { cwd: scratch, home });

    assert.equal(result.status, 2);
    assert.equal(readdirSync(agentDir).includes("aies.json"), false);
  });
});

describe("bind-project: --list and --unbind", { skip: !GIT_AVAILABLE && "git is not available" }, () => {
  let scratch;
  let home;
  let agentDir;
  let configPath;
  let repo;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "aies-bind-list-")));
    home = join(scratch, "home");
    agentDir = join(home, "agent");
    configPath = join(agentDir, "aies.json");
    mkdirSync(agentDir, { recursive: true });
    repo = makeRepo(scratch, "alpha-app");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("--list prints the tracker and only the repository paths", () => {
    writeFileSync(
      configPath,
      `${JSON.stringify({ tracker: "plane", model: "secret-looking-value", repos: { AIES: repo } }, null, 2)}\n`,
    );

    const result = bind(["--list"], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `tracker=plane\nAIES=${repo}\n`);
  });

  it("--list reports the linear default when the profile names no tracker", () => {
    const result = bind(["--list"], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "tracker=linear\n");
  });

  it("--unbind removes the binding, keeps other keys and writes a backup", () => {
    writeFileSync(configPath, `${JSON.stringify({ tracker: "plane", repos: { AIES: repo } }, null, 2)}\n`);

    const result = bind(["--unbind", "aies"], { cwd: scratch, home });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readConfig(configPath), { tracker: "plane", repos: {} });
    assert.equal(backupsOf(agentDir).length, 1);
  });

  it("--unbind refuses a project with no binding", () => {
    writeFileSync(configPath, `${JSON.stringify({ repos: { BETA: "/elsewhere" } }, null, 2)}\n`);

    const result = bind(["--unbind", "AIES"], { cwd: scratch, home });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /no tiene vínculo/u);
    assert.deepEqual(readConfig(configPath), { repos: { BETA: "/elsewhere" } });
  });
});
