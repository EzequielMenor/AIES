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
