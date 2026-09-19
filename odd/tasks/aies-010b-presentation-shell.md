# AIES-010B — Presentation Shell, Spanish UX & Real-Run Hardening

Status: in progress
Branch: `feat/aies-010b-presentation-shell`
Baseline: latest real `EZE-422` session in the isolated AIES profile
Scope: presentation of AIES-specific workflow plus the narrowly authorized Verify handoff fix

## Goal

Make `/aies-run <ticket>` feel like AIES rather than exposed Pi/MCP plumbing. The
human should understand the ticket, stage, active agent, outcome, intervention,
Verify result and Linear completion from the ticket header, AIES shell, agent card
and terminal summary alone.

## Product invariants

- Pi owns the runtime; AIES owns presentation of AIES-specific workflow.
- Runtime state flows into presentation. Rendered text never drives workflow.
- All AIES user-facing copy is Spanish. Code, commands, paths, identifiers, models
  and standard technical names remain in their original language.
- UI-only progress uses Pi presentation surfaces and never model messages.
- AIES-specific plumbing is compact by default; errors and detail remain observable.
- Generic Pi tools keep Pi rendering unless evidence supports a targeted exception.
- Parent-mediated MCP, routing, permissions, sandbox, Context Governor thresholds,
  Linear policy, autonomy and repair budget do not change.
- Verify result and handoff protocol status are separate facts. A protocol failure
  must not fabricate `BLOCKED` or turn `FAIL` into `PASS`.
- No new agent, dashboard, sidebar, MCP server, memory subsystem, parallelism, Git
  automation, PR, push or deployment.

## Authorized documentation surface

Only these documentation files may change:

- `docs/UX.md`
- `docs/ARCHITECTURE.md`
- `docs/DECISIONS.md`
- `odd/tasks/aies-010b-presentation-shell.md`

## Work units

| Task | Status | Outcome | Commit |
|---|---|---|---|
| T1 Baseline and design map | complete | Audited the latest real EZE-422 session, quantified visible noise, re-audited exact gentle-pi 3.2.1 and Pi 0.85.1 APIs, and froze the presentation/protocol seams below. | `11fd177` |
| T2 Spanish shell and ticket identity | complete | Added the resident Spanish rule, responsive ticket header and AIES footer, Spanish status/approval/DONE/BLOCKED projections, safer agent-card copy and invariant tests. | `bba2ede` |
| T3 Quiet AIES plumbing and agent cards | complete | Added compact Spanish `aies_ticket` rendering, card-first `aies_delegate` rendering, visible collapsed errors, complete expanded detail and effective compact Linear MCP settings. | `89a0c0f` |
| T4 Verify protocol hardening | complete | Reproduced EZE-422, made a schema-validated child completion tool the sole verdict authority, separated `protocol_error` from domain verdicts, and prevented repair/retry on protocol faults. | `73af9e3` |
| T5 Documentation and real-run evidence | pending | Update the three allowed docs, run full/isolation/headless/PTY checks, perform the safe real E2E smoke, capture before/after metrics and close the task record. | — |

## Baseline EZE-422

Source session:
`~/.local/share/aies/agent/sessions/--Users-ezequielmenor-Proyectos-Developer-aies-smoke--/2026-09-19T14-37-13-751Z_01a0ba19-9497-7401-8142-d9e10e631d26.jsonl`

| Signal | Before |
|---|---:|
| Visible Parent narration blocks | 9 |
| Raw Parent tool calls / results | 20 / 20 |
| AIES-owned tool rows | 11 (`aies_ticket` 7, `aies_delegate` 4) |
| Linear MCP calls | 4 |
| Visible child records | 4 (Worker 1, Verify 3) |
| Verify attempts | 3, all falsely projected as `BLOCKED` |
| Context peak | 44,902 tokens |
| Compactions | 0 |

Observed flow:
`LOAD → MCP get_issue → LOAD replay → START → MCP statuses → START replay → MCP save_issue → START replay → Parent inspection → Worker DONE → Verify BLOCKED ×3 → MCP save_comment → BLOCKED`.

The Parent narrated every meaningful transition in addition to native tool rows and
AIES cards. Verify's substantive evidence passed, but malformed final JSON was
converted into a domain `blocked` verdict and retried three times.

## Locked implementation seams

1. `aies-runtime` remains the sole Pi-facing presentation owner.
2. The AIES status segment is replaced by a full `ctx.ui.setFooter()` shell while
   AIES is active. It renders identity, ticket, stage, context and AUTO first;
   model and compact cwd are opportunistic.
3. The active ticket uses `ctx.ui.setHeader()` and degrades from a small boxed
   identity to one compact line at narrow widths. Header/footer render from the
   same snapshot and never feed workflow decisions.
4. `aies_ticket` and `aies_delegate` receive presentation-only
   `renderCall`/`renderResult` functions. Intermediate `remote_required` results
   and delegate tool chrome collapse; errors and expanded detail remain available.
5. The external `mcp` tool is not wrapped or replaced: Pi exposes no documented
   executable definition for arbitrary extension tools. AIES pins the adapter's
   compact one-line result mode and relies on native expansion for raw payloads.
   No model-visible MCP content is rewritten for presentation.
6. A short `before_agent_start` amendment is the single resident Spanish/quiet
   Parent rule. Child prompts stay technical and English where useful.
7. Verify gains a schema-validated completion tool inside the isolated child. A
   captured verdict is independent of the child's final prose. A missing/invalid
   handoff is `protocol_error`, never a domain `blocked`; it cannot trigger Worker
   repair or be silently promoted to PASS.
8. Existing `aies-ui` modules are extended. No generic UI framework, tool-rendering
   subsystem, new agent or second timer is introduced.

## Reused patterns from exact `gentle-pi@3.2.1`

- Tool execution stays intact while `renderCall`/`renderResult` change only the
  human projection.
- One custom footer factory, semantic theme roles, width-priority degradation and
  explicit shutdown cleanup.
- One live agent widget, 60-second finished TTL and durable context-free entries.
- Bounded collapsed output with complete expanded detail.
- Not copied: task store, RPC runner, SDD/review UI, agent protocol, sidebar,
  dashboard, history browser, cost accounting or shell editor replacement.

## Required checks

- Focused RED/GREEN tests for every changed behavior.
- `npm test`
- `npm run check:isolation`
- `bash -n bin/aies scripts/*.sh`
- Spanish copy invariants without brittle full-string snapshots.
- Quiet-rendering checks for `aies_ticket`, normal Linear MCP, `aies_delegate`, and
  visible MCP errors.
- Ticket header and footer at normal and narrow widths, AUTO on/off, pressure and
  compaction.
- No UI path calls `sendMessage` or otherwise adds model context.
- Verify regression: evidence PASS plus imperfect final handoff does not cause
  false BLOCKED, repeat Verify or consume repair budget.
- Headless behavior remains functional.
- Real TUI smoke in the safe `aies-smoke` repository, plus cmux when available.
- `/aies-status` default and `detalle` escape hatch.

## Evidence log

- Branch created from clean, verified hotfix tip `54c116a`.
- Baseline rerun: `npm test` — 356/356 pass; `bash -n bin/aies scripts/*.sh` — pass.
- Exact Gentle audit source: npm tarball `gentle-pi@3.2.1`, unpacked under `/tmp` only.
- T2 focused verification: 173/173 pass.
- T2 independent verification: `npm test` and `npm run check:isolation` — 381/381 pass; shell syntax — pass.
- T2 native review lineage `review-19dac445e85037cd` could not capture its reviewer because the Pi host relay returned `MissingSessionID` twice; no review verdict or authority acknowledgement was produced.
- T3 focused verification: 86/86 pass; independent full verification: 411/411 pass plus isolation and shell syntax.
- T3 native review lineage `review-f74ac7fe1328db6d` could not capture its reviewer because the Pi host relay returned `MissingSessionID`; no review verdict or authority acknowledgement was produced.
- T4 deterministic regression and smoke verification: 212/212 focused checks and 439/439 full/isolation checks pass; shell syntax passes.
- T4 independent verifier confirmed the EZE-422 free-form PASS pattern now becomes `protocol_error` once, with zero repairs and no automatic rerun; captured tool verdicts survive malformed or failing final prose.
- T4 native review lineage `review-8f0a4e587dc336a6` could not capture its reviewer because the Pi host relay returned `MissingSessionID`; no review verdict or authority acknowledgement was produced.
- Real baseline session located at:
  `~/.local/share/aies/agent/sessions/--Users-ezequielmenor-Proyectos-Developer-aies-smoke--/2026-09-19T14-37-13-751Z_01a0ba19-9497-7401-8142-d9e10e631d26.jsonl`.

## Known constraints

- The real smoke must not touch a production repository or unsafe Linear ticket.
- The installed AIES profile may contain reusable OAuth credentials, but no secret
  material may be printed, copied or exposed to children.
- Commit and smoke evidence are recorded here; no push or PR is authorized.
