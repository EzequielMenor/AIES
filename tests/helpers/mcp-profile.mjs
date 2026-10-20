/**
 * Trusted and hostile MCP profiles for the tests (D38).
 *
 * A profile is a temporary agent directory with `mcp-adapter.json` (and optionally `mcp.json`), read in
 * exclusive mode. The trust verdict is `evaluateMcpTrust` over that directory, so a test states the
 * shape it wants and the guard judges it, with no copy of the rules in the test.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateMcpTrust } from "../../extensions/aies-agents/mcp/trust.ts";

const TEMPLATE = JSON.parse(readFileSync(fileURLToPath(new URL("../../profile/mcp-adapter.json", import.meta.url)), "utf-8"));

/** The repo template, restricted to `servers` (default: every server the template declares). */
export function templateProfile(servers = Object.keys(TEMPLATE.mcpServers)) {
  return {
    mcpServers: Object.fromEntries(servers.map((name) => [name, structuredClone(TEMPLATE.mcpServers[name])])),
    settings: structuredClone(TEMPLATE.settings),
  };
}

/** The trust literal of a trusted profile with the template's Linear and Plane, for pure guard tests. */
export const TRUSTED = Object.freeze({ trusted: true, servers: new Set(["linear", "plane"]), reason: "" });

/** The trust literal of a profile the guard does not trust. */
export const UNTRUSTED = Object.freeze({ trusted: false, servers: new Set(), reason: "perfil de prueba no fiable" });

/**
 * Write `files` (name → object or text) into a temporary agent directory and judge it. Returns the
 * environment the adapter would see, the verdict, and `cleanup()`. `mode` defaults to `exclusive`.
 */
export function writeProfile(files, { mode = "exclusive", argv = ["node", "pi"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "aies-mcp-profile-"));
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  const env = { PI_CODING_AGENT_DIR: dir, PI_MCP_CONFIG_MODE: mode };
  return {
    dir,
    env,
    argv,
    trust: evaluateMcpTrust(env, argv),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A trusted profile: the whole repo template in exclusive mode. */
export function trustedProfile(options) {
  return writeProfile({ "mcp-adapter.json": templateProfile() }, options);
}

/**
 * Point this process at a trusted profile for one test: the hook and the extension read `process.env`.
 * Returns the restore function, which resets the variables and removes the profile.
 */
export function useTrustedProfileEnv() {
  const profile = trustedProfile();
  const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_MCP_CONFIG_MODE: process.env.PI_MCP_CONFIG_MODE };
  process.env.PI_CODING_AGENT_DIR = profile.dir;
  process.env.PI_MCP_CONFIG_MODE = "exclusive";
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    profile.cleanup();
  };
}
