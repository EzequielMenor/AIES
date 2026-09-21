/**
 * AIES-010B T3: quiet AIES plumbing and agent-centered tool presentation.
 *
 * Drives the real `renderCall`/`renderResult` projections of `aies_ticket` and
 * `aies_delegate` directly, with the theme and render context Pi provides. No Pi
 * runtime, no model, no terminal. Execution is exercised separately to prove the
 * presentation-only hooks changed nothing the model receives.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const plainTheme = { fg: (_color, value) => value, bold: (value) => value };

/** Records the semantic colors a row asked for, so "not an error" is provable. */
function recordingTheme() {
  const colors = [];
  return {
    colors,
    fg(color, value) {
      colors.push(color);
      return value;
    },
    bold(value) {
      return value;
    },
  };
}

/** Pi's render context: args plus the flags and shared row-local state Pi passes. */
function context(args = {}, overrides = {}) {
  return {
    args,
    toolCallId: "call-1",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    ...overrides,
  };
}

function mount(component, width = 120) {
  assert.ok(component && typeof component.render === "function", "a renderer must return a Component");
  assert.equal(typeof component.invalidate, "function", "a Component must implement invalidate()");
  return component.render(width);
}

function text(component, width = 120) {
  return mount(component, width).join("\n");
}

function emptyTicketManager() {
  return { getActiveTicket: () => undefined, getWorkState: () => "idle" };
}

/** A manager whose terminal actions succeed, so `execute` reaches the success path. */
function terminalTicketManager(overrides = {}) {
  return {
    getActiveTicket: () => ({ identifier: "EZE-428" }),
    getWorkState: () => "complete",
    completeTicket: async () => ({ ok: true, message: "Ticket EZE-428 marked Done in Linear." }),
    blockTicket: async () => ({ ok: true, message: "Ticket EZE-428 marked blocked: waiting on design." }),
    ...overrides,
  };
}

describe("aies_ticket presentation", () => {
  const tool = createTicketTool(emptyTicketManager());

  it("shows one short pending line while the operation is in flight", () => {
    const call = tool.renderCall(
      { action: "load", ticketId: "EZE-422" },
      plainTheme,
      context({ action: "load", ticketId: "EZE-422" }, { isPartial: true, executionStarted: false }),
    );
    assert.equal(text(call), "⟳ EZE-422 · cargando…");
  });

  it("shows the pending line from the result slot too, without a ticket id", () => {
    const row = text(
      tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: true }, plainTheme, context({ action: "start" })),
    );
    assert.equal(row, "⟳ Linear · iniciando…");
  });

  it("settles load into one compact success row and hides the call chrome", () => {
    const result = {
      content: [{ type: "text", text: "Ticket EZE-422 loaded." }],
      details: { ticket: { identifier: "EZE-422" }, workState: "loaded", result: { ok: true } },
    };
    const ctx = context({ action: "load", ticketId: "EZE-422" });
    assert.deepEqual(mount(tool.renderCall({ action: "load", ticketId: "EZE-422" }, plainTheme, ctx)), []);
    assert.equal(
      text(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, ctx)),
      "✓ EZE-422 · cargado",
    );
  });

  it("settles the non-terminal actions into compact rows without the contract", () => {
    const cases = [
      ["start", "iniciado"],
      ["refresh", "actualizado"],
      ["comment", "comentado"],
      ["show", "mostrado"],
    ];
    for (const [action, done] of cases) {
      const result = {
        content: [{ type: "text", text: `raw contract output for ${action}` }],
        details: {
          ticket: { identifier: "EZE-7", title: "TÍTULO SECRETO", description: "DESCRIPCIÓN SECRETA" },
          workState: "loaded",
        },
      };
      const row = text(
        tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action, ticketId: "EZE-7" })),
      );
      assert.match(row, /EZE-7/u);
      assert.ok(row.includes(done), row);
      assert.equal(row.includes("SECRETO"), false, `the collapsed row must not print the contract: ${row}`);
      assert.equal(row.includes("raw contract"), false, `the collapsed row must not print visible prose: ${row}`);
    }
  });

  it("never collapses a raw directive or replay payload into a successful Linear row", () => {
    const result = {
      content: [{ type: "text", text: "Ticket EZE-500 loaded." }],
      details: {
        ticket: { identifier: "EZE-500" },
        workState: "loaded",
        // A success path can still carry the transport's own replay bookkeeping.
        result: { ok: true, directive: { tool: "get_issue", args: { id: "EZE-500" }, key: "linear:get_issue" } },
      },
    };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action: "load", ticketId: "EZE-500" })),
    );
    assert.equal(row, "✓ EZE-500 · cargado");
    for (const raw of ["directive", "get_issue", "linear:get_issue", "{"]) {
      assert.equal(row.includes(raw), false, `raw plumbing ${raw} leaked into: ${row}`);
    }
  });

  it("treats remote_required as a compact Linear handoff, not an error dump", () => {
    const theme = recordingTheme();
    const result = {
      content: [{ type: "text", text: "Linear requires an MCP call: mcp({ tool: 'get_issue', args: {} })" }],
      details: {
        error: "remote_required",
        directive: { server: "linear", tool: "get_issue", args: {}, key: "linear:get_issue" },
      },
    };
    // The host does not set isError for a returned flag, so details.error is the signal.
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, theme, context({ action: "load", ticketId: "EZE-422" })),
    );
    assert.equal(row, "→ Linear · get_issue");
    assert.deepEqual(theme.colors, ["accent"], "the handoff must not be painted as an error");
  });

  it("falls back to a plain Linear handoff when no directive tool is available", () => {
    const result = { content: [{ type: "text", text: "remote" }], details: { error: "remote_required" } };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action: "refresh" })),
    );
    assert.equal(row, "→ Linear");
  });

  it("keeps the full directive content reachable when remote_required is expanded", () => {
    const full = "Linear requires an MCP call.\nmcp({ tool: 'get_issue', args: { id: 'EZE-422' } })";
    const result = {
      content: [{ type: "text", text: full }],
      details: { error: "remote_required", directive: { tool: "get_issue" } },
    };
    const expanded = text(
      tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context({ action: "load", ticketId: "EZE-422" })),
    );
    assert.equal(expanded, full);
  });

  it("names the ticket in a visible error when details carry it", () => {
    const result = {
      content: [{ type: "text", text: "Linear MCP is unavailable." }],
      details: { error: "mcp_unavailable", ticket: { identifier: "EZE-9" } },
    };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action: "complete" })),
    );
    assert.equal(row, "✗ EZE-9 · MCP no disponible");
    assert.equal(row.includes("mcp_unavailable"), false, `the raw error code must not leak: ${row}`);
  });

  it("keeps a real ticket error visible when collapsed", () => {
    const theme = recordingTheme();
    const result = {
      content: [{ type: "text", text: "Error: ticketId parameter is required for action 'load'." }],
      details: { error: "missing_ticket_id" },
    };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, theme, context({ action: "load" })),
    );
    assert.match(row, /✗/u);
    assert.ok(row.includes("falta el ID del ticket"), row);
    assert.equal(row.includes("missing_ticket_id"), false, `the raw error code must not leak: ${row}`);
    assert.deepEqual(theme.colors, ["error"]);
  });

  it("maps every known Linear error code to a concise Spanish phrase", () => {
    const known = {
      missing_ticket_id: "falta el ID del ticket",
      missing_evidence: "falta la evidencia",
      missing_comment: "falta el comentario",
      empty_comment: "el comentario está vacío",
      invalid_id: "ID de ticket inválido",
      unsupported_action: "acción no soportada",
      mcp_unavailable: "MCP no disponible",
      auth_unavailable: "autenticación requerida",
      network_failure: "falló la red",
      permission_denied: "sin permisos",
      not_found: "ticket no encontrado",
      invalid_remote_payload: "respuesta inválida de Linear",
      invalid_transition: "transición inválida",
      remote_conflict: "conflicto remoto",
      no_pending_remote: "sin operación pendiente",
      no_active_ticket: "no hay ticket activo",
      ticket_in_progress: "otro ticket en curso",
      verify_gate_denied: "verificación denegada",
      sync_error: "error de sincronización",
      comment_failed: "no se pudo comentar",
      refresh_failed: "no se pudo actualizar",
    };
    for (const [code, phrase] of Object.entries(known)) {
      const result = { content: [{ type: "text", text: `raw internal detail for ${code}` }], details: { error: code } };
      const row = text(
        tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action: "load", ticketId: "EZE-1" })),
      );
      assert.equal(row, `✗ EZE-1 · ${phrase}`, `code ${code} rendered ${row}`);
      assert.equal(row.includes(code), false, `raw code ${code} leaked into: ${row}`);
    }
  });

  it("falls back to a safe Spanish phrase for an unknown error code", () => {
    const result = {
      content: [{ type: "text", text: "kaboom: unhandled internal failure" }],
      details: { error: "kaboom_internal_999" },
    };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action: "complete", ticketId: "EZE-3" })),
    );
    assert.equal(row, "✗ EZE-3 · falló la operación");
    assert.equal(row.includes("kaboom_internal_999"), false, `the raw code must not leak: ${row}`);
    assert.equal(row.includes("unhandled internal failure"), false, `the internal detail must not leak: ${row}`);
  });

  it("keeps an expanded ticket error byte-identical", () => {
    const full = "Ticket operation 'load' failed: missing_ticket_id";
    const result = { content: [{ type: "text", text: full }], details: { error: "missing_ticket_id" } };
    const expanded = text(
      tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context({ action: "load" })),
    );
    assert.equal(expanded, full);
  });

  it("exposes the complete original content only when expanded", () => {
    const full = "Active Ticket [workState: loaded]:\n\n- [ ] Criterio uno\n- [ ] Criterio dos";
    const result = { content: [{ type: "text", text: full }], details: { active: false } };
    const expanded = text(
      tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context({ action: "show", ticketId: "EZE-422" })),
    );
    assert.equal(expanded, full);
  });

  it("hides Linear chrome for 'show' without an active ticket", () => {
    const result = {
      content: [{ type: "text", text: "No Linear ticket currently active in this session." }],
      details: { active: false },
    };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action: "show" })),
    );
    assert.equal(row, "Linear · sin ticket activo");
  });
});

describe("aies_ticket terminal ownership", () => {
  it("hides the collapsed success row for complete and block (the runtime card owns the surface)", () => {
    const tool = createTicketTool(emptyTicketManager());
    for (const action of ["complete", "block"]) {
      const result = {
        content: [{ type: "text", text: "raw success text" }],
        details: { ticket: { identifier: "EZE-428" }, workState: "complete", result: { ok: true } },
      };
      assert.deepEqual(
        mount(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action, ticketId: "EZE-428" }))),
        [],
        `${action} must not render a second success row`,
      );
    }
  });

  it("never hides a complete/block error row", () => {
    const tool = createTicketTool(emptyTicketManager());
    for (const action of ["complete", "block"]) {
      const result = {
        content: [{ type: "text", text: "raw failure" }],
        details: { error: "verify_gate_denied", ticket: { identifier: "EZE-428" } },
      };
      const row = text(
        tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ action, ticketId: "EZE-428" })),
      );
      assert.match(row, /✗/u);
      assert.ok(row.includes("verificación denegada"), row);
    }
  });

  it("never hides the expanded complete/block output", () => {
    const tool = createTicketTool(emptyTicketManager());
    for (const action of ["complete", "block"]) {
      const full = `Ticket EZE-428 ${action} full output`;
      const result = { content: [{ type: "text", text: full }], details: { result: { ok: true } } };
      const expanded = text(
        tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context({ action, ticketId: "EZE-428" })),
      );
      assert.equal(expanded, full);
    }
  });

  it("keeps an unexpected host error visible for complete and block", () => {
    const tool = createTicketTool(emptyTicketManager());
    for (const action of ["complete", "block"]) {
      // Pi wraps a thrown tool error as `details: {}` with render context `isError: true`.
      const result = { content: [{ type: "text", text: "host error" }], details: {} };
      const theme = recordingTheme();
      const row = text(
        tool.renderResult(
          result,
          { expanded: false, isPartial: false },
          theme,
          context({ action, ticketId: "EZE-428" }, { isError: true }),
        ),
      );
      assert.match(row, /✗/u);
      assert.ok(row.includes("EZE-428"), row);
      assert.deepEqual(theme.colors, ["error"]);
      assert.equal(row.includes("host error"), false, `the collapsed error must stay bounded: ${row}`);
    }
  });

  it("tells the Parent to end the turn after a successful complete", async () => {
    const tool = createTicketTool(terminalTicketManager());
    const res = await tool.execute("1", { action: "complete", evidence: "verified" }, undefined, undefined, {
      cwd: "/repo",
      mode: "print",
    });
    assert.equal(res.isError, false);
    const message = res.content[0].text;
    // The original model-visible message is preserved.
    assert.ok(message.includes("Ticket EZE-428 marked Done in Linear."), message);
    // The stop instruction is explicit about same-turn prose ownership.
    assert.match(message, /end the turn/i);
    assert.match(message, /no user-facing/i);
    assert.match(message, /prose/i);
    assert.match(message, /DONE\/BLOCKED/);
    // Structured semantics are untouched.
    assert.equal(res.details.result.ok, true);
    assert.equal(res.details.result.message, "Ticket EZE-428 marked Done in Linear.");
  });

  it("tells the Parent to end the turn after a successful block", async () => {
    const tool = createTicketTool(terminalTicketManager());
    const res = await tool.execute("1", { action: "block", evidence: "waiting" }, undefined, undefined, {
      cwd: "/repo",
      mode: "print",
    });
    assert.equal(res.isError, false);
    const message = res.content[0].text;
    assert.match(message, /end the turn/i);
    assert.match(message, /prose/i);
    assert.equal(res.details.result.ok, true);
  });

  it("never appends the stop instruction to a failed complete/block", async () => {
    const tool = createTicketTool({
      getActiveTicket: () => ({ identifier: "EZE-428" }),
      getWorkState: () => "working",
      completeTicket: async () => ({
        ok: false,
        error: "verify_gate_denied",
        message: "Done Gate DENIED: no verification run.",
      }),
    });
    const res = await tool.execute("1", { action: "complete" }, undefined, undefined, { cwd: "/repo", mode: "print" });
    assert.equal(res.isError, true);
    assert.equal(/end the turn/i.test(res.content[0].text), false, res.content[0].text);
  });
});

describe("aies_delegate presentation", () => {
  const tool = createDelegateTool();

  it("shows a short role line before the activity card exists, never the task", () => {
    const args = { role: "worker", task: "Implement the secret feature in src/secret.ts" };
    const row = text(tool.renderCall(args, plainTheme, context(args, { executionStarted: false, isPartial: true })));
    assert.match(row, /Worker/u);
    assert.equal(row.includes("secret feature"), false, `the collapsed row must not leak the task: ${row}`);
    assert.equal(row.includes("src/secret.ts"), false, `the collapsed row must not leak paths: ${row}`);
  });

  it("hides the settled call chrome once execution started (the card owns the surface)", () => {
    const args = { role: "worker", task: "Implement it" };
    assert.deepEqual(mount(tool.renderCall(args, plainTheme, context(args, { executionStarted: true, isPartial: true }))), []);
  });

  it("shows a short role line while streaming", () => {
    const args = { role: "verify", task: "Check the secret criteria" };
    const row = text(
      tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: true }, plainTheme, context(args)),
    );
    assert.match(row, /Verify/u);
    assert.equal(row.includes("Check the secret criteria"), false, `the running row must not repeat the task: ${row}`);
  });

  it("hides the collapsed success entirely", () => {
    const args = { role: "worker", task: "Implement it" };
    const result = {
      content: [{ type: "text", text: "WORKER HANDOFF change: src/a.ts summary: done" }],
      details: { status: "done", summary: "done", changes: [{ file: "src/a.ts" }], checks: [] },
    };
    assert.deepEqual(
      mount(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context(args))),
      [],
    );
  });

  it("keeps a child failure visible when collapsed, without the raw handoff", () => {
    const args = { role: "worker", task: "Implement it" };
    const result = {
      content: [{ type: "text", text: "WORKER HANDOFF summary: could not finish" }],
      details: { status: "failed", summary: "could not finish", changes: [] },
    };
    const row = text(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context(args)));
    assert.match(row, /✗/u);
    assert.match(row, /Worker/u);
    assert.equal(row.includes("WORKER HANDOFF"), false, `the collapsed error must not dump the handoff: ${row}`);
  });

  it("keeps a rejected verify request visible when collapsed", () => {
    const args = { role: "verify", task: "Check it" };
    const result = { content: [{ type: "text", text: "Verify request rejected: criteria are required." }] };
    const row = text(tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context(args)));
    assert.match(row, /✗/u);
    assert.match(row, /Verify/u);
  });

  it("keeps a blocked child visible and an unknown host error visible", () => {
    const blocked = {
      content: [{ type: "text", text: "VERIFY HANDOFF status: blocked" }],
      details: { status: "blocked", defects: [{ severity: "blocking" }] },
    };
    const blockedRow = text(
      tool.renderResult(blocked, { expanded: false, isPartial: false }, plainTheme, context({ role: "verify" })),
    );
    assert.match(blockedRow, /bloqueado/u);
    assert.match(blockedRow, /Verify/u);

    const thrown = { content: [{ type: "text", text: "child session crashed" }], details: undefined };
    const thrownRow = text(
      tool.renderResult(thrown, { expanded: false, isPartial: false }, plainTheme, context({ role: "explore" }, { isError: true })),
    );
    assert.match(thrownRow, /✗/u);
    assert.match(thrownRow, /Explore/u);
    assert.equal(thrownRow.includes("child session crashed"), false, `the collapsed error must stay concise: ${thrownRow}`);
  });

  it("never leaks a raw delegate error code into the collapsed row", () => {
    const result = {
      content: [{ type: "text", text: "internal failure: some_internal_code" }],
      details: { error: "some_internal_code" },
    };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ role: "worker" })),
    );
    assert.equal(row, "✗ Worker · falló la operación");
    assert.equal(row.includes("some_internal_code"), false, `the raw code must not leak: ${row}`);
    assert.equal(row.includes("internal failure"), false, `the internal detail must not leak: ${row}`);
  });

  it("prefers the structured status over a delegate error code", () => {
    const failed = { content: [{ type: "text", text: "raw" }], details: { status: "failed", error: "some_internal_code" } };
    const failedRow = text(
      tool.renderResult(failed, { expanded: false, isPartial: false }, plainTheme, context({ role: "worker" })),
    );
    assert.equal(failedRow, "✗ Worker · falló");

    const blocked = { content: [{ type: "text", text: "raw" }], details: { status: "blocked", error: "some_internal_code" } };
    const blockedRow = text(
      tool.renderResult(blocked, { expanded: false, isPartial: false }, plainTheme, context({ role: "verify" })),
    );
    assert.equal(blockedRow, "✗ Verify · bloqueado");
  });

  it("presents a verify protocol error as its own Spanish fault, never a domain BLOCKED", () => {
    const result = {
      content: [{ type: "text", text: "⚠ Verificación: error de protocolo (missing_completion)." }],
      details: { kind: "protocol_error", code: "missing_completion", message: "the verify child produced no completion" },
    };
    const row = text(
      tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ role: "verify" }, { isError: true })),
    );
    assert.match(row, /error de protocolo/u);
    assert.equal(row.includes("bloqueado"), false, `a protocol error must not read as BLOCKED: ${row}`);
    assert.equal(row.includes("missing_completion"), false, `the raw internal code must not leak: ${row}`);
  });

  it("tells the Parent not to auto-retry a protocol fault", () => {
    const guidelines = (tool.promptGuidelines ?? []).join("\n").toLowerCase();
    assert.match(guidelines, /protocol/);
    assert.match(guidelines, /retry/);
  });

  it("exposes the complete handoff only when expanded", () => {
    const full = "WORKER HANDOFF\nstatus: done\nchanges:\n  - src/secret.ts\nsummary: implemented everything";
    const result = { content: [{ type: "text", text: full }], details: { status: "done", changes: [{ file: "src/secret.ts" }] } };
    const expanded = text(
      tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context({ role: "worker" })),
    );
    assert.equal(expanded, full);
  });
});

describe("collapsed rows never leak the internal contract", () => {
  it("keeps handoffs, paths, criteria and summaries out of every collapsed row", () => {
    const ticketTool = createTicketTool(emptyTicketManager());
    const delegateTool = createDelegateTool();
    const secrets = [
      "WORKER HANDOFF",
      "VERIFY HANDOFF",
      "EXPLORE HANDOFF",
      "src/secret.ts",
      "Criterio secreto",
      "Acceptance Criteria",
      "DESCRIPCIÓN SECRETA",
    ];

    const collapsed = [];
    collapsed.push(
      text(ticketTool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: true }, plainTheme, context({ action: "load" }))),
    );
    collapsed.push(
      text(
        ticketTool.renderResult(
          { content: [{ type: "text", text: "contract with Criterio secreto" }], details: { ticket: { identifier: "EZE-1", description: "DESCRIPCIÓN SECRETA" } } },
          { expanded: false, isPartial: false },
          plainTheme,
          context({ action: "show", ticketId: "EZE-1" }),
        ),
      ),
    );
    collapsed.push(
      text(
        ticketTool.renderResult(
          { content: [{ type: "text", text: "mcp call needed" }], details: { error: "remote_required", directive: { tool: "get_issue" } } },
          { expanded: false, isPartial: false },
          plainTheme,
          context({ action: "load", ticketId: "EZE-1" }),
        ),
      ),
    );
    collapsed.push(
      text(
        delegateTool.renderResult(
          { content: [{ type: "text", text: "WORKER HANDOFF summary: Criterio secreto at src/secret.ts" }], details: { status: "done" } },
          { expanded: false, isPartial: false },
          plainTheme,
          context({ role: "worker" }),
        ),
      ),
    );
    collapsed.push(
      text(
        delegateTool.renderResult(
          { content: [{ type: "text", text: "VERIFY HANDOFF with criteria and src/secret.ts" }], details: { status: "failed" } },
          { expanded: false, isPartial: false },
          plainTheme,
          context({ role: "verify" }),
        ),
      ),
    );

    for (const row of collapsed) {
      for (const secret of secrets) {
        assert.equal(row.includes(secret), false, `"${secret}" leaked into: ${row}`);
      }
    }
  });
});

describe("presentation hooks do not change execution", () => {
  it("returns the same ticket content/details/isError on the non-navigating paths", async () => {
    const tool = createTicketTool(emptyTicketManager());
    const ctx = { cwd: "/repo", mode: "print" };

    assert.deepEqual(await tool.execute("1", { action: "load" }, undefined, undefined, ctx), {
      content: [{ type: "text", text: "Error: ticketId parameter is required for action 'load'." }],
      details: { error: "missing_ticket_id" },
      isError: true,
    });

    const missingEvidence = await tool.execute("2", { action: "block" }, undefined, undefined, ctx);
    assert.equal(missingEvidence.details.error, "missing_evidence");
    assert.equal(missingEvidence.isError, true);

    const missingComment = await tool.execute("3", { action: "comment" }, undefined, undefined, ctx);
    assert.equal(missingComment.details.error, "missing_comment");
    assert.equal(missingComment.isError, true);

    assert.deepEqual(await tool.execute("4", { action: "show" }, undefined, undefined, ctx), {
      content: [
        {
          type: "text",
          text: "No Linear ticket currently active in this session. Use action 'load' with a ticketId to activate one.",
        },
      ],
      details: { active: false },
      isError: false,
    });
  });

  it("keeps the delegate verify rejection byte-identical", async () => {
    const tool = createDelegateTool();
    const result = await tool.execute("1", { role: "verify", task: "Check it" }, undefined, undefined, { cwd: "/repo", mode: "print" });

    assert.equal(result.isError, true);
    assert.equal(result.details, undefined);
    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text, /^Verify request rejected: /u);
  });

  it("does not mutate the result it renders", () => {
    const tool = createDelegateTool();
    const result = { content: [{ type: "text", text: "handoff" }], details: { status: "done", changes: [{ file: "a.ts" }] } };
    const snapshot = JSON.stringify(result);

    tool.renderResult(result, { expanded: true, isPartial: false }, plainTheme, context({ role: "worker" }));
    tool.renderResult(result, { expanded: false, isPartial: false }, plainTheme, context({ role: "worker" }));

    assert.equal(JSON.stringify(result), snapshot, "a renderer must never rewrite model content");
  });

  it("never reaches the conversation from a renderer", () => {
    for (const file of ["extensions/aies-agents/linear/tool.ts", "extensions/aies-agents/delegate.ts"]) {
      const source = readFileSync(`${REPO}/${file}`, "utf8");
      assert.equal(source.includes("sendMessage"), false, `${file} must not send messages`);
      assert.equal(source.includes("sendUserMessage"), false, `${file} must not send user messages`);
    }
  });
});
