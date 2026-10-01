/**
 * AIES-010 presentation module checks.
 *
 * Every renderer is driven with real runtime state: the tests build snapshots
 * through the actual appliers (`createState` + `apply*` + `toSnapshot`) so the
 * field names the UI reads are exercised for real, never a hand-made object that
 * could drift from `state.ts`.
 *
 * No Pi runtime, no terminal, no timers: the renderers are pure and the `paint`
 * stays `PLAIN_PAINT`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyActivityFacts,
  applyAgents,
  applyAutonomySync,
  applyContextGovernorSync,
  applyContextUsage,
  applyDelegationEnd,
  applyDelegationStart,
  applyModel,
  applyParentMutation,
  applyRunStart,
  applyRunUsage,
  applyTicketObservationSync,
  applyVerificationReport,
  applyVerificationStart,
  createState,
  fromSnapshot,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderFooter, renderHeader } from "../extensions/aies-ui/footer.ts";
import { clip, formatCost, formatDuration, formatTokens, singleLine } from "../extensions/aies-ui/format.ts";
import { deriveStage, isCompacting, isContextPressure, statusGlyph, verificationIndicator } from "../extensions/aies-ui/vocabulary.ts";
import { isActivityVisible, renderActivityCard, renderActivityEntry } from "../extensions/aies-ui/activity.ts";
import { approvalOptions, renderApprovalPrompt } from "../extensions/aies-ui/approval.ts";
import { PLAIN_PAINT, themePaint } from "../extensions/aies-ui/paint.ts";
import { renderBlockedSummary, renderDoneSummary, renderStatusOverview } from "../extensions/aies-ui/summary.ts";

const T0 = 1_700_000_000_000;

/** One value out of a `  label  value` report row, by its label. */
function field(text, label) {
  const pattern = new RegExp(`^ {2}${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} +(.*)$`, "mu");
  const match = text.match(pattern);
  assert.ok(match, `no "${label}" row:\n${text}`);
  return match[1].trim();
}

function snap(state) {
  return toSnapshot(state);
}

/** Snapshot plus the observatory records, which the flat snapshot does not project. */
function snapWithAgents(state) {
  return { ...toSnapshot(state), agents: state.agents };
}

function withContext(state, tokens) {
  return applyContextUsage(state, { tokens, contextWindow: 200_000 });
}

function withTicket(state, identifier = "EZE-417") {
  return applyTicketObservationSync(state, { active: true, identifier, status: "In Progress" });
}

function render(snapshot, now = T0, options) {
  return renderFooter(snapshot, now, options);
}

describe("paint", () => {
  it("stays plain without a theme", () => {
    assert.equal(PLAIN_PAINT.fg("accent", "x"), "x");
    assert.equal(themePaint(undefined).fg("error", "boom"), "boom");
  });

  it("adapts a usable theme and survives an unusable one", () => {
    const theme = { fg: (color, text) => `<${color}>${text}` };
    assert.equal(themePaint(theme).fg("success", "ok"), "<success>ok");
    assert.equal(themePaint({ fg: () => undefined }).fg("success", "ok"), "ok");
    assert.equal(
      themePaint({
        fg: () => {
          throw new Error("theme exploded");
        },
      }).fg("success", "ok"),
      "ok",
    );
  });
});

describe("format", () => {
  it("formats tokens and durations compactly", () => {
    assert.equal(formatTokens(820), "820");
    assert.equal(formatTokens(8747), "8.7k");
    assert.equal(formatTokens(34_000), "34k");
    assert.equal(formatTokens(1_500_000), "1.5M");
    assert.equal(formatTokens(null), "?");
    assert.equal(formatDuration(14_000), "00:14");
    assert.equal(formatDuration(151_000), "02:31");
    assert.equal(formatDuration(3_862_000), "1:04:22");
  });

  it("formats a cost, or an em dash when it is unknown", () => {
    assert.equal(formatCost(0.08), "$0.08");
    assert.equal(formatCost(0.1), "$0.10");
    assert.equal(formatCost(null), "—");
    assert.equal(formatCost(undefined), "—");
    assert.equal(formatCost(Number.NaN), "—");
  });

  it("collapses to one line and clips without exceeding the width", () => {
    assert.equal(singleLine("a\n  b\tc "), "a b c");
    assert.equal(clip("hello world", 5), "hell…");
    assert.equal(clip("hi", 5), "hi");
    assert.equal(clip("hello", 0), "");
    assert.equal(clip("hello", 1), "…");
    for (let width = 0; width <= 12; width += 1) {
      assert.ok(clip("hello world", width).length <= width, `clip exceeded ${width}`);
    }
  });
});

describe("vocabulary", () => {
  it("derives IDLE, EXPLORE, WORK, VERIFY and REPAIR from the active child", () => {
    assert.equal(deriveStage(snap(createState(T0))), "IDLE");

    const explored = applyDelegationStart(createState(T0), "explore", T0);
    assert.equal(deriveStage(snap(explored)), "EXPLORE");

    const working = applyDelegationStart(createState(T0), "worker", T0);
    assert.equal(deriveStage(snap(working)), "WORK");

    const verifying = applyDelegationStart(createState(T0), "verify", T0);
    assert.equal(deriveStage(snap(verifying)), "VERIFY");

    const failing = applyVerificationReport(createState(T0), { status: "fail", valid: false, attempts: 1 });
    const repairing = applyDelegationStart(failing, "worker", T0);
    assert.equal(deriveStage(snap(repairing)), "REPAIR");
  });

  it("derives WAIT, BLOCKED and DONE from autonomy and verification", () => {
    assert.equal(deriveStage(snap(applyAutonomySync(createState(T0), { enabled: true, stopReason: "user_required" }))), "WAIT");
    assert.equal(deriveStage(snap(applyAutonomySync(createState(T0), { enabled: true, stopReason: "blocked" }))), "BLOCKED");
    assert.equal(deriveStage(snap(applyAutonomySync(createState(T0), { enabled: true, stopReason: "completed" }))), "DONE");

    const blockedVerify = applyVerificationReport(createState(T0), { status: "blocked", valid: false, attempts: 1 });
    assert.equal(deriveStage(snap(blockedVerify)), "BLOCKED");

    const passed = applyVerificationReport(createState(T0), { status: "pass", valid: true, attempts: 1 });
    assert.equal(deriveStage(snap(passed)), "FINALIZING");
    assert.equal(deriveStage({ ...snap(passed), doneEmitted: true }), "DONE");
    assert.equal(deriveStage({ ...snap(passed), runEndedAt: T0 + 5000 }), "DONE");
  });

  it("reads pressure, compaction and the verification indicator", () => {
    const idle = snap(createState(T0));
    assert.equal(isContextPressure(idle), false);
    assert.equal(isCompacting(idle), false);

    const pressure = snap(applyContextGovernorSync(createState(T0), { zone: "pressure" }));
    assert.equal(isContextPressure(pressure), true);
    assert.equal(isCompacting(snap(applyContextGovernorSync(createState(T0), { compacting: true }))), true);

    assert.equal(verificationIndicator(snap(createState(T0))), undefined);
    assert.equal(verificationIndicator(snap(applyVerificationReport(createState(T0), { status: "pass", valid: true, attempts: 1 }))), "V:PASS");
    const staleState = applyVerificationReport(applyVerificationStart(createState(T0)), { status: "pass", valid: false });
    assert.equal(verificationIndicator(snap(staleState)), "V:STALE");
    assert.equal(verificationIndicator(snap(applyVerificationReport(createState(T0), { status: "fail", valid: false, attempts: 1 }))), "V:FAIL");
    assert.equal(verificationIndicator(snap(applyVerificationReport(createState(T0), { status: "blocked", valid: false, attempts: 1 }))), undefined);
  });

  it("distinguishes a protocol error from PASS, FAIL and BLOCKED", () => {
    const protocol = applyVerificationReport(createState(T0), { status: "protocol_error", valid: false, attempts: 1, awaitingVerification: true });
    assert.equal(verificationIndicator(snap(protocol)), "V:ERROR");
    assert.equal(deriveStage(snap(protocol)), "BLOCKED");
  });

  it("shares one semantic glyph vocabulary for every status", () => {
    assert.equal(statusGlyph("running"), "◆");
    assert.equal(statusGlyph("completed"), "✓");
    assert.equal(statusGlyph("failed"), "✗");
    assert.equal(statusGlyph("blocked"), "!");
    assert.equal(statusGlyph("queued"), "◇");
  });
});

describe("footer", () => {
  it("shows idle, ticket + WORK and ticket + VERIFY", () => {
    assert.equal(render(snap(withContext(createState(T0), 31_000))), "✧ AIES · listo · ctx 31k");

    const working = applyDelegationStart(withContext(withTicket(createState(T0)), 42_000), "worker", T0);
    assert.equal(render(snap(working)), "✧ AIES · EZE-417 · WORK · ctx 42k");

    const verifying = applyDelegationStart(withContext(withTicket(createState(T0)), 45_000), "verify", T0);
    assert.equal(render(snap(verifying)), "✧ AIES · EZE-417 · VERIFY · ctx 45k");
  });

  it("shows a placeholder only at IDLE and omits it while work is in flight", () => {
    assert.equal(render(snap(withContext(createState(T0), 31_000))), "✧ AIES · listo · ctx 31k");

    const idleTicket = withContext(withTicket(createState(T0)), 46_000);
    assert.equal(render(snap(idleTicket)), "✧ AIES · EZE-417 · ctx 46k");

    const exploringNoTicket = applyDelegationStart(withContext(createState(T0), 42_000), "explore", T0);
    assert.equal(render(snap(exploringNoTicket)), "✧ AIES · EXPLORE · ctx 42k");

    const auto = applyAutonomySync(withContext(withTicket(createState(T0)), 42_000), { enabled: true, ticketId: "EZE-417" });
    const exploringTicket = applyDelegationStart(auto, "explore", T0);
    assert.equal(render(snap(exploringTicket)), "✧ AIES · EZE-417 · EXPLORE · ctx 42k · AUTO");

    const doneTicket = applyAutonomySync(withContext(withTicket(createState(T0)), 46_000), { enabled: false, stopReason: "completed" });
    assert.equal(render(snap(doneTicket)), "✧ AIES · EZE-417 · DONE · ctx 46k");
    assert.equal(render(snap(doneTicket)).includes("V:PASS"), false);
  });

  it("shows AUTO only when autonomy is enabled", () => {
    const base = withContext(withTicket(createState(T0)), 40_000);
    const on = applyAutonomySync(base, { enabled: true, ticketId: "EZE-417" });
    const off = applyAutonomySync(base, { enabled: false });

    assert.equal(render(snap(on)), "✧ AIES · EZE-417 · ctx 40k · AUTO");
    assert.equal(render(snap(off)).includes("AUTO"), false);
    assert.equal(render(snap(createState(T0))).includes("AUTO"), false);
  });

  it("appends model/provider and elapsed only when the width permits", () => {
    const ticket = withContext(withTicket(createState(T0)), 42_000);
    const modeled = applyModel(ticket, { id: "model-z", provider: "anthropic" });

    const wide = render(snap(modeled), T0, { width: 120, cwd: "/home/dev/aies-smoke" });
    assert.match(wide, /model-z\/anthropic/u);
    assert.match(wide, /00:00/u);
    assert.equal(wide.includes("aies-smoke"), false, "cwd is not product status");
    assert.equal(render(snap(modeled), T0, { width: 30 }).includes("model-z"), false);
  });

  it("marks context pressure and compaction without a peak or a ceiling", () => {
    let state = withContext(createState(T0), 104_000);
    state = applyContextGovernorSync(state, { zone: "pressure", currentTokens: 104_000 });
    const pressure = render(snap(state));
    assert.match(pressure, /ctx 104k !/u);
    assert.equal(pressure.includes("peak"), false);
    assert.equal(pressure.includes("/"), false);

    const compacting = applyContextGovernorSync(state, { compacting: true });
    assert.match(render(snap(compacting)), /compactando…/u);
  });

  it("shows V:PASS for a valid pass and V:STALE once it is invalidated", () => {
    const withPass = (() => {
      let state = withContext(createState(T0), 40_000);
      state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });
      return applyDelegationStart(state, "worker", T0);
    })();
    assert.match(render(snap(withPass)), /V:PASS/u);

    let invalidated = withContext(createState(T0), 40_000);
    invalidated = applyVerificationStart(invalidated);
    invalidated = applyVerificationReport(invalidated, { status: "pass", valid: true, repairs: 0, maxRepairs: 2 });
    invalidated = applyParentMutation(invalidated);
    const stale = render(snap(invalidated));
    assert.match(stale, /V:STALE/u);
    assert.equal(stale.includes("V:PASS"), false);
  });

  it("never prints counters, elapsed time or cmp and stays one line", () => {
    const rich = (() => {
      let state = withContext(withTicket(createState(T0)), 42_000);
      state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });
      return applyDelegationStart(state, "worker", T0);
    })();
    const footer = render(snap(rich), T0 + 134_000);

    assert.equal(footer.split("\n").length, 1);
    for (const banned of ["peak", "tools", "files", "cmp", "02:14", "/150k"]) {
      assert.equal(footer.includes(banned), false, `${banned} leaked into: ${footer}`);
    }
  });

  it("degrades by priority and never exceeds the width", () => {
    const rich = (() => {
      let state = withContext(withTicket(createState(T0)), 42_000);
      state = applyAutonomySync(state, { enabled: true, ticketId: "EZE-417" });
      state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });
      return applyDelegationStart(state, "worker", T0);
    })();

    for (const width of [80, 48, 32, 24, 16]) {
      const footer = render(snap(rich), T0, { width });
      assert.ok(footer.length <= width, `width ${width}: "${footer}"`);
      assert.ok(footer.startsWith("✧ AIES · EZE-417"), `width ${width}: "${footer}"`);
      assert.equal(footer.split("\n").length, 1);
    }

    assert.equal(render(snap(rich), T0, { width: 70 }), "✧ AIES · EZE-417 · WORK · ctx 42k · 00:00 · AUTO · V:PASS");
    assert.equal(render(snap(rich), T0, { width: 48 }), "✧ AIES · EZE-417 · WORK · ctx 42k · AUTO");
    assert.equal(render(snap(rich), T0, { width: 39 }), "✧ AIES · EZE-417 · WORK · ctx 42k");
    assert.equal(render(snap(rich), T0, { width: 32 }), "✧ AIES · EZE-417 · WORK");
    assert.equal(render(snap(rich), T0, { width: 22 }), "✧ AIES · EZE-417");
  });

  it("never drops a context pressure alarm, even when clipped", () => {
    let state = withContext(withTicket(createState(T0)), 104_000);
    state = applyContextGovernorSync(state, { zone: "pressure", currentTokens: 104_000 });
    state = applyDelegationStart(state, "worker", T0);

    const at32 = render(snap(state), T0, { width: 32 });
    assert.ok(at32.length <= 32, at32);
    assert.equal(at32, "✧ AIES · EZE-417 · ctx 104k !");

    const at24 = render(snap(state), T0, { width: 24 });
    assert.ok(at24.length <= 24, at24);
    assert.ok(at24.startsWith("✧ AIES · EZE-417 · ctx"), at24);
  });

  it("renders the minimal panel footer and hides model, cwd, AUTO and V:PASS", () => {
    const rich = (() => {
      let state = withContext(withTicket(createState(T0)), 42_000);
      state = applyAutonomySync(state, { enabled: true, ticketId: "EZE-417" });
      state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });
      state = applyModel(state, { id: "model-z", provider: "anthropic" });
      return applyDelegationStart(state, "worker", T0);
    })();

    const fallback = render(snap(rich), T0, { width: 200, cwd: "/home/dev/aies-smoke" });
    assert.match(fallback, /AUTO/u);
    assert.match(fallback, /V:PASS/u);
    assert.match(fallback, /model-z\/anthropic/u);
    assert.match(fallback, /00:00/u);
    assert.equal(fallback.includes("aies-smoke"), false);

    const minimal = render(snap(rich), T0, { width: 200, cwd: "/home/dev/aies-smoke", panelVisible: true });
    assert.equal(minimal, "✧ AIES · EZE-417 · WORK · ctx 42k");
    for (const hidden of ["AUTO", "V:PASS", "model-z", "anthropic", "00:00", "aies-smoke"]) {
      assert.equal(minimal.includes(hidden), false, minimal);
    }
  });

  it("keeps every alarm in the minimal footer, even when clipped", () => {
    let state = withContext(withTicket(createState(T0)), 104_000);
    state = applyContextGovernorSync(state, { zone: "pressure", currentTokens: 104_000 });
    state = applyDelegationStart(state, "worker", T0);

    const at32 = render(snap(state), T0, { width: 32, panelVisible: true });
    assert.ok(at32.length <= 32, at32);
    assert.equal(at32, "✧ AIES · EZE-417 · ctx 104k !");

    const compacting = applyContextGovernorSync(state, { compacting: true });
    const compactLine = render(snap(compacting), T0, { width: 48, panelVisible: true });
    assert.ok(compactLine.length <= 48, compactLine);
    assert.match(compactLine, /compactando…/u);
  });

  it("keeps a verification alarm in the minimal footer", () => {
    let state = withContext(withTicket(createState(T0)), 40_000);
    state = applyVerificationReport(state, { status: "fail", valid: false, attempts: 1 });
    state = applyDelegationStart(state, "worker", T0);

    const minimal = render(snap(state), T0, { width: 200, panelVisible: true });
    assert.match(minimal, /V:FAIL/u);
    assert.equal(minimal.includes("V:PASS"), false, minimal);
  });

  it("shows a protocol error as V:ERROR, never folded into a domain verdict", () => {
    let state = withContext(withTicket(createState(T0)), 40_000);
    state = applyVerificationStart(state);
    state = applyVerificationReport(state, { status: "protocol_error", valid: false, attempts: 1, awaitingVerification: true });

    const footer = render(snap(state));
    assert.match(footer, /V:ERROR/u);
    assert.equal(footer.includes("V:FAIL"), false, footer);
    assert.equal(footer.includes("V:BLOCKED"), false, footer);
    assert.equal(footer.includes("V:PASS"), false, footer);
  });
});

describe("header", () => {
  function ticketState(identifier, status, title) {
    return applyTicketObservationSync(createState(T0), { active: true, identifier, status, title });
  }

  it("renders a boxed identity with ID, title, status and AUTO", () => {
    const state = applyAutonomySync(ticketState("EZE-417", "In Progress", "Implement first-run guidance"), { enabled: true, ticketId: "EZE-417" });
    const lines = renderHeader(snap(state), 80);

    assert.equal(lines.length, 4);
    assert.match(lines[0], /✧ EZE-417/u);
    const text = lines.join("\n");
    assert.match(text, /Implement first-run guidance/u);
    assert.match(text, /In Progress/u);
    assert.match(text, /AUTO/u);
    assert.equal(text.includes("http"), false);
    assert.equal(text.toLowerCase().includes("criteri"), false);
  });

  it("degrades to one compact line at narrow widths", () => {
    const state = ticketState("EZE-422", "In Progress", "A very long title that must not appear");
    assert.deepEqual(renderHeader(snap(state), 40), ["EZE-422 · In Progress"]);

    const auto = applyAutonomySync(state, { enabled: true, ticketId: "EZE-422" });
    assert.deepEqual(renderHeader(snap(auto), 40), ["EZE-422 · In Progress · AUTO"]);
    assert.equal(renderHeader(snap(state), 40).join(" ").includes("long title"), false);
  });

  it("renders no header without an active ticket", () => {
    assert.deepEqual(renderHeader(snap(createState(T0)), 80), []);
    assert.deepEqual(renderHeader(snap(createState(T0)), 40), []);
  });
});

describe("activity", () => {
  it("renders live explore, worker and verify cards", () => {
    assert.deepEqual(renderActivityCard({ role: "explore", task: "", startedAt: T0 }, "EXPLORE", T0 + 12_000), [
      "◆ Explore",
      "  Revisando el proyecto y preparando el cambio",
      "  00:12",
    ]);

    assert.deepEqual(renderActivityCard({ role: "worker", task: "", startedAt: T0 }, "WORK", T0 + 34_000), [
      "◆ Worker",
      "  Implementando el cambio y sus tests",
      "  00:34",
    ]);

    assert.deepEqual(renderActivityCard({ role: "verify", task: "", startedAt: T0, criteriaTotal: 4 }, "VERIFY", T0 + 18_000), [
      "◆ Verify",
      "  Comprobando 4 criterios…",
      "  00:18",
    ]);
  });

  it("uses the delegation task and the repair subtitle", () => {
    const card = renderActivityCard({ role: "worker", task: "Arreglar el parser", startedAt: T0 }, "REPAIR", T0 + 5_000);
    assert.equal(card[1], "  reparando · Arreglar el parser");

    const explore = renderActivityCard({ role: "explore", task: "Buscar el handoff", startedAt: T0 }, "EXPLORE", T0 + 5_000);
    assert.equal(explore[1], "  Buscar el handoff");
  });

  it("appends the child model only when asked", () => {
    const activity = { role: "worker", task: "", startedAt: T0, model: "model-x" };
    assert.equal(renderActivityCard(activity, "WORK", T0 + 12_000, { showModel: true })[2], "  00:12 · model-x");
    assert.equal(renderActivityCard(activity, "WORK", T0 + 12_000)[2], "  00:12");
  });

  it("treats a finished record as no longer widget-visible", () => {
    const finished = { role: "explore", task: "", startedAt: T0, finishedAt: T0 + 16_000, outcome: "done", evidenceCount: 4 };

    assert.equal(isActivityVisible({ role: "explore", task: "", startedAt: T0 }, T0), true);
    assert.equal(isActivityVisible(finished, T0 + 16_000), false);
    assert.equal(isActivityVisible(finished, T0 + 16_000 + 60_000), false);
    assert.deepEqual(renderActivityCard(finished, "IDLE", T0 + 16_000), []);
    assert.deepEqual(renderActivityCard(finished, "IDLE", T0 + 16_000 + 60_000), []);
  });

  it("renders the boxed live card at width 48 and above", () => {
    const activity = {
      role: "worker",
      task: "Implementar el cambio",
      startedAt: T0,
      currentActivity: "Editando calculator.js",
      changedPaths: ["src/calculator.js"],
      modelLabel: "Qwen 3.8 Flash",
      providerLabel: "openrouter",
      totalTokens: 34_000,
      cost: 0.03,
    };
    const lines = renderActivityCard(activity, "WORK", T0 + 31_000, { width: 60 });
    assert.ok(lines.length >= 4, lines.join("\n"));
    assert.ok(lines.length <= 6, lines.join("\n"));
    assert.match(lines[0], /^╭─ ◆ Worker/u);
    assert.match(lines.at(-1), /^╰/u);
    for (const line of lines) assert.ok(line.length <= 60, line);

    const text = lines.join("\n");
    assert.match(text, /Editando calculator\.js/u);
    assert.match(text, /00:31/u);
    assert.match(text, /34k tokens/u);
    assert.match(text, /\$0\.03/u);
  });

  it("caps the boxed card at the panel width so it reads as a card, not a banner", () => {
    const activity = {
      role: "worker",
      task: "Implementar el cambio",
      startedAt: T0,
      currentActivity: "Editando calculator.js",
      changedPaths: ["src/calculator.js"],
      modelLabel: "Qwen 3.8 Flash",
      totalTokens: 34_000,
      cost: 0.03,
    };

    const wide = renderActivityCard(activity, "WORK", T0 + 31_000, { width: 140 });
    assert.match(wide[0], /^╭─ ◆ Worker/u);
    for (const line of wide) assert.ok(line.length <= 72, `wide card line ${line.length}: ${line}`);

    const mid = renderActivityCard(activity, "WORK", T0 + 31_000, { width: 60 });
    assert.match(mid[0], /^╭─ ◆ Worker/u);
    for (const line of mid) assert.ok(line.length <= 60, `mid card line ${line.length}: ${line}`);

    const narrow = renderActivityCard(activity, "WORK", T0 + 31_000, { width: 40 });
    for (const line of narrow) assert.ok(line.length <= 40, `narrow card line ${line.length}: ${line}`);
  });

  it("omits every unknown metric from the boxed card", () => {
    const activity = { role: "worker", task: "", startedAt: T0 };
    const text = renderActivityCard(activity, "WORK", T0 + 12_000, { width: 60 }).join("\n");
    assert.match(text, /00:12/u);
    assert.equal(text.includes("tokens"), false, text);
    assert.equal(text.includes("$"), false, text);
    assert.equal(text.includes("—"), false, text);
  });

  it("falls back to the plain three lines below width 48", () => {
    const activity = { role: "explore", task: "", startedAt: T0 };
    assert.deepEqual(renderActivityCard(activity, "EXPLORE", T0 + 12_000, { width: 40 }), [
      "◆ Explore",
      "  Revisando el proyecto y preparando el…",
      "  00:12",
    ]);
  });

  it("prefers the mechanical currentActivity over the task text", () => {
    const activity = { role: "worker", task: "Implement the parent English prompt", startedAt: T0, currentActivity: "Editando main.ts" };
    const plain = renderActivityCard(activity, "WORK", T0 + 5_000);
    assert.equal(plain[1], "  Editando main.ts");

    const boxed = renderActivityCard(activity, "WORK", T0 + 5_000, { width: 60 }).join("\n");
    assert.match(boxed, /Editando main\.ts/u);
    assert.equal(boxed.includes("Implement the parent English prompt"), false, boxed);
  });

  it("prefers the active ticket title over the parent-authored task in the live card", () => {
    const worker = renderActivityCard(
      { role: "worker", task: "Implement the parent English prompt", startedAt: T0 },
      "WORK",
      T0 + 5_000,
      { ticketTitle: "Implement first-run guidance" },
    );
    assert.equal(worker[1], "  Implement first-run guidance");

    const withoutTicket = renderActivityCard({ role: "worker", task: "Implement the parent English prompt", startedAt: T0 }, "WORK", T0 + 5_000);
    assert.equal(withoutTicket[1], "  Implementando el cambio y sus tests");

    const verify = renderActivityCard(
      { role: "verify", task: "Verify the parent prompt", startedAt: T0, criteriaTotal: 4 },
      "VERIFY",
      T0 + 5_000,
      { ticketTitle: "Implement first-run guidance" },
    );
    assert.equal(verify[1], "  Comprobando 4 criterios…");
  });

  it("keeps the durable entry as the single, fact-carrying trace of a finished child", () => {
    const explore = { role: "explore", task: "", startedAt: T0, finishedAt: T0 + 16_000, outcome: "done", evidenceCount: 4 };
    assert.equal(renderActivityEntry(explore), "✓ Explore · 00:16 · 4 archivos relevantes");

    const worker = { role: "worker", task: "", startedAt: T0, finishedAt: T0 + 39_000, outcome: "done", totalTokens: 34_000, cost: 0.04, changedFiles: 3, checksPassed: 3, checksTotal: 3 };
    assert.equal(renderActivityEntry(worker), "✓ Worker · 00:39 · 34k · $0.04 · 3 archivos modificados · checks aprobados");

    const verify = { role: "verify", task: "", startedAt: T0, finishedAt: T0 + 27_000, outcome: "failed", blockingDefects: 1 };
    assert.equal(renderActivityEntry(verify), "✗ Verify · FAIL · 00:27 · 1 defecto bloqueante");

    const protocol = { role: "verify", task: "", startedAt: T0, finishedAt: T0 + 4_000, outcome: "protocol_error" };
    assert.match(renderActivityEntry(protocol), /error de protocolo/u);
    assert.equal(renderActivityEntry(protocol).includes("BLOCKED"), false);

    const noFacts = renderActivityEntry({ role: "explore", task: "", startedAt: T0, finishedAt: T0 + 16_000, outcome: "done", evidenceCount: 0 });
    assert.equal(noFacts, "✓ Explore · 00:16");
    assert.equal(noFacts.includes("—"), false);
  });
});

describe("approval", () => {
  it("builds the action, the effect and the reason without policy tokens", () => {
    const { title, message } = renderApprovalPrompt({
      action: "Instalar o modificar dependencias",
      detail: "pnpm add zod",
      effect: "cambia el árbol de dependencias del proyecto",
      reason: "validar el nuevo schema",
    });

    assert.equal(title, "AIES necesita permiso");
    assert.equal(
      message,
      ["Instalar o modificar dependencias", "  pnpm add zod", "", "Efecto", "  cambia el árbol de dependencias del proyecto", "", "Necesario para", "  validar el nuevo schema"].join("\n"),
    );
    assert.equal(message.includes("permission="), false);
    assert.equal(message.includes("category="), false);
  });

  it("omits every part that has no value", () => {
    const onlyAction = renderApprovalPrompt({ action: "Instalar dependencia", detail: "pnpm add zod", reason: "validar el schema" });
    assert.equal(onlyAction.message, ["Instalar dependencia", "  pnpm add zod", "", "Necesario para", "  validar el schema"].join("\n"));
    assert.equal(onlyAction.message.includes("Efecto"), false);

    const noReason = renderApprovalPrompt({ action: "Instalar dependencia", effect: "cambia el árbol" });
    assert.equal(noReason.message.includes("Necesario para"), false);

    const blankAction = renderApprovalPrompt({ action: "   ", reason: "  " });
    assert.equal(blankAction.message, "");
    assert.equal(blankAction.title, "AIES necesita permiso");
  });

  it("exposes the two exact approval choices for a select dialog", () => {
    assert.deepEqual(approvalOptions(), ["Permitir una vez", "Denegar"]);
  });
});

describe("summaries", () => {
  it("renders the compact DONE projection with only the rows that have values", () => {
    const full = renderDoneSummary(
      {
        ticket: "EZE-423",
        agents: [
          { role: "Worker", glyph: "✓", text: "1 archivo · checks aprobados" },
          { role: "Verify", glyph: "✓", text: "PASS · 5/5" },
        ],
        linear: "Done",
        commit: "abc1234",
        tokens: { total: 16_000, main: 12_000, agents: 4_000 },
        cost: 0.06,
        durationMs: 106_000,
      },
      { width: 60 },
    );

    assert.match(full[0], /✓ EZE-423 · completado/u);
    assert.match(full[0], /01:46/u, "the duration rides the headline when the width allows");
    const text = full.join("\n");
    assert.match(text, /^  Worker ✓ 1 archivo · checks aprobados$/mu);
    assert.match(text, /^  Verify ✓ PASS · 5\/5$/mu);
    assert.match(text, /^  Linear ✓ Done$/mu);
    assert.equal(text.includes("Git"), false, `detailed git facts stay out of DONE:\n${text}`);
    assert.equal(text.includes("Tokens"), false, `detailed tokens stay out of DONE:\n${text}`);
    assert.equal(text.includes("Coste"), false, `detailed cost stays out of DONE:\n${text}`);
    assert.equal(text.includes("Tiempo"), false, text);
  });

  it("falls back to a Time row without a width and omits empty rows", () => {
    const withDuration = renderDoneSummary({ ticket: "EZE-423", durationMs: 106_000 });
    assert.equal(withDuration[0], "✓ EZE-423 · completado");
    assert.equal(withDuration.at(-1), "  Tiempo 01:46");

    assert.deepEqual(renderDoneSummary({ ticket: "EZE-417" }), ["✓ EZE-417 · completado"]);
    assert.deepEqual(renderDoneSummary({}), ["✓ Tarea completada"]);

    const unknown = renderDoneSummary({ ticket: "EZE-423", cost: null });
    const unknownText = unknown.join("\n");
    assert.equal(unknownText.includes("Coste"), false, unknownText);
    assert.equal(unknownText.includes("$0.00"), false);
    assert.equal(unknownText.includes("Git"), false);
    assert.equal(unknownText.includes("NaN"), false);
  });

  it("bounds arbitrary agent input so DONE cannot grow without limit", () => {
    const agents = Array.from({ length: 12 }, (_, index) => ({
      role: "Worker",
      glyph: "✓",
      text: `${index}: ${"x".repeat(400)}`,
    }));
    const lines = renderDoneSummary({ ticket: "EZE-423", agents });
    const text = lines.join("\n");

    assert.ok(lines.length <= 7, `unbounded DONE grew to ${lines.length} lines:\n${text}`);
    assert.match(text, /más/u, text);
    for (const line of lines) assert.ok(line.length <= 72, `line too long (${line.length}): ${line}`);
  });

  it("renders a real warning with a pointer to the full view", () => {
    const text = renderDoneSummary({ ticket: "EZE-423", warnings: ["1 check no concluyó"] }).join("\n");
    assert.match(text, /^! 1 check no concluyó$/mu);
    assert.match(text, /^  \/aies-status detalle$/mu);
  });

  it("renders a BLOCKED card with needs, state and verification last", () => {
    const full = renderBlockedSummary({
      ticket: "EZE-417",
      happened: "La instalación requiere autorización.",
      needs: "autorización para instalar X",
      done: ["implementación terminada"],
      pending: "Verify pendiente",
      verification: "V:PASS",
    });

    assert.equal(full[0], "! EZE-417 bloqueado");
    const text = full.join("\n");
    assert.match(text, /^Necesita$/mu);
    assert.match(text, /^  autorización para instalar X$/mu);
    assert.match(text, /^Estado$/mu);
    assert.match(text, /^  implementación terminada$/mu);
    assert.match(text, /^  Verify pendiente$/mu);
    assert.equal(full.at(-1), "V:PASS");

    const minimal = renderBlockedSummary({ happened: "Linear no pudo sincronizarse." });
    assert.deepEqual(minimal, ["! Bloqueado", "", "Linear no pudo sincronizarse."]);
    assert.equal(minimal.join("\n").includes("Necesita"), false);
    assert.equal(minimal.join("\n").includes("Estado"), false);
  });

  it("renders the /aies-status overview for a full and an empty state", () => {
    let state = createState(T0);
    state = applyTicketObservationSync(state, { active: true, identifier: "EZE-417", status: "In Progress", title: "Implement first-run guidance" });
    state = applyContextUsage(state, { tokens: 43_000, contextWindow: 150_000 });
    state = applyContextGovernorSync(state, { zone: "green", currentTokens: 43_000, compactAtTokens: 120_000, ceilingTokens: 150_000 });
    state = applyAutonomySync(state, { enabled: true, ticketId: "EZE-417", continuationCount: 3, stopReason: null, lastStep: "working" });
    state = applyModel(state, { id: "qwen3.8-flash", provider: "openrouter", name: "Qwen 3.8 Flash" });
    state = applyDelegationStart(state, "worker", T0 + 100, "Implement the unit");
    state = applyDelegationEnd(state, "done", T0 + 31_000);
    state = applyVerificationStart(state);
    state = applyVerificationReport(state, { status: "pass", valid: true, repairs: 0, maxRepairs: 2 });
    const agent = { id: "worker-1", role: "worker", status: "completed", startedAt: T0, finishedAt: T0 + 31_000, modelId: null, modelLabel: null, providerId: null, providerLabel: null, currentActivity: null, totalTokens: 4_000, cost: 0.02, toolCount: 3, changedPaths: ["a.js"], activities: [], result: null };
    state = applyAgents(state, [agent]);
    state = applyRunStart(state, T0);
    state = applyRunUsage(state, { totalTokens: 1_000, cost: 0.01 }, [], T0);
    state = applyRunUsage(state, { totalTokens: 13_000, cost: 0.05 }, [agent], T0 + 402_000);

    const full = renderStatusOverview(snapWithAgents(state), T0 + 402_000);
    assert.equal(full.split("\n")[0], "AIES");
    assert.equal(field(full, "actual"), "43k / 150k · verde");
    assert.equal(field(full, "pico"), "43k");
    assert.equal(field(full, "compactaciones"), "0");
    assert.equal(field(full, "estado"), "PASS");
    assert.equal(field(full, "intentos"), "1");
    assert.equal(field(full, "reparaciones"), "0 / 2");
    assert.equal(field(full, "modelo"), "Qwen 3.8 Flash · openrouter");
    assert.match(field(full, "Tokens"), /Main 12k · Agents 4k · Total 16k/u);
    assert.match(field(full, "Coste"), /Main \$0\.04 · Agents \$0\.02 · Total \$0\.06/u);
    assert.match(field(full, "worker"), /completed · 00:31 · 4k/u);
    for (const label of ["Ejecución", "tiempo", "Uso", "Agentes"]) assert.ok(full.includes(label), full);
    assert.ok(full.split("\n").length <= 34, `too many lines:\n${full}`);

    const empty = renderStatusOverview(snap(createState(T0)), T0);
    assert.equal(empty.split("\n")[0], "AIES");
    assert.equal(field(empty, "actual"), "?");
    assert.equal(field(empty, "pico"), "0");
    assert.equal(field(empty, "compactaciones"), "0");
    assert.equal(empty.includes("Ticket"), false);
    assert.equal(empty.includes("Verificación"), false);
    assert.equal(empty.includes("modelo"), false);
    assert.equal(empty.includes("Tokens"), false);
    assert.equal(empty.includes("Agentes"), false);
  });

  it("renders a protocol error in the overview without the raw internal code", () => {
    let state = createState(T0);
    state = applyVerificationStart(state);
    state = applyVerificationReport(state, { status: "protocol_error", valid: false, repairs: 0, maxRepairs: 2, awaitingVerification: true });

    const overview = renderStatusOverview(snap(state), T0);
    assert.equal(field(overview, "estado"), "error de protocolo");
    assert.equal(overview.includes("PROTOCOL_ERROR"), false, overview);
    assert.equal(field(overview, "estado") === "BLOQUEADO", false, overview);
  });
});

describe("state activity observation", () => {
  it("records the task, the outcome and the reported facts", () => {
    let state = createState(T0);
    state = applyDelegationStart(state, "explore", T0 + 100, "Buscar el handoff");
    assert.equal(state.delegations.activeTask, "Buscar el handoff");
    assert.deepEqual(state.activity, { role: "explore", task: "Buscar el handoff", startedAt: T0 + 100 });

    state = applyActivityFacts(state, { evidenceCount: 4, changedFiles: "nope", summary: "ok" });
    assert.equal(state.activity.evidenceCount, 4);
    assert.equal(state.activity.changedFiles, undefined);
    assert.equal(state.activity.summary, "ok");

    state = applyDelegationEnd(state, "done", T0 + 16_100);
    assert.equal(state.activity.finishedAt, T0 + 16_100);
    assert.equal(state.activity.outcome, "done");
    assert.equal(state.delegations.activeTask, undefined);
  });

  it("still starts a delegation when the task is omitted", () => {
    const state = applyDelegationStart(createState(T0), "worker", T0);
    assert.equal(state.delegations.activeRole, "worker");
    assert.equal(state.activity.role, "worker");
    assert.equal(state.activity.task, "");
  });

  it("survives a snapshot round-trip", () => {
    let state = createState(T0);
    state = applyDelegationStart(state, "verify", T0 + 100, "Comprobar");
    state = applyActivityFacts(state, { criteriaPassed: 4, criteriaTotal: 4, blockingDefects: 0 });
    state = applyDelegationEnd(state, "done", T0 + 27_100);

    const restored = fromSnapshot(JSON.parse(JSON.stringify(snap(state))), T0);
    assert.deepEqual(restored.activity, state.activity);
    assert.deepEqual(toSnapshot(restored).activity, snap(state).activity);
  });

  it("degrades to silence without an activity record", () => {
    const state = applyActivityFacts(createState(T0), { evidenceCount: 4 });
    assert.equal(state.activity, undefined);
    assert.equal(toSnapshot(state).activity, undefined);
  });
});
