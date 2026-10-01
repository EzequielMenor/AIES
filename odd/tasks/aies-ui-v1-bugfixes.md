# AIES UI v1 real-bug fixes — keyboard + idle shell

Two real bugs found by using AIES UI v1 on the normal profile. No new phase:
the UI v1 freeze stands and this is the documented real-bugfix exception.
No core, routing, agents, autonomy or runtime-semantics changes.

## BUG 1 — `/aies-models` keyboard: arrows dead, Esc traps the user

Root cause (verified against Pi 0.86.1 sources):

- `extensions/aies-models/index.ts` ignores the `keybindings` manager Pi injects
  into the `ctx.ui.custom()` factory (`_keybindings`) and `decodeOverlayKey`
  hand-matches raw legacy bytes (`\x1b[A`, `\x1b[B`, bare `\x1b`).
- Pi enables the Kitty keyboard protocol when the terminal supports it
  (`setKittyProtocolActive(true)` in the interactive host; pi-tui `keys.js`
  decodes both legacy and Kitty sequences). Under that protocol arrows and Esc
  arrive as CSI-u / modifyOtherKeys sequences, never as the legacy bytes the
  table hardcodes, so ↑ ↓ Esc are silently dropped. `j`/`k` are plain ASCII and
  keep working.
- The in-repo reference is `/agents` (`extensions/aies-runtime/index.ts`,
  `agentKeys()`): it decodes through `manager.matches(data, "tui.select.*")`
  with raw fallbacks, which is why that view works.
- Pi's own components (onboarding select) use the same
  `keybindings.matches(keyData, action)` pattern. There are no
  `tui.select.left/right` actions; left/right use `tui.editor.cursorLeft/Right`
  (same as `/agents`), and Ctrl+S maps to `app.models.save` ("Save model
  selection"), with raw ASCII fallbacks.

Fix: bind through the injected manager (+ raw fallbacks), add
`left`/`right` (effort only), `q` (quit view from any step), Ctrl+S (confirm
and save), and a `settled` guard so input after close is a no-op.

## BUG 2 — idle shell: empty main pane, no editor hint, fake workflow Todos

Root causes:

- No empty-state surface exists: the main pane renders nothing in a fresh IDLE
  session.
- Pi's main editor exposes no public placeholder API; the supported surface is
  an `aboveEditor` widget (AIES already uses `setWidget` for the activity card).
- `deriveTodos` unconditionally emits the five workflow steps, so IDLE shows a
  fake `Todos 0/5`.

Fix: a pure `extensions/aies-ui/empty-state.ts` (gate + renderer), an
`aies-empty-state` widget synced next to the activity widget with a repaint on
the `input` event, and an idle-gated `TodoProjection` (`— sin tarea activa`)
that leaves WORK/VERIFY/DONE semantics untouched. The editor hint is the
widget's last muted line — a true in-editor placeholder would need a second
editor-level seam, which D25 forbids.

## Tasks

| # | Task | Status | Evidence |
|---|------|--------|----------|
| T1 | Keyboard fix: overlay alphabet + adapter + focused tests | complete | 49/49 aies-models suites; commit `e94cc61` |
| T2 | Idle shell: empty state, editor hint, run-gated Todos + tests | complete | 13+16+35+18+24+53 focused suites green; gates 753/753; commit below |
| T3 | Full gates (npm test, check:isolation) | complete | 753/753 both runs (159 suites) after the widget-lifecycle fix |
| T4 | Manual validation on the REAL profile (arrows, jkh l, Enter, Esc, q, Ctrl+S, reopen; empty state lifecycle; Todos idle) | complete | See evidence log 2026-09-21 |

## Constraints

- UI v1 stays frozen except these fixes; no release/README/web/AIES-011.
- Empty state: not persisted, not model-visible, no context entries, derived
  from `sessionManager.getEntries()` (no listeners to leak).
- Todos: WORK/VERIFY/DONE semantics unchanged; only the IDLE case is gated.

- 2026-09-21 T4 manual validation (REAL profile, fresh session, via cmux; captures in
  `/tmp/aies-bugfix-captures/`, text + PNG): fresh IDLE shows the centered empty state
  (`✧ AIES`, prompt hints, command rows, muted editor hint) and the rail shows
  `Todos — sin tarea activa`. In `/aies-models`: real arrow keys (`cmux send-key
  up/down/left/right`) move the selection exactly like `j`/`k`; `h`/`l` and `←`/`→`
  move the effort step; Enter advances; Esc walks back thinking → model → roles and
  closes from the main view; `q` closes from any step; reopening works; Ctrl+S
  confirms and persists (verified on a disposable profile: `settings.json` gained
  `defaultProvider`/`defaultModel`/`modelThinkingLevels` and the rail notified the new
  Parent default; on a credential-less profile the pre-existing fail-safe correctly
  refused to persist). Real-profile `aies.json` verified byte-identical to a pre-test
  backup. Empty state disappears after the first real user input and reappears on a
  fresh session; it intentionally stays while only slash commands ran (no user
  message yet). Known cosmetic note: while an overlay is open before any input, the
  empty-state block still renders below it; hiding it would require host-internal
  overlay state (a forbidden seam).
- 2026-09-21 Work-unit commits: `e94cc61` (keyboard), `9db953f` (idle shell), tracker
  commit below. Suite totals: 753/753 (159 suites) on `npm test` and
  `npm run check:isolation`.
