/**
 * Spanish UX invariants for AIES-010B / T2.
 *
 * Asserts the resident Parent system-prompt rule, the identity report language,
 * and the Spanish-first rendering of the critical human projections (footer,
 * header, activity facts, overview, detail rows, approval choices). The checks
 * are semantic, never full-string snapshots, so copy can evolve without
 * breaking the suite.
 *
 * No Pi runtime, no terminal, no timers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import aiesIdentity, { RESIDENT_SYSTEM_RULE } from "../extensions/aies-identity.ts";
import {
  applyAutonomySync,
  applyContextGovernorSync,
  applyContextUsage,
  applyTicketObservationSync,
  applyVerificationReport,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderStatusOverview } from "../extensions/aies-ui/summary.ts";
import { renderStatusReport } from "../extensions/aies-runtime/status.ts";
import { renderFooter, renderHeader } from "../extensions/aies-ui/footer.ts";
import { renderActivityCard, renderActivityEntry } from "../extensions/aies-ui/activity.ts";
import { approvalOptions, renderApprovalPrompt } from "../extensions/aies-ui/approval.ts";
import { handlePermissionGate } from "../extensions/aies-agents/permissions.ts";

const T0 = 1_700_000_000_000;
const RULE_LINES = [
  "Responde siempre al usuario en castellano.",
  "Mantén comandos, código, nombres técnicos e identificadores en su idioma original.",
  "No narres pasos internos si la UI ya los representa.",
];

/** A fake ExtensionAPI that records what the extension registers. */
function fakePi() {
  const handlers = new Map();
  const commands = new Map();
  return {
    handlers,
    commands,
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
  };
}

function ticketState(identifier, status, title) {
  return applyTicketObservationSync(createState(T0), { active: true, identifier, status, title });
}

describe("resident Parent Spanish rule", () => {
  it("is exactly the three required instructions", () => {
    assert.deepEqual(RESIDENT_SYSTEM_RULE.split("\n"), RULE_LINES);
  });

  it("appends the rule to the Parent system prompt once per agent start", async () => {
    const pi = fakePi();
    aiesIdentity(pi);

    const handler = pi.handlers.get("before_agent_start")?.[0];
    assert.equal(typeof handler, "function", "no before_agent_start handler registered");

    const result = await handler({ type: "before_agent_start", prompt: "hola", systemPrompt: "BASE PROMPT" });
    assert.ok(result.systemPrompt.startsWith("BASE PROMPT"), result.systemPrompt);
    for (const line of RULE_LINES) assert.ok(result.systemPrompt.includes(line), result.systemPrompt);
  });

  it("never duplicates the rule when the handler is invoked again", async () => {
    const pi = fakePi();
    aiesIdentity(pi);
    const handler = pi.handlers.get("before_agent_start")[0];

    const once = await handler({ type: "before_agent_start", prompt: "hola", systemPrompt: "BASE" });
    const twice = await handler({ type: "before_agent_start", prompt: "otra", systemPrompt: once.systemPrompt });

    const occurrences = twice.systemPrompt.split(RULE_LINES[0]).length - 1;
    assert.equal(occurrences, 1, twice.systemPrompt);
  });
});

describe("identity projection", () => {
  it("reports the profile with Spanish labels", async () => {
    const pi = fakePi();
    aiesIdentity(pi);

    const command = pi.commands.get("aies-info");
    assert.ok(command, "aies-info is not registered");

    let message = "";
    await command.handler("", { cwd: "/repo", mode: "tui", ui: { notify: (text) => { message = text; } } });

    assert.match(message, /perfil/u);
    assert.match(message, /directorio del agente/u);
    assert.equal(message.includes("agent dir"), false, message);
  });

  it("announces the profile in Spanish without touching non-UI sessions", async () => {
    const pi = fakePi();
    aiesIdentity(pi);
    const handler = pi.handlers.get("session_start")[0];

    let told = "";
    await handler({ type: "session_start", reason: "startup" }, { hasUI: true, ui: { notify: (text) => { told = text; } } });
    assert.match(told, /Perfil AIES/u);

    let silent = "";
    await handler({ type: "session_start", reason: "startup" }, { hasUI: false, ui: { notify: (text) => { silent = text; } } });
    assert.equal(silent, "", "a headless session must stay silent");
  });
});

describe("Spanish critical copy", () => {
  it("renders the idle footer in Spanish with the AIES identity glyph", () => {
    const footer = renderFooter(toSnapshot(applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 })), T0);
    assert.equal(footer, "❈ AIES · listo · ctx 31k");
    assert.equal(footer.includes("ready"), false);
  });

  it("renders the activity facts in Spanish instead of `checks passed`", () => {
    const lines = renderActivityCard(
      { role: "worker", task: "", startedAt: T0, finishedAt: T0 + 51_000, outcome: "done", changedFiles: 3, checksPassed: 3, checksTotal: 3 },
      "IDLE",
      T0 + 51_000,
    );
    const text = lines.join("\n");
    assert.match(text, /checks aprobados/u);
    assert.equal(text.includes("checks passed"), false, text);
  });

  it("renders the ticket header in Spanish-free technical terms with AUTO", () => {
    const state = applyAutonomySync(ticketState("EZE-422", "In Progress", "Implement first-run guidance"), {
      enabled: true,
      ticketId: "EZE-422",
    });
    assert.deepEqual(renderHeader(toSnapshot(state), 40), ["EZE-422 · In Progress · AUTO"]);
  });

  it("renders the /aies-status overview with Spanish sections and labels", () => {
    let state = ticketState("EZE-417", "In Progress", "Implement first-run guidance");
    state = applyContextUsage(state, { tokens: 43_000, contextWindow: 150_000 });
    state = applyAutonomySync(state, { enabled: true, ticketId: "EZE-417", continuationCount: 3 });
    state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 1, maxRepairs: 2 });

    const overview = renderStatusOverview(toSnapshot(state), T0 + 402_000);
    for (const label of ["Ejecución", "pico", "compactaciones", "reparaciones", "Verificación"]) {
      assert.ok(overview.includes(label), `overview is missing ${label}:\n${overview}`);
    }
    for (const english of ["Run", "peak", "compactions", "repairs", "done"]) {
      assert.equal(overview.includes(english), false, `overview still leaks ${english}:\n${overview}`);
    }
  });

  it("renders the detailed report rows in Spanish while keeping telemetry", () => {
    let state = applyContextUsage(createState(T0), { tokens: 34_000, contextWindow: 200_000 });
    state = applyContextGovernorSync(state, {
      zone: "pressure",
      currentTokens: 34_000,
      compactAtTokens: 120_000,
      ceilingTokens: 150_000,
      compactPending: false,
      compacting: false,
      compactionCount: 1,
      oversizedResults: 2,
    });
    const report = renderStatusReport(toSnapshot(state), T0);

    for (const label of [
      "pico",
      "compactaciones",
      "llamadas",
      "lecturas",
      "motivo de parada",
      "herramientas activas",
      "Gobernador de contexto",
      "Proceso principal",
      "Resultados de herramientas",
      "Entorno de ejecución",
      "zona",
      "compactar en",
      "techo",
      "pendiente",
      "compactando",
      "sobredimensionados",
    ]) {
      assert.ok(report.includes(label), `detail report is missing ${label}:\n${report}`);
    }

    // The exact English labels this task removes must never come back.
    for (const english of [
      "Context governor",
      "Resultados de tools",
      "compact at",
      "ceiling",
      "oversized",
      "Padre",
      "Runtime",
      "reads",
      "chars",
      "current",
      "pending",
      "compacting",
      "compactions",
      "zone",
    ]) {
      assert.equal(report.includes(english), false, `detail report still leaks ${english}:\n${report}`);
    }
    assert.match(report, /AIES — estado de la sesión/u);
    assert.match(report, /Mide, no gobierna/u);
  });

  it("renders the ticket verdict in Spanish without a raw NONE", () => {
    let state = ticketState("EZE-417", "In Progress", "Implement first-run guidance");
    state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });
    state = applyTicketObservationSync(state, { active: true, identifier: "EZE-417", status: "In Progress", title: "Implement first-run guidance", validVerify: true });

    const report = renderStatusReport(toSnapshot(state), T0);
    assert.ok(report.includes("PASS (válido)"), report);
    assert.equal(report.includes("PASS (valid)"), false, report);
    assert.equal(report.includes("NONE"), false, report);
  });

  it("renders a Spanish absent verification state instead of NONE", () => {
    const report = renderStatusReport(toSnapshot(ticketState("EZE-417", "In Progress", "Implement first-run guidance")), T0);
    assert.ok(report.includes("sin verificar"), report);
    assert.equal(report.includes("NONE"), false, report);
  });

  it("never leaks a raw child summary into the finished card or the durable entry", () => {
    const leaked = "raw child summary that must never reach the default UI";
    const finished = { role: "worker", task: "", startedAt: T0, finishedAt: T0 + 5_000, outcome: "done", summary: leaked };

    const card = renderActivityCard(finished, "IDLE", T0 + 5_000);
    assert.equal(card.join("\n").includes(leaked), false, card.join("\n"));
    assert.deepEqual(card, ["✓ Worker · 00:05"]);

    const entry = renderActivityEntry(finished);
    assert.equal(entry.includes(leaked), false, entry);
    assert.equal(entry, "✓ Worker · 00:05");
  });

  it("offers the two exact Spanish approval choices", () => {
    assert.deepEqual(approvalOptions(), ["Permitir una vez", "Denegar"]);
    const prompt = renderApprovalPrompt({ action: "Instalar dependencia", detail: "pnpm add zod" });
    assert.equal(prompt.title, "AIES necesita permiso");
    assert.match(prompt.message, /Instalar dependencia/u);
  });

  it("reports a user denial with the exact Spanish reason", async () => {
    const selection = await handlePermissionGate(
      { action: "ask", prompt: "Instalar dependencia" },
      { hasUI: true, ui: { select: async () => "Denegar" } },
    );
    assert.equal(selection.allowed, false);
    assert.equal(selection.reason, "Operación rechazada por el usuario.");

    const confirmation = await handlePermissionGate(
      { action: "ask", prompt: "Instalar dependencia" },
      { hasUI: true, ui: { confirm: async () => false } },
    );
    assert.equal(confirmation.allowed, false);
    assert.equal(confirmation.reason, "Operación rechazada por el usuario.");
  });
});
