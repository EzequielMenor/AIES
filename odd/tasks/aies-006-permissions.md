# AIES-006 - Permission Boundaries

Status: complete
Branch: `feat/aies-006-permissions`
Scope: Phase 6 of AIES (defense-in-depth permission boundaries, capability surface, policy taxonomy, and OS runtime sandbox containment)

## Goal

Establish a robust, defense-in-depth security boundary separating autonomous local development
from dangerous, irreversible, or out-of-workspace operations. Protect host credentials, prevent
filesystem escapes, and guarantee source-read-only integrity for independent verification through
operating-system kernel syscall containment rather than regex string inspection.

## Non-goals (out of scope for this phase)

Micro-VM hardware virtualization (Gondolin), custom sandbox implementations or homegrown shell parsers,
additional agent roles (AIES-006 is purely infrastructure and policy), automatic commits, remote pushes,
PR opening, and persistent memory across sessions.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Three-layer security model | 1. Capability surface (tools per role); 2. Permission policy (ALLOW/ASK/DENY taxonomy); 3. OS runtime sandbox boundary (`@anthropic-ai/sandbox-runtime`) |
| D2 | Sandbox runtime engine | Option B (`@anthropic-ai/sandbox-runtime`) evaluated and selected in Decision Gate D12. Uses Apple Seatbelt (`sandbox-exec`) on macOS and `bubblewrap` on Linux |
| D3 | Explore tool surface | Strictly read-only tools: `read`, `grep`, `find`, `ls`, `tgrep`. No `edit`, no `write`, no `bash` |
| D4 | Worker capability & containment | Workspace-contained `edit` and `write` tools that block path traversal and secret files at the tool boundary, plus guarded and sandboxed `bash` |
| D5 | Verify source protection | Strictly read-only tool surface (no `edit`, no `write`). Sandboxed bash enforces source-read-only at the OS syscall level. Attempted writes via `node -e`, `python`, `ruby`, or arbitrary binaries are blocked by the kernel |
| D6 | Verify allowed output roots | Designated output directories (`.cache`, `coverage`, `dist`, `build`, `node_modules/.cache`, `/tmp`) are pre-created on the host filesystem before sandbox activation, enabling compilers and test runners to write artifacts without compromising the source tree |
| D7 | Permission taxonomy | `ALLOW`: safe, local, reversible development operations.<br>`ASK`: boundary-crossing actions (package manager installation). Prompts user confirm if interactive UI is present; automatically converts to `DENY` (`ASK -> DENY`) in headless mode or child sessions.<br>`DENY`: high-risk operations (sudo, git push, git reset --hard, git clean -fd, mass deletion, secrets access) |
| D8 | Credential isolation | `COMMON_DENY_READ` (`~/.ssh`, `~/.aws`, `~/.gnupg`, `auth.json`) blocked at sandbox level. Protected files (`.env*`, `*.pem`, `*.key`) blocked at tool and sandbox levels. Parent retains model keys and host credentials; children never inherit them |
| D9 | Sandbox degradation | When sandboxing is disabled (`AIES_SANDBOX=0`) or unsupported: Worker logs a warning and falls back to unsandboxed execution; Verify strictly halts with an error because independent verification requires OS-level enforcement to guarantee artifact integrity |
| D10 | Observability integration | Telemetry counters (`denials`, `approvals`, `sandboxFailures`) tracked in `AiesState`, displayed in `/aies-status` under `Permisos:`, and reflected in the footer (`SANDBOX OFF` indicator when sandbox is inactive) |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Decision Gate D12: Sandbox Runtime Evaluation | this branch | `docs: add Decision D12 comparing sandbox options` |
| T2 Dependency integration: `@anthropic-ai/sandbox-runtime` | this branch | `feat(permissions): add sandbox-runtime dependency and profile config` |
| T3 OS Sandbox Manager and role configurations | this branch | `feat(permissions): implement SandboxManager and role configurations` |
| T4 Policy taxonomy and permission gate (ALLOW / ASK / DENY) | this branch | `feat(permissions): implement ALLOW/ASK/DENY policy and approval gate` |
| T5 Workspace-contained mutation tools for Worker (`contained-tools.ts`) | this branch | `feat(permissions): add contained write and edit tools for Worker` |
| T6 Command guard sandbox integration and package mutation ASK handling | this branch | `feat(permissions): wire sandboxed execution into guarded bash` |
| T7 Observability: `Permisos:` block in `/aies-status` and footer sync | this branch | `feat(observability): track permission telemetry and status` |
| T8 Unit test suite: `tests/permissions.test.mjs` | this branch | `test(permissions): add unit test suite for permission boundaries` |
| T9 Smoke E2E test: `tests/smoke-permissions.test.mjs` | this branch | `test(permissions): add real smoke test for permission boundaries` |
| T10 Documentation: architecture, locked decisions, and task record | this branch | `docs: document permission boundaries and record AIES-006 task` |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Full test suite | `npm test` | 170/170 pass across 40 test suites |
| Isolation script | `npm run check:isolation` | pass (same 170 checks under temporary `AIES_HOME`) |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| Explore unchanged | `tests/permissions.test.mjs` | Explore session has only read/search tools; no bash, edit, or write |
| Worker workspace write | `tests/permissions.test.mjs` | Worker can write and edit files inside workspace root |
| Worker path escape denied | `tests/permissions.test.mjs` | Contained tools reject writes outside workspace root |
| Worker secret files denied | `tests/permissions.test.mjs` | Contained tools reject writes to `.env`, `.env.*`, `*.pem`, `*.key` |
| Verify indirect write denied | `tests/permissions.test.mjs` | `node -e "fs.writeFileSync(...)"` in Verify denied by Seatbelt sandbox (`EACCES` / `Operation not permitted`) |
| Verify checks allowed | `tests/permissions.test.mjs` | Read-only inspection and checks succeed under sandbox in Verify |
| Verify output roots allowed | `tests/permissions.test.mjs` | Writes to `.cache/test.json` succeed in Verify while source remains read-only |
| Secret paths unreadable | `tests/permissions.test.mjs` | Sandbox filesystem denyRead contains `~/.ssh`, `~/.aws`, and `auth.json` |
| Destructive git denied | `tests/permissions.test.mjs` | `git push`, `git reset --hard`, `git clean -fd`, `git checkout .`, `git branch -D` denied |
| ASK behavior (UI vs no-UI) | `tests/permissions.test.mjs` | Package mutations prompt confirm with UI; auto-deny (`ASK -> DENY`) without UI |
| Sandbox degradation | `tests/permissions.test.mjs` | `AIES_SANDBOX=0` reports disabled; Worker falls back with warning; Verify refuses execution |
| Observability metrics | `tests/permissions.test.mjs` | `AiesState` tracks denials, approvals, and sandbox failures; `/aies-status` renders `Permisos:` |
| Real smoke flow | `tests/smoke-permissions.test.mjs` | Worker safe write -> Verify pass -> verified revision under active sandbox |
| Plain Pi unchanged | `npm test` & manual check | Pi starts and runs unchanged without ambient profile contamination |
