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
 * MCP servers are reconciled incrementally. A template server the profile does not
 * declare is added. Every other entry is kept as the user wrote it: custom servers,
 * their credentials and their settings included. A template server the profile
 * declares differently is never overwritten; the difference is reported by server
 * name and key names only, never by value.
 *
 * Nothing here is a credential. OAuth tokens live in the OS credential store and
 * are never written to the profile by AIES.
 *
 * Servers the user excluded on purpose are listed in `mcpExcluded` in the profile's
 * `aies.json` (an array of server names, exact match). The seed only reads that file.
 * An excluded template server is never added, and a server the profile already
 * declares is never removed or changed by this rule. A missing `aies.json` excludes
 * nothing.
 *
 * Fail-closed rules: an unreadable, empty or malformed existing file is reported
 * and left untouched, and the script exits with status 1. The launcher keeps going
 * with whatever profile it had. An unreadable `aies.json` blocks every MCP change,
 * because an excluded server could come back.
 *
 * Before an existing file is changed or removed, its content is copied to
 * `<name>.bak-YYYYMMDDTHHMMSS` (a numeric suffix is added rather than overwriting an
 * earlier backup) with the original permissions. Changed files are written through a
 * temporary file in the same directory and a rename, and keep their permissions.
 *
 * Usage: node scripts/seed-profile-config.mjs <templateDir> <agentDir>
 */

import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const [, , TEMPLATE_DIR_ARG, AGENT_DIR_ARG] = process.argv;

if (!TEMPLATE_DIR_ARG || !AGENT_DIR_ARG) {
  process.stderr.write("seed-profile-config: usage: seed-profile-config.mjs <templateDir> <agentDir>\n");
  process.exit(2);
}

const TEMPLATE_DIR = resolve(TEMPLATE_DIR_ARG);
const AGENT_DIR = resolve(AGENT_DIR_ARG);
const BACKUP_ATTEMPTS = 100;

/** Becomes 1 when a file is refused. The run finishes its other safe steps, then exits with it. */
let exitStatus = 0;

function warn(message) {
  process.stderr.write(`aies: ${message}\n`);
}

/** A file the script will not touch. Only paths and error codes are printed, never file content. */
function refuse(message) {
  exitStatus = 1;
  warn(`${message}; leaving it untouched`);
}

function errorCode(error) {
  return error?.code ?? error?.name ?? "unknown error";
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Indentation of the first indented line, so the user's own layout survives a rewrite. */
function detectIndent(text) {
  const match = text.match(/^([ \t]+)\S/m);
  return match ? match[1] : 2;
}

function readJson(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    refuse(`cannot read ${path} (${errorCode(error)})`);
    return { ok: false };
  }
  // A UTF-8 byte order mark is valid UTF-8 but JSON.parse rejects it.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") {
    refuse(`${path} is empty`);
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(body), indent: detectIndent(body) };
  } catch {
    // The parser message can quote part of the file, and the file may hold credentials.
    refuse(`${path} is not valid JSON`);
    return { ok: false };
  }
}

function isWritable(path) {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${day}T${time}`;
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or never created.
  }
}

/**
 * Copy `path` to `<path>.bak-<stamp>` with the same permissions. An earlier backup is
 * never overwritten: a numeric suffix is used instead.
 */
function backupFile(path, stamp) {
  const mode = statSync(path).mode & 0o777;
  for (let attempt = 1; attempt <= BACKUP_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${path}.bak-${stamp}` : `${path}.bak-${stamp}-${attempt}`;
    try {
      copyFileSync(path, candidate, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
    chmodSync(candidate, mode);
    return candidate;
  }
  throw new Error(`no free backup name next to ${path}`);
}

/**
 * Write `value` as JSON to `path`. An existing file is backed up first, rewritten
 * through a temporary file in the same directory, and keeps its permissions. A
 * symlink is followed, so the link survives and the real file is the one changed.
 * Returns false when the file was refused; the caller decides what that means.
 */
function saveJson(path, value, indent, stamp) {
  const target = existsSync(path) ? realpathSync(path) : path;
  const existed = existsSync(target);
  if (existed && !isWritable(target)) {
    refuse(`${path} is not writable`);
    return false;
  }

  const mode = existed ? statSync(target).mode & 0o777 : undefined;
  const temporary = `${target}.aies-${process.pid}.tmp`;
  const text = `${JSON.stringify(value, null, indent)}\n`;
  let backup;
  try {
    mkdirSync(dirname(target), { recursive: true });
    if (existed) backup = backupFile(target, stamp);
    writeFileSync(temporary, text);
    if (mode !== undefined) chmodSync(temporary, mode);
    renameSync(temporary, target);
  } catch (error) {
    removeQuietly(temporary);
    if (backup) removeQuietly(backup);
    refuse(`cannot update ${path} (${errorCode(error)})`);
    return false;
  }

  if (backup) warn(`backed up ${path} to ${backup} before changing it`);
  return true;
}

/**
 * Ensure every package the AIES profile declares is present. User-added packages
 * are preserved; a non-array `packages` field is never rewritten.
 */
function reconcilePackages(stamp) {
  const templatePath = join(TEMPLATE_DIR, "settings.json");
  const targetPath = join(AGENT_DIR, "settings.json");
  if (!existsSync(templatePath)) return;

  const template = readJson(templatePath);
  if (!template.ok || !isPlainObject(template.value)) return;
  const required = Array.isArray(template.value.packages) ? template.value.packages.filter((s) => typeof s === "string") : [];
  if (required.length === 0) return;

  let current = {};
  let indent = 2;
  if (existsSync(targetPath)) {
    const loaded = readJson(targetPath);
    if (!loaded.ok) return;
    current = loaded.value;
    indent = loaded.indent;
  }
  if (!isPlainObject(current)) {
    refuse(`${targetPath} is not a JSON object`);
    return;
  }
  if (current.packages !== undefined && !Array.isArray(current.packages)) {
    refuse(`${targetPath} has a non-array "packages" field`);
    return;
  }

  const packages = Array.isArray(current.packages) ? [...current.packages] : [];
  const missing = required.filter((source) => !packages.includes(source));
  if (missing.length === 0) return;

  if (saveJson(targetPath, { ...current, packages: [...missing, ...packages] }, indent, stamp)) {
    process.stdout.write(`aies: profile declares ${missing.join(", ")}\n`);
  }
}

/** The names and differing keys of two entries. Keys are names; values are never returned. */
function differingKeys(left, right) {
  if (!isPlainObject(left) || !isPlainObject(right)) return ["(entire entry)"];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].filter((key) => !isDeepStrictEqual(left[key], right[key])).sort();
}

/** Report template servers the profile declares differently. Informational: the run still succeeds. */
function reportDifferences(path, declared, existing) {
  for (const name of Object.keys(declared)) {
    if (!Object.hasOwn(existing, name) || isDeepStrictEqual(existing[name], declared[name])) continue;
    const keys = differingKeys(existing[name], declared[name]);
    warn(`MCP server "${name}" in ${path} differs from the AIES template (keys: ${keys.join(", ")}); existing values were kept`);
  }
}

/** Absent means ENOENT on the path itself, so a dangling symlink still counts as present. */
function isMissing(path) {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

/**
 * The `mcpExcluded` list of aies.json. An absent file or key excludes nothing. An
 * unreadable file or a malformed list returns `ok: false`, and the caller adds no
 * MCP server, because an excluded server could come back.
 */
function readExcludedServers(path) {
  if (isMissing(path)) return { ok: true, names: new Set() };
  const loaded = readJson(path);
  if (!loaded.ok) return { ok: false };
  if (!isPlainObject(loaded.value)) {
    refuse(`${path} is not a JSON object`);
    return { ok: false };
  }
  if (!Object.hasOwn(loaded.value, "mcpExcluded")) return { ok: true, names: new Set() };
  const list = loaded.value.mcpExcluded;
  if (!Array.isArray(list) || !list.every((name) => typeof name === "string")) {
    refuse(`${path} has no valid "mcpExcluded" list of server names`);
    return { ok: false };
  }
  return { ok: true, names: new Set(list) };
}

/** The template with the excluded servers removed. Every template-derived write starts from it. */
function withoutExcluded(template, excluded) {
  if (excluded.size === 0 || !isPlainObject(template.mcpServers)) return template;
  const mcpServers = Object.fromEntries(Object.entries(template.mcpServers).filter(([name]) => !excluded.has(name)));
  return { ...template, mcpServers };
}

/** One informational line per run for template servers that were left out on purpose. Names only. */
function reportExclusions(names) {
  if (names.length === 0) return;
  const noun = names.length === 1 ? "server" : "servers";
  warn(`not adding MCP ${noun} ${names.join(", ")}: excluded in aies.json (mcpExcluded)`);
}

/**
 * Add the MCP servers the template declares and the profile does not. An entry the
 * profile already declares is never replaced, and no other key is touched. Excluded
 * template servers are never added. A missing file is created from the template,
 * without the excluded servers.
 */
function reconcileServers(templatePath, targetPath, stamp, excluded) {
  if (!existsSync(templatePath)) return;
  const template = readJson(templatePath);
  if (!template.ok || !isPlainObject(template.value)) return;
  const declared = isPlainObject(template.value.mcpServers) ? template.value.mcpServers : {};

  if (!existsSync(targetPath)) {
    reportExclusions(Object.keys(declared).filter((name) => excluded.has(name)));
    if (saveJson(targetPath, withoutExcluded(template.value, excluded), 2, stamp)) {
      process.stdout.write(`aies: profile MCP config reconciled at ${targetPath}\n`);
    }
    return;
  }

  const loaded = readJson(targetPath);
  if (!loaded.ok) return;
  const current = loaded.value;
  if (!isPlainObject(current)) {
    refuse(`${targetPath} is not a JSON object`);
    return;
  }
  if (current.mcpServers !== undefined && !isPlainObject(current.mcpServers)) {
    refuse(`${targetPath} has no valid "mcpServers" object`);
    return;
  }

  const existing = current.mcpServers ?? {};
  reportDifferences(targetPath, declared, existing);

  const missing = Object.keys(declared).filter((name) => !Object.hasOwn(existing, name));
  reportExclusions(missing.filter((name) => excluded.has(name)));
  const added = missing.filter((name) => !excluded.has(name));
  if (added.length === 0) return;

  const mcpServers = { ...existing };
  for (const name of added) mcpServers[name] = declared[name];
  if (saveJson(targetPath, { ...current, mcpServers }, loaded.indent, stamp)) {
    process.stdout.write(`aies: profile MCP config reconciled at ${targetPath}; added ${added.join(", ")}\n`);
  }
}

/**
 * v3 migration: the legacy mcp.json is merged into mcp-adapter.json (template as the
 * base, legacy next, destination values last). The legacy file is removed only after
 * the merged file reads back intact. Both files are backed up before they change.
 */
function migrateLegacy(legacyPath, targetPath, templatePath, stamp, excluded) {
  const legacy = readJson(legacyPath);
  if (!legacy.ok) return;
  if (!isPlainObject(legacy.value)) {
    refuse(`${legacyPath} is not a JSON object`);
    return;
  }

  const template = existsSync(templatePath) ? readJson(templatePath) : { ok: true, value: {} };
  if (!template.ok || !isPlainObject(template.value)) return;

  // An excluded server never comes from the template: not as the base of a merge, not as a new entry.
  const base = withoutExcluded(template.value, excluded);
  let current = { ...base };
  let indent = 2;
  const targetExists = existsSync(targetPath);
  if (targetExists) {
    const loaded = readJson(targetPath);
    if (!loaded.ok) return;
    if (!isPlainObject(loaded.value)) {
      refuse(`${targetPath} is not a JSON object`);
      return;
    }
    current = loaded.value;
    indent = loaded.indent;
  }

  const next = mergeObjects(mergeObjects(base, legacy.value), current);
  if (!isPlainObject(next.mcpServers)) {
    refuse(`${targetPath} has no valid "mcpServers" object after migration`);
    return;
  }
  const serversOf = (value) => (isPlainObject(value?.mcpServers) ? value.mcpServers : {});
  if (targetExists) reportDifferences(targetPath, serversOf(template.value), serversOf(current));
  reportExclusions(
    Object.keys(serversOf(template.value)).filter(
      (name) => excluded.has(name) && !Object.hasOwn(serversOf(legacy.value), name) && !Object.hasOwn(serversOf(current), name),
    ),
  );

  if (!saveJson(targetPath, next, indent, stamp)) return;

  const validated = readJson(targetPath);
  if (!validated.ok) return;
  if (!isDeepStrictEqual(validated.value, next)) {
    exitStatus = 1;
    warn(`${targetPath} did not read back as written; keeping ${legacyPath}`);
    return;
  }

  try {
    const backup = backupFile(legacyPath, stamp);
    unlinkSync(legacyPath);
    warn(`removed ${legacyPath} after migration; its content is kept at ${backup}`);
  } catch (error) {
    exitStatus = 1;
    warn(`cannot remove ${legacyPath} (${errorCode(error)}); it is kept`);
    return;
  }
  process.stdout.write(`aies: profile MCP config migrated to ${targetPath}; removed legacy ${legacyPath}\n`);
}

/**
 * Keep the MCP config format aligned with the installed adapter generation. v3
 * reads mcp-adapter.json only; v2 reads mcp.json. If the package is not installed
 * yet, use the current v3 format so the first Pi launch cannot produce a warning.
 */
function reconcileMcpConfig(stamp, excluded) {
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
  if (isV2) {
    reconcileServers(legacyTemplatePath, mcpJsonPath, stamp, excluded);
    return;
  }

  if (!existsSync(mcpJsonPath)) {
    reconcileServers(adapterTemplatePath, mcpAdapterPath, stamp, excluded);
    return;
  }
  migrateLegacy(mcpJsonPath, mcpAdapterPath, adapterTemplatePath, stamp, excluded);
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
  const stamp = backupStamp();
  reconcilePackages(stamp);

  const exclusions = readExcludedServers(join(AGENT_DIR, "aies.json"));
  if (!exclusions.ok) {
    warn("no MCP server is added while aies.json cannot be read, so an excluded server cannot come back");
    return;
  }
  reconcileMcpConfig(stamp, exclusions.names);
}

try {
  main();
} catch (error) {
  exitStatus = 1;
  warn(`profile reconciliation stopped by an unexpected error (${errorCode(error)}); no further changes were made`);
}
process.exitCode = exitStatus;
