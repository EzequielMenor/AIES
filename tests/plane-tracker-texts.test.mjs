/**
 * D33 phase 4, part B: the texts that name the tracker.
 *
 * A Plane ticket or a Plane server says "Plane" in the directives, the manager errors,
 * the tool and command texts, the autonomy stop codes and the human view. Linear keeps
 * every one of those texts exactly as it was, and the tests pin both sides. No network,
 * no credential, and the profile is a temporary directory of this test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { describeRemoteDirective } from "../extensions/aies-agents/linear/contract.ts";
import { configuredTrackerLabel } from "../extensions/aies-agents/linear/tracker.ts";
import { trackerLabel, trackerLabelForServer } from "../extensions/aies-agents/linear/labels.ts";
import { ticketLoadPrompt, ticketRunPrompt } from "../extensions/aies-agents/linear/prompt.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { FakeLinearTransport, mediatedAnswer } from "../extensions/aies-agents/linear/transport.ts";
import { HostMediatedPlaneTransport } from "../extensions/aies-agents/linear/plane-transport.ts";
import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import { registerTicketCommand } from "../extensions/aies-agents/linear/command.ts";
import { evaluateContinuation } from "../extensions/aies-agents/autonomy/policy.ts";
import { createRoutingState } from "../extensions/aies-agents/routing.ts";
import { getContextGovernor } from "../extensions/aies-agents/context-governor.ts";
import { createVerificationState } from "../extensions/aies-agents/verification.ts";
import { deriveTodos } from "../extensions/aies-ui/todos.ts";
import { renderDoneSummary } from "../extensions/aies-ui/summary.ts";
import { deriveStage } from "../extensions/aies-ui/vocabulary.ts";
import { blockedSentence } from "../extensions/aies-runtime/index.ts";
import { PLANE_TRACKER, LINEAR_TRACKER } from "../extensions/aies-agents/linear/tracker.ts";
import { FakePlaneTransport } from "../extensions/aies-agents/linear/plane-transport.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PLANE_SELECTION = () => ({ ok: true, tracker: PLANE_TRACKER });
const LINEAR_SELECTION = () => ({ ok: true, tracker: LINEAR_TRACKER });

function planeDirective() {
  return {
    key: "plane:workitem(action=\"retrieve_by_identifier\")",
    server: "plane",
    tool: "workitem",
    args: { action: "retrieve_by_identifier", workitem_identifier: "AIES-38", expand: "state,project" },
    purpose: "read the ticket contract",
  };
}

function linearDirective() {
  return {
    key: "linear:get_issue(id=\"EZE-101\")",
    server: "linear",
    tool: "get_issue",
    args: { id: "EZE-101" },
    purpose: "read the ticket contract",
  };
}

describe("D33 phase 4 (B): the tracker label", () => {
  it("names Plane for the plane tracker and server, and Linear for everything else", () => {
    assert.equal(trackerLabel("plane"), "Plane");
    assert.equal(trackerLabel("linear"), "Linear");
    assert.equal(trackerLabel(undefined), "Linear");
    assert.equal(trackerLabelForServer(" PLANE "), "Plane");
    assert.equal(trackerLabelForServer("linear"), "Linear");
    assert.equal(trackerLabelForServer(undefined), "Linear");
    assert.equal(trackerLabelForServer(42), "Linear");
  });
});

describe("D33 phase 4 (B): directives and transport errors", () => {
  it("names the tracker of a remote directive, and keeps Linear's text exactly", () => {
    const plane = describeRemoteDirective(planeDirective());
    assert.match(plane, /^Plane remote call required\./);
    assert.match(plane, /every Plane read/);
    assert.doesNotMatch(plane, /Linear/);

    const linear = describeRemoteDirective(linearDirective());
    assert.equal(
      linear.split("\n")[0],
      "Linear remote call required.",
    );
    assert.match(linear, /AIES does not speak MCP itself: the Parent session performs every Linear read/);
    assert.match(linear, /and write with the `mcp` proxy tool registered by pi-mcp-adapter\./);
  });

  it("labels the mediated remote_required message by tracker, with Linear as the default", () => {
    assert.throws(
      () => mediatedAnswer({}, "linear", "get_issue", { id: "EZE-1" }, "read the ticket contract"),
      (error) => error.message === "Linear remote call required: get_issue (read the ticket contract)",
    );
    assert.throws(
      () => mediatedAnswer({}, "plane", "workitem", { action: "update" }, "update the ticket workflow state", "Plane"),
      (error) => error.message === "Plane remote call required: workitem (update the ticket workflow state)",
    );
    const transport = new HostMediatedPlaneTransport({});
    return transport.getIssue("AIES-38").then(
      () => assert.fail("a call with no captured answer must ask the Parent"),
      (error) => assert.equal(error.message, "Plane remote call required: workitem (read the ticket contract)"),
    );
  });
});

describe("D33 phase 4 (B): the manager's messages name the configured tracker", () => {
  it("answers a Plane load with a Plane directive message", async () => {
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    const result = await manager.loadTicket("AIES-38");
    assert.equal(result.error, "remote_required");
    assert.equal(result.message, "Plane remote call required: workitem");
  });

  it("answers a Linear load with the unchanged Linear directive message", async () => {
    const manager = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: LINEAR_SELECTION });
    const result = await manager.loadTicket("EZE-101");
    assert.equal(result.error, "remote_required");
    assert.equal(result.message, "Linear remote call required: get_issue");
  });

  it("reports the configured tracker from the manager", () => {
    const plane = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    assert.equal(plane.trackerName(), "Plane");
    const linear = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: LINEAR_SELECTION });
    assert.equal(linear.trackerName(), "Linear");
  });
});

describe("D33 phase 4 (B): tool, command and prompt texts", () => {
  let savedAgentDir;
  let agentDir;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    agentDir = mkdtempSync(join(tmpdir(), "aies-plane-texts-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("describes the configured tracker in the tool and the command, with Linear when unset", () => {
    assert.equal(configuredTrackerLabel(), "Linear", "no aies.json means Linear");
    const linearTool = createTicketTool(new TicketManager({ getVerification: () => createVerificationState() }));
    assert.match(linearTool.description, /active Linear work unit ticket/);
    assert.match(linearTool.promptGuidelines[0], /^Linear is reached only through/);

    writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ tracker: "plane" }));
    assert.equal(configuredTrackerLabel(), "Plane");
    const planeTool = createTicketTool(new TicketManager({ getVerification: () => createVerificationState() }));
    assert.match(planeTool.description, /active Plane work unit ticket/);
    assert.doesNotMatch(planeTool.description, /Linear/);
    assert.match(planeTool.promptGuidelines[0], /^Plane is reached only through/);

    const registered = [];
    registerTicketCommand({ registerCommand: (name, command) => registered.push({ name, command }) }, new TicketManager({ getVerification: () => createVerificationState() }));
    assert.equal(registered[0].name, "aies-ticket");
    assert.match(registered[0].command.description, /Activate or show the active Plane ticket/);
  });

  it("names the tracker in the load and run prompts, with Linear as the default", () => {
    assert.equal(ticketLoadPrompt("EZE-101").startsWith("Load Linear ticket EZE-101:"), true);
    assert.equal(ticketLoadPrompt("AIES-38", "Plane").startsWith("Load Plane ticket AIES-38:"), true);
    assert.match(ticketRunPrompt("AIES-38", { label: "Plane" }), /^Start bounded autonomy on Plane ticket AIES-38:/);
    assert.match(ticketRunPrompt("EZE-101"), /^Start bounded autonomy on Linear ticket EZE-101:/);
  });
});

describe("D33 phase 4 (B): autonomy stop codes", () => {
  const autonomy = (overrides = {}) => ({
    enabled: true,
    ticketId: "AIES-38",
    continuationCount: 0,
    lastDecision: null,
    stopReason: null,
    lastFingerprint: null,
    consecutiveSameFingerprint: 0,
    pending: false,
    ...overrides,
  });

  async function loadedManager(selection, transport) {
    const manager = new TicketManager({ transport, getVerification: () => createVerificationState(), selectTracker: selection });
    return manager;
  }

  function evaluate(manager, linearError) {
    return evaluateContinuation({
      autonomy: autonomy(),
      ticketManager: manager,
      verification: createVerificationState(),
      routing: createRoutingState(),
      governor: getContextGovernor(),
      linearError,
    });
  }

  it("stops a Plane ticket with the generic tracker codes and names Plane", async () => {
    const fake = new FakePlaneTransport();
    fake.seedIssue({ identifier: "AIES-38", title: "Plane stop", state: "Todo" });
    const manager = await loadedManager(PLANE_SELECTION, fake);
    await manager.loadTicket("AIES-38");

    const conflict = evaluate(manager, "remote_conflict");
    assert.equal(conflict.stopReason, "tracker_conflict");
    assert.match(conflict.reason, /Remote conflict detected in Plane ticket/);

    const sync = evaluate(manager, "sync_error");
    assert.equal(sync.stopReason, "tracker_sync_failed");
    assert.match(sync.reason, /Plane sync failed/);
  });

  it("keeps the Linear codes and texts for a Linear ticket", async () => {
    const linear = new FakeLinearTransport([
      { id: "issue-eze-101", identifier: "EZE-101", title: "Linear stop", state: { id: "status-todo", name: "Todo", type: "unstarted" } },
    ]);
    const manager = await loadedManager(LINEAR_SELECTION, linear);
    await manager.loadTicket("EZE-101");
    const conflict = evaluate(manager, "remote_conflict");
    assert.equal(conflict.stopReason, "linear_conflict");
    assert.equal(conflict.reason, "Remote conflict detected in Linear ticket; stopping to avoid overwrite");
    const sync = evaluate(manager, "network_failure");
    assert.equal(sync.stopReason, "linear_sync_failed");
    assert.equal(sync.reason, "Implementation verified PASS but Linear sync failed; stopping without re-running code");
  });
});

describe("D33 phase 4 (B): the human view names the active tracker", () => {
  it("labels the Done card with the tracker and keeps Linear's line", () => {
    const plane = renderDoneSummary({ ticket: "AIES-38", linear: "Done", tracker: "Plane" }, { paint: undefined }).join("\n");
    assert.match(plane, /Plane ✓ Done/);
    assert.doesNotMatch(plane, /Linear/);

    const linear = renderDoneSummary({ ticket: "EZE-101", linear: "Done" }).join("\n");
    assert.match(linear, /Linear ✓ Done/);
  });

  it("labels the todo step with the tracker", () => {
    const planeSteps = deriveTodos({ ticket: { active: true, identifier: "AIES-38", tracker: "plane", workState: "complete" } }).items;
    assert.equal(planeSteps.find((step) => step.key === "linear").label, "Sincronizar Plane");
    const linearSteps = deriveTodos({ ticket: { active: true, identifier: "EZE-101", workState: "complete" } }).items;
    assert.equal(linearSteps.find((step) => step.key === "linear").label, "Sincronizar Linear");
  });

  it("treats the generic tracker stop codes as real blockers", () => {
    assert.equal(deriveStage({ autonomy: { enabled: false, stopReason: "tracker_conflict", continuationCount: 0 } }), "BLOCKED");
    assert.equal(deriveStage({ autonomy: { enabled: false, stopReason: "tracker_sync_failed", continuationCount: 0 } }), "BLOCKED");
  });

  it("writes the blocked sentences of a Plane run with Plane, and Linear's sentences unchanged", () => {
    assert.deepEqual(blockedSentence("tracker_conflict", "plane"), {
      happened: "Plane cambió de estado por fuera de AIES.",
      needs: "revisar el ticket en Plane antes de continuar.",
    });
    assert.deepEqual(blockedSentence("tracker_sync_failed", "plane"), {
      happened: "Plane no pudo sincronizarse.",
      pending: "El código está verificado y no se volverá a ejecutar.",
    });
    assert.deepEqual(blockedSentence("linear_sync_failed", undefined), {
      happened: "Linear no pudo sincronizarse.",
      pending: "El código está verificado y no se volverá a ejecutar.",
    });
    assert.deepEqual(blockedSentence("linear_conflict", "linear"), {
      happened: "Linear cambió de estado por fuera de AIES.",
      needs: "revisar el ticket en Linear antes de continuar.",
    });
  });
});

describe("D33 phase 4 (B): the skill is tracker-neutral and keeps its rules", () => {
  it("is loaded from skills/ticket-workflow with its rules, and the old directory is gone", () => {
    const skill = readFileSync(join(REPO, "skills", "ticket-workflow", "SKILL.md"), "utf8");
    assert.match(skill, /^---\nname: ticket-workflow\ndescription: .*\(Linear or Plane/m);
    assert.match(skill, /# Ticket Workflow/);
    for (const rule of ["One Active Ticket", "Exact Ticket Loading", "Acceptance Criteria", "Status Transitions", "Done Gate (Verification Enforcement)", "Compact Feedback & Zero Spam"]) {
      assert.ok(skill.includes(rule), `rule kept: ${rule}`);
    }
    assert.equal(existsSync(join(REPO, "skills", "linear-ticket")), false);
  });
});
