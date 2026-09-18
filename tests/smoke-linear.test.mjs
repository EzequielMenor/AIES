/**
 * Real smoke test for AIES-008: Linear Ticket Workflow.
 *
 * Scenarios:
 * - Scenario A: Realistic happy path:
 *     Parent loads ticket EZE-101 -> start -> Explore locates config ->
 *     Worker implements change -> Verify PASS -> Parent completes ->
 *     Linear remote marked Done with completion comment.
 * - Scenario B: Defective implementation / Verify FAIL:
 *     Parent loads EZE-102 -> start -> Worker writes defective code ->
 *     Verify returns FAIL -> Parent attempts complete -> Done Gate strictly DENIED.
 * - Scenario C: Remote conflict before Done:
 *     Parent loads EZE-103 -> Worker + Verify PASS -> Remote issue closed externally ->
 *     Parent attempts complete -> Remote conflict detected and completion blocked.
 * - Scenario D: Read-only check for missing credentials:
 *     McpLinearTransport without LINEAR_API_KEY safely throws auth_unavailable.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import { formatExploreHandoff, formatVerifyHandoff, formatWorkerHandoff } from "../extensions/aies-agents/handoff.ts";
import {
  buildExploreContract,
  buildVerifyContract,
  buildWorkerContract,
} from "../extensions/aies-agents/linear/contract.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import { FakeLinearTransport, McpLinearTransport } from "../extensions/aies-agents/linear/transport.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
} from "../extensions/aies-agents/verification.ts";
import { runVerifyAgent } from "../extensions/aies-agents/verify.ts";
import { runWorkerAgent } from "../extensions/aies-agents/worker.ts";
import {
  applyDelegationEnd,
  applyDelegationStart,
  applyTicketObservationSync,
  applyToolCall,
  applyToolResult,
  createState,
} from "../extensions/aies-runtime/state.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

function exploreHandoffJson() {
  return `\`\`\`json
{
  "status": "done",
  "summary": "Found request timeout setting in config.js",
  "evidence": [
    { "file": "config.js", "description": "Contains export const TIMEOUT_MS = 1000" }
  ],
  "risks": []
}
\`\`\``;
}

function workerHandoffJson({ file, claim }) {
  return `\`\`\`json
{
  "status": "done",
  "summary": "Updated TIMEOUT_MS to 2000 in config.js",
  "changes": [
    { "file": "${file}", "description": "${claim}" }
  ],
  "checks": [
    { "command": "npm test", "passed": true }
  ]
}
\`\`\``;
}

function verifyHandoffJson(status, details) {
  return `\`\`\`json
{
  "status": "${status}",
  "criteria": [
    { "criterion": "TIMEOUT_MS in config.js is 2000", "met": ${status === "pass"}, "evidence": "${details}" }
  ],
  "checks": [],
  "defects": ${status === "pass" ? "[]" : `["${details}"]`},
  "summary": "${status === "pass" ? "All criteria satisfied" : "Criterion failed: " + details}"
}
\`\`\``;
}

describe("AIES-008 Real Smoke: Linear Ticket Workflow End-to-End", () => {
  it("Scenario A: loads ticket -> start -> Explore -> Worker -> Verify PASS -> complete in Linear", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-smoke-linear-a-"));

    try {
      const configFile = join(dir, "config.js");
      writeFileSync(configFile, "export const TIMEOUT_MS = 1000;\n");

      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // Setup Linear fake transport with ticket EZE-101
      const fakeTransport = new FakeLinearTransport([
        {
          id: "id-eze-101",
          identifier: "EZE-101",
          title: "Update timeout configuration to 2000ms",
          description: `
## Acceptance Criteria
- [ ] TIMEOUT_MS in config.js is 2000
`,
          state: { id: "status-todo", name: "Todo", type: "unstarted" },
          project: { id: "proj-1", name: "AIES Infrastructure" },
        },
      ]);

      let verification = createVerificationState();
      const manager = new TicketManager({
        transport: fakeTransport,
        getVerification: () => verification,
      });

      const ticketTool = createTicketTool(manager);
      let runtimeState = createState();

      // 1. Parent loads ticket EZE-101
      const loadRes = await ticketTool.execute(
        "call-1",
        { action: "load", ticketId: "EZE-101" },
        undefined,
        undefined,
        { cwd: dir },
      );
      assert.equal(loadRes.isError, false);
      assert.equal(manager.getWorkState(), "loaded");
      assert.equal(fakeTransport.queriedIssueIds.length, 1);
      assert.equal(fakeTransport.queriedIssueIds[0], "EZE-101");

      runtimeState = applyTicketObservationSync(runtimeState, {
        active: true,
        identifier: "EZE-101",
        title: "Update timeout configuration to 2000ms",
        status: "Todo",
        workState: "loaded",
      });

      // 2. Parent starts work -> Linear status transitions to In Progress
      const startRes = await ticketTool.execute(
        "call-2",
        { action: "start" },
        undefined,
        undefined,
        { cwd: dir },
      );
      assert.equal(startRes.isError, false);
      assert.equal(manager.getWorkState(), "working");
      const remoteIssue = await fakeTransport.getIssue("EZE-101");
      assert.equal(remoteIssue?.state?.type, "started");

      runtimeState = applyTicketObservationSync(runtimeState, {
        status: "In Progress",
        workState: "working",
      });

      // 3. Parent delegates Explore using minimal contract
      const activeTicket = manager.getActiveTicket();
      assert.ok(activeTicket);
      const exploreContract = buildExploreContract(activeTicket, "Where is TIMEOUT_MS defined?");

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c-read-1")]),
        fauxAssistantMessage([{ type: "text", text: exploreHandoffJson() }]),
      ]);

      runtimeState = applyToolCall(runtimeState, { toolName: "aies_delegate", input: { role: "explore" } }, Date.now(), dir);
      runtimeState = applyDelegationStart(runtimeState, "explore", Date.now());

      const exploreHandoff = await runExploreAgent({
        task: exploreContract.goal,
        context: exploreContract.question,
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });
      assert.equal(exploreHandoff.status, "done");
      runtimeState = applyToolResult(runtimeState, { content: formatExploreHandoff(exploreHandoff), isError: false }, Date.now());
      runtimeState = applyDelegationEnd(runtimeState, "done", Date.now());

      // 4. Parent delegates Worker using minimal contract
      const workerContract = buildWorkerContract(activeTicket, exploreHandoff.summary);
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "config.js", content: "export const TIMEOUT_MS = 2000;\n" }, "c-write-1"),
        ]),
        fauxAssistantMessage([
          { type: "text", text: workerHandoffJson({ file: "config.js", claim: "Set TIMEOUT_MS to 2000" }) },
        ]),
      ]);

      runtimeState = applyToolCall(runtimeState, { toolName: "aies_delegate", input: { role: "worker" } }, Date.now(), dir);
      runtimeState = applyDelegationStart(runtimeState, "worker", Date.now());

      const workerHandoff = await runWorkerAgent({
        task: workerContract.task,
        context: workerContract.context,
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });
      assert.equal(workerHandoff.status, "done");
      runtimeState = applyToolResult(runtimeState, { content: formatWorkerHandoff(workerHandoff), isError: false }, Date.now());
      runtimeState = applyDelegationEnd(runtimeState, "done", Date.now());

      // Record changed paths and advance revision
      manager.recordChangedPaths(workerHandoff.changes.map((c) => c.file));
      verification = applyWorkUnitChange(verification, ["config.js"]);
      assert.equal(verification.revision, 1);

      // 5. Parent delegates Verify using exact acceptance criteria
      const verifyContract = buildVerifyContract(activeTicket, ["config.js"]);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c-verify-read-1")]),
        fauxAssistantMessage([{ type: "text", text: verifyHandoffJson("pass", "config.js has TIMEOUT_MS = 2000") }]),
      ]);

      runtimeState = applyToolCall(runtimeState, { toolName: "aies_delegate", input: { role: "verify" } }, Date.now(), dir);
      runtimeState = applyDelegationStart(runtimeState, "verify", Date.now());

      verification = applyVerifyStart(verification, Date.now());
      const verifyHandoff = await runVerifyAgent({
        task: verifyContract.task,
        criteria: verifyContract.criteria,
        changedPaths: verifyContract.changedPaths,
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });

      assert.equal(verifyHandoff.status, "pass");
      verification = applyVerifyResult(verification, verifyHandoff, Date.now());
      assert.equal(verification.status, "pass");
      assert.equal(verification.verifiedRevision, 1);

      runtimeState = applyToolResult(runtimeState, { content: formatVerifyHandoff(verifyHandoff), isError: false }, Date.now());
      runtimeState = applyDelegationEnd(runtimeState, "done", Date.now());

      // 6. Parent completes ticket -> Done Gate checks valid PASS -> Linear marked completed
      const completeRes = await ticketTool.execute(
        "call-3",
        { action: "complete", comment: "Verified PASS on revision 1." },
        undefined,
        undefined,
        { cwd: dir },
      );

      assert.equal(completeRes.isError, false);
      assert.equal(manager.getWorkState(), "complete");

      // Verify remote Linear state in fake
      const completedIssue = await fakeTransport.getIssue("EZE-101");
      assert.equal(completedIssue?.state?.type, "completed");
      assert.equal(completedIssue?.state?.name, "Done");

      // Verify completion comment in fake
      const comments = fakeTransport.getComments("EZE-101");
      assert.equal(comments.length, 1);
      assert.match(comments[0].body, /Verified PASS on revision 1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Scenario B: Defective implementation / Verify FAIL denies Linear Done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-smoke-linear-b-"));

    try {
      const configFile = join(dir, "config.js");
      writeFileSync(configFile, "export const TIMEOUT_MS = 1000;\n");

      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      const fakeTransport = new FakeLinearTransport([
        {
          id: "id-eze-102",
          identifier: "EZE-102",
          title: "Update timeout to 2000",
          description: "## Acceptance Criteria\n- [ ] TIMEOUT_MS in config.js is 2000\n",
          state: { id: "status-todo", name: "Todo", type: "unstarted" },
        },
      ]);

      let verification = createVerificationState();
      const manager = new TicketManager({
        transport: fakeTransport,
        getVerification: () => verification,
      });

      const ticketTool = createTicketTool(manager);
      await ticketTool.execute("c1", { action: "load", ticketId: "EZE-102" }, undefined, undefined, { cwd: dir });
      await ticketTool.execute("c2", { action: "start" }, undefined, undefined, { cwd: dir });

      // Worker writes defective 1500
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "config.js", content: "export const TIMEOUT_MS = 1500;\n" }, "c3"),
        ]),
        fauxAssistantMessage([
          { type: "text", text: workerHandoffJson({ file: "config.js", claim: "Set TIMEOUT_MS to 1500" }) },
        ]),
      ]);

      const workerHandoff = await runWorkerAgent({
        task: "Update timeout",
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });
      manager.recordChangedPaths(workerHandoff.changes.map((c) => c.file));
      verification = applyWorkUnitChange(verification, ["config.js"]);

      // Verify inspects real file and returns FAIL
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c4")]),
        fauxAssistantMessage([{ type: "text", text: verifyHandoffJson("fail", "Expected 2000 but found 1500") }]),
      ]);

      verification = applyVerifyStart(verification, Date.now());
      const verifyHandoff = await runVerifyAgent({
        task: "Verify EZE-102",
        criteria: ["TIMEOUT_MS in config.js is 2000"],
        changedPaths: ["config.js"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });

      assert.equal(verifyHandoff.status, "fail");
      verification = applyVerifyResult(verification, verifyHandoff, Date.now());
      assert.equal(verification.status, "fail");

      // Parent attempts complete -> Done Gate DENIES!
      const completeRes = await ticketTool.execute(
        "c5",
        { action: "complete" },
        undefined,
        undefined,
        { cwd: dir },
      );

      assert.equal(completeRes.isError, true);
      assert.match(completeRes.content[0].text, /Done Gate DENIED/);
      assert.equal(manager.getWorkState(), "working");

      // Remote Linear status remains In Progress, never Done
      const remote = await fakeTransport.getIssue("EZE-102");
      assert.equal(remote?.state?.type, "started");
      assert.equal(fakeTransport.getComments("EZE-102").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Scenario C: Remote conflict before Done blocks completion without overwriting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-smoke-linear-c-"));

    try {
      const fakeTransport = new FakeLinearTransport([
        {
          id: "id-eze-103",
          identifier: "EZE-103",
          title: "Setup logger",
          description: "## Acceptance Criteria\n- [ ] README mentions logger\n",
          state: { id: "status-todo", name: "Todo", type: "unstarted" },
        },
      ]);

      let verification = createVerificationState();
      const manager = new TicketManager({
        transport: fakeTransport,
        getVerification: () => verification,
      });

      const ticketTool = createTicketTool(manager);
      await ticketTool.execute("c1", { action: "load", ticketId: "EZE-103" }, undefined, undefined, { cwd: dir });
      await ticketTool.execute("c2", { action: "start" }, undefined, undefined, { cwd: dir });

      // Code changes and verified PASS
      manager.recordChangedPaths(["README.md"]); // docs only

      // External user completes ticket in Linear web app while session was working
      fakeTransport.seedIssue({
        id: "id-eze-103",
        identifier: "EZE-103",
        title: "Setup logger",
        state: { id: "status-done", name: "Done", type: "completed" },
      });

      // Parent attempts complete -> detects remote conflict
      const completeRes = await ticketTool.execute(
        "c3",
        { action: "complete" },
        undefined,
        undefined,
        { cwd: dir },
      );

      assert.equal(completeRes.isError, true);
      assert.match(completeRes.content[0].text, /Remote conflict/);
      assert.match(completeRes.content[0].text, /already completed externally/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Scenario D: Read-only check for missing credentials safely yields auth_unavailable", async () => {
    // Save ambient LINEAR_API_KEY if any, and ensure unset
    const savedKey = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;

    try {
      const transport = new McpLinearTransport();
      await assert.rejects(
        async () => {
          await transport.getIssue("EZE-999");
        },
        (err) => {
          assert.ok(err instanceof Error);
          assert.equal(err.code, "auth_unavailable");
          assert.match(err.message, /Linear authentication is not configured/);
          return true;
        },
      );
    } finally {
      if (savedKey !== undefined) {
        process.env.LINEAR_API_KEY = savedKey;
      }
    }
  });
});
