# AIES-005 - Independent Verify

Status: complete
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
| D5 | Verdict semantics | `pass` needs evidence (a verdict without any evidence is downgraded to `blocked`); `fail` needs a reproducible defect related to the change; `blocked` is reserved for causes external to the change |
| D6 | Verify command policy | The Worker destructive list plus every workspace mutation: all mutating git subcommands, any `rm`/`mv`/`cp`/`tee`/`truncate`/`touch`, in-place `sed`/`perl`, dependency installation, file redirection, and command substitution that would hide a command from the guard |
| D7 | Verification state | `status` (`none \| running \| pass \| fail \| blocked`), `attempts`, `repairs`, monotonic revision, failure signature, awaiting-verification flag |
| D8 | PASS invalidation | A behaviour-bearing revision counter: a relevant parent `edit`/`write` or Worker run moves the revision past `verifiedRevision`, so an old PASS expires without hashing anything. A documentation-only change does not move it |
| D9 | Repair policy | Maximum 2 repair cycles (3 verifications), plus an early stop when the same failure signature repeats without material progress |
| D10 | Authority | Only the parent decides "this work unit is verified", from a valid Verify PASS. Worker and Verify report; they never mark verified |
| D11 | Routing rule | A behaviour-bearing change produced by Worker requires Verify before it can be considered complete; documentation-only paths do not |
| D12 | Model resolution | Priority: `AIES_VERIFY_MODEL` env > `aies.json` (`agents.verify.model`) > parent session model |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Shared command guard and Verify read-only policy | `3831dc0`, `7cfb34a`, `dc32b9f` | `feat(agents): add independent verification workflow` |
| T2 Verify handoff schema, defect list and failure signature | `3831dc0` | same commit |
| T3 Verification state, PASS invalidation and repair policy | `3831dc0`, `7cfb34a` | same commit, refined by the review fix |
| T4 Verify role prompt and isolated child runner | `3831dc0` | same commit |
| T5 Routing, delegate, model and session wiring for the Verify route | `3831dc0` | same commit |
| T6 Test suite: `tests/verify.test.mjs` | `3831dc0`, `7cfb34a` | same commit |
| T7 Smoke E2E: `tests/smoke-verify.test.mjs` (FAIL -> repair -> PASS) | `3831dc0` | same commit |
| T8 Observability: verification section in the footer and `/aies-status` | `ba35279` | `feat(observability): surface verification state` |
| T9 Profile configuration: `agents.verify.model` seed | `3831dc0` | same commit |
| T10 Documentation: architecture, decision D11, README, phase record | this commit | `docs: record the AIES-005 verification phase` |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Full test suite | `npm test` | 147/147 pass (108 before this phase) |
| Isolation script | `npm run check:isolation` | pass (same 147 checks under a temporary `AIES_HOME`) |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| Extension loadability | dynamic import of both extension entry points; RPC `get_commands` under a temporary `AIES_HOME` | both export a function, no `extension_error` |
| Fresh context | `tests/verify.test.mjs` | parent/Worker sentinel absent unless it is part of the criteria; the same assertion is proven non-vacuous |
| Guard bypass | `tests/verify.test.mjs` | command substitution, `find -delete`/`-exec` and `xargs` refused; three policy holes found in review and closed before closing the phase |
| No mutation tools | `tests/verify.test.mjs` | `VERIFY_TOOLS` and the child session contain no `edit`/`write`; 46 blocked command forms plus 3 command-substitution bypasses asserted |
| Checks available | `tests/verify.test.mjs` | the child reads the real file and runs the real check inside its session transcript |
| Git inspection | `tests/verify.test.mjs` | `status`, `diff`, `diff --stat`, `show`, `log`, `blame`, `ls-files` allowed; every mutating subcommand blocked |
| PASS real | `tests/smoke-verify.test.mjs` | PASS only after the artifact actually holds 2000 |
| FAIL real | `tests/verify.test.mjs`, `tests/smoke-verify.test.mjs` | FAIL with a blocking defect when the artifact holds 1500/1000 |
| Worker lie | `tests/verify.test.mjs`, `tests/smoke-verify.test.mjs` | the claim never enters the prompt; the repository decides the verdict |
| BLOCKED is not FAIL | `tests/verify.test.mjs` | exit 127 on a check yields `blocked`, and the policy stops instead of repairing |
| No self-repair | `tests/verify.test.mjs` | tree hash identical before/after a FAIL run; blocked mutations never reach the shell |
| PASS invalidation | `tests/verify.test.mjs`, `tests/observability.test.mjs` | status returns to `none`, `valid` false, footer `V:STALE`, while a docs-only edit keeps the PASS valid |
| Repair cycle | `tests/verify.test.mjs`, `tests/smoke-verify.test.mjs` | FAIL -> repair -> fresh Verify -> PASS, 2 attempts and 1 repair |
| Repair limit | `tests/verify.test.mjs` | third repair denied: `repair budget exhausted (2 cycles)` |
| Same failure protection | `tests/verify.test.mjs` | two identical signatures stop before the budget is spent |
| Metrics isolation | `tests/verify.test.mjs` | one parent tool call per delegation; zero parent reads, searches or shell inspections |
| Plain Pi unchanged | `pi --version` | 0.85.1 starts unchanged |
