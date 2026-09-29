/**
 * Seed and reconcile the AIES-owned parts of an isolated Pi profile.
 *
 * The template directory (this repository's `profile/`) is the declared source of
 * truth for the MCP integration AIES needs. This script copies only what is
 * missing and restores only what the template declares, so:
 *
 *   - the first launch seeds a usable profile,
 *   - later launches still work when the user edited the profile (Pi owns
 *     `settings.json` after seeding, and `/mcp setup` may rewrite `mcp.json`),
 *   - running it twice changes nothing.
 *
 * Nothing here is a credential. OAuth tokens live in the OS credential store and
 * are never written to the profile by AIES.
 *
 * Fail-closed rules: an unreadable or malformed existing file is reported and left
 * untouched, and the launcher keeps working with whatever it had.
 *
 * Usage: node scripts/seed-profile-config.mjs <templateDir> <agentDir>
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const [, , TEMPLATE_DIR_ARG, AGENT_DIR_ARG] = process.argv;

if (!TEMPLATE_DIR_ARG || !AGENT_DIR_ARG) {
  process.stderr.write("seed-profile-config: usage: seed-profile-config.mjs <templateDir> <agentDir>\n");
  process.exit(2);
}

const TEMPLATE_DIR = resolve(TEMPLATE_DIR_ARG);
const AGENT_DIR = resolve(AGENT_DIR_ARG);

function warn(message) {
  process.stderr.write(`aies: ${message}\n`);
}

function readJson(path) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    warn(`cannot read ${path} (${error instanceof Error ? error.message : String(error)}); leaving it untouched`);
    return { ok: false, value: undefined };
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.aies.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Ensure every package the AIES profile declares is present. User-added packages
 * are preserved; a non-array `packages` field is never rewritten.
 */
function reconcilePackages() {
  const templatePath = join(TEMPLATE_DIR, "settings.json");
  const targetPath = join(AGENT_DIR, "settings.json");
  if (!existsSync(templatePath)) return;

  const template = readJson(templatePath);
  if (!template.ok || !isPlainObject(template.value)) return;
  const required = Array.isArray(template.value.packages) ? template.value.packages.filter((s) => typeof s === "string") : [];
  if (required.length === 0) return;

  let current;
  if (existsSync(targetPath)) {
    const loaded = readJson(targetPath);
    if (!loaded.ok) return;
    current = loaded.value;
  } else {
    current = {};
  }
  if (!isPlainObject(current)) {
    warn(`${targetPath} is not a JSON object; leaving it untouched`);
    return;
  }
  if (current.packages !== undefined && !Array.isArray(current.packages)) {
    warn(`${targetPath} has a non-array "packages" field; leaving it untouched`);
    return;
  }

  const packages = Array.isArray(current.packages) ? [...current.packages] : [];
  const missing = required.filter((source) => !packages.includes(source));
  if (missing.length === 0) {
    if (!existsSync(targetPath)) writeJson(targetPath, { ...current, packages });
    return;
  }

  writeJson(targetPath, { ...current, packages: [...missing, ...packages] });
  process.stdout.write(`aies: profile declares ${missing.join(", ")}\n`);
}

/**
 * Ensure MCP configurations exist and remain compatible across pi-mcp-adapter 2.x and 3.x.
 *
 * Conflict-safe rules:
 * A) Empty profile: seed both mcp.json and mcp-adapter.json from templates.
 * B) Only mcp.json exists: preserve mcp.json byte-for-byte; create mcp-adapter.json
 *    migrating user servers and settings without destroying user configuration.
 * C) Only mcp-adapter.json exists: preserve mcp-adapter.json byte-for-byte.
 * D) Both exist (even with different content): never overwrite either, never merge
 *    destructively; preserve both byte-for-byte.
 *
 * Idempotence: a second run makes zero changes.
 */
function reconcileMcpConfig() {
  const mcpJsonPath = join(AGENT_DIR, "mcp.json");
  const mcpAdapterPath = join(AGENT_DIR, "mcp-adapter.json");

  const hasMcpJson = existsSync(mcpJsonPath);
  const hasMcpAdapter = existsSync(mcpAdapterPath);

  // Case D: Both exist. Never overwrite either, never merge destructively.
  if (hasMcpJson && hasMcpAdapter) {
    return;
  }

  // Case C: Only mcp-adapter.json exists. Preserve byte-for-byte.
  if (!hasMcpJson && hasMcpAdapter) {
    return;
  }

  // Case B: Only mcp.json exists. Preserve mcp.json byte-for-byte;
  // create mcp-adapter.json migrating user configuration and adding declared template servers.
  if (hasMcpJson && !hasMcpAdapter) {
    const templatePath = existsSync(join(TEMPLATE_DIR, "mcp-adapter.json"))
      ? join(TEMPLATE_DIR, "mcp-adapter.json")
      : join(TEMPLATE_DIR, "mcp.json");

    const template = existsSync(templatePath) ? readJson(templatePath) : { ok: true, value: {} };
    const userMcp = readJson(mcpJsonPath);

    if (!userMcp.ok || !isPlainObject(userMcp.value)) {
      warn(`${mcpJsonPath} is not a readable JSON object; leaving profile untouched`);
      return;
    }

    const next = { ...userMcp.value };

    const templateServers = (template.ok && isPlainObject(template.value?.mcpServers)) ? template.value.mcpServers : {};
    const userServers = isPlainObject(userMcp.value.mcpServers) ? userMcp.value.mcpServers : {};
    const mergedServers = { ...userServers };
    for (const [name, definition] of Object.entries(templateServers)) {
      if (!mergedServers[name]) {
        mergedServers[name] = definition;
      }
    }
    next.mcpServers = mergedServers;

    const templateSettings = (template.ok && isPlainObject(template.value?.settings)) ? template.value.settings : {};
    const userSettings = isPlainObject(userMcp.value.settings) ? userMcp.value.settings : {};
    const mergedSettings = { ...userSettings };
    for (const [key, value] of Object.entries(templateSettings)) {
      if (mergedSettings[key] === undefined) {
        mergedSettings[key] = value;
      }
    }
    if (Object.keys(mergedSettings).length > 0) {
      next.settings = mergedSettings;
    }

    writeJson(mcpAdapterPath, next);
    process.stdout.write(`aies: profile MCP config reconciled at ${mcpAdapterPath}\n`);
    return;
  }

  // Case A: Empty profile (neither exists). Seed both from templates.
  const templateMcp = join(TEMPLATE_DIR, "mcp.json");
  const templateAdapter = existsSync(join(TEMPLATE_DIR, "mcp-adapter.json"))
    ? join(TEMPLATE_DIR, "mcp-adapter.json")
    : templateMcp;

  if (existsSync(templateMcp)) {
    const parsed = readJson(templateMcp);
    if (parsed.ok && isPlainObject(parsed.value)) {
      writeJson(mcpJsonPath, parsed.value);
      process.stdout.write(`aies: profile MCP config reconciled at ${mcpJsonPath}\n`);
    }
  }

  if (existsSync(templateAdapter)) {
    const parsed = readJson(templateAdapter);
    if (parsed.ok && isPlainObject(parsed.value)) {
      writeJson(mcpAdapterPath, parsed.value);
      process.stdout.write(`aies: profile MCP config reconciled at ${mcpAdapterPath}\n`);
    }
  }
}

function main() {
  mkdirSync(AGENT_DIR, { recursive: true });
  reconcilePackages();
  reconcileMcpConfig();
}

main();
