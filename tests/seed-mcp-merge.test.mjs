/**
 * Incremental, non-destructive MCP reconciliation of the isolated AIES profile
 * (scripts/seed-profile-config.mjs).
 *
 * Every case runs the seed script the way the launcher does, against temporary
 * profile directories only. No network, no credentials, and nothing under the
 * real profile or the ambient Pi profile. The credential-looking values in the
 * fixtures are fakes that must never reach stdout or stderr.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SEED = join(REPO, "scripts", "seed-profile-config.mjs");
const BOOTSTRAP = join(REPO, "scripts", "bootstrap-profile.sh");
const TEMPLATE = join(REPO, "profile");

const TEMPLATE_ADAPTER = JSON.parse(readFileSync(join(TEMPLATE, "mcp-adapter.json"), "utf8"));
const TEMPLATE_LEGACY = JSON.parse(readFileSync(join(TEMPLATE, "mcp.json"), "utf8"));
const TEMPLATE_SETTINGS = readFileSync(join(TEMPLATE, "settings.json"), "utf8");

// Fake credentials: recognisable, never valid, and forbidden in any output.
const FAKE_HEADER_TOKEN = "AIES-FAKE-HEADER-TOKEN-7f3a9c";
const FAKE_URL_TOKEN = "AIES-FAKE-URL-TOKEN-51b2d8";
const FAKE_HOST = "custom.example.invalid";

const LINEAR = { url: "https://mcp.linear.app/mcp", auth: "oauth", lifecycle: "lazy" };
const CUSTOM = {
  url: `https://${FAKE_HOST}/mcp`,
  headers: { "X-Api-Key": FAKE_HEADER_TOKEN },
  bearerTokenEnv: "AIES_FAKE_BEARER_ENV",
};
const BACKUP_NAME = /\.bak-\d{8}T\d{6}(-\d+)?$/;

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "aies-seed-merge-"));
  roots.push(root);
  return root;
}

/** Agent dir under a temporary root. settings.json is pre-seeded from the template unless `settings` is false. */
function createProfile({ files = {}, settings = true } = {}) {
  const agentDir = join(tempRoot(), "agent");
  mkdirSync(agentDir, { recursive: true });
  if (settings) writeFileSync(join(agentDir, "settings.json"), TEMPLATE_SETTINGS);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(agentDir, name), content);
  return agentDir;
}

function adapterPackage(agentDir, version) {
  const packageDir = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version }));
}

function seed(agentDir) {
  return spawnSync(process.execPath, [SEED, TEMPLATE, agentDir], { encoding: "utf8" });
}

function asJson(value, indent = 2) {
  return `${JSON.stringify(value, null, indent)}\n`;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Backups of `name` next to it: `<name>.bak-YYYYMMDDTHHMMSS[-n]`. */
function backupsOf(dir, name) {
  return readdirSync(dir).filter((entry) => entry.startsWith(`${name}.bak-`) && BACKUP_NAME.test(entry));
}

/** Names, modes and bytes of every entry, so "untouched" means byte-for-byte and mode-for-mode. */
function snapshot(dir) {
  return readdirSync(dir).sort().map((name) => {
    const path = join(dir, name);
    const stat = lstatSync(path);
    let content;
    if (stat.isSymbolicLink()) content = `link:${readlinkSync(path)}`;
    else if (stat.isDirectory()) content = "directory";
    else content = readFileSync(path).toString("base64");
    return [name, stat.mode & 0o777, content];
  });
}

const conflictLines = (result) => result.stderr.split("\n").filter((line) => line.includes("differs from the AIES template"));

function assertNoSecrets(result, secrets) {
  for (const secret of secrets) {
    assert.ok(!result.stdout.includes(secret), "stdout must not print a credential-looking value");
    assert.ok(!result.stderr.includes(secret), "stderr must not print a credential-looking value");
  }
}

describe("seed-profile-config: incremental, non-destructive MCP reconciliation", () => {
  it("(a) seeds linear and plane into a fresh profile, as before", () => {
    const agentDir = createProfile({ settings: false });
    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readJsonFile(join(agentDir, "mcp-adapter.json")).mcpServers, TEMPLATE_ADAPTER.mcpServers);
    assert.deepEqual(readdirSync(agentDir).sort(), ["mcp-adapter.json", "settings.json"]);
    assert.deepEqual(backupsOf(agentDir, "mcp-adapter.json"), []);
  });

  it("(b) adds plane to a profile that only declares linear, backs the file up and keeps linear byte for byte", () => {
    const original = `${JSON.stringify({ mcpServers: { linear: LINEAR } }, null, 4)}\n`;
    const agentDir = createProfile({ files: { "mcp-adapter.json": original } });
    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    const current = readFileSync(join(agentDir, "mcp-adapter.json"), "utf8");
    const parsed = JSON.parse(current);
    assert.deepEqual(Object.keys(parsed.mcpServers), ["linear", "plane"]);
    assert.equal(JSON.stringify(parsed.mcpServers.linear), JSON.stringify(LINEAR), "linear is kept byte for byte");
    assert.deepEqual(parsed.mcpServers.plane, TEMPLATE_ADAPTER.mcpServers.plane);
    assert.equal(parsed.settings, undefined, "no settings key is added to an existing profile");
    assert.match(current, /\n {4}"mcpServers"/, "the user's indentation survives the rewrite");

    const backups = backupsOf(agentDir, "mcp-adapter.json");
    assert.equal(backups.length, 1, "exactly one backup before the change");
    assert.equal(readFileSync(join(agentDir, backups[0]), "utf8"), original);
    assert.deepEqual(conflictLines(result), []);
  });

  it("(c) keeps a custom server exactly as written and adds the missing template servers", () => {
    const original = asJson({ mcpServers: { linear: LINEAR, miservidor: CUSTOM } });
    const agentDir = createProfile({ files: { "mcp-adapter.json": original } });
    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
    assert.deepEqual(Object.keys(parsed.mcpServers), ["linear", "miservidor", "plane"]);
    assert.equal(JSON.stringify(parsed.mcpServers.miservidor), JSON.stringify(CUSTOM), "custom server is kept as written");
    assert.equal(JSON.stringify(parsed.mcpServers.linear), JSON.stringify(LINEAR));
    assert.equal(backupsOf(agentDir, "mcp-adapter.json").length, 1);
    assert.deepEqual(conflictLines(result), []);
  });

  describe("declared entries that differ from the template", () => {
    const drifted = { url: `https://${FAKE_HOST}/plane?token=${FAKE_URL_TOKEN}`, auth: "oauth", lifecycle: "lazy" };
    const original = asJson({ mcpServers: { plane: drifted } });

    it("(d) never overwrites the entry, reports name and keys only, and still adds the missing servers", () => {
      const agentDir = createProfile({ files: { "mcp-adapter.json": original } });
      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
      assert.deepEqual(parsed.mcpServers.plane, drifted, "a differing entry is never replaced");
      assert.deepEqual(parsed.mcpServers.linear, TEMPLATE_ADAPTER.mcpServers.linear, "the missing template server is added");

      const conflicts = conflictLines(result);
      assert.equal(conflicts.length, 1, result.stderr);
      assert.match(conflicts[0], /MCP server "plane"/);
      assert.match(conflicts[0], /\(keys: url\)/);
      assertNoSecrets(result, [FAKE_URL_TOKEN, FAKE_HOST]);
    });

    it("(e) a second run changes nothing: same bytes, no new backup, no new conflict", () => {
      const agentDir = createProfile({ files: { "mcp-adapter.json": original } });
      const first = seed(agentDir);
      assert.equal(first.status, 0, first.stderr);
      assert.ok(readJsonFile(join(agentDir, "mcp-adapter.json")).mcpServers.linear, "the first run adds linear");
      const afterFirst = snapshot(agentDir);

      const second = seed(agentDir);
      assert.equal(second.status, 0, second.stderr);
      assert.deepEqual(snapshot(agentDir), afterFirst, "second run leaves every file as the first run left it");
      assert.equal(backupsOf(agentDir, "mcp-adapter.json").length, 1, "no second backup");
      assert.deepEqual(conflictLines(second), conflictLines(first), "no conflict that the first run did not report");
      assert.doesNotMatch(second.stdout, /reconciled at|profile declares/);
    });
  });

  describe("corrupt, empty or malformed profile config fails safely", () => {
    const corrupt = {
      "invalid JSON (token inside the broken document)": `{"mcpServers": {"linear": {"headers": {"Authorization": "Bearer ${FAKE_HEADER_TOKEN}"}}`,
      "empty file": "",
      "whitespace-only file": " \n\t\n",
      "mcpServers is an array": `{"mcpServers": ["${FAKE_HEADER_TOKEN}"]}`,
      "mcpServers is null": '{"mcpServers": null}',
      "mcpServers is a string": `{"mcpServers": "${FAKE_HEADER_TOKEN}"}`,
      "top-level value is an array": "[]",
      "top-level value is null": "null",
    };

    for (const [label, content] of Object.entries(corrupt)) {
      it(`(f) leaves the directory untouched with ${label} and exits 1 without a backup`, () => {
        const agentDir = createProfile({ files: { "mcp-adapter.json": content } });
        const before = snapshot(agentDir);

        const result = seed(agentDir);

        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(snapshot(agentDir), before, "file, mode and directory listing are unchanged");
        assert.deepEqual(backupsOf(agentDir, "mcp-adapter.json"), []);
        assert.match(result.stderr, /aies: .*mcp-adapter\.json.*leaving it untouched/);
        assertNoSecrets(result, [FAKE_HEADER_TOKEN]);
      });
    }

    it("(f) keeps the launcher going: bootstrap continues with the existing profile", () => {
      const home = tempRoot();
      const aiesHome = join(home, "aies-home");
      const agentDir = join(aiesHome, "agent");
      mkdirSync(agentDir, { recursive: true });
      const corruptContent = '{"mcpServers": ';
      writeFileSync(join(agentDir, "mcp-adapter.json"), corruptContent);

      const result = spawnSync("bash", [BOOTSTRAP, "--aies-home", aiesHome], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /continuing with the existing profile/);
      assert.equal(readFileSync(join(agentDir, "mcp-adapter.json"), "utf8"), corruptContent);
      assert.deepEqual(backupsOf(agentDir, "mcp-adapter.json"), []);
    });
  });

  describe("format variants: v2 (mcp.json) and legacy migration", () => {
    it("(g) v2 adapter: a missing mcp.json is seeded from the v2 template", () => {
      const agentDir = createProfile();
      adapterPackage(agentDir, "2.9.0");
      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readJsonFile(join(agentDir, "mcp.json")), TEMPLATE_LEGACY);
      assert.ok(!readdirSync(agentDir).includes("mcp-adapter.json"));
    });

    it("(g) v2 adapter: an existing mcp.json gets missing servers only, its settings untouched", () => {
      const original = asJson({ mcpServers: { linear: LINEAR, miservidor: CUSTOM }, settings: { scriptMode: true } });
      const agentDir = createProfile({ files: { "mcp.json": original } });
      adapterPackage(agentDir, "2.9.0");
      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      const parsed = readJsonFile(join(agentDir, "mcp.json"));
      assert.deepEqual(Object.keys(parsed.mcpServers), ["linear", "miservidor", "plane"]);
      assert.equal(JSON.stringify(parsed.mcpServers.miservidor), JSON.stringify(CUSTOM));
      assert.deepEqual(parsed.settings, { scriptMode: true }, "no settings key is added");
      assert.ok(!readdirSync(agentDir).includes("mcp-adapter.json"), "v2 never creates the v3 file");
      const backups = backupsOf(agentDir, "mcp.json");
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(join(agentDir, backups[0]), "utf8"), original);
    });

    it("(g) legacy mcp.json migrates into a missing mcp-adapter.json, and the legacy file is backed up before removal", () => {
      const legacy = asJson({ mcpServers: { linear: LINEAR, miservidor: CUSTOM } });
      const agentDir = createProfile({ files: { "mcp.json": legacy } });
      adapterPackage(agentDir, "3.2.0");
      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      assert.ok(!readdirSync(agentDir).includes("mcp.json"), "legacy file is removed after migration");
      const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
      assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["linear", "miservidor", "plane"]);
      assert.equal(JSON.stringify(parsed.mcpServers.miservidor), JSON.stringify(CUSTOM));
      const backups = backupsOf(agentDir, "mcp.json");
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(join(agentDir, backups[0]), "utf8"), legacy);
    });

    it("(g) legacy migration into an existing mcp-adapter.json backs up the destination before it changes", () => {
      const destination = asJson({ mcpServers: { linear: { url: `https://${FAKE_HOST}/linear`, auth: "oauth" } } });
      const legacy = asJson({ mcpServers: { miservidor: CUSTOM } });
      const agentDir = createProfile({ files: { "mcp-adapter.json": destination, "mcp.json": legacy } });
      adapterPackage(agentDir, "3.2.0");
      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      assert.ok(!readdirSync(agentDir).includes("mcp.json"));
      const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
      assert.equal(parsed.mcpServers.linear.url, `https://${FAKE_HOST}/linear`, "destination value wins");
      assert.deepEqual(parsed.mcpServers.plane, TEMPLATE_ADAPTER.mcpServers.plane);
      assert.equal(JSON.stringify(parsed.mcpServers.miservidor), JSON.stringify(CUSTOM));

      const destinationBackups = backupsOf(agentDir, "mcp-adapter.json");
      assert.equal(destinationBackups.length, 1);
      assert.equal(readFileSync(join(agentDir, destinationBackups[0]), "utf8"), destination);
      const legacyBackups = backupsOf(agentDir, "mcp.json");
      assert.equal(legacyBackups.length, 1);
      assert.equal(readFileSync(join(agentDir, legacyBackups[0]), "utf8"), legacy);
    });
  });

  describe("file permissions", () => {
    const original = asJson({ mcpServers: { linear: LINEAR } });

    it("(h) keeps the file's permissions, and the backup carries the same permissions", () => {
      const agentDir = createProfile({ files: { "mcp-adapter.json": original } });
      chmodSync(join(agentDir, "mcp-adapter.json"), 0o640);
      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      assert.equal(statSync(join(agentDir, "mcp-adapter.json")).mode & 0o777, 0o640);
      const [backup] = backupsOf(agentDir, "mcp-adapter.json");
      assert.equal(statSync(join(agentDir, backup)).mode & 0o777, 0o640);
    });

    it("(h) refuses a read-only file: nothing is written, no backup, exit 1", { skip: process.getuid?.() === 0 && "root ignores file modes" }, () => {
      const agentDir = createProfile({ files: { "mcp-adapter.json": original } });
      chmodSync(join(agentDir, "mcp-adapter.json"), 0o444);
      const before = snapshot(agentDir);

      const result = seed(agentDir);

      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(snapshot(agentDir), before);
      assert.match(result.stderr, /not writable/);
    });
  });

  it("(i) prints no credential-looking value, even when it reports a conflict next to a custom server", () => {
    const drifted = { url: `https://${FAKE_HOST}/plane?token=${FAKE_URL_TOKEN}`, auth: "oauth", lifecycle: "lazy" };
    const agentDir = createProfile({
      files: { "mcp-adapter.json": asJson({ mcpServers: { miservidor: CUSTOM, plane: drifted } }) },
    });
    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assertNoSecrets(result, [FAKE_HEADER_TOKEN, FAKE_URL_TOKEN, FAKE_HOST]);
  });

  it("(j) reads a UTF-8 byte order mark and writes valid JSON back", () => {
    const agentDir = createProfile({ files: { "mcp-adapter.json": `﻿${asJson({ mcpServers: { linear: LINEAR } })}` } });
    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
    assert.deepEqual(Object.keys(parsed.mcpServers), ["linear", "plane"]);
  });

  it("(k) follows a symlinked profile file: the link survives and the real file gets the change and its backup", () => {
    const agentDir = createProfile();
    const dotfiles = join(tempRoot(), "dotfiles");
    mkdirSync(dotfiles);
    const realFile = join(dotfiles, "mcp-adapter.json");
    writeFileSync(realFile, asJson({ mcpServers: { linear: LINEAR } }));
    symlinkSync(realFile, join(agentDir, "mcp-adapter.json"));

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(lstatSync(join(agentDir, "mcp-adapter.json")).isSymbolicLink(), "the link is not replaced");
    assert.deepEqual(Object.keys(readJsonFile(realFile).mcpServers), ["linear", "plane"]);
    assert.equal(backupsOf(dotfiles, "mcp-adapter.json").length, 1, "the backup sits beside the real file");
  });

  it("(l) a complete profile is not rewritten, even when its key order and indentation differ from the template", () => {
    const complete = `${JSON.stringify({
      mcpServers: {
        plane: { lifecycle: "lazy", auth: "oauth", url: TEMPLATE_ADAPTER.mcpServers.plane.url },
        linear: { lifecycle: "lazy", auth: "oauth", url: TEMPLATE_ADAPTER.mcpServers.linear.url },
      },
    }, null, 4)}\n`;
    const agentDir = createProfile({ files: { "mcp-adapter.json": complete } });
    const before = snapshot(agentDir);

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(agentDir), before, "no write and no backup");
    assert.deepEqual(conflictLines(result), [], "reordered keys are not a difference");
  });
});

describe("seed-profile-config: persistent exclusion (aies.json mcpExcluded)", () => {
  const PLANE_CUSTOM = { url: `https://${FAKE_HOST}/plane`, auth: "oauth" };
  const linearOnly = asJson({ mcpServers: { linear: LINEAR } });
  /** aies.json as the other extensions write it: a tracker key next to the exclusion list. */
  const aiesConfig = (mcpExcluded) => asJson({ tracker: "plane", mcpExcluded });

  it("(m) an excluded server is not added to an existing profile: nothing is written and no backup is made", () => {
    const agentDir = createProfile({ files: { "mcp-adapter.json": linearOnly, "aies.json": aiesConfig(["plane"]) } });
    const before = snapshot(agentDir);

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(agentDir), before, "no plane, no backup; linear and aies.json are byte for byte the same");
    assert.equal(result.stdout, "", "nothing was written, so nothing is reported on stdout");
    assert.match(result.stderr, /excluded.*plane|plane.*excluded/);
    assert.deepEqual(backupsOf(agentDir, "mcp-adapter.json"), []);
  });

  it("(n) adds the other missing servers, never writes aies.json, and a second run changes nothing", () => {
    const original = asJson({ mcpServers: { miservidor: CUSTOM } });
    const config = aiesConfig(["plane"]);
    const agentDir = createProfile({ files: { "mcp-adapter.json": original, "aies.json": config } });

    const first = seed(agentDir);

    assert.equal(first.status, 0, first.stderr);
    const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
    assert.deepEqual(Object.keys(parsed.mcpServers), ["miservidor", "linear"]);
    assert.deepEqual(parsed.mcpServers.linear, TEMPLATE_ADAPTER.mcpServers.linear);
    assert.equal(backupsOf(agentDir, "mcp-adapter.json").length, 1);
    assert.deepEqual(backupsOf(agentDir, "aies.json"), []);
    assert.equal(readFileSync(join(agentDir, "aies.json"), "utf8"), config, "aies.json is only read");
    const afterFirst = snapshot(agentDir);

    const second = seed(agentDir);

    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(snapshot(agentDir), afterFirst, "second run leaves every file as the first run left it");
    assert.equal(backupsOf(agentDir, "mcp-adapter.json").length, 1, "no second backup");
  });

  it("(o) excluding both template servers changes nothing, whatever the profile holds", () => {
    const original = asJson({ mcpServers: { miservidor: CUSTOM } });
    const agentDir = createProfile({ files: { "mcp-adapter.json": original, "aies.json": aiesConfig(["linear", "plane"]) } });
    const before = snapshot(agentDir);

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(agentDir), before, "no write and no backup");
  });

  it("(p) a new profile honours the exclusion: only the other template servers are seeded", () => {
    const config = aiesConfig(["plane"]);
    const agentDir = createProfile({ files: { "aies.json": config } });

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readJsonFile(join(agentDir, "mcp-adapter.json")).mcpServers, { linear: TEMPLATE_ADAPTER.mcpServers.linear });
    assert.deepEqual(backupsOf(agentDir, "mcp-adapter.json"), []);
    assert.equal(readFileSync(join(agentDir, "aies.json"), "utf8"), config);
  });

  it("(p) a new v2 profile honours the exclusion in mcp.json", () => {
    const agentDir = createProfile({ files: { "aies.json": aiesConfig(["plane"]) } });
    adapterPackage(agentDir, "2.9.0");

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readJsonFile(join(agentDir, "mcp.json")).mcpServers, { linear: TEMPLATE_LEGACY.mcpServers.linear });
    assert.ok(!readdirSync(agentDir).includes("mcp-adapter.json"), "v2 never creates the v3 file");
  });

  it("(p) without aies.json nothing is excluded: a new profile gets both template servers", () => {
    const agentDir = createProfile();

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readJsonFile(join(agentDir, "mcp-adapter.json")).mcpServers, TEMPLATE_ADAPTER.mcpServers);
  });

  it("(q) an excluded name that the template does not declare is ignored, and matching is exact and case-sensitive", () => {
    const agentDir = createProfile({ files: { "aies.json": aiesConfig(["ghost", "PLANE"]) } });

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(readJsonFile(join(agentDir, "mcp-adapter.json")).mcpServers), ["linear", "plane"]);
    assert.doesNotMatch(result.stderr, /ghost|PLANE/);
  });

  it("(r) an excluded server the profile already declares is kept exactly as written and never removed", () => {
    const agentDir = createProfile({
      files: { "mcp-adapter.json": asJson({ mcpServers: { plane: PLANE_CUSTOM } }), "aies.json": aiesConfig(["plane"]) },
    });

    const result = seed(agentDir);

    assert.equal(result.status, 0, result.stderr);
    const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
    assert.equal(JSON.stringify(parsed.mcpServers.plane), JSON.stringify(PLANE_CUSTOM), "the excluded entry is byte for byte the same");
    assert.deepEqual(parsed.mcpServers.linear, TEMPLATE_ADAPTER.mcpServers.linear, "the other template server is still added");
  });

  describe("an unreadable or malformed aies.json fails safe", () => {
    const malformed = {
      "invalid JSON (token inside the broken document)": `{"mcpExcluded": ["plane"], "headers": "${FAKE_HEADER_TOKEN}"`,
      "empty file": "",
      "whitespace-only file": " \n\t\n",
      "top-level value is an array": '["plane"]',
      "top-level value is null": "null",
      "mcpExcluded is a string": asJson({ mcpExcluded: "plane" }),
      "mcpExcluded is null": asJson({ mcpExcluded: null }),
      "mcpExcluded is an object": asJson({ mcpExcluded: { plane: true } }),
      "mcpExcluded holds a non-string": asJson({ mcpExcluded: ["plane", 7] }),
    };

    for (const [label, content] of Object.entries(malformed)) {
      it(`(s) with ${label}: adds no server, writes nothing, makes no backup and exits 1`, () => {
        const agentDir = createProfile({ files: { "mcp-adapter.json": linearOnly, "aies.json": content } });
        const before = snapshot(agentDir);

        const result = seed(agentDir);

        assert.equal(result.status, 1, result.stderr);
        assert.deepEqual(snapshot(agentDir), before, "file, mode and listing unchanged");
        assert.deepEqual(backupsOf(agentDir, "mcp-adapter.json"), []);
        assert.match(result.stderr, /aies\.json/);
        assert.doesNotMatch(result.stderr, /Unexpected|at position|SyntaxError/, "parser text is not quoted");
        assertNoSecrets(result, [FAKE_HEADER_TOKEN]);
      });
    }

    it("(s) on a new profile, an unreadable aies.json creates no MCP config at all", () => {
      const agentDir = createProfile({ files: { "aies.json": "[]" } });

      const result = seed(agentDir);

      assert.equal(result.status, 1, result.stderr);
      assert.ok(!readdirSync(agentDir).includes("mcp-adapter.json"));
      assert.ok(!readdirSync(agentDir).includes("mcp.json"));
    });

    it("(s) an unreadable aies.json also blocks the legacy migration, which keeps mcp.json in place", () => {
      const legacy = asJson({ mcpServers: { miservidor: CUSTOM } });
      const agentDir = createProfile({ files: { "mcp.json": legacy, "aies.json": "[]" } });
      adapterPackage(agentDir, "3.2.0");
      const before = snapshot(agentDir);

      const result = seed(agentDir);

      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(snapshot(agentDir), before, "no migration, no removal, no backup");
      assertNoSecrets(result, [FAKE_HEADER_TOKEN]);
    });

    it("(s) the launcher continues with the existing profile when aies.json is unreadable", () => {
      const home = tempRoot();
      const aiesHome = join(home, "aies-home");
      const agentDir = join(aiesHome, "agent");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(join(agentDir, "mcp-adapter.json"), linearOnly);
      writeFileSync(join(agentDir, "aies.json"), "[]");

      const result = spawnSync("bash", [BOOTSTRAP, "--aies-home", aiesHome], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: home },
      });

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /continuing with the existing profile/);
      assert.equal(readFileSync(join(agentDir, "mcp-adapter.json"), "utf8"), linearOnly);
      assert.deepEqual(backupsOf(agentDir, "mcp-adapter.json"), []);
    });
  });

  describe("legacy migration and v2 honour the exclusion", () => {
    it("(u) migrating mcp.json into a new mcp-adapter.json leaves out an excluded template server", () => {
      const legacy = asJson({ mcpServers: { linear: LINEAR, miservidor: CUSTOM } });
      const agentDir = createProfile({ files: { "mcp.json": legacy, "aies.json": aiesConfig(["plane"]) } });
      adapterPackage(agentDir, "3.2.0");

      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      assert.ok(!readdirSync(agentDir).includes("mcp.json"), "legacy file is removed after migration");
      const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
      assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["linear", "miservidor"]);
      assert.equal(JSON.stringify(parsed.mcpServers.miservidor), JSON.stringify(CUSTOM));
      const [backup] = backupsOf(agentDir, "mcp.json");
      assert.ok(backup, "the legacy file is backed up before removal");
      assert.equal(readFileSync(join(agentDir, backup), "utf8"), legacy);
      assertNoSecrets(result, [FAKE_HEADER_TOKEN]);
    });

    it("(u) migrating into an existing destination does not add an excluded template server", () => {
      const destination = asJson({ mcpServers: { linear: LINEAR } });
      const legacy = asJson({ mcpServers: { miservidor: CUSTOM } });
      const agentDir = createProfile({ files: { "mcp-adapter.json": destination, "mcp.json": legacy, "aies.json": aiesConfig(["plane"]) } });
      adapterPackage(agentDir, "3.2.0");

      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
      assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["linear", "miservidor"]);
      assert.equal(backupsOf(agentDir, "mcp-adapter.json").length, 1, "the destination is backed up before it changes");
    });

    it("(u) an excluded server that the legacy file declares is migrated exactly as written", () => {
      const legacy = asJson({ mcpServers: { plane: PLANE_CUSTOM } });
      const agentDir = createProfile({ files: { "mcp.json": legacy, "aies.json": aiesConfig(["plane"]) } });
      adapterPackage(agentDir, "3.2.0");

      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      const parsed = readJsonFile(join(agentDir, "mcp-adapter.json"));
      assert.equal(JSON.stringify(parsed.mcpServers.plane), JSON.stringify(PLANE_CUSTOM), "no template key is merged into an excluded entry");
      assert.deepEqual(Object.keys(parsed.mcpServers).sort(), ["linear", "plane"]);
    });

    it("(v) v2 adapter: an existing mcp.json that lacks an excluded server is not rewritten", () => {
      const agentDir = createProfile({ files: { "mcp.json": linearOnly, "aies.json": aiesConfig(["plane"]) } });
      adapterPackage(agentDir, "2.9.0");
      const before = snapshot(agentDir);

      const result = seed(agentDir);

      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(snapshot(agentDir), before, "no write and no backup");
    });
  });
});
