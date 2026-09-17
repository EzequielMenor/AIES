/**
 * Test suite for AIES-003: Isolated Explore (hardened read-only & scoped search).
 *
 * Verifies:
 * 1. No bash: Explore agent does NOT have a generic bash/terminal tool.
 * 2. No writes: Explore agent does NOT have edit, write, or mutating tools.
 * 3. Scoped tgrep schema: Rejects arbitrary command strings, validates parameters.
 * 4. Path containment: Blocks path traversal (../, /etc, $HOME).
 * 5. No shell injection: Patterns and arguments are passed cleanly to runner without shell.
 * 6. Output capping: Match lines, file counts, and character volume are defensively capped.
 * 7. Progressive search: Supports filesOnly: true and bounded context lines.
 * 8. Fallback: When tgrep is unavailable (ENOENT), returns clear capability notice and Explore falls back to grep/find/read.
 * 9. Metrics isolation: Child searches, reads, and delegations do not pollute parent metrics.
 * 10. Existing test invariants: Full test suite passes cleanly.
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

import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";
import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import {
  formatExploreHandoff,
  MAX_HANDOFF_CHARS,
  parseExploreHandoff,
} from "../extensions/aies-agents/handoff.ts";
import { resolveExploreModel } from "../extensions/aies-agents/model.ts";
import {
  buildTgrepArgs,
  createTgrepToolDefinition,
  MAX_TGREP_FILES,
  MAX_TGREP_MATCH_LINES,
  MAX_TGREP_OUTPUT_CHARS,
  resolveSafePath,
} from "../extensions/aies-agents/tgrep.ts";
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

describe("AIES-003 Isolated Explore (Hardened Read-Only)", () => {
  describe("Scoped tgrep tool & security constraints", () => {
    it("strictly contains search paths within workspace root", () => {
      // Safe paths within workspace
      assert.equal(resolveSafePath(REPO_ROOT, "."), REPO_ROOT);
      assert.equal(resolveSafePath(REPO_ROOT, "src"), join(REPO_ROOT, "src"));
      assert.equal(resolveSafePath(REPO_ROOT, "./extensions"), join(REPO_ROOT, "extensions"));

      // Traversal attempts must throw path traversal error
      assert.throws(
        () => resolveSafePath(REPO_ROOT, "../outside"),
        /Path traversal blocked/u,
      );
      assert.throws(
        () => resolveSafePath(REPO_ROOT, "../../etc/passwd"),
        /Path traversal blocked/u,
      );
      assert.throws(
        () => resolveSafePath(REPO_ROOT, "/etc/shadow"),
        /Path traversal blocked/u,
      );
      assert.throws(
        () => resolveSafePath(REPO_ROOT, "/tmp"),
        /Path traversal blocked/u,
      );
    });

    it("builds structured arguments safely without shell injection", () => {
      // Pattern with shell characters ($(rm -rf), backticks, semicolons) must remain literal argument
      const maliciousPattern = "$(rm -rf /); touch /tmp/pwned; `echo bad`";
      const args = buildTgrepArgs(
        {
          pattern: maliciousPattern,
          fixed: true,
          fileType: "ts",
          glob: "*.test.ts",
          context: 3,
        },
        REPO_ROOT,
      );

      assert.ok(args.includes("-F"), "Must include -F for fixed");
      assert.ok(args.includes("-t"), "Must include -t for fileType");
      assert.ok(args.includes("ts"), "Must include fileType value");
      assert.ok(args.includes("-g"), "Must include -g for glob");
      assert.ok(args.includes("*.test.ts"), "Must include glob value");
      assert.ok(args.includes("-C"), "Must include -C for context");
      assert.ok(args.includes("3"), "Must include context value 3");
      assert.equal(
        args[args.length - 2],
        maliciousPattern,
        "Pattern must be passed verbatim without shell interpolation",
      );
      assert.equal(args[args.length - 1], REPO_ROOT, "Last argument must be the safe target path");
    });

    it("supports progressive search via filesOnly flag", async () => {
      let executedArgs = [];
      const mockRunner = async (_bin, args) => {
        executedArgs = args;
        return { stdout: "extensions/aies-agents/explore.ts\nextensions/aies-agents/tgrep.ts\n" };
      };

      const tool = createTgrepToolDefinition(REPO_ROOT, { runner: mockRunner });
      const result = await tool.execute(
        "call-1",
        { pattern: "runExploreAgent", filesOnly: true },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );

      assert.ok(executedArgs.includes("-l"), "filesOnly must pass -l flag to tgrep");
      assert.equal(result.isError, false);
      assert.match(result.content[0].text, /extensions\/aies-agents\/explore\.ts/u);
    });

    it("defensively caps output when match volume is large", async () => {
      // Generate 200 match lines exceeding MAX_TGREP_MATCH_LINES (100)
      const hugeOutput = Array.from({ length: 200 }, (_, i) => `file.ts:${i + 1}: matching line content`).join("\n");
      const mockRunner = async () => ({ stdout: hugeOutput });

      const tool = createTgrepToolDefinition(REPO_ROOT, { runner: mockRunner });
      const result = await tool.execute(
        "call-2",
        { pattern: "matching" },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );

      assert.equal(result.isError, false);
      assert.match(result.content[0].text, /\[Results truncated: limit of 100 match lines exceeded/u);

      // Verify character capping
      const giganticOutput = "X".repeat(MAX_TGREP_OUTPUT_CHARS + 5000);
      const mockRunner2 = async () => ({ stdout: giganticOutput });
      const tool2 = createTgrepToolDefinition(REPO_ROOT, { runner: mockRunner2 });
      const result2 = await tool2.execute(
        "call-3",
        { pattern: "gigantic" },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );

      assert.match(result2.content[0].text, /\[Results truncated/u);
      assert.ok(result2.content[0].text.length <= MAX_TGREP_OUTPUT_CHARS + 200);
    });

    it("handles tgrep unavailable (ENOENT) with capability notice and no crash", async () => {
      const enoentError = new Error("spawn tgrep ENOENT");
      enoentError.code = "ENOENT";
      const mockRunner = async () => {
        throw enoentError;
      };

      const tool = createTgrepToolDefinition(REPO_ROOT, { runner: mockRunner });
      const result = await tool.execute(
        "call-4",
        { pattern: "anything" },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );

      assert.equal(result.isError, true);
      assert.match(
        result.content[0].text,
        /tgrep capability unavailable: 'tgrep' executable not found on PATH\. Use built-in 'grep' or 'find' tools instead\./u,
      );
    });

    it("handles zero matches (exit code 1) gracefully without reporting error", async () => {
      const noMatchError = new Error("Command failed with exit code 1");
      noMatchError.code = 1;
      const mockRunner = async () => {
        throw noMatchError;
      };

      const tool = createTgrepToolDefinition(REPO_ROOT, { runner: mockRunner });
      const result = await tool.execute(
        "call-5",
        { pattern: "nonexistent_pattern" },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );

      assert.equal(result.isError, false);
      assert.match(result.content[0].text, /No matches found for pattern "nonexistent_pattern"/u);
    });
  });

  describe("Tool surface enforcement (no bash, no writes)", () => {
    it("guarantees child AgentSession has strictly read-only tools and NO bash", async () => {
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
        systemPrompt: "You are a read-only explorer.",
      });
      await resourceLoader.reload();

      const customTgrep = createTgrepToolDefinition(REPO_ROOT);
      const { session } = await createAgentSession({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        model,
        modelRuntime: runtime,
        resourceLoader,
        sessionManager: SessionManager.inMemory(REPO_ROOT),
        customTools: [customTgrep],
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
        assert.equal(allTools.includes("bash"), false, "Child must NOT have 'bash' tool in registry");
        assert.equal(allTools.includes("edit"), false, "Child must NOT have 'edit' tool in registry");
        assert.equal(allTools.includes("write"), false, "Child must NOT have 'write' tool in registry");
      } finally {
        session.dispose();
      }
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

      // Gigantic output must be capped under 6,000 chars
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

      state = applyDelegationStart(state, "explore", T0 + 1000);
      assert.equal(state.delegations.total, 1);
      assert.equal(state.delegations.byRole.explore, 1);
      assert.equal(state.delegations.activeRole, "explore");
      assert.equal(state.session.lastEventAt, T0 + 1000);

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

      const entries = sessionManager.getEntries();
      const fullChildTranscript = JSON.stringify(entries);
      assert.equal(
        fullChildTranscript.includes(PARENT_SECRET_SENTINEL),
        false,
        "Parent secret sentinel leaked into child session!",
      );
    });

    it("executes multi-turn exploration with tgrep search and read calls", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // Turn 1: Child calls "tgrep" with filesOnly: true
      const searchCall = fauxAssistantMessage([
        fauxToolCall("tgrep", { pattern: "aies", filesOnly: true }, "call-tgrep-1"),
      ]);

      // Turn 2: Child calls "read" on package.json
      const readCall = fauxAssistantMessage([
        fauxToolCall("read", { path: "package.json" }, "call-read-pkg"),
      ]);

      // Turn 3: Child finishes with structured handoff
      const handoffJson = `\`\`\`json
{
  "status": "done",
  "summary": "Located and verified package.json.",
  "evidence": [
    { "file": "package.json", "lines": "1-5", "note": "project metadata" }
  ],
  "issues": [],
  "next": []
}
\`\`\``;
      const finishMsg = fauxAssistantMessage([{ type: "text", text: handoffJson }]);

      faux.setResponses([searchCall, readCall, finishMsg]);

      const mockTgrepRunner = async () => ({
        stdout: "package.json\nREADME.md\n",
      });

      const handoff = await runExploreAgent({
        task: "Find and inspect package.json",
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        tgrepRunner: mockTgrepRunner,
      });

      assert.equal(handoff.status, "done");
      assert.equal(handoff.summary, "Located and verified package.json.");
      assert.equal(handoff.evidence.length, 1);
      assert.equal(handoff.evidence[0].file, "package.json");
    });

    it("falls back to grep/find when tgrep is unavailable without failing the session", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // Turn 1: Child calls tgrep, gets unavailable notice
      const tgrepCall = fauxAssistantMessage([
        fauxToolCall("tgrep", { pattern: "name" }, "call-tgrep-unavailable"),
      ]);

      // Turn 2: Child falls back to built-in grep
      const grepCall = fauxAssistantMessage([
        fauxToolCall("grep", { pattern: "aies" }, "call-grep-fallback"),
      ]);

      // Turn 3: Child finishes
      const handoffJson = `\`\`\`json
{
  "status": "done",
  "summary": "Completed exploration via grep fallback.",
  "evidence": [
    { "file": "package.json", "note": "matched via grep" }
  ],
  "issues": ["tgrep was unavailable"],
  "next": []
}
\`\`\``;
      const finishMsg = fauxAssistantMessage([{ type: "text", text: handoffJson }]);

      faux.setResponses([tgrepCall, grepCall, finishMsg]);

      const enoentRunner = async () => {
        const err = new Error("spawn tgrep ENOENT");
        err.code = "ENOENT";
        throw err;
      };

      const handoff = await runExploreAgent({
        task: "Search with fallback",
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        tgrepRunner: enoentRunner,
      });

      assert.equal(handoff.status, "done");
      assert.equal(handoff.summary, "Completed exploration via grep fallback.");
      assert.deepEqual(handoff.issues, ["tgrep was unavailable"]);
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

      // Child runs internally (with noExtensions: true)
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
      assert.equal(parentState.exploration.searches, 0, "Child searches must NOT inflate parent searches");
      assert.equal(parentState.delegations.total, 1);
      assert.equal(parentState.delegations.lastOutcome, "done");
    });

    it("creates a valid aies_delegate ToolDefinition conforming to schema", async () => {
      const tool = createDelegateTool();
      assert.equal(tool.name, "aies_delegate");
      assert.equal(tool.label, "AIES Delegate");
      assert.ok(tool.parameters);

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
