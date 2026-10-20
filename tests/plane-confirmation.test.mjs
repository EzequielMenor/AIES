/**
 * D36 part 3: a Plane state write is confirmed by a read-back, never by its own answer.
 *
 * The read-back has the same MCP arguments as the read before the write, so it runs under
 * its own stage: the Parent sees it as a normal `remote_required` directive, and the
 * pre-write answer can never satisfy it. A read-back that does not show the written state
 * refuses the move: the local ticket keeps its state, it stays open, and the comment is
 * not written. The offline Plane simulator answers as the hosted server does; the tests
 * replace one answer where they need a stale, missing or unusable read-back.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { isLinearRemoteRequired, LinearTransportError } from "../extensions/aies-agents/linear/transport.ts";
import { HostMediatedPlaneTransport } from "../extensions/aies-agents/linear/plane-transport.ts";
import { PLANE_TRACKER } from "../extensions/aies-agents/linear/tracker.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
} from "../extensions/aies-agents/verification.ts";
import { createPlaneMcpSimulator } from "./helpers/plane-mcp-simulator.mjs";
import { PLANE_STATES, PLANE_WORKITEM_UUID, planeWorkItem } from "./helpers/plane-fixtures.mjs";

const CODE_PATHS = ["extensions/aies-agents/linear/manager.ts"];
const PLANE_SELECTION = () => ({ ok: true, tracker: PLANE_TRACKER });
const DESCRIPTION = "## Acceptance Criteria\n- [ ] The read-back confirms the Plane state\n";
const CONFIRM = "#confirm-state";
const IN_PROGRESS = PLANE_STATES.find((state) => state.name === "In Progress").id;

/** Verification state after a behaviour-bearing change and a fresh PASS. */
function freshPass() {
  let state = createVerificationState();
  state = applyWorkUnitChange(state, CODE_PATHS, "worker implemented the change");
  state = applyVerifyStart(state, 1_700_000_000_000);
  return applyVerifyResult(state, { status: "pass", criteria: [] }, 1_700_000_000_100);
}

/** The `mcp` proxy answer the adapter returns: a JSON text part. */
const envelope = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

const isConfirm = (directive) => directive.key.endsWith(CONFIRM);

/**
 * Answers the pending directives the way the Parent does, until the operation settles.
 * `override` may replace the answer of one directive with the raw value the Parent would
 * hand back; `undefined` means the answer the hosted server would give.
 */
async function settle(manager, simulator, first, override = () => undefined) {
  const seen = [];
  let result = first;
  while (result.error === "remote_required") {
    const { directive } = result;
    seen.push(directive);
    const replaced = override(directive);
    const value = replaced === undefined ? simulator.answer(directive) : replaced;
    result = await manager.submitRemote(value, directive.key);
  }
  return { result, seen };
}

function newManager(getVerification = () => createVerificationState()) {
  return new TicketManager({ getVerification, selectTracker: PLANE_SELECTION });
}

describe("D36 part 3: the read-back is a normal remote directive, after the write", () => {
  it("asks for the same MCP read once more, under its own key, and moves the ticket only after it", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, stateName: "Todo" })]);
    const manager = newManager();
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));

    const start = await settle(manager, simulator, await manager.startWork());
    assert.equal(start.result.ok, true, start.result.message);

    const reads = start.seen.filter((d) => d.tool === "workitem" && d.args.action === "retrieve_by_identifier");
    assert.equal(reads.length, 2, "one read before the write and one read-back after it");
    const [before, after] = reads;
    assert.equal(before.key.endsWith(CONFIRM), false);
    assert.equal(isConfirm(after), true);
    assert.equal(after.server, "plane");
    assert.deepEqual(after.args, before.args, "the MCP call is the same: no extra argument reaches Plane");
    assert.deepEqual(Object.keys(after.args).sort(), ["action", "expand", "workitem_identifier"]);
    assert.match(after.purpose, /confirm/);

    const update = start.seen.findIndex((d) => d.args.action === "update");
    assert.ok(start.seen.indexOf(after) > update, "the read-back comes after the write");
    assert.equal(manager.getWorkState(), "working");
    assert.equal(manager.getActiveTicket().status, "In Progress");
  });

  it("a read-back that still shows the old state refuses the start: nothing moves locally", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, stateName: "Todo" })]);
    const manager = newManager();
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));
    const stale = simulator.workItem(PLANE_WORKITEM_UUID);

    const start = await settle(manager, simulator, await manager.startWork(), (d) => (isConfirm(d) ? envelope(stale) : undefined));
    assert.equal(start.result.ok, false);
    assert.equal(start.result.error, "remote_conflict");
    assert.match(start.result.message, /was not moved in AIES and stays open/);
    assert.equal(manager.getWorkState(), "loaded", "the local ticket did not start");
    assert.equal(manager.getActiveTicket().status, "Todo");
    assert.equal(simulator.workItem(PLANE_WORKITEM_UUID).state.name, "In Progress", "the write reached Plane, which is why the read-back is needed");
  });

  it("the write's own answer is not evidence: a write that claims In Progress is refused when the read-back shows Todo", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, stateName: "Todo" })]);
    const manager = newManager();
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));
    const stale = simulator.workItem(PLANE_WORKITEM_UUID);

    const start = await settle(manager, simulator, await manager.startWork(), (d) => {
      if (isConfirm(d)) return envelope(stale);
      if (d.args.action === "update") return envelope(planeWorkItem({ sequence: 38, stateName: "In Progress" }));
      return undefined;
    });
    assert.equal(start.result.ok, false);
    assert.equal(start.result.error, "remote_conflict");
    assert.equal(manager.getWorkState(), "loaded");
  });

  it("a read-back with no work item refuses the start with not_found", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, stateName: "Todo" })]);
    const manager = newManager();
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));

    const start = await settle(manager, simulator, await manager.startWork(), (d) => (isConfirm(d) ? null : undefined));
    assert.equal(start.result.ok, false);
    assert.equal(start.result.error, "not_found");
    assert.equal(manager.getWorkState(), "loaded");
  });

  it("an unusable read-back refuses the start with invalid_remote_payload", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, stateName: "Todo" })]);
    const manager = newManager();
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));

    const start = await settle(manager, simulator, await manager.startWork(), (d) => (isConfirm(d) ? "garbage" : undefined));
    assert.equal(start.result.ok, false);
    assert.equal(start.result.error, "invalid_remote_payload");
    assert.equal(manager.getWorkState(), "loaded");
  });

  it("a read-back that names another ticket, or carries no state, is refused", async () => {
    const other = planeWorkItem({ sequence: 99, stateName: "In Progress" });
    const noState = { ...planeWorkItem({ sequence: 38, stateName: "In Progress" }) };
    delete noState.state;

    for (const [label, answer] of [["another ticket", other], ["no state", noState]]) {
      // A fresh remote per case: a write that already landed would make the start a no-op.
      const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, stateName: "Todo" })]);
      const manager = newManager();
      await settle(manager, simulator, await manager.loadTicket("AIES-38"));
      const start = await settle(manager, simulator, await manager.startWork(), (d) => (isConfirm(d) ? envelope(answer) : undefined));
      assert.equal(start.result.ok, false, label);
      assert.equal(start.result.error, "invalid_remote_payload", label);
      assert.equal(manager.getWorkState(), "loaded", label);
    }
  });
});

describe("D36 part 3: the completion moves to Done and posts its comment only after the read-back", () => {
  it("writes the comment after the read-back confirmed Done", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, description: DESCRIPTION, stateName: "Todo" })]);
    let verification = createVerificationState();
    const manager = newManager(() => verification);
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));
    await settle(manager, simulator, await manager.startWork());

    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    const complete = await settle(manager, simulator, await manager.completeTicket());
    assert.equal(complete.result.ok, true, complete.result.message);

    const confirmAt = complete.seen.findIndex(isConfirm);
    const commentAt = complete.seen.findIndex((d) => d.tool === "workitem_comment");
    assert.ok(confirmAt > -1, "the completion reads the ticket back");
    assert.ok(commentAt > confirmAt, "the comment is written after the read-back");
    assert.equal(simulator.comments.length, 1);
    assert.equal(manager.getWorkState(), "complete");
    assert.equal(simulator.workItem(PLANE_WORKITEM_UUID).state.name, "Done");
  });

  it("a completion whose read-back does not show Done leaves the ticket open, with no comment", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, description: DESCRIPTION, stateName: "Todo" })]);
    let verification = createVerificationState();
    const manager = newManager(() => verification);
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));
    await settle(manager, simulator, await manager.startWork());
    const inProgress = simulator.workItem(PLANE_WORKITEM_UUID);

    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    const complete = await settle(manager, simulator, await manager.completeTicket(), (d) => (isConfirm(d) ? envelope(inProgress) : undefined));
    assert.equal(complete.result.ok, false);
    assert.equal(complete.result.error, "remote_conflict");
    assert.match(complete.result.message, /was not moved in AIES and stays open/);
    assert.equal(manager.getWorkState(), "working", "the ticket is not complete");
    assert.equal(manager.getActiveTicket().status, "In Progress");
    assert.equal(simulator.comments.length, 0, "no comment is written for an unconfirmed completion");
    assert.equal(complete.seen.some((d) => d.tool === "workitem_comment"), false);
  });

  it("a retry never completes twice: when the unconfirmed write did land, the existing remote conflict reports it", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, description: DESCRIPTION, stateName: "Todo" })]);
    let verification = createVerificationState();
    const manager = newManager(() => verification);
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));
    await settle(manager, simulator, await manager.startWork());
    const inProgress = simulator.workItem(PLANE_WORKITEM_UUID);

    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    await settle(manager, simulator, await manager.completeTicket(), (d) => (isConfirm(d) ? envelope(inProgress) : undefined));
    // The write reached Plane before the read-back refused it, so Plane now shows Done.
    assert.equal(simulator.workItem(PLANE_WORKITEM_UUID).state.name, "Done");
    const retry = await settle(manager, simulator, await manager.completeTicket());
    assert.equal(retry.result.ok, false);
    assert.equal(retry.result.error, "remote_conflict");
    assert.match(retry.result.message, /already completed externally/);
    assert.equal(manager.getWorkState(), "working", "the ticket stays open in AIES until someone decides");
    assert.equal(simulator.comments.length, 0);
  });

  it("the EZE-503 hold still stands before any Plane call, and no read-back is requested", async () => {
    const simulator = createPlaneMcpSimulator([planeWorkItem({ sequence: 38, description: DESCRIPTION, stateName: "Todo" })]);
    let verification = createVerificationState();
    const manager = newManager(() => verification);
    await settle(manager, simulator, await manager.loadTicket("AIES-38"));
    await settle(manager, simulator, await manager.startWork());

    manager.recordChangedPaths(CODE_PATHS);
    verification = freshPass();
    manager.recordUserInput("no cierres el ticket todavía");
    const calls = simulator.calls.length;
    const complete = await manager.completeTicket();
    assert.equal(complete.error, "pending_final_action");
    assert.equal(manager.getPendingDirective(), null);
    assert.equal(simulator.calls.length, calls, "the hold is decided before any Plane call");
  });
});

describe("D36 part 3: the transport asks for the read-back as a directive of its own", () => {
  it("names the read-back after the write, and resolves only when that read shows the written state", async () => {
    const answers = {};
    const attempt = () => new HostMediatedPlaneTransport(answers).updateIssue("AIES-38", { statusId: IN_PROGRESS });
    const directives = [];

    // Each round answers the directive the transport names, as the Parent would.
    const replies = [planeWorkItem({ sequence: 38, stateName: "Todo" }), planeWorkItem({ sequence: 38, stateName: "In Progress" })];
    let resolved = null;
    for (let round = 0; round < 6 && !resolved; round += 1) {
      try {
        resolved = await attempt();
      } catch (error) {
        assert.ok(isLinearRemoteRequired(error), `expected a remote directive, got ${error.message}`);
        directives.push(error.directive);
        if (isConfirm(error.directive)) {
          answers[error.directive.key] = planeWorkItem({ sequence: 38, stateName: "In Progress" });
        } else {
          answers[error.directive.key] = replies[directives.length - 1] ?? planeWorkItem({ sequence: 38, stateName: "In Progress" });
        }
      }
    }

    assert.equal(directives.length, 3, "read, write, read-back");
    const [read, write, confirm] = directives;
    assert.equal(read.tool, "workitem");
    assert.equal(write.args.action, "update");
    assert.equal(confirm.server, "plane");
    assert.equal(confirm.tool, "workitem");
    assert.deepEqual(confirm.args, read.args);
    assert.equal(isConfirm(confirm), true);
    assert.equal(resolved.state.id, IN_PROGRESS);
    assert.equal(resolved.identifier, "AIES-38");
  });

  it("refuses a read-back that shows another state, even when the write answered the target state", async () => {
    const answers = {};
    const attempt = () => new HostMediatedPlaneTransport(answers).updateIssue("AIES-38", { statusId: IN_PROGRESS });
    const seenDirectives = [];
    let failure = null;
    for (let round = 0; round < 6 && !failure; round += 1) {
      try {
        await attempt();
      } catch (error) {
        if (!isLinearRemoteRequired(error)) {
          failure = error;
          break;
        }
        seenDirectives.push(error.directive);
        const todo = planeWorkItem({ sequence: 38, stateName: "Todo" });
        const inProgress = planeWorkItem({ sequence: 38, stateName: "In Progress" });
        answers[error.directive.key] = isConfirm(error.directive) ? todo : inProgress;
      }
    }
    assert.ok(failure instanceof LinearTransportError, "the write is refused, not confirmed");
    assert.equal(failure.name, "PlaneWriteUnconfirmedError");
    assert.equal(failure.code, "remote_conflict");
    assert.match(failure.message, /stays open/);
    assert.equal(seenDirectives.length, 3);
  });
});
