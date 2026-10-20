/**
 * D33 phase 3: `tracker: "plane"` in an isolated `aies.json` selects Plane end to end.
 *
 * No `selectTracker` is injected: the manager reads `$PI_CODING_AGENT_DIR/aies.json`
 * itself, exactly as the runtime does. The profile is a temporary directory of this
 * test, never the real one, and no remote call is made: the Plane answer is a fixture.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { HostMediatedPlaneTransport } from "../extensions/aies-agents/linear/plane-transport.ts";
import { createVerificationState } from "../extensions/aies-agents/verification.ts";
import { PLANE_PROJECT, planeWorkItem } from "./helpers/plane-fixtures.mjs";

/** The `mcp` proxy answer the adapter returns: a JSON text part. */
function mcpAnswer(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

describe("D33 phase 3: tracker selection from aies.json, end to end", () => {
  let savedAgentDir;
  let agentDir;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "aies-plane-select-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  function writeAiesConfig(content) {
    writeFileSync(join(agentDir, "aies.json"), JSON.stringify(content));
  }

  it("tracker plane selects the Plane transport: the load asks for the plane retrieve, and the answer activates a plane ticket", async () => {
    writeAiesConfig({ tracker: "plane" });
    const manager = new TicketManager({ getVerification: () => createVerificationState() });

    const first = await manager.loadTicket("AIES-38");
    assert.equal(first.error, "remote_required");
    assert.equal(first.directive.server, "plane");
    assert.equal(first.directive.tool, "workitem");
    assert.equal(first.directive.args.action, "retrieve_by_identifier");
    assert.equal(first.directive.args.workitem_identifier, "AIES-38");
    assert.ok(manager.getTransport() instanceof HostMediatedPlaneTransport);

    const loaded = await manager.submitRemote(mcpAnswer(planeWorkItem({ sequence: 38 })));
    assert.equal(loaded.ok, true, loaded.message);
    assert.equal(loaded.ticket.identifier, "AIES-38");
    assert.equal(loaded.ticket.tracker, "plane");
    assert.equal(loaded.ticket.team, PLANE_PROJECT.id, "the project UUID is kept as an internal field");
    assert.equal(manager.toSnapshot().tracker, "plane");
  });

  it("the same profile without the tracker key selects Linear, which asks for the Linear call", async () => {
    writeAiesConfig({});
    const manager = new TicketManager({ getVerification: () => createVerificationState() });
    const result = await manager.loadTicket("EZE-101");
    assert.equal(result.error, "remote_required");
    assert.equal(result.directive.server, "linear");
    assert.equal(result.directive.tool, "get_issue");
  });

  it("an absent aies.json selects Linear", async () => {
    const manager = new TicketManager({ getVerification: () => createVerificationState() });
    const result = await manager.loadTicket("EZE-101");
    assert.equal(result.directive.server, "linear");
  });

  it("an unknown tracker fails closed with no remote call", async () => {
    writeAiesConfig({ tracker: "jira" });
    const manager = new TicketManager({ getVerification: () => createVerificationState() });
    const result = await manager.loadTicket("AIES-38");
    assert.equal(result.ok, false);
    assert.equal(result.error, "tracker_unknown");
    assert.equal(result.directive, undefined);
    assert.equal(manager.getPendingDirective(), null);
  });

  it("switching the profile to Linear while a plane ticket is active fails closed, with no remote call", async () => {
    writeAiesConfig({ tracker: "plane" });
    const manager = new TicketManager({ getVerification: () => createVerificationState() });
    await manager.loadTicket("AIES-38");
    await manager.submitRemote(mcpAnswer(planeWorkItem({ sequence: 38 })));
    assert.equal(manager.getActiveTicket().tracker, "plane");

    writeAiesConfig({ tracker: "linear" });
    const refused = await manager.completeTicket();
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "tracker_mismatch");
    assert.equal(refused.directive, undefined);
    assert.equal(manager.getPendingDirective(), null);
    assert.equal(manager.getActiveTicket().identifier, "AIES-38");
    assert.equal(manager.getWorkState(), "loaded");
  });
});
