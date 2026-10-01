# AIES-010 - Gentle-inspired Pi UX & TUI

Status: complete (one interactive check handed to the user)
Branch: `feat/aies-010-gentle-inspired-ux`
Scope: Phase 10 of AIES (visual/product layer only: information hierarchy, workflow
vocabulary, footer, agent activity components, permission-ask presentation,
BLOCKED/DONE summaries, human `/aies-status`, command audit, UI-only rendering)

## Handed over

Every automated check is green and the real-terminal smoke covers the footer, the
narrow-terminal degradation, the headless path and all four commands through a real
Pi process. What an agent cannot observe is a human watching a child work: the live
card, the TTL tail, the permission dialog and the DONE/BLOCKED entries were verified
through the real renderers and a real extension host, but the interactive flow
(child + approval at a real terminal) needs a model credential that the isolated
profile deliberately does not have. `docs/UX.md` §6-§12 states the exact strings to
expect; the checklist is in the final report of this phase.

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
| T1 Audit gentle-pi UI surface | `dc0bcc4` | `docs(ux): audit gentle-pi's visual surface and freeze the AIES-010 design` |
| T2 Design: hierarchy, vocabulary, components | `dc0bcc4` | (same commit as T1) |
| T3 `extensions/aies-ui/` presentation module + unit tests | `f8441ac` | `feat(ui): add the pure AIES presentation module and the new footer contract` |
| T4 Footer redesign + width degradation | `1f20c7f` | `feat(ui): wire the footer, the activity card and the session view into the runtime` |
| T5 Agent activity widget + finished-child entries | `1f20c7f` | (same commit as T4) |
| T6 Verify/repair presentation | `1f20c7f` | (same commit as T4) |
| T7 Permission ASK presentation | `a445fe4` | `feat(ui): present permission requests as an actionable approval card` |
| T8 BLOCKED and DONE summaries | `1f20c7f` | (same commit as T4) |
| T9 Human `/aies-status` + command audit | `1f20c7f`, `9535fe6` | `feat(ui): put /aies-run status on the shared vocabulary` |
| T10 Tests: invariants, headless, no-pollution | `f8441ac`, `1f20c7f` | `tests/aies-ui.test.mjs` (29) + `tests/aies-ui-seam.test.mjs` (9) |
| T11 Docs: ARCHITECTURE, DECISIONS, UX | `dc0bcc4`, `4e7d08e` | `docs(ux): record the gentle-pi audit confirmations and the footer ready rule` |
| T12 Manual visual smoke | - | real pty capture + real RPC runs, evidence below |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Baseline before the phase | `npm test` | 260/260 pass on `feat/aies-009-bounded-autonomy` |
| Full test suite | `npm test` | **299/299 pass**, 0 fail, 78 suites |
| Isolation script | `npm run check:isolation` | 299/299 pass under a temporary `AIES_HOME` |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| UI imports nothing from Pi | `grep -rn "@earendil-works\|sendMessage" extensions/aies-ui/` | no match |
| No raw ANSI in the module | `grep -rn "x1b\[" extensions/aies-ui/` | no match |
| No `pi-tui` dependency added | `grep -rn "@earendil-works/pi-tui" extensions/` | no match |
| Real TUI footer (pty) | `PI_TUI_WRITE_LOG` over a real `script` pty | `AIES · ready · ctx 0` rendered as one line |
| Real TUI at 40 columns (pty) | same, with `stty cols 40` | `AIES · ready · ctx 0`, no wrap, no break |
| Real `/aies-status` | RPC `prompt "/aies-status"` through `bin/aies` | human view: `Run`/`Contexto`/`Permisos` |
| Real `/aies-status detalle` | RPC `prompt "/aies-status detalle"` | full 48-line report intact |
| Real `/aies-run status` | RPC `prompt "/aies-run status"` | autonomy view + pointer to `/aies-status` |
| Full-flow surface dump | real appliers + real renderers, throwaway driver | footer/card/entry/DONE/BLOCKED/approval/narrow text captured in `docs/UX.md` §5-§13 |

## Findings (reported, not fixed here)

- `odd/tasks/` has no `aies-009-*.md`: AIES-009 is documented in
  `docs/ARCHITECTURE.md` and by decision D15, but the phase task record is
  missing. Recorded here as an observation; this phase does not rewrite AIES-009.
- The child model a user configured per role (`aies.json` -> `agents.<role>.model`)
  is resolved inside the child session and is not observable by the parent. The
  activity card therefore shows no model. Exposing it needs a getter on
  `extensions/aies-agents/session.ts`, which is a wiring change, not a UX one.
- `ContinuationController` exposes no activation timestamp, so `/aies-run status`
  cannot print how long autonomy has been running. Same category as above.
- Pi's native footer already renders a context percentage next to the AIES
  segment. AIES shows absolute tokens instead, so the two are complementary
  rather than duplicated, but a reader now sees both. Recorded, not changed.
