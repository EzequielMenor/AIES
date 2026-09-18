/**
 * Real smoke test for AIES-005: Parent -> Explore -> Worker -> Verify(FAIL)
 * -> Worker repair -> Verify(PASS).
 *
 * The scenario is realistic and deliberately defective: the Worker is asked to
 * bring `TIMEOUT_MS` to 2000, writes 1500, and reports success. Independent
 * verification inspects the artifact, not the report, and fails. The parent then
 * runs one bounded repair cycle with a fresh Verify.
 *
 * What it measures:
 * - how much work happens outside the parent and how little comes back;
 * - parent tool calls (5 delegations) against the children's internal tool calls;
 * - handoff sizes against the payload the children pulled in;
 * - verification attempts, repair cycles and the validity of the final PASS.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  formatExploreHandoff,
  formatRepairBrief,
  formatVerifyHandoff,
  formatWorkerHandoff,
} from "../extensions/aies-agents/handoff.ts";
import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkerRepairStart,
  applyWorkerResult,
  buildRepairContext,
  buildVerifyTaskInput,
  createVerificationState,
  isVerificationValid,
  planVerification,
  requiresVerification,
  toVerificationReport,
} from "../extensions/aies-agents/verification.ts";
import { runVerifyAgent } from "../extensions/aies-agents/verify.ts";
import { runWorkerAgent } from "../extensions/aies-agents/worker.ts";
import {
  applyDelegationEnd,
  applyDelegationStart,
  applyToolCall,
  applyToolResult,
  createState,
} from "../extensions/aies-runtime/state.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const TIMEOUT_CRITERION = "TIMEOUT_MS in config.js is 2000";
const CHECK_CRITERION = "npm test passes";

function exploreHandoffJson() {
  return `\`\`\`json
{
  "status": "done",
  "summary": "The request timeout lives in config.js as TIMEOUT_MS.",
  "evidence": [{ "file": "config.js", "lines": "1-2", "note": "Exports TIMEOUT_MS" }],
  "issues": [],
  "next": ["Delegate the timeout change to Worker"]
}
\`\`\``;
}

function workerHandoffJson({ claim, file }) {
  return `\`\`\`json
{
  "status": "done",
  "summary": "${claim}",
  "changes": [{ "file": "${file}", "description": "Updated TIMEOUT_MS" }],
  "checks": [{ "check": "npm test", "result": "passed" }],
  "issues": [],
  "next": ["Ready for independent verification"]
}
\`\`\``;
}

function verifyHandoffJson({ status, observed, defect }) {
  return `\`\`\`json
{
  "status": "${status}",
  "summary": "${status === "pass" ? "The artifact matches the criteria." : "The artifact does not match the criteria."}",
  "criteria": [
    { "criterion": "${TIMEOUT_CRITERION}", "status": "${status}", "evidence": "config.js:1 shows ${observed}" },
    { "criterion": "${CHECK_CRITERION}", "status": "pass", "evidence": "npm test exit 0" }
  ],
  "checks": [{ "check": "npm test", "result": "exit 0" }],
  "defects": ${defect ? JSON.stringify([defect]) : "[]"},
  "next": []
}
\`\`\``;
}

describe("AIES-005 Real Smoke: Parent -> Worker -> Verify FAIL -> repair -> Verify PASS", () => {
  it("fails on the real defect, repairs once with a fresh Verify, and passes", async () => {
    const startedAt = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "aies-smoke-005-"));

    try {
      const configFile = join(dir, "config.js");
      writeFileSync(configFile, "export const TIMEOUT_MS = 1000;\n");

      const faux = fauxProvider();
      const runtime = await ModelRuntime.create();
      runtime.registerNativeProvider(faux.provider);
      const model = faux.models[0];

      // ------------------------------------------------------------------
      // Metrics: what the parent sees, and what the children actually pulled.
      // ------------------------------------------------------------------
      const task = "Bring the request timeout to 2000ms and keep the checks green";
      let parentContextChars = task.length;
      let childrenToolPayloadChars = 0;
      let childToolCalls = 0;

      // What a child session starts with (its role prompt) plus what its tools
      // returned, measured against what actually came back to the parent. The
      // role prompt is a fact of the design: it never enters parent context.
      const rolePromptChars = (role) => readFileSync(join(REPO_ROOT, "agents", `${role}.md`), "utf8").length;
      let childrenContextChars = 0;
      const withChild = (role, payloadChars) => {
        childrenContextChars += rolePromptChars(role) + payloadChars;
      };

      let parent = createState(startedAt);
      let verification = createVerificationState();

      const delegate = (role, input) => {
        parent = applyToolCall(parent, { toolName: "aies_delegate", input: { role, ...input } }, Date.now(), dir);
        parent = applyDelegationStart(parent, role, Date.now());
      };
      const settle = (text) => {
        parent = applyToolResult(parent, { content: text, isError: false }, Date.now());
        parent = applyDelegationEnd(parent, "done", Date.now());
        parentContextChars += text.length;
      };

      // ------------------------------------------------------------------
      // 1. Explore
      // ------------------------------------------------------------------
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("tgrep", { pattern: "TIMEOUT_MS", filesOnly: true }, "c1")]),
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c2")]),
        fauxAssistantMessage([{ type: "text", text: exploreHandoffJson() }]),
      ]);
      childToolCalls += 2;
      childrenToolPayloadChars += readFileSync(configFile, "utf8").length;
      withChild("explore", readFileSync(configFile, "utf8").length);

      delegate("explore", { task: "Locate the request timeout configuration" });
      const exploreHandoff = await runExploreAgent({
        task: "Locate the request timeout configuration",
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        tgrepRunner: async () => ({ stdout: "config.js\n" }),
      });
      const exploreHandoffSize = formatExploreHandoff(exploreHandoff).length;
      settle(formatExploreHandoff(exploreHandoff));

      assert.equal(exploreHandoff.status, "done");
      assert.deepEqual(
        requiresVerification(exploreHandoff.evidence.map((entry) => entry.file)),
        requiresVerification(["config.js"]),
      );

      // ------------------------------------------------------------------
      // 2. Worker #1 — writes 1500 and claims success. The defect is real.
      // ------------------------------------------------------------------
      const workerClaim = "TIMEOUT_MS is now 2000 and npm test passes";
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "config.js", content: "export const TIMEOUT_MS = 1500;\n" }, "c3"),
        ]),
        fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" }, "c4")]),
        fauxAssistantMessage([{ type: "text", text: workerHandoffJson({ claim: workerClaim, file: "config.js" }) }]),
      ]);
      childToolCalls += 2;
      childrenToolPayloadChars += "3 checks passed\n".length;
      withChild("worker", "3 checks passed\n".length);

      delegate("worker", { task, context: "TIMEOUT_MS lives in config.js" });
      const workerHandoff = await runWorkerAgent({
        task,
        context: "TIMEOUT_MS lives in config.js",
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        bashRunner: async () => ({ stdout: "3 checks passed\n", exitCode: 0 }),
      });
      const workerHandoffText = formatWorkerHandoff(workerHandoff);
      settle(workerHandoffText);

      assert.equal(workerHandoff.status, "done");
      assert.equal(readFileSync(configFile, "utf8"), "export const TIMEOUT_MS = 1500;\n");

      verification = applyWorkerResult(verification, workerHandoff.changes.map((change) => change.file));
      assert.equal(verification.awaitingVerification, true, "a behaviour-bearing change requires Verify");
      assert.equal(planVerification(verification).action, "verify");

      // ------------------------------------------------------------------
      // 3. Verify #1 — fresh context, real artifact, FAIL.
      // ------------------------------------------------------------------
      const verifyCriteria = [TIMEOUT_CRITERION, CHECK_CRITERION];

      // The Verify child is built from the work unit and the criteria alone; the
      // Worker's success claim has no field to travel in.
      assert.equal(
        buildVerifyTaskInput({
          task,
          criteria: verifyCriteria,
          changedPaths: workerHandoff.changes.map((change) => change.file),
        }).includes(workerClaim),
        false,
        "the Worker claim has no path into Verify",
      );

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c5")]),
        fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" }, "c6")]),
        fauxAssistantMessage([
          {
            type: "text",
            text: verifyHandoffJson({
              status: "fail",
              observed: "TIMEOUT_MS = 1500",
              defect: {
                severity: "blocking",
                file: "config.js",
                description: "TIMEOUT_MS is 1500, expected 2000",
                evidence: "read config.js:1",
              },
            }),
          },
        ]),
      ]);
      childToolCalls += 2;
      childrenToolPayloadChars += "3 checks passed\n".length;
      withChild("verify", "3 checks passed\n".length);

      const verifyOneStart = Date.now();
      delegate("verify", { task, criteria: verifyCriteria, changedPaths: ["config.js"] });
      const verifyOne = await runVerifyAgent({
        task,
        criteria: verifyCriteria,
        changedPaths: ["config.js"],
        checks: ["npm test"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        bashRunner: async () => ({ stdout: "3 checks passed\n", exitCode: 0 }),
      });
      verification = applyVerifyResult(
        applyVerifyStart(verification, verifyOneStart),
        verifyOne,
        Date.now(),
      );
      settle(formatVerifyHandoff(verifyOne));

      assert.equal(verifyOne.status, "fail", "verify #1 must fail on the real defect");
      assert.equal(verifyOne.defects[0].file, "config.js");
      assert.equal(verification.status, "fail");
      assert.equal(planVerification(verification).action, "repair");
      assert.equal(planVerification(verification).repair, 1);

      // ------------------------------------------------------------------
      // 4. Worker repair — receives the defects, never the Verify transcript.
      // ------------------------------------------------------------------
      const repairBrief = formatRepairBrief(verifyOne);
      const repairContext = buildRepairContext({
        task,
        criteria: verifyCriteria,
        changedPaths: ["config.js"],
        brief: repairBrief,
      });
      assert.equal(repairContext.includes(verifyOne.summary), false, "no Verify narrative is forwarded");
      assert.match(repairContext, /TIMEOUT_MS is 1500, expected 2000/u);

      verification = applyWorkerRepairStart(verification);
      assert.equal(verification.repairs, 1);

      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("write", { path: "config.js", content: "export const TIMEOUT_MS = 2000;\n" }, "c7"),
        ]),
        fauxAssistantMessage([{ type: "text", text: workerHandoffJson({ claim: "Fixed the reported defect", file: "config.js" }) }]),
      ]);
      childToolCalls += 1;
      childrenToolPayloadChars += "3 checks passed\n".length;
      withChild("worker", 0);

      delegate("worker", { task, context: repairContext });
      const repairHandoff = await runWorkerAgent({
        task,
        context: repairContext,
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });
      settle(formatWorkerHandoff(repairHandoff));

      assert.equal(readFileSync(configFile, "utf8"), "export const TIMEOUT_MS = 2000;\n");
      verification = applyWorkerResult(verification, repairHandoff.changes.map((change) => change.file));

      // ------------------------------------------------------------------
      // 5. Verify #2 — fresh context again, and this time the artifact is right.
      // ------------------------------------------------------------------
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c8")]),
        fauxAssistantMessage([
          {
            type: "text",
            text: verifyHandoffJson({ status: "pass", observed: "TIMEOUT_MS = 2000", defect: null }),
          },
        ]),
      ]);
      childToolCalls += 1;
      childrenToolPayloadChars += readFileSync(configFile, "utf8").length;
      withChild("verify", readFileSync(configFile, "utf8").length);

      const verifyTwoStart = Date.now();
      delegate("verify", { task, criteria: verifyCriteria, changedPaths: ["config.js"] });
      const verifyTwo = await runVerifyAgent({
        task,
        criteria: verifyCriteria,
        changedPaths: ["config.js"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
      });
      verification = applyVerifyResult(applyVerifyStart(verification, verifyTwoStart), verifyTwo, Date.now());
      settle(formatVerifyHandoff(verifyTwo));

      // ------------------------------------------------------------------
      // Assertions: the verified state is the real repository state.
      // ------------------------------------------------------------------
      assert.equal(verifyTwo.status, "pass", "verify #2 must pass on the repaired artifact");
      assert.equal(verification.attempts, 2);
      assert.equal(verification.repairs, 1);
      assert.equal(isVerificationValid(verification), true);
      assert.equal(planVerification(verification).action, "done");

      const report = toVerificationReport(verification);
      assert.equal(report.status, "pass");
      assert.equal(report.valid, true);

      // The parent did 5 delegations; the children did the real work.
      assert.equal(parent.tools.calls, 5, "the parent sees one call per delegation");
      assert.equal(parent.tools.callsByName.aies_delegate, 5);
      assert.equal(parent.exploration.sourceReads, 0, "child reads never count as parent reads");
      assert.equal(parent.exploration.searches, 0);
      assert.equal(parent.exploration.shellInspections, 0);
      assert.equal(parent.delegations.byRole.explore, 1);
      assert.equal(parent.delegations.byRole.worker, 2);
      assert.equal(parent.delegations.byRole.verify, 2);
      assert.equal(parent.delegations.byOutcome.done, 5);

      // The children did the work, and their context stayed theirs.
      assert.ok(childToolCalls >= 8, `children ran ${childToolCalls} tool calls`);
      assert.ok(
        parentContextChars < childrenContextChars / 5,
        `parent absorbed ${parentContextChars} chars of ${childrenContextChars} that the children ran on`,
      );

      const handoffs = [
        formatExploreHandoff(exploreHandoff),
        workerHandoffText,
        formatVerifyHandoff(verifyOne),
        formatWorkerHandoff(repairHandoff),
        formatVerifyHandoff(verifyTwo),
      ];
      for (const handoff of handoffs) {
        assert.ok(handoff.length < 6000, "every handoff stays under the cap");
      }
      assert.ok(exploreHandoffSize < 1000);
      assert.ok(Math.max(...handoffs.map((entry) => entry.length)) < 2000);

      // The artifact, not the report, is what verification trusted.
      assert.equal(
        verifyOne.criteria[0].evidence.includes("1500"),
        true,
        "verify #1 reported the value it read",
      );
      assert.equal(
        verifyTwo.criteria[0].evidence.includes("2000"),
        true,
        "verify #2 reported the repaired value",
      );

      const metrics = {
        parentContextChars,
        childrenContextChars,
        childrenToolPayloadChars,
        childToolCalls,
        parentToolCalls: parent.tools.calls,
        handoffChars: handoffs.map((entry) => entry.length),
        verifyAttempts: verification.attempts,
        repairCycles: verification.repairs,
        elapsedMs: Date.now() - startedAt,
      };

      assert.equal(metrics.verifyAttempts, 2);
      assert.equal(metrics.repairCycles, 1);
      assert.ok(metrics.elapsedMs >= 0);
      assert.equal(metrics.parentToolCalls, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
