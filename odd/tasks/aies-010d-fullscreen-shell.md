# AIES-010D — Full-Screen Product Shell & Transcript Polish

Status: complete
Branch: `feat/aies-010d-fullscreen-shell`
Baseline: AIES-010C, 630/630 tests
Scope: presentation-only final UX iteration before AIES-011

## Goal

Make a real `aies` launch feel like an intentional full-screen AIES product rather
than a Pi session with AIES widgets: clean startup, separated status surface,
prominent agent activity, quiet successful tools, preserved error detail, compact
DONE, responsive degradation and clean terminal restoration.

## Product invariants

- Pi remains the runtime; AIES uses only documented public extension/TUI APIs and profile settings.
- This phase changes presentation only. Agent Observatory semantics, routing, autonomy, Verify, repair, permissions, sandbox, Linear/MCP and telemetry sources are locked.
- No terminal renderer, persistence layer, history, new metrics, roles or framework.
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
- `extensions/aies-identity.ts`
- `extensions/aies-runtime/**`
- `extensions/aies-ui/**`
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
| T5 Real visual and E2E acceptance | complete | Inspected tmux at 120/90/70, cmux, `/agents`, compact/expanded/error tools and clean alternate-screen restoration; EZE-426 completed Explore → Worker → Verify PASS → Linear Done. Production diff is net -161 lines. | pending commit |

## Required evidence

- Exact gentle-pi@3.2.1 implementation audit with file/symbol evidence.
- Pi public API/settings evidence for screen ownership, persistent layout, expansion, thinking visibility, resize and teardown.
- Strict RED/GREEN focused tests for behavior-bearing presentation changes.
- Clean launch with no prior shell history in the normal interactive path.
- Idle identity without bootstrap/debug dominance.
- Full/compact/hidden responsive status bands and non-duplicating footer.
- One prominent live agent surface and one durable completion entry.
- Compact success tools, byte-identical expanded output and visible errors.
- `/agents` remains functional over the existing registry.
- Headless path unaffected.
- `npm test`, `npm run check:isolation`, `bash -n bin/aies scripts/*.sh`, `git diff --check`.
- Real cmux and 80-column inspection plus clean `/exit`/Ctrl+C restoration.
- Safe real `/aies-run EZE-XXX` ending Worker → Verify PASS → Linear Done.
- Before/after visual comparison and net LOC report.

## Scope exclusions

No AIES-011 work; no Planner, Reviewer, new agents, parallelism, memory, web UI,
history, database, task browser, GitHub, new MCP, notifications, remote dashboard,
config editor, pricing database, analytics backend or agent architecture changes.

## Evidence log

- Branch created from the clean AIES-010C tip.
- The package-owned `gentle-ai-explore` subprocess is currently unavailable in this host: both read-only scouts exited before their first turn with Node `MODULE_NOT_FOUND`. Investigation therefore falls back to direct read-only inspection; this is a tooling incident, not product evidence.
- The active installed Gentle package is 3.3.0, not the requested 3.2.1. The exact 3.2.1 package was inspected from its immutable npm tarball rather than treating 3.3.0 as equivalent.
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
