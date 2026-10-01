# AIES-007 - Context Governor

Status: complete
Branch: `feat/aies-007-context-governor`
Scope: Phase 7 of AIES (Context Governor, operational budgets and zones, safe proactive compaction at agent_settled, tool-output hygiene, operational ceiling guardrails, and observability integration)

## Goal

Establish the Context Governor as the single conceptual authority governing the Parent session context size
in AIES. Decouple AIES operational budgets from provider context windows (e.g. 1M tokens), preventing
context bloat, reasoning degradation, and cost/latency inflation. Prioritize delegation to isolated child
agents (`aies_delegate`) as the primary prevention mechanism, enforce proactive single-flight compaction
at safe turn boundaries (`agent_settled`), sanitize oversized tool results (> 32k chars) while protecting
structured child handoffs, and impose an operational ceiling blocking heavy tools while keeping delegation unblocked.

## Non-goals (out of scope for this phase)

Linear issue tracking, AIES-008 task loops, autonomous multi-turn continuation, mutating Pi runtime internals,
or modifying the ambient user environment.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Single conceptual authority | `ContextGovernor` (`extensions/aies-agents/context-governor.ts`) owns context budgets, zones, compaction scheduling, and tool result hygiene |
| D2 | Operational budget vs Provider window | AIES defines healthy working memory budgets (target 80k, pressure 100k, compact 120k, ceiling 150k) independent of the provider's physical 1M+ window |
| D3 | Delegation primary, compaction secondary | Child agents absorb large exploratory dumps and check outputs; compaction is a secondary safety net for accumulated Parent conversation |
| D4 | Adaptive budget scaling | Scaled dynamically for smaller models: `effectiveThreshold = min(absoluteThreshold, floor(ratio * contextWindow))` |
| D5 | Safe turn boundary compaction | Proactive compaction executes strictly on `agent_settled` (when assistant and tools are idle), never mid-turn or during tool execution |
| D6 | Async serialization (Single-flight) | Wraps Pi's callback-based `ctx.compact({ customInstructions, onComplete, onError })` into a Promise to guarantee sequential single-flight execution |
| D7 | Curated compaction prompt | `AIES_COMPACTION_INSTRUCTIONS` preserves architectural decisions, file paths, active work units, verification status, and constraints |
| D8 | Tool-output hygiene | Head+tail truncation for parent tool results exceeding 32,000 chars (retains 8k head + 4k tail with omission notice) |
| D9 | Handoff protection | `aies_delegate` outputs are strictly exempt from truncation to guarantee verdict, defect, and evidence integrity |
| D10 | Operational ceiling | Tokens >= 150k block direct heavy tools (`read`, `edit`, `write`, searches, heavy bash); `aies_delegate` remains strictly allowed |
| D11 | Observability integration | Telemetry synced into `AiesState`; `/aies-status` renders `Context governor:` block; footer displays pressure (`ctx ...!`) and compacting status |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Configuration: context budgets in `profile/aies.json` | this branch | `feat(context): add context budget configuration to profile` |
| T2 Context Governor engine: calculations, truncation, async compaction | this branch | `feat(context): implement ContextGovernor engine and compaction lifecycle` |
| T3 Routing & guardrail integration: context pressure and operational ceiling | this branch | `feat(context): enforce context pressure and ceiling guardrails in routing` |
| T4 Observability & footer: telemetry sync, `/aies-status`, and footer indicator | this branch | `feat(observability): integrate context governor telemetry and status reporting` |
| T5 Unit & smoke tests: `tests/context-governor.test.mjs`, `tests/smoke-context.test.mjs` | this branch | `test(context): add comprehensive unit and smoke test suites for context governor` |
| T6 Documentation & task record: Architecture, decisions, and task record | this branch | `docs: document Context Governor architecture and record AIES-007 task` |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Full test suite | `npm test` | 195/195 pass across 42 test suites |
| Isolation script | `npm run check:isolation` | pass (same 195 checks under temporary `AIES_HOME`) |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| Launcher info | `bin/aies --aies-info` | clean (resolves isolated profile) |
| Default budgets (1M window) | `tests/context-governor.test.mjs` | Target 80k, pressure 100k, compact 120k, ceiling 150k |
| Scaled budgets (128k window) | `tests/context-governor.test.mjs` | Target 51.2k, pressure 64k, compact 76.8k, ceiling 96k |
| Zone calculation | `tests/context-governor.test.mjs` | Correctly resolves green, amber, pressure, compact, ceiling zones |
| Safe boundary trigger | `tests/context-governor.test.mjs` | Compaction triggers on `agent_settled` when zone >= compact; never mid-turn |
| Single-flight lock | `tests/context-governor.test.mjs` | Concurrent compactions prevented; returns same in-flight Promise |
| Async serialization | `tests/context-governor.test.mjs` | Wraps Pi callback into Promise; resolves on `onComplete`, rejects on `onError` |
| Curated instructions | `tests/context-governor.test.mjs` | Compaction passes `AIES_COMPACTION_INSTRUCTIONS` with decision retention |
| Post-compaction null tokens | `tests/context-governor.test.mjs` | Handles `tokens: null` gracefully right after compaction |
| Head+tail truncation | `tests/context-governor.test.mjs` | Outputs > 32k truncated to 8k head + 4k tail with omission notice |
| Small outputs untouched | `tests/context-governor.test.mjs` | Tool outputs <= 32k characters preserved completely |
| Handoff exemption | `tests/context-governor.test.mjs` | `aies_delegate` outputs strictly exempt from truncation |
| Operational ceiling block | `tests/context-governor.test.mjs` | Tokens >= 150k blocks read, write, edit, search, heavy bash |
| Ceiling delegation allowed | `tests/context-governor.test.mjs` | `aies_delegate` remains strictly allowed under ceiling |
| Context pressure routing | `tests/context-governor.test.mjs` | Zone >= amber adds soft pressure signal to delegate |
| Telemetry sync & snapshot | `tests/context-governor.test.mjs` | `AiesState` tracks zone, compactions, truncations, ceiling hits |
| `/aies-status` rendering | `tests/observability-runtime.test.mjs` | Renders `Context governor:` block with zone, budgets, and compaction stats |
| Footer indicator | `tests/observability-runtime.test.mjs` | Renders `ctx ...!` on pressure and `compactando` during compaction |
| E2E smoke tests | `tests/smoke-context.test.mjs` | Tool hygiene, compaction lifecycle ordering, launcher profile integration |
