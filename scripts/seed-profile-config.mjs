/**
 * Seed and reconcile the AIES-owned parts of an isolated Pi profile.
 *
 * The template directory (this repository's `profile/`) is the declared source of
 * truth for the MCP integration AIES needs. This script copies only what is
 * missing and restores only what the template declares, so:
 *
 *   - the first launch seeds a usable profile,
 *   - later launches still work when the user edited the profile (Pi owns
 *     `settings.json` after seeding, and `/mcp setup` may rewrite MCP config),
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

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
 * Keep the MCP config format aligned with the installed adapter generation. v3
 * reads mcp-adapter.json only; v2 reads mcp.json. If the package is not installed
 * yet, use the current v3 format so the first Pi launch cannot produce a warning.
 */
function reconcileMcpConfig() {
  const mcpJsonPath = join(AGENT_DIR, "mcp.json");
  const mcpAdapterPath = join(AGENT_DIR, "mcp-adapter.json");
  const legacyTemplatePath = join(TEMPLATE_DIR, "mcp.json");
  const adapterTemplatePath = join(TEMPLATE_DIR, "mcp-adapter.json");
  const packagePath = join(AGENT_DIR, "npm", "node_modules", "pi-mcp-adapter", "package.json");
  let adapterMajor;

  if (existsSync(packagePath)) {
    const metadata = readJson(packagePath);
    const match = metadata.ok && typeof metadata.value?.version === "string"
      ? metadata.value.version.match(/^(\d+)\./)
      : null;
    if (match) adapterMajor = Number(match[1]);
    else warn(`cannot determine pi-mcp-adapter version from ${packagePath}; using the current v3 config format`);
  }

  const isV2 = adapterMajor !== undefined && adapterMajor < 3;
  const targetPath = isV2 ? mcpJsonPath : mcpAdapterPath;
  const sourcePath = isV2 ? mcpAdapterPath : mcpJsonPath;
  const templatePath = isV2 ? legacyTemplatePath : adapterTemplatePath;

  if (isV2) {
    if (!existsSync(targetPath) && existsSync(templatePath)) {
      const template = readJson(templatePath);
      if (template.ok && isPlainObject(template.value)) {
        writeJson(targetPath, template.value);
        process.stdout.write(`aies: profile MCP config reconciled at ${targetPath}\n`);
      }
    }
    return;
  }

  const template = existsSync(templatePath) ? readJson(templatePath) : { ok: true, value: {} };
  if (!template.ok || !isPlainObject(template.value)) return;

  if (!existsSync(sourcePath)) {
    if (!existsSync(targetPath)) {
      writeJson(targetPath, template.value);
      process.stdout.write(`aies: profile MCP config reconciled at ${targetPath}\n`);
    }
    return;
  }

  const legacy = readJson(sourcePath);
  if (!legacy.ok || !isPlainObject(legacy.value)) {
    warn(`${sourcePath} is not a readable JSON object; leaving profile untouched`);
    return;
  }

  let current = { ...template.value };
  if (existsSync(targetPath)) {
    const loaded = readJson(targetPath);
    if (!loaded.ok || !isPlainObject(loaded.value)) {
      warn(`${targetPath} is not a readable JSON object; leaving profile untouched`);
      return;
    }
    current = loaded.value;
  }

  const next = mergeObjects(mergeObjects(template.value, legacy.value), current);
  if (!isPlainObject(next.mcpServers)) {
    warn(`${targetPath} has no valid "mcpServers" object after migration; leaving legacy config untouched`);
    return;
  }

  writeJson(targetPath, next);
  const validated = readJson(targetPath);
  if (!validated.ok || !isPlainObject(validated.value) || !isPlainObject(validated.value.mcpServers)
    || !deepEqual(validated.value, next)) {
    warn(`${targetPath} failed validation after migration; leaving legacy config untouched`);
    return;
  }

  unlinkSync(sourcePath);
  process.stdout.write(`aies: profile MCP config migrated to ${targetPath}; removed legacy ${sourcePath}\n`);
}

/** Merge recursively, with values from the right-hand config taking precedence. */
function mergeObjects(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(result[key]) && isPlainObject(value)
      ? mergeObjects(result[key], value)
      : value;
  }
  return result;
}

function main() {
  mkdirSync(AGENT_DIR, { recursive: true });
  reconcilePackages();
  reconcileMcpConfig();
}

main();
