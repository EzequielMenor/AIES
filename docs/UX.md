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
| Custom footer | `ctx.ui.setFooter(factory)` | until cleared or session end |
| Ticket header | `ctx.ui.setHeader(factory)` | until cleared or session end |
| Widget above/below the editor | `ctx.ui.setWidget(key, factory or lines, { placement })` | until cleared |
| Durable transcript line | `pi.appendEntry(type, data)` + `pi.registerEntryRenderer(type, fn)` | persists in the session file |
| Transient notification | `ctx.ui.notify(text, level)` | until it scrolls away |
| Interactive dialog | `ctx.ui.select` / `confirm` / `input` / `custom` | until answered |
| Theme colors | `ctx.ui.theme.fg(color, text)` | per render |

Pi's own surfaces (transcript, generic tool rows, editor, spinner, compaction
loader, keybindings) stay Pi's. While an AIES session is active, AIES installs
its own footer and ticket header — both rendered from the same snapshot — and
restores Pi's built-in footer and header on shutdown. The editor is never
replaced.

### The no-context-pollution guarantee

This is the single most important mechanic of the phase.

Pi keeps two different things apart:

- a **message** (`pi.sendMessage`) participates in the LLM context — even with
  `display: false` it is sent to the model;
- a **custom entry** (`pi.appendEntry`) is documented as *"not sent to LLM"*, and
  `registerEntryRenderer` draws it in the transcript for the human.

AIES uses `sendMessage` for exactly zero UI purposes. Progress, activity cards,
permission notices, and completion summaries go through `setFooter`, `setHeader`,
`setWidget`, `notify`, or `appendEntry` + `registerEntryRenderer`. Everything the
human sees about progress is therefore invisible to the model, and no
"Worker started / Worker completed" line is ever billed as context.

`tests/aies-ui-seam.test.mjs` asserts this by driving a fake `ExtensionAPI` and
failing if any UI path calls `sendMessage`.

## 3. Information hierarchy

Five rings, from always-visible to on-demand.

### Always (very little)

```
✧ AIES · EZE-417 · WORK · ctx 42k · AUTO
```

Ticket, workflow stage, context health, autonomy. Nothing else.

### Wide terminals: the status panel

From 72 columns the same snapshot is drawn as a persistent status panel below the
editor, and the footer turns minimal. The panel carries the run's headline facts
(model, context, time, agents) and the run's usage (tokens, cost). It is
described in §5.

```
✧ AIES · EZE-417 · WORK
Claude Sonnet 4.5 · anthropic · ctx 42k · 04:21 · 2 · Worker activo
Tokens Main 12k · Agents 3000 · Total 15k
Coste Main $0.04 · Agents $0.01 · Total $0.05
```

### While a child works

One live card and one mini agents widget: which child, what it is doing, for how
long, and what it has spent. See §6.

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
session id, telemetry and per-child detail. The session view is `/aies-status`;
the session's children, with one selectable record each, are `/agents`.

The rule this replaces: AIES-002..009 accumulated observability, and AIES-010
stops showing all of it all the time. AIES-010C adds the status panel and the
observatory surfaces without letting any of them feed a decision.

## 4. Workflow vocabulary

One dimension, eight values, and a small set of independent indicators. Stage
answers *"where is the work?"*; indicators answer *"what else is true?"*.

| Stage | Meaning | Color |
|---|---|---|
| `IDLE` | nothing in flight | none (footer shows `listo`) |
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
| verification | `V:PASS`, `V:FAIL`, `V:STALE`, `V:ERROR` | only when it adds information |
| permissions | `PERM` | only after a denial |

`V:BLOCKED`, `V:?` and `V:none` are deliberately **not** footer vocabulary: when a
verification is blocked or running, the stage already says it. `V:ERROR` is the
exception: a verification protocol fault is not the stage's to express, so it
keeps its own indicator.

## 5. Shell: footer, status panel and ticket header

While an AIES session is active, `aies-runtime` installs a custom footer with
`ctx.ui.setFooter`, replacing Pi's built-in footer (the older AIES `setStatus`
segment is gone) and restoring the original on shutdown. It is one line:

```
✧ AIES · EZE-417 · WORK · ctx 42k · AUTO
✧ AIES · EZE-417 · VERIFY · ctx 45k · AUTO
✧ AIES · EZE-417 · DONE · ctx 46k
✧ AIES · listo · ctx 31k
```

- One line. Never a second line, never a panel, never `key=value`. The single
  `✧` is the AIES identity glyph, here as everywhere else.
- The rich form above prints only when no status panel is on screen. While the
  panel is visible the footer is **minimal**: identity, ticket, stage, context and
  alarms, without `AUTO`, `V:PASS`, model or cwd, so the same fact is never told
  twice. Both forms are the same renderer reading the same snapshot.
- `listo` appears only when the stage is `IDLE`. While work is in flight and there
  is no ticket, the line simply omits the token (`✧ AIES · EXPLORE · ctx 42k`):
  `listo` next to `EXPLORE` would read as a contradiction.
- `V:PASS` is printed when it is the newest thing worth knowing — and suppressed
  when the stage is already `DONE`, which means exactly the same thing. Once a
  parent mutation invalidates the PASS, the stage reverts to `IDLE` and the line
  carries `V:STALE`, which is the state the human actually needs to see.
- The footer is not `/aies-status`. If a fact needs a label to be understood, it
  belongs in the status report, not here.
- No percentages, no ceiling, no `peak:`, no tool counts, no elapsed time. Elapsed
  time belongs to the activity card (§6) and to `/aies-status`.
- Autonomy is silent when off: there is no `AUTO OFF`.
- The parent model and a compact cwd are opportunistic: appended only when the
  terminal leaves room, and the first two segments the width degradation drops.

### The status panel

From 72 columns the status panel is a persistent widget below the editor — not
`ctx.ui.setHeader`, because Pi's header is the startup header and scrolls out of
view as the transcript grows. It is a block, never a sidebar: it takes no editor
width, holds no state, and its lines never exceed 72 columns.

| Terminal width | Panel |
|---|---|
| `>= 100` | a borderless block of at most 4 lines, each clipped to at most 72 columns |
| `72`–`99` | a single-column box of at most 6 lines (4 body rows plus the top and bottom borders), at most 72 columns wide |
| `< 72` | nothing; the startup ticket header is the identity surface |

Wide tier (`>= 100`), borderless:

```
✧ AIES · EZE-417 · WORK
Claude Sonnet 4.5 · anthropic · ctx 42k · 04:21 · 2 · Worker activo
Tokens Main 12k · Agents 3000 · Total 15k
Coste Main $0.04 · Agents $0.01 · Total $0.05
```

- The first line is the title: `✧ AIES · <ticket|listo> · <STAGE>`. A real ticket
  is always shown; `listo` stands in only when the stage is `IDLE`.
- The second line carries the model label and its provider, `ctx`, the run time
  and the agent count, each part printed only when it is known.
- The `Tokens` row prints `Main`, `Agents` and `Total`; a zero bucket is left out
  and `Total` is always shown. The row is omitted when nothing was measured.
- The `Coste` row is omitted when there is no real cost. Within a shown row an
  unknown bucket is `—`, never an estimated `$0.00`.

Mid tier (`72`–`99`), a single-column box:

```
╭─ ✧ AIES · EZE-417 · WORK ────────────────────────────────────────────╮
│ Contexto 42k                                                         │
│ Tiempo   04:21                                                       │
│ Agentes  2 · Worker activo                                           │
│ Modelo   Claude Sonnet 4.5 · anthropic                               │
╰──────────────────────────────────────────────────────────────────────╯
```

- Rows are emitted in this order and capped at four: `Contexto`, `Tiempo`,
  `Agentes`, `Modelo`, `Tokens`, `Coste`. Everything past the fourth is dropped,
  so cost is dropped first, then tokens, then the model, then the agents.
  `Contexto` and `Tiempo` are always present.
- `Contexto` reads `compactando…` while a compaction is in flight and appends
  ` !` under pressure. `Tiempo` is the current run's wall-clock time.
- A row is printed only when it has a value: `Agentes` is omitted when the
  registry is empty, `Modelo` when no model is known, `Tokens` when nothing was
  measured, and `Coste` when there is no real cost.

Observed live: a 140-column terminal renders the wide panel with the minimal
footer, 80 columns the mid box with the minimal footer, and 60 columns no panel
with the rich footer fallback.

### Narrow terminals

Segments carry a drop priority; the renderer removes the least important present
segment until the line fits, then truncates as a last resort.

| Segment | Drop priority |
|---|---|
| model | dropped first |
| compact cwd | next |
| `V:PASS` | next |
| `AUTO` | next |
| stage | next |
| `ctx N` | next (the bare number is tried before dropping) |
| `AIES`, ticket, alarms (`ctx N !`, `compactando…`, `V:FAIL`, `V:STALE`, `V:ERROR`, `PERM`, `SANDBOX OFF`) | never dropped |

A segment that is itself an alarm is never dropped, and the pressured context
segment stops being droppable: at 32 columns the line reads
`✧ AIES · EZE-417 · ctx 104k ! · c…` rather than silently losing the warning. Below
that, the tail is clipped; identity, ticket and the leading alarm survive.

Width is measured on the plain text before painting, so no ANSI dependency is
needed to decide what fits.

### Ticket header

`aies-runtime` installs a small startup header with `ctx.ui.setHeader`, rendered
from the same snapshot as the footer and showing the active ticket identity. It
renders no lines while the status panel is visible, so it is the identity surface
below 72 columns:

```
╭─ ✧ EZE-417 ─────────────────────────────────────────╮
│ Implement first-run guidance                        │
│ In Progress · AUTO                                  │
╰─────────────────────────────────────────────────────╯
```

- No active ticket means no header lines at all.
- From 72 columns the status panel is what the human reads: the header renders
  no lines while the panel is visible, so the two never duplicate a fact.
- Below 60 columns it collapses to one compact line
  (`EZE-417 · In Progress · AUTO`); otherwise the boxed identity grows to at most
  64 columns.
- The header is identity, not workflow: like the footer it is a projection and
  never feeds a decision.

## 6. Agent activity

The Gentle feeling the user asked to keep: *I know a child is working without
reading its transcript.* The Agent Observatory adds a selectable view of every
child the session ran: the mini widget and `/agents`.

### Live (one widget per active child)

Exactly one widget, key `aies-activity`, above the editor. From 48 columns it is a
boxed card capped at 72 columns, so a wide terminal reads it as a card and not as
a full-width banner; below 48 it stays three plain lines. It is updated in place
by re-rendering from state, never a new message per event, and it shows no tool
calls, no file reads, no reasoning and no transcript.

```
╭─ ◆ Worker ───────────────────────────────────────────────╮
│ Editando src/calculator.js                               │
│ src/calculator.js                                        │
│ 00:34 · Claude Sonnet 4.5 · 3100 tokens · $0.01          │
╰──────────────────────────────────────────────────────────╯
```

Below 48 columns it is three plain lines:

```
◆ Explore
  Investigando routing y lifecycle…
  00:12
```

- The role sits on the top border. The content lines are, in order: the activity
  line, the last changed path when there is one, and the metric line
  (`elapsed · model · tokens · cost`, each part printed only when the child
  reported it).
- The activity line prefers the child's own mechanical wording (`Editando …`,
  `Ejecutando …`, derived from its tool events), so a Parent-authored English task
  prompt does not leak into the default UI; it falls back to a Spanish role phrase
  only before the child has reported any activity. A Verify card reports its
  criterion count instead.
- Elapsed time comes from the single runtime timer.

### Finished (durable, no TTL)

A finished child leaves no lingering card: the live widget is cleared as soon as
it finishes, and its only trace is one compact durable transcript line appended
through `appendEntry` + `registerEntryRenderer`. The 60-second finished-card TTL
of AIES-010B is gone, so duplicated finished rows cannot pile up.

```
✓ Explore · 00:16 · 4200 · $0.01 · 4 archivos relevantes
```

```
✓ Worker · 00:51 · 12k · $0.04 · 3 archivos modificados · checks aprobados
```

```
✓ Verify · PASS · 00:27 · 8000 · $0.03 · 4/4 criterios
```

```
✗ Verify · FAIL · 00:22 · 1 defecto bloqueante
```

The line is `<glyph> <Role> · <verdict?> · <duration> · <tokens> · <cost> ·
<facts>`, with each part printed only when the child reported it. It costs no
context, survives a session reload, and is what remains once the widget is gone.
Ten children produce ten short lines, not ten cards. Both the card and the durable
line render structured facts only; a child's free-form `summary` is never
re-rendered and stays in the internal handoff.

### Mini agents widget

While the observatory holds records, one compact widget, key `aies-agents`, sits
above the editor (from 48 columns; nothing below that). It shows at most four
rows and collapses the rest into `… N más`:

```
✓ Explore  2 archivos        00:17
◆ Worker   calculator.js     00:34
```

Each row is `<glyph> <Role padded> <detail padded> <elapsed>`. The detail is the
last changed path's basename for a running child (or its mechanical activity, or
`esperando`), and the changed-file count for a finished one. The widget shares the
runtime timer and repaints from the registry; it owns no timer and no second
source of truth.

### `/agents`

`/agents` opens one Pi `ctx.ui.custom()` view over the same records. The rows are
selectable, and the selected record's structured detail prints below the list:

```
AIES Agents
  ✓ Explore #1  completed
▸ ◆ Worker #1  running

  modelo       Claude Sonnet 4.5
  proveedor    Anthropic
  tiempo       00:34
  tokens       3100
  coste        $0.01
  herramientas 3
  archivos     src/calculator.js
  actividad reciente
    Editando src/calculator.js
← → agente · esc cerrar
```

- The row label is `<Role> #<ordinal>`, from the record's stable `<role>-<ordinal>`
  id. The detail prints the resolved model and provider, elapsed time, tokens,
  cost, tool count, changed paths, up to five recent mechanical activities and the
  compact result — each row only when it has a value.
- `archivos` lists bounded short paths in the shared two-segment form, so an
  absolute home prefix never reaches the screen, and collapses past three entries
  into a `… N más` remainder.
- `←`/`→` and `↑`/`↓` move the selection with wrap-around; `esc` closes. The key
  hints (`← → agente · esc cerrar`) are printed at the bottom of the view.
- In a host without a dialog channel (`print`, `json`, `rpc`) the same text is
  returned through `notify`, so the command always answers.
- The registry is ephemeral: it is reset on `session_start` and never restored, so
  a resumed session starts with an empty `/agents`.

### Glyphs

```
◆  active                    (accent)
◇  running, no activity yet  (dim)
✓  success                   (success)
!  blocked                   (warning)
✗  failure                   (error)
▸  selected row in /agents   (accent)
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
✓ Verify · PASS · 00:27     ✗ Verify · FAIL              ! Verify · BLOCKED                    ⚠ Verify · ERROR
  4/4 criterios               1 defecto bloqueante        la verificación no pudo concluir     error de protocolo
```

The verdict is never read from the child's prose. The isolated Verify child must
produce one valid `aies_verify_complete` call, and the parent reads that captured
call. One invalid attempt may be corrected in the same turn; a missing completion,
an invalid-only completion or a second valid completion is a
`protocol_error`, shown as `V:ERROR` / `error de protocolo` — never `PASS`,
`FAIL` or `BLOCKED`. It consumes one attempt, spends zero repair budget and stops
the loop without an automatic retry, so a malformed handoff cannot fabricate a
domain verdict or burn repair cycles.

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

The DONE projection is compact: a headline plus one indented row per fact, and
only the rows that carry a value.

```
✓ EZE-417 · completado
  Explore ✓ 4 archivos relevantes
  Worker ✓ 3 archivos modificados · checks aprobados
  Verify ✓ 4/4 criterios
  Linear ✓ Done
  Tokens 15k (main 12k · agents 3000)
  Coste $0.05
  Tiempo 04:21
```

- One row per finished child, in the order they ran, read from the observatory:
  `<Role> <glyph> <compact result>`. Nothing here is re-narrated from the child's
  raw summary.
- `Tokens` prints `Total (main X · agents Y)`; `Coste` prints an em dash when the
  cost is unknown, never a `$0.00` the run did not measure.
- A `Git <commit>` row appears only if the workflow actually produced one
  (AIES-010 introduces no git automation, so it normally does not). A real warning
  (`1 agente no completó`, a verification protocol error, a Linear sync failure)
  adds a `! …` line plus a pointer to `/aies-status detalle`.
- When the terminal width allows, the duration rides the headline instead of a
  `Tiempo` row.

Same durable entry mechanism as BLOCKED. The DONE card is edge-triggered: the
runtime emits it the moment the observed ticket reaches Linear's completed state,
and autonomy stopping with `completed` shares the same single latch, so a run
appends exactly one DONE `aies-summary` entry. BLOCKED cards are emitted once per
new autonomy stop reason. Both go through one publish path: the durable entry is
always appended, and its headline travels through `notify` only where the durable
card cannot be drawn (a non-TUI mode, or a host without entry renderers), so the
human never sees the same headline twice.

## 13. `/aies-status`

A human view, not a telemetry dump. Grouped by concept, zeros omitted, no
duplicated fact.

```
AIES

Ticket
  id                EZE-417
  situación         In Progress
  título            Implement first-run guidance

Ejecución
  etapa             DONE · autonomía activa
  continuaciones    3
  modelo            Claude Sonnet 4.5 · anthropic
  tiempo            04:22 · run 04:21

Verificación
  estado            PASS
  intentos          1
  reparaciones      1 / 2

Contexto
  actual            42k / 150k · verde
  pico              51k
  compactaciones    0

Uso
  Tokens            Main 12k · Agents 3000 · Total 15k
  Coste             Main $0.04 · Agents $0.01 · Total $0.05

Agentes
  explore           completed · 00:16 · 4200
  worker            completed · 00:51 · 10k
  verify            completed · 00:27 · 8000

Permisos
  sandbox           active
  denegaciones      1
```

Rules:

- Sections are omitted when they have no value (`Ticket` without a ticket,
  `Verificación` before anything ran, `Uso` before the run measured anything,
  `Agentes` with no delegations). `Ejecución` is the one exception: the stage is
  the headline answer to "what is it doing?", so it is always printed, and a
  stopped autonomy always carries why it stopped.
- `Uso` groups the run telemetry: `Tokens` and `Coste`, each as `Main · Agents ·
  Total`. An unknown cost prints an em dash, never a zero.
- `Agentes` prints one row per observatory record, `<role>` -> `<status> ·
  <duration> · <tokens>`, and falls back to the delegation counts only when the
  registry has no records.
- Rows keep the `  <label><value>` layout so the same reader works in the terminal
  and in tests.
- Autonomy stop reasons are printed in Spanish (`necesita tu intervención`), never
  as a raw code such as `user_required`.
- Labels are Spanish, consistent with the rest of AIES; technical keys stay in
  English in code and in the telemetry payloads.

### The full telemetry stays one argument away

`/aies-status detalle` (also `all`) prints the complete report — every counter,
phase, tool tally, peak, session id and provider — exactly as it was before this
phase, plus the AIES-010C `Observatorio` section (per-child id, tool count,
tokens, cost, changed paths and recent activity) and the `Uso del run` section
(`main`, `agents`, `total` and the baseline they are measured against). The human
view is the default, not a replacement: telemetry is never deleted because it is
not shown. Both views read the same snapshot the footer does, so they cannot
disagree.

## 14. Commands

Five primitives.

| Command | Role | Visibility |
|---|---|---|
| `/aies-status` | the human view of the session; `detalle` (or `all`) prints the full telemetry | normal |
| `/agents` | the session's children and the selected record's structured detail (AIES-010C) | normal |
| `/aies-ticket [id]` | activate or inspect the Linear ticket | normal |
| `/aies-run [id\|stop\|status]` | bounded autonomy; `status` prints the autonomy view | normal |
| `/aies-info` | resolved profile paths, mode, extension path | diagnostic |

`/aies-info` stays registered but is deliberately demoted: it is a
diagnostic/dev command and must not compete with `/aies-status`. `/agents` is the
one command AIES-010C adds: it opens the ephemeral observatory and intervenes in
nothing. No further command is added for context, verify, permissions, Linear or
autonomy: the UI reduces the need for commands instead of multiplying them.

`/aies-run status` deliberately does **not** reprint the session view. It is the
autonomy command, so it reports the stage, the continuation count, the last step
and why autonomy stopped, and points at `/aies-status` for everything else. Two
commands printing the same report is the duplication this phase removes.

## 15. Model, time, cost

- **Model.** The parent model is shown in the status panel (`Modelo`) and in
  `/aies-status`. Since AIES-010C the observatory also records the model each
  child resolved (`modelLabel`) and its provider (`providerLabel`), taken from the
  role runner's resolved model through the public `model.ts` path, and they appear
  in the activity card metric line and in the `/agents` detail. AIES never invents
  a model it cannot read.
- **Time.** One shared `formatDuration`: `00:14`, `02:31`, `1:04:22`. Used by the
  activity card, the status panel and `/aies-status`, never in the footer.
- **Cost.** Implemented since AIES-010C, from real `SessionStats.cost` only. The
  panel's `Coste` group, the `/aies-status` `Uso` section, the `/agents` detail and
  the DONE card all read the same run telemetry. An unknown cost is unavailable,
  never estimated.

### Glossary

| Term | Meaning |
|---|---|
| **Context** | The current Parent session context in tokens, from `ctx.getContextUsage()`. Always the current Parent context, never cumulative usage and never a sum of child context. The panel row is `Contexto`; the footer segment is `ctx N`. |
| **Tokens** | The provider/runtime token total (`SessionStats.tokens.total`, or the assistant `usage.totalTokens` for the Parent). Reasoning is already inside output and is never added again. Counted once. `Tokens Main` is cumulative provider usage for the run, so it can legitimately exceed the current `Context` figure, which is the live Parent window occupancy. Child usage reaches the aggregate only through the observatory registry. |
| **Cost** | The provider-reported cost in dollars, from `SessionStats.cost` / `usage.cost.total`. An unknown cost renders `—` and is never estimated. |
| **Time** | The current AIES run's wall-clock time, not the sum of the child durations. Each child's own elapsed time is individual (the activity card and `/agents`). |
| **Main** | The Parent bucket: Parent usage since the run baseline. It never includes a child. |
| **Agents** | The sum of the observatory's child records. |
| **Total** | `Main + Agents`, counted exactly once. |

## 16. UI architecture

```
extensions/aies-ui/            pure presentation, no Pi import, no state
  format.ts                    formatTokens, formatDuration, formatCost, clip, paint adapter
  vocabulary.ts                deriveStage, indicators
  footer.ts                    renderFooter/renderHeader + width degradation
  panel.ts                     status panel, responsive bands
  activity.ts                  live card, finished line, entry data
  agents.ts                    mini agents widget, /agents view, selectAgent
  tools.ts                     quiet projections for the six generic tools
  approval.ts                  renderApprovalPrompt
  summary.ts                   DONE / BLOCKED cards, /aies-status overview, /aies-run status
extensions/aies-runtime/       the only writer of the footer, the header and the widgets
  index.ts                     Pi events -> state -> strings
  state.ts                     the runtime state and its transitions
  usage.ts                     aggregateUsage: Main / Agents / Total
  quiet-tools.ts               the Pi boundary for the quiet generic tools
extensions/aies-agents/        the child roles and the registry that observes them
  observatory.ts               the ephemeral, session-local Agent Observatory registry
```

Rules:

- `aies-ui` imports nothing from Pi and holds no state. Every function is
  `state -> string`.
- Exactly one owner per Pi surface: `aies-runtime` owns the footer, the startup
  ticket header, the widget keys `aies-activity`, `aies-agents` and `aies-panel`,
  the `/agents` custom view, the quiet tool registration and the entry renderers;
  `aies-agents` owns the approval dialog and produces the observatory records that
  `aies-ui` renders.
- Painting is injected (`Paint`), so the same renderer works uncolored in tests
  and headless.
- No `packages/ui`, no component registry, no virtual DOM, no state management.
  Pi is the UI runtime.

## 17. Terminal and headless

- Narrow: below 72 columns the status panel renders nothing and the rich footer
  returns, degrading by priority (§5); below 60 columns the ticket header is one
  line. The activity card is boxed from 48 columns and otherwise stays three
  plain lines; the mini agents widget renders from 48 columns and clips the
  detail before the elapsed time.
- cmux/Multiplexer: no absolute cursor movement, no full-screen redraw, no
  terminal-size query beyond `process.stdout.columns`.
- Headless/`print`/`json`: no widget, no status, no entry rendering, no panel. The
  workflow runs identically; `/aies-status` still answers (through `notify`, which
  is a no-op channel there), `/agents` returns its text through `notify`, and the
  state machine is untouched.
- RPC: `hasUI` is true, so dialogs work; widget/status calls are ignored by the
  RPC presenter.
- One timer: the runtime observer owns a single interval, 1s while a child is
  active and 5s otherwise, cleared on shutdown, and it unrefs so it can never
  hold the process open.
- Real smokes: two safe tickets in a scratch `aies-smoke` repository (`EZE-424`
  and `EZE-425`) ran `Worker -> Verify PASS -> Linear Done` on the isolated
  profile, with Linear really reaching `Done`. One `EZE-425` attempt stopped on
  `BLOCKED · V:ERROR` because the scratch fixture itself left `npm test` red, so
  Verify could not close its criteria: that is the protocol-error path rendering
  correctly, not a product defect, and the fixture was repaired before the
  successful run. `aies -p "/aies-status"` exits 0 with no TUI surface, and
  `--mode rpc` slash-command prompts fail identically in ambient `pi`, so that
  failure is Pi's RPC behavior and not an AIES regression. Startup measures
  `0.19s` against a `0.18-0.20s` baseline.

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

### Confirmations from the installed source

The audit was performed against `gentle-pi@3.2.1` on this machine, reading
`extensions/` and `lib/`. Points that matter for AIES:

- The compact bar is `✿ gentle shell ⟡ path branch ±changes ⟡ model · effort ⟡
  ctx gauge percent ⟡ cost ⟡ provider statuses`, fed by `ctx.getContextUsage()`,
  `ctx.model`, `ctx.getThinkingLevel()`, `ctx.sessionManager.getCwd()`,
  `ctx.sessionManager.getSessionName()`, `ctx.sessionManager.getEntries()` (for
  session cost) and `footerData.getExtensionStatuses()`
  (`lib/shell-bar.ts`, `extensions/gentle-shell.ts`).
- Its responsive order is: session name first, then the location is compacted,
  then trailing statuses are removed before final truncation. AIES keeps the idea
  and documents its own order in §5.
- The gauge is 8 cells (`▰`/`▱`), warning at `>=80%`, error at `>=95%`, dim when
  unknown (`lib/shell-gauge.ts`).
- The agents card bounds finished rows to 60 seconds and at most three rows,
  between 3 and 8 rows total, `25%` of terminal height, with `… N more` on
  overflow. AIES copied the TTL idea in AIES-010 and dropped the table (one child
  at a time); AIES-010C dropped the TTL as well, clearing the widget on finish so
  the durable entry is the only trace.
- The startup banner switches between full (at least 30x80), minimal (at least
  20x40) and skipped. AIES has no banner, but this is the same philosophy as the
  footer's documented drop order.
- `ctx.ui.notify`, `setWidget`, `custom`, `setFooter`, `setHeader` and
  `setEditorComponent` never insert a conversation message; `pi.sendMessage`
  always uses Pi's message transport even with `display: false`, and
  `pi.appendEntry` is the durable, context-free channel. This is the mechanic
  §1 of the no-pollution guarantee depends on.
- Gentle does render compact tool rows (`read path`, `$ command`, `grep /re/`)
  through its own quiet-tools extension. AIES-010 rejected this as duplication of
  Pi's native rows, but AIES-010C adopted the idea for exactly the six generic
  tools that flood the transcript (`read`, `bash`, `grep`, `find`, `edit`,
  `write`), through Pi's documented `create*Tool` override pattern rather than a
  parallel tool list, keeping Pi's execution and its native error shell.

Audit note: one referenced document (`orchestration/pi.md`, linked from
`docs/review-integration.md` in the installed package) was not present at the
path it advertises. Nothing in this document depends on it; it is recorded so the
next audit does not chase it twice.

### Comparison table

| Gentle concept | AIES decision | Reason |
|---|---|---|
| Agent activity cards | Adapt | The core feeling to keep: a child working without its transcript. The live card is one running child; AIES-010C adds a bounded mini list and `/agents` for the children already run, not a Gentle-style live agent table. |
| Context gauge (8-cell bar + `%`) | Reject | A meter needs a ceiling to be read, and a ceiling invites "how full am I" math. `ctx 42k` with an `!` only under pressure is quieter and answers the same question. |
| Model + effort in the footer | Reject from the footer, adapt on demand | Always-visible model text is decoration in AIES; the parent model is in the status panel and `/aies-status`, and AIES-010C shows the child's resolved model in the activity card and `/agents`. |
| Elapsed time per row | Adapt | Consistent `formatDuration` in the activity card, the status panel, `/agents` and `/aies-status`, never in the footer. |
| Cost / subscription / usage bars | Reject v1, partially adopted (AIES-010C) | AIES-010 rejected this because there was no reliable per-child source and no own accounting was allowed. AIES-010C reads the real `SessionStats.cost` the child reported and shows Main / Agents / Total; it still builds no pricing catalogue, no subscription meter and no usage bar. |
| Agent history browser | Reject v1, partially adopted (AIES-010C) | AIES-010 considered it out of scope. AIES-010C adds `/agents` over the ephemeral, session-local registry: this session's children with structured detail. It is still not persistent history, not a task store and not a cross-session browser. |
| Persistent sidebar / large orchestration panel | Reject | AIES has one child at a time and one ticket at a time. A sidebar would show a mostly empty tree and permanently steal editor space. The AIES-010C panel is a bounded block below the editor (at most 4 borderless lines from 100 columns, a single-column box of at most 6 lines from 72, never wider than 72 columns), not a sidebar or an editor column, and the startup ticket header renders nothing while the panel is visible. |
| Custom multi-part footer with brand, path, branch, dirty count | Reject | AIES needs one status segment, not the whole footer. Keeping Pi's footer means fewer surfaces to maintain and no loss of Pi features. |
| Finished-row TTL on the widget | Adapt, then dropped (AIES-010C) | AIES-010 copied the TTL to solve "ten historical cards". AIES-010C clears the widget the moment a child finishes and relies on the one durable entry per child, which removes the lingering card and the duplicated rows entirely. |
| Pure renderer + theme interface, tested without a TUI | Adapt | This is why the AIES renderers live in a Pi-free module with injected paint. |
| `ui.select` for closed choices | Reject for approvals | `confirm` already expresses allow/deny with a safe default; a select would add a third option nobody acts on. Reused only where AIES already had it. |
| Compact tool rows (`read path`, `$ command`) from quiet-tools | Reject, then adopted for six tools (AIES-010C) | AIES-010 rejected a second tool list as duplication. AIES-010C re-registers only `read`, `bash`, `grep`, `find`, `edit`, `write` through Pi's documented override pattern, so execution and the native error shell stay Pi's and only the row drawing changes. |
| Startup banner with project, branch, MCP, skills, extensions | Reject | AIES is a harness for one developer on one repository; a banner is startup decoration. `/aies-info` already answers "which profile am I running". |
| Agent overlay, session scope, transcript export | Reject v1, partially adopted (AIES-010C) | AIES-010 rejected it because it needed a child task store, a process protocol and a thread model. AIES-010C adds a bounded, ephemeral `/agents` overlay over in-process session records; there is still no task store, no session scope and no transcript export. |
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

**AIES-010C.** Keeps the same shell and adds what the run was still hiding: a
status panel below the editor on wide terminals (with a minimal footer while it
is present), a mini agents widget and a `/agents` view over the ephemeral
observatory, real Main / Agents / Total usage including each child's resolved
model and cost, quiet rows for the six generic tools, and a compact DONE
projection. The finished-child TTL is removed, so the durable entry is the only
trace of a finished child.

## 20. Linear authentication and the MCP handoff

Linear is reached through the official Linear MCP server, loaded by
`pi-mcp-adapter` in the AIES profile. AIES adds no MCP command of its own:

| Surface | Owner | What the human sees |
|---|---|---|
| `/mcp` | the adapter | server status and tool counts |
| `/mcp-auth linear` | the adapter | the OAuth flow in the browser |
| authentication needed, interactive | AIES | `Linear needs authentication.` then `Run:` and `/mcp-auth linear` |
| authentication needed, headless | AIES | names the session mode and says to authenticate from an interactive session |
| adapter not loaded | AIES | names the missing package and `aies install npm:pi-mcp-adapter` |

`LINEAR_API_KEY` never appears in a message: no AIES code path reads it. A missing
transport is reported as an error and missing authentication as a warning, because
only one of the two needs a human decision.

Once authenticated, `/aies-ticket EZE-422` and `/aies-run EZE-422` need no further
human step. Because AIES owns no MCP client, the Parent performs the call: an action
that needs the remote answers with the exact `mcp` invocation, and the Parent repeats
the same action with `remote: <result>`. The human sees one turn with a few tool
calls, not a prompt. `/aies-run` still starts the work itself when it can, so an
in-process transport stays synchronous.

Headless modes (`print`, `json`, `rpc`) never try to start an OAuth flow.

## 21. Language: Spanish UX, original technical identifiers

AIES user-facing copy is Spanish. That rule lives in one place: a single resident
instruction appended to the Parent system prompt once per agent start
(`before_agent_start`, idempotent):

> Responde siempre al usuario en castellano. Mantén comandos, código, nombres
> técnicos e identificadores en su idioma original. No narres pasos internos si
> la UI ya los representa.

Child sessions are created with `noExtensions: true`, so they never receive it and
their prompts stay technical.

The boundary is deliberate:

| Spanish (visible UX) | Original language (technical) |
|---|---|
| Footer words (`listo`, `compactando…`), overview labels and section titles (`Ejecución`, `Verificación`, `Contexto`, `Uso`, `Agentes`, `Permisos`), and the `/agents` detail labels (`modelo`, `proveedor`, `tiempo`, `tokens`, `coste`, `herramientas`, `archivos`, `actividad reciente`, `resultado`) | Stage tokens `IDLE`..`DONE`, `AUTO`, verdict tokens `PASS`/`FAIL`/`BLOCKED`, indicators `V:*` |
| Activity facts (`3 archivos modificados`, `checks aprobados`, `4/4 criterios`) | Ticket identifiers (`EZE-417`), Linear `status` values, model ids, session ids, the `/agents` title `AIES Agents` and the record statuses (`running`, `completed`, `failed`, `blocked`) |
| Approval dialog (`AIES necesita permiso`, `Permitir una vez`, `Denegar`) and telemetry labels in `/aies-status detalle` | Commands, code, paths, tool names and technical telemetry values such as model, zone and sandbox identifiers |

A raw internal code never reaches the visible row: known Linear error codes map to
a short Spanish phrase (for example `invalid_remote_payload` → `respuesta inválida
de Linear`) and an unknown code degrades to a safe fallback.

## 22. Quiet AIES tool rendering and MCP presentation settings

AIES-owned plumbing is compact by default; the raw content stays one expansion
away. Since AIES-010C the six generic tools that carry raw file and shell traffic
are quiet too.

### AIES-owned plumbing

| Tool | Collapsed | Expanded |
|---|---|---|
| `aies_ticket` | one row: pending (`⟳ EZE-422 · cargando…`), settled (`✓ EZE-422 · cargado`), a `remote_required` handoff (`→ Linear · <tool>`) or a visible error (`✗ EZE-422 · verificación denegada`) | the complete original text, byte-identical |
| `aies_delegate` | one short role line before the card exists (`◆ Worker · trabajando…`), nothing on success once the activity card owns the surface, or a visible failure (`✗ Worker · falló`) | the complete original handoff, byte-identical |

### Generic tools

`read`, `bash`, `grep`, `find`, `edit` and `write` are re-registered through Pi's
documented `create*Tool(cwd)` override pattern: one original instance runs, its
`execute` is delegated untouched, and only `renderCall`/`renderResult` are added.
The native shell is kept (no `renderShell: "self"`), so Pi still frames a failure.
Collapsed success rows:

```
› read  src/calculator.js ✓
› grep  TODO · 3 coincidencias
› find  src · 2 archivos
› edit  src/calculator.js ✓ +2 / -1
› bash  npm test ✓
```

- `›` marks a settled success and the target is the call's own subject: `<path>`
  for `read`/`edit`/`write`, the `<command>` for `bash`, the `<pattern>` for
  `grep`, and `<path|pattern>` for `find`. It is clipped to 60 columns, and the
  name column is fixed so every target starts at the same cell.
- `grep` adds `· N coincidencias` (singular `coincidencia`) and `find` adds `· N
  archivos` (singular `archivo`), from the real entry lines of the result. `edit`
  adds `✓ +A / -R` from the diff.
- `bash` adds one dim output line only when the result is exactly one non-blank
  line of at most 60 characters; Pi's `(no output)` placeholder is never drawn as
  a fact, and the bash duration is deliberately absent because the public details
  never carry it.
- A real truncation (`truncation`, `matchLimitReached`, `linesTruncated` or
  `resultLimitReached`) appends a `[truncated]` hint so a partial result is never
  swallowed by the row.
- Expanded success prints the raw `content` byte for byte plus the real detail
  facts (the diff for `edit`, the showing-of-total range for a truncated
  `grep`/`find`).
- A failure is always visible, whether collapsed or expanded: the native error
  flag, the result's `isError` or a structured `details.error`. Collapsed it shows
  `✗ <tool> <target>` followed by up to three real error lines; expanded it shows
  every line. An error never collapses away.

Boundaries:

- Presentation hooks change only the human projection. They never mutate the
  execution result, `content`, `details`, the error flag or the schema.
- Errors stay visible; only routine success and intermediate plumbing collapse.
  A Verify protocol fault reads `error de protocolo de verificación`.
- Only the six named generic tools are quiet. Every other Pi tool keeps Pi's own
  rendering, and the external `mcp` tool is not wrapped at all.
- Renderers never send a conversation message: no UI path calls `sendMessage`.
- The adapter's quiet result mode is pinned in `profile/mcp.json` —
  `toolResultRendering: "compact"`, `collapsedResultLines: 1`,
  `notifyOnStartupConnect: false`, `mcpFooterStatus: "off"`. These are
  presentation settings only: the `mcp` schema and the parent-mediated
  `remote_required → mcp → replay` flow are unchanged.
