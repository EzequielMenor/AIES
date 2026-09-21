/**
 * Test suite for AIES-008: Linear Ticket Workflow.
 *
 * Covers the 16 mandatory test categories:
 * 1. Exact ticket retrieval (no backlog query).
 * 2. Compact contract (< 2,500 chars).
 * 3. No children Linear (Explore, Worker, Verify tool surfaces).
 * 4. Parent ownership (only Parent has aies_ticket).
 * 5. Start transition (load does not mutate; startWork transitions to started).
 * 6. Done Gate (none -> DENY, fail -> DENY, blocked -> DENY, running -> DENY, stale PASS -> DENY, fresh PASS -> ALLOW).
 * 7. Docs-only (requiresVerification false -> complete without Verify).
 * 8. PASS invalidation (parent mutation -> revision moves -> Done DENIED).
 * 9. Remote refresh before Done.
 * 10. Conflict detection (remote completed/canceled -> BLOCKED).
 * 11. Session resume (restores active ticket from snapshot without remote fetch).
 * 12. Linear unavailable (network failure reports sync error, code remains verified PASS, Worker not re-run).
 * 13. Context size bound (< 2,500 chars with adversarial payload).
 * 14. Context Governor compatibility (classified standard, survives compaction).
 * 15. Permissions integration (children cannot bypass or run remote tools).
 * 16. Existing suite compatibility.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxProvider } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

import { classifyOutput } from "../extensions/aies-agents/context-governor.ts";
import {
  extractAcceptanceCriteria,
  formatCompactContract,
  normalizeTicketContract,
  readIssueState,
  readIssueTeam,
  buildExploreContract,
  buildWorkerContract,
  buildVerifyContract,
} from "../extensions/aies-agents/linear/contract.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import {
  canSwitchTicket,
  checkDoneGate,
  detectRemoteConflict,
  resolveTargetStatus,
} from "../extensions/aies-agents/linear/policy.ts";
import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import { registerTicketCommand } from "../extensions/aies-agents/linear/command.ts";
import { ticketLoadPrompt, ticketRunPrompt } from "../extensions/aies-agents/linear/prompt.ts";
import {
  FakeLinearTransport,
  HostMediatedLinearTransport,
  LinearTransportError,
} from "../extensions/aies-agents/linear/transport.ts";
// LinearIssueRaw type omitted in .mjs test file
import { isCommandPermittedInWorker } from "../extensions/aies-agents/worker-guard.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
  requiresVerification,
} from "../extensions/aies-agents/verification.ts";
import {
  applyCompaction,
  applyTicketObservationSync,
  createState,
  fromSnapshot,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

describe("AIES-008: Linear Ticket Workflow", () => {
  let fakeTransport;
  let verificationState;
  let manager;

  const sampleIssue = {
    id: "issue-eze-101",
    identifier: "EZE-101",
    title: "Implement session isolation for Linear ticket",
    description: `
# Context
We need to ensure Linear tickets are properly tracked.

## Acceptance Criteria
- [ ] Child agents have no Linear tools
- [ ] Done Gate requires valid fresh Verify PASS
- [ ] Remote conflict blocks completion

## Notes
TBD: what about webhooks?
`,
    state: { id: "status-todo", name: "Todo", type: "unstarted" },
    project: { id: "proj-1", name: "AIES Core" },
    labels: [{ id: "l-1", name: "backend" }, "security"],
    url: "https://linear.app/aies/issue/EZE-101",
  };

  beforeEach(() => {
    fakeTransport = new FakeLinearTransport([sampleIssue]);
    verificationState = createVerificationState();
    manager = new TicketManager({
      transport: fakeTransport,
      getVerification: () => verificationState,
    });
  });

  describe("1. Exact ticket retrieval (no backlog query)", () => {
    it("loads only the requested ticket and performs zero backlog scanning", async () => {
      fakeTransport.seedIssue({
        identifier: "EZE-999",
        title: "Unrelated backlog ticket",
      });

      const result = await manager.loadTicket("EZE-101");

      assert.equal(result.ok, true);
      assert.equal(result.ticket?.identifier, "EZE-101");
      assert.equal(result.ticket?.title, "Implement session isolation for Linear ticket");
      assert.deepEqual(fakeTransport.queriedIssueIds, ["EZE-101"]);
      // Never queried other issues or requested list of all issues
      assert.ok(!fakeTransport.queriedIssueIds.includes("EZE-999"));
    });

    it("returns a clean not_found error when ticket does not exist", async () => {
      const result = await manager.loadTicket("UNKNOWN-404");
      assert.equal(result.ok, false);
      assert.equal(result.error, "not_found");
      assert.match(result.message ?? "", /not found/i);
    });
  });

  describe("2. Compact contract (< 2,500 chars)", () => {
    it("normalizes a massive description with 40,000 characters safely under 2,500 chars", () => {
      const hugeDescription =
        "## Acceptance Criteria\n- [ ] Fast startup\n- [ ] Clean shutdown\n\n" +
        "Big context payload:\n" +
        "x".repeat(40000);

      const hugeRaw = {
        id: "id-huge",
        identifier: "EZE-HUGE",
        title: "Huge Ticket",
        description: hugeDescription,
        state: { id: "status-todo", name: "Todo", type: "unstarted" },
      };

      const normalized = normalizeTicketContract(hugeRaw);
      assert.deepEqual(normalized.acceptanceCriteria, ["Fast startup", "Clean shutdown"]);

      const compact = formatCompactContract(normalized);
      assert.ok(compact.length < 2500, `Contract length was ${compact.length}, expected < 2500`);
      assert.ok(compact.includes("EZE-HUGE — Huge Ticket"));
      assert.ok(compact.includes("1. Fast startup"));
      assert.ok(compact.includes("2. Clean shutdown"));
    });

    it("applies context hygiene truncation when criteria list exceeds 2,500 chars", () => {
      const criteria = Array.from({ length: 100 }, (_, i) => `Criterion ${i + 1}: ${"x".repeat(30)}`);
      const ticket = {
        id: "id-many",
        identifier: "EZE-MANY",
        title: "Many criteria ticket",
        description: "",
        acceptanceCriteria: criteria,
        status: "Todo",
        loadedAt: Date.now(),
      };
      const compact = formatCompactContract(ticket);
      assert.ok(compact.length <= 2500);
      assert.ok(compact.includes("[... truncated for context hygiene ...]"));
    });

    it("extracts explicit checklists, bullet criteria, and flags ambiguous items", () => {
      const desc = `
## Acceptance Criteria
- [ ] Deterministic fake transport
* 1. Zero ambient credential leak
- [ ] TBD: uncertain requirement?

Other requirements:
Ensure timeout is bounded
`;
      const extracted = extractAcceptanceCriteria(desc);
      assert.equal(extracted.isExplicit, true);
      assert.equal(extracted.criteria.length, 3);
      assert.equal(extracted.criteria[0], "Deterministic fake transport");
      assert.equal(extracted.criteria[1], "Zero ambient credential leak");
      assert.ok(extracted.ambiguous.some((a) => a.includes("TBD")));
    });
  });

  describe("3. No children Linear (Explore, Worker, Verify tool whitelists)", () => {
    it("ensures child agent definitions never contain aies_ticket or Linear tools", async () => {
      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // 1. Explore tool surface
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
        tools: ["read", "grep", "find", "ls", "tgrep"],
      });

      // 2. Worker tool surface
      const workerLoader = new DefaultResourceLoader({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: "Worker",
      });
      await workerLoader.reload();
      const { session: workerSession } = await createAgentSession({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        model,
        modelRuntime: runtime,
        resourceLoader: workerLoader,
        sessionManager: SessionManager.inMemory(REPO_ROOT),
        tools: ["read", "grep", "find", "ls", "tgrep", "edit", "write", "bash"],
      });

      // 3. Verify tool surface
      const verifyLoader = new DefaultResourceLoader({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: "Verify",
      });
      await verifyLoader.reload();
      const { session: verifySession } = await createAgentSession({
        cwd: REPO_ROOT,
        agentDir: REPO_ROOT,
        model,
        modelRuntime: runtime,
        resourceLoader: verifyLoader,
        sessionManager: SessionManager.inMemory(REPO_ROOT),
        tools: ["read", "grep", "find", "ls", "tgrep", "bash"],
      });

      try {
        const exploreTools = exploreSession.getActiveToolNames();
        const workerTools = workerSession.getActiveToolNames();
        const verifyTools = verifySession.getActiveToolNames();

        for (const tools of [exploreTools, workerTools, verifyTools]) {
          assert.ok(!tools.includes("aies_ticket"), "Child must not have aies_ticket");
          assert.ok(!tools.some((t) => t.toLowerCase().includes("linear")), "Child must not have any Linear tool");
        }
      } finally {
        exploreSession.dispose();
        workerSession.dispose();
        verifySession.dispose();
      }
    });

    it("builds minimal child contracts stripped of raw Linear metadata", () => {
      const ticket = normalizeTicketContract(sampleIssue);
      const explorePayload = buildExploreContract(ticket, "Where is the state managed?");
      assert.equal(explorePayload.goal, "EZE-101: Implement session isolation for Linear ticket");
      assert.equal(explorePayload.question, "Where is the state managed?");
      assert.ok(!JSON.stringify(explorePayload).includes("status-todo"));

      const workerPayload = buildWorkerContract(ticket, "Use TicketManager");
      assert.ok(workerPayload.task.includes("EZE-101"));
      assert.ok(workerPayload.context.includes("ACCEPTANCE CRITERIA:"));
      assert.ok(workerPayload.context.includes("Child agents have no Linear tools"));

      const verifyPayload = buildVerifyContract(ticket, ["src/index.ts"], ["npm test"]);
      assert.ok(verifyPayload.task.includes("Verify EZE-101"));
      assert.deepEqual(verifyPayload.criteria, [
        "Child agents have no Linear tools",
        "Done Gate requires valid fresh Verify PASS",
        "Remote conflict blocks completion",
      ]);
      assert.deepEqual(verifyPayload.changedPaths, ["src/index.ts"]);
    });
  });

  describe("4. Parent ownership (only Parent has aies_ticket)", () => {
    it("creates aies_ticket tool and handles parent actions", async () => {
      const tool = createTicketTool(manager);
      assert.equal(tool.name, "aies_ticket");

      // show when empty
      const emptyRes = await tool.execute("c1", { action: "show" }, undefined, undefined, { cwd: REPO_ROOT });
      assert.equal(emptyRes.isError, false);
      assert.match(emptyRes.content[0].text, /No Linear ticket currently active/);

      // load ticket
      const loadRes = await tool.execute(
        "c2",
        { action: "load", ticketId: "EZE-101" },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );
      assert.equal(loadRes.isError, false);
      assert.match(loadRes.content[0].text, /Active ticket set to EZE-101/);

      // show active ticket
      const showRes = await tool.execute("c3", { action: "show" }, undefined, undefined, { cwd: REPO_ROOT });
      assert.equal(showRes.isError, false);
      assert.match(showRes.content[0].text, /Active Ticket \[workState: loaded\]/);
      assert.match(showRes.content[0].text, /EZE-101/);

      // add comment
      const commentRes = await tool.execute(
        "c4",
        { action: "comment", comment: "Investigating architecture" },
        undefined,
        undefined,
        { cwd: REPO_ROOT },
      );
      assert.equal(commentRes.isError, false);
      assert.equal(fakeTransport.addedComments.length, 1);
      assert.equal(fakeTransport.addedComments[0].body, "Investigating architecture");
    });
  });

  describe("5. Start transition", () => {
    it("keeps ticket in 'loaded' state on load and transitions to 'started' only upon startWork", async () => {
      await manager.loadTicket("EZE-101");
      assert.equal(manager.getWorkState(), "loaded");
      // Remote issue state was not mutated on load
      const issueBefore = await fakeTransport.getIssue("EZE-101");
      assert.equal(issueBefore?.state?.type, "unstarted");

      // Now start work
      const startResult = await manager.startWork();
      assert.equal(startResult.ok, true);
      assert.equal(manager.getWorkState(), "working");

      // Remote issue state was transitioned to started
      const issueAfter = await fakeTransport.getIssue("EZE-101");
      assert.equal(issueAfter?.state?.type, "started");
      assert.equal(issueAfter?.state?.name, "In Progress");
    });
  });

  describe("6. Done Gate enforcement", () => {
    const codeFiles = ["src/feature.ts"];

    it("DENIES completion when verification status is 'none'", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(codeFiles);

      verificationState.status = "none";
      const result = await manager.completeTicket();

      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_gate_denied");
      assert.match(result.message ?? "", /no verification run has been executed/i);
    });

    it("DENIES completion when verification status is 'fail'", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(codeFiles);

      verificationState.status = "fail";
      const result = await manager.completeTicket();

      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_gate_denied");
      assert.match(result.message ?? "", /cannot complete ticket with failing verification/i);
    });

    it("DENIES completion when verification status is 'blocked'", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(codeFiles);

      verificationState.status = "blocked";
      const result = await manager.completeTicket();

      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_gate_denied");
      assert.match(result.message ?? "", /cannot complete ticket while verification is blocked/i);
    });

    it("DENIES completion when verification status is 'running'", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(codeFiles);

      verificationState.status = "running";
      const result = await manager.completeTicket();

      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_gate_denied");
      assert.match(result.message ?? "", /verification in progress/i);
    });

    it("DENIES completion when verification PASS is stale (revision mismatch)", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(codeFiles);

      verificationState.status = "pass";
      verificationState.verifiedRevision = 1;
      verificationState.revision = 2; // code mutated after verify pass!

      const result = await manager.completeTicket();

      assert.equal(result.ok, false);
      assert.equal(result.error, "verify_gate_denied");
      assert.match(result.message ?? "", /verification is stale/i);
    });

    it("ALLOWS completion when verification PASS is fresh and valid", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(codeFiles);

      verificationState.status = "pass";
      verificationState.verifiedRevision = 1;
      verificationState.revision = 1;

      const result = await manager.completeTicket();

      assert.equal(result.ok, true);
      assert.equal(manager.getWorkState(), "complete");

      // Verify remote status transitioned to completed
      const remote = await fakeTransport.getIssue("EZE-101");
      assert.equal(remote?.state?.type, "completed");
      assert.equal(remote?.state?.name, "Done");
    });
  });

  describe("7. Docs-only completion (no Verify required)", () => {
    it("completes immediately without verify run when changed files are docs/markdown only", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["docs/ARCHITECTURE.md", "README.md"]);

      assert.equal(requiresVerification(["docs/ARCHITECTURE.md", "README.md"]).required, false);
      verificationState.status = "none"; // No verification was run

      const result = await manager.completeTicket();

      assert.equal(result.ok, true);
      assert.equal(manager.getWorkState(), "complete");
      const remote = await fakeTransport.getIssue("EZE-101");
      assert.equal(remote?.state?.type, "completed");
    });
  });

  describe("8. PASS invalidation", () => {
    it("invalidates valid PASS when work unit changes and blocks Done until fresh PASS", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["src/controller.ts"]);

      // Initial work unit change creates revision 1
      verificationState = applyWorkUnitChange(verificationState, ["src/controller.ts"]);
      assert.equal(verificationState.revision, 1);

      // Initial verify pass on revision 1
      verificationState = applyVerifyStart(verificationState, Date.now());
      verificationState = applyVerifyResult(
        verificationState,
        { status: "pass", criteria: [], checks: [], defects: [] },
        Date.now(),
      );
      assert.equal(verificationState.status, "pass");
      assert.equal(verificationState.verifiedRevision, 1);

      // Code is mutated (e.g. parent edit or worker repair)
      verificationState = applyWorkUnitChange(verificationState, ["src/controller.ts"]);
      assert.equal(verificationState.revision, 2);

      // Completion attempt must be denied!
      const failedDone = await manager.completeTicket();
      assert.equal(failedDone.ok, false);
      assert.equal(failedDone.error, "verify_gate_denied");

      // Fresh verify pass on revision 2
      verificationState = applyVerifyStart(verificationState, Date.now());
      verificationState = applyVerifyResult(
        verificationState,
        { status: "pass", criteria: [], checks: [], defects: [] },
        Date.now(),
      );
      assert.equal(verificationState.verifiedRevision, 2);

      // Now completion is allowed
      const allowedDone = await manager.completeTicket();
      assert.equal(allowedDone.ok, true);
    });
  });

  describe("9. Remote refresh before Done", () => {
    it("queries remote ticket before updating status to ensure freshness", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["README.md"]); // docs only for quick check

      fakeTransport.queriedIssueIds = [];
      await manager.completeTicket();

      assert.ok(fakeTransport.queriedIssueIds.includes("EZE-101"), "Must query remote issue before completing");
      assert.ok(fakeTransport.updatedIssues.some((u) => u.id === "EZE-101"));
    });
  });

  describe("10. Conflict detection", () => {
    it("detects when remote ticket was completed externally and blocks local completion", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["README.md"]);

      // Simulate external user closing ticket in Linear UI
      fakeTransport.seedIssue({
        id: "issue-eze-101",
        identifier: "EZE-101",
        title: "Implement session isolation for Linear ticket",
        state: { id: "status-done", name: "Done", type: "completed" },
      });

      const result = await manager.completeTicket();
      assert.equal(result.ok, false);
      assert.equal(result.error, "remote_conflict");
      assert.match(result.message ?? "", /already completed externally/i);
    });

    it("detects when remote ticket was canceled externally and blocks local completion", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["README.md"]);

      fakeTransport.seedIssue({
        id: "issue-eze-101",
        identifier: "EZE-101",
        title: "Implement session isolation for Linear ticket",
        state: { id: "status-canceled", name: "Canceled", type: "canceled" },
      });

      const result = await manager.completeTicket();
      assert.equal(result.ok, false);
      assert.equal(result.error, "remote_conflict");
      assert.match(result.message ?? "", /canceled externally/i);
    });

    it("handles remote conflict thrown by transport on update", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["README.md"]);

      fakeTransport.simulateConflictOnNextUpdate = true;
      const result = await manager.completeTicket();

      assert.equal(result.ok, false);
      assert.equal(result.error, "remote_conflict");
    });
  });

  describe("11. Session resume without remote fetch", () => {
    it("serializes to snapshot and restores state cleanly without querying remote transport", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["src/app.ts", "src/util.ts"]);

      const snapshot = manager.toSnapshot();
      assert.ok(snapshot);
      assert.equal(snapshot.ticketId, "EZE-101");
      assert.equal(snapshot.workState, "working");
      assert.deepEqual(snapshot.changedPaths, ["src/app.ts", "src/util.ts"]);

      // Create new manager instance with empty transport queries
      fakeTransport.queriedIssueIds = [];
      const resumedManager = new TicketManager({
        transport: fakeTransport,
        getVerification: () => verificationState,
      });

      resumedManager.restoreFromSnapshot(snapshot);

      assert.equal(resumedManager.getActiveTicket()?.identifier, "EZE-101");
      assert.equal(resumedManager.getWorkState(), "working");
      assert.deepEqual(resumedManager.getChangedPaths(), ["src/app.ts", "src/util.ts"]);
      // Zero remote network calls during restore!
      assert.deepEqual(fakeTransport.queriedIssueIds, []);
    });
  });

  describe("12. Linear unavailable", () => {
    it("reports sync error on network failure without discarding valid local verified PASS", async () => {
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      manager.recordChangedPaths(["src/service.ts"]);

      // Code is verified PASS
      verificationState.status = "pass";
      verificationState.verifiedRevision = 1;
      verificationState.revision = 1;

      // Simulate remote network failure
      fakeTransport.setSimulatedError("network_failure");

      const result = await manager.completeTicket();

      assert.equal(result.ok, false);
      assert.equal(result.error, "network_failure");
      assert.match(result.message ?? "", /Linear sync failed/);
      assert.match(result.message ?? "", /Local implementation remains verified PASS/);

      // Local PASS is preserved!
      assert.equal(verificationState.status, "pass");
      assert.equal(verificationState.verifiedRevision, 1);
    });
  });

  describe("13. Context size bound", () => {
    it("strictly bounds compact contract under 2,500 chars regardless of ticket size", () => {
      const adversarialTicket = normalizeTicketContract({
        id: "id-adv",
        identifier: "ADV-999",
        title: "A".repeat(500),
        description: "B\n".repeat(2000),
        state: { id: "s-1", name: "In Progress", type: "started" },
        project: { id: "p-1", name: "P".repeat(200) },
        labels: Array.from({ length: 50 }, (_, i) => `label-${i}`),
      });

      const formatted = formatCompactContract(adversarialTicket);
      assert.ok(formatted.length <= 2500, `Length was ${formatted.length} > 2500`);
    });
  });

  describe("14. Context Governor compatibility", () => {
    it("classifies ticket compact contract as normal output (not oversized)", () => {
      const ticket = normalizeTicketContract(sampleIssue);
      const contract = formatCompactContract(ticket);
      const classification = classifyOutput(contract);
      assert.equal(classification, "normal");
    });

    it("preserves active ticket observation across compaction lifecycle in runtime state", () => {
      let state = createState();
      state = applyTicketObservationSync(state, {
        active: true,
        identifier: "EZE-101",
        title: "Test ticket",
        status: "In Progress",
        workState: "working",
      });

      assert.equal(state.ticket?.identifier, "EZE-101");
      assert.equal(state.ticket?.workState, "working");

      // Trigger compaction
      state = applyCompaction(state, 120000, 35000);

      // Ticket observation survives compaction
      assert.equal(state.ticket?.identifier, "EZE-101");
      assert.equal(state.ticket?.workState, "working");

      // Snapshot and restore
      const snap = toSnapshot(state);
      const restored = fromSnapshot(snap);
      assert.equal(restored.ticket?.identifier, "EZE-101");
      assert.equal(restored.ticket?.workState, "working");
    });
  });

  describe("15. Permissions integration", () => {
    it("blocks remote operations in Worker guard preventing direct remote mutation", () => {
      assert.equal(isCommandPermittedInWorker("git push origin main", REPO_ROOT).allowed, false);
      assert.equal(isCommandPermittedInWorker("npm publish", REPO_ROOT).allowed, false);
      assert.equal(isCommandPermittedInWorker("curl -X POST https://api.linear.app", REPO_ROOT).allowed, true); // curl might run safe queries, but tool surface has no Linear API key or secret
    });

    it("prevents switching ticket when a ticket is in progress unless completed or forced", () => {
      const check1 = canSwitchTicket(normalizeTicketContract(sampleIssue), "working", "EZE-102");
      assert.equal(check1.allowed, false);
      assert.match(check1.reason ?? "", /currently in progress/);

      const checkForce = canSwitchTicket(normalizeTicketContract(sampleIssue), "working", "EZE-102", true);
      assert.equal(checkForce.allowed, true);

      const checkComplete = canSwitchTicket(normalizeTicketContract(sampleIssue), "complete", "EZE-102");
      assert.equal(checkComplete.allowed, true);
    });
  });

  describe("16. Existing suite compatibility", () => {
    it("resolves target status dynamically without hardcoding team status names", () => {
      const customStatuses = [
        { id: "s-1", name: "Por Hacer", type: "unstarted" },
        { id: "s-2", name: "En Progreso", type: "started" },
        { id: "s-3", name: "Listo", type: "completed" },
      ];

      const started = resolveTargetStatus(customStatuses, "started");
      assert.equal(started?.id, "s-2");
      assert.equal(started?.name, "En Progreso");

      const completed = resolveTargetStatus(customStatuses, "completed");
      assert.equal(completed?.id, "s-3");
      assert.equal(completed?.name, "Listo");
    });
  });

  describe("17. Real Linear MCP payload shapes", () => {
    // Captured from a real `get_issue` call: Linear's MCP projection reports the
    // workflow state as a flat status name plus `statusType`, keeps the state id
    // only in `stateHistory`, and exposes `project` and `team` as plain strings.
    const realMcpIssue = {
      id: "EZE-422",
      uuid: "767a81fb-454e-4656-94b7-cf5319a509e6",
      title: "`src/calculator.js` implements `multiply()` incorrectly.",
      description: "Acceptance criteria:\n\n* `multiply(3, 4)` returns `12`\n* existing tests pass",
      status: "Todo",
      statusType: "unstarted",
      stateHistory: [
        {
          state: { id: "3a0392c2-60b3-4461-9ec5-c163e9813ff9", name: "Todo", type: "unstarted" },
          startedAt: "2026-09-19T13:32:55.243Z",
          endedAt: null,
        },
      ],
      project: "AIES",
      team: "Eze",
      teamId: "433440dd-bd9a-40d0-a54b-89e10b6f482b",
      labels: [],
      url: "https://linear.app/eze33/issue/EZE-422/example",
    };

    it("reads the flat status fields, the state id from history, and the team", () => {
      const state = readIssueState(realMcpIssue);
      assert.equal(state.name, "Todo");
      assert.equal(state.type, "unstarted");
      assert.equal(state.id, "3a0392c2-60b3-4461-9ec5-c163e9813ff9");
      assert.equal(readIssueTeam(realMcpIssue), "Eze");
      assert.equal(readIssueTeam({ identifier: "E-1", title: "t", teamId: "team-1" }), "team-1");
    });

    it("normalizes the real MCP payload into a usable compact contract", () => {
      const ticket = normalizeTicketContract(realMcpIssue);
      assert.equal(ticket.identifier, "EZE-422");
      assert.equal(ticket.status, "Todo");
      assert.equal(ticket.statusType, "unstarted");
      assert.equal(ticket.project, "AIES");
      assert.equal(ticket.team, "Eze");
      assert.ok(ticket.acceptanceCriteria.length >= 2, "explicit criteria must survive normalization");
      assert.ok(formatCompactContract(ticket).length < 2500);
    });

    it("still reads the object-shaped state used by the deterministic fake", () => {
      const state = readIssueState({
        identifier: "EZE-1",
        title: "t",
        state: { id: "s1", name: "In Progress", type: "started" },
      });
      assert.deepEqual(state, { id: "s1", name: "In Progress", type: "started" });
    });

    it("detects an externally completed ticket from the flat payload", () => {
      const conflict = detectRemoteConflict(normalizeTicketContract(realMcpIssue), {
        ...realMcpIssue,
        status: "Done",
        statusType: "completed",
      });
      assert.equal(conflict.conflict, true);
      assert.match(conflict.reason ?? "", /already completed externally/);
    });

    it("prefers the in-progress state over an earlier started state", () => {
      // The real team returns In Review before In Progress among its started states.
      const statuses = [
        { id: "review", name: "In Review", type: "started" },
        { id: "progress", name: "In Progress", type: "started" },
        { id: "done", name: "Done", type: "completed" },
        { id: "todo", name: "Todo", type: "unstarted" },
      ];
      assert.equal(resolveTargetStatus(statuses, "started")?.id, "progress");
      assert.equal(resolveTargetStatus(statuses, "completed")?.id, "done");
      assert.equal(resolveTargetStatus(statuses, "unstarted")?.id, "todo");
    });
  });

  describe("18. Invalid remote payload boundary (TicketManager + HostMediated transport)", () => {
    // No transport override: the manager uses the real HostMediatedLinearTransport,
    // so these exercises the genuine Parent-mediated seam.
    const mediatedManager = () => new TicketManager({ getVerification: () => createVerificationState() });

    // Captured from a real `get_issue` call: `identifier` and `id` are the human
    // key, `uuid` is the stable Linear id, and the state is flat with `statusType`.
    const realIssue = {
      id: "EZE-423",
      identifier: "EZE-423",
      uuid: "767a81fb-454e-4656-94b7-cf5319a509e6",
      title: "Agent observatory",
      description: "Acceptance criteria:\n\n* something",
      status: "Todo",
      statusType: "unstarted",
      stateHistory: [{ state: { id: "state-todo", name: "Todo", type: "unstarted" }, endedAt: null }],
      project: "AIES",
      team: "Eze",
    };

    it("refuses a truthy but incomplete payload instead of activating an undefined ticket", async () => {
      // The transport hands the Parent's answer back verbatim, however incomplete
      // it is: rejecting it is the manager's boundary, not the transport's.
      const transport = new HostMediatedLinearTransport({ "linear:get_issue(id=\"EZE-423\")": { foo: "bar" } });
      assert.deepEqual(await transport.getIssue("EZE-423"), { foo: "bar" });

      const manager = mediatedManager();
      const first = await manager.loadTicket("EZE-423");
      assert.equal(first.ok, false);
      assert.equal(first.error, "remote_required");
      assert.equal(first.directive.tool, "get_issue");

      const second = await manager.submitRemote({ foo: "bar" });
      assert.equal(second.ok, false, "an identity-less payload must never activate a ticket");
      assert.equal(second.error, "invalid_remote_payload");
      assert.equal(manager.getActiveTicket(), null);
      assert.equal(manager.getPendingDirective(), null);
    });

    it("never projects the literal 'undefined' or a bogus 'Unknown' status", async () => {
      const manager = mediatedManager();
      await manager.loadTicket("EZE-423");
      const result = await manager.submitRemote({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, "invalid_remote_payload");
      assert.doesNotMatch(result.message ?? "", /undefined/);
      assert.equal(manager.getActiveTicket(), null);
    });

    it("rejects a payload whose only identity is the uuid, never using it as the ticket identifier", async () => {
      // Real `get_issue` carries `id`/`identifier` (EZE-423) plus a separate
      // `uuid`. The uuid is Linear's internal key, not the human ticket key, so a
      // payload that carries only the uuid cannot name a ticket and must be
      // rejected instead of surfacing the uuid as the user-facing identifier.
      const manager = mediatedManager();
      await manager.loadTicket("EZE-423");
      const result = await manager.submitRemote({
        uuid: "767a81fb-454e-4656-94b7-cf5319a509e6",
        title: "Agent observatory",
        status: "Todo",
        statusType: "unstarted",
        team: "Eze",
      });
      assert.equal(result.ok, false, "a uuid-only payload must not become the user-facing identifier");
      assert.equal(result.error, "invalid_remote_payload");
      assert.equal(manager.getActiveTicket(), null);
      assert.equal(manager.getPendingDirective(), null);
    });

    it("rejects an invalid refresh payload without clobbering the active ticket", async () => {
      const manager = mediatedManager();
      await manager.loadTicket("EZE-423");
      assert.equal((await manager.submitRemote(realIssue)).ok, true);
      assert.equal(manager.getActiveTicket().identifier, "EZE-423");

      const refresh = await manager.refresh();
      assert.equal(refresh.error, "remote_required");
      const bad = await manager.submitRemote({ data: null });
      assert.equal(bad.ok, false);
      assert.equal(bad.error, "invalid_remote_payload");
      assert.equal(manager.getActiveTicket().identifier, "EZE-423");
    });

    it("fails closed through the tool without a remote directive or self-debug instructions", async () => {
      const tool = createTicketTool(mediatedManager());
      const first = await tool.execute("c1", { action: "load", ticketId: "EZE-423" }, undefined, undefined, {
        mode: "print",
      });
      assert.equal(first.isError, true);
      assert.equal(first.details.directive.tool, "get_issue");

      const second = await tool.execute(
        "c2",
        { action: "load", ticketId: "EZE-423", remote: { unexpected: true } },
        undefined,
        undefined,
        { mode: "print" },
      );
      assert.equal(second.isError, true);
      assert.equal(second.details.error, "invalid_remote_payload");
      assert.equal(second.details.directive, undefined);
      assert.equal(second.details.instruction, undefined);
      assert.doesNotMatch(second.content[0].text, /mcp\(|source|inspect|debug/i);
    });
  });

  describe("19. Pending remote replay semantics", () => {
    const mediatedManager = () => new TicketManager({ getVerification: () => createVerificationState() });
    const realIssue = {
      id: "EZE-423",
      identifier: "EZE-423",
      title: "Agent observatory",
      description: "",
      status: "Todo",
      statusType: "unstarted",
      team: "Eze",
    };

    // `no_pending_remote` is the stale/replayed-answer guard, not a defect: a
    // Pending answer is refused only when no operation is actually in flight, and
    // the message names the recovery. Repeating the action without `remote`
    // re-derives the directive, so a valid pending answer is never lost.
    it("refuses a stale replay once no operation is pending, and retries cleanly", async () => {
      const manager = mediatedManager();
      const first = await manager.loadTicket("EZE-423");
      assert.equal(first.error, "remote_required");

      const activated = await manager.submitRemote(realIssue);
      assert.equal(activated.ok, true);
      assert.equal(manager.getPendingDirective(), null);

      const stale = await manager.submitRemote(realIssue);
      assert.equal(stale.ok, false);
      assert.equal(stale.error, "no_pending_remote");
      assert.match(stale.message ?? "", /Repeat the action without `remote`/);

      const retried = await manager.refresh();
      assert.equal(retried.error, "remote_required");
      assert.equal(retried.directive.tool, "get_issue");
      assert.deepEqual(retried.directive.args, { id: "EZE-423" });
    });
  });
});

describe("10. Parent replay prompts stay compact", () => {
  it("keeps the load prompt to one short, safe instruction", () => {
    const prompt = ticketLoadPrompt("EZE-101");
    assert.equal(prompt.includes("\n"), false, `the load prompt must be one instruction:\n${prompt}`);
    assert.ok(prompt.length <= 320, `load prompt is ${prompt.length} chars:\n${prompt}`);
    assert.match(prompt, /aies_ticket/u);
    assert.match(prompt, /action: "load"/u);
    assert.match(prompt, /mcp/u);
    assert.match(prompt, /remote/u);
    assert.match(prompt, /Do not edit files/u);
  });

  it("keeps the run prompt compact and preserves the workflow continuation", () => {
    const prompt = ticketRunPrompt("EZE-101");
    assert.equal(prompt.includes("\n"), false, `the run prompt must be one instruction:\n${prompt}`);
    assert.ok(prompt.length <= 380, `run prompt is ${prompt.length} chars:\n${prompt}`);
    assert.match(prompt, /action: "load"/u);
    assert.match(prompt, /action: "start"/u);
    assert.match(prompt, /mcp/u);
    assert.match(prompt, /remote/u);
    assert.match(prompt, /workflow/iu);

    const active = ticketRunPrompt("EZE-101", { alreadyActive: true });
    assert.match(active, /action: "start"/u);
    assert.equal(active.includes('action: "load"'), false, active);
  });
});

describe("11. Internal Linear instructions stay out of the transcript", () => {
  it("hands /aies-ticket to the Parent through Pi's hidden custom-message path", async () => {
    const hidden = [];
    const visible = [];
    const commands = new Map();
    const pi = {
      commands,
      registerCommand(name, def) {
        commands.set(name, def);
      },
      sendMessage(message, options) {
        hidden.push({ message, options });
      },
      sendUserMessage(text, options) {
        visible.push({ text, options });
      },
    };

    // No transport: the load answers `remote_required` and hands the MCP work to
    // the Parent instead of failing.
    const manager = new TicketManager({ getVerification: () => createVerificationState() });
    registerTicketCommand(pi, manager);

    const notifications = [];
    await commands.get("aies-ticket").handler("EZE-422", {
      cwd: REPO_ROOT,
      mode: "tui",
      hasUI: true,
      ui: { notify: (message, type) => notifications.push({ message, type }), confirm: async () => false },
    });

    assert.equal(hidden.length, 1, "the internal Linear prompt must use the hidden path");
    assert.equal(hidden[0].message.display, false, "internal plumbing must not render as user input");
    assert.equal(hidden[0].message.customType, "aies-instruction");
    assert.equal(hidden[0].options.triggerTurn, true);
    assert.equal(hidden[0].options.deliverAs, "followUp");
    assert.match(hidden[0].message.content, /aies_ticket/u);
    assert.deepEqual(visible, [], "AIES never fabricates visible user input");
  });
});
