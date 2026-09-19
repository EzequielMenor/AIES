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
  applyAutonomySync,
  applyContextGovernorSync,
  applyContextUsage,
  applyDelegationEnd,
  applyDelegationStart,
  applyModel,
  applyParentMutation,
  applyTicketObservationSync,
  applyVerificationReport,
  applyVerificationStart,
  createState,
  fromSnapshot,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderFooter, renderHeader } from "../extensions/aies-ui/footer.ts";
import { clip, formatDuration, formatTokens, singleLine } from "../extensions/aies-ui/format.ts";
import { deriveStage, isCompacting, isContextPressure, verificationIndicator } from "../extensions/aies-ui/vocabulary.ts";
import { ACTIVITY_TTL_MS, isActivityVisible, renderActivityCard, renderActivityEntry } from "../extensions/aies-ui/activity.ts";
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
    assert.equal(formatTokens(34_000), "34k");
    assert.equal(formatTokens(1_500_000), "1.5M");
    assert.equal(formatTokens(null), "?");
    assert.equal(formatDuration(14_000), "00:14");
    assert.equal(formatDuration(151_000), "02:31");
    assert.equal(formatDuration(3_862_000), "1:04:22");
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
    assert.equal(deriveStage(snap(passed)), "DONE");
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
});

describe("footer", () => {
  it("shows idle, ticket + WORK and ticket + VERIFY", () => {
    assert.equal(render(snap(withContext(createState(T0), 31_000))), "❈ AIES · listo · ctx 31k");

    const working = applyDelegationStart(withContext(withTicket(createState(T0)), 42_000), "worker", T0);
    assert.equal(render(snap(working)), "❈ AIES · EZE-417 · WORK · ctx 42k");

    const verifying = applyDelegationStart(withContext(withTicket(createState(T0)), 45_000), "verify", T0);
    assert.equal(render(snap(verifying)), "❈ AIES · EZE-417 · VERIFY · ctx 45k");
  });

  it("shows a placeholder only at IDLE and omits it while work is in flight", () => {
    assert.equal(render(snap(withContext(createState(T0), 31_000))), "❈ AIES · listo · ctx 31k");

    const idleTicket = withContext(withTicket(createState(T0)), 46_000);
    assert.equal(render(snap(idleTicket)), "❈ AIES · EZE-417 · ctx 46k");

    const exploringNoTicket = applyDelegationStart(withContext(createState(T0), 42_000), "explore", T0);
    assert.equal(render(snap(exploringNoTicket)), "❈ AIES · EXPLORE · ctx 42k");

    const auto = applyAutonomySync(withContext(withTicket(createState(T0)), 42_000), { enabled: true, ticketId: "EZE-417" });
    const exploringTicket = applyDelegationStart(auto, "explore", T0);
    assert.equal(render(snap(exploringTicket)), "❈ AIES · EZE-417 · EXPLORE · ctx 42k · AUTO");

    const doneTicket = applyAutonomySync(withContext(withTicket(createState(T0)), 46_000), { enabled: false, stopReason: "completed" });
    assert.equal(render(snap(doneTicket)), "❈ AIES · EZE-417 · DONE · ctx 46k");
    assert.equal(render(snap(doneTicket)).includes("V:PASS"), false);
  });

  it("shows AUTO only when autonomy is enabled", () => {
    const base = withContext(withTicket(createState(T0)), 40_000);
    const on = applyAutonomySync(base, { enabled: true, ticketId: "EZE-417" });
    const off = applyAutonomySync(base, { enabled: false });

    assert.equal(render(snap(on)), "❈ AIES · EZE-417 · ctx 40k · AUTO");
    assert.equal(render(snap(off)).includes("AUTO"), false);
    assert.equal(render(snap(createState(T0))).includes("AUTO"), false);
  });

  it("appends the compact cwd and model only when the width permits", () => {
    const ticket = withContext(withTicket(createState(T0)), 42_000);
    const modeled = applyModel(ticket, { id: "model-z", provider: "anthropic" });

    assert.match(render(snap(modeled), T0, { width: 120 }), / · model-z$/u);
    assert.equal(render(snap(modeled), T0, { width: 30 }).includes("model-z"), false);
    assert.match(render(snap(ticket), T0, { width: 120, cwd: "/home/dev/aies-smoke" }), / · aies-smoke$/u);
    assert.equal(render(snap(ticket), T0, { width: 30, cwd: "/home/dev/aies-smoke" }).includes("aies-smoke"), false);
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
      assert.ok(footer.startsWith("❈ AIES · EZE-417"), `width ${width}: "${footer}"`);
      assert.equal(footer.split("\n").length, 1);
    }

    assert.equal(render(snap(rich), T0, { width: 70 }), "❈ AIES · EZE-417 · WORK · ctx 42k · AUTO · V:PASS");
    assert.equal(render(snap(rich), T0, { width: 48 }), "❈ AIES · EZE-417 · WORK · ctx 42k · AUTO");
    assert.equal(render(snap(rich), T0, { width: 39 }), "❈ AIES · EZE-417 · WORK · ctx 42k");
    assert.equal(render(snap(rich), T0, { width: 32 }), "❈ AIES · EZE-417 · WORK");
    assert.equal(render(snap(rich), T0, { width: 22 }), "❈ AIES · EZE-417");
  });

  it("never drops a context pressure alarm, even when clipped", () => {
    let state = withContext(withTicket(createState(T0)), 104_000);
    state = applyContextGovernorSync(state, { zone: "pressure", currentTokens: 104_000 });
    state = applyDelegationStart(state, "worker", T0);

    const at32 = render(snap(state), T0, { width: 32 });
    assert.ok(at32.length <= 32, at32);
    assert.equal(at32, "❈ AIES · EZE-417 · ctx 104k !");

    const at24 = render(snap(state), T0, { width: 24 });
    assert.ok(at24.length <= 24, at24);
    assert.ok(at24.startsWith("❈ AIES · EZE-417 · ctx"), at24);
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
    assert.match(lines[0], /❈ EZE-417/u);
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
      "  Explorando el repositorio…",
      "  00:12",
    ]);

    assert.deepEqual(renderActivityCard({ role: "worker", task: "", startedAt: T0 }, "WORK", T0 + 34_000), [
      "◆ Worker",
      "  Implementando el work unit…",
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

  it("keeps a finished card for the TTL and then clears it", () => {
    const finished = { role: "explore", task: "", startedAt: T0, finishedAt: T0 + 16_000, outcome: "done", evidenceCount: 4 };

    assert.equal(isActivityVisible({ role: "explore", task: "", startedAt: T0 }, T0), true);
    assert.equal(isActivityVisible(finished, T0 + 16_000 + ACTIVITY_TTL_MS - 1), true);
    assert.equal(isActivityVisible(finished, T0 + 16_000 + ACTIVITY_TTL_MS), false);
    assert.deepEqual(renderActivityCard(finished, "IDLE", T0 + 16_000 + ACTIVITY_TTL_MS), []);
  });

  it("renders the finished facts and never a placeholder", () => {
    assert.deepEqual(renderActivityCard({ role: "explore", task: "", startedAt: T0, finishedAt: T0 + 16_000, outcome: "done", evidenceCount: 4 }, "IDLE", T0 + 16_000), [
      "✓ Explore · 00:16",
      "  4 archivos relevantes",
    ]);

    assert.deepEqual(renderActivityCard({ role: "worker", task: "", startedAt: T0, finishedAt: T0 + 51_000, outcome: "done", changedFiles: 3, checksPassed: 3, checksTotal: 3 }, "IDLE", T0 + 51_000), [
      "✓ Worker · 00:51",
      "  3 archivos modificados · checks aprobados",
    ]);

    assert.deepEqual(renderActivityCard({ role: "verify", task: "", startedAt: T0, finishedAt: T0 + 27_000, outcome: "done", criteriaPassed: 4, criteriaTotal: 4 }, "IDLE", T0 + 27_000), [
      "✓ Verify · PASS · 00:27",
      "  4/4 criterios",
    ]);

    assert.deepEqual(renderActivityCard({ role: "verify", task: "", startedAt: undefined, finishedAt: T0, outcome: "failed", blockingDefects: 1 }, "IDLE", T0), [
      "✗ Verify · FAIL",
      "  1 defecto bloqueante",
    ]);

    assert.deepEqual(renderActivityCard({ role: "verify", task: "", startedAt: T0, finishedAt: T0 + 4_000, outcome: "blocked" }, "IDLE", T0 + 4_000), [
      "! Verify · BLOCKED · 00:04",
      "  la verificación no pudo concluir",
    ]);

    const protocol = renderActivityCard(
      { role: "verify", task: "", startedAt: T0, finishedAt: T0 + 4_000, outcome: "protocol_error" },
      "BLOCKED",
      T0 + 4_000,
    ).join("\n");
    assert.match(protocol, /ERROR/u);
    assert.match(protocol, /error de protocolo/u);
    assert.equal(protocol.includes("BLOCKED"), false, protocol);

    const noFacts = renderActivityCard({ role: "explore", task: "", startedAt: T0, finishedAt: T0 + 16_000, outcome: "done", evidenceCount: 0 }, "IDLE", T0 + 16_000);
    assert.deepEqual(noFacts, ["✓ Explore · 00:16"]);
    assert.equal(noFacts.join("\n").includes("0 "), false);
    assert.equal(noFacts.join("\n").includes("—"), false);
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
    assert.equal(withoutTicket[1], "  Implement the parent English prompt");

    const verify = renderActivityCard(
      { role: "verify", task: "Verify the parent prompt", startedAt: T0, criteriaTotal: 4 },
      "VERIFY",
      T0 + 5_000,
      { ticketTitle: "Implement first-run guidance" },
    );
    assert.equal(verify[1], "  Comprobando 4 criterios…");
  });

  it("renders the durable transcript entry", () => {
    const finished = { role: "explore", task: "", startedAt: T0, finishedAt: T0 + 16_000, outcome: "done", evidenceCount: 4 };
    assert.equal(renderActivityEntry(finished), "✓ Explore · 00:16 · 4 archivos relevantes");
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
  it("renders a DONE card with only the sections that have values", () => {
    const full = renderDoneSummary({
      ticket: "EZE-417",
      changes: ["First-run guidance añadida.", "Estados de temperatura aclarados."],
      verification: "PASS · 4 criterios · 18 tests",
      linear: "Done",
      commit: "abc1234",
      durationMs: 261_000,
    });

    assert.equal(full[0], "✓ EZE-417 completado");
    const text = full.join("\n");
    assert.match(text, /^Cambios$/mu);
    assert.match(text, /^  First-run guidance añadida\.$/mu);
    assert.match(text, /^Verificación$/mu);
    assert.match(text, /^Linear$/mu);
    assert.match(text, /^Git$/mu);
    assert.match(text, /^Tiempo$/mu);
    assert.match(text, /  04:21/u);

    assert.deepEqual(renderDoneSummary({ ticket: "EZE-417" }), ["✓ EZE-417 completado"]);
    assert.deepEqual(renderDoneSummary({}), ["✓ Tarea completada"]);

    const noCommit = renderDoneSummary({ changes: ["x"] });
    assert.equal(noCommit.join("\n").includes("Git"), false);
    assert.equal(noCommit.join("\n").includes("NaN"), false);
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
    state = applyDelegationStart(state, "worker", T0 + 100, "Implement the unit");
    state = applyDelegationEnd(state, "done", T0 + 31_000);
    state = applyVerificationStart(state);
    state = applyVerificationReport(state, { status: "pass", valid: true, repairs: 0, maxRepairs: 2 });

    const full = renderStatusOverview(snap(state), T0 + 402_000);
    assert.equal(full.split("\n")[0], "AIES");
    assert.equal(field(full, "actual"), "43k / 150k · verde");
    assert.equal(field(full, "pico"), "43k");
    assert.equal(field(full, "compactaciones"), "0");
    assert.equal(field(full, "estado"), "PASS");
    assert.equal(field(full, "intentos"), "1");
    assert.equal(field(full, "reparaciones"), "0 / 2");
    assert.ok(full.includes("Ejecución"), full);
    assert.ok(full.split("\n").length <= 30, `too many lines:\n${full}`);

    const empty = renderStatusOverview(snap(createState(T0)), T0);
    assert.equal(empty.split("\n")[0], "AIES");
    assert.equal(field(empty, "actual"), "?");
    assert.equal(field(empty, "pico"), "0");
    assert.equal(field(empty, "compactaciones"), "0");
    assert.equal(empty.includes("Ticket"), false);
    assert.equal(empty.includes("Verificación"), false);
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
