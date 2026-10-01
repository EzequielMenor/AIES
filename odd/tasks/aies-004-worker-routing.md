# AIES-004 - Worker + Routing

Status: complete
Branch: `feat/aies-004-worker-routing`
Scope: Phase 4 of AIES (Worker child agent and parent routing policy)

## Goal

Add an isolated Worker child agent capable of implementing concrete work units,
and introduce parent routing policy across Inline Direct, Explore, and Worker routes
with soft signals and hard guardrails to prevent parent context inflation.

The parent retains coordination and small inline work, Explore discovers, and Worker
modifies.

## Non-goals (out of scope for this phase)

Verify agent, Reviewer, Planner, Debugger, linear workflow, persistent memory,
proactive compaction, complete context governor, autopilot, background daemons,
parallel workers, automatic worktrees, remote push/PR/deploy, or universal permission
sandbox.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Delegation roles | `aies_delegate({ role: "explore" \| "worker", task, context? })` registered on parent |
| D2 | Worker tool surface | `read`, `grep`, `find`, `ls`, `tgrep`, `edit`, `write`, and guarded `bash` |
| D3 | Command security guard | Strict blocking of `git clean`, `git reset --hard`, `git checkout --`, `git restore`, `git push`, `git merge`, `git rebase`, `git branch -D`, mass `rm`, `sudo`, `deploy`, and `publish` |
| D4 | Worktree protection | Inspect git status, no reset/stash of pre-existing uncommitted changes, return `blocked` on conflicting modifications |
| D5 | Context isolation | Child session spawned via `createAgentSession` with fresh in-memory session manager; parent sentinels/history never leak |
| D6 | Metrics isolation | Child session uses `noExtensions: true`, preventing child tool calls from inflating parent metrics |
| D7 | Structured handoff | Schema: `status` (done/blocked/failed), `summary`, `changes`, `checks`, `issues`, `next` (max 1 step). Capped defensively (< 6,000 chars) |
| D8 | Model resolution | Priority: `AIES_WORKER_MODEL` env > `aies.json` (`agents.worker.model`) > parent session model |
| D9 | Routing routes | `INLINE` (small/trivial), `EXPLORE` (discovery, >2 files), `WORKER` (implementation, multi-file changes) |
| D10 | Routing thresholds | Reads: 3 soft / 5 hard stop. Tool calls: 7 soft / 12 hard stop. Boundary reset on delegation |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Role prompt: `agents/worker.md` | this commit | `feat(agents): add isolated worker and parent routing` |
| T2 Shared child session: `extensions/aies-agents/session.ts` | this commit | same commit |
| T3 Command security guard: `extensions/aies-agents/worker-guard.ts` | this commit | same commit |
| T4 Worker handoff: parser and defensive formatter in `handoff.ts` | this commit | same commit |
| T5 Worker runner: `extensions/aies-agents/worker.ts` | this commit | same commit |
| T6 Generalized model resolution: `extensions/aies-agents/model.ts` | this commit | same commit |
| T7 Parent routing policy & guardrails: `extensions/aies-agents/routing.ts` | this commit | same commit |
| T8 Delegation expansion: `aies_delegate` supporting worker in `delegate.ts` | this commit | same commit |
| T9 Observability updates: duration and outcome tracking in runtime state & status | this commit | same commit |
| T10 Profile configuration: add `agents.worker.model` seed in `profile/aies.json` | this commit | same commit |
| T11 Test suite: `tests/worker.test.mjs`, `tests/routing.test.mjs`, `tests/smoke.test.mjs` | this commit | same commit |
| T12 Documentation: architecture, decision D10, task record | this commit | same commit |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Worker test suite | `node --test tests/worker.test.mjs` | 20/20 pass |
| Routing test suite | `node --test tests/routing.test.mjs` | 8/8 pass |
| Smoke test suite | `node --test tests/smoke.test.mjs` | 1/1 pass |
| Full test suite | `npm test` | 108/108 pass |
| Isolation script | `npm run check:isolation` | pass |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| Command guard | `tests/worker.test.mjs` assertions | git clean, reset --hard, push, sudo, mass rm blocked |
| Context isolation | `tests/worker.test.mjs` assertion | parent secret not present in child transcript |
| Trivial inline allowed | `tests/routing.test.mjs` Caso 1 | 1 read + 1 edit proceeds inline |
| Soft reads pressure | `tests/routing.test.mjs` Caso 2 | soft signal at 3 reads, execution continues |
| Hard reads stop | `tests/routing.test.mjs` Caso 3 | 5th+ exploratory read blocked with feedback |
| Tool budget stop | `tests/routing.test.mjs` Caso 4 | 12 tools reached blocks arbitrary direct tool calls |
| Boundary reset | `tests/routing.test.mjs` Caso 5 | boundary counters reset on delegation, telemetry preserved |
| Multi-file worker trigger | `tests/routing.test.mjs` Caso 6 | multi-file changes delegate to Worker |
| Real smoke flow | `tests/smoke.test.mjs` | Parent -> Explore -> Worker -> Parent with <10% parent context |
| Plain Pi unchanged | `pi --version` | 0.85.1 starts unchanged |
