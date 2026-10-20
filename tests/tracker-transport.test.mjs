/**
 * D33 phase 2: tracker abstraction with no behaviour change for Linear.
 *
 * Covers, without network or credentials:
 * (a) the reusable `TrackerTransport` contract, run against FakeLinearTransport;
 * (b) the compatibility aliases and the Linear exports that must stay as they are;
 * (c) tracker selection from `$PI_CODING_AGENT_DIR/aies.json`: absent or `linear`
 *     is Linear exactly, `plane` selects the Plane transport (D33 phase 3), and an
 *     unknown value fails closed with no MCP call;
 * (d) the ticket snapshot records its tracker and legacy snapshots load as linear;
 * (e) a snapshot from another tracker is refused and the state is kept;
 * (f) the Linear flow load -> start -> verify PASS -> complete is unchanged;
 * (g) the absence of PLANE_API_KEY changes nothing.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import {
  FakeLinearTransport,
  HostMediatedLinearTransport,
  isLinearRemoteRequired,
  LINEAR_MCP_SERVER,
  LinearTransportError,
} from "../extensions/aies-agents/linear/transport.ts";
// Namespace import: the neutral aliases are checked at runtime without making the
// whole file depend on them at link time.
import * as transportModule from "../extensions/aies-agents/linear/transport.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  createVerificationState,
} from "../extensions/aies-agents/verification.ts";
import { runTrackerTransportContract } from "./helpers/tracker-transport-contract.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const sampleIssue = {
  id: "issue-eze-101",
  identifier: "EZE-101",
  title: "Implement session isolation for Linear ticket",
  description: `## Acceptance Criteria
- [ ] Child agents have no Linear tools
- [ ] Done Gate requires valid fresh Verify PASS
`,
  state: { id: "status-todo", name: "Todo", type: "unstarted" },
  project: { id: "proj-1", name: "AIES Core" },
  labels: [{ id: "l-1", name: "backend" }, "security"],
  url: "https://linear.app/aies/issue/EZE-101",
};

const secondIssue = {
  id: "issue-eze-202",
  identifier: "EZE-202",
  title: "Second ticket",
  description: "## Acceptance Criteria\n- [ ] Second\n",
  state: { id: "status-todo", name: "Todo", type: "unstarted" },
  project: { id: "proj-1", name: "AIES Core" },
};

/** A transport that records every call. A tracker refusal must leave it at zero. */
function spyTransport(issues = [sampleIssue]) {
  const fake = new FakeLinearTransport(issues);
  const calls = [];
  const wrap = (name) => async (...args) => {
    calls.push(name);
    return fake[name](...args);
  };
  return {
    calls,
    fake,
    transport: {
      getIssue: wrap("getIssue"),
      updateIssue: wrap("updateIssue"),
      getStatuses: wrap("getStatuses"),
      addComment: wrap("addComment"),
    },
  };
}

/** Snapshot as the session stores it, before any tracker field existed. */
function legacySnapshot(issue = sampleIssue) {
  return {
    ticketId: issue.identifier,
    activeTicket: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: "",
      acceptanceCriteria: [],
      status: "Todo",
      statusId: "status-todo",
      statusType: "unstarted",
      project: "AIES Core",
      loadedAt: 1,
    },
    workState: "loaded",
    lastKnownLinearStatus: "Todo",
    changedPaths: [],
    pendingFinalAction: null,
    persistedAt: 1,
  };
}

describe("D33 phase 2: TrackerTransport", () => {
  let savedAgentDir;
  let agentDir;
  let savedPlaneKey;

  beforeEach(() => {
    savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    savedPlaneKey = process.env.PLANE_API_KEY;
    agentDir = mkdtempSync(join(tmpdir(), "aies-tracker-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PLANE_API_KEY;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
    if (savedPlaneKey === undefined) delete process.env.PLANE_API_KEY;
    else process.env.PLANE_API_KEY = savedPlaneKey;
    rmSync(agentDir, { recursive: true, force: true });
  });

  function writeAiesConfig(content) {
    writeFileSync(join(agentDir, "aies.json"), typeof content === "string" ? content : JSON.stringify(content));
  }

  // (a) Executable contract, reusable by the Plane transport in phase 3.
  runTrackerTransportContract("FakeLinearTransport", () => {
    const transport = new FakeLinearTransport();
    return { transport, seed: (issue) => transport.seedIssue(issue) };
  });

  describe("(b) compatibility surface", () => {
    it("keeps the Linear transport classes, helpers and MCP server name exported", () => {
      assert.equal(typeof FakeLinearTransport, "function");
      assert.equal(typeof HostMediatedLinearTransport, "function");
      assert.equal(typeof LinearTransportError, "function");
      assert.equal(typeof isLinearRemoteRequired, "function");
      assert.equal(typeof transportModule.linearRemoteKey, "function");
      assert.equal(typeof transportModule.unwrapMcpAnswer, "function");
      assert.equal(typeof transportModule.readRemoteAnswer, "function");
      assert.equal(typeof transportModule.normalizeStatuses, "function");
      assert.equal(LINEAR_MCP_SERVER, "linear");
    });

    it("exposes the neutral error aliases as the same classes", () => {
      assert.equal(transportModule.TrackerTransportError, transportModule.LinearTransportError);
    });

    it("both transports expose the four TrackerTransport methods", () => {
      for (const transport of [new FakeLinearTransport(), new HostMediatedLinearTransport()]) {
        for (const method of ["getIssue", "updateIssue", "getStatuses", "addComment"]) {
          assert.equal(typeof transport[method], "function", `${method} must exist`);
        }
      }
    });

    it("the mediated transport still answers with a remote_required directive", async () => {
      await assert.rejects(
        () => new HostMediatedLinearTransport().getIssue("EZE-1"),
        (error) => isLinearRemoteRequired(error) && error.directive.server === LINEAR_MCP_SERVER,
      );
    });
  });

  describe("(c) tracker selection in aies.json", () => {
    it("an absent aies.json keeps Linear: the mediated transport asks for the Linear call", async () => {
      const manager = new TicketManager({ getVerification: () => createVerificationState() });
      const result = await manager.loadTicket("EZE-1");
      assert.equal(result.error, "remote_required");
      assert.equal(result.directive.server, "linear");
      assert.equal(result.directive.tool, "get_issue");
    });

    it("tracker linear and a config without a tracker key both keep Linear", async () => {
      for (const config of [{ tracker: "linear" }, { repos: {} }]) {
        writeAiesConfig(config);
        const manager = new TicketManager({ getVerification: () => createVerificationState() });
        const result = await manager.loadTicket("EZE-1");
        assert.equal(result.error, "remote_required", JSON.stringify(config));
        assert.equal(result.directive.server, "linear", JSON.stringify(config));
      }
    });

    it("an unreadable aies.json keeps the Linear default, as the other profile readers do", async () => {
      writeAiesConfig("{ not json");
      const manager = new TicketManager({ getVerification: () => createVerificationState() });
      const result = await manager.loadTicket("EZE-1");
      assert.equal(result.error, "remote_required");
      assert.equal(result.directive.server, "linear");
    });

    it("an unknown tracker fails closed before any transport call", async () => {
      writeAiesConfig({ tracker: "jira" });
      const spy = spyTransport();
      const manager = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      const result = await manager.loadTicket("EZE-101");
      assert.equal(result.ok, false);
      assert.equal(result.error, "tracker_unknown");
      assert.match(result.message, /jira/);
      assert.deepEqual(spy.calls, []);
      assert.equal(manager.getActiveTicket(), null);
    });

    it("tracker plane makes no call of its own for operations that have no active ticket", async () => {
      writeAiesConfig({ tracker: "plane" });
      const manager = new TicketManager({ getVerification: () => createVerificationState() });
      const attempts = [
        manager.startWork(),
        manager.completeTicket(),
        manager.blockTicket({ evidence: "blocked" }),
        manager.addComment("note"),
        manager.refresh(),
      ];
      for (const result of await Promise.all(attempts)) {
        assert.equal(result.ok, false);
        assert.equal(result.error, "no_active_ticket");
        assert.equal(result.directive, undefined);
      }
      assert.equal(manager.getPendingDirective(), null);
      assert.equal(manager.getActiveTicket(), null);
    });

    it("tracker plane routes the ticket load to the Plane transport, which asks the Parent only for its call", async () => {
      writeAiesConfig({ tracker: "plane" });
      const manager = new TicketManager({ getVerification: () => createVerificationState() });
      const result = await manager.loadTicket("EZE-1");
      assert.equal(result.error, "remote_required");
      assert.equal(result.directive.server, "plane");
      assert.equal(result.directive.tool, "workitem");
      assert.equal(manager.getPendingDirective().server, "plane");
      assert.equal(manager.getActiveTicket(), null);
    });

    it("tracker plane refuses to act on an active Linear ticket and leaves its state untouched", async () => {
      const spy = spyTransport([sampleIssue]);
      const manager = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      assert.equal((await manager.loadTicket("EZE-101")).ok, true);
      assert.equal((await manager.startWork()).ok, true);
      const callsBefore = spy.calls.length;
      const addedBefore = spy.fake.addedComments.length;
      const updatedBefore = spy.fake.updatedIssues.length;

      writeAiesConfig({ tracker: "plane" });
      const result = await manager.completeTicket();

      assert.equal(result.error, "tracker_mismatch");
      assert.equal(spy.calls.length, callsBefore);
      assert.equal(spy.fake.addedComments.length, addedBefore);
      assert.equal(spy.fake.updatedIssues.length, updatedBefore);
      assert.equal(manager.getActiveTicket().identifier, "EZE-101");
      assert.equal(manager.getWorkState(), "working");
    });
  });

  describe("(d) the snapshot records its tracker", () => {
    it("a snapshot of an active Linear ticket records tracker linear", async () => {
      const spy = spyTransport();
      const manager = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      await manager.loadTicket("EZE-101");
      const snapshot = manager.toSnapshot();
      assert.equal(snapshot.tracker, "linear");
      assert.equal(snapshot.activeTicket.tracker, "linear");
    });

    it("the tracker survives a JSON round trip into a resumed session", async () => {
      const spy = spyTransport();
      const original = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      await original.loadTicket("EZE-101");
      const stored = JSON.parse(JSON.stringify(original.toSnapshot()));

      const resumed = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      const restored = resumed.restoreFromSnapshot(stored);
      assert.notEqual(restored?.ok, false);
      assert.equal(resumed.getActiveTicket().identifier, "EZE-101");
      assert.equal(resumed.toSnapshot().tracker, "linear");
    });

    it("a legacy snapshot without a tracker loads and is treated as linear", async () => {
      const spy = spyTransport();
      const manager = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      const restored = manager.restoreFromSnapshot(legacySnapshot());
      assert.notEqual(restored?.ok, false);
      assert.equal(manager.getActiveTicket().identifier, "EZE-101");
      assert.equal(manager.toSnapshot().tracker, "linear");
      const refreshed = await manager.refresh();
      assert.equal(refreshed.ok, true);
      assert.deepEqual(spy.calls, ["getIssue"]);
    });
  });

  describe("(e) a snapshot from another tracker fails closed", () => {
    it("a plane snapshot is refused under linear and the active ticket is kept", async () => {
      const spy = spyTransport([sampleIssue, secondIssue]);
      const manager = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      await manager.loadTicket("EZE-101");
      await manager.startWork();
      const callsBefore = spy.calls.length;

      const foreign = { ...legacySnapshot(secondIssue), tracker: "plane" };
      const result = manager.restoreFromSnapshot(foreign);

      assert.equal(result.ok, false);
      assert.equal(result.error, "tracker_mismatch");
      assert.match(result.message, /plane/);
      assert.match(result.message, /linear/);
      assert.equal(manager.getActiveTicket().identifier, "EZE-101");
      assert.equal(manager.getWorkState(), "working");
      assert.equal(spy.calls.length, callsBefore, "a refused restore makes no remote call");
    });

    it("a fresh session refuses the plane snapshot, activates nothing and makes no call", async () => {
      const spy = spyTransport([secondIssue]);
      const manager = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      const result = manager.restoreFromSnapshot({ ...legacySnapshot(secondIssue), tracker: "plane" });

      assert.equal(result.ok, false);
      assert.equal(result.error, "tracker_mismatch");
      assert.equal(manager.getActiveTicket(), null);
      const refresh = await manager.refresh();
      assert.equal(refresh.error, "no_active_ticket");
      assert.deepEqual(spy.calls, []);
    });

    it("a linear snapshot is refused when plane is configured, because the trackers differ", () => {
      writeAiesConfig({ tracker: "plane" });
      const spy = spyTransport();
      const manager = new TicketManager({ transport: spy.transport, getVerification: () => createVerificationState() });
      const result = manager.restoreFromSnapshot(legacySnapshot());
      assert.equal(result.ok, false);
      assert.equal(result.error, "tracker_mismatch");
      assert.equal(spy.calls.length, 0, "a refused restore makes no remote call");
      assert.equal(manager.getActiveTicket(), null);
    });

    it("an unknown configured tracker refuses to restore anything", () => {
      writeAiesConfig({ tracker: "jira" });
      const manager = new TicketManager({ getVerification: () => createVerificationState() });
      const result = manager.restoreFromSnapshot(legacySnapshot());
      assert.equal(result.ok, false);
      assert.equal(result.error, "tracker_unknown");
      assert.equal(manager.getActiveTicket(), null);
    });
  });

  describe("(f) the Linear flow is unchanged", () => {
    it("load -> start -> verify PASS -> complete produces the same results, messages and remote effects", async () => {
      const fake = new FakeLinearTransport([sampleIssue]);
      let verification = createVerificationState();
      const manager = new TicketManager({ transport: fake, getVerification: () => verification });

      const load = await manager.loadTicket("EZE-101");
      const start = await manager.startWork();
      manager.recordChangedPaths(["src/controller.ts"]);
      verification = applyWorkUnitChange(verification, ["src/controller.ts"]);
      verification = applyVerifyStart(verification, Date.now());
      verification = applyVerifyResult(
        verification,
        { status: "pass", criteria: [], checks: [], defects: [] },
        Date.now(),
      );
      const complete = await manager.completeTicket();
      const remote = await fake.getIssue("EZE-101");

      assert.deepEqual(summarize(load), {
        ok: true,
        workState: "loaded",
        message: "Active ticket set to EZE-101: Implement session isolation for Linear ticket",
        contract:
          "Ticket: EZE-101 — Implement session isolation for Linear ticket\n" +
          "Status: Todo [unstarted]\n" +
          "Project: AIES Core\n" +
          "Labels: backend, security\n" +
          "URL: https://linear.app/aies/issue/EZE-101\n" +
          "\n" +
          "Acceptance Criteria:\n" +
          "1. Child agents have no Linear tools\n" +
          "2. Done Gate requires valid fresh Verify PASS\n" +
          "\n" +
          "Summary:\n" +
          "## Acceptance Criteria\n" +
          "- [ ] Child agents have no Linear tools\n" +
          "- [ ] Done Gate requires valid fresh Verify PASS",
        ticket: {
          identifier: "EZE-101",
          status: "Todo",
          statusId: "status-todo",
          statusType: "unstarted",
          project: "AIES Core",
        },
      });
      assert.deepEqual(summarize(start), {
        ok: true,
        workState: "working",
        message: "Started work on EZE-101 (In Progress).",
        ticket: { identifier: "EZE-101", status: "In Progress", statusId: "status-in-progress", statusType: "started", project: "AIES Core" },
      });
      assert.deepEqual(summarize(complete), {
        ok: true,
        workState: "complete",
        message: "Ticket EZE-101 marked Done in Linear.",
        ticket: { identifier: "EZE-101", status: "Done", statusId: "status-done", statusType: "completed", project: "AIES Core" },
      });
      assert.deepEqual(remote.state, { id: "status-done", name: "Done", type: "completed" });
      assert.deepEqual(
        fake.getComments("EZE-101").map((comment) => comment.body),
        ["Implemented EZE-101. Verified PASS on revision 1."],
      );
    });
  });

  describe("(g) PLANE_API_KEY is never read", () => {
    it("no AIES extension source refers to PLANE_API_KEY", () => {
      const sourceDir = join(REPO_ROOT, "extensions");
      const files = readdirSync(sourceDir, { recursive: true }).filter((name) => String(name).endsWith(".ts"));
      assert.ok(files.length > 0);
      for (const name of files) {
        const text = readFileSync(join(sourceDir, String(name)), "utf8");
        assert.equal(text.includes("PLANE_API_KEY"), false, `${name} must not reference PLANE_API_KEY`);
      }
    });

    it("a Linear flow is identical whether or not PLANE_API_KEY is set", async () => {
      const run = async () => {
        const fake = new FakeLinearTransport([sampleIssue]);
        const manager = new TicketManager({ transport: fake, getVerification: () => createVerificationState() });
        return [summarize(await manager.loadTicket("EZE-101")), summarize(await manager.startWork())];
      };
      delete process.env.PLANE_API_KEY;
      const withoutKey = await run();
      process.env.PLANE_API_KEY = "sentinel-plane-token-value";
      const withKey = await run();
      assert.deepEqual(withKey, withoutKey);
      assert.equal(JSON.stringify(withKey).includes("sentinel-plane-token-value"), false);
    });

    it("the plane request does not depend on the key being present", async () => {
      writeAiesConfig({ tracker: "plane" });
      const manager = new TicketManager({ getVerification: () => createVerificationState() });
      delete process.env.PLANE_API_KEY;
      const withoutKey = await manager.loadTicket("EZE-1");
      process.env.PLANE_API_KEY = "sentinel-plane-token-value";
      const withKey = await manager.loadTicket("EZE-1");
      assert.deepEqual(withKey, withoutKey);
      assert.equal(withKey.error, "remote_required");
      assert.equal(withKey.directive.server, "plane");
    });
  });
});

/** The fields of a result that are compared; timestamps and the additive tracker field are left out. */
function summarize(result) {
  const { ticket, ...rest } = result;
  if (!ticket) return rest;
  return {
    ...rest,
    ticket: {
      identifier: ticket.identifier,
      status: ticket.status,
      statusId: ticket.statusId,
      statusType: ticket.statusType,
      project: ticket.project,
    },
  };
}
