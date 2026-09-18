# AIES-005 - Independent Verify

Status: in progress
Branch: `feat/aies-005-verify`
Scope: Phase 5 of AIES (independent verification role, verification state and bounded repair)

## Goal

Close the core loop of the harness: the parent knows what to do, Explore
discovers, Worker changes, and Verify demonstrates whether the change actually
works. Verify is a third isolated child role that inspects the real repository
artifact, executes the relevant checks, and answers `pass | fail | blocked` with
evidence. It never repairs.

## Non-goals (out of scope for this phase)

Linear workflow, automatic done, automatic commits, push, PR, merge, deploy,
persistent memory, the full context governor, proactive compaction, autopilot,
background or parallel agents, a permanent reviewer, mandatory multi-model
review, and a complete permission sandbox (that is AIES-006).

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Roles | `aies_delegate({ role: "explore" \| "worker" \| "verify", ... })`, and no further roles |
| D2 | Verify tool surface | `read`, `grep`, `find`, `ls`, `tgrep`, guarded `bash`. No `edit`, no `write` |
| D3 | Verify context | Structured and factual only: task, acceptance criteria, changed paths, base ref, suggested checks, cwd. Free-form `context` is rejected for this role |
| D4 | Verify verdict | `pass \| fail \| blocked`, with per-criterion status, checks, defects and a single next step |
| D5 | Verdict semantics | `pass` needs evidence; `fail` needs a reproducible defect related to the change; `blocked` is reserved for causes external to the change |
| D6 | Verify command policy | The Worker destructive list plus every workspace mutation: all mutating git subcommands, any `rm`/`mv`/`cp`/`tee`/`truncate`/`touch`, in-place `sed`/`perl`, dependency installation, and file redirection |
| D7 | Verification state | `status` (`none \| running \| pass \| fail \| blocked`), `attempts`, `repairs`, revision counter, failure signature, awaiting-verification flag |
| D8 | PASS invalidation | A work-unit revision counter: any parent `edit`/`write` or completed Worker run invalidates a PASS by moving the revision past `verifiedRevision` |
| D9 | Repair policy | Maximum 2 repair cycles (3 verifications), plus an early stop when the same failure signature repeats without material progress |
| D10 | Authority | Only the parent decides "this work unit is verified", from a valid Verify PASS. Worker and Verify report; they never mark verified |
| D11 | Routing rule | A behaviour-bearing change produced by Worker requires Verify before it can be considered complete; documentation-only paths do not |
| D12 | Model resolution | Priority: `AIES_VERIFY_MODEL` env > `aies.json` (`agents.verify.model`) > parent session model |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Shared command guard and Verify read-only policy | pending | `feat(agents): add independent verification workflow` |
| T2 Verify handoff schema, defect list and failure signature | pending | same commit |
| T3 Verification state, PASS invalidation and repair policy | pending | same commit |
| T4 Verify role prompt and isolated child runner | pending | same commit |
| T5 Routing, delegate, model and session wiring for the Verify route | pending | same commit |
| T6 Test suite: `tests/verify.test.mjs` | pending | same commit |
| T7 Smoke E2E: `tests/smoke-verify.test.mjs` (FAIL -> repair -> PASS) | pending | same commit |
| T8 Observability: verification section in the footer and `/aies-status` | pending | `feat(observability): surface verification state` |
| T9 Profile configuration: `agents.verify.model` seed | pending | same commit |
| T10 Documentation: architecture, decision D11, README, phase record | pending | `docs: record the AIES-005 verification phase` |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Full test suite | `npm test` | pending |
| Isolation script | `npm run check:isolation` | pending |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | pending |
| Fresh context | `tests/verify.test.mjs` | pending |
| No mutation tools | `tests/verify.test.mjs` | pending |
| Reads the real artifact | `tests/verify.test.mjs` | pending |
| FAIL through a Worker lie | `tests/verify.test.mjs` | pending |
| BLOCKED is not FAIL | `tests/verify.test.mjs` | pending |
| No self-repair | `tests/verify.test.mjs` | pending |
| PASS invalidation | `tests/verify.test.mjs`, `tests/observability.test.mjs` | pending |
| Repair limit and same-failure stop | `tests/verify.test.mjs` | pending |
| Metrics isolation | `tests/verify.test.mjs` | pending |
| Smoke FAIL -> repair -> PASS | `tests/smoke-verify.test.mjs` | pending |
| Plain Pi unchanged | `pi --version` | pending |
