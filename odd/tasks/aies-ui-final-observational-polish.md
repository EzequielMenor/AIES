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

- [x] **T4 — Repository validation and design detector**
  - Independent verifier `mucsefsb-2-mlju`: `git diff --check` clean; `npm test` and `npm run check:isolation` each passed 788/788; `bash -n bin/aies scripts/*.sh` passed; final worktree clean.
  - Candidate inspection found no raw ANSI output, debug logging, model/tool calls, persistence, or out-of-scope routing/fullscreen/right-rail/release/README/website/AIES-011 changes. Pi 0.87 rail compatibility is base-only at `458b238`.
  - The required one-time detector invocation was attempted exactly once after visual changes: `impeccable detect --json extensions/aies-ui extensions/aies-models extensions/aies-runtime/index.ts`; unavailable because `impeccable` is not installed (`command not found`).

- [x] **T5 — Manual isolated-profile validation and delivery report**
  - Used explicit `AIES_HOME=/tmp/aies-polish-profile`; `--aies-info` confirmed Pi 0.87.0 and all profile resource links target `/private/tmp/aies-final-observational-polish`. The shared default profile was never used or modified.
  - Real tmux TUI at 120×40 confirmed the Pi 0.87 physical rail, tall upper-third empty-state flow, centered bordered `/aies-models`, j/Enter navigation to Explore/model selection, q cleanup, and the centered larger `/agents` empty modal.
  - Resized the same live session to 60×22: the rail yielded, empty-state spacer collapsed without covering the editor, and both modals remained bounded; model help clipped with `…` rather than overflowing.
  - Text capture saved outside the repository at `/tmp/aies-polish-manual-capture.txt` (40 lines). Running/completed agents, live repaint, selection preservation, Esc/q reopen, and Explore/Worker/Verify execution paths are covered by the focused/full automated suites.
  - Attempted the requested real Explore/Worker/Verify smoke from the isolated TUI, but the configured Anthropic credential returned HTTP 401 `authentication_error: API key is invalid` before delegation. No child ran and no files changed; this is the only manual-validation limitation.

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
- T3 complete and independently verified: `/agents` uses the shared frame and public overlay API, adapts between side-by-side and stacked layouts, renders only existing Observatory fields/activity, and repaints through the existing event bus with no polling or model calls. Focused tests pass 34/34; adjacent observability tests pass 60/60.
- Branch rebased cleanly onto `458b238`, which supplies the separately validated Pi 0.87 rail compatibility fix as base-only history; polish commits are now `6e227ba`, `dc38a19`, and `9166371`.
- T4 complete: full and isolation suites each pass 788/788, shell syntax and diff checks pass, scope inspection is clean. Impeccable detector unavailable after the mandated single attempt because its executable is not installed.
- T5 complete with a real isolated Pi 0.87.0 TUI at 120×40 and 60×22. Visual layout, modal framing, responsive clipping, close/reopen behavior, and profile attribution were observed directly. The real three-role model smoke was attempted but blocked before delegation by an invalid configured Anthropic API key; deterministic role/verification suites remained green in the 788-test run.

## Next step

Commit this final validation record and deliver the requested report; no release, push, PR, README, website, or AIES-011 work.
