/**
 * OS-level sandbox integration for AIES child agents (AIES-006).
 *
 * Uses @anthropic-ai/sandbox-runtime to enforce filesystem and network boundaries
 * at the operating system level (Apple Seatbelt / sandbox-exec on macOS,
 * bubblewrap on Linux).
 *
 * Enforces:
 * - Worker: workspace-write (can write to workspace and /tmp; cannot write outside).
 * - Verify: source-read-only (source files and .git are read-only; auxiliary output
 *   roots like .cache, coverage, dist, build and /tmp are writable).
 * - Secrets isolation: denied read access to ~/.ssh, ~/.aws, ~/.gnupg and explicit
 *   external secret fixtures without depending on host credentials leaking.
 * - Network isolation: disabled by default for both Worker and Verify child sessions.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  SandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type SandboxRole = "worker" | "verify";
export type SandboxStatus = "active" | "unavailable" | "disabled";

export interface SandboxConfigOptions {
  extraAllowWrite?: string[];
  extraDenyRead?: string[];
  extraDenyWrite?: string[];
  allowedDomains?: string[];
}

export interface SandboxExecutionOptions {
  role: SandboxRole;
  timeout?: number;
  signal?: AbortSignal;
  configOptions?: SandboxConfigOptions;
  env?: NodeJS.ProcessEnv;
}

export interface SandboxedCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sandboxDenied?: boolean;
}

let currentConfigRole: SandboxRole | null = null;
let currentConfigCwd: string | null = null;
let isInitialized = false;

/**
 * Determine if OS sandboxing is supported on the current platform and environment.
 */
export function isSandboxSupported(): boolean {
  if (process.env.AIES_SANDBOX === "0" || process.env.AIES_SANDBOX === "false") {
    return false;
  }
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return false;
  }
  try {
    return SandboxManager.isSupportedPlatform();
  } catch {
    return false;
  }
}

/**
 * Get current sandbox status.
 */
export function getSandboxStatus(): SandboxStatus {
  if (process.env.AIES_SANDBOX === "0" || process.env.AIES_SANDBOX === "false") {
    return "disabled";
  }
  return isSandboxSupported() ? "active" : "unavailable";
}

const COMMON_DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
];

export const DEFAULT_VERIFY_ALLOWED_OUTPUT_SUBDIRS: readonly string[] = [
  ".cache",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  "node_modules/.cache",
  ".tmp",
  ".astro",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
];

export const VERIFY_ALLOWED_OUTPUT_SUBDIRS = DEFAULT_VERIFY_ALLOWED_OUTPUT_SUBDIRS;

const FORBIDDEN_OUTPUT_ROOT_PARTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".vscode",
  ".cursor",
  ".idea",
  ".claude",
  ".superpowers",
  "openspec",
  ".agents",
  ".agent",
  ".pi",
  ".atl",
  ".codegraph",
  ".vercel",
  "src",
  "source",
  "lib",
  "app",
  "pages",
  "components",
  "test",
  "tests",
  "spec",
  "specs",
  "docs",
  "documentation",
  "public",
  "static",
  "scripts",
  "bin",
  "config",
]);

/**
 * Check if a candidate relative directory is safe to treat as an ephemeral/generated output root.
 */
export function isSafeGeneratedSubdir(subdir: string): boolean {
  const normalized = subdir.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized || normalized.includes("..") || normalized.includes("*") || normalized.includes("?")) {
    return false;
  }

  const parts = normalized.split("/");
  const rootPart = parts[0];
  const lower = normalized.toLowerCase();

  // Ephemeral OS files or log streams
  if (lower === ".ds_store" || lower === "thumbs.db" || lower.endsWith(".log")) {
    return false;
  }

  // Secrets, credentials, keys, auth
  if (
    lower.startsWith(".env") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower.includes("secret") ||
    lower.includes("credential") ||
    lower.includes("token") ||
    lower.includes("auth.json")
  ) {
    return false;
  }

  // VCS, tooling configs, or standard source directories
  if (FORBIDDEN_OUTPUT_ROOT_PARTS.has(rootPart)) {
    return false;
  }

  // Dependencies: only node_modules/.cache is allowed, never node_modules itself
  if (rootPart === "node_modules" && normalized !== "node_modules/.cache") {
    return false;
  }

  return true;
}

/**
 * Check if a directory inside workspaceRoot contains any git-tracked files.
 */
export function hasTrackedFilesInDir(workspaceRoot: string, subdir: string): boolean {
  try {
    const tracked = execFileSync("git", ["ls-files", subdir], {
      cwd: workspaceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return Boolean(tracked.trim());
  } catch {
    return false;
  }
}

/**
 * Resolve the complete list of allowed output subdirectories inside a workspace for Verify.
 * Combines built-in standard ephemeral directories with safe, git-ignored generated directories.
 * Strictly excludes ANY candidate directory that contains git-tracked files.
 */
export function resolveVerifyAllowedOutputSubdirs(workspaceRoot: string): string[] {
  const result = new Set<string>();

  // Filter default catalog: strictly exclude any directory containing git-tracked files
  for (const candidate of DEFAULT_VERIFY_ALLOWED_OUTPUT_SUBDIRS) {
    if (!hasTrackedFilesInDir(workspaceRoot, candidate)) {
      result.add(candidate);
    }
  }

  const gitignorePath = join(workspaceRoot, ".gitignore");

  if (existsSync(gitignorePath)) {
    try {
      const content = readFileSync(gitignorePath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
          continue;
        }
        const isExplicitDir = trimmed.endsWith("/");
        const candidate = trimmed.replace(/\/+$/, "");
        if (!isSafeGeneratedSubdir(candidate)) {
          continue;
        }

        const fullPath = join(workspaceRoot, candidate);
        const exists = existsSync(fullPath);
        if (exists) {
          try {
            if (!statSync(fullPath).isDirectory()) {
              continue;
            }
          } catch {
            continue;
          }
        } else if (!isExplicitDir) {
          continue;
        }

        // Validate that git actually ignores this path and that it contains no tracked files
        try {
          execFileSync("git", ["check-ignore", "-q", candidate], {
            cwd: workspaceRoot,
            stdio: "ignore",
          });
          if (!hasTrackedFilesInDir(workspaceRoot, candidate)) {
            result.add(candidate);
          }
        } catch {
          // If git check fails (not a git repo or not ignored), do not add unverified path
        }
      }
    } catch {
      // Best-effort reading of .gitignore
    }
  }

  return Array.from(result);
}

export function buildWorkspaceSecretPatterns(workspaceRoot: string): string[] {
  return [
    join(workspaceRoot, ".env"),
    join(workspaceRoot, ".env.*"),
    join(workspaceRoot, "**/.env*"),
    join(workspaceRoot, "*.pem"),
    join(workspaceRoot, "**/*.pem"),
    join(workspaceRoot, "*.key"),
    join(workspaceRoot, "**/*.key"),
  ];
}

/**
 * Build sandbox configuration for Worker role.
 */
export function buildWorkerSandboxConfig(
  workspaceRoot: string,
  options?: SandboxConfigOptions,
): SandboxRuntimeConfig {
  const agentDir = getAgentDir();
  const workspaceSecrets = buildWorkspaceSecretPatterns(workspaceRoot);
  const denyReadPaths = [
    ...COMMON_DENY_READ,
    join(agentDir, "auth.json"),
    ...workspaceSecrets,
    ...(options?.extraDenyRead ?? []),
  ];

  const allowWritePaths = [
    workspaceRoot,
    tmpdir(),
    "/tmp",
    ...(options?.extraAllowWrite ?? []),
  ];

  return {
    network: {
      allowedDomains: options?.allowedDomains ?? [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: denyReadPaths,
      allowWrite: allowWritePaths,
      denyWrite: [
        ...workspaceSecrets,
        ...(options?.extraDenyWrite ?? []),
      ],
    },
  };
}

/**
 * Build sandbox configuration for Verify role.
 * Source tree is strictly READ-ONLY. Only designated output roots are writable.
 */
export function buildVerifySandboxConfig(
  workspaceRoot: string,
  options?: SandboxConfigOptions,
): SandboxRuntimeConfig {
  const agentDir = getAgentDir();
  const workspaceSecrets = buildWorkspaceSecretPatterns(workspaceRoot);
  const denyReadPaths = [
    ...COMMON_DENY_READ,
    join(agentDir, "auth.json"),
    ...workspaceSecrets,
    ...(options?.extraDenyRead ?? []),
  ];

  // Pre-create output roots inside workspace if needed, so Seatbelt allows writing files inside them
  const allowedOutputRoots: string[] = [
    "/tmp",
    ...(options?.extraAllowWrite ?? []),
  ];

  const systemTmp = tmpdir();
  if (!workspaceRoot.startsWith(systemTmp) && !systemTmp.startsWith(workspaceRoot)) {
    allowedOutputRoots.push(systemTmp);
  }

  const allowedSubdirs = resolveVerifyAllowedOutputSubdirs(workspaceRoot);
  for (const subDir of allowedSubdirs) {
    const fullPath = join(workspaceRoot, subDir);
    try {
      if (!existsSync(fullPath)) {
        mkdirSync(fullPath, { recursive: true });
      }
    } catch {
      // Best effort pre-creation
    }
    allowedOutputRoots.push(fullPath);
  }

  return {
    network: {
      allowedDomains: options?.allowedDomains ?? [],
      deniedDomains: [],
    },
    filesystem: {
      denyRead: denyReadPaths,
      allowWrite: allowedOutputRoots,
      denyWrite: [
        ...workspaceSecrets,
        ...(options?.extraDenyWrite ?? []),
      ],
    },
  };
}

/**
 * Synchronize and activate the sandbox configuration for the target role and workspace.
 */
export async function syncSandboxConfig(
  role: SandboxRole,
  cwd: string,
  options?: SandboxConfigOptions,
): Promise<void> {
  const config =
    role === "worker"
      ? buildWorkerSandboxConfig(cwd, options)
      : buildVerifySandboxConfig(cwd, options);

  if (isInitialized && currentConfigRole === role && currentConfigCwd === cwd) {
    // Already in desired state
    return;
  }

  if (isInitialized) {
    try {
      await SandboxManager.updateConfig(config);
      currentConfigRole = role;
      currentConfigCwd = cwd;
      return;
    } catch {
      // If updateConfig fails, reset and re-initialize
      try {
        await SandboxManager.reset();
      } catch {}
      isInitialized = false;
    }
  }

  await SandboxManager.initialize(config);
  isInitialized = true;
  currentConfigRole = role;
  currentConfigCwd = cwd;

  // Ensure network listener is ready if configured
  if (config.network) {
    try {
      await SandboxManager.waitForNetworkInitialization();
    } catch {
      // Continue if network initialization is immediate or non-blocking
    }
  }
}

/**
 * Reset the sandbox runtime (e.g. at session end or test teardown).
 */
export async function resetSandbox(): Promise<void> {
  if (isInitialized) {
    try {
      await SandboxManager.reset();
    } finally {
      isInitialized = false;
      currentConfigRole = null;
      currentConfigCwd = null;
    }
  }
}

const SANDBOX_DENIAL_PATTERNS = [
  /operation not permitted/i,
  /permission denied/i,
  /sandbox-exec/i,
  /_SBX/i,
  /read-only file system/i,
];

/**
 * Check whether an error message or stderr string indicates a sandbox boundary violation.
 */
export function isSandboxViolation(text: string): boolean {
  return SANDBOX_DENIAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * macOS Keychain withdrawal for child sandboxes (AIES-006 credential invariant).
 *
 * `@anthropic-ai/sandbox-runtime` hard-codes `(allow mach-lookup)` for the two
 * Mach services Keychain Services needs and offers no option to withdraw them
 * (`allowMachLookup` only adds). A sandboxed child could therefore still call
 * `SecItemCopyMatching` - the primitive `pi-mcp-adapter` stores the host's MCP
 * credentials with - and read the host's tokens. File-level `denyRead` cannot
 * help: securityd reads the keychain, not the sandboxed process.
 *
 * SBPL decides an operation by its last matching rule - the runtime implements
 * its own read denies exactly that way - so appending denies after the runtime's
 * security block withdraws Keychain access from the whole sandboxed subtree.
 */
const MACOS_KEYCHAIN_SECURITY_BLOCK =
  "; Specific mach-lookup permissions for security operations\n" +
  '(allow mach-lookup (global-name "com.apple.SecurityServer"))';

const MACOS_KEYCHAIN_WITHDRAWAL = [
  "; AIES: the Keychain belongs to the host; children must not reach securityd",
  '(deny mach-lookup (global-name "com.apple.securityd.xpc"))',
  '(deny mach-lookup (global-name "com.apple.SecurityServer"))',
].join("\n");

/**
 * Withdraw macOS Keychain access from a Seatbelt-wrapped command.
 *
 * The profile is handed to `sandbox-exec -p` as shell-quoted text, so the injected
 * rules are kept apostrophe-free and leave that quoting untouched.
 *
 * Fail closed: a profile this function cannot recognise is a profile whose Keychain
 * access was NOT withdrawn, so running it would silently expose the host's
 * credentials to a child.
 */
export function withdrawKeychainAccess(wrappedCommand: string): string {
  const occurrences = wrappedCommand.split(MACOS_KEYCHAIN_SECURITY_BLOCK).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      "Refusing to run a sandboxed child command: the macOS Seatbelt profile did not contain " +
        `exactly one Keychain security block (found ${occurrences}), so the host Keychain could not be ` +
        "withdrawn and its credentials would be reachable from inside the sandbox",
    );
  }
  return wrappedCommand.replace(
    MACOS_KEYCHAIN_SECURITY_BLOCK,
    `${MACOS_KEYCHAIN_SECURITY_BLOCK}\n${MACOS_KEYCHAIN_WITHDRAWAL}`,
  );
}

/**
 * Execute a command inside the OS sandbox for the specified role.
 */
export async function executeSandboxedCommand(
  command: string,
  cwd: string,
  options: SandboxExecutionOptions,
): Promise<SandboxedCommandResult> {
  const { role, timeout, signal, configOptions, env } = options;

  if (!isSandboxSupported()) {
    if (role === "verify") {
      throw new Error(
        "Sandbox unavailable: Verify requires OS sandbox enforcement to guarantee source-read-only integrity",
      );
    }
    // Worker degraded fallback
    return executeUnsandboxedCommand(command, cwd, { timeout, signal, env });
  }

  if (!existsSync(cwd)) {
    throw new Error(`Working directory does not exist: ${cwd}`);
  }

  await syncSandboxConfig(role, cwd, configOptions);

  const wrapped = await SandboxManager.wrapWithSandbox(command);
  // Seatbelt profiles only exist on macOS; other platforms never carry this block.
  const wrappedCommand = process.platform === "darwin" ? withdrawKeychainAccess(wrapped) : wrapped;

  return new Promise((resolveResult, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn("bash", ["-c", wrappedCommand], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout * 1000);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    const onAbort = () => {
      child.kill("SIGKILL");
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      if (signal?.aborted) {
        return reject(new Error("aborted"));
      }

      if (timedOut) {
        return reject(new Error(`timeout:${timeout}`));
      }

      const exitCode = code ?? 0;
      const combinedOutput = `${stdoutBuffer}\n${stderrBuffer}`;
      const sandboxDenied = exitCode !== 0 && isSandboxViolation(combinedOutput);

      resolveResult({
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode,
        sandboxDenied,
      });
    });
  });
}

/**
 * Execute without sandbox (used for Worker degradation when sandbox is unavailable).
 */
function executeUnsandboxedCommand(
  command: string,
  cwd: string,
  options: { timeout?: number; signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<SandboxedCommandResult> {
  const { timeout, signal, env } = options;

  return new Promise((resolveResult, reject) => {
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;

    const child = spawn("bash", ["-c", command], {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (timeout && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout * 1000);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
    });

    const onAbort = () => {
      child.kill("SIGKILL");
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      if (signal?.aborted) {
        return reject(new Error("aborted"));
      }

      if (timedOut) {
        return reject(new Error(`timeout:${timeout}`));
      }

      resolveResult({
        stdout: stdoutBuffer,
        stderr: stderrBuffer,
        exitCode: code ?? 0,
        sandboxDenied: false,
      });
    });
  });
}
