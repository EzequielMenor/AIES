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
 * Ensure the declared MCP servers and adapter settings exist. Every other server
 * the user added stays exactly as it was.
 */
function reconcileMcpConfig() {
  const templatePath = join(TEMPLATE_DIR, "mcp.json");
  if (!existsSync(templatePath)) return;
  const targetPath = join(AGENT_DIR, "mcp.json");

  const template = readJson(templatePath);
  if (!template.ok || !isPlainObject(template.value)) return;

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

  const next = { ...current };

  const templateServers = isPlainObject(template.value.mcpServers) ? template.value.mcpServers : {};
  const currentServers = isPlainObject(current.mcpServers) ? current.mcpServers : {};
  const servers = { ...currentServers };
  for (const [name, definition] of Object.entries(templateServers)) {
    if (!deepEqual(servers[name], definition)) servers[name] = definition;
  }
  next.mcpServers = servers;

  const templateSettings = isPlainObject(template.value.settings) ? template.value.settings : {};
  const currentSettings = isPlainObject(current.settings) ? current.settings : {};
  const settings = { ...currentSettings };
  for (const [key, value] of Object.entries(templateSettings)) {
    if (!deepEqual(settings[key], value)) settings[key] = value;
  }
  if (Object.keys(settings).length > 0) next.settings = settings;

  if (deepEqual(next, current) && existsSync(targetPath)) return;
  writeJson(targetPath, next);
  process.stdout.write(`aies: profile MCP config reconciled at ${targetPath}\n`);
}

function main() {
  mkdirSync(AGENT_DIR, { recursive: true });
  reconcilePackages();
  reconcileMcpConfig();
}

main();
