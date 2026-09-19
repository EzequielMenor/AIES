# AIES-010C — Agent Observatory, Telemetry & Final Visual Polish

Status: in progress
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
| T2 Linear invalid-load boundary | complete | Rejects remote issues without non-empty `identifier`/`id` before state mutation, keeps the previous ticket on invalid refresh, renders a Spanish failure, and proves `no_pending_remote` is the expected stale-replay guard. | pending commit |
| T3 Ephemeral Agent Observatory and exact usage | pending | Add lifecycle registry, mechanical activity events, model/provider, tools, paths, ring buffer and real Parent/Agents/Total token/cost aggregation without double counting. | — |
| T4 Observatory presentation and `/agents` | pending | Add active card, compact agents/status widget, interactive keyboard navigation, richer `/aies-status`, responsive footer fallback and compact DONE projection. | — |
| T5 Quiet generic tool rendering | pending | Use Pi-supported renderer overrides for compact successful `bash/read/grep/find/edit/write`, native expansion for raw detail and automatically visible failures, without changing tool execution/model content. | — |
| T6 Documentation, full verification and real smokes | pending | Update architecture/UX/decision docs, run full/isolation/shell checks, compare startup/render cadence, validate cmux + 80 columns + headless, and complete safe live `/aies-run` plus `/agents` smoke. | — |

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
- Wide status surface: a compact Pi widget, not a sidebar/runtime replacement;
  hidden at the narrow breakpoint. Footer is minimal while it is present and the
  rich fallback otherwise.
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
