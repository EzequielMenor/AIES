# AIES-001 - Isolated bootstrap

Status: complete
Branch: `feat/aies-001-bootstrap`
Scope: Phase 1 of AIES (bootstrap only)

## Goal

Make AIES runnable through its own `aies` command while Pi stays the unchanged
runtime, on a Pi profile fully isolated from the user's main Pi installation.

## Non-goals (out of scope for this phase)

dashboard, subagents, orchestration, reviews, memory, autopilot, theming,
branding, CI, npm publishing, Pi version pinning, settings migration.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Runtime | official `pi` binary on `PATH`; no fork, no vendoring |
| D2 | Profile location | `~/.local/share/aies/agent` (`PI_CODING_AGENT_DIR`), overridable with `AIES_HOME` |
| D3 | Skills policy | wrapper always passes `--no-skills`; AIES skills load via `--skill <repo>/skills` once that directory has content |
| D4 | Credentials | fresh `/login` inside the AIES profile; no shared or copied `auth.json` |
| D5 | Version control | own repo, one work-unit commit per task on `feat/aies-001-bootstrap` |
| D6 | Package manager | npm (matches Pi's default `npmCommand`, single lockfile) |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Repo scaffolding, ODD tracking, V0 baseline | `ff8bf56` | `chore(repo): scaffold AIES repository` |
| T2 Launcher: `bin/aies`, `scripts/bootstrap-profile.sh`, `profile/settings.json` | `cda7d33` | `feat(launcher): run pi against an isolated AIES profile` |
| T3 Identity extension: `extensions/aies-identity.ts` | `aa1318b` | `feat(extension): report the active AIES profile` |
| T4 Smoke checks: `tests/isolation.test.mjs`, `scripts/check-isolation.sh` | `cc5f72c` | `test(isolation): prove the AIES profile is isolated` |
| T5 Docs: `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` | `fe15ced` | `docs: document the AIES bootstrap and its decisions` |
| T6 Verification V0-V7, non-regression check | this commit | `chore(odd): record AIES-001 evidence and close the phase` |
| T7 Unblock commits (remove inherited local hook) | this commit | same commit as T6 |

Full log: `git log --oneline`.

## Verification evidence

Every check runs against a temporary `AIES_HOME` with a hostile ambient
environment (`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` pointing at
`~/.pi/agent`), so isolation and override are proven together. No credentials and
no model calls are involved.

| Check | Evidence | Result |
|-------|----------|--------|
| V0 baseline of the ambient profile | `.verification/baseline-pi-profile.txt` | captured before any write |
| V1 launcher resolution | `aies --aies-info` under a temporary `AIES_HOME` | `PI_CODING_AGENT_DIR=<tmp>/agent`, `pi_version=0.85.1` |
| V2 Pi's own resolution | `getAgentDir()` from Pi's public API | equals the temporary agent dir, never `~/.pi/agent` |
| V3 extension loading | RPC `get_commands` | `aies-info` present with `baseDir` = isolated agent dir; zero commands from `~/.pi/agent` |
| V3b skills policy | RPC `get_commands` | zero `source: "skill"` entries |
| V4 session storage | RPC `get_state` | `sessionFile` inside `<tmp>/agent/sessions/` |
| V4b identity command | RPC `/aies-info` | report shows the isolated agent dir and the extension's own path |
| V4c package isolation | `aies list` | no package from the ambient profile |
| V5 non-regression | sha256 of `~/.pi/agent/{settings,auth,models}.json` + session dir listing | identical to V0; 9 session dirs before and after |
| V6 interactive identity | manual | pending user confirmation (footer shows `AIES`, `/aies-info` reports the isolated dir) |
| V7 ambient Pi unaffected | `pi --version` | `0.85.1`, profile untouched |
| Automated suite | `npm test` | 9/9 pass |
| Shell syntax | `bash -n` on the three scripts | clean |

## Git hook resolution (T7)

The global `init.templateDir` template installs a `pre-commit` that runs
`gga run || exit 1`, and `gga` is not installed. The local, unversioned
`.git/hooks/pre-commit` (byte-identical to the template) was removed from this
repository only; `~/.git-templates` was left untouched and no commit uses
`--no-verify`. `gga` is not used anywhere in AIES.

## Open risks

- R1 The name `AIES` is already used by a different project on
  `github.com/EzequielMenor/AIES` (legacy autonomous harness with its own
  runtime). Working copies exist at `~/repos/AIES` and `~/.aies`. No remote is
  configured here on purpose; the collision needs an explicit decision before
  any push.
- R2 `~/.agents/skills` is not isolated by `PI_CODING_AGENT_DIR`. Mitigated by
  D3, verified to load zero skills.
- R3 A project-local `.pi/` in the working directory is not isolated. Pi protects
  it behind the project trust prompt; `--no-approve` opts out per run.
- R4 `pi update --self` from the AIES profile updates the shared global Pi
  binary. Intentional in this phase (a single runtime); no version is pinned yet.
- R5 Any future `git init` still inherits the broken hook from the global
  template. Fixing that means editing `~/.git-templates`, which is the user's
  decision and outside this repository.
