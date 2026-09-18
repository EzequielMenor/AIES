# AIES UX

The visual system of AIES inside Pi: what the human sees, where, when, and why.
This document is the reference for AIES-010 and for any later presentation work.

Read this together with `docs/ARCHITECTURE.md` (what the system does) and
`docs/DECISIONS.md` (why). Nothing here changes behaviour: it describes and
constrains how behaviour is projected to a person.

---

## 1. The one rule

```
runtime state  ->  UI projection
```

The UI never decides, never infers workflow state from its own text, and is never
the source of truth. If a card says `V:PASS`, it is because `VerificationState`
says `pass`. Every renderer in this document is a pure function of a state
snapshot, which is why they can be tested without a terminal.

Corollaries:

- A renderer that cannot read a field shows nothing, never a guess.
- Presentation is outside the model's context. Progress is for the human.
- A broken projection degrades to silence; it never changes the workflow.

## 2. What Pi already gives AIES

AIES adds no terminal renderer of its own. It uses Pi's public extension API:

| Surface | Pi API | Lifetime |
|---|---|---|
| Footer segment | `ctx.ui.setStatus(key, text)` | until cleared or session end |
| Widget above/below the editor | `ctx.ui.setWidget(key, factory or lines, { placement })` | until cleared |
| Durable transcript line | `pi.appendEntry(type, data)` + `pi.registerEntryRenderer(type, fn)` | persists in the session file |
| Transient notification | `ctx.ui.notify(text, level)` | until it scrolls away |
| Interactive dialog | `ctx.ui.select` / `confirm` / `input` / `custom` | until answered |
| Theme colors | `ctx.ui.theme.fg(color, text)` | per render |

Pi's own surfaces (transcript, tool rows, editor, spinner, compaction loader,
keybindings) stay Pi's. AIES does not replace the footer, the editor, or the
header.

### The no-context-pollution guarantee

This is the single most important mechanic of the phase.

Pi keeps two different things apart:

- a **message** (`pi.sendMessage`) participates in the LLM context — even with
  `display: false` it is sent to the model;
- a **custom entry** (`pi.appendEntry`) is documented as *"not sent to LLM"*, and
  `registerEntryRenderer` draws it in the transcript for the human.

AIES uses `sendMessage` for exactly zero UI purposes. Progress, activity cards,
permission notices, and completion summaries go through `setStatus`,
`setWidget`, `notify`, or `appendEntry` + `registerEntryRenderer`. Everything the
human sees about progress is therefore invisible to the model, and no
"Worker started / Worker completed" line is ever billed as context.

`tests/aies-ui-seam.test.mjs` asserts this by driving a fake `ExtensionAPI` and
failing if any UI path calls `sendMessage`.

## 3. Information hierarchy

Four rings, from always-visible to on-demand.

### Always (very little)

```
AIES · EZE-417 · WORK · ctx 42k · AUTO
```

Ticket, workflow stage, context health, autonomy. Nothing else.

### While a child works

One live card: which child, what it is doing, for how long. See §6.

### When something matters

An alarm appears only when it is true and only for as long as it is true:

```
ctx 104k !        context pressure
compactando…      compaction in flight
V:FAIL            the change did not pass
V:STALE           a PASS no longer describes the artifact
! BLOCKED         workflow stopped, a human is needed
```

### On demand only

Counters, tool calls, peak context, output volume, sandbox internals, provider,
session id, telemetry, per-child detail. All of it lives in `/aies-status`.

The rule this replaces: AIES-002..009 accumulated observability, and AIES-010
stops showing all of it all the time.

## 4. Workflow vocabulary

One dimension, eight values, and a small set of independent indicators. Stage
answers *"where is the work?"*; indicators answer *"what else is true?"*.

| Stage | Meaning | Color |
|---|---|---|
| `IDLE` | nothing in flight | none (footer shows `ready`) |
| `EXPLORE` | an Explore child is running | accent |
| `WORK` | a Worker child is running for a change not under repair | accent |
| `REPAIR` | a Worker child is running while a Verify FAIL is open | accent |
| `VERIFY` | a Verify child is running | accent |
| `WAIT` | autonomy paused and needs the human | warning |
| `BLOCKED` | the workflow stopped on a real blocker | error |
| `DONE` | the work unit is verified and complete | success |

Derivation (`deriveStage` in `extensions/aies-ui/vocabulary.ts`), evaluated in
this order — the first match wins:

1. `BLOCKED` — autonomy stopped with `blocked`, `linear_conflict`,
   `linear_sync_failed`, `permission_denied`, `sandbox_unavailable`,
   `no_progress`, `verification_failed`, `repair_limit`, `context_failure`, or
   verification itself reported `blocked`.
2. `WAIT` — autonomy stopped with `user_required`.
3. `DONE` — autonomy stopped with `completed`, or verification is `pass` and
   still valid and no child is active.
4. `VERIFY` / `WORK` / `REPAIR` / `EXPLORE` — the role of the active delegation.
5. `IDLE`.

Indicators are never folded into the stage:

| Indicator | Values | Shown when |
|---|---|---|
| `AUTO` | on / off | only when autonomy is enabled |
| context | `ctx 42k` / `ctx 104k !` | always |
| compaction | `compactando…` | while compacting |
| verification | `V:PASS`, `V:FAIL`, `V:STALE`, `V:?` | only when it adds information |
| permissions | `PERM` | only after a denial |

`V:BLOCKED` and `V:?` are deliberately **not** footer vocabulary: when a
verification is blocked or running, the stage already says it.

## 5. Footer

```
AIES · EZE-417 · WORK · ctx 42k · AUTO
AIES · EZE-417 · VERIFY · ctx 45k · AUTO
AIES · EZE-417 · DONE · ctx 46k · V:PASS
AIES · ready · ctx 31k
```

- One line. Never a second line, never a panel, never `key=value`.
- The footer is not `/aies-status`. If a fact needs a label to be understood, it
  belongs in the status report, not here.
- No percentages, no ceiling, no `peak:`, no tool counts, no elapsed time. Elapsed
  time belongs to the activity card (§6) and to `/aies-status`.
- Autonomy is silent when off: there is no `AUTO OFF`.

### Narrow terminals

Segments carry a drop priority; the renderer removes the least important present
segment until the line fits, then truncates as a last resort.

| Segment | Drop priority |
|---|---|
| `V:PASS` | dropped first |
| `AUTO` | next |
| stage | next |
| `ctx N` | next (the bare number is tried before dropping) |
| `AIES`, ticket, alarms (`ctx !`, `compactando…`, `V:FAIL`, `V:STALE`, `PERM`) | never dropped |

Width is measured on the plain text before painting, so no ANSI dependency is
needed to decide what fits.

## 6. Agent activity

The Gentle feeling the user asked to keep: *I know a child is working without
reading its transcript.*

### Live (one widget per active child)

```
◆ Explore
  Investigando routing y lifecycle…
  00:12
```

```
◆ Worker
  Implementando el work unit…
  00:34
```

```
◆ Verify
  Comprobando 4 criterios…
  00:18
```

- Exactly one widget, key `aies-activity`, above the editor.
- Updated in place by re-rendering from state; never a new message per event.
- No tool calls, no file reads, no reasoning, no transcript.
- The "what it is doing" line is the delegation's own `task` text, clipped to the
  available width. It is authority, not a decorated guess.
- Elapsed time comes from the single runtime timer.

### Finished (briefly, then durable)

The widget keeps the finished row for 60 seconds and then clears itself, so a
finished child is visible where the work happened but never accumulates.

```
✓ Explore · 00:16
  4 archivos relevantes
```

```
✓ Worker · 00:51
  3 archivos modificados · checks passed
```

```
✓ Verify · PASS · 00:27
  4/4 criterios
```

```
✗ Verify · FAIL
  1 defecto bloqueante
```

In parallel, one compact durable line per finished child is appended to the
transcript through `appendEntry` + `registerEntryRenderer`. It costs no context,
survives session reload, and is what remains once the widget is gone. Ten
children produce ten short lines, not ten cards.

### Glyphs

```
◆  active          (accent)
✓  success         (success)
!  warning         (warning)
✗  failure         (error)
○  queued/idle     (dim)
```

ASCII-width, single cell, no emoji, no Nerd Font requirement.

## 7. Explore

During: task text and elapsed. After: status, duration, and a small count of
relevant paths (`handoff.evidence.length`). Never `grep … read … find …`.

## 8. Worker

During: the work unit and elapsed. After: modified-file count, check count,
and status. The diff is never printed automatically; it is already in the
transcript through Pi's own tool rows.

## 9. Verify and repair

Verify must be unmistakable:

```
✓ Verify · PASS · 00:27        ✗ Verify · FAIL              ! Verify · BLOCKED
  4/4 criterios                  1 defecto bloqueante        la verificación no pudo concluir
```

Repair is a stage transition, not a controller trace. The sequence

```
VERIFY (FAIL) -> REPAIR -> VERIFY (PASS)
```

is expressed as stage changes plus a Worker card whose subtitle reads `reparando`
when a FAIL is open. No internal controller state, no attempt counters, no
budget text in the live surface; those live in `/aies-status`.

## 10. Permission ASK

`ALLOW / ASK / DENY` is AIES-006 policy and does not change. Only the ASK
presentation changes, from a bare policy string to a human decision:

```
AIES necesita permiso
Instalar dependencia
  pnpm add zod
Efecto
  cambia el árbol de dependencias del proyecto
[Permitir] [Denegar]
```

Implemented with Pi's `ctx.ui.confirm(title, message)` — the same interactive
primitive AIES-006 already used, now fed a structured, labelled prompt built by
`renderApprovalPrompt` from what the policy actually knows: the action, the
concrete command, and its side effect. A justification (`Necesario para`) is
printed only when the policy supplies one; AIES never invents a reason.
Cancel/escape is a deny. In headless, RPC-without-UI and child sessions the gate
keeps its existing behaviour (`ASK -> DENY`); the presentation never weakens the
policy.

## 11. BLOCKED

```
! EZE-417 bloqueado

Necesita
  autorización para instalar X

Estado
  implementación terminada
  Verify pendiente
```

```
! EZE-417 bloqueado

Linear no pudo sincronizarse.
El código está verificado y no se volverá a ejecutar.

V:PASS
```

Rendered as a durable transcript entry: what happened, what is already done, and
what is needed from the human. Never a stack trace, never a raw reason code
without a translation, and never a field with no value.

## 12. DONE

```
✓ EZE-417 completado

Cambios
  First-run guidance añadida.
  Estados de temperatura aclarados.

Verificación
  PASS · 4 criterios · 18 tests

Linear
  Done

Tiempo
  04:21
```

Same entry mechanism. A section is printed only when it has a value; a commit
hash appears only if the workflow actually produced one (AIES-010 introduces no
git automation, so it normally does not).

## 13. `/aies-status`

A human view, not a telemetry dump. Grouped by concept, under 30 useful lines,
zeros omitted, no duplicated fact.

```
AIES

Ticket
  EZE-417 · In Progress
  Implement first-run guidance

Run
  WORK · autonomía activa
  transcurrido 06:42 · continuaciones 3

Verificación
  pendiente · intentos 0 · repairs 0

Contexto
  43k / 150k · verde
  peak 51k · compactions 0

Agentes
  explore  done    12s
  worker   activo  31s
  verify   —

Permisos
  sandbox activo · aprobaciones 0
```

Technical labels stay in English in code and telemetry keys; the visible labels
are Spanish, consistent with the rest of AIES. Internal telemetry is not deleted
because it is not shown — `/aies-status` reads the same snapshot the footer does.

## 14. Commands

Unchanged and audited. Four primitives, no more:

| Command | Role | Visibility |
|---|---|---|
| `/aies-status` | the human view of the session | normal |
| `/aies-ticket [id]` | activate or inspect the Linear ticket | normal |
| `/aies-run [id\|stop\|status]` | bounded autonomy | normal |
| `/aies-info` | resolved profile paths, mode, extension path | diagnostic |

`/aies-info` stays registered but is deliberately demoted: it is a
diagnostic/dev command and must not compete with `/aies-status`. No new command
is added for agents, context, verify, permissions, Linear or autonomy: the UI
reduces the need for commands instead of multiplying them.

## 15. Model, time, cost

- **Model.** Not in the footer. The parent model is Pi's own footer/`/model`
  concern and is shown on demand by `/aies-status`. The child model is **not shown
  in v1**: the parent session cannot observe the model a child resolved, and AIES
  does not invent a value it cannot read. Making it observable would need a new
  getter on the child-session module; that is a wiring change, not a UX one, and
  it is deliberately left out of a presentation phase.
- **Time.** One shared `formatDuration`: `00:14`, `02:31`, `1:04:22`. Used by the
  activity card and by `/aies-status`, never in the footer.
- **Cost.** Not implemented. Pi exposes per-session usage, not a reliable
  per-child cost, and AIES will not build its own accounting. Context tokens come
  from `ctx.getContextUsage()` and that is all AIES shows.

## 16. UI architecture

```
extensions/aies-ui/            pure presentation, no Pi import, no state
  format.ts                    formatTokens, formatDuration, clip, paint adapter
  vocabulary.ts                deriveStage, indicators
  footer.ts                    renderFooter + width degradation
  activity.ts                  live card, finished line, entry data
  approval.ts                  renderApprovalPrompt
  summary.ts                   DONE / BLOCKED cards, /aies-status report
extensions/aies-runtime/       the only writer of the footer and the widgets
  index.ts                     Pi events -> state -> strings
extensions/aies-agents/        feeds the approval prompt with the policy reason
```

Rules:

- `aies-ui` imports nothing from Pi and holds no state. Every function is
  `state -> string`.
- Exactly one owner per Pi surface: `aies-runtime` owns the footer key `aies`,
  the widget key `aies-activity` and the entry renderers; `aies-agents` owns the
  approval dialog.
- Painting is injected (`Paint`), so the same renderer works uncolored in tests
  and headless.
- No `packages/ui`, no component registry, no virtual DOM, no state management.
  Pi is the UI runtime.

## 17. Terminal and headless

- Narrow: the footer degrades by priority (§5); the activity card clips its
  subtitle and drops the optional metric line.
- cmux/Multiplexer: no absolute cursor movement, no full-screen redraw, no
  terminal-size query beyond `process.stdout.columns`.
- Headless/`print`/`json`: no widget, no status, no entry rendering. The workflow
  runs identically; `/aies-status` still answers (through `notify`, which is a
  no-op channel there) and the state machine is untouched.
- RPC: `hasUI` is true, so dialogs work; widget/status calls are ignored by the
  RPC presenter.
- One timer: the runtime observer owns a single interval, 1s while a child is
  active and 5s otherwise, cleared on shutdown, and it unrefs so it can never
  hold the process open.

## 18. gentle-pi audit and decisions

Audited installation: `gentle-pi@3.2.1` at
`~/.pi/agent/npm/node_modules/gentle-pi`, extensions under `extensions/`, pure
renderers under `lib/`.

### Pi-native vs gentle-pi-specific

| Concern | Owner |
|---|---|
| Transcript, tool rows, editor, keybindings, working spinner, theme engine, `ctx.ui.*` primitives, `appendEntry`/`registerEntryRenderer` | Pi |
| The custom footer (`setFooter`) with brand, path, branch, model, gauge, cost, usage bars | gentle-pi (`lib/shell-bar.ts`) |
| The agents card, todo card, changes card, dev-binary notice (`setWidget`) | gentle-pi (`lib/agents-widget.ts`, `gentle-todo.ts`, `gentle-shell.ts`) |
| Task records, history file, completion queue, child dialog relay | gentle-pi runtime (`lib/agents-protocol.ts`) |
| Spanish/English copy, glyph set (`❀`, `◐`, `○`, `✓`, `✗`), rose palette | presentation choice |
| The ODD/SDD lifecycle, review authority, consent envelopes | gentle-pi product, not UI |

### What makes the Gentle experience work

1. One custom footer line replaces Pi's three-line footer.
2. A live widget above the editor re-rendered from state — never a message per
   event (`setWidget(key, (tui) => ({ render })` with `tui.requestRender()`).
3. Finished rows linger for a TTL and then disappear, so the card never grows.
4. Durable transcript content uses `appendEntry` + `registerEntryRenderer`,
   explicitly documented as not participating in the LLM context.
5. Pure renderers in `lib/`, tested without a TUI (`tests/agents-widget.test.ts`).
6. Semantic role table per status (`LOOK`), theme colors only, no raw ANSI.
7. Row/column budget derived from terminal size; label clipped before the number.

### Comparison table

| Gentle concept | AIES decision | Reason |
|---|---|---|
| Agent activity cards | Adapt | The core feeling to keep: a child working without its transcript. AIES has exactly one child at a time, so the card is one row plus a subtitle, not a table. |
| Context gauge (8-cell bar + `%`) | Reject | A meter needs a ceiling to be read, and a ceiling invites "how full am I" math. `ctx 42k` with an `!` only under pressure is quieter and answers the same question. |
| Model + effort in the footer | Reject from the footer, adapt on demand | Always-visible model text is decoration in AIES; the parent model is in `/aies-status` and the child model only when it differs. |
| Elapsed time per row | Adapt | Consistent `formatDuration`, but only in the activity card and `/aies-status`, never in the footer. |
| Cost / subscription / usage bars | Reject v1 | No reliable per-child source and no own accounting allowed. Context is the only resource AIES shows. |
| Agent history browser | Reject v1 | Out of scope; the durable one-line entry plus `/aies-status` is enough. |
| Persistent sidebar / large orchestration panel | Reject | AIES has one child at a time and one ticket at a time. A panel would show a mostly empty tree and permanently steal editor space. |
| Custom multi-part footer with brand, path, branch, dirty count | Reject | AIES needs one status segment, not the whole footer. Keeping Pi's footer means fewer surfaces to maintain and no loss of Pi features. |
| Finished-row TTL on the widget | Adapt | Solves "ten historical cards" without a history UI. |
| Pure renderer + theme interface, tested without a TUI | Adapt | This is why the AIES renderers live in a Pi-free module with injected paint. |
| `ui.select` for closed choices | Reject for approvals | `confirm` already expresses allow/deny with a safe default; a select would add a third option nobody acts on. Reused only where AIES already had it. |
| ODD/SDD UI (SDD status, review consent, judgment day) | Reject | AIES has no SDD and no review authority. Importing that UI would import a workflow AIES does not run. |

## 19. Before / after

### The inventory of what AIES showed before this phase

| Surface | What it showed | Where / when | Owner | Problem | Decision |
|---|---|---|---|---|---|
| Footer line | `AIES · ticket · VERIFY · compactando · ctx 34k/peak 41k · tools 8 · files 4 · cmp 1 · V:PASS · delegando worker · SANDBOX OFF · AUTO · 02:14` | footer, always | `aies-runtime` | Up to twelve segments, mixed Spanish and English, no priority order, two different "a child is running" signals, counters nobody asked for | redesign |
| Context segment | `ctx 34k/peak 41k` | footer, always | `aies-runtime` | `peak` duplicates `/aies-status`; the `!` alarm was the only useful part | redesign |
| Session elapsed | `02:14` | footer, always | `aies-runtime` | Time of the wrong thing: the session, not the running child | remove from footer, move to activity card and status |
| Delegation sign | `delegando worker` | footer, while a child runs | `aies-runtime` | One word; no task, no elapsed, no outcome | redesign as the activity card |
| Verification sign | `V:?`, `V:PASS`, `V:STALE`, `V:FAIL`, `V:BLOCKED` | footer, when present | `aies-runtime` | `V:BLOCKED` and `V:?` duplicated the stage; `V:STALE` was never explained | redesign: keep `V:PASS`/`V:FAIL`/`V:STALE`, fold the rest into the stage |
| Autonomy sign | `AUTO`, `AUTO:BLOCKED` | footer | `aies-runtime` | Silent when off (good), but the blocked form carried no reason | redesign as stage + BLOCKED card |
| `/aies-status` | ~10 sections, 60-80 lines of telemetry | on demand | `aies-runtime` | A dump, not a view; the human had to know which row to look for | redesign as a human view; the dump moves to `detalle` |
| `/aies-info` | extension path, agent dir, config dir, cwd, mode | on demand | `aies-identity` | Diagnostic text competing with the status command | keep, demote |
| Startup notification | `AIES profile: <dir>` | every session start | `aies-identity` | Noise for a fact that never changes | keep (it is the isolation proof), stop treating it as a status surface |
| `/aies-ticket` | contract text in a notification | on demand | `aies-agents/linear` | Correct content, transient channel | keep |
| `/aies-run` | autonomy state as a notification | on demand | `aies-agents/autonomy` | A second report duplicating `/aies-status` rows, with English keys inside Spanish text | redesign into the overview; the command only starts and stops |
| Child activity | nothing | - | - | The only sign a child was running was Pi's own tool row | add: one live card + one durable line |
| Child results | the handoff text inside the tool result | after each delegation | Pi tool row | Correct and complete, but not scannable while working | keep; add the compact card on top |
| Permission ASK | `ctx.ui.confirm("Permission Approval Required", ...)` | when a boundary is crossed | `aies-agents` | Policy wording instead of a decision; no structured side effect | redesign the prompt only |
| BLOCKED | `AUTO:BLOCKED` in the footer | on stop | `aies-runtime` | Did not say what happened, what was done, or what was needed | add a BLOCKED card |
| DONE | nothing | - | - | Finishing a task felt like the transcript simply stopping | add a DONE card |
| Timer | one 5s interval rendering only the footer | always | `aies-runtime` | Seconds-resolution elapsed was impossible; a card would need the same clock | keep one timer, adapt the period |

### Summary

**Before.** Each phase added its own surface: the footer grew a segment per
feature, Spanish and English were mixed inside one line, `/aies-status` was a
telemetry dump whose length grew with every phase, the only sign that a child was
running was a Pi tool row, BLOCKED/DONE had no presentation at all, and the
permission dialog spoke policy instead of consequences.

**After.** One vocabulary, one footer with a documented priority order, one live
card for the active child, one durable line per finished child, two purpose-built
summaries for the two states the human must notice, and a human status view with
the full telemetry one argument away. Fewer always-visible elements, the same
available information.
