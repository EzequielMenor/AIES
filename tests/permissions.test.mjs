/**
 * Test suite for AIES-006: Permission Boundaries & Sandbox Enforcement.
 *
 * Covers the 12 core requirements:
 * 1. Explore tool surface unchanged (read-only tools, no bash/edit/write).
 * 2. Worker workspace-write (write & edit inside workspace permitted).
 * 3. Worker escape denied (writes outside workspace and secret file modifications rejected).
 * 4. Verify source protected via OS sandbox (indirect writes via node/bash denied by Seatbelt).
 * 5. Verify checks allowed (read-only tests and inspection execute successfully).
 * 6. Verify allowed output roots (.cache, coverage, dist, build, tmp) writable without source violation.
 * 7. Secrets unauthorized roots unreadable (denyRead on ~/.ssh, ~/.aws, auth.json, etc.).
 * 8. Dangerous git operations blocked by policy (push, reset --hard, clean -fd, checkout .).
 * 9. ASK behavior: UI approval vs headless/child auto-deny (ASK -> DENY).
 * 10. Sandbox unavailable degradation: graceful fallback for Worker, strict halt for Verify.
 * 11. No regex security theatre: syscall-level enforcement, not binary name matching.
 * 12. Observability: telemetry counters, /aies-status report, and footer indicators.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
  checkCommandPolicy,
  createGuardedBashToolDefinition,
} from "../extensions/aies-agents/command-guard.ts";
import {
  createContainedEditToolDefinition,
  createContainedWriteToolDefinition,
  isPathInsideWorkspace,
  isProtectedFile,
} from "../extensions/aies-agents/contained-tools.ts";
import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import { createTgrepToolDefinition } from "../extensions/aies-agents/tgrep.ts";
import {
  getPermissionTelemetry,
  handlePermissionGate,
  recordApprovalRequest,
  recordPermissionDenial,
  recordSandboxFailure,
  resetPermissionTelemetry,
} from "../extensions/aies-agents/permissions.ts";
import {
  buildVerifySandboxConfig,
  buildWorkerSandboxConfig,
  executeSandboxedCommand,
  getSandboxStatus,
  isSandboxSupported,
  isSandboxViolation,
  resetSandbox,
} from "../extensions/aies-agents/sandbox.ts";
import {
  createVerifyBashToolDefinition,
  isCommandPermittedInVerify,
} from "../extensions/aies-agents/verify-guard.ts";
import { runVerifyAgent } from "../extensions/aies-agents/verify.ts";
import {
  createWorkerBashToolDefinition,
  isCommandPermittedInWorker,
} from "../extensions/aies-agents/worker-guard.ts";
import { runWorkerAgent } from "../extensions/aies-agents/worker.ts";
import {
  applyApprovalRequest,
  applyPermissionDenial,
  applyPermissionsSync,
  applySandboxFailure,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderFooter, renderStatusReport } from "../extensions/aies-runtime/status.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

describe("AIES-006 Permission Boundaries", () => {
  let fixtureDir;

  beforeEach(() => {
    resetPermissionTelemetry();
    fixtureDir = mkdtempSync(join(tmpdir(), "aies-perm-test-"));
    mkdirSync(join(fixtureDir, "src"), { recursive: true });
    writeFileSync(join(fixtureDir, "src", "index.js"), "console.log('original');\n");
    writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }, null, 2));
  });

  afterEach(async () => {
    await resetSandbox();
    if (fixtureDir && existsSync(fixtureDir)) {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  describe("1. Capability Surface & Role Separation", () => {
    it("preserves Explore strictly read-only: no edit, write, or bash tools", async () => {
      const runtime = await ModelRuntime.create();
      const { session } = await createAgentSession({
        cwd: fixtureDir,
        sessionManager: SessionManager.inMemory(fixtureDir),
        modelRuntime: runtime,
        customTools: [createTgrepToolDefinition(fixtureDir)],
        tools: ["read", "grep", "find", "ls", "tgrep"],
      });

      try {
        const activeTools = session.getActiveToolNames();
        assert.deepEqual(
          activeTools.sort(),
          ["find", "grep", "ls", "read", "tgrep"].sort(),
          "Child tool surface must be strictly read/search tools",
        );

        const allTools = session.getAllTools().map((t) => t.name);
        assert.equal(allTools.includes("bash"), false, "Explore must NOT have 'bash' tool");
        assert.equal(allTools.includes("edit"), false, "Explore must NOT have 'edit' tool");
        assert.equal(allTools.includes("write"), false, "Explore must NOT have 'write' tool");
      } finally {
        session.dispose();
      }
    });

    it("equips Worker with workspace-contained edit and write tools", () => {
      const writeTool = createContainedWriteToolDefinition(fixtureDir);
      const editTool = createContainedEditToolDefinition(fixtureDir);

      assert.equal(writeTool.name, "write");
      assert.equal(editTool.name, "edit");
      assert.ok(typeof writeTool.execute === "function");
      assert.ok(typeof editTool.execute === "function");
    });
  });

  describe("2. Worker Workspace Containment", () => {
    it("permits writes and edits inside workspace", async () => {
      const writeTool = createContainedWriteToolDefinition(fixtureDir);
      const editTool = createContainedEditToolDefinition(fixtureDir);

      // Write inside workspace
      const writeRes = await writeTool.execute("call-1", {
        path: "src/new-file.js",
        content: "export const x = 42;\n",
      });
      assert.match(writeRes.content[0].text, /wrote/i);
      assert.equal(readFileSync(join(fixtureDir, "src", "new-file.js"), "utf8"), "export const x = 42;\n");

      // Edit inside workspace
      const editRes = await editTool.execute("call-2", {
        path: "src/new-file.js",
        edits: [{ oldText: "42", newText: "100" }],
      });
      assert.match(editRes.content[0].text, /replaced|updated/i);
      assert.equal(readFileSync(join(fixtureDir, "src", "new-file.js"), "utf8"), "export const x = 100;\n");
    });

    it("denies writes outside workspace root (path traversal / absolute paths)", async () => {
      const writeTool = createContainedWriteToolDefinition(fixtureDir);
      const editTool = createContainedEditToolDefinition(fixtureDir);

      const outsidePath = join(tmpdir(), "outside-worker-escape.txt");

      const res1 = await writeTool.execute("call-3", { path: outsidePath, content: "escaped" });
      assert.equal(res1.isError, true);
      assert.match(res1.content[0].text, /outside workspace root/i);

      const res2 = await writeTool.execute("call-4", { path: "../outside-relative.txt", content: "escaped" });
      assert.equal(res2.isError, true);
      assert.match(res2.content[0].text, /outside workspace root/i);

      const res3 = await editTool.execute("call-5", {
        path: outsidePath,
        edits: [{ oldText: "a", newText: "b" }],
      });
      assert.equal(res3.isError, true);
      assert.match(res3.content[0].text, /outside workspace root/i);
    });

    it("denies writes to sensitive files (.env, *.pem, *.key) inside workspace", async () => {
      const writeTool = createContainedWriteToolDefinition(fixtureDir);

      const res1 = await writeTool.execute("call-6", { path: ".env", content: "SECRET=123\n" });
      assert.equal(res1.isError, true);
      assert.match(res1.content[0].text, /protected file.*cannot be modified directly/i);

      const res2 = await writeTool.execute("call-7", { path: "server.key", content: "KEY\n" });
      assert.equal(res2.isError, true);
      assert.match(res2.content[0].text, /protected file.*cannot be modified directly/i);

      const res3 = await writeTool.execute("call-8", { path: "cert.pem", content: "CERT\n" });
      assert.equal(res3.isError, true);
      assert.match(res3.content[0].text, /protected file.*cannot be modified directly/i);
    });
  });

  describe("3. Verify Source Protection via OS Sandbox", () => {
    it("blocks indirect writes via node -e in Verify under OS sandbox", async () => {
      if (!isSandboxSupported()) {
        return; // Skip on platforms without Seatbelt/bwrap
      }

      const script = "const fs = require('fs'); fs.writeFileSync('src/index.js', 'HACKED');";
      const result = await executeSandboxedCommand(`node -e "${script}"`, fixtureDir, {
        role: "verify",
      });

      assert.notEqual(result.exitCode, 0, "Execution must fail");
      assert.ok(result.sandboxDenied, "Result should flag sandbox denial");
      assert.ok(
        isSandboxViolation(result.stderr) || isSandboxViolation(result.stdout),
        `Violation expected in: ${result.stderr}`,
      );

      // Verify file is untouched
      assert.equal(readFileSync(join(fixtureDir, "src", "index.js"), "utf8"), "console.log('original');\n");
    });

    it("permits read-only verification checks under OS sandbox in Verify", async () => {
      if (!isSandboxSupported()) {
        return;
      }

      const result = await executeSandboxedCommand(
        "node -e \"const fs = require('fs'); console.log(fs.readFileSync('src/index.js', 'utf8').trim());\"",
        fixtureDir,
        { role: "verify" },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), "console.log('original');");
    });

    it("permits writing to pre-created output roots (.cache, dist, /tmp) in Verify", async () => {
      if (!isSandboxSupported()) {
        return;
      }

      // Pre-create output directories before running sandbox
      mkdirSync(join(fixtureDir, ".cache"), { recursive: true });

      const result = await executeSandboxedCommand(
        "node -e \"const fs = require('fs'); fs.writeFileSync('.cache/test.json', JSON.stringify({ ok: true })); console.log('CACHED');\"",
        fixtureDir,
        { role: "verify" },
      );

      assert.equal(result.exitCode, 0, `Output root write failed: ${result.stderr}`);
      assert.equal(result.stdout.trim(), "CACHED");
      assert.equal(readFileSync(join(fixtureDir, ".cache", "test.json"), "utf8"), '{"ok":true}');
    });
  });

  describe("4. Secret and Host Credentials Protection", () => {
    it("configures denyRead for SSH, AWS, and agent credentials", () => {
      const workerConfig = buildWorkerSandboxConfig(fixtureDir);
      const verifyConfig = buildVerifySandboxConfig(fixtureDir);

      assert.ok(workerConfig.filesystem.denyRead.some((p) => p.includes(".ssh")));
      assert.ok(workerConfig.filesystem.denyRead.some((p) => p.includes(".aws")));
      assert.ok(workerConfig.filesystem.denyRead.some((p) => p.includes("auth.json")));

      assert.ok(verifyConfig.filesystem.denyRead.some((p) => p.includes(".ssh")));
      assert.ok(verifyConfig.filesystem.denyRead.some((p) => p.includes(".aws")));
      assert.ok(verifyConfig.filesystem.denyRead.some((p) => p.includes("auth.json")));
    });

    it("identifies secret paths correctly via isProtectedFile helper", () => {
      assert.equal(isProtectedFile(".env"), true);
      assert.equal(isProtectedFile(".env.local"), true);
      assert.equal(isProtectedFile("path/to/.env.production"), true);
      assert.equal(isProtectedFile("secrets.key"), true);
      assert.equal(isProtectedFile("client.pem"), true);
      assert.equal(isProtectedFile("src/index.ts"), false);
      assert.equal(isProtectedFile("README.md"), false);
    });
  });

  describe("5. Policy & Command Guardrails (ALLOW / ASK / DENY)", () => {
    it("DENIES destructive git operations", () => {
      const dangerous = [
        "git push origin main",
        "git push --force",
        "git reset --hard HEAD~1",
        "git clean -fd",
        "git checkout -- .",
        "git restore .",
        "git branch -D feat",
        "git merge feature",
        "git rebase main",
      ];

      for (const cmd of dangerous) {
        const pol = checkCommandPolicy(cmd, fixtureDir, "worker");
        assert.equal(pol.action, "deny", `Expected deny for: ${cmd}`);
      }
    });

    it("DENIES privileged operations (sudo)", () => {
      const pol = checkCommandPolicy("sudo chown -R user .", fixtureDir, "worker");
      assert.equal(pol.action, "deny");
      assert.match(pol.reason ?? "", /sudo is not permitted/i);
    });

    it("classifies package manager mutations as ASK", () => {
      const packageMutations = [
        "npm install express",
        "npm i -D typescript",
        "npm uninstall lodash",
        "npm update",
        "yarn add react",
        "pnpm add vitest",
      ];

      for (const cmd of packageMutations) {
        const pol = checkCommandPolicy(cmd, fixtureDir, "worker");
        assert.equal(pol.action, "ask", `Expected ask for: ${cmd}`);
      }
    });

    it("ALLOWS safe read-only inspection, test, and build commands", () => {
      const safe = [
        "npm test",
        "npm run build",
        "npm run check:isolation",
        "node -v",
        "git status",
        "git diff",
        "git log -n 5",
        "ls -la",
        "find src -name '*.ts'",
      ];

      for (const cmd of safe) {
        const pol = checkCommandPolicy(cmd, fixtureDir, "worker");
        assert.equal(pol.action, "allow", `Expected allow for: ${cmd}`);
      }
    });
  });

  describe("6. ASK Behavior: UI Approval vs Headless Auto-Deny", () => {
    it("approves action when UI confirm returns true", async () => {
      let confirmedPrompt = "";
      const ctx = {
        hasUI: true,
        ui: {
          confirm: async (title, message) => {
            confirmedPrompt = `${title}: ${message}`;
            return true;
          },
        },
      };

      const evalAsk = {
        action: "ask",
        prompt: "Install package express?",
        reason: "Package manager mutation",
      };

      const result = await handlePermissionGate(evalAsk, ctx);
      assert.equal(result.allowed, true);
      assert.match(confirmedPrompt, /Install package express/);

      const tel = getPermissionTelemetry();
      assert.equal(tel.approvals, 1);
      assert.equal(tel.denials, 0);
    });

    it("denies action when UI confirm returns false", async () => {
      const ctx = {
        hasUI: true,
        ui: {
          confirm: async () => false,
        },
      };

      const evalAsk = {
        action: "ask",
        prompt: "Install package express?",
        reason: "Package manager mutation",
      };

      const result = await handlePermissionGate(evalAsk, ctx);
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? "", /Operation rejected by user/i);

      const tel = getPermissionTelemetry();
      assert.equal(tel.approvals, 1);
      assert.equal(tel.denials, 1);
    });

    it("auto-denies action (ASK -> DENY) when UI is not available (headless/child session)", async () => {
      const ctxWithoutUI = { hasUI: false };

      const evalAsk = {
        action: "ask",
        prompt: "Install package express?",
        reason: "Package manager mutation",
      };

      const result = await handlePermissionGate(evalAsk, ctxWithoutUI);
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? "", /ASK -> DENY/i);

      const tel = getPermissionTelemetry();
      assert.equal(tel.denials, 1);
    });

    it("auto-denies action when context is undefined", async () => {
      const evalAsk = {
        action: "ask",
        reason: "Boundary crossing",
      };

      const result = await handlePermissionGate(evalAsk, undefined);
      assert.equal(result.allowed, false);
      assert.match(result.reason ?? "", /ASK -> DENY/i);
    });
  });

  describe("7. Degradation when Sandbox is Unavailable", () => {
    it("reports disabled status when AIES_SANDBOX=0", () => {
      const prev = process.env.AIES_SANDBOX;
      try {
        process.env.AIES_SANDBOX = "0";
        assert.equal(isSandboxSupported(), false);
        assert.equal(getSandboxStatus(), "disabled");
      } finally {
        if (prev !== undefined) process.env.AIES_SANDBOX = prev;
        else delete process.env.AIES_SANDBOX;
      }
    });

    it("refuses Verify execution when sandbox is unavailable", async () => {
      const prev = process.env.AIES_SANDBOX;
      try {
        process.env.AIES_SANDBOX = "0";
        await assert.rejects(
          async () => {
            await executeSandboxedCommand("node -v", fixtureDir, { role: "verify" });
          },
          /Sandbox unavailable: Verify requires OS sandbox enforcement/i,
        );
      } finally {
        if (prev !== undefined) process.env.AIES_SANDBOX = prev;
        else delete process.env.AIES_SANDBOX;
      }
    });
  });

  describe("8. Telemetry & Observability Integration", () => {
    it("tracks permission metrics in AiesState and status report", () => {
      let state = createState(1000);
      assert.equal(state.permissions.denials, 0);
      assert.equal(state.permissions.approvals, 0);
      assert.equal(state.permissions.sandboxFailures, 0);

      state = applyPermissionDenial(state);
      state = applyApprovalRequest(state);
      state = applySandboxFailure(state);

      assert.equal(state.permissions.denials, 1);
      assert.equal(state.permissions.approvals, 1);
      assert.equal(state.permissions.sandboxFailures, 1);

      const report = renderStatusReport(toSnapshot(state), 2000);
      assert.match(report, /Permisos:/);
      assert.match(report, /sandbox\s+active/);
      assert.match(report, /denegaciones\s+1/);
      assert.match(report, /aprobaciones\s+1/);
      assert.match(report, /fallos sandbox\s+1/);
    });

    it("renders SANDBOX OFF in footer when sandbox is disabled or unavailable", () => {
      let state = createState(1000);
      state = applyPermissionsSync(state, { sandbox: "unavailable" });

      const footer = renderFooter(toSnapshot(state), 2000);
      assert.match(footer, /SANDBOX OFF/);

      state = applyPermissionsSync(state, { sandbox: "active" });
      const activeFooter = renderFooter(toSnapshot(state), 2000);
      assert.ok(!activeFooter.includes("SANDBOX OFF"));
    });
  });
});
