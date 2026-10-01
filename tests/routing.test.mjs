/**
 * Test suite for AIES-004: Parent Routing Policy & Guardrails.
 *
 * Verifies deterministic routing behavior:
 * - Caso 1: Trivial work (1 read, 1 edit) does not force delegation.
 * - Caso 2: Soft reads (3 reads) applies pressure without breaking execution.
 * - Caso 3: Hard reads (>= 5 reads) blocks further exploratory reads with structured feedback to delegate Explore.
 * - Caso 4: Tool budget (>= 12 tool calls) blocks arbitrary continuation without re-evaluation/delegation.
 * - Caso 5: Reset boundary: delegation resets work-unit counters while global telemetry accumulates.
 * - Caso 6: Worker trigger: multi-file non-trivial changes can be delegated to Worker directly.
 * - Caso 7: Explore trigger: unknown scope directs to Explore.
 * - Caso 8: No automatic explosion: routing evaluates signals; model decides; one decision -> one delegation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRoutingDelegationEnd,
  applyRoutingDelegationStart,
  applyRoutingToolCall,
  checkRoutingGuardrail,
  createRoutingState,
  evaluateRoutingSignals,
  ROUTING_THRESHOLDS,
} from "../extensions/aies-agents/routing.ts";
import {
  applyDelegationEnd,
  applyDelegationStart,
  applyToolCall,
  createState,
} from "../extensions/aies-runtime/state.ts";

const ROOT = "/workspace";

describe("AIES-004 Parent Routing Policy & Guardrails", () => {
  it("Caso 1 — trivial: 1 read and 1 edit does not force delegation", () => {
    let routing = createRoutingState();

    // 1 read
    assert.equal(checkRoutingGuardrail(routing, { toolName: "read", input: { path: "a.ts" } }).block, false);
    routing = applyRoutingToolCall(routing, { toolName: "read", input: { path: "a.ts" } }, ROOT);

    // 1 edit
    assert.equal(checkRoutingGuardrail(routing, { toolName: "edit", input: { path: "a.ts" } }).block, false);
    routing = applyRoutingToolCall(routing, { toolName: "edit", input: { path: "a.ts" } }, ROOT);

    const signals = evaluateRoutingSignals(routing);
    assert.equal(signals.explorationPressure, "none");
    assert.equal(signals.toolPressure, "none");
    assert.equal(signals.recommendedAction, "inline");
    assert.equal(routing.readsSinceBoundary, 1);
    assert.equal(routing.toolsSinceBoundary, 2);
  });

  it("Caso 2 — soft reads: 3 exploratory reads triggers soft pressure without blocking execution", () => {
    let routing = createRoutingState();

    for (let i = 1; i <= 3; i++) {
      const call = { toolName: "read", input: { path: `file${i}.ts` } };
      const guard = checkRoutingGuardrail(routing, call);
      assert.equal(guard.block, false, `Read ${i} must not be blocked at soft threshold`);
      routing = applyRoutingToolCall(routing, call, ROOT);
    }

    assert.equal(routing.readsSinceBoundary, 3);
    const signals = evaluateRoutingSignals(routing);
    assert.equal(signals.explorationPressure, "soft");
    assert.equal(signals.recommendedAction, "explore");
    assert.match(signals.reason ?? "", /Soft exploration threshold reached/u);

    // Can still perform another call (soft pressure informs but does not hard stop yet)
    assert.equal(
      checkRoutingGuardrail(routing, { toolName: "read", input: { path: "file4.ts" } }).block,
      false,
    );
  });

  it("Caso 3 — hard reads: reaching hard threshold blocks subsequent direct exploratory reads", () => {
    let routing = createRoutingState();

    // Execute 5 exploratory reads up to hard threshold
    for (let i = 1; i <= ROUTING_THRESHOLDS.EXPLORATION_READS_HARD; i++) {
      const call = { toolName: "read", input: { path: `src/mod${i}.ts` } };
      assert.equal(checkRoutingGuardrail(routing, call).block, false);
      routing = applyRoutingToolCall(routing, call, ROOT);
    }

    assert.equal(routing.readsSinceBoundary, 5);
    const signals = evaluateRoutingSignals(routing);
    assert.equal(signals.explorationPressure, "hard");
    assert.equal(signals.recommendedAction, "explore");

    // Attempting a 6th exploratory read is blocked by hard guardrail
    const sixthRead = { toolName: "read", input: { path: "src/mod6.ts" } };
    const guard = checkRoutingGuardrail(routing, sixthRead);
    assert.equal(guard.block, true);
    assert.match(guard.reason ?? "", /parent exploration budget exceeded; delegate Explore/u);

    // view_file is also blocked
    const viewCall = { toolName: "view_file", input: { filePath: "src/mod7.ts" } };
    assert.equal(checkRoutingGuardrail(routing, viewCall).block, true);

    // But delegation tool is NEVER blocked
    assert.equal(
      checkRoutingGuardrail(routing, {
        toolName: "aies_delegate",
        input: { role: "explore", task: "Investigate remaining modules" },
      }).block,
      false,
    );
  });

  it("Caso 4 — tool budget: reaching 12 tools blocks arbitrary continuation without re-evaluation", () => {
    let routing = createRoutingState();

    // Perform 12 tool calls
    for (let i = 1; i <= ROUTING_THRESHOLDS.TOOL_CALLS_HARD; i++) {
      const call = { toolName: "grep", input: { pattern: `query${i}` } };
      assert.equal(checkRoutingGuardrail(routing, call).block, false);
      routing = applyRoutingToolCall(routing, call, ROOT);
    }

    assert.equal(routing.toolsSinceBoundary, 12);
    const signals = evaluateRoutingSignals(routing);
    assert.equal(signals.toolPressure, "hard");

    // 13th arbitrary direct call is blocked
    const nextCall = { toolName: "edit", input: { path: "a.ts" } };
    const guard = checkRoutingGuardrail(routing, nextCall);
    assert.equal(guard.block, true);
    assert.match(
      guard.reason ?? "",
      /parent tool budget exceeded; re-evaluation required: delegate Explore or Worker, or finalize task/u,
    );

    // But aies_delegate remains open
    assert.equal(
      checkRoutingGuardrail(routing, {
        toolName: "aies_delegate",
        input: { role: "worker", task: "Implement feature" },
      }).block,
      false,
    );
  });

  it("Caso 5 — reset boundary: delegation resets work-unit counters while global telemetry is preserved", () => {
    let routing = createRoutingState();
    let globalState = createState(1_000_000);

    // Parent inspects 4 files and runs 8 tools
    for (let i = 1; i <= 4; i++) {
      const call = { toolName: "read", input: { path: `file${i}.ts` } };
      routing = applyRoutingToolCall(routing, call, ROOT);
      globalState = applyToolCall(globalState, call, 1_000_000 + i * 100, ROOT);
    }
    for (let i = 1; i <= 4; i++) {
      const call = { toolName: "grep", input: { pattern: `test${i}` } };
      routing = applyRoutingToolCall(routing, call, ROOT);
      globalState = applyToolCall(globalState, call, 1_000_000 + (i + 4) * 100, ROOT);
    }

    assert.equal(routing.toolsSinceBoundary, 8);
    assert.equal(routing.readsSinceBoundary, 4);
    assert.equal(routing.filesSinceBoundary.length, 4);
    assert.equal(globalState.tools.calls, 8);
    assert.equal(globalState.exploration.sourceReads, 4);

    // Parent launches Explore delegation
    routing = applyRoutingDelegationStart(routing, "explore", 1_001_000);
    globalState = applyDelegationStart(globalState, "explore", 1_001_000);
    assert.equal(routing.currentMode, "delegated");

    // Explore completes
    routing = applyRoutingDelegationEnd(routing, "explore", "done", 1_002_000);
    globalState = applyDelegationEnd(globalState, "done", 1_002_000);

    // Routing boundary counters MUST reset
    assert.equal(routing.currentMode, "inline");
    assert.equal(routing.toolsSinceBoundary, 0, "toolsSinceBoundary must reset to 0 after delegation");
    assert.equal(routing.readsSinceBoundary, 0, "readsSinceBoundary must reset to 0 after delegation");
    assert.equal(routing.filesSinceBoundary.length, 0, "filesSinceBoundary must reset to 0 after delegation");
    assert.equal(routing.lastDelegation?.role, "explore");
    assert.equal(routing.lastDelegation?.outcome, "done");

    // Global telemetry MUST NOT be lost
    assert.equal(globalState.tools.calls, 8, "Global tool calls must be preserved");
    assert.equal(globalState.exploration.sourceReads, 4, "Global source reads must be preserved");
    assert.equal(globalState.delegations.total, 1, "Global delegations must record 1 delegation");
    assert.equal(globalState.delegations.byRole.explore, 1);
  });

  it("Caso 6 — Worker trigger: non-trivial multi-file changes route to Worker without direct editing", () => {
    let routing = createRoutingState();

    // After investigation, parent recognizes a multi-file change (>= 2 files)
    const filesToModify = ["src/auth.ts", "src/session.ts"];
    assert.ok(
      filesToModify.length >= ROUTING_THRESHOLDS.MULTI_FILE_CHANGES_WORKER_THRESHOLD,
      "Multi-file changes must meet worker threshold",
    );

    // Parent delegates directly to Worker
    assert.equal(
      checkRoutingGuardrail(routing, {
        toolName: "aies_delegate",
        input: {
          role: "worker",
          task: "Update authentication session handling in auth.ts and session.ts",
        },
      }).block,
      false,
    );

    routing = applyRoutingDelegationStart(routing, "worker", Date.now());
    routing = applyRoutingDelegationEnd(routing, "worker", "done", Date.now());

    assert.equal(routing.toolsSinceBoundary, 0);
    assert.equal(routing.lastDelegation?.role, "worker");
  });

  it("Caso 7 — Explore trigger: unknown scope directs to Explore", () => {
    let routing = createRoutingState();

    // Parent attempts to inspect 4 files to locate a problem
    for (let i = 1; i <= 4; i++) {
      routing = applyRoutingToolCall(routing, { toolName: "read", input: { path: `src/pkg/${i}.ts` } }, ROOT);
    }

    const signals = evaluateRoutingSignals(routing);
    assert.equal(signals.recommendedAction, "explore");
    assert.match(signals.reason ?? "", /files inspected/u);

    // Parent delegates to Explore
    routing = applyRoutingDelegationStart(routing, "explore", Date.now());
    assert.equal(routing.currentMode, "delegated");
  });

  it("Caso 8 — No automatic explosion: routing evaluates policy, one decision -> one delegation", () => {
    let routing = createRoutingState();

    // Even under soft or hard pressure, guardrail does NOT automatically spawn children
    for (let i = 1; i <= 5; i++) {
      routing = applyRoutingToolCall(routing, { toolName: "read", input: { path: `file${i}.ts` } }, ROOT);
    }

    // Signals indicate pressure
    const signals = evaluateRoutingSignals(routing);
    assert.equal(signals.explorationPressure, "hard");
    assert.equal(routing.currentMode, "inline");

    // Guardrail prevents wrong direct reads, but does NOT create a delegation automatically
    const guard = checkRoutingGuardrail(routing, { toolName: "read", input: { path: "extra.ts" } });
    assert.equal(guard.block, true);
    assert.equal(routing.lastDelegation, undefined, "No delegation should be created automatically by guardrail");

    // Parent explicitly makes exactly one delegation call
    routing = applyRoutingDelegationStart(routing, "explore", 1_000);
    assert.equal(routing.currentMode, "delegated");
    routing = applyRoutingDelegationEnd(routing, "explore", "done", 2_000);
    assert.equal(routing.currentMode, "inline");
    assert.equal(routing.lastDelegation?.role, "explore");
  });
});
