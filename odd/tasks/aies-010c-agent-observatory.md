# AIES-010C — Agent Observatory, Telemetry & Final Visual Polish

Status: complete
Branch: `feat/aies-010c-agent-observatory`
Baseline: real EZE-423 smoke (`Worker → Verify PASS → Linear Done`)
Scope: final presentation and observability phase before AIES-011 Calibration

## Goal

Make an active AIES run legible at a glance without reading Parent reasoning or
raw tool traffic: ticket, stage, Parent model/provider/context, run time, active
and completed agents, real token/cost usage, Verify and Linear outcome. Add one
interactive `/agents` view over session-local child facts.

## Product invariants

- Pi owns runtime; AIES owns presentation of the AIES workflow.
- Agent Observatory is ephemeral presentation state, not agent orchestration.
- The registry observes existing Explore/Worker/Verify sessions and never routes,
  authorizes, persists, retries or changes their prompts.
- Parent and child usage come only from Pi/provider usage records. `tokens` means
  provider/runtime `totalTokens`; reasoning is already included in output and is
  never added again. Unknown cost is shown as unavailable and is never estimated.
- Main excludes child usage; Agents is the sum of finalized/current child usage;
  Total is Main + Agents exactly once.
- Context always means current Parent context, never cumulative usage.
- Time is wall-clock time for the current AIES run; child elapsed is individual.
- UI-only facts never enter model context. No transcript duplication, polling,
  persistence, pricing catalogue, analytics backend or new role.
- All AIES user-facing copy is Spanish; technical names remain unchanged.
- Routing, thresholds, repair limits, autonomy, permissions, sandbox, Linear/MCP
  architecture and child roles are locked except for the bounded Linear invalid
  payload defect proven by the EZE-423 smoke.
- Replace obsolete presentation paths rather than layering compatibility UI.

## Authorized edit surfaces

- `extensions/aies-agents/**`
- `extensions/aies-runtime/**`
- `extensions/aies-ui/**`
- `tests/**`
- `docs/UX.md`
- `docs/ARCHITECTURE.md`
- `docs/DECISIONS.md`
- `odd/tasks/aies-010c-agent-observatory.md`

## Work units

| Task | Status | Outcome | Commit |
|---|---|---|---|
| T1 Baseline, Pi/Gentle audit and design freeze | complete | Mapped AIES-010B seams, Pi 0.85.1 usage/UI APIs, selective Gentle patterns, the EZE-423 invalid-load defect, responsive layout and six bounded work units. | `a13e97f` |
| T2 Linear invalid-load boundary | complete | Rejects remote issues without non-empty `identifier`/`id` before state mutation, keeps the previous ticket on invalid refresh, renders a Spanish failure, and proves `no_pending_remote` is the expected stale-replay guard. | `70ad842` |
| T3 Ephemeral Agent Observatory and exact usage | complete | Added the pure session-local registry, mechanical Spanish activity derivation, real child `SessionStats` usage sampling that survives disposal, event-driven child wiring, and run-scoped Main/Agents/Total aggregation with incremental Parent sampling. | `832b549` |
| T4 Observatory presentation and `/agents` | complete | Added the boxed status panel, panel-aware minimal footer, boxed live card with no lingering finished card, mini agents widget, interactive `/agents`, telemetry in `/aies-status` and the compact DONE projection. | `22481aa` |
| T5 Quiet generic tool rendering | complete | Re-registered the six generic tools through the documented Pi pattern with delegated execution, compact `›` rows, always-visible bounded errors and byte-identical native expansion. | `d176fb4` |
| T6 Documentation, full verification and real smokes | complete | Documented the shipped observatory, corrected the docs after the smoke-driven fixes, ran three real `/aies-run` smokes plus `/agents`, width and headless checks, and closed with 630/630 tests, isolation and shell syntax green. | `cc3c593` + docs |

## Design freeze

- Registry lifetime: one Parent session; reset on new session, no snapshot restore.
- Registry cardinality: sequential child records with stable `<role>-<ordinal>` ids;
  current architecture still runs one primary child at a time.
- Recent activity: bounded ring buffer of five mechanically derived tool events.
- Activity wording: tool name + sanitized path/command (`Leyendo`, `Buscando`,
  `Editando`, `Ejecutando`, `Comprobando`); never child-authored narration.
- Usage source: child `AgentSession.getSessionStats()` before disposal; live usage
  may be sampled from the same session on observed events. Parent usage is reduced
  from Parent session entries/run baseline and never includes child usage because
  delegated child sessions remain in-memory and `aies_delegate` returns no nested
  `usage` field.
- Wide status surface: the boxed panel is rendered through `ctx.ui.setHeader` in
  the wide band (`>= 100` columns, two inner columns, at most 8 lines), a compact
  single-column box from 72 columns, and nothing below that. It replaces the
  ticket header in those bands instead of duplicating it, is not a sidebar and
  steals no editor width. Footer is minimal while the panel is present and the
  rich fallback otherwise. The live card and the mini agents list stay widgets
  above the editor.
- `/agents`: one Pi `ctx.ui.custom()` component, arrow navigation and Escape;
  no extra commands or full-screen framework.
- Generic tools: keep Pi execution/result shapes and global native
  `app.tools.expand`; presentation override only. Errors never collapse away.
- No independent presentation timer: reuse the runtime observer's single adaptive
  timer and event-driven invalidation.

## Required evidence

- Strict RED/GREEN focused tests for every behavior-bearing work unit.
- Registry lifecycle, sequential agents, bounded activities, live/final usage,
  missing cost and no double counting.
- Parent/child model and provider projection.
- Active card, status widget, `/agents` navigation, narrow terminal and headless.
- Compact successful generic tools, expanded raw detail and visible errors.
- Exactly one completed Worker entry and one Verify result.
- Compact Spanish DONE summary and no-context-pollution seam.
- Invalid Linear payload regression; `pending_remote` regression only if diagnosis
  proves a product defect.
- `npm test`
- `npm run check:isolation`
- `bash -n bin/aies scripts/*.sh`
- `git diff --check`
- Real cmux and tmux 80-column visual validation.
- Safe real E2E: `Worker → Verify PASS → Linear Done`, including `/agents` while
  running and after completion.
- Approximate startup before/after and render/update cadence comparison.

## Scope exclusions

No Planner/Reviewer/new roles, parallelism, persistent history, task database,
web/browser UI, memory, task graph, GitHub, new MCP servers, pricing database,
analytics/telemetry server, cloud sync, provider protocol changes, reasoning
capture, routing/autonomy/permission/context-policy redesign, push or PR.

## Evidence log

- Branch created from AIES-010B tip `f10cc84` after removing the explicitly
  authorized untracked HTML session export.
- Pi 0.85.1 public docs confirm `AgentSession.getSessionStats()`, `ctx.ui.custom()`,
  widget/footer factories, native `app.tools.expand`, semantic theme colors and
  presentation-only custom tool renderers.
- The EZE-423 invalid-load symptom is reachable because `performLoad()` accepts
  any truthy object, and `normalizeTicketContract()` lets both `identifier` and
  `id` collapse to `undefined` before mutating `activeTicket`.
- Baseline launcher startup (`AIES_HOME=/tmp/aies-010c-startup-baseline
  bin/aies --aies-info`) measured 0.20s, 0.18s and 0.18s wall-clock.
- A CodeGraph initialization probe created `.codegraph/` and `.cursor/`; the
  tooling incident was isolated and both generated directories were removed.
  They are outside AIES-010C and must not reappear.
- T2 RED reproduced a truthy `{ foo: "bar" }` MCP replay activating an identity-less
  ticket. GREEN validates non-empty `identifier`/`id` before state mutation,
  rejects uuid-only payloads, preserves the active ticket on invalid refresh and
  maps the collapsed error to `respuesta inválida de Linear`.
- `no_pending_remote` is expected replay protection: it occurs only after the
  pending operation was consumed; repeating the action without `remote` safely
  re-derives the directive. No transport behavior changed.
- T2 independent focused verification: 75/75 tests pass across Linear,
  tool-rendering and smoke-linear; `git diff --check` passes.
- T3 RED: the registry suite failed on a missing `usage.ts` export, and the wiring
  suite failed 10/11 before `attachChildObservatory` existed. GREEN: registry 37/37,
  wiring 11/11, focused child suites 143/143.
- T3 child usage reads the real public `SessionStats` fields `tokens.total` and
  `cost`; `cost` becomes `null` when the value is not finite and is never estimated.
  Finalized usage lives in the registry, so it survives `session.dispose()`.
- T3 run telemetry RED failed on the missing `applyAgents` export; GREEN 22/22,
  then 24/24 after the incremental-sampling correction. Parent usage is reduced
  once per appended session entry from a closure cache, reset on `session_start`.
- Child records are ephemeral by construction: `toSnapshot` never writes `agents`
  and `fromSnapshot` never reads it, so a resume cannot resurrect a finished child.
- T3 full suite 518/518, isolation 518/518, `bash -n` clean, `git diff --check`
  clean. Independent verification confirmed all seven invariants with no blocker:
  one timer still owned by `aies-runtime`, no `sendMessage`, and unchanged
  `aies_delegate` handoff shapes and child tool surfaces.
- T4a RED failed on the missing `panel.ts`/`agents.ts` modules, the missing
  `formatCost` export and the retired `ACTIVITY_TTL_MS` seam contract; GREEN 145/145
  focused. Identity is now the single `✧` glyph; a finished child clears its widget
  immediately, so the durable entry is the only trace and the smoke's duplicated
  `✓ Worker` rows cannot recur.
- T4b RED failed 7/9 on the panel band, footer minimality, the `aies-agents`
  widget, `/agents` navigation and the DONE telemetry; GREEN 10/10. The stale
  command-inventory assertion in `tests/observability.test.mjs` was updated to
  `["aies-status", "agents"]` because `/agents` is an explicit product requirement.
- T4 independent verification: 556/556 tests, isolation green, shell syntax clean,
  all eight invariants PASS with no blocker. It found one real cosmetic defect —
  a long mini-widget detail collided with the elapsed column
  (`Verificando npm test02:00`); fixed by clipping to `DETAIL_WIDTH - 1` with a
  RED-first regression, now rendering `Verificando npm … 02:00`. Suite 557/557.
- T5 uses the documented `built-in-tool-renderer` pattern: public `create*Tool(cwd)`
  instances delegate `execute` unchanged, and only `renderCall`/`renderResult` are
  added. The native shell is kept, so a failed result keeps Pi's error framing.
  `bash` duration is deliberately absent because the public details never carry it.
- T5 independent verification: 7/7 invariants PASS, 607/607 tests, isolation green,
  shell syntax clean. Real renders confirmed `› read  src/calculator.js ✓`,
  `✗ bash  npm test` with three bounded error lines, and byte-identical expanded
  output. Two cosmetic notes recorded: a trailing blank line in expanded raw text
  (faithful to the bytes) and no live-TUI render proof yet — T6 covers that.

### T6 real smokes (safe `aies-smoke` repository, isolated AIES profile)

- Smoke 1 — `EZE-424` (new safe ticket, broken `clamp` fixture), 140-column tmux
  TUI, model MiniMax-M3: `LOAD → START → Worker → Verify PASS 7/7 → Linear Done`.
  Linear really reached `Done` (state history confirms). Compact tool rows worked
  live (`› bash  pwd && ls -la ✓`, `› read  …/src/cla… ✓`), MCP rows stayed one
  line with `(Ctrl+O to expand)`, and the session file held exactly two
  `aies-agent` entries — one Worker, one Verify — with no duplicate.
- Smoke 1 defects found (all invisible to the unit suites):
  1. The status panel lived in `ctx.ui.setHeader`, which is Pi's *startup*
     header: it scrolled out of view as soon as the transcript grew, so the panel
     was never visible during the run.
  2. The compact DONE card was never emitted — no `aies-summary` entry exists in
     the session file. The `✓ EZE-424 · completado` line in the transcript was the
     `aies_ticket` complete row, not the card.
  3. The idle panel printed `Coste Main/Agents/Total $0.00` with no run.
- Smoke 2 — `EZE-425`, first attempt: ended `BLOCKED · V:ERROR` because my own
  fixture left `npm test` red through a pre-existing `calculator.js` defect, so
  Verify could not close its criteria. That is a fixture mistake, not an AIES
  defect, and it is real evidence that the protocol-error path renders correctly
  (`BLOCKED` stage plus the `V:ERROR` alarm in both panel and footer, no fake
  verdict, no automatic retry). The fixture was repaired on `main` and the ticket
  reset to `Todo`.
- Smoke 2 — `EZE-425`, second attempt: `LOAD → START → Explore → Worker →
  Verify PASS 5/5 → Linear Done`, confirmed in Linear. Live surfaces observed:
  persistent panel below the editor with model/provider, `ctx`, run time, agent
  count and `Tokens`/`Coste` Main·Agents·Total; the boxed live card; the mini
  agents widget; one durable entry per child (`✓ Explore · 00:33 · 7 archivos
  relevantes`, `✓ Worker · 00:16 · 1 archivo modificado · checks aprobados`,
  `✓ Verify · PASS · 00:17 · 5/5 criterios`); and the compact DONE card with
  `Linear ✓ Done`, `Tokens 374k (main 253k · agents 121k)`, `Coste $0.05`,
  `Tiempo 02:03`.
- `/agents` real smoke: opened while Verify was running, it listed `Explore #1
  completed`, `Worker #1 completed`, `Verify #1 running` with model, provider
  display name, elapsed, tokens, cost, tool count, recent mechanical activity and
  result; `→` moved the selection and updated the detail; `Esc` closed it. After
  completion the same records remained with their telemetry.
- Structural defect found by smoke 2 and fixed: Pi loads each extension with its
  own jiti instance (`moduleCache: false`), so the `observatory` singleton was two
  different objects in `aies-agents` and `aies-runtime` — the panel showed
  `Agentes 0`, `Tokens Agents 0` and `/agents` said `sin agentes en esta sesión`
  while children had really run. The registry now crosses the extension boundary
  through Pi's documented `pi.events` bus on the stable `aies:agents` channel.
- Width degradation, live: 140 columns → wide panel (4 lines) + minimal footer;
  80 columns → mid single-column boxed panel + minimal footer; 60 columns → panel
  hidden and the rich footer fallback returns (`… · ctx 19k · MiniMax-M3 ·
  aies-smoke`).
- Headless: `aies -p "/aies-status"` exits 0 with no TUI surface and no leak.
  `--mode rpc` slash-command prompts fail with
  `Cannot read properties of undefined (reading 'startsWith')` for *every*
  command including `/nonexistent-xyz` — and the ambient `pi --mode rpc` behaves
  identically, so this is Pi's RPC prompt behavior, not an AIES regression.
- Performance: startup after the phase is 0.19s, 0.19s, 0.19s
  (`AIES_HOME=/tmp/aies-010c-startup-after bin/aies --aies-info`) against the
  0.20s/0.18s/0.18s baseline. Still exactly one adaptive interval (1s active,
  5s idle), Parent usage reduced incrementally once per session entry, and no
  flicker was observed across the captured frames.
- Autonomy note: the persisted `aies-autonomy` entry shows `stopReason: null`
  because `aies-agents/index.ts` appends that snapshot *before* calling
  `controller.handleSettled(...)`. The policy itself is correct, and the DONE card
  no longer depends on it: it is edge-triggered on the observed ticket completion.
- Smoke 3 — `EZE-426` after the bridge and polish fixes: the persistent panel,
  capped boxed card (`╭─ ◆ Verify ─…╮` at 72 columns), mini widget with a
  mechanical activity (`◆ Verify   Ejecutando git l… 00:09`), live
  `Tokens Main 67k · Agents 91k · Total 158k` and `Coste Main $0.01 · Agents
  $0.01 · Total $0.02` were all observed while the run worked. The run ended
  `BLOCKED` for a cause outside this phase: the Verify child tried nine PASS
  completions and `aies_verify_complete` rejected every one, so the child
  reported `BLOCKED` with one blocking defect. `git diff f10cc84..HEAD` proves
  `handoff.ts` (the validator) is untouched by AIES-010C and `verify.ts` changed
  only for observatory begin/finish, so this is pre-existing AIES-010B strictness
  under D19, not a regression. The presentation behaved exactly as specified:
  `! Verify · BLOCKED · 04:13 · 1/1 criterio · 1 defecto bloqueante` once, stage
  `BLOCKED` in panel and footer, and the Parent refused to force `Done` without a
  PASS. Recorded as a known limitation for AIES-011 Calibration.
- Duplicate-headline defect found by smoke 2 and fixed: the transcript showed the
  `aies_ticket` complete row, the DONE card and a third `notify` headline. The
  summary headline is now notified only when the durable card is not drawn.
- `/agents` absolute-path defect found by smoke 2 and fixed: the detail `archivos`
  row now uses bounded repository-relative short paths with a `… N más` remainder.
- Final repository verification: `npm test` 630/630, `npm run check:isolation`
  green, `bash -n bin/aies scripts/*.sh` clean, `git diff --check` clean.
