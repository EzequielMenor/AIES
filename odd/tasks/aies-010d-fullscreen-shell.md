# AIES-010D — Full-Screen Product Shell & Transcript Polish

Status: active — final product-polish pass before UI v1 freeze
Branch: `feat/aies-010d-fullscreen-shell`
Baseline: AIES-010C, 630/630 tests
Scope: final presentation shell, profile theme, role model configuration and UI freeze before AIES-011
TDD: user-required regression-first; runner `node --test` for focused tests, then `npm test`
Delivery: Conventional Commits by work unit; no push and no pull request; finish with a clean working tree
Delivery strategy: current feature branch only, explicitly requested by the user; forecast exceeds 400 authored lines because it closes several already-authorized UX surfaces, so commits stay independently reviewable and no PR is created

## Goal

Make a real `aies` launch feel like an intentional full-screen AIES product rather
than a Pi session with AIES widgets: clean startup, separated status surface,
prominent agent activity, quiet successful tools, preserved error detail, compact
DONE, responsive degradation and clean terminal restoration.

## Product invariants

- Pi remains the runtime; AIES uses only documented public extension/TUI APIs and profile settings.
- This phase changes presentation and profile-local role model preferences only. Agent Observatory semantics, routing, autonomy, Verify, repair, permissions, sandbox, Linear/MCP mediation and telemetry sources are locked.
- No terminal renderer, database, agent history, new metrics, roles or framework.
- The run-local Todos checklist is a derived ephemeral projection of existing workflow state; it has no persistence and no authority.
- `/aies-models` uses Pi's available model registry and capability metadata; it never hardcodes model/provider catalogues or silently stores invalid effort combinations.
- Parent model persistence uses Pi's isolated profile settings semantics. Child-role preferences live only under the isolated AIES profile and apply to future delegations, never active children.
- Raw tool output remains available through Pi's native expansion; failures remain prominent.
- Thinking visibility changes only through a supported Pi profile setting, never interception or chain-of-thought capture.
- All AIES user-facing copy remains Spanish; technical identifiers remain unchanged.
- Responsive bands: full status surface at >=120 columns, compact at 80–119, hidden below 80 with a rich footer fallback.
- Full-screen startup and teardown must preserve Ctrl+C, resize, cursor state and shell usability.
- Prefer replacing/simplifying the AIES-010C UI over adding parallel surfaces; keep net code growth small.
- Manual visual acceptance in a real AIES TUI is authoritative after automated checks.

## Authorized edit surfaces

- `bin/aies`
- `profile/settings.json`
- `profile/aies.json`
- `themes/**`
- `scripts/bootstrap-profile.sh`
- `extensions/aies-identity.ts`
- `extensions/aies-runtime/**`
- `extensions/aies-ui/**`
- `extensions/aies-agents/autonomy/**`
- `extensions/aies-agents/linear/**`
- `tests/**`
- `docs/UX.md`
- `docs/DECISIONS.md`
- `odd/tasks/aies-010d-fullscreen-shell.md`

## Work units

| Task | Status | Outcome | Commit |
|---|---|---|---|
| T1 Exact Gentle/Pi audit and design boundary | complete | Audited exact gentle-pi@3.2.1 and Pi 0.85.1: fullscreen/alternate-screen and quiet startup are public settings; the Gentle right rail is an experimental private layout-node patch and cannot be reused under AIES's public-API boundary. | `ee2b646` |
| T2 Clean launch, idle state and teardown | complete | Enabled Pi-owned fullscreen, resume-hint teardown, quiet startup and public thinking-block hiding; removed the redundant startup notification and preserved `/aies-info`. | `7b12933` |
| T3 Product shell, responsive status and quiet transcript | complete | Added the 120+/80–119 status-dock tiers and <80 rich footer fallback, integrated the agents overview, removed its duplicate widget and gave six generic tools compact self-owned shells with raw expansion and visible failures. | `bf9e9a2` |
| T4 Documentation and automated verification | complete | Documented the public/private boundary and D23, reconciled historical presentation contracts, preserved the activity card's independent cap and passed all automated gates. | `c21d3ee` |
| T5 Real visual and E2E acceptance | invalidated | The prior captures proved only a below-editor dock, which fails the corrected requirement for a physical right rail. | — |
| T6 Pi 0.86.1 public API re-audit | complete | Confirmed installed Pi 0.86.1 still exposes only above/below editor widgets; its fullscreen layout root remains private. User authorized one isolated compatibility shim. | — |
| T7 Isolated right-rail shim and corrected projections | complete | Corrected the real visual overlap: a showing rail is now the sole dock-yield signal, independent of reduced widget width. RED/GREEN 42/42, independent verification PASS, and rerun 160-column capture proves rail-only status. | included in next UI work-unit commit |
| T8 Clean startup and contract documentation | complete | Documented D24: the single user-authorized, 0.85/0.86-guarded private compatibility shim, its fallback/debt/removal conditions, and pending T9 visual authority. Focused checks 41/41; independent documentation verification PASS. | included in next UI work-unit commit |
| T9 Real cmux correction and visual acceptance | superseded by final pass | EZE-427 demonstrated that the physical rail architecture exists and the 120-column correction works, but also exposed transcript noise, missing Todos/models surfaces and unfinished product coherence. Preserve its verified rail/fallback work; final acceptance moves to T14. | — |
| T10 Transcript ownership and deterministic outcomes | complete | Pi 0.86.1 public hidden custom messages now carry autonomy and Linear instructions to the model without transcript rendering; compact Linear rows, the short resident anti-chatter rule and single durable runtime DONE/BLOCKED are regression-locked. Focused 190/190, adjacent 101/101, independent verification PASS. | `c40aa15` |
| T11 Unified shell, rail and run-local Todos | complete | One theme-backed semantic vocabulary now drives Status, Agents, Todos, `/agents`, summaries and footer; Todos are a pure ephemeral workflow projection; the height-aware rail preserves Status > active Agents > Todos; live activity has one responsive owner; branch/time/context/token projections and narrow fallbacks are regression-locked, including linked-worktree detached SHA resolution and the 80–119 Todos summary. First-pass 213/213 + 60/60 GREEN exposed two verifier gaps; corrective RED/GREEN reached 220/220 + 60/60 and independent re-verification PASS. | included in T11 work-unit commit |
| T12 AIES theme and `/aies-models` | pending | Add a sober profile-local Pi theme; implement a keyboard-first overlay backed by `ctx.modelRegistry.getAvailable()` and real thinking capability metadata; persist Parent through Pi's isolated settings and child roles through isolated AIES config; wire future delegations to those validated choices. | — |
| T13 Automated verification and consolidation | pending | Run focused RED/GREEN suites, full tests, isolation, shell syntax, headless/fullscreen regressions, design detector and diff checks; delete obsolete duplication; document supported APIs and remaining limitations; commit each complete work unit conventionally. | — |
| T14 Final real cmux smoke and UI freeze | pending | Use a disposable issue for one last real IDLE → WORKER → VERIFY → Linear Done run; capture IDLE, WORKER, VERIFY, `/agents`, `/aies-models`, DONE, narrow fallback and exit; record LOC, screenshots and acceptance. Mark `AIES UI v1 FROZEN` only if every gate passes. | — |

## Required evidence

- Exact gentle-pi@3.2.1 implementation audit with file/symbol evidence.
- Pi public API/settings evidence for screen ownership, persistent layout, expansion, thinking visibility, resize and teardown.
- Strict RED/GREEN focused tests for behavior-bearing presentation changes.
- Clean launch with no prior shell history in the normal interactive path.
- Idle identity without bootstrap/debug dominance.
- At >=120 useful columns, the physical layout is `transcript | right rail`; any below-editor dock at that width is a failure. The 80–119 dock and <80 rich-footer fallback remain mutually exclusive with the rail.
- Temporary diagnostic evidence records the real terminal columns, left-pane width, selected breakpoint and selected mode, then the diagnostic code is removed before acceptance.
- The right rail contains coherent `Status` and `Agents` sections, with one prominent live agent surface and one durable completion entry.
- A single theme-backed AIES visual primitive supplies Status, Agents, DONE and BLOCKED hierarchy.
- AIES/Linear/replay plumbing is humanized or collapsed, generic successful tools occupy one line, expanded output remains byte-identical, and failures remain prominent.
- `/agents` remains functional over the existing registry.
- Headless path unaffected.
- `npm test`, `npm run check:isolation`, `bash -n bin/aies scripts/*.sh`, `git diff --check`.
- Real cmux and 80-column inspection plus clean Ctrl+D/Ctrl+C restoration.
- Safe real `/aies-run EZE-XXX` ending Worker → Verify PASS → Linear Done.
- Same-surface real cmux captures for IDLE, WORKER, VERIFY and compact DONE; synthetic terminals and automated tests cannot close T9.
- Before/after visual comparison and net LOC report.

## Final-pass acceptance additions

- Internal continuation instructions remain model-visible but are never rendered as ordinary user input.
- Thinking is hidden by the supported profile setting and remains user-toggleable through Pi's native `Ctrl+T` action.
- Linear actions project as short human states; raw MCP payloads and replay directives stay under expansion/debug.
- DONE and BLOCKED each have exactly one runtime-owned durable visual; the Parent produces no second summary.
- When the rail is visible, live child activity appears there and not in a simultaneous transcript card; the completed child leaves one compact durable line. Inline activity remains the fallback without a rail.
- Status shows non-empty Project, Branch, Ticket, Stage, Model, Provider, Context and active-run Time rows plus vertical Main/Agents/Total token and cost groups.
- Branch preference is active ticket change branch, then workspace branch, then `detached @ <short-sha>`, then `—`, using already available state and no aggressive polling.
- Todos are derived from real run state, bounded, ephemeral and lower priority than Status and active agents.
- `/agents`, `/aies-models`, permissions, summaries and AIES tool projections share one semantic theme vocabulary without hardcoded ANSI.
- The AIES theme is profile-local and loaded through Pi's supported theme mechanism.
- `/aies-models` lists only available configured models, validates supported effort levels, saves only valid selections and never interrupts active children.
- `/aies-status` defaults to a human product view while `detalle` retains technical telemetry.
- Fullscreen, alternate-screen restoration, headless behavior and generic tool execution remain unchanged.

## Scope exclusions

No AIES-011 work; no Planner, Reviewer, new agents, parallelism, memory product,
web UI, persistent Todos, persistent agent history, database, task browser, GitHub,
new MCP, notifications, remote dashboard, pricing database, analytics backend or
agent architecture changes.

## Current progress

- In progress: T12 profile-local theme and `/aies-models`.
- Completed baseline retained: T1–T11, including the unified semantic vocabulary, pure run-local Todos, height-aware rail ownership and responsive fallbacks.
- Next step: establish focused RED tests for registry-backed model selection, capability-valid effort, isolated Parent/child preference persistence and delegation wiring.
- Current authored diff before the final pass: 797 additions / 128 deletions across tracked files, plus the new right-rail module; this work will be committed as reviewable units rather than expanded into another architecture layer.

## Evidence log

- 2026-09-21 T11 complete: regression-first implementation observed 5 intended RED failures and reached 213/213 focused plus 60/60 adjacent GREEN. Independent verification then correctly returned FAIL on two acceptance-critical gaps: linked-worktree detached branch resolution and the missing 80–119 Todos summary. Focused corrective RED reproduced both failures (15/17), then GREEN reached 66/66 rail/panel/fullscreen, 154/154 adjacent UI/telemetry/permissions and 60/60 observability. The Parent spot-check matched those totals, `git diff --check` stayed clean, and independent re-verification returned PASS. Final behavior includes shared semantic vocabulary; pure bounded run-local Todos; Status > active Agents > Todos under height pressure; one live-activity owner; vertical project/branch/ticket/stage/model/provider/context/time and split usage facts; frozen DONE time; compact 8.7k token formatting; linked-worktree-aware `detached @ <sha>` with explicit `Rama —` fallback; polished `/agents` and default `/aies-status`; and responsive >=120 rail, 80–119 dock with Todos summary, <80 footer.
- 2026-09-21 T10: `deliverAgentInstruction()` consolidates the autonomy continuation, `/aies-run` and `/aies-ticket` handoffs onto Pi 0.86.1's public `sendMessage({ display:false }, { triggerTurn:true, deliverAs:"followUp" })` path. Pi still converts the custom message to a user-role LLM message while the TUI omits it. The previous visible path remains only as a compatibility fallback for older hosts. Focused regression-first evidence observed 3 intended RED failures, then 190/190 GREEN; adjacent imports and runtime consumers passed 101/101; parent spot check repeated 190/190; independent verifier PASS; `git diff --check` clean. Linear/MCP mediation, replay, Done Gate, Verify, routing, permissions and sandbox were untouched.

- 2026-09-20 T9 visual rejection: the user made real cmux captures the sole acceptance authority. The target is the existing `workspace:7` / `surface:7` pane on `/dev/ttys015`, measured at 237×58; the non-interactive harness reports 80×24 and is not representative. The live pane currently resolves the repository extension symlink and profile-local Pi 0.86.1 settings (`fullscreen`, `hideThinkingBlock`, `quietStartup`) plus compact one-line MCP result rendering. Acceptance still requires the corrected rail composition and real IDLE/WORKER/VERIFY/DONE captures from this same surface.
- 2026-09-20 T9 diagnosis/correction: a temporary opt-in probe on that exact pane recorded `{columns:237,leftWidth:189,breakpoint:140,mode:"rail"}`. The probe and its environment contract were then fully removed. Regression-first implementation observed 15 intended RED failures, changed the rail threshold to 120, added explicit Status/Agents hierarchy through one shared theme-backed heading primitive, bounded/compacted DONE and BLOCKED, removed duplicate progress notifications, shortened visible Linear replay prompts, and strengthened the Parent anti-narration rule while preserving durable telemetry and workflow semantics. Focused/adjacent checks passed 339/339; full independent verification and real same-surface captures remain pending.
- Branch created from the clean AIES-010C tip.
- The package-owned `gentle-ai-explore` subprocess is currently unavailable in this host: both read-only scouts exited before their first turn with Node `MODULE_NOT_FOUND`. Investigation therefore falls back to direct read-only inspection; this is a tooling incident, not product evidence.
- The active installed Gentle package is newer than the requested 3.2.1. The exact 3.2.1 package was inspected from its immutable npm tarball rather than treating the installed version as equivalent.
- 2026-09-20 correction: the real installed runtime is Pi 0.86.1. Its public `ExtensionWidgetOptions.placement` remains limited to `aboveEditor | belowEditor`; `ExtensionUIContext` exposes no persistent sidebar or root-composition API, while the host keeps `fullscreenLayoutRoot` private. The user explicitly authorized one isolated, version-guarded private compatibility shim for the optional right rail, with the existing below-editor/footer UI as fail-safe fallback.
- 2026-09-20 remediation block: the mandatory `gentle-ai-worker` launch for T7 exited before `agent_settled` with Node `MODULE_NOT_FOUND`, before its first turn and before any edit. The runtime exposes no native Agent fallback or alternate writer definition, so implementation stopped at the delegation boundary rather than proceeding monolithically.
- 2026-09-20 resume: a read-only `gentle-ai-worker` readiness probe completed normally, read the feature document, and made no edits or command invocations. T7 is unblocked and resumes through one scoped writer with regression-first evidence.
- 2026-09-20 T7: regression-first writer observed RED (26/31 passing; the missing shim and session-timer expectations failed), then GREEN with `node --test tests/fullscreen-shell.test.mjs tests/aies-panel.test.mjs tests/aies-ui-seam.test.mjs` (41/41). An independent read-only verifier returned PASS and the parent spot check repeated the same 41/41 result plus `git diff --check`; the new untracked shim also passed `git diff --no-index --check /dev/null extensions/aies-ui/right-rail.ts`. The shim accepts only Pi 0.85/0.86, restores the original layout-node descriptor on dispose, and all unavailable/throwing cases retain the prior dock/footer fallback. Native risk assessment was unavailable (`native command returned empty output`), so the independent verifier was required and completed.
- 2026-09-20 T8: `docs/UX.md` and append-only `docs/DECISIONS.md` D24 now document the exact private exception, Pi-owned alternate-screen lifecycle, no-global-install boundary, fallback, re-audit/removal condition, and that T9 remains unaccepted. Focused checks passed 41/41; independent documentation verification PASS; parent spot check repeated 41/41 and clean diff checks.
- 2026-09-20 T9 first real-runtime attempt: `npm test` and isolation passed 645/645; shell syntax and diff checks passed. Isolated 160-column tmux captures proved IDLE rail, run-only idle timer, 76-column fallback, alternate-screen scrollback isolation (zero pre-launch markers while open), resize, Ctrl+C survival and Ctrl+D restoration. `/exit` is not a Pi 0.86.1 command; it becomes a model prompt, so Ctrl+D is the verified graceful exit. T9 remains blocked: no safe non-mutating route could create real WORKER/VERIFY/DONE from an existing Done Linear fixture; cmux supplied lifecycle escape evidence but no post-extension visual frame. Critically, at 150/160 the physical rail and compact below-editor dock appeared together because the dock yield predicate sees the rail-reduced widget width, reopening T7 for a bounded presentation correction.
- 2026-09-20 T7 correction/T9 rerun: regression-first test reproduced the overlap (15/16 focused seam tests), then passed after making `railHandle.showing()` the dock's sole yield signal; focused suite is 42/42 and independent verification PASS. A disposable isolated Pi 0.86.1 tmux run at 160 proves exactly one physical rail box with Project/Branch and no idle run timer; the below-editor dock is absent. 120 and 90 restore full/compact docks; 76 has no dock/rail and retains the rich footer. While alternate screen was active, `capture-pane -S -300` found zero pre-launch markers; Ctrl+D restored all markers and a usable shell. The parent spot check repeated focused 42/42 and `git diff --check`. This resolves the rail/dock visual defect but does not resolve the real WORKER/VERIFY/DONE or cmux visual-evidence blockers.
- 2026-09-20 T9 safe Linear attempt: created disposable Linear issue `EZE-427` (Todo) and a clean detached fixture worktree at `49dedcf` under `/tmp/aies-010d-eze427/aies-smoke`; the intentional `truncate` fixture was RED before launch. A real cmux workspace loaded the final extension at 160 columns and visually showed the physical right rail (Proyecto `aies-smoke`, Rama `detached`, model/provider/context); no below-editor dock appeared. `/aies-run EZE-427` could not enter real routing because the isolated AIES profile's Linear call returned `401 API key is invalid`; `/mcp-auth linear` reported reconnection but did not repair it. `EZE-427` remained Todo and the fixture remained clean. Thus WORKER, VERIFY, DONE, `/agents` during active work, final Linear Done, and clean cmux exit could not be captured. Do not close T9 or alter global/profile authentication from this repository.
- Pi 0.85.1 publicly supports `tuiMode: "fullscreen"`, backed by its alternate-screen renderer, plus `fullscreenExitOutput: "resume-hint"`, `quietStartup: true` and `hideThinkingBlock: true`. These are profile-local settings and require no launcher ANSI or global Pi mutation.
- Fullscreen keeps transcript scrolling inside the viewport while editor, widgets and footer remain fixed. Pi owns resize, mouse scroll, SIGINT/exit teardown and cursor restoration.
- Gentle's actual right rail is not a public extension primitive. `lib/shell-sidebar-layout.ts` patches `Symbol.for("@earendil-works/pi-tui/layout-node")`, activates only in fullscreen at 140 columns, creates a 50-column `ScrollView`, memoizes frames and restores the original layout node on dispose. Importing that is forbidden by AIES's public-API boundary.
- The strongest supported AIES approximation is therefore a fixed `belowEditor` widget in Pi fullscreen, visually outside the scrolling transcript: full at 120+ columns, compact at 80–119 and hidden below 80 with a rich footer fallback.
- Gentle quiet tools use public `create*Tool` delegation with `renderShell: "self"`; this is the missing mechanism behind AIES-010C's still-large green success backgrounds. Pi's native expansion state still supplies raw detail.
- Gentle's active agent card and full agents view are ordinary public widget/custom-component patterns. AIES can refine its existing equivalents without touching registry or agent semantics.

- 2026-09-20: T2 followed red/green tests (`fullscreen-shell`, `spanish-ux`). The delegated writer failed before its first turn with the known host `MODULE_NOT_FOUND` incident; no native Agent fallback was exposed, so the bounded implementation ran inline. Headless print-mode smoke exited 0 with no output or terminal side effects.
- 2026-09-20: T3 used focused red/green renderer and runtime-seam tests. The required writer retry again failed before its first turn with the same host `MODULE_NOT_FOUND`; implementation remained bounded and ran inline. The production diff removes more UI code than it adds.
- 2026-09-20: T4 verifier launch failed before its first turn with the same host `MODULE_NOT_FOUND`, so the parent ran the exact verification commands. The first full suite exposed four stale/over-coupled presentation expectations; after correcting them and restoring the activity card's independent 72-column cap, `npm run check:isolation` passed all 633 tests. `bash -n`, headless print mode and Impeccable detection also passed.
- 2026-09-20: T5 passed real terminal acceptance. tmux showed the 96-column full dock at 120, the 72-column compact dock at 90 and the rich footer-only fallback at 70; cmux rendered the native fullscreen surface correctly. Successful `read` output collapsed to one row, Ctrl+O exposed the byte-identical JSON, and an ENOENT stayed red and visible. `/agents` showed Explore, Worker and Verify records with keyboard selection. Ctrl+C remained Pi-owned; Ctrl+D exited Pi 0.85.1 and restored the host screen with status 0. The ambient `pi` changed to 0.86.0 during the session, so target-version acceptance was repeated through an isolated temporary PATH shim pinned to the already-audited Pi 0.85.1 executable.
- 2026-09-20: Real isolated-profile smoke in `~/Proyectos/Developer/aies-smoke` completed EZE-426 through Explore (9 findings), Worker (one-file minimal fix), Verify PASS (4/4 criteria) and Linear Done. An independent `npm test` passed and Linear independently reported `statusType: completed`. The smoke repository intentionally retains the one-line `src/truncate.js` change without a commit.
- 2026-09-20: Relative to AIES-010C, production surfaces (`profile/settings.json` and `extensions/**`) changed by +156/-317 lines, net -161. The implementation replaced duplicate presentation instead of adding a parallel shell.
