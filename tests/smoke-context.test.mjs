/**
 * Smoke tests for AIES-007: Context Governor.
 *
 * Smoke 1 — Tool output: Real fixture producing oversized output (> 32k chars)
 * demonstrates bounded result, original size in telemetry, and truncation banner.
 *
 * Smoke 2 — Compaction lifecycle: Simulates token progression across 119k (no compact),
 * 121k (pending), mid-turn active (no compaction), agent_settled (compact starts),
 * compacting in-flight, and onComplete callback resolution.
 *
 * Smoke 3 — Session and launcher status: Confirms aies launcher reports profile correctly,
 * aies.json context config is loaded, and status report renders the new governor block.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ContextGovernor,
  DEFAULT_OUTPUT_LIMITS,
} from "../extensions/aies-agents/context-governor.ts";
import { createState, toSnapshot, applyContextGovernorSync, applyContextUsage } from "../extensions/aies-runtime/state.ts";
import { renderStatusReport, renderFooter } from "../extensions/aies-runtime/status.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("AIES-007 Context Governor — Smoke Tests", () => {
  // Smoke 1 — Tool output hygiene
  it("Smoke 1: oversized tool output is cleanly bounded and reported in telemetry", () => {
    const governor = new ContextGovernor();
    const originalSize = 65_000;
    const oversizedLog = [
      "HEADER: INITIATING REPOSITORY AUDIT",
      ...Array.from({ length: 1000 }, (_, i) => `TRACE line ${i}: evaluating dependency graph node ${i}`),
      "FOOTER: REPOSITORY AUDIT COMPLETE WITH 0 ERRORS",
    ].join("\n");

    assert.ok(oversizedLog.length > DEFAULT_OUTPUT_LIMITS.oversizedOutputChars);

    const filterResult = governor.processToolResult({
      toolName: "bash",
      content: [{ type: "text", text: oversizedLog }],
    });

    assert.equal(filterResult.modified, true);
    const boundedText = filterResult.content[0].text;

    // Bounded text must be substantially smaller than original
    assert.ok(boundedText.length < oversizedLog.length);
    assert.ok(boundedText.length <= 20_000, `bounded output length was ${boundedText.length}`);

    // Preserves head and tail context
    assert.match(boundedText, /^HEADER: INITIATING REPOSITORY AUDIT/u);
    assert.match(boundedText, /FOOTER: REPOSITORY AUDIT COMPLETE WITH 0 ERRORS$/u);

    // Shows clear truncation notice with original and shown sizes
    assert.match(boundedText, /\[Output truncated by AIES Context Governor\]/u);
    assert.match(boundedText, /Original: [0-9,]+ chars/u);
    assert.match(boundedText, /Shown: [0-9,]+ chars/u);

    // Telemetry accurately registers oversized output count
    const telemetry = governor.getTelemetry();
    assert.equal(telemetry.oversizedResults, 1);
    assert.ok(telemetry.truncatedChars > 40_000);
  });

  // Smoke 2 — Compaction lifecycle
  it("Smoke 2: compaction lifecycle ordering from 119k to pending to settled to complete", async () => {
    const governor = new ContextGovernor({
      targetTokens: 80_000,
      pressureTokens: 100_000,
      compactTokens: 120_000,
      ceilingTokens: 150_000,
    });

    // 1. 119k: Below threshold -> no compact, not pending
    governor.updateUsage({ tokens: 119_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "pressure");
    assert.equal(governor.isCompactPending(), false);
    assert.equal(governor.isCompacting(), false);

    // 2. 121k: At threshold -> marked pending, but agent still active -> no compact started
    governor.updateUsage({ tokens: 121_000, contextWindow: 200_000 });
    assert.equal(governor.getZone(), "compact");
    assert.equal(governor.isCompactPending(), true);
    assert.equal(governor.isCompacting(), false);

    // 3. agent_settled: Safe boundary reached -> compaction begins
    let onCompleteCallback;
    const fakeCtx = {
      compact: (opts) => {
        onCompleteCallback = opts.onComplete;
      },
    };

    const settlePromise = governor.handleSettled(fakeCtx);

    // Before callback: compacting is true, pending is cleared
    assert.equal(governor.isCompacting(), true);
    assert.equal(governor.isCompactPending(), false);
    assert.equal(governor.getTelemetry().compactionCount, 0);

    // 4. Async onComplete fires
    onCompleteCallback({ summary: "Summary of ticket work" });
    await settlePromise;

    // After callback: compacting is false, compactionCount incremented
    assert.equal(governor.isCompacting(), false);
    assert.equal(governor.getTelemetry().compactionCount, 1);
    assert.ok(typeof governor.getTelemetry().lastCompactionAt === "number");
  });

  // Smoke 3 — Status report rendering & launcher integration
  it("Smoke 3: status report and footer reflect governor state without breaking launcher", () => {
    // Check launcher --aies-info
    const infoOutput = execFileSync(join(REPO_ROOT, "bin/aies"), ["--aies-info"], {
      encoding: "utf8",
      env: {
        ...process.env,
        AIES_HOME: mkdtempSync(join(tmpdir(), "aies-smoke-home-")),
      },
    });
    assert.match(infoOutput, /AIES_REPO=/u);
    assert.match(infoOutput, /PI_CODING_AGENT_DIR=/u);

    // Check status report formatting
    let state = createState(Date.now());
    state = applyContextUsage(state, { tokens: 104_000, contextWindow: 200_000 });
    state = applyContextGovernorSync(state, {
      zone: "pressure",
      currentTokens: 104_000,
      compactAtTokens: 120_000,
      ceilingTokens: 150_000,
      compactPending: false,
      compacting: false,
      compactionCount: 1,
      oversizedResults: 2,
    });

    const report = renderStatusReport(toSnapshot(state), Date.now());
    assert.match(report, /^Gobernador de contexto:$/mu);
    assert.match(report, /zona\s+pressure/u);
    assert.match(report, /actual\s+104k/u);
    assert.match(report, /compactar en\s+120k/u);
    assert.match(report, /techo\s+150k/u);
    assert.match(report, /pendiente\s+no/u);
    assert.match(report, /compactando\s+no/u);
    assert.match(report, /compactaciones\s+1/u);
    assert.match(report, /sobredimensionados\s+2/u);

    // Check footer formatting under pressure
    const footer = renderFooter(toSnapshot(state), Date.now());
    assert.match(footer, /ctx 104k !/u);

    // Check footer formatting during compaction
    state = applyContextGovernorSync(state, { compacting: true });
    const compactingFooter = renderFooter(toSnapshot(state), Date.now());
    assert.match(compactingFooter, /compactando/u);
  });
});
