/**
 * EZE-490: deterministic capture of the `mcp` proxy result.
 *
 * The remote Linear payload must never be reconstructed textually by the Parent
 * LLM (the lossy path that dropped the acceptance section in EZE-488). Instead the
 * `tool_result` handler captures the raw `mcp` result and resumes the pending
 * operation through `TicketManager.captureRemote`. These tests exercise that seam
 * directly on the manager, with the exact event input shape (`{ server, tool, args }`)
 * and content array the handler forwards, plus the manual `remote` fallback guards.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { extractAcceptanceCriteria } from "../extensions/aies-agents/linear/contract.ts";
import { createVerificationState } from "../extensions/aies-agents/verification.ts";

const mediatedManager = () =>
  new TicketManager({ getVerification: () => createVerificationState() });

/** Wrap a payload the way the `mcp` proxy tool reports it back as tool content. */
function mcpContent(payload) {
  return [{ type: "text", text: JSON.stringify(payload) }];
}

/** Drive the mediated load to its `remote_required` directive. */
async function pendingLoad(manager, ticketId) {
  const first = await manager.loadTicket(ticketId);
  assert.equal(first.ok, false);
  assert.equal(first.error, "remote_required");
  assert.equal(first.directive.tool, "get_issue");
  return first.directive;
}

describe("EZE-490: automatic capture of the mcp Linear result", () => {
  const issue = {
    id: "EZE-490",
    identifier: "EZE-490",
    uuid: "767a81fb-454e-4656-94b7-cf5319a509e6",
    title: "Capturar el resultado de mcp sin reconstrucción del LLM",
    description: "Objetivo del ticket.\n\n## Aceptación\n\n- [ ] descripción > 4 KB preservada íntegra\n- [ ] la sección `## Aceptación` al final se extrae sin perder criterios\n- [ ] unicode y español conservados (áéíóú, ñ, ¿?)",
    status: "Todo",
    statusType: "unstarted",
    stateHistory: [{ state: { id: "state-todo", name: "Todo", type: "unstarted" }, endedAt: null }],
    project: { id: "p-1", name: "AIES" },
    labels: [{ id: "l-1", name: "bug" }, "linear"],
    team: "Eze",
    url: "https://linear.app/aies/issue/EZE-490",
  };

  it("loads a small ticket through capture without a second aies_ticket call", async () => {
    const manager = mediatedManager();
    const directive = await pendingLoad(manager, "EZE-490");

    assert.equal(manager.getPendingRemoteKey(), directive.key);

    const resumed = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      mcpContent(issue),
    );

    assert.ok(resumed, "a matching mcp result must resume the pending operation");
    assert.equal(resumed.ok, true);
    assert.equal(manager.getActiveTicket().identifier, "EZE-490");
    assert.equal(manager.getPendingDirective(), null, "capture must clear the pending remote");
  });

  it("returns null and leaves the operation untouched when no remote is pending", async () => {
    const manager = mediatedManager();
    const result = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      mcpContent(issue),
    );
    assert.equal(result, null);
    assert.equal(manager.getActiveTicket(), null);
  });

  it("returns null when the mcp call does not match the pending directive", async () => {
    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");

    const mismatched = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "OTHER-1" } },
      mcpContent({ ...issue, identifier: "OTHER-1", id: "OTHER-1" }),
    );
    assert.equal(mismatched, null, "an unrelated mcp call must not consume the pending directive");
    assert.equal(manager.getPendingRemoteKey(), 'linear:get_issue(id="EZE-490")');
  });

  it("preserves a > 4 KB description byte-for-byte (EZE-488 regression)", async () => {
    const filler = "Línea de contexto con acentos y ñ. ".repeat(200); // > 4 KB
    const long = {
      ...issue,
      description: `${filler}\n\n## Aceptación\n\n- [ ] criterios al final del payload se conservan`,
    };
    assert.ok(long.description.length > 4096, "fixture description must exceed 4 KB");

    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");
    const resumed = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      mcpContent(long),
    );

    assert.equal(resumed.ok, true);
    const active = manager.getActiveTicket();
    assert.equal(active.description, long.description, "the full description is preserved");
    assert.ok(
      active.acceptanceCriteria.some((c) => c.includes("criterios al final del payload se conservan")),
      "the trailing acceptance section is extracted, not lost",
    );
  });

  it("extracts the acceptance section at the very end and keeps unicode/Spanish", async () => {
    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");
    const resumed = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      mcpContent(issue),
    );

    assert.equal(resumed.ok, true);
    const active = manager.getActiveTicket();
    assert.equal(active.title, "Capturar el resultado de mcp sin reconstrucción del LLM");
    assert.deepEqual(
      active.acceptanceCriteria,
      [
        "descripción > 4 KB preservada íntegra",
        "la sección `## Aceptación` al final se extrae sin perder criterios",
        "unicode y español conservados (áéíóú, ñ, ¿?)",
      ],
    );
  });

  it("preserves relations and metadata (labels, project, team, url, state)", async () => {
    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");
    await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      mcpContent(issue),
    );

    const active = manager.getActiveTicket();
    assert.deepEqual(active.labels, ["bug", "linear"]);
    assert.equal(active.project, "AIES");
    assert.equal(active.team, "Eze");
    assert.equal(active.url, "https://linear.app/aies/issue/EZE-490");
    assert.equal(active.status, "Todo");
    assert.equal(active.statusId, "state-todo");
    assert.equal(active.statusType, "unstarted");
  });

  it("roundtrip preserves the complete extracted criteria through the contract", async () => {
    const criteria = extractAcceptanceCriteria(issue.description).criteria;
    assert.equal(criteria.length, 3);

    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");
    const resumed = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      mcpContent(issue),
    );

    assert.deepEqual(resumed.ticket.acceptanceCriteria, criteria, "nothing is dropped from the payload");
  });

  it("rejects a truncated (non-JSON) mcp answer as invalid_remote_payload, never not_found", async () => {
    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");

    // A truncated tool result: a partial JSON string that will not parse.
    const truncated = [{ type: "text", text: '{"identifier":"EZE-490","description":"long text' }];
    const resumed = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      truncated,
    );

    assert.ok(resumed);
    assert.equal(resumed.ok, false);
    assert.equal(resumed.error, "invalid_remote_payload");
    assert.equal(manager.getActiveTicket(), null, "a corrupt payload must not activate a partial ticket");
    assert.equal(manager.getPendingDirective(), null);
  });

  it("rejects an issue payload whose identity does not match the requested ticket", async () => {
    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");

    const resumed = await manager.captureRemote(
      { server: "linear", tool: "get_issue", args: { id: "EZE-490" } },
      mcpContent({ identifier: "EZE-999", id: "EZE-999", title: "wrong ticket" }),
    );

    assert.equal(resumed.ok, false);
    assert.equal(resumed.error, "invalid_remote_payload");
    assert.match(resumed.message, /does not match the requested ticket/);
    assert.equal(manager.getActiveTicket(), null);
  });

  it("fails a manual remote for a different key with remote_mismatch and keeps the pending directive", async () => {
    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");

    const wrong = await manager.submitRemote(issue, 'linear:get_issue(id="EZE-999")');
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, "remote_mismatch");
    assert.equal(
      manager.getPendingRemoteKey(),
      'linear:get_issue(id="EZE-490")',
      "a misrouted answer must not clobber the pending directive",
    );

    // The correct answer still resumes the operation afterwards.
    const ok = await manager.submitRemote(issue, manager.getPendingRemoteKey());
    assert.equal(ok.ok, true);
    assert.equal(manager.getActiveTicket().identifier, "EZE-490");
  });

  it("still accepts the manual remote fallback when capture did not fire", async () => {
    const manager = mediatedManager();
    await pendingLoad(manager, "EZE-490");
    const result = await manager.submitRemote(mcpContent(issue));
    assert.equal(result.ok, true);
    assert.equal(manager.getActiveTicket().identifier, "EZE-490");
  });
});
