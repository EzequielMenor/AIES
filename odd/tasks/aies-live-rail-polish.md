# AIES live-rail polish — integration, real observability, active-agent card, /agents modal

Presentation/observability-only closure on top of the Pi 0.87 rail fix. No architecture,
routing, Linear, autonomy, permissions, or AIES-011 work.

## Objective

Ship one consistent, executable branch where the right rail reports REAL live data
(elapsed time of the current stage, real cost or `—`, tokens that repaint during a run),
a small fixed active-agent card sits above the composer while a child agent runs, and
`/agents` reads as the same modal system as `/aies-models`.

## Problem and rationale

- The user runs `feat/aies-010d-fullscreen-shell`; the validated visual polish lives on
  `feat/aies-ui-final-observational-polish` (3 visual commits, descendant of the 010d tip)
  and is not integrated yet.
- Real runs still show: rail cost late or stuck at `0`, rail time not tracking the run,
  a flat/static right rail without hierarchy, no in-run active-agent card, and `/agents`
  needing to be a floating read-only modal in the `/aies-models` visual language.

## Scope (exact)

A) Branch integration: start from the 010d base (Pi 0.87 rail fix), fast-forward the polish
   commits in, end with one consistent executable branch, no duplicated/parallel variants.
B) Real cost/time: current-stage elapsed time; real cost only when it exists; `—` (never a
   fake `$0.00`) when absent; provider without pricing → `—`/`n/d`; main/agents/total tokens
   repaint during the run.
C) Active-agent card: fixed small card above the input while a child agent is active —
   role/agent, short task summary, elapsed time, tokens, optional reliable cost/status;
   disappears when the run ends; same theme/borders as the rest of AIES.
D) `/agents` modal: centered floating modal framed like `/aies-models`; left column session
   agent list + status, right column selected-agent detail (model, provider, time, tokens,
   cost, context, tools, recent activity, final result when finished); read-only.
E) Right-rail hierarchy: clear titles/accents, differentiated labels vs values, highlighted
   states (IDLE, EXPLORE, WORK, VERIFY, DONE), well-separated sections; AIES theme
   consistency across modal/card/footer.
F) Validation: focused tests, real TUI smoke if credentials allow; explicit split between
   suite-validated and manually validated; report with evidence for time/cost/tokens.

## Explicit non-scope

No routing, Linear, autonomy, permissions, context governor, fullscreen/right-rail
architecture, release/README/website, AIES-011, no new front ends.

## Constraints

- Pi stays the runtime; only public `ctx.ui`/overlay seams already used by AIES.
- Pure `extensions/aies-ui/` renderers stay Pi-free; colors only from the existing
  theme/Paint adapter; no hardcoded ANSI, no second theme system.
- Never estimate or fabricate telemetry: missing cost/time/tokens render `—`.
- `/agents` is read-only observation; no child navigation, no session opening, no model calls.
- Writes single-threaded through `gentle-ai-worker` with narrow allowed edit surfaces.

## TDD and delivery

- TDD: enabled (inherited from the AIES-010D regression-first convention).
- Runner: focused `node --test <files>`, then `npm test`, `npm run check:isolation`,
  `bash -n bin/aies scripts/*.sh`.
- Route: 4-file mapping trigger fires → `gentle-ai-explore` scout; every multi-file
  implementation task → `gentle-ai-worker`; verification runs → `gentle-ai-verify`.
- Delivery: work-unit commits on the feature branch; no push/PR/release.

## Tasks

| # | Task | Status | Evidence |
|---|------|--------|----------|
| T1 | Integrate polish commits into the 010d base (ff), single consistent branch | complete | ff `458b238`→`9c47849`, 0 conflicts, 3 polish commits + their 788-test validation on top of the Pi 0.87 rail fix |
| T2 | Scout: map rail cost/time/tokens data flow + active-child lifecycle + modal seams | complete | `gentle-ai-explore` map: root causes for fake `$0.00` (Agents bucket seeded `{cost:0}`), stale time (delegations never set `runUsage.startedAt`), 5s repaint clock, unapplied `STAGE_TONE`, activity card suppressed by `!railShowing` |
| T3 | Real rail observability: real elapsed stage time, real cost or `—`, live token repaint | complete | RED 8+3 → GREEN `tests/rail-live-metrics+run-telemetry+aies-panel+fullscreen-shell+aies-ui` 153/153; full suite 818/818; `git diff --check` clean. Root causes: unknown cost buckets are `null` (no fake `$0.00`, observed 0 still `$0.00`); `activeRunElapsed` prefers `delegations.activeStartedAt`, freezes at `runEndedAt`, `—` at IDLE; parent cost cache no longer latches unknown; 1s clock while run/delegation active |
| T4 | Fixed active-agent card above the composer (appear/finish lifecycle) | complete | RED 2 → GREEN `tests/active-agent-card+aies-ui-seam+empty-state` 45/45 + regressions 66/66. Root cause: `syncActivity` gated the card on `!railShowing`; now registers whenever `isActivityVisible` (clears on `finishedAt`), 1s tick repaints elapsed, boxed width ≤72, cost only when observed |
| T5 | Right-rail visual hierarchy (titles, labels/values, state chips, sections) | complete | RED 7 → GREEN `tests/rail-hierarchy` 10/10 + `aies-ui+aies-panel+fullscreen-shell` 119/119 + `rail-live-metrics+run-telemetry` 44/44. Labels `muted`, values `text`, `Etapa` = `STAGE_TONE` + glyph, agent rows per lifecycle tone, values aligned via plain-measured `StatusRow` (color never changes layout), height-pressure invariants intact |
| T6 | `/agents` final modal aligned with `/aies-models` visual system | complete | RED 6 → GREEN `tests/agents-view+observatory-ui+modal-frame` 48/48 + 24/24 regressions; zero line overflows widths 1–200. Field map: modelo/proveedor/tiempo/tokens/coste/`contexto`(structural `—`)/herramientas/actividad(≤5)/resultado final; left list state chips toned (`running/success/error/warning`) + `selection`; read-only regression test (Enter/space/tab/letters do nothing, no message/model/tool call); `modal.ts` untouched |
| T6b | Fix fabricated `$0.00` cost at IDLE (found by the live smoke, not by unit tests) | complete | Root cause: sampler `parentUsageOf()` returned `{totalTokens:0, cost:0}` with `costKnown:true` for an empty session and `applyRunUsage` adopted it as observed. Fix in `state.ts`: an all-zero parent sample degrades to unknown end-to-end (a genuinely observed 0 still renders `$0.00`). RED 4/5 → GREEN 49/49; `npm test` **845/845**; `tests/idle-cost.test.mjs` reproduces through the real appliers + `renderRightRail`. Known note (out of scope): the `costKnown:true` seed at `runtime/index.ts:615` still exists; neutralized by the state guard, only consumer is `applyRunUsage` |
| T7 | Validation: focused + full gates, TUI smoke, split suite/manual evidence, report | complete | Gates (`gentle-ai-verify`): `npm test` **845/845** (175 suites), `npm run check:isolation` 845/845, `bash -n bin/aies scripts/*.sh` OK, `git diff --check` clean. Live smoke (isolated `AIES_HOME=/tmp/aies-rail-smoke2`, Pi 0.87.0, tmux 120×40): idle rail truthful (`grep '$0.00'` = 0, `Tiempo —`, tokens `—`), `/agents` + `/aies-models` open/close centered (88 col, margins 16/16 — display-column measurement overturns the byte-based "not centered" claim); captures in `/tmp/aies-rail-smoke*/`. NOT VALIDATED (HTTP 401 invalid key, 2 attempts): live run time/token advance, observed run cost, non-IDLE stage glyph live, child-card liveness, populated `/agents` detail — suite-only until a valid credential. Commits: `6d4e815` (agents modal), `21d43b5` (rail metrics + card + hierarchy), `419e59c` (docs) |

## Acceptance criteria

1. One branch containing the 0.87 rail fix and the visual polish; `npm test` and
   `npm run check:isolation` green on it.
2. During a real run the rail shows the elapsed time of the current stage and repainting
   main/agents/total tokens; no fake `$0.00` ever renders — missing cost is `—`.
3. While a child agent runs, a fixed themed card above the composer shows agent, short task,
   time and tokens; it disappears when the run finishes.
4. `/agents` is a centered bordered read-only modal in the `/aies-models` language with
   list-left / detail-right and every required detail field (missing values render `—`).
5. Rail sections read as hierarchy: clear titles, label/value differentiation, highlighted
   stage states, consistent theme with modal/card/footer.
6. No routing/Linear/autonomy/permissions/architecture diff in the final changeset.

## Progress and evidence

- T1 ff integration `458b238`→`9c47849`; polish history (3 commits + 788-test validation) now on the single branch the user runs.
- T3/T4/T5/T6/T6b each followed strict TDD (RED observed → GREEN) with focused suites; full-suite progression 818 → 840 → **845/845**.
- Gates (verifier `gentle-ai-verify`): `npm test` 840/840 at gate time (before T6b, then 845/845 after), `npm run check:isolation` green, `bash -n bin/aies scripts/*.sh` green, `git diff --check` clean. Final repetition after T6b in progress.
- Live TUI smoke (isolated `AIES_HOME=/tmp/aies-rail-smoke`, Pi 0.87.0, tmux 120×40):
  - PASS: launcher isolation, rail docked right, `Tiempo —` / Tokens `—` at IDLE, `/agents` open + j/k + Esc (read-only, empty state), `/aies-models` open + j + Esc, same frame language (border/title/help).
  - FALSE POSITIVE overturned: the verifier's "modals not centered" claim came from byte-based measurement; display-column measurement shows `/agents` cols 16–103 (88 wide, margins 16/16) and `/aies-models` cols 15–103 — both centered.
  - REAL DEFECT found and fixed: fabricated `Coste Main/Total $0.00` at IDLE (T6b); recheck capture pending.
  - NOT VALIDATED (blocked by provider, HTTP 401 `API key is invalid`, 2 attempts then stopped): live stage-time advance during a run, live token repaint during a run, real observed cost during a run, stage glyphs for a non-IDLE stage in a real run, active-agent card during a real child delegation, populated `/agents` detail column. These remain covered by unit/integration tests only until a valid credential is available.
- Unrelated concurrent working-tree changes (README.md, docs/DECISIONS.md, tests/isolation.test.mjs, extensions/aies-provider-commandcode/, scripts/refresh-commandcode-models.mjs, tests/commandcode-provider.test.mjs) were never touched by this feature.
