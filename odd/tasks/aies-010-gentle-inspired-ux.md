# AIES-010 - Gentle-inspired Pi UX & TUI

Status: in progress
Branch: `feat/aies-010-gentle-inspired-ux`
Scope: Phase 10 of AIES (visual/product layer only: information hierarchy, workflow
vocabulary, footer, agent activity components, permission-ask presentation,
BLOCKED/DONE summaries, human `/aies-status`, command audit, UI-only rendering)

## Goal

Turn the functional v1 architecture (AIES-001..009) into one coherent, quiet and
readable experience inside Pi. Study gentle-pi as a product reference, keep only
the ideas that transfer, and express them through Pi's public extension API.

## Hard constraints (user-stated)

- No new agents, no new subsystems, no new intelligence.
- The AIES cast stays: Parent, Explore, Worker, Verify, Linear, Context,
  Permissions, Autonomy.
- No own UI framework, no component registry, no `packages/ui`, no state
  management layer. Pi remains the UI runtime.
- UI is a projection of runtime state. Never the other way around.
- Nothing outside the visual/product scope changes: routing policy, Verify
  semantics, sandbox, Context Governor thresholds, Linear Done Gate, continuation
  decisions, repair limits and model routing stay untouched.
- UI updates must not enter the parent's conversation context.
- Headless/RPC without UI must keep working.

## Non-goals (deferred)

Memory, web dashboard, own sidebar, persistent agent-history browser, parallel
agents, new autonomy, new Linear behaviour, git automation, PR/push, own cost
accounting. All of that is out of scope for AIES-010.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Presentation home | New pure module `extensions/aies-ui/`: no Pi import, no state, no decisions. `aies-runtime` and `aies-agents` import it for strings. No new extension is registered. |
| D2 | Workflow vocabulary | Exactly one stage dimension: `IDLE, EXPLORE, WORK, VERIFY, REPAIR, WAIT, BLOCKED, DONE`. Everything else is an independent indicator (`AUTO`, context, verification, sandbox). |
| D3 | Footer | `AIES · <ticket|ready> · <STAGE> · ctx <n> · AUTO?` plus alarm-only segments. Never a telemetry dump, never a percentage, never a permanent ceiling. |
| D4 | Live activity | One widget per active child (`setWidget`), updated in place, cleared when the child ends. Never a message, never a tool-call list, never a transcript. |
| D5 | Finished activity | One compact transcript line per finished child through `appendEntry` + `registerEntryRenderer`: rendered, persisted, and outside the LLM context. |
| D6 | No context pollution | Progress and summaries use `setStatus` / `setWidget` / `appendEntry` / `notify` only. `sendMessage` is never used for UI. |
| D7 | Escape hatches | Every new surface degrades to silence: broken projection, non-TUI mode and narrow terminals must never change workflow behaviour. |
| D8 | Elapsed time | One shared `formatDuration` (00:14 / 02:31 / 1:04:22) and a single timer, owned by the runtime observer. |
| D9 | Cost/tokens | Context tokens only (Pi's own `getContextUsage`). No per-child token or cost accounting in v1. |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Audit gentle-pi UI surface | T1 | `docs(ux): audit gentle-pi visual surface and AIES current UX` |
| T2 Design: hierarchy, vocabulary, components | T1 | (same commit as T1) |
| T3 `extensions/aies-ui/` presentation module + unit tests | T2 | `feat(ui): add a pure AIES presentation module` |
| T4 Footer redesign + width degradation | T3 | `feat(ui): redesign the footer as a projection of workflow state` |
| T5 Agent activity widget + finished-child entries | T3 | (same commit as T4) |
| T6 Verify/repair presentation | T3 | (same commit as T4) |
| T7 Permission ASK presentation | T4 | `feat(ui): present permission requests as an actionable approval card` |
| T8 BLOCKED and DONE summaries | T4 | (same commit as T7) |
| T9 Human `/aies-status` + command audit | T5 | `feat(ui): make /aies-status a human view and audit the command set` |
| T10 Tests: invariants, headless, no-pollution | T6 | `test(ui): cover footer, activity, approval, summaries and headless degradation` |
| T11 Docs: ARCHITECTURE, DECISIONS, UX | T7 | `docs(ux): document the AIES visual system and its boundaries` |
| T12 Manual visual smoke | - | manual, evidence in this file |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Baseline before the phase | `npm test` | 260/260 pass on `feat/aies-009-bounded-autonomy` |
| Full test suite | `npm test` | pending |
| Isolation script | `npm run check:isolation` | pending |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | pending |
| Manual visual smoke | `aies` in a real terminal | pending |

## Findings (reported, not fixed here)

- `odd/tasks/` has no `aies-009-*.md`: AIES-009 is documented in
  `docs/ARCHITECTURE.md` and by decision D15, but the phase task record is
  missing. Recorded here as an observation; this phase does not rewrite AIES-009.
