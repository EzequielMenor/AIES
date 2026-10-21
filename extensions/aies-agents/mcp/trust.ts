/**
 * Trust in the MCP profile the adapter loads (D38, option A: a closed trusted MCP profile).
 *
 * The Plane write guard used to reconstruct how pi-mcp-adapter names servers and tools, and every
 * round showed another form. This module replaces that reconstruction with one predicate. A profile
 * is trusted only when it has exactly the shape AIES approved, and then attribution is plain string
 * equality with the declared server names. Any other profile is untrusted, and an untrusted profile
 * refuses every tool that is not a Pi base tool or an AIES tool (`NON_MCP_TOOL_NAMES`).
 *
 * The approved shape is the repository template `profile/mcp-adapter.json`, located relative to this
 * file. A server that becomes trusted later (Engram, for example) is added to the template; the guard
 * itself does not change.
 *
 * A profile is trusted when ALL of these hold:
 * - `PI_MCP_CONFIG_MODE` is exactly `exclusive`, so the adapter reads only the files below;
 * - `PI_CODING_AGENT_DIR` resolves, and the adapter's file exists and is a JSON object: the path given
 *   with `--mcp-config` in argv (`mcpConfigPathFromArgv`, the adapter's own parser), or
 *   `$PI_CODING_AGENT_DIR/mcp-adapter.json`;
 * - the legacy `$PI_CODING_AGENT_DIR/mcp.json` is absent, blank, or passes the same rules (the adapter
 *   reads it as a superset);
 * - `MCP_DIRECT_TOOLS` is blank, and the files have no `imports`, no `claudePlugins`, no non-empty
 *   `mcp-servers`, no top-level key outside `mcpServers`, `settings` and `$schema`, no
 *   `settings.agentPluginPaths`, no `settings.toolPrefix` other than `server`, and no `settings.directTools`;
 * - every declared server is named as in the template (exact, case-sensitive), and its definition has
 *   only `url`, `auth`, `lifecycle`, `disabled` and `directTools` keys, with `url` and `auth` equal to
 *   the template's, and `directTools` absent or `false`.
 * A subset of the template is trusted, and so is a profile with no server.
 *
 * Session snapshot: `initMcpTrust` judges the profile when the extension loads and keeps a digest of
 * the files it read. `currentMcpTrust` re-reads the files on every call (cached by stamp) and returns
 * the trust in force: the trust at start AND an unchanged profile. The adapter does not reload in
 * place, so a profile that was hostile at start and was repaired later stays untrusted, and an edit
 * can only lower trust, never raise it.
 *
 * Residual, stated plainly: nothing stops the Parent's `edit`, `write` or `bash` from changing a
 * profile file (D38 removed the path guard on purpose). The snapshot is the guarantee: such an edit
 * can only lower trust, and only from the next session on.
 *
 * Pure reads, no network, no credential. Profile contents are never logged or returned: callers get
 * a verdict and a short reason, never a value from the file.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface McpTrust {
  /** True when the profile has the approved shape and has not changed since it was read at start. */
  readonly trusted: boolean;
  /** The declared server names of a trusted profile. Empty when there are none, and when untrusted. */
  readonly servers: ReadonlySet<string>;
  /** Why the profile is not trusted, in short Spanish. Empty when it is trusted. */
  readonly reason: string;
}

/**
 * The only tool names a call may have on an untrusted profile: Pi's built-in tools that AIES wraps
 * (`aies-runtime/quiet-tools.ts`, `QUIET_TOOL_NAMES`), `tgrep` (`aies-agents/tgrep.ts`, for Explore
 * agents), and the tools AIES registers (`aies_ticket` in `linear/tool.ts`, `aies_delegate` in
 * `delegate.ts`, `aies_verify_complete` in `verify.ts`, and the two read-only Parent memory tools in
 * `aies-memory/index.ts`). A new AIES tool is listed here; the test
 * `tests/mcp-trust.test.mjs` fails when an `aies_*` name or a registered tool is missing.
 */
export const NON_MCP_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "tgrep",
  "aies_ticket",
  "aies_delegate",
  "aies_verify_complete",
  "aies_memory_search",
  "aies_memory_context",
]);

/** The files the adapter 3.2.0 reads under exclusive mode (`config.ts`, `getConfigSources`). */
const MAIN_FILE = "mcp-adapter.json";
const LEGACY_FILE = "mcp.json";

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(["mcpServers", "settings", "$schema"]);
const SERVER_KEYS: ReadonlySet<string> = new Set(["url", "auth", "lifecycle", "disabled", "directTools"]);

interface ApprovedServer {
  readonly url: unknown;
  readonly auth: unknown;
}

/** The repository template, read once per process; `null` when it cannot be read or is malformed. */
let templateCache: ReadonlyMap<string, ApprovedServer> | null | undefined;

function approvedServers(): ReadonlyMap<string, ApprovedServer> | null {
  if (templateCache === undefined) templateCache = loadTemplate();
  return templateCache;
}

function loadTemplate(): ReadonlyMap<string, ApprovedServer> | null {
  const path = fileURLToPath(new URL("../../../profile/mcp-adapter.json", import.meta.url));
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isRecord(raw.mcpServers)) return null;
  const servers = new Map<string, ApprovedServer>();
  for (const [name, definition] of Object.entries(raw.mcpServers)) {
    if (!isRecord(definition)) return null;
    servers.set(name, { url: definition.url, auth: definition.auth });
  }
  return servers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function untrusted(reason: string): McpTrust {
  return { trusted: false, servers: new Set<string>(), reason };
}

/** `PI_CODING_AGENT_DIR` as the adapter resolves it (`agent-dir.ts`, `getAgentDir`), or undefined. */
function agentDirFrom(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return undefined;
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return resolve(homedir(), configured.slice(2));
  return resolve(configured);
}

/**
 * The `--mcp-config` path the adapter would read, mirroring its argv parser (`utils.ts`,
 * `getConfigPathFromArgv`): a bad value resets it, and `--` ends the scan.
 */
export function mcpConfigPathFromArgv(argv: readonly string[]): string | undefined {
  let configPath: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") break;
    if (arg === "--mcp-config") {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith("-") && !value.startsWith("@")) {
        configPath = value;
        index += 1;
      } else {
        configPath = undefined;
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) configPath = arg.slice("--mcp-config=".length);
  }
  return configPath;
}

/** A cheap identity of a file: absent, unreadable, or its size, mtime and ctime. */
function fileStamp(path: string): string {
  try {
    const stats = statSync(path);
    return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
}

/** Text of a file, `null` when absent, `undefined` when it cannot be read. Cached by stamp. */
const textCache = new Map<string, { stamp: string; text: string | null | undefined }>();

function readText(path: string): string | null | undefined {
  const stamp = fileStamp(path);
  const cached = textCache.get(path);
  if (cached && cached.stamp === stamp) return cached.text;
  let text: string | null | undefined;
  if (stamp === "absent") {
    text = null;
  } else {
    try {
      text = readFileSync(path, "utf-8");
    } catch (error) {
      text = (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
    }
  }
  textCache.set(path, { stamp, text });
  return text;
}

interface ProfileFile {
  readonly path: string;
  /** The adapter's main file: a missing or blank one is not trusted. */
  readonly required: boolean;
  /** The file text, or `null` when the file is absent. */
  readonly text: string | null;
}

type ProfileRead = { ok: true; files: ProfileFile[] } | { ok: false; reason: string };

/** The files the adapter reads for this process, under the same mode and environment checks. */
function readProfile(env: NodeJS.ProcessEnv, argv: readonly string[]): ProfileRead {
  if (env.PI_MCP_CONFIG_MODE !== "exclusive") {
    return { ok: false, reason: "el perfil MCP no se carga en modo exclusive" };
  }
  if ((env.MCP_DIRECT_TOOLS ?? "").trim() !== "") {
    return { ok: false, reason: "MCP_DIRECT_TOOLS activa herramientas directas" };
  }
  const agentDir = agentDirFrom(env);
  if (!agentDir) return { ok: false, reason: "PI_CODING_AGENT_DIR no está definido" };

  const override = mcpConfigPathFromArgv(argv);
  const mainPath = override ? resolve(override) : join(agentDir, MAIN_FILE);
  const legacyPath = join(agentDir, LEGACY_FILE);
  const mainText = readText(mainPath);
  const legacyText = readText(legacyPath);
  if (mainText === undefined || legacyText === undefined) {
    return { ok: false, reason: "un fichero de servidores MCP no es legible" };
  }
  return {
    ok: true,
    files: [
      { path: mainPath, required: true, text: mainText },
      { path: legacyPath, required: false, text: legacyText },
    ],
  };
}

function digestOf(files: readonly ProfileFile[]): string {
  return createHash("sha256")
    .update(JSON.stringify(files.map((file) => [file.path, file.text])), "utf8")
    .digest("hex");
}

/** Whether a direct-tools setting is on: any value but `false`, or absent. */
function directToolsOn(value: unknown): boolean {
  return value !== undefined && value !== false;
}

function settingsProblem(settings: unknown): string | undefined {
  if (settings === undefined) return undefined;
  if (!isRecord(settings)) return "settings no es un objeto";
  if (settings.agentPluginPaths !== undefined) return "el perfil declara rutas de plugins";
  if (settings.toolPrefix !== undefined && settings.toolPrefix !== "server") {
    return "el prefijo de herramientas no es el del adaptador";
  }
  if (directToolsOn(settings.directTools)) return "las herramientas directas están activas";
  return undefined;
}

function serverProblem(definition: unknown, approved: ApprovedServer | undefined): string | undefined {
  if (!approved) return "un servidor MCP no está en la plantilla aprobada";
  if (!isRecord(definition)) return "la definición de un servidor MCP no es un objeto";
  for (const key of Object.keys(definition)) {
    if (!SERVER_KEYS.has(key)) return "un servidor MCP tiene una clave no aprobada";
  }
  if (definition.url !== approved.url) return "la URL de un servidor MCP no es la de la plantilla";
  if (definition.auth !== approved.auth) return "la autenticación de un servidor MCP no es la de la plantilla";
  if (definition.lifecycle !== undefined && typeof definition.lifecycle !== "string") {
    return "el lifecycle de un servidor MCP no es texto";
  }
  if (definition.disabled !== undefined && typeof definition.disabled !== "boolean") {
    return "el campo disabled de un servidor MCP no es booleano";
  }
  if (directToolsOn(definition.directTools)) return "un servidor MCP tiene herramientas directas";
  return undefined;
}

/** The reason one file breaks the rules, or undefined. Declared server names are added to `declared`. */
function fileProblem(text: string, required: boolean, approved: ReadonlyMap<string, ApprovedServer>, declared: Set<string>): string | undefined {
  if (text.trim() === "") return required ? "el fichero de servidores MCP está vacío" : undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "el fichero de servidores MCP no es JSON válido";
  }
  if (!isRecord(raw)) return "el fichero de servidores MCP no es un objeto JSON";
  if (raw.imports !== undefined) return "el perfil importa otras configuraciones";
  if (raw.claudePlugins !== undefined) return "el perfil declara plugins de Claude";
  if (raw["mcp-servers"] !== undefined && !(isRecord(raw["mcp-servers"]) && Object.keys(raw["mcp-servers"]).length === 0)) {
    return "el perfil declara mcp-servers";
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key) && key !== "mcp-servers") return "el fichero tiene una clave de nivel superior no aprobada";
  }
  const settings = settingsProblem(raw.settings);
  if (settings) return settings;

  if (raw.mcpServers === undefined) return undefined;
  if (!isRecord(raw.mcpServers)) return "mcpServers no es un objeto";
  for (const [name, definition] of Object.entries(raw.mcpServers)) {
    const problem = serverProblem(definition, approved.get(name));
    if (problem) return problem;
    declared.add(name);
  }
  return undefined;
}

/** The verdict for the files as they are now. Pure over the texts; memoised by the texts it saw last. */
let verdictMemo: { key: string; verdict: McpTrust } | undefined;

function judge(files: readonly ProfileFile[]): McpTrust {
  const key = JSON.stringify(files.map((file) => [file.path, file.text]));
  if (verdictMemo?.key === key) return verdictMemo.verdict;

  const approved = approvedServers();
  let verdict: McpTrust;
  if (!approved) {
    verdict = untrusted("la plantilla aprobada del repo no es legible");
  } else {
    const declared = new Set<string>();
    verdict = { trusted: true, servers: declared, reason: "" };
    for (const file of files) {
      if (file.text === null) {
        if (file.required) verdict = untrusted("falta el fichero de servidores MCP del perfil");
        continue;
      }
      const problem = fileProblem(file.text, file.required, approved, declared);
      if (problem) {
        verdict = untrusted(problem);
        break;
      }
    }
  }
  verdictMemo = { key, verdict };
  return verdict;
}

/**
 * The trust verdict for the profile as it is on disk now. Pure with respect to the process: it does
 * not record a snapshot. `initMcpTrust` and `currentMcpTrust` are the session entry points.
 */
export function evaluateMcpTrust(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): McpTrust {
  const read = readProfile(env, argv);
  return read.ok ? judge(read.files) : untrusted(read.reason);
}

interface Snapshot {
  readonly verdict: McpTrust;
  /** Digest of the files read at start. Empty when they could not be read. */
  readonly digest: string;
}

let snapshot: Snapshot | undefined;

/**
 * Judge the profile once, when the extension loads, and keep the digest of the files it read. Call
 * it at startup, before any tool call. A later call replaces the snapshot, as a fresh session does.
 */
export function initMcpTrust(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): McpTrust {
  const read = readProfile(env, argv);
  if (!read.ok) {
    const verdict = untrusted(read.reason);
    snapshot = { verdict, digest: "" };
    return verdict;
  }
  const verdict = judge(read.files);
  snapshot = { verdict, digest: digestOf(read.files) };
  return verdict;
}

/**
 * The trust in force for one call: the verdict at start, and only while the profile is unchanged
 * since then. Without a snapshot the profile is untrusted (fail closed).
 */
export function currentMcpTrust(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): McpTrust {
  if (!snapshot) return untrusted("el perfil MCP no se leyó al arrancar la sesión");
  if (!snapshot.verdict.trusted) return snapshot.verdict;
  const read = readProfile(env, argv);
  if (!read.ok) return untrusted(read.reason);
  if (digestOf(read.files) !== snapshot.digest) {
    return untrusted("el perfil MCP cambió después de arrancar la sesión");
  }
  return snapshot.verdict;
}
