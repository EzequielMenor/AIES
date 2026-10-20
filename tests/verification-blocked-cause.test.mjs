/**
 * Blocked cause in the verification record (AIES-006, follow-up to verify-sandbox-recovery).
 *
 * The record keeps why a verdict was BLOCKED, and only a sandbox block is recoverable:
 *
 * - `applySandboxBlock` records `blockedCause: "sandbox_unavailable"` and drops any
 *   verified revision, so no later transition can make an earlier PASS valid.
 * - Any other verdict, and any work-unit change or Worker run, replaces or clears the
 *   cause, so a cause never outlives the block it describes.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applySandboxBlock,
  applyVerifyResult,
  applyVerifyStart,
  applyWorkUnitChange,
  applyWorkerResult,
  createVerificationState,
  isVerificationValid,
  planVerification,
  toVerificationReport,
} from "../extensions/aies-agents/verification.ts";

const SANDBOX_HANDOFF = {
  status: "blocked",
  summary: "Verify exige sandbox del SO y no está activo (AIES_SANDBOX=0 lo desactiva).",
  criteria: [{ index: 1, criterion: "npm run check passes", status: "blocked", evidence: "no evaluado" }],
  checks: [],
  defects: [],
  next: ["Activa el sandbox del SO."],
};

const EXTERNAL_BLOCKED = {
  ...SANDBOX_HANDOFF,
  summary: "The package registry is unreachable.",
};

const PASS_HANDOFF = {
  status: "pass",
  summary: "Checked.",
  criteria: [{ index: 1, criterion: "npm run check passes", status: "pass", evidence: "exit 0" }],
  checks: [{ check: "npm run check", result: "passed" }],
  defects: [],
  next: [],
};

const FAIL_HANDOFF = {
  status: "fail",
  summary: "Still failing.",
  criteria: [{ index: 1, criterion: "npm run check passes", status: "fail", evidence: "exit 1" }],
  checks: [{ check: "npm run check", result: "exit 1" }],
  defects: [{ severity: "blocking", file: "src/app.js", description: "wrong value", evidence: "src/app.js:1" }],
  next: [],
};

/** A valid PASS at revision 0, the state a same-revision block starts from. */
function passedAtRevisionZero() {
  const started = applyVerifyStart(createVerificationState(), 1000);
  return applyVerifyResult(started, PASS_HANDOFF, 1100);
}

describe("applySandboxBlock records the sandbox cause and never revives a PASS", () => {
  it("records blockedCause, the BLOCKED status and the reason, without spending an attempt", () => {
    const next = applySandboxBlock(createVerificationState(), SANDBOX_HANDOFF, 2000);

    assert.equal(next.status, "blocked");
    assert.equal(next.blockedCause, "sandbox_unavailable");
    assert.equal(next.blockedReason, SANDBOX_HANDOFF.summary);
    assert.equal(next.attempts, 0, "a block is not an attempt");
    assert.equal(next.revision, 0, "a block does not move the revision");
  });

  it("drops the verified revision of an earlier PASS of the same revision", () => {
    const before = passedAtRevisionZero();
    assert.equal(isVerificationValid(before), true, "precondition: valid PASS");

    const blocked = applySandboxBlock(before, SANDBOX_HANDOFF, 2000);

    assert.equal(blocked.verifiedRevision, undefined);
    assert.equal(isVerificationValid(blocked), false);
    assert.notEqual(planVerification(blocked).action, "done");
  });

  it("stays invalid through a later FAIL, and only a new PASS validates the revision again", () => {
    const blocked = applySandboxBlock(passedAtRevisionZero(), SANDBOX_HANDOFF, 2000);

    const failed = applyVerifyResult(applyVerifyStart(blocked, 3000), FAIL_HANDOFF, 3100);
    assert.equal(failed.status, "fail");
    assert.equal(isVerificationValid(failed), false);

    const repassed = applyVerifyResult(applyVerifyStart(failed, 4000), PASS_HANDOFF, 4100);
    assert.equal(isVerificationValid(repassed), true);
    assert.equal(repassed.verifiedRevision, repassed.revision);
  });

  it("is reflected in the report without marking the revision valid", () => {
    const blocked = applySandboxBlock(passedAtRevisionZero(), SANDBOX_HANDOFF, 2000);
    const report = toVerificationReport(blocked);

    assert.equal(report.status, "blocked");
    assert.equal(report.valid, false);
    assert.equal(report.decision, "stop");
  });
});

describe("the cause never outlives the block it describes", () => {
  it("a Verify verdict that is not a sandbox block carries no cause", () => {
    const sandboxBlocked = applySandboxBlock(createVerificationState(), SANDBOX_HANDOFF, 1000);
    const externalBlocked = applyVerifyResult(applyVerifyStart(sandboxBlocked, 2000), EXTERNAL_BLOCKED, 2100);

    assert.equal(externalBlocked.status, "blocked");
    assert.equal(externalBlocked.blockedCause, undefined);
  });

  it("a plain BLOCKED verdict has no cause from the start", () => {
    const next = applyVerifyResult(applyVerifyStart(createVerificationState(), 1000), EXTERNAL_BLOCKED, 1100);

    assert.equal(next.status, "blocked");
    assert.equal(next.blockedCause, undefined);
    assert.equal(next.blockedReason, EXTERNAL_BLOCKED.summary);
  });

  it("a PASS or FAIL verdict clears a previous sandbox cause", () => {
    const blocked = applySandboxBlock(createVerificationState(), SANDBOX_HANDOFF, 1000);

    assert.equal(applyVerifyResult(applyVerifyStart(blocked, 2000), PASS_HANDOFF, 2100).blockedCause, undefined);
    assert.equal(applyVerifyResult(applyVerifyStart(blocked, 2000), FAIL_HANDOFF, 2100).blockedCause, undefined);
  });

  it("a behaviour-bearing work-unit change clears a sandbox block and its cause", () => {
    const blocked = applySandboxBlock(createVerificationState(), SANDBOX_HANDOFF, 1000);
    const changed = applyWorkUnitChange(blocked, ["src/app.js"]);

    assert.equal(changed.status, "none");
    assert.equal(changed.blockedCause, undefined);
    assert.equal(changed.blockedReason, undefined);
    assert.equal(changed.revision, 1);
  });

  it("a documentation-only change keeps a sandbox block and its cause", () => {
    const blocked = applySandboxBlock(createVerificationState(), SANDBOX_HANDOFF, 1000);
    const docs = applyWorkUnitChange(blocked, ["docs/notes.md"]);

    assert.equal(docs.status, "blocked");
    assert.equal(docs.blockedCause, "sandbox_unavailable");
  });

  it("a Worker run that changes behaviour clears a sandbox block and its cause", () => {
    const blocked = applySandboxBlock(passedAtRevisionZero(), SANDBOX_HANDOFF, 1000);
    const worked = applyWorkerResult(blocked, ["src/app.js"]);

    assert.equal(worked.status, "none");
    assert.equal(worked.blockedCause, undefined);
    assert.equal(worked.verifiedRevision, undefined);
    assert.equal(isVerificationValid(worked), false);
  });
});

describe("the record stays serializable and compatible", () => {
  it("a sandbox-blocked record survives a JSON round trip with the same validity", () => {
    const blocked = applySandboxBlock(passedAtRevisionZero(), SANDBOX_HANDOFF, 2000);
    const restored = JSON.parse(JSON.stringify(blocked));

    assert.equal(restored.blockedCause, "sandbox_unavailable");
    assert.equal(isVerificationValid(restored), false);
    assert.deepEqual(toVerificationReport(restored), toVerificationReport(blocked));
  });

  it("a record written without blockedCause reads as an unexplained BLOCKED", () => {
    const legacy = JSON.parse(
      JSON.stringify({ ...createVerificationState(), status: "blocked", blockedRevision: 0, blockedReason: "outage" }),
    );

    assert.equal(legacy.blockedCause, undefined);
    assert.equal(isVerificationValid(legacy), false);
    assert.equal(planVerification(legacy).action, "stop");
  });
});
