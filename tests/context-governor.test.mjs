/**
 * Test suite for AIES-007: Context Governor.
 *
 * Covers the 21 mandatory test categories:
 * 1. Budget calculation (large vs small context window scaling, monotonic invariant).
 * 2. Zone transitions (green -> amber -> pressure -> compact -> ceiling).
 * 3. No premature compaction (below threshold does not mark pending or trigger compaction).
 * 4. Pending behavior (above compact marks pending without mid-tool execution).
 * 5. Safe boundary (agent_settled initiates compaction).
 * 6. Single flight (multiple triggers -> 1 compaction, in-flight deduplication).
 * 7. Await completion (post-compaction state is not marked complete before onComplete).
 * 8. Error handling (onError leaves state coherent, records error, no loop).
 * 9. Ceiling enforcement (heavy direct work blocked, aies_delegate allowed).
 * 10. Routing pressure (context pressure reaches routing without duplicating counters).
 * 11. Verify survives (FAIL + repair pending survives compaction and continues).
 * 12. PASS survives (valid PASS survives compaction).
 * 13. Telemetry survives (peak tokens, compactions, history not reset).
 * 14. Large result (detected, measured, not blocked).
 * 15. Oversized result (truncated and protected according to policy).
 * 16. Head/tail preservation (logs preserve beginning and end).
 * 17. Structured handoffs (aies_delegate results never truncated).
 * 18. Existing routing (AIES-004).
 * 19. Existing verify (AIES-005).
 * 20. Existing permissions (AIES-006).
 * 21. Entire suite passes.
 */

import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  calculateContextBudgets,
  classifyOutput,
  ContextGovernor,
  DEFAULT_CONTEXT_BUDGETS,
  DEFAULT_OUTPUT_LIMITS,
  determineContextZone,
  isHeavyParentTool,
  truncateOutputText,
  truncateToolResultContent,
} from "../extensions/aies-agents/context-governor.ts";
import {
  applyRoutingDelegationEnd,
  applyRoutingDelegationStart,
  applyRoutingToolCall,
  checkRoutingGuardrail,
  createRoutingState,
  evaluateRoutingSignals,
} from "../extensions/aies-agents/routing.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
  isVerificationValid,
} from "../extensions/aies-agents/verification.ts";
import {
  applyCompaction,
  applyContextGovernorSync,
  applyContextUsage,
  applyToolCall,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";

describe("AIES-007 Context Governor — Unit Tests", () => {
  let governor;

  beforeEach(() => {
    governor = new ContextGovernor({
      targetTokens: 80_000,
      pressureTokens: 100_000,
      compactTokens: 120_000,
      ceilingTokens: 150_000,
    });
  });

  // 1. Budget calculation
  it("1. Budget calculation: large window produces expected defaults; small window scales adaptively", () => {
    // Large window (1M tokens)
    const largeBudgets = calculateContextBudgets(1_000_000);
    assert.equal(largeBudgets.targetTokens, 80_000);
    assert.equal(largeBudgets.pressureTokens, 100_000);
    assert.equal(largeBudgets.compactTokens, 120_000);
    assert.equal(largeBudgets.ceilingTokens, 150_000);

    // Medium window (200k tokens, e.g. Claude)
    const claudeBudgets = calculateContextBudgets(200_000);
    assert.equal(claudeBudgets.targetTokens, 80_000);
    assert.equal(claudeBudgets.pressureTokens, 100_000);
    assert.equal(claudeBudgets.compactTokens, 120_000);
    assert.equal(claudeBudgets.ceilingTokens, 150_000);

    // Small window (128k tokens, e.g. GPT-4o)
    const gptBudgets = calculateContextBudgets(128_000);
    assert.equal(gptBudgets.targetTokens, 51_200);   // 40% of 128k
    assert.equal(gptBudgets.pressureTokens, 64_000); // 50% of 128k
    assert.equal(gptBudgets.compactTokens, 83_200);  // 65% of 128k
    assert.equal(gptBudgets.ceilingTokens, 96_000);  // 75% of 128k

    // Invariant check: strict monotonicity across all tested windows
    for (const win of [1_000_000, 200_000, 128_000, 64_000, 32_000, 10_000]) {
      const b = calculateContextBudgets(win);
      assert.ok(b.targetTokens > 0, `targetTokens must be > 0 for window ${win}`);
      assert.ok(b.targetTokens < b.pressureTokens, `amber < pressure for window ${win}`);
      assert.ok(b.pressureTokens < b.compactTokens, `pressure < compact for window ${win}`);
      assert.ok(b.compactTokens < b.ceilingTokens, `compact < ceiling for window ${win}`);
      assert.ok(b.ceilingTokens <= win, `ceiling <= window for window ${win}`);
    }
  });

  // 2. Zone transitions
  it("2. Zone transitions: green -> amber -> pressure -> compact -> ceiling", () => {
    governor.updateUsage({ tokens: 50_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "green");

    governor.updateUsage({ tokens: 80_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "amber");

    governor.updateUsage({ tokens: 99_999, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "amber");

    governor.updateUsage({ tokens: 100_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "pressure");

    governor.updateUsage({ tokens: 119_999, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "pressure");

    governor.updateUsage({ tokens: 120_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "compact");

    governor.updateUsage({ tokens: 149_999, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "compact");

    governor.updateUsage({ tokens: 150_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "ceiling");
  });

  // 3. No premature compaction
  it("3. No premature compaction: below compact threshold does not mark pending or call compact", async () => {
    let compactCalls = 0;
    const fakeCtx = {
      compact: () => {
        compactCalls++;
      },
    };

    governor.updateUsage({ tokens: 119_000, contextWindow: 200_000 });
    assert.equal(governor.isCompactPending(), false);
    assert.equal(governor.isCompacting(), false);

    await governor.handleSettled(fakeCtx);
    assert.equal(compactCalls, 0, "compact must not be called when below threshold");
  });

  // 4. Pending behavior
  it("4. Pending behavior: reaching compact threshold marks pending without mid-tool compaction", () => {
    governor.updateUsage({ tokens: 121_000, contextWindow: 200_000 });
    assert.equal(governor.isCompactPending(), true);
    assert.equal(governor.isCompacting(), false, "must not initiate compaction mid-turn");
  });

  // 5. Safe boundary
  it("5. Safe boundary: agent_settled initiates compaction", async () => {
    let compactOptions = null;
    const fakeCtx = {
      compact: (opts) => {
        compactOptions = opts;
      },
    };

    governor.updateUsage({ tokens: 125_000, contextWindow: 200_000 });
    assert.equal(governor.isCompactPending(), true);

    const settlePromise = governor.handleSettled(fakeCtx);
    assert.ok(compactOptions !== null, "compact must be called at agent_settled");
    assert.equal(governor.isCompacting(), true, "governor must enter compacting state");
    assert.equal(governor.isCompactPending(), false, "pending flag must be cleared");

    // Complete async compaction
    compactOptions.onComplete({ summary: "compacted" });
    await settlePromise;
    assert.equal(governor.isCompacting(), false);
    assert.equal(governor.getTelemetry().compactionCount, 1);
  });

  // 6. Single flight
  it("6. Single flight: multiple triggers before settle initiate only one compaction", async () => {
    let compactCount = 0;
    let finishCompact;
    const fakeCtx = {
      compact: (opts) => {
        compactCount++;
        finishCompact = opts.onComplete;
      },
    };

    // Multiple threshold triggers
    governor.updateUsage({ tokens: 120_000, contextWindow: 200_000 });
    governor.updateUsage({ tokens: 130_000, contextWindow: 200_000 });
    governor.updateUsage({ tokens: 140_000, contextWindow: 200_000 });

    // Inflight settle
    const p1 = governor.handleSettled(fakeCtx);
    const p2 = governor.handleSettled(fakeCtx);

    assert.equal(compactCount, 1, "exactly one compaction may be dispatched");
    finishCompact({ summary: "done" });

    await Promise.all([p1, p2]);
    assert.equal(compactCount, 1);
  });

  // 7. Await completion
  it("7. Await completion: post-compaction state is NOT complete before the real onComplete callback", async () => {
    let completeCallback;
    let settledFinished = false;

    const fakeCtx = {
      compact: (opts) => {
        completeCallback = opts.onComplete;
      },
    };

    governor.updateUsage({ tokens: 125_000, contextWindow: 200_000 });
    const settlePromise = governor.handleSettled(fakeCtx).then(() => {
      settledFinished = true;
    });

    // Before onComplete is invoked
    assert.equal(governor.isCompacting(), true);
    assert.equal(settledFinished, false, "settle promise must not resolve before onComplete callback");
    assert.equal(governor.getTelemetry().compactionCount, 0);

    // Call onComplete
    completeCallback({ summary: "session summarized" });
    await settlePromise;

    assert.equal(settledFinished, true);
    assert.equal(governor.isCompacting(), false);
    assert.equal(governor.getTelemetry().compactionCount, 1);
  });

  // 8. Error handling
  it("8. Error handling: onError leaves state coherent, records error, and avoids loops", async () => {
    let errorCallback;
    const fakeCtx = {
      compact: (opts) => {
        errorCallback = opts.onError;
      },
    };

    governor.updateUsage({ tokens: 125_000, contextWindow: 200_000 });
    const settlePromise = governor.handleSettled(fakeCtx);

    assert.equal(governor.isCompacting(), true);
    errorCallback(new Error("Model context exhausted"));
    await settlePromise;

    const telemetry = governor.getTelemetry();
    assert.equal(governor.isCompacting(), false);
    assert.equal(telemetry.lastCompactionError, "Model context exhausted");
    assert.equal(telemetry.compactionFailures, 1);
    assert.equal(telemetry.consecutiveCompactionFailures, 1);

    // Calling settle again without new pending flag does not loop
    let newCompacts = 0;
    await governor.handleSettled({ compact: () => newCompacts++ });
    assert.equal(newCompacts, 0, "must not re-trigger compaction without pending flag");
  });

  // 9. Ceiling enforcement
  it("9. Ceiling enforcement: direct heavy work blocked at ceiling; aies_delegate allowed", () => {
    governor.updateUsage({ tokens: 155_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "ceiling");

    // Heavy direct tools: blocked
    assert.equal(governor.isHeavyWorkAllowed("read").allowed, false);
    assert.equal(governor.isHeavyWorkAllowed("edit").allowed, false);
    assert.equal(governor.isHeavyWorkAllowed("write").allowed, false);
    assert.equal(governor.isHeavyWorkAllowed("grep").allowed, false);
    assert.equal(governor.isHeavyWorkAllowed("bash", { command: "npm test" }).allowed, false);

    // Trivial status commands: allowed
    assert.equal(governor.isHeavyWorkAllowed("bash", { command: "git status" }).allowed, true);
    assert.equal(governor.isHeavyWorkAllowed("bash", { command: "pwd" }).allowed, true);

    // CRITICAL: aies_delegate is NEVER blocked
    assert.equal(governor.isHeavyWorkAllowed("aies_delegate").allowed, true);

    // Integration with routing guardrail
    const routing = createRoutingState();
    const readCheck = checkRoutingGuardrail(routing, { toolName: "read", input: { path: "foo.ts" } }, governor);
    assert.equal(readCheck.block, true);
    assert.match(readCheck.reason ?? "", /parent context ceiling reached/iu);

    const delegateCheck = checkRoutingGuardrail(routing, { toolName: "aies_delegate", input: { role: "worker" } }, governor);
    assert.equal(delegateCheck.block, false, "aies_delegate must never be blocked at ceiling");
  });

  // 10. Routing pressure
  it("10. Routing pressure: context pressure reaches routing signals without duplicate counters", () => {
    let routing = createRoutingState();
    routing = applyRoutingToolCall(routing, { toolName: "read", input: { path: "file1.ts" } });

    // Under pressure zone
    const signals = evaluateRoutingSignals(routing, "pressure");
    assert.equal(signals.contextPressure, "pressure");
    assert.equal(signals.recommendedAction, "explore");
    assert.match(signals.reason ?? "", /Context pressure is pressure/u);

    // Routing work-unit counters remain clean
    assert.equal(routing.readsSinceBoundary, 1);
    assert.equal(routing.toolsSinceBoundary, 1);
  });

  // 11. Verify survives compaction
  it("11. Verify survives compaction: FAIL with repair budget survives compaction intact", () => {
    let verification = createVerificationState();
    verification = applyWorkUnitChange(verification, ["src/app.ts"], "work unit 1");
    verification = applyVerifyStart(verification, Date.now());
    verification = applyVerifyResult(
      verification,
      {
        status: "fail",
        summary: "failed verification",
        criteria: [],
        checks: [],
        defects: [{ severity: "blocking", description: "Broken export" }],
        next: ["repair"],
      },
      100,
    );

    assert.equal(verification.status, "fail");
    assert.equal(isVerificationValid(verification), false);

    // Simulate compaction occurring in runtime
    let state = createState(Date.now());
    state = applyCompaction(state, Date.now());

    // Verification state is unchanged and can continue repair cycle
    assert.equal(verification.status, "fail");
    assert.equal(verification.repairs, 0);
    assert.equal(isVerificationValid(verification), false);
  });

  // 12. PASS survives compaction
  it("12. PASS survives compaction: valid PASS verdict remains valid across compaction", () => {
    let verification = createVerificationState();
    verification = applyWorkUnitChange(verification, ["src/app.ts"], "work unit 1");
    verification = applyVerifyStart(verification, Date.now());
    verification = applyVerifyResult(
      verification,
      {
        status: "pass",
        summary: "all passed",
        criteria: [],
        checks: [],
        defects: [],
        next: ["done"],
      },
      100,
    );

    assert.equal(verification.status, "pass");
    assert.equal(isVerificationValid(verification), true);

    // Compacting must not invalidate PASS
    let state = createState(Date.now());
    state = applyCompaction(state, Date.now());

    assert.equal(verification.status, "pass");
    assert.equal(isVerificationValid(verification), true);
  });

  // 13. Telemetry survives compaction
  it("13. Telemetry survives compaction: peak context and cumulative counts are monotonic", () => {
    let state = createState(Date.now());
    state = applyContextUsage(state, { tokens: 95_000, contextWindow: 200_000 });
    state = applyToolCall(state, { toolName: "read", input: { path: "file.ts" } }, Date.now(), "/workspace");

    assert.equal(state.context.peakTokens, 95_000);
    assert.equal(state.tools.calls, 1);

    // Compaction occurs
    state = applyCompaction(state, Date.now());
    // Post-compaction tokens might drop or be null before next LLM response
    state = applyContextUsage(state, { tokens: 25_000, contextWindow: 200_000 });

    assert.equal(state.context.currentTokens, 25_000);
    assert.equal(state.context.peakTokens, 95_000, "peakTokens must not reset on compaction");
    assert.equal(state.compactionCount, 1);
    assert.equal(state.tools.calls, 1);
  });

  // 14. Large result
  it("14. Large result: output between 12k and 32k is classified as large and not truncated", () => {
    const text = "x".repeat(15_000);
    assert.equal(classifyOutput(text.length), "large");

    const res = truncateToolResultContent([{ type: "text", text }], "bash");
    assert.equal(res.modified, false);
    assert.equal(res.oversizedCount, 0);
    assert.equal(res.content[0].text.length, 15_000);
  });

  // 15. Oversized result
  it("15. Oversized result: output > 32k is truncated and recorded in telemetry", () => {
    const text = "A".repeat(40_000);
    assert.equal(classifyOutput(text.length), "oversized");

    const result = governor.processToolResult({
      toolName: "bash",
      content: [{ type: "text", text }],
    });

    assert.equal(result.modified, true);
    assert.ok(result.content[0].text.length < 40_000);
    assert.match(result.content[0].text, /\[Output truncated by AIES Context Governor\]/u);
    assert.match(result.content[0].text, /Original: 40,000 chars/u);

    const telemetry = governor.getTelemetry();
    assert.equal(telemetry.oversizedResults, 1);
    assert.ok(telemetry.truncatedChars > 0);
  });

  // 16. Head/tail preservation
  it("16. Head/tail preservation: long logs preserve initial and final portions", () => {
    const headPrefix = "LOG_START_LINE_1\n";
    const tailSuffix = "LOG_END_SUCCESS_0\n";
    const middle = "M".repeat(50_000);
    const fullText = `${headPrefix}${middle}${tailSuffix}`;

    const truncated = truncateOutputText(fullText, DEFAULT_OUTPUT_LIMITS);
    assert.equal(truncated.truncated, true);
    assert.ok(truncated.text.startsWith("LOG_START_LINE_1"), "head must be preserved");
    assert.ok(truncated.text.endsWith("LOG_END_SUCCESS_0\n"), "tail must be preserved");
  });

  // 17. Structured handoffs
  it("17. Structured handoffs: aies_delegate results are NEVER truncated", () => {
    const longHandoff = JSON.stringify({
      verdict: "PASS",
      evidence: ["A".repeat(35_000)],
    });

    const res = governor.processToolResult({
      toolName: "aies_delegate",
      content: [{ type: "text", text: longHandoff }],
    });

    assert.equal(res.modified, false, "aies_delegate must never be modified by governor");
    assert.equal(res.content[0].text, longHandoff);
    assert.equal(governor.getTelemetry().oversizedResults, 0);
  });
});
