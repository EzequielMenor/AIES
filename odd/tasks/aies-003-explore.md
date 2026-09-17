# AIES-003 - Isolated Explore

Status: complete
Branch: `feat/aies-003-isolated-explore`
Scope: Phase 3 of AIES (First delegation primitive)

## Goal

Build and verify the first real delegation primitive of AIES:
The parent session can launch an isolated child `Explore` agent, let it investigate
the repository with a strictly read-only tool surface, and receive only a compact,
structured handoff.

No automatic routing, planner, worker, or compaction policy yet: this phase proves
that the delegation primitive works cleanly and safely.

## Non-goals (out of scope for this phase)

Automatic routing, planner or worker roles, multi-agent orchestration, proactive
compaction, background daemon, Linear synchronization, task memory, or external
review tools.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Delegation tool | Single tool `aies_delegate({ role: "explore", task, context? })` registered on parent |
| D2 | Tool surface | Strictly read-only: `read`, `grep`, `find`, `ls`, and read-only `bash`. Absolutely no `edit` or `write` |
| D3 | Bash guard | Strict safety filter: rejects mutating commands, file redirects (`>`, `>>`), subshell injection, and command substitution |
| D4 | Context isolation | Child session spawned via `createAgentSession` with fresh in-memory session manager; parent transcript/sentinels never leak |
| D5 | Metrics isolation | Child session uses `noExtensions: true`, preventing child tool calls from inflating parent metrics |
| D6 | Structured handoff | Structured schema: `status` (done/blocked/failed), `summary`, `evidence`, `issues`, `next`. Capped defensively (< 6,000 chars) |
| D7 | Model resolution | Priority order: `AIES_EXPLORE_MODEL` env > `aies.json` (`agents.explore.model`) > parent session model |
| D8 | Lifecycle & settlement | Child session cleans up via `session.dispose()` in `finally` |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Role prompt: `agents/explore.md` | this commit | `feat(agents): add isolated explore delegation` |
| T2 Bash guard: safety filter and read-only bash operations | this commit | same commit as T1 |
| T3 Handoff: parser, sanitizer, and defensive formatter | this commit | same commit as T1 |
| T4 Model resolution: env override, config seed, parent fallback | this commit | same commit as T1 |
| T5 Child execution runner: isolated `AgentSession`, tool surface | this commit | same commit as T1 |
| T6 Delegation tool: `aies_delegate` registration with Pi | this commit | same commit as T1 |
| T7 Observability: delegation tracking in state, footer, and `/aies-status` | this commit | same commit as T1 |
| T8 Profile bootstrap: link `agents` and seed `aies.json` | this commit | same commit as T1 |
| T9 Test suite: `tests/explore.test.mjs` verifying isolation and execution | this commit | same commit as T1 |
| T10 Docs: architecture, decision D9, README update | this commit | same commit as T1 |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Explore test suite | `node --test tests/explore.test.mjs` | 17/17 pass |
| Whole test suite | `npm test` | 75/75 pass |
| Isolation script | `npm run check:isolation` | pass |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| Sentinels isolation | test assertion in `explore.test.mjs` | parent secret not present in child transcript |
| Read-only tools | test assertion in `explore.test.mjs` | only read-only tools active; edit/write absent |
| Mutating bash rejected | test assertion in `explore.test.mjs` | rm, touch, sed -i, redirections blocked |
| Safe bash accepted | test assertion in `explore.test.mjs` | git status, cat, grep, find accepted |
| Structured handoff | test assertion in `explore.test.mjs` | done/blocked/failed parsed correctly |
| Output capping | test assertion in `explore.test.mjs` | huge output capped under 6,000 chars |
| Parent metrics isolation | test assertion in `explore.test.mjs` | child tool calls do not increase parent counters |
| Multi-turn tool execution | test assertion in `explore.test.mjs` | child executes tool call and returns evidence |
| Plain Pi unchanged | `pi --version` | 0.85.1 starts unchanged |
