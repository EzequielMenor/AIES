# AIES-008 - Linear Ticket Workflow

Status: complete
Branch: `feat/aies-008-linear-ticket-workflow`
Scope: Phase 8 of AIES (Linear Ticket Workflow as operational unit of work, Parent ownership, child isolation, compact operational contract, transport abstraction with deterministic fake, programmatic Done Gate, remote conflict detection, snapshot persistence, and observability integration)

## Goal

Establish Linear tickets as the **operational unit of work** for an AIES parent session.
Linear serves as the external source of truth for active ticket identifiers, status, acceptance criteria,
and project metadata, while never serving as memory, repository context, backlog dump, or giant prompt.
Enforce single ownership in the Parent session, strict exclusion of Linear tools and schemas from child agents
(Explore, Worker, Verify), safe normalization into compact contracts (< 2,500 chars), robust transport abstraction
with in-memory deterministic fakes, programmatic Done Gate enforcement tied to independent verification (AIES-005),
remote conflict protection, and persistence across Pi session boundaries.

## Non-goals (out of scope for this phase)

Autonomous task continuation, picking the next ticket from the backlog automatically, multi-turn task loops,
git push, pull requests, or merge actions (strictly deferred to AIES-009).

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Parent ownership | Parent session is the sole owner of Linear; child agents (Explore, Worker, Verify) have no Linear tools, no Linear MCP, and no direct issue mutations |
| D2 | Tool budget | Budget capped at +1 tool (`aies_ticket`) and 1 command (`/aies-ticket`); active tools expand from 8 to 9 in Parent, 0 in children |
| D3 | Compact contract | Normalizes raw payloads into a compact contract strictly bounded under 2,500 chars (`formatCompactContract`), extracting explicit checklist criteria and flagging ambiguities |
| D4 | Transport abstraction | `LinearTransport` interface decoupling policy from network; `FakeLinearTransport` for deterministic, offline testing; `McpLinearTransport` with typed error classification |
| D5 | Single ticket per session | 1 Linear ticket = 1 logical parent session. Switching tickets while one is in progress requires explicit completion or forced confirmation |
| D6 | Start transition | Loading a ticket sets `workState = "loaded"` without remote mutation; calling `start` explicitly transitions Linear status to started ("In Progress") |
| D7 | Programmatic Done Gate | Behavior-bearing changes require a fresh, valid Verify PASS (`verifiedRevision === revision && verification.status === "pass"`). Stale PASS, fail, blocked, or none strictly deny Done. Docs-only changes complete without Verify |
| D8 | Remote conflict detection | `completeTicket()` queries remote ticket before updating; if remote state transitioned to completed or canceled externally, completion is blocked to avoid overwriting |
| D9 | Session persistence | Ticket state serialized to Pi session entry `aies-ticket` on `agent_settled`; restored on resume without remote network calls |
| D10 | Observability integration | Active ticket identifier displayed in footer (`AIES · EZE-123 · ...`); dedicated `Ticket:` section in `/aies-status` |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Linear Subsystem Architecture | this branch | `feat(linear): implement linear transport, contract normalizer, manager, and policy` |
| T2 Parent Tool & Command | this branch | `feat(linear): register aies_ticket tool and /aies-ticket command in parent session` |
| T3 Observability & Status Integration | this branch | `feat(observability): integrate active ticket state into runtime state and status report` |
| T4 Procedural Skill | this branch | `feat(skills): add linear-ticket procedural skill and isolation check update` |
| T5 Unit & Smoke Test Suites | this branch | `test(linear): add comprehensive unit and smoke test suites for linear workflow` |
| T6 Documentation & Architecture | this branch | `docs: document Linear ticket workflow in architecture, decisions, and task report` |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Full test suite | `npm test` | 228/228 pass across 60 test suites |
| Isolation script | `npm run check:isolation` | pass (same 228 checks under temporary `AIES_HOME`) |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| Launcher info | `bin/aies --aies-info` | clean (resolves isolated profile) |
| Exact ticket retrieval | `tests/linear.test.mjs` | Queries only requested ticket (`EZE-101`), zero backlog scan |
| Compact contract bound | `tests/linear.test.mjs` | Bounded strictly under 2,500 chars with 40k char description |
| Criteria extraction | `tests/linear.test.mjs` | Extracts checklist items, strips numbers, flags TBD/TODO |
| Child isolation | `tests/linear.test.mjs` | Explore, Worker, Verify tool surfaces contain 0 Linear tools |
| Parent tool definition | `tests/linear.test.mjs` | `aies_ticket` defined on Parent, handles load, start, show, comment |
| Start transition | `tests/linear.test.mjs` | Load leaves remote status unchanged; startWork transitions to started |
| Done Gate enforcement | `tests/linear.test.mjs` | none -> DENY, fail -> DENY, blocked -> DENY, stale PASS -> DENY, fresh PASS -> ALLOW |
| Docs-only completion | `tests/linear.test.mjs` | Completes without Verify when changed paths are markdown/docs only |
| PASS invalidation | `tests/linear.test.mjs` | Work unit mutation increments revision and invalidates PASS; Done DENIED until fresh PASS |
| Remote refresh before Done | `tests/linear.test.mjs` | Remote issue queried before status update |
| Conflict detection | `tests/linear.test.mjs` | External completion or cancellation detected and blocked |
| Session resume | `tests/linear.test.mjs` | Restores active ticket from snapshot without remote network calls |
| Linear unavailable | `tests/linear.test.mjs` | Network error reports sync error without discarding valid local PASS |
| Context hygiene truncation | `tests/linear.test.mjs` | Massive criteria lists truncate with clear hygiene notice |
| Context Governor compatibility | `tests/linear.test.mjs` | Contract classified as normal output; ticket state survives compaction |
| Permissions integration | `tests/linear.test.mjs` | Worker guard blocks remote mutations; ticket switching guarded |
| Dynamic status resolution | `tests/linear.test.mjs` | Resolves custom team status names by type without hardcoding |
| Real smoke happy path | `tests/smoke-linear.test.mjs` | E2E load -> start -> Explore -> Worker -> Verify PASS -> complete in Linear |
| Real smoke defect failure | `tests/smoke-linear.test.mjs` | E2E Worker writes defective code -> Verify FAIL -> Done Gate strictly DENIED |
| Real smoke remote conflict | `tests/smoke-linear.test.mjs` | External completion detected during smoke run -> complete blocked |
| Real smoke missing credentials | `tests/smoke-linear.test.mjs` | Transport without credentials yields typed `auth_unavailable` error |
