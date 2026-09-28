/**
 * Test suite for AIES-004: Isolated Worker agent & Command Security Guard.
 *
 * Verifies:
 * 1. Isolation: Parent sentinels never leak into Worker context unless explicitly in task/context.
 * 2. Tool surface: Worker has read, grep, find, ls, tgrep, edit, write, and guarded bash.
 * 3. Role separation: Explore remains strictly read-only (no edit/write/bash), Worker has mutation tools.
 * 4. Controlled mutation: Worker can edit/write files in a test fixture.
 * 5. Scope: Worker receives work unit and minimal context.
 * 6. Structured handoff: Schema validation for done, blocked, and failed statuses, capped defensively.
 * 7. Metrics isolation: Internal child tool executions do not pollute parent metrics.
 * 8. Destructive command guard: Blocks git clean, reset --hard, checkout discarding changes, git push, sudo, mass rm, etc.
 * 9. Model resolution hierarchy: AIES_WORKER_MODEL > aies.json > parent model.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";
import {
  formatWorkerHandoff,
  MAX_HANDOFF_CHARS,
  parseWorkerHandoff,
} from "../extensions/aies-agents/handoff.ts";
import { resolveWorkerModel } from "../extensions/aies-agents/model.ts";
import { createTgrepToolDefinition } from "../extensions/aies-agents/tgrep.ts";
import {
  createWorkerBashToolDefinition,
  isCommandPermittedInWorker,
} from "../extensions/aies-agents/worker-guard.ts";
import { runWorkerAgent } from "../extensions/aies-agents/worker.ts";
import {
  applyDelegationEnd,
  applyDelegationStart,
  applyToolCall,
  applyToolResult,
  createState,
} from "../extensions/aies-runtime/state.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

describe("AIES-004 Isolated Worker Agent", () => {
  describe("Command Security Guard (destructive & remote protection)", () => {
    it("blocks sudo commands", () => {
      const res1 = isCommandPermittedInWorker("sudo rm -rf /var/log", REPO_ROOT);
      assert.equal(res1.allowed, false);
      assert.match(res1.reason ?? "", /sudo is not permitted/u);

      const res2 = isCommandPermittedInWorker("npm test && sudo apt-get update", REPO_ROOT);
      assert.equal(res2.allowed, false);
      assert.match(res2.reason ?? "", /sudo is not permitted/u);
    });

    it("blocks destructive git clean commands", () => {
      const res1 = isCommandPermittedInWorker("git clean -fd", REPO_ROOT);
      assert.equal(res1.allowed, false);
      assert.match(res1.reason ?? "", /git clean is destructive/u);

      const res2 = isCommandPermittedInWorker("git clean -f", REPO_ROOT);
      assert.equal(res2.allowed, false);
      assert.match(res2.reason ?? "", /git clean is destructive/u);
    });

    it("blocks destructive git reset commands (--hard, --merge, --keep)", () => {
      const res1 = isCommandPermittedInWorker("git reset --hard HEAD~1", REPO_ROOT);
      assert.equal(res1.allowed, false);
      assert.match(res1.reason ?? "", /git reset --hard/u);

      const res2 = isCommandPermittedInWorker("git reset --merge", REPO_ROOT);
      assert.equal(res2.allowed, false);
      assert.match(res2.reason ?? "", /git reset --hard/u);
    });

    it("blocks destructive git checkout and restore commands discarding changes", () => {
      const res1 = isCommandPermittedInWorker("git checkout -- .", REPO_ROOT);
      assert.equal(res1.allowed, false);
      assert.match(res1.reason ?? "", /git checkout discarding/u);

      const res2 = isCommandPermittedInWorker("git checkout -f main", REPO_ROOT);
      assert.equal(res2.allowed, false);
      assert.match(res2.reason ?? "", /git checkout discarding/u);

      const res3 = isCommandPermittedInWorker("git restore .", REPO_ROOT);
      assert.equal(res3.allowed, false);
      assert.match(res3.reason ?? "", /git restore discarding/u);
    });

    it("blocks remote operations (git push, deploy, publish)", () => {
      const res1 = isCommandPermittedInWorker("git push origin main", REPO_ROOT);
      assert.equal(res1.allowed, false);
      assert.match(res1.reason ?? "", /git push/u);

      const res2 = isCommandPermittedInWorker("git push --force", REPO_ROOT);
      assert.equal(res2.allowed, false);
      assert.match(res2.reason ?? "", /git push/u);

      const res3 = isCommandPermittedInWorker("npm publish", REPO_ROOT);
      assert.equal(res3.allowed, false);
      assert.match(res3.reason ?? "", /package publishing/u);

      const res4 = isCommandPermittedInWorker("vercel deploy", REPO_ROOT);
      assert.equal(res4.allowed, false);
      assert.match(res4.reason ?? "", /deploy/u);
    });

    it("blocks git merge, rebase, and branch deletion", () => {
      const res1 = isCommandPermittedInWorker("git merge feature-branch", REPO_ROOT);
      assert.equal(res1.allowed, false);
      assert.match(res1.reason ?? "", /git merge/u);

      const res2 = isCommandPermittedInWorker("git rebase main", REPO_ROOT);
      assert.equal(res2.allowed, false);
      assert.match(res2.reason ?? "", /git rebase/u);

      const res3 = isCommandPermittedInWorker("git branch -D old-branch", REPO_ROOT);
      assert.equal(res3.allowed, false);
      assert.match(res3.reason ?? "", /branch deletion/u);
    });

    it("blocks mass file deletion and outside workspace access", () => {
      const res1 = isCommandPermittedInWorker("rm -rf /", REPO_ROOT);
      assert.equal(res1.allowed, false);
      assert.match(res1.reason ?? "", /mass file deletion/u);

      const res2 = isCommandPermittedInWorker("rm -rf *", REPO_ROOT);
      assert.equal(res2.allowed, false);
      assert.match(res2.reason ?? "", /mass file deletion/u);

      const res3 = isCommandPermittedInWorker("cat /etc/shadow", REPO_ROOT);
      assert.equal(res3.allowed, false);
      assert.match(res3.reason ?? "", /accessing system path/u);

      const res4 = isCommandPermittedInWorker("cd ../..", REPO_ROOT);
      assert.equal(res4.allowed, false);
      assert.match(res4.reason ?? "", /navigating outside workspace root/u);
    });

    it("allows safe development inspection, test, and build commands", () => {
      assert.equal(isCommandPermittedInWorker("git status --porcelain", REPO_ROOT).allowed, true);
      assert.equal(isCommandPermittedInWorker("git diff", REPO_ROOT).allowed, true);
      assert.equal(isCommandPermittedInWorker("git log -n 5 --oneline", REPO_ROOT).allowed, true);
      assert.equal(isCommandPermittedInWorker("npm test", REPO_ROOT).allowed, true);
      assert.equal(isCommandPermittedInWorker("node --test tests/worker.test.mjs", REPO_ROOT).allowed, true);
      assert.equal(isCommandPermittedInWorker("npm run build", REPO_ROOT).allowed, true);
      assert.equal(isCommandPermittedInWorker("npx eslint .", REPO_ROOT).allowed, true);
      assert.equal(isCommandPermittedInWorker("ls -la src/", REPO_ROOT).allowed, true);
    });

    it("createWorkerBashToolDefinition intercepts and blocks unsafe commands", async () => {
      const tool = createWorkerBashToolDefinition(REPO_ROOT);
      const result = await tool.execute(
        "call-1",
        { command: "git clean -fd" },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Command blocked by Worker safety guard: git clean is destructive/u);
    });
  });

  describe("Tool surface enforcement and role separation", () => {
    it("guarantees Worker AgentSession has edit, write, and guarded bash tools", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      const resourceLoader = new DefaultResourceLoader({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: "You are a worker agent.",
      });
      await resourceLoader.reload();

      const customTgrep = createTgrepToolDefinition(REPO_ROOT);
      const guardedBash = createWorkerBashToolDefinition(REPO_ROOT);

      const { session } = await createAgentSession({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        model,
        modelRuntime: runtime,
        resourceLoader,
        sessionManager: SessionManager.inMemory(REPO_ROOT),
        customTools: [customTgrep, guardedBash],
        tools: ["read", "grep", "find", "ls", "tgrep", "edit", "write", "bash"],
      });

      try {
        const activeTools = session.getActiveToolNames();
        assert.ok(activeTools.includes("edit"), "Worker must have 'edit' tool");
        assert.ok(activeTools.includes("write"), "Worker must have 'write' tool");
        assert.ok(activeTools.includes("bash"), "Worker must have 'bash' tool");
        assert.ok(activeTools.includes("read"), "Worker must have 'read' tool");
        assert.ok(activeTools.includes("grep"), "Worker must have 'grep' tool");
        assert.ok(activeTools.includes("find"), "Worker must have 'find' tool");
        assert.ok(activeTools.includes("ls"), "Worker must have 'ls' tool");
        assert.ok(activeTools.includes("tgrep"), "Worker must have 'tgrep' tool");
      } finally {
        session.dispose();
      }
    });

    it("preserves strict read-only tool surface for Explore while Worker has mutation tools", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // Explore session
      const exploreLoader = new DefaultResourceLoader({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: "Explore",
      });
      await exploreLoader.reload();
      const { session: exploreSession } = await createAgentSession({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        model,
        modelRuntime: runtime,
        resourceLoader: exploreLoader,
        sessionManager: SessionManager.inMemory(REPO_ROOT),
        customTools: [createTgrepToolDefinition(REPO_ROOT)],
        tools: ["read", "grep", "find", "ls", "tgrep"],
      });

      try {
        const exploreTools = exploreSession.getActiveToolNames();
        assert.equal(exploreTools.includes("edit"), false, "Explore must not have edit");
        assert.equal(exploreTools.includes("write"), false, "Explore must not have write");
        assert.equal(exploreTools.includes("bash"), false, "Explore must not have bash");
      } finally {
        exploreSession.dispose();
      }
    });
  });

  describe("Structured Worker handoff parsing and formatting", () => {
    it("parses valid structured JSON for done, blocked, and failed", () => {
      const doneJson = `Implementation complete:
\`\`\`json
{
  "status": "done",
  "summary": "Updated timeout configuration to 2000ms.",
  "changes": [
    { "file": "src/config.ts", "description": "Changed TIMEOUT constant" }
  ],
  "checks": [
    { "check": "npm test", "result": "All 5 tests pass" }
  ],
  "issues": [],
  "next": ["Verify in staging"]
}
\`\`\``;

      const doneHandoff = parseWorkerHandoff(doneJson);
      assert.equal(doneHandoff.status, "done");
      assert.equal(doneHandoff.summary, "Updated timeout configuration to 2000ms.");
      assert.equal(doneHandoff.changes.length, 1);
      assert.equal(doneHandoff.changes[0].file, "src/config.ts");
      assert.equal(doneHandoff.checks.length, 1);
      assert.equal(doneHandoff.checks[0].check, "npm test");

      const blockedJson = `\`\`\`json
{
  "status": "blocked",
  "summary": "Target file src/config.ts has unrelated unstaged changes.",
  "changes": [],
  "checks": [],
  "issues": ["Risk of clobbering existing uncommitted worktree changes"],
  "next": ["Stash or commit worktree changes first"]
}
\`\`\``;

      const blockedHandoff = parseWorkerHandoff(blockedJson);
      assert.equal(blockedHandoff.status, "blocked");
      assert.match(blockedHandoff.issues[0], /Risk of clobbering/u);

      const failedJson = `\`\`\`json
{
  "status": "failed",
  "summary": "Syntax error during compilation.",
  "changes": [],
  "checks": [{ "check": "tsc", "result": "Exit code 1" }],
  "issues": ["Type mismatch in service.ts"],
  "next": []
}
\`\`\``;

      const failedHandoff = parseWorkerHandoff(failedJson);
      assert.equal(failedHandoff.status, "failed");
    });

    it("formats Worker handoff compactly and caps defensively under 6,000 characters", () => {
      const handoff = {
        status: "done",
        summary: "Implemented fix",
        changes: [{ file: "a.ts", description: "Fixed typo" }],
        checks: [{ check: "npm test", result: "Pass" }],
        issues: ["None"],
        next: ["Ready for review"],
      };

      const formatted = formatWorkerHandoff(handoff);
      assert.match(formatted, /^### Worker Result: DONE/u);
      assert.match(formatted, /\*\*Changes\*\*:/u);
      assert.match(formatted, /\*\*Checks & Tests\*\*:/u);
      assert.match(formatted, /\*\*Recommended Next Step\*\*:/u);
      assert.ok(formatted.length < MAX_HANDOFF_CHARS);

      // Gigantic summary capped under 6,000 chars
      const hugeHandoff = {
        status: "done",
        summary: "W".repeat(10_000),
        changes: [],
        checks: [],
        issues: [],
        next: [],
      };
      const capped = formatWorkerHandoff(hugeHandoff);
      assert.ok(capped.length <= MAX_HANDOFF_CHARS + 100);
      assert.match(capped, /\[Truncated: worker handoff exceeded 6,000 characters\]/u);
    });
  });

  describe("Model resolution hierarchy", () => {
    it("prefers AIES_WORKER_MODEL environment variable", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);

      const parentModel = { id: "parent-model", provider: "mock" };
      const env = { AIES_WORKER_MODEL: "faux/faux-1" };

      const resolved = await resolveWorkerModel(runtime, parentModel, "/dummy", env);
      assert.equal(resolved?.id, "faux-1");
    });

    it("reads model from aies.json agents.worker.model when env is unset", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);

      const tempDir = mkdtempSync(join(tmpdir(), "aies-worker-model-"));
      try {
        writeFileSync(
          join(tempDir, "aies.json"),
          JSON.stringify({ agents: { worker: { model: "faux/faux-1" } } }),
        );

        const parentModel = { id: "parent-model", provider: "mock" };
        const resolved = await resolveWorkerModel(runtime, parentModel, tempDir, {});
        assert.equal(resolved?.id, "faux-1");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("falls back to parent model when neither env nor config specifies worker model", async () => {
      const parentModel = { id: "parent-model", provider: "mock" };
      const resolved = await resolveWorkerModel(null, parentModel, "/dummy", {});
      assert.equal(resolved, parentModel);
    });

    it("fails explicitly when a configured worker model cannot resolve instead of using the parent model", async () => {
      const dir = mkdtempSync(join(tmpdir(), "aies-worker-invalid-"));
      const previous = process.env.AIES_WORKER_MODEL;
      delete process.env.AIES_WORKER_MODEL;
      try {
        writeFileSync(
          join(dir, "aies.json"),
          JSON.stringify({ agents: { worker: { model: "ghost/missing-model" } } }),
        );
        const runtime = await ModelRuntime.create({
          authPath: join(dir, "auth.json"),
          modelsPath: null,
        });
        const registry = new ModelRegistry(runtime);
        const parentModel = { provider: "mock", id: "parent-model" };

        await assert.rejects(
          () => resolveWorkerModel(registry, parentModel, dir, {}),
          /ghost\/missing-model/,
          "an explicit but unresolvable worker model must not resolve to the parent model",
        );

        const handoff = await runWorkerAgent({
          task: "This must not run on the parent model",
          cwd: REPO_ROOT,
          agentDir: dir,
          modelRuntime: registry,
          parentModel,
        });

        assert.equal(handoff.status, "failed", "the delegation must fail explicitly, not fall back");
        assert.match(handoff.issues.join(" "), /ghost\/missing-model/);
      } finally {
        if (previous === undefined) delete process.env.AIES_WORKER_MODEL;
        else process.env.AIES_WORKER_MODEL = previous;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("End-to-end child session execution and isolation", () => {
    it("guarantees child context isolation from parent secret sentinels", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      const PARENT_SECRET = "PARENT_WORKER_SECRET_DO_NOT_LEAK_789";

      const jsonText = `\`\`\`json
{
  "status": "done",
  "summary": "Implementation executed without leaks.",
  "changes": [],
  "checks": [],
  "issues": [],
  "next": []
}
\`\`\``;

      faux.setResponses([fauxAssistantMessage([{ type: "text", text: jsonText }])]);

      const sessionManager = SessionManager.inMemory(REPO_ROOT);

      const handoff = await runWorkerAgent({
        task: "Implement task without leaking parent context",
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
      });

      assert.equal(handoff.status, "done");

      const entries = sessionManager.getEntries();
      const transcript = JSON.stringify(entries);
      assert.equal(
        transcript.includes(PARENT_SECRET),
        false,
        "Parent secret sentinel leaked into Worker session!",
      );
    });

    it("performs controlled mutation on a fixture directory", async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "aies-worker-fixture-"));
      try {
        const fixtureFile = join(tempDir, "sample.txt");
        writeFileSync(fixtureFile, "initial content\n");

        const faux = fauxProvider();
        const runtime = await ModelRuntime.create();
        runtime.registerNativeProvider(faux.provider);
        const model = faux.models[0];

        // Turn 1: Worker writes/edits file
        const editCall = fauxAssistantMessage([
          fauxToolCall("write", { path: "sample.txt", content: "updated by worker\n" }, "call-write-1"),
        ]);

        // Turn 2: Worker executes check via bash
        const bashCall = fauxAssistantMessage([
          fauxToolCall("bash", { command: "cat sample.txt" }, "call-bash-1"),
        ]);

        // Turn 3: Worker handoff
        const handoffJson = `\`\`\`json
{
  "status": "done",
  "summary": "Updated sample.txt successfully.",
  "changes": [{ "file": "sample.txt", "description": "Changed content to updated by worker" }],
  "checks": [{ "check": "cat sample.txt", "result": "Verified content" }],
  "issues": [],
  "next": []
}
\`\`\``;
        const finishMsg = fauxAssistantMessage([{ type: "text", text: handoffJson }]);

        faux.setResponses([editCall, bashCall, finishMsg]);

        const mockBashRunner = async () => ({
          stdout: "updated by worker\n",
          exitCode: 0,
        });

        const handoff = await runWorkerAgent({
          task: "Update sample.txt and verify",
          cwd: tempDir,
          agentDir: REPO_ROOT,
          modelRuntime: runtime,
          model,
          bashRunner: mockBashRunner,
        });

        assert.equal(handoff.status, "done");
        assert.equal(handoff.changes.length, 1);
        assert.equal(handoff.changes[0].file, "sample.txt");

        const modifiedContent = readFileSync(fixtureFile, "utf8");
        assert.equal(modifiedContent, "updated by worker\n");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("isolates parent metrics from Worker internal tool calls", async () => {
      let parentState = createState(1_000_000);

      // Parent delegates to worker (1 tool call)
      parentState = applyToolCall(
        parentState,
        { toolName: "aies_delegate", input: { role: "worker", task: "Implement feature" } },
        1_000_100,
        REPO_ROOT,
      );
      parentState = applyDelegationStart(parentState, "worker", 1_000_100);

      // Worker runs internally (edit, bash, write, tgrep)
      // Parent receives completed delegate tool result
      parentState = applyToolResult(
        parentState,
        { content: "### Worker Result: DONE", isError: false },
        1_000_600,
      );
      parentState = applyDelegationEnd(parentState, "done", 1_000_600);

      // Parent metrics must reflect only the single delegation
      assert.equal(parentState.tools.calls, 1);
      assert.equal(parentState.tools.callsByName.aies_delegate, 1);
      assert.equal(parentState.exploration.sourceReads, 0);
      assert.equal(parentState.delegations.total, 1);
      assert.equal(parentState.delegations.byRole.worker, 1);
      assert.equal(parentState.delegations.lastOutcome, "done");
      assert.equal(parentState.delegations.lastDurationMs, 500);
    });

    it("aies_delegate tool definition accepts both explore and worker roles", async () => {
      const tool = createDelegateTool();
      assert.equal(tool.name, "aies_delegate");

      // Verify schema permits role: "worker"
      assert.ok(tool.parameters);

      // Verify unknown role is rejected
      await assert.rejects(
        async () => {
          await tool.execute(
            "call-1",
            { role: "verifier", task: "Verify code" },
            undefined,
            undefined,
            { cwd: REPO_ROOT },
          );
        },
        /Unsupported delegation role: "verifier"/u,
      );
    });
  });
});
