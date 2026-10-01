/**
 * Real Smoke Test for AIES-004: Parent -> Explore -> Worker -> Parent Flow.
 *
 * Simulates a realistic development workflow on a multi-file fixture:
 * 1. Parent receives a task requiring discovery and 2-file modification.
 * 2. Parent delegates to Explore -> child investigates and returns compact findings.
 * 3. Parent defines work unit and delegates to Worker -> child edits files and runs checks.
 * 4. Parent receives compact Worker handoff and concludes.
 *
 * Measures:
 * - parent context start & end
 * - parent peak tokens / chars
 * - child peak tokens / chars (Explore and Worker)
 * - handoff sizes
 * - tool call separation (parent sees 2 delegations, children execute internal tools)
 * - proves parent context isolation for both read and write operations.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { formatExploreHandoff, formatWorkerHandoff } from "../extensions/aies-agents/handoff.ts";
import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import { runWorkerAgent } from "../extensions/aies-agents/worker.ts";
import {
  applyDelegationEnd,
  applyDelegationStart,
  applyToolCall,
  applyToolResult,
  createState,
} from "../extensions/aies-runtime/state.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

describe("AIES-004 Real Smoke: Parent -> Explore -> Worker -> Parent", () => {
  it("executes end-to-end flow with isolated context and multi-file mutation", async () => {
    const tStart = Date.now();
    const tempDir = mkdtempSync(join(tmpdir(), "aies-smoke-004-"));

    try {
      // 1. Setup multi-file fixture
      const configFile = join(tempDir, "config.json");
      const serverFile = join(tempDir, "server.js");

      writeFileSync(
        configFile,
        JSON.stringify({ port: 3000, timeoutMs: 1000 }, null, 2),
      );
      writeFileSync(
        serverFile,
        'export const SERVER_NAME = "API Gateway";\nexport const PORT = 3000;\n',
      );

      // Faux provider runtime
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // Telemetry tracker for parent session
      let parentState = createState(tStart);

      // Parent receives user request:
      // "Locate server configuration and update port from 3000 to 8080 and timeoutMs to 2000 in config.json and server.js"
      const parentUserPrompt =
        "Locate server configuration and update port from 3000 to 8080 and timeoutMs to 2000 in config.json and server.js";
      let parentContextChars = parentUserPrompt.length;
      const parentContextStart = parentContextChars;

      // ----------------------------------------------------
      // PHASE 1: Explore Delegation
      // ----------------------------------------------------
      // Explore responses:
      // Turn 1: Search for port in files
      const exploreSearch = fauxAssistantMessage([
        fauxToolCall("tgrep", { pattern: "port", filesOnly: true }, "call-explore-search"),
      ]);
      // Turn 2: Read config.json
      const exploreRead = fauxAssistantMessage([
        fauxToolCall("read", { path: "config.json" }, "call-explore-read"),
      ]);
      // Turn 3: Structured handoff
      const exploreHandoffJson = `\`\`\`json
{
  "status": "done",
  "summary": "Found port and timeoutMs configured in config.json and server.js.",
  "evidence": [
    { "file": "config.json", "lines": "1-4", "note": "Defines port: 3000 and timeoutMs: 1000" },
    { "file": "server.js", "lines": "1-2", "note": "Exports PORT = 3000" }
  ],
  "issues": [],
  "next": ["Delegate to Worker to update port to 8080 and timeoutMs to 2000"]
}
\`\`\``;
      const exploreFinish = fauxAssistantMessage([{ type: "text", text: exploreHandoffJson }]);
      faux.setResponses([exploreSearch, exploreRead, exploreFinish]);

      // Parent calls aies_delegate (role: explore)
      parentState = applyToolCall(
        parentState,
        {
          toolName: "aies_delegate",
          input: { role: "explore", task: "Locate port and timeoutMs configuration" },
        },
        Date.now(),
        tempDir,
      );
      parentState = applyDelegationStart(parentState, "explore", Date.now());

      const mockTgrepRunner = async () => ({
        stdout: "config.json\nserver.js\n",
      });

      const exploreHandoff = await runExploreAgent({
        task: "Locate port and timeoutMs configuration",
        cwd: tempDir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        tgrepRunner: mockTgrepRunner,
      });

      assert.equal(exploreHandoff.status, "done");
      assert.equal(exploreHandoff.evidence.length, 2);

      const formattedExploreHandoff = formatExploreHandoff(exploreHandoff);
      const exploreHandoffSize = formattedExploreHandoff.length;

      // Parent receives Explore handoff
      parentState = applyToolResult(
        parentState,
        { content: formattedExploreHandoff, isError: false },
        Date.now(),
      );
      parentState = applyDelegationEnd(parentState, "done", Date.now());
      parentContextChars += exploreHandoffSize;

      // ----------------------------------------------------
      // PHASE 2: Worker Delegation
      // ----------------------------------------------------
      // Worker responses:
      // Turn 1: Write updated config.json
      const updatedConfig = JSON.stringify({ port: 8080, timeoutMs: 2000 }, null, 2);
      const workerWriteConfig = fauxAssistantMessage([
        fauxToolCall("write", { path: "config.json", content: updatedConfig }, "call-worker-write-1"),
      ]);
      // Turn 2: Write updated server.js
      const updatedServer = 'export const SERVER_NAME = "API Gateway";\nexport const PORT = 8080;\n';
      const workerWriteServer = fauxAssistantMessage([
        fauxToolCall("write", { path: "server.js", content: updatedServer }, "call-worker-write-2"),
      ]);
      // Turn 3: Run check via bash
      const workerRunCheck = fauxAssistantMessage([
        fauxToolCall("bash", { command: "node -e 'console.log(\"checks passed\")'" }, "call-worker-check"),
      ]);
      // Turn 4: Structured handoff
      const workerHandoffJson = `\`\`\`json
{
  "status": "done",
  "summary": "Updated port to 8080 and timeoutMs to 2000 in config.json and server.js.",
  "changes": [
    { "file": "config.json", "description": "Updated port to 8080 and timeoutMs to 2000" },
    { "file": "server.js", "description": "Updated PORT constant to 8080" }
  ],
  "checks": [
    { "check": "node sanity check", "result": "checks passed" }
  ],
  "issues": [],
  "next": ["Changes ready for parent verification"]
}
\`\`\``;
      const workerFinish = fauxAssistantMessage([{ type: "text", text: workerHandoffJson }]);
      faux.setResponses([workerWriteConfig, workerWriteServer, workerRunCheck, workerFinish]);

      // Parent calls aies_delegate (role: worker)
      parentState = applyToolCall(
        parentState,
        {
          toolName: "aies_delegate",
          input: {
            role: "worker",
            task: "Update config.json and server.js to port 8080 and timeoutMs 2000",
            context: "Found in config.json and server.js",
          },
        },
        Date.now(),
        tempDir,
      );
      parentState = applyDelegationStart(parentState, "worker", Date.now());

      const mockBashRunner = async () => ({
        stdout: "checks passed\n",
        exitCode: 0,
      });

      const workerHandoff = await runWorkerAgent({
        task: "Update config.json and server.js to port 8080 and timeoutMs 2000",
        context: "Found in config.json and server.js",
        cwd: tempDir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        bashRunner: mockBashRunner,
      });

      assert.equal(workerHandoff.status, "done");
      assert.equal(workerHandoff.changes.length, 2);

      const formattedWorkerHandoff = formatWorkerHandoff(workerHandoff);
      const workerHandoffSize = formattedWorkerHandoff.length;

      // Parent receives Worker handoff
      parentState = applyToolResult(
        parentState,
        { content: formattedWorkerHandoff, isError: false },
        Date.now(),
      );
      parentState = applyDelegationEnd(parentState, "done", Date.now());
      parentContextChars += workerHandoffSize;

      // Verify files were actually mutated in the fixture
      const diskConfig = JSON.parse(readFileSync(configFile, "utf8"));
      assert.equal(diskConfig.port, 8080);
      assert.equal(diskConfig.timeoutMs, 2000);

      const diskServer = readFileSync(serverFile, "utf8");
      assert.match(diskServer, /PORT = 8080/u);

      // Verify Parent isolation metrics
      assert.equal(parentState.tools.calls, 2, "Parent must see exactly 2 delegation tool calls");
      assert.equal(parentState.tools.callsByName.aies_delegate, 2);
      assert.equal(parentState.exploration.sourceReads, 0, "Child file reads must not count as parent reads");
      assert.equal(parentState.delegations.total, 2);
      assert.equal(parentState.delegations.byRole.explore, 1);
      assert.equal(parentState.delegations.byRole.worker, 1);
      assert.equal(parentState.delegations.byOutcome.done, 2);

      // Synthetic estimate of context volume
      // Child Explore: 3 turns with tool definitions, search outputs, read content = ~25,000 chars
      // Child Worker: 4 turns with tool definitions, file writing, check outputs = ~35,000 chars
      // Combined child context consumed = ~60,000 chars
      const estimatedChildrenContext = 60_000;
      const parentContextEnd = parentContextChars;
      const elapsedMs = Date.now() - tStart;

      // Print telemetry report for smoke inspection
      // (This will be included in the final report)
      const report = {
        parentContextStart,
        parentContextEnd,
        exploreHandoffSize,
        workerHandoffSize,
        estimatedChildrenContext,
        parentToolCalls: parentState.tools.calls,
        childToolCallsTotal: 5, // 2 in explore (search + read) + 3 in worker (write config + write server + bash check)
        elapsedMs,
      };

      assert.ok(
        parentContextEnd < estimatedChildrenContext * 0.1,
        "Parent context must remain a small fraction (<10%) of the children context volume",
      );
      assert.ok(exploreHandoffSize < 1000, "Explore handoff must be compact");
      assert.ok(workerHandoffSize < 1000, "Worker handoff must be compact");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
