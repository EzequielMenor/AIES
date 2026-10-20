/**
 * Executable contract for `TrackerTransport` (D33 phase 2).
 *
 * Any transport a tracker backend provides must satisfy these cases: Linear's
 * `FakeLinearTransport` today, and `PlaneTransport` in phase 3. The suite only
 * relies on the four methods and on the shared issue shape; it never depends on
 * a Linear-specific identifier format, status name or MCP tool name.
 *
 * Usage:
 *   runTrackerTransportContract("FakeLinearTransport", () => ({
 *     transport,                       // a TrackerTransport
 *     seed: (issue) => { ... },        // makes an issue exist on the fake remote
 *   }));
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const TICKET = "TST-1";

function stateName(issue) {
  const state = issue?.state;
  if (state && typeof state === "object") return state.name;
  if (typeof state === "string") return state;
  return issue?.status?.name ?? issue?.status;
}

export function runTrackerTransportContract(label, createFixture) {
  describe(`TrackerTransport contract: ${label}`, () => {
    const seededIssue = {
      id: "contract-internal-1",
      identifier: TICKET,
      title: "Contract ticket",
      description: "## Acceptance Criteria\n- [ ] Contract holds\n",
      state: { id: "contract-todo", name: "Todo", type: "unstarted" },
      project: { id: "contract-project", name: "Contract" },
    };

    it("getIssue resolves null for a ticket that does not exist", async () => {
      const { transport } = createFixture();
      assert.equal(await transport.getIssue("TST-404"), null);
    });

    it("getIssue resolves the seeded issue under its human identifier", async () => {
      const { transport, seed } = createFixture();
      seed(seededIssue);
      const issue = await transport.getIssue(TICKET);
      assert.ok(issue, "seeded ticket must be found");
      assert.equal(issue.identifier, TICKET);
      assert.equal(issue.title, "Contract ticket");
      assert.equal(stateName(issue), "Todo");
    });

    it("getStatuses resolves a non-empty list of { id, name, type } entries", async () => {
      const { transport, seed } = createFixture();
      seed(seededIssue);
      const statuses = await transport.getStatuses(seededIssue.project?.name);
      assert.ok(Array.isArray(statuses) && statuses.length > 0, "statuses must be a non-empty array");
      for (const status of statuses) {
        assert.equal(typeof status.id, "string");
        assert.equal(typeof status.name, "string");
        assert.equal(typeof status.type, "string");
      }
    });

    it("updateIssue moves the ticket to the requested status and returns the updated issue", async () => {
      const { transport, seed } = createFixture();
      seed(seededIssue);
      const statuses = await transport.getStatuses(seededIssue.project?.name);
      const target = statuses.find((status) => status.type === "started");
      assert.ok(target, "contract needs a started status to move to");

      const updated = await transport.updateIssue(TICKET, { statusId: target.id });
      assert.equal(updated.identifier, TICKET);
      assert.equal(stateName(updated), target.name);

      const after = await transport.getIssue(TICKET);
      assert.equal(stateName(after), target.name, "a later read must observe the update");
    });

    it("updateIssue on a ticket that does not exist rejects with a typed not_found error", async () => {
      const { transport, seed } = createFixture();
      seed(seededIssue);
      const statuses = await transport.getStatuses(seededIssue.project?.name);
      await assert.rejects(
        () => transport.updateIssue("TST-404", { statusId: statuses[0].id }),
        (error) => error?.code === "not_found",
      );
    });

    it("addComment resolves without a value and does not change the ticket state", async () => {
      const { transport, seed } = createFixture();
      seed(seededIssue);
      const before = stateName(await transport.getIssue(TICKET));
      const result = await transport.addComment(TICKET, "Contract comment");
      assert.equal(result, undefined);
      assert.equal(stateName(await transport.getIssue(TICKET)), before);
    });
  });
}
