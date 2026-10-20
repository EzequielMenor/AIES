/**
 * D33 phase 3: the ticket lifecycle over Plane, offline, with the real Done Gate.
 *
 * load -> start -> verify PASS -> complete must behave as the Linear flow does:
 * no PASS, no completion; an explicit hold (EZE-503), no completion and no Plane
 * call; a state changed outside AIES, a remote conflict. The same lifecycle runs
 * through the mediated Parent path against the offline Plane simulator, so the
 * `remote_required` replay is exercised end to end.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { FakeLinearTransport } from "../extensions/aies-agents/linear/transport.ts";
import { FakePlaneTransport } from "../extensions/aies-agents/linear/plane-transport.ts";
import { PLANE_TRACKER } from "../extensions/aies-agents/linear/tracker.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
} from "../extensions/aies-agents/verification.ts";
import { createPlaneMcpSimulator } from "./helpers/plane-mcp-simulator.mjs";
import { planeWorkItem } from "./helpers/plane-fixtures.mjs";

const CODE_PATHS = ["extensions/aies-agents/linear/manager.ts"];
const PLANE_SELECTION = () => ({ ok: true, tracker: PLANE_TRACKER });
const LINEAR_SELECTION = () => ({ ok: true, tracker: { id: "linear", mcpServer: "linear" } });
const DESCRIPTION = "## Acceptance Criteria\n- [ ] The Done Gate holds on Plane\n";

/** Verification state after a behaviour-bearing change and a fresh PASS. */
function freshPass() {
  let state = createVerificationState();
  state = applyWorkUnitChange(state, CODE_PATHS, "worker implemented the change");
  state = applyVerifyStart(state, 1_700_000_000_000);
  return applyVerifyResult(state, { status: "pass", criteria: [] }, 1_700_000_000_100);
}

function seededPlane() {
  const fake = new FakePlaneTransport();
  fake.seedIssue({ identifier: "AIES-38", title: "Plane lifecycle", description: DESCRIPTION, state: "Todo" });
  return fake;
}

function seededLinear() {
  return new FakeLinearTransport([
    {
      id: "issue-eze-101",
      identifier: "EZE-101",
      title: "Linear lifecycle",
      description: DESCRIPTION,
      state: { id: "status-todo", name: "Todo", type: "unstarted" },
      project: { id: "proj-1", name: "AIES Core" },
    },
  ]);
}

describe("D33 phase 3: Plane lifecycle with FakePlaneTransport and the real Done Gate", () => {
  it("load -> start -> verify PASS -> complete moves the work item to Done and comments once", async () => {
    const fake = seededPlane();
    let verification = createVerificationState();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => verification,
      selectTracker: PLANE_SELECTION,
    });

    const load = await manager.loadTicket("AIES-38");
    assert.equal(load.ok, true);
    assert.equal(load.ticket.tracker, "plane");

    const start = await manager.startWork();
    assert.equal(start.ok, true);
    assert.equal(start.workState, "working");
    assert.equal((await fake.getIssue("AIES-38")).state.name, "In Progress");

    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    const complete = await manager.completeTicket();
    assert.equal(complete.ok, true, complete.message);
    assert.equal(complete.workState, "complete");
    assert.equal((await fake.getIssue("AIES-38")).state.name, "Done");
    assert.equal(fake.addedComments.length, 1);
    assert.match(fake.addedComments[0].body, /Implemented AIES-38/);
  });

  it("without a valid PASS the Done Gate denies, and Plane keeps its state", async () => {
    const fake = seededPlane();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => createVerificationState(),
      selectTracker: PLANE_SELECTION,
    });
    await manager.loadTicket("AIES-38");
    await manager.startWork();
    manager.recordChangedPaths(CODE_PATHS);

    const complete = await manager.completeTicket();
    assert.equal(complete.ok, false);
    assert.equal(complete.error, "verify_gate_denied");
    assert.equal(fake.updatedIssues.length, 1, "only the start transition was written");
    assert.equal((await fake.getIssue("AIES-38")).state.name, "In Progress");
  });

  it("an explicit hold outranks a PASS: no Plane call is made and the ticket stays open", async () => {
    const fake = seededPlane();
    let verification = createVerificationState();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => verification,
      selectTracker: PLANE_SELECTION,
    });
    await manager.loadTicket("AIES-38");
    await manager.startWork();
    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    manager.recordUserInput("no commit todavía");

    const queriedBefore = fake.queriedIdentifiers.length;
    const updatedBefore = fake.updatedIssues.length;
    const commentsBefore = fake.addedComments.length;
    const complete = await manager.completeTicket();

    assert.equal(complete.ok, false);
    assert.equal(complete.error, "pending_final_action");
    assert.equal(fake.queriedIdentifiers.length, queriedBefore, "a held completion reads nothing from Plane");
    assert.equal(fake.updatedIssues.length, updatedBefore);
    assert.equal(fake.addedComments.length, commentsBefore);
    assert.equal((await fake.getIssue("AIES-38")).state.name, "In Progress");
  });

  it("a user release lifts the hold and the same completion then reaches Done", async () => {
    const fake = seededPlane();
    let verification = createVerificationState();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => verification,
      selectTracker: PLANE_SELECTION,
    });
    await manager.loadTicket("AIES-38");
    await manager.startWork();
    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    manager.recordUserInput("quiero revisarlo antes");
    assert.equal((await manager.completeTicket()).error, "pending_final_action");

    manager.recordUserInput("ya lo revisé, podés commitear");
    const complete = await manager.completeTicket();
    assert.equal(complete.ok, true, complete.message);
    assert.equal((await fake.getIssue("AIES-38")).state.name, "Done");
  });

  it("a work item moved to Cancelled outside AIES is a remote conflict and is not overwritten", async () => {
    const fake = seededPlane();
    let verification = createVerificationState();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => verification,
      selectTracker: PLANE_SELECTION,
    });
    await manager.loadTicket("AIES-38");
    await manager.startWork();
    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    fake.moveExternally("AIES-38", "Cancelled");

    const complete = await manager.completeTicket();
    assert.equal(complete.ok, false);
    assert.equal(complete.error, "remote_conflict");
    assert.match(complete.message, /canceled externally/);
    assert.equal((await fake.getIssue("AIES-38")).state.name, "Cancelled");
  });

  it("a work item already Done outside AIES is a remote conflict", async () => {
    const fake = seededPlane();
    let verification = createVerificationState();
    const manager = new TicketManager({
      transport: fake,
      getVerification: () => verification,
      selectTracker: PLANE_SELECTION,
    });
    await manager.loadTicket("AIES-38");
    await manager.startWork();
    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    fake.moveExternally("AIES-38", "Done");

    const complete = await manager.completeTicket();
    assert.equal(complete.error, "remote_conflict");
  });

  it("the Plane lifecycle gives the same outcomes as the Linear lifecycle", async () => {
    async function lifecycle(transport, selection) {
      let verification = createVerificationState();
      const manager = new TicketManager({ transport, getVerification: () => verification, selectTracker: selection });
      const steps = {};
      steps.load = (await manager.loadTicket(transport instanceof FakeLinearTransport ? "EZE-101" : "AIES-38")).ok;
      steps.start = (await manager.startWork()).workState;
      manager.recordChangedPaths(CODE_PATHS);
      steps.deniedWithoutPass = (await manager.completeTicket()).error;
      verification = freshPass();
      const complete = await manager.completeTicket();
      steps.complete = complete.ok;
      steps.workState = complete.workState;
      return steps;
    }

    const linear = await lifecycle(seededLinear(), LINEAR_SELECTION);
    const plane = await lifecycle(seededPlane(), PLANE_SELECTION);
    assert.deepEqual(plane, linear);
    assert.deepEqual(plane, {
      load: true,
      start: "working",
      deniedWithoutPass: "verify_gate_denied",
      complete: true,
      workState: "complete",
    });
  });

  it("a Plane snapshot is refused under linear, and restored under plane", async () => {
    const fake = seededPlane();
    const planeManager = new TicketManager({
      transport: fake,
      getVerification: () => createVerificationState(),
      selectTracker: PLANE_SELECTION,
    });
    await planeManager.loadTicket("AIES-38");
    const snapshot = planeManager.toSnapshot();
    assert.equal(snapshot.tracker, "plane");

    const linearManager = new TicketManager({
      getVerification: () => createVerificationState(),
      selectTracker: LINEAR_SELECTION,
    });
    const refused = linearManager.restoreFromSnapshot(snapshot);
    assert.equal(refused.ok, false);
    assert.equal(refused.error, "tracker_mismatch");
    assert.equal(linearManager.getActiveTicket(), null);

    const restored = new TicketManager({ getVerification: () => createVerificationState(), selectTracker: PLANE_SELECTION });
    assert.equal(restored.restoreFromSnapshot(snapshot).ok, true);
    assert.equal(restored.getActiveTicket().identifier, "AIES-38");
  });
});

describe("D33 phase 3: the lifecycle through the mediated Parent path", () => {
  /** Answers every `remote_required` the way the Parent would, until the operation settles. */
  async function settle(manager, simulator, first) {
    const seen = [];
    let result = first;
    while (result.error === "remote_required") {
      const { directive } = result;
      seen.push(`${directive.tool}:${directive.args.action}`);
      result = await manager.submitRemote(simulator.answer(directive), directive.key);
    }
    return { result, seen };
  }

  it("load, start and complete reach Plane only through directives the Parent answers", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, description: DESCRIPTION })]);
    let verification = createVerificationState();
    const manager = new TicketManager({ getVerification: () => verification, selectTracker: PLANE_SELECTION });

    const load = await settle(manager, simulator, await manager.loadTicket("AIES-38"));
    assert.equal(load.result.ok, true, load.result.message);
    assert.deepEqual(load.seen, ["workitem:retrieve_by_identifier"]);
    assert.equal(manager.getActiveTicket().tracker, "plane");

    const start = await settle(manager, simulator, await manager.startWork());
    assert.equal(start.result.ok, true, start.result.message);
    // D36 part 3: the state write is confirmed by a read-back, which is a normal directive too.
    assert.deepEqual(start.seen, [
      "state:list",
      "workitem:retrieve_by_identifier",
      "workitem:update",
      "workitem:retrieve_by_identifier",
    ]);
    assert.equal(simulator.workItem("9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b").state.name, "In Progress");

    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    const complete = await settle(manager, simulator, await manager.completeTicket());
    assert.equal(complete.result.ok, true, complete.result.message);
    // The comment is written only after the read-back confirmed the Done state.
    assert.deepEqual(complete.seen, [
      "workitem:retrieve_by_identifier",
      "state:list",
      "workitem:update",
      "workitem:retrieve_by_identifier",
      "workitem_comment:create",
    ]);
    assert.equal(simulator.workItem("9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b").state.name, "Done");
    assert.equal(simulator.comments.length, 1);
    assert.match(simulator.comments[0].comment_html, /^<p>Implemented AIES-38\. Verified PASS on revision /);
    assert.ok(!/[<>]\s*script/i.test(simulator.comments[0].comment_html));
  });
});
