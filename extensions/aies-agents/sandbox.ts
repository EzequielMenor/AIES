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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
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

const VERIFY_ALLOWED_OUTPUT_SUBDIRS = [
  ".cache",
  "coverage",
  "dist",
  "build",
  "node_modules/.cache",
  ".tmp",
];

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

  for (const subDir of VERIFY_ALLOWED_OUTPUT_SUBDIRS) {
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

  const wrappedCommand = await SandboxManager.wrapWithSandbox(command);

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
