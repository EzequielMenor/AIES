# AIES UI final observational polish

Final presentation-only fixes discovered through dogfooding. This does not reopen the AIES architecture or start a new product phase.

## Objective

Make `/aies-models` and `/agents` read as coherent AIES modal surfaces, move the idle identity toward the upper third of the main pane, and preserve every existing behavior and authority boundary.

## Problem and rationale

- `/aies-models` is functionally correct but lacks a clearly bounded surface, so it reads as transcript text.
- The empty state sits too close to the editor on tall terminals, leaving the main pane visually top-heavy.
- `/agents` is observationally useful but currently replaces the editor and does not repaint an open view when observatory records change.
- The existing Agent Observatory already owns the real ephemeral data. The correct fix is presentation and repaint wiring, not a new log, dashboard, process, or child interaction path.

## Scope

- Add one reusable pure AIES modal-frame/layout primitive using injected theme paint.
- Frame and center `/aies-models` without changing its state machine, persistence, or keyboard behavior.
- Position the existing ephemeral empty state with a bounded, height-aware flow spacer using public TUI information; no absolute screen coordinates and no focused custom overlay.
- Present `/agents` as a larger centered overlay with a selectable session-agent list, real stats, recent mechanical activity, responsive horizontal/vertical layouts, and low-cost event-driven repainting.
- Add focused tests and perform isolated-profile manual validation.

## Explicit non-scope

Do not change routing, autonomy, permissions, context governor, Linear, Verify protocol, agent execution, fullscreen architecture, right-rail architecture, release artifacts, README, website, AIES-011, observatory persistence, child prompts, child sessions, or model usage.

## Constraints

- Pi remains the runtime; use public `ctx.ui.custom(..., { overlay: true })` APIs already used by `/aies-models`.
- Pure `extensions/aies-ui/` renderers remain Pi-free.
- No hardcoded ANSI or second theme system. Colors come from the existing theme/Paint adapter.
- `/agents` is read-only observation: no Enter action, child navigation, chat, attach, session switch, tool call, or model call.
- Missing telemetry renders `—`; never estimate tokens, context, or cost and never recalculate prices.
- Activity is limited to the existing bounded mechanical observatory buffer; never render reasoning or chain-of-thought.
- Empty state remains ephemeral, non-persisted, non-model-visible, and must not cover the editor on short terminals.
- Preserve unrelated concurrent main-worktree changes by implementing in `/tmp/aies-final-observational-polish` on branch `feat/aies-ui-final-observational-polish`.

## TDD and delivery

- TDD: enabled, inherited from the active AIES-010D regression-first project task convention in `odd/tasks/aies-010d-fullscreen-shell.md`.
- Runner: focused `node --test <files>`, then `npm test`, `npm run check:isolation`, and `bash -n bin/aies scripts/*.sh`.
- Route: delegated direct. The 4-file mapping trigger was satisfied by `gentle-ai-explore`; every multi-file implementation task uses `gentle-ai-worker`.
- Forecast: approximately 650 authored changed lines including tests, split into three reviewable work-unit commits.
- Delivery strategy: `exception-ok` because the user requested local commits and explicitly excluded release/README/website; no PR or push is part of this task.

## Tasks

- [x] **T1 — Shared modal frame and `/aies-models` polish**
  - Route: delegated writer; multi-file trigger satisfied by `gentle-ai-worker` task `mublx2sf-2-77ke`.
  - RED observed: missing `extensions/aies-ui/modal.ts`, then 9 frame-sensitive navigation assertions failed after initial wiring.
  - GREEN: shared Pi-free `renderModalFrame`, centered content-adapted overlay, integrated title/border/help, injected Paint only; `overlay.ts` remained byte-for-byte unchanged.
  - Checks: `node --test tests/modal-frame.test.mjs tests/aies-models.test.mjs tests/aies-models-keys.test.mjs` → 60/60 pass; parent repeated the exact focused command in the isolated worktree → 60/60 pass.

- [x] **T2 — Height-aware empty-state placement**
  - Route: delegated writer `mubmks0v-6-gx9n`; runtime + pure renderer + focused tests.
  - RED observed: 4 failures proved absent tall-terminal spacing, unbounded-growth expectations, and missing live-resize wiring.
  - GREEN: public `TUI.terminal.rows` is read on each widget render and feeds a pure bounded trailing flow spacer; short heights collapse to zero and preserve a 6-row editor-band reserve.
  - Checks: `node --test tests/empty-state.test.mjs tests/aies-ui-seam.test.mjs` → 38/38 pass; parent repeated the exact command → 38/38 pass.

- [x] **T3 — `/agents` observatory modal**
  - Route: delegated writer `mubn6fgh-8-b7im`; pure renderer + runtime adapter + focused tests.
  - RED observed: missing modal-width export plus 5 runtime failures covering overlay options, j/k, close/reopen cleanup, live repaint/selection, and no-message paths.
  - GREEN: shared-frame 88-column centered overlay; wide list/detail and narrow stacked layouts; real stats with `—`; bounded retained mechanical activity; selected-id preservation; scoped `AGENTS_CHANNEL` repaint handle; ↑↓/j/k and Esc/q.
  - Checks: focused agent-view + observatory UI → 34/34 pass; adjacent bridge/observability → 60/60 pass; parent repeated the focused suite → 34/34 pass.

- [ ] **T4 — Repository validation and design detector**
  - Run focused tests, full test suite, isolation suite, shell syntax checks, and one Impeccable detector pass over changed UI targets.
  - Inspect the final diff for scope, accidental churn, ANSI literals, and authority-boundary regressions.

- [ ] **T5 — Manual isolated-profile validation and delivery report**
  - Use `AIES_HOME=/tmp/...`; project policy forbids touching the default/ambient profile.
  - Validate empty-state positioning at tall and short sizes; `/aies-models` border and complete keyboard flow; `/agents` empty/running/completed views, selection, live updates, responsive layouts, Esc/q cleanup, and reopen.
  - Capture text/PNG evidence only if the existing cmux capture mechanism is available.
  - Report root cause/design, files, tests, manual evidence, LOC, commits, and real remaining limitations; then stop.

## Acceptance criteria

1. `/aies-models` is a clearly delimited centered modal using AIES theme semantics and preserves ↑↓←→, hjkl, Enter, Esc, q, and Ctrl+S behavior.
2. The idle empty state sits near the first third on tall terminals, compresses safely on short terminals, never covers the editor, and remains ephemeral/non-model-visible/non-persisted.
3. `/agents` opens as a coherent larger AIES modal, lists current-session agents, updates details immediately on selection, and closes with Esc or q without residual state.
4. Agent stats and activity use only real existing Observatory data; unavailable metrics show `—`; no new logging, polling, model calls, or token usage is introduced.
5. `/agents` repaints from the existing event flow while open, preserves selection across running updates, retains completed records/activity for the current session, and reopens cleanly.
6. Wide terminals use list + detail columns; narrow terminals use a bounded vertical layout; every rendered line stays within its width.
7. Existing tests remain green and focused regression tests avoid giant snapshots.

## Progress and evidence

- Mapping complete via `gentle-ai-explore`: current observatory/event bridge is sufficient; missing seams are modal framing, `/agents` overlay mode, active-view repaint, responsive layout, and height input for empty-state spacing.
- Pi 0.87 docs confirm public overlays, `overlayOptions`, injected keybindings, `tui.requestRender()`, and component invalidation. Repository dependency compatibility must remain valid with locked Pi 0.85.1 APIs already used by `/aies-models`.
- T1 complete and independently verified: new `extensions/aies-ui/modal.ts` shared frame; `/aies-models` uses a centered numeric preferred width and existing public overlay API. Focused tests pass 60/60. The temporary `node_modules` symlink used only for worktree test resolution was removed after the check. A cwd incident was diagnosed read-only: no T1 changes leaked into the dirty main worktree.
- T2 complete and independently verified: the Pi-free renderer computes a height-relative spacer, while the existing above-editor widget reads public `TUI.terminal.rows` per render. Focused tests pass 38/38, including heights 6–120 and live resize 48→14. Eligibility, transcript, context, persistence, and widget architecture remain unchanged.
- T3 complete: `/agents` now uses the shared frame and public overlay API, adapts between side-by-side and stacked layouts, renders only existing Observatory fields/activity, and repaints through the existing event bus with no polling or model calls. Focused tests pass 34/34; adjacent observability tests pass 60/60.

## Next step

Commit T3, independently verify it, then run the T4 repository gates and one Impeccable detector pass.
