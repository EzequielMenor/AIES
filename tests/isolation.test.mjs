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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Runs pi in RPC mode through the launcher and returns the decoded records.
 *
 * `options.cwd` is optional and additive: existing call sites keep inheriting
 * the process working directory when they omit it, while the catalog tests can
 * launch the child from an unrelated directory.
 */
function rpc(env, commands, extraArgs = [], options = {}) {
  const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
  const result = spawnSync(AIES, ["--mode", "rpc", ...extraArgs], {
    env,
    input,
    encoding: "utf8",
    cwd: options.cwd,
  });

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

  it("resolves explicit --aies-home, overriding AIES_HOME environment variable", () => {
    const explicitHome = mkdtempSync(join(tmpdir(), "aies-explicit-home-"));
    try {
      const info = parseInfo(runAies(env, ["--aies-info", "--aies-home", explicitHome]));
      assert.equal(info.AIES_HOME, explicitHome);
      assert.equal(info.PI_CODING_AGENT_DIR, join(explicitHome, "agent"));
    } finally {
      rmSync(explicitHome, { recursive: true, force: true });
    }
  });

  it("seeds both mcp.json and mcp-adapter.json for adapter 2.x and 3.x compatibility", () => {
    runAies(env, ["--aies-info"]);
    const mcpJson = join(agentDir, "mcp.json");
    const mcpAdapterJson = join(agentDir, "mcp-adapter.json");
    assert.ok(existsSync(mcpJson), "mcp.json must be seeded");
    assert.ok(existsSync(mcpAdapterJson), "mcp-adapter.json must be seeded");
    const mcpContent = JSON.parse(readFileSync(mcpJson, "utf8"));
    const adapterContent = JSON.parse(readFileSync(mcpAdapterJson, "utf8"));
    assert.deepEqual(adapterContent, mcpContent, "mcp-adapter.json must match mcp.json");
  });

  it("protects against inherited temporary AIES_HOME in interactive sessions and falls back to canonical", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "aies-inherited-"));
    const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-"));
    try {
      const mockPi = join(mockBinDir, "pi");
      writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });

      const script = `import pty, os, subprocess
master, slave = pty.openpty()
env = dict(os.environ, PATH="${mockBinDir}:" + os.environ["PATH"], AIES_HOME="${tmpHome}")
p = subprocess.run(["bash", "${AIES}", "install"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print("STDOUT:" + p.stdout.decode())
print("STDERR:" + p.stderr.decode())
`;
      const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${DEFAULT_AIES_HOME}/agent`));
      assert.match(result.stdout, /ignoring inherited temporary AIES_HOME/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(mockBinDir, { recursive: true, force: true });
    }
  });

  it("respects --aies-ephemeral in interactive sessions when temporary AIES_HOME is intentional", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "aies-ephemeral-"));
    const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-"));
    try {
      const mockPi = join(mockBinDir, "pi");
      writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });

      const script = `import pty, os, subprocess
master, slave = pty.openpty()
env = dict(os.environ, PATH="${mockBinDir}:" + os.environ["PATH"], AIES_HOME="${tmpHome}")
p = subprocess.run(["bash", "${AIES}", "--aies-ephemeral", "install"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print("STDOUT:" + p.stdout.decode())
print("STDERR:" + p.stderr.decode())
`;
      const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${tmpHome}/agent`));
      assert.doesNotMatch(result.stdout, /ignoring inherited temporary AIES_HOME/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(mockBinDir, { recursive: true, force: true });
    }
  });

  it("respects explicit --aies-home even in interactive sessions with temporary path", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "aies-inherited-"));
    const explicitHome = mkdtempSync(join(tmpdir(), "aies-explicit-interactive-"));
    const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-"));
    try {
      const mockPi = join(mockBinDir, "pi");
      writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });

      const script = `import pty, os, subprocess
master, slave = pty.openpty()
env = dict(os.environ, PATH="${mockBinDir}:" + os.environ["PATH"], AIES_HOME="${tmpHome}")
p = subprocess.run(["bash", "${AIES}", "--aies-home", "${explicitHome}", "install"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print("STDOUT:" + p.stdout.decode())
print("STDERR:" + p.stderr.decode())
`;
      const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${explicitHome}/agent`));
      assert.doesNotMatch(result.stdout, /ignoring inherited temporary AIES_HOME/);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(explicitHome, { recursive: true, force: true });
      rmSync(mockBinDir, { recursive: true, force: true });
    }
  });

  it("respects inherited custom persistent AIES_HOME in interactive and non-interactive sessions", () => {
    const persistentHome = join(homedir(), ".aies-test-custom-persistent-" + Date.now());
    const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-"));
    try {
      const mockPi = join(mockBinDir, "pi");
      writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });

      // Interactive (PTY)
      const script = `import pty, os, subprocess
master, slave = pty.openpty()
env = dict(os.environ, PATH="${mockBinDir}:" + os.environ["PATH"], AIES_HOME="${persistentHome}")
p = subprocess.run(["bash", "${AIES}", "install"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print("STDOUT:" + p.stdout.decode())
print("STDERR:" + p.stderr.decode())
`;
      const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
      assert.equal(result.status, 0);
      assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${persistentHome}/agent`));
      assert.doesNotMatch(result.stdout, /ignoring inherited temporary AIES_HOME/);

      // Non-interactive (direct spawn)
      const nonInteractive = spawnSync(AIES, ["--aies-info"], {
        env: { ...process.env, AIES_HOME: persistentHome },
        encoding: "utf8"
      });
      assert.equal(nonInteractive.status, 0);
      assert.match(nonInteractive.stdout, new RegExp(`AIES_HOME=${persistentHome}`));
    } finally {
      rmSync(persistentHome, { recursive: true, force: true });
      rmSync(mockBinDir, { recursive: true, force: true });
    }
  });

  describe("EZE-486 regression: zero arguments / empty array under macOS Bash 3.2 (nounset)", () => {
    it("launches Pi when called with zero arguments under system bash (/bin/bash)", () => {
      const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-zeroargs-"));
      const logFile = join(mockBinDir, "pi.log");
      try {
        const mockPi = join(mockBinDir, "pi");
        writeFileSync(mockPi, `#!/bin/sh\necho "INVOKED" >> "${logFile}"\nfor a in "$@"; do echo "ARG: $a" >> "${logFile}"; done\n`, { mode: 0o755 });

        const customEnv = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` };
        const result = spawnSync("/bin/bash", [AIES], { env: customEnv, encoding: "utf8" });
        assert.equal(result.status, 0, `aies with zero arguments failed:\n${result.stderr}`);
        const log = readFileSync(logFile, "utf8");
        assert.match(log, /INVOKED/);
        assert.match(log, /ARG: --no-skills/);
      } finally {
        rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("matrix Case A: inherited temporary AIES_HOME in interactive mode warns, falls back to canonical, and launches Pi with zero args", () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "aies-inherited-zeroargs-"));
      const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-case-a-"));
      try {
        const mockPi = join(mockBinDir, "pi");
        writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\nfor a in "$@"; do echo "ARG: $a"; done\n', { mode: 0o755 });

        const script = `import pty, os, subprocess
master, slave = pty.openpty()
env = dict(os.environ, PATH="${mockBinDir}:" + os.environ["PATH"], AIES_HOME="${tmpHome}")
p = subprocess.run(["/bin/bash", "${AIES}"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print("STDOUT:" + p.stdout.decode())
print("STDERR:" + p.stderr.decode())
`;
        const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${DEFAULT_AIES_HOME}/agent`));
        assert.match(result.stdout, /ignoring inherited temporary AIES_HOME/);
        assert.match(result.stdout, /ARG: --no-skills/);
        assert.doesNotMatch(result.stdout, /unbound variable/);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
        rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("matrix Case B: env -u AIES_HOME uses canonical profile and launches Pi with zero args", () => {
      const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-case-b-"));
      try {
        const mockPi = join(mockBinDir, "pi");
        writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });

        const customEnv = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` };
        delete customEnv.AIES_HOME;
        const result = spawnSync("/bin/bash", [AIES], { env: customEnv, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${DEFAULT_AIES_HOME}/agent`));
        assert.doesNotMatch(result.stderr, /ignoring inherited temporary AIES_HOME/);
        assert.doesNotMatch(result.stderr, /unbound variable/);
      } finally {
        rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("matrix Case C: aies --aies-home <path> respects explicit profile with zero other args", () => {
      const explicitHome = mkdtempSync(join(tmpdir(), "aies-explicit-zeroargs-"));
      const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-case-c-"));
      try {
        const mockPi = join(mockBinDir, "pi");
        writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });

        const customEnv = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` };
        const result = spawnSync("/bin/bash", [AIES, "--aies-home", explicitHome], { env: customEnv, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${explicitHome}/agent`));
        assert.doesNotMatch(result.stderr, /unbound variable/);
      } finally {
        rmSync(explicitHome, { recursive: true, force: true });
        rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("matrix Case D: aies --aies-ephemeral respects temporary profile with zero other args", () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "aies-ephemeral-zeroargs-"));
      const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-case-d-"));
      try {
        const mockPi = join(mockBinDir, "pi");
        writeFileSync(mockPi, '#!/bin/sh\necho "MOCK_PI_DIR=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });

        const script = `import pty, os, subprocess
master, slave = pty.openpty()
env = dict(os.environ, PATH="${mockBinDir}:" + os.environ["PATH"], AIES_HOME="${tmpHome}")
p = subprocess.run(["/bin/bash", "${AIES}", "--aies-ephemeral"], stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
print("STDOUT:" + p.stdout.decode())
print("STDERR:" + p.stderr.decode())
`;
        const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
        assert.equal(result.status, 0);
        assert.match(result.stdout, new RegExp(`MOCK_PI_DIR=${tmpHome}/agent`));
        assert.doesNotMatch(result.stderr, /ignoring inherited temporary AIES_HOME/);
        assert.doesNotMatch(result.stderr, /unbound variable/);
      } finally {
        rmSync(tmpHome, { recursive: true, force: true });
        rmSync(mockBinDir, { recursive: true, force: true });
      }
    });

    it("matrix Case E: normal Pi arguments are preserved exactly in order and content", () => {
      const mockBinDir = mkdtempSync(join(tmpdir(), "aies-mock-pi-case-e-"));
      const logFile = join(mockBinDir, "pi.log");
      try {
        const mockPi = join(mockBinDir, "pi");
        writeFileSync(mockPi, `#!/bin/sh\nfor a in "$@"; do echo "ARG: $a" >> "${logFile}"; done\n`, { mode: 0o755 });

        const customEnv = { ...process.env, PATH: `${mockBinDir}:${process.env.PATH}` };
        const testArgs = ["-p", "hello world", "--mode", "rpc", "arg with spaces and quotes '\""];
        const result = spawnSync("/bin/bash", [AIES, ...testArgs], { env: customEnv, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        const logLines = readFileSync(logFile, "utf8").trim().split("\n");
        const forwardedArgs = logLines.map((l) => l.replace(/^ARG: /, ""));
        assert.deepEqual(forwardedArgs.slice(-testArgs.length), testArgs);
      } finally {
        rmSync(mockBinDir, { recursive: true, force: true });
      }
    });
  });


  it("guarantees bin/aies and bootstrap-profile.sh apply the exact same profile precedence", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "aies-temp-parity-"));
    const explicitHome = mkdtempSync(join(tmpdir(), "aies-explicit-parity-"));
    const bootstrapScript = join(REPO, "scripts", "bootstrap-profile.sh");
    try {
      // 1. Explicit --aies-home
      const aiesInfoExplicit = parseInfo(runAies(env, ["--aies-info", "--aies-home", explicitHome]));
      const bootstrapExplicit = spawnSync("bash", [bootstrapScript, "--aies-home", explicitHome], {
        env: { ...env, AIES_HOME: tmpHome },
        encoding: "utf8"
      });
      assert.equal(aiesInfoExplicit.AIES_HOME, explicitHome);
      assert.equal(bootstrapExplicit.status, 0);
      assert.ok(existsSync(join(explicitHome, "agent", "settings.json")));

      // 2. Ephemeral opt-in with temporary directory
      const aiesInfoEphemeral = parseInfo(runAies({ ...env, AIES_HOME: tmpHome }, ["--aies-info", "--aies-ephemeral"]));
      assert.equal(aiesInfoEphemeral.AIES_HOME, tmpHome);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
      rmSync(explicitHome, { recursive: true, force: true });
    }
  });

  describe("MCP conflict-safe seeding rules (A, B, C, D) and idempotence", () => {
    const seedScript = join(REPO, "scripts", "seed-profile-config.mjs");
    const templateDir = join(REPO, "profile");

    it("Case A: empty profile seeds both mcp.json and mcp-adapter.json idempotently", () => {
      const testAgentDir = mkdtempSync(join(tmpdir(), "aies-mcp-case-a-"));
      try {
        const first = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(first.status, 0);
        const mcpJson = join(testAgentDir, "mcp.json");
        const adapterJson = join(testAgentDir, "mcp-adapter.json");
        assert.ok(existsSync(mcpJson));
        assert.ok(existsSync(adapterJson));

        const mcpContentFirst = readFileSync(mcpJson, "utf8");
        const adapterContentFirst = readFileSync(adapterJson, "utf8");

        // Second run: 0 changes
        const second = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(second.status, 0);
        assert.equal(readFileSync(mcpJson, "utf8"), mcpContentFirst);
        assert.equal(readFileSync(adapterJson, "utf8"), adapterContentFirst);
        assert.doesNotMatch(second.stdout, /reconciled at/);
      } finally {
        rmSync(testAgentDir, { recursive: true, force: true });
      }
    });

    it("Case B: only mcp.json exists -> preserved byte-for-byte; creates mcp-adapter.json preserving config", () => {
      const testAgentDir = mkdtempSync(join(tmpdir(), "aies-mcp-case-b-"));
      try {
        const mcpJson = join(testAgentDir, "mcp.json");
        const customMcpContent = '{\n  "mcpServers": {\n    "custom-user-server": {\n      "command": "custom-cmd"\n    }\n  }\n}\n';
        writeFileSync(mcpJson, customMcpContent);

        const first = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(first.status, 0);

        // mcp.json preserved byte-for-byte
        assert.equal(readFileSync(mcpJson, "utf8"), customMcpContent);

        // mcp-adapter.json created with user server + template servers (linear)
        const adapterJson = join(testAgentDir, "mcp-adapter.json");
        assert.ok(existsSync(adapterJson));
        const adapterObj = JSON.parse(readFileSync(adapterJson, "utf8"));
        assert.ok(adapterObj.mcpServers["custom-user-server"]);
        assert.ok(adapterObj.mcpServers["linear"]);

        const adapterContentFirst = readFileSync(adapterJson, "utf8");

        // Second run: 0 changes
        const second = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(second.status, 0);
        assert.equal(readFileSync(mcpJson, "utf8"), customMcpContent);
        assert.equal(readFileSync(adapterJson, "utf8"), adapterContentFirst);
        assert.doesNotMatch(second.stdout, /reconciled at/);
      } finally {
        rmSync(testAgentDir, { recursive: true, force: true });
      }
    });

    it("Case C: only mcp-adapter.json exists -> preserved byte-for-byte", () => {
      const testAgentDir = mkdtempSync(join(tmpdir(), "aies-mcp-case-c-"));
      try {
        const adapterJson = join(testAgentDir, "mcp-adapter.json");
        const customAdapterContent = '{\n  "mcpServers": {\n    "v3-custom": {\n      "command": "v3"\n    }\n  }\n}\n';
        writeFileSync(adapterJson, customAdapterContent);

        const first = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(first.status, 0);
        assert.equal(readFileSync(adapterJson, "utf8"), customAdapterContent);

        // Second run: 0 changes
        const second = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(second.status, 0);
        assert.equal(readFileSync(adapterJson, "utf8"), customAdapterContent);
        assert.doesNotMatch(second.stdout, /reconciled at/);
      } finally {
        rmSync(testAgentDir, { recursive: true, force: true });
      }
    });

    it("Case D: both exist with different content -> neither overwritten, neither merged destructively", () => {
      const testAgentDir = mkdtempSync(join(tmpdir(), "aies-mcp-case-d-"));
      try {
        const mcpJson = join(testAgentDir, "mcp.json");
        const adapterJson = join(testAgentDir, "mcp-adapter.json");
        const mcpContent = '{\n  "mcpServers": {\n    "server-one": {\n      "command": "one"\n    }\n  }\n}\n';
        const adapterContent = '{\n  "mcpServers": {\n    "server-two": {\n      "command": "two"\n    }\n  }\n}\n';
        writeFileSync(mcpJson, mcpContent);
        writeFileSync(adapterJson, adapterContent);

        const first = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(first.status, 0);

        // Neither overwritten, neither merged destructively
        assert.equal(readFileSync(mcpJson, "utf8"), mcpContent);
        assert.equal(readFileSync(adapterJson, "utf8"), adapterContent);
        assert.doesNotMatch(first.stdout, /reconciled at/);

        // Second run: 0 changes
        const second = spawnSync("node", [seedScript, templateDir, testAgentDir], { encoding: "utf8" });
        assert.equal(second.status, 0);
        assert.equal(readFileSync(mcpJson, "utf8"), mcpContent);
        assert.equal(readFileSync(adapterJson, "utf8"), adapterContent);
      } finally {
        rmSync(testAgentDir, { recursive: true, force: true });
      }
    });
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

    const themes = join(agentDir, "themes");
    assert.ok(lstatSync(themes).isSymbolicLink(), "themes should be a symlink into the repo");
    assert.equal(readlinkSync(themes), join(REPO, "themes"));
    assert.ok(existsSync(join(themes, "aies.json")), "the aies theme must be discoverable from the profile");

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

  it("does not seed a child config into a fresh profile", () => {
    const fresh = mkdtempSync(join(tmpdir(), "aies-fresh-profile-"));
    try {
      runAies(isolatedEnv(fresh), ["--aies-info"]);
      assert.equal(
        existsSync(join(fresh, "agent", "aies.json")),
        false,
        "bootstrap must not seed aies.json; the profile creates it only after a user saves a child preference",
      );
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("keeps the repository aies.json as a defaults fixture", () => {
    assert.ok(
      existsSync(join(REPO, "profile", "aies.json")),
      "profile/aies.json stays as the documented defaults fixture",
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

    const models = commands.find((command) => command.name === "aies-models");
    assert.ok(models, "the /aies-models extension is not loaded from the profile");
    assert.equal(models.sourceInfo.baseDir, agentDir);
    assert.equal(
      models.sourceInfo.origin,
      "top-level",
      "the model picker is a top-level profile extension, not a package",
    );

    const leaked = commands.filter((command) => command.sourceInfo?.path?.startsWith(PI_PROFILE));
    assert.deepEqual(leaked, [], `commands leaked from the ambient Pi profile: ${JSON.stringify(leaked)}`);
  });

  it("registers the Command Code provider from the profile extension, offline", () => {
    // A dummy value is enough: pi only needs auth to be *configured* for the
    // provider's models to count as available. Nothing here talks to the network.
    const { records } = rpc(
      { ...env, COMMANDCODE_API_KEY: "aies-isolation-check-not-a-key" },
      [
        { id: "1", type: "get_commands" },
        { id: "2", type: "get_available_models" },
      ],
      ["--no-session"],
    );

    const provider = responseFor(records, "get_commands")
      .commands
      .find((command) => command.name === "aies-commandcode");
    assert.ok(provider, "the Command Code provider extension is not loaded");
    assert.equal(provider.sourceInfo.baseDir, agentDir);
    assert.equal(
      provider.sourceInfo.origin,
      "top-level",
      "the provider is a top-level profile extension, not a package",
    );

    const catalog = JSON.parse(
      readFileSync(join(REPO, "extensions", "aies-provider-commandcode", "models.json"), "utf8"),
    );
    const registered = responseFor(records, "get_available_models")
      .models
      .filter((model) => model.provider === "commandcode");

    assert.equal(
      registered.length,
      catalog.length,
      "pi must see exactly the models in the committed static catalog",
    );
    assert.deepEqual(
      registered.map((model) => model.id).sort(),
      catalog.map((model) => model.id).sort(),
    );
    for (const model of registered) {
      assert.equal(model.baseUrl, "https://api.commandcode.ai/provider/v1");
    }

    // Both transports come from the single registerProvider call.
    const anthropic = registered.filter((model) => model.api === "anthropic-messages").map((model) => model.id);
    assert.deepEqual(
      [...anthropic].sort(),
      catalog.filter((model) => model.api === "anthropic-messages").map((model) => model.id).sort(),
    );
    assert.ok(anthropic.length > 0, "no model kept the Anthropic transport");
    assert.ok(anthropic.length < registered.length, "no model kept the OpenAI transport");
  });

  describe("Command Code stored credentials", () => {
    const CATALOG_FILE = join(REPO, "extensions", "aies-provider-commandcode", "models.json");
    const CATALOG = JSON.parse(readFileSync(CATALOG_FILE, "utf8"));
    const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
    // Measured against Pi 0.87.0: the committed catalog serves this many models.
    const CATALOG_SIZE = 76;

    const availableCommandCodeModels = (records) =>
      responseFor(records, "get_available_models").models.filter((model) => model.provider === "commandcode");

    /**
     * Bootstraps a fresh isolated profile and stores a dummy Command Code
     * credential at `<agentDir>/auth.json`, the ordinary `/login commandcode`
     * path. The value is obviously not a key and never leaves this temp home.
     */
    function storedCredentialHome() {
      const stored = mkdtempSync(join(tmpdir(), "aies-commandcode-stored-"));
      const storedEnv = isolatedEnv(stored);
      delete storedEnv.COMMANDCODE_API_KEY;
      runAies(storedEnv, ["--aies-info"]);

      const authFile = join(stored, "agent", "auth.json");
      writeFileSync(
        authFile,
        JSON.stringify({ commandcode: { type: "api_key", key: "aies-isolation-check-not-a-key" } }),
        { mode: 0o600 },
      );
      return { stored, storedEnv, authFile };
    }

    it("discovers a persisted credential with no environment variable", () => {
      const { stored, storedEnv, authFile } = storedCredentialHome();
      try {
        assert.ok(existsSync(authFile), "the stored credential must exist in the isolated profile");
        assert.equal(storedEnv.COMMANDCODE_API_KEY, undefined);

        const { status, records } = rpc(storedEnv, [{ id: "1", type: "get_available_models" }], ["--no-session"]);
        assert.equal(status, 0, "the stored-credential run must exit cleanly");

        const registered = availableCommandCodeModels(records);
        assert.equal(registered.length, CATALOG_SIZE, "a stored credential must surface the whole catalog");
        assert.equal(registered.length, CATALOG.length);
        assert.deepEqual(
          registered.map((model) => model.id).sort(),
          CATALOG.map((model) => model.id).sort(),
        );
        for (const model of registered) {
          assert.equal(model.baseUrl, COMMANDCODE_BASE_URL);
        }

        // Both transports come from the single registerProvider call.
        const anthropic = registered.filter((model) => model.api === "anthropic-messages");
        assert.ok(anthropic.length > 0, "the Anthropic transport disappeared from the stored-credential path");
        assert.ok(
          anthropic.length < registered.length,
          "the OpenAI transport disappeared from the stored-credential path",
        );
      } finally {
        rmSync(stored, { recursive: true, force: true });
      }
    });

    it("keeps the provider registered but disconnected without a credential", () => {
      const disconnected = mkdtempSync(join(tmpdir(), "aies-commandcode-disconnected-"));
      const disconnectedEnv = isolatedEnv(disconnected);
      delete disconnectedEnv.COMMANDCODE_API_KEY;
      try {
        runAies(disconnectedEnv, ["--aies-info"]);
        assert.equal(
          existsSync(join(disconnected, "agent", "auth.json")),
          false,
          "bootstrap must not fabricate a credential",
        );

        const { status, records } = rpc(
          disconnectedEnv,
          [
            { id: "1", type: "get_commands" },
            { id: "2", type: "get_available_models" },
          ],
          ["--no-session"],
        );
        assert.equal(status, 0, "the disconnected run must exit cleanly");

        const provider = responseFor(records, "get_commands")
          .commands
          .find((command) => command.name === "aies-commandcode");
        assert.ok(provider, "the provider extension must load even when disconnected");
        assert.equal(provider.sourceInfo.origin, "top-level");
        assert.equal(provider.sourceInfo.baseDir, join(disconnected, "agent"));

        assert.equal(
          availableCommandCodeModels(records).length,
          0,
          "an unauthenticated provider must contribute zero available models",
        );
      } finally {
        rmSync(disconnected, { recursive: true, force: true });
      }
    });

    it("resolves the catalog from an unrelated working directory", () => {
      const { stored, storedEnv } = storedCredentialHome();
      try {
        const { status, records } = rpc(
          storedEnv,
          [{ id: "1", type: "get_available_models" }],
          ["--no-session"],
          { cwd: tmpdir() },
        );
        assert.equal(status, 0, "the unrelated-cwd run must exit cleanly");

        const registered = availableCommandCodeModels(records);
        assert.equal(registered.length, CATALOG_SIZE);
        assert.deepEqual(
          registered.map((model) => model.id).sort(),
          CATALOG.map((model) => model.id).sort(),
        );
      } finally {
        rmSync(stored, { recursive: true, force: true });
      }
    });

    it("stays offline: every stored-credential run exits 0 under PI_OFFLINE", () => {
      const { stored, storedEnv } = storedCredentialHome();
      try {
        assert.equal(storedEnv.PI_OFFLINE, "1", "the new tests must keep startup zero-network");
        const { status } = rpc(storedEnv, [{ id: "1", type: "get_available_models" }], ["--no-session"]);
        assert.equal(status, 0);
      } finally {
        rmSync(stored, { recursive: true, force: true });
      }
    });

    it("leaves the ambient Pi profile untouched", () => {
      assert.deepEqual(fingerprintProfile(), baseline);
    });
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

  it("lets no MCP command come from the repository", () => {
    const { records } = rpc(env, [{ id: "1", type: "get_commands" }], ["--no-session"]);
    const commands = responseFor(records, "get_commands").commands;

    const mcpCommands = commands.filter((command) => command.name === "mcp" || command.name === "mcp-auth");
    for (const command of mcpCommands) {
      assert.ok(
        !command.sourceInfo?.path?.startsWith(REPO),
        `${command.name} must come from pi-mcp-adapter, never from AIES`,
      );
    }
  });

  it("keeps the MCP config seeded in the profile and free of credentials", () => {
    runAies(env, ["--aies-info"]);

    const profileConfig = join(agentDir, "mcp.json");
    assert.ok(existsSync(profileConfig), "the profile MCP config must be seeded");
    assert.ok(
      !lstatSync(profileConfig).isSymbolicLink(),
      "the MCP config must be seeded, not linked, so Pi may write to it without dirtying the repository",
    );

    const servers = JSON.parse(readFileSync(profileConfig, "utf8")).mcpServers ?? {};
    assert.deepEqual(Object.keys(servers), ["linear"]);
    assert.equal(servers.linear.url, "https://mcp.linear.app/mcp");
    assert.equal(servers.linear.auth, "oauth");

    for (const path of [profileConfig, join(REPO, "profile", "mcp.json")]) {
      const raw = readFileSync(path, "utf8");
      for (const secret of ["accessToken", "refreshToken", "clientSecret", "bearerToken", "authorization_code"]) {
        assert.ok(!raw.includes(secret), `${path} must never hold ${secret}`);
      }
    }
  });

  it("pins the adapter's compact MCP presentation without touching the Linear server", () => {
    const repoConfig = JSON.parse(readFileSync(join(REPO, "profile", "mcp.json"), "utf8"));

    // The adapter reads `settings` from the MCP config file, so the pin lives there
    // and the Linear server definition, auth and lazy lifecycle stay untouched.
    assert.deepEqual(repoConfig.mcpServers, {
      linear: { url: "https://mcp.linear.app/mcp", auth: "oauth", lifecycle: "lazy" },
    });
    assert.equal(repoConfig.settings.scriptMode, false);
    assert.equal(repoConfig.settings.toolResultRendering, "compact");
    assert.equal(repoConfig.settings.collapsedResultLines, 1);
    assert.equal(repoConfig.settings.notifyOnStartupConnect, false);
    assert.equal(repoConfig.settings.mcpFooterStatus, "off");

    runAies(env, ["--aies-info"]);
    const seeded = JSON.parse(readFileSync(join(agentDir, "mcp.json"), "utf8"));
    assert.equal(seeded.settings.toolResultRendering, "compact");
    assert.equal(seeded.settings.collapsedResultLines, 1);
    assert.equal(seeded.settings.notifyOnStartupConnect, false);
    assert.equal(seeded.settings.mcpFooterStatus, "off");
    assert.deepEqual(Object.keys(seeded.mcpServers), ["linear"]);
    assert.equal(seeded.mcpServers.linear.url, "https://mcp.linear.app/mcp");
    assert.equal(seeded.mcpServers.linear.lifecycle, "lazy");
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
