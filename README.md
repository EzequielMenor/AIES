# AIES

AIES is a personal AI engineering environment built **on top of Pi**.

- **Pi is the runtime.** AIES does not fork Pi, does not vendor it, and does not
  implement an alternative CLI or agent loop. It uses the official `pi` binary.
- **AIES is the opinionated harness layer.** Extensions, skills, prompts, themes
  and defaults that shape how *you* work, versioned in this repository.
- **The Pi profile is fully isolated.** AIES runs against its own
  `PI_CODING_AGENT_DIR`, so it never reads or writes your normal Pi settings,
  credentials, extensions, skills, prompts, themes, models, packages or sessions.

The command is `aies`; underneath it is `pi`.

> Phase status: isolated bootstrap (AIES-001) plus a session metrics baseline
> (AIES-002) that measures the parent session and does nothing else. No
> dashboard, subagents, orchestration, reviews, memory or autopilot. See
> [Scope](#scope).

## Requirements

- `pi` on `PATH` (any version providing `PI_CODING_AGENT_DIR`; verified against 0.85.1)
- Node.js >= 22 (for the test suite and the dev-time type surface)
- bash

## Quick start

```bash
npm install                 # dev dependency: pi's public API, used by tests
./bin/aies                  # start an isolated AIES session
./bin/aies --aies-info      # show the resolved profile paths
npm run check:isolation     # prove the isolation (no credentials needed)
```

To get the command on your `PATH`:

```bash
npm link                    # creates a global `aies` -> ./bin/aies
npm unlink -g aies          # undo
```

Until then, use `./bin/aies`.

The first AIES session has no model credentials on purpose (that is the
isolation working). Log in once inside the isolated profile with `/login`; the
credential is written to the AIES profile only.

## Profile layout

```
~/.local/share/aies/agent        <- PI_CODING_AGENT_DIR for every aies run
├── settings.json                <- seeded from profile/settings.json once, then owned by pi
├── auth.json                    <- written by /login inside AIES only
├── models.json, models-store.json
├── sessions/                    <- AIES sessions only
├── npm/, git/                   <- packages installed with `aies install`
├── trust.json
└── extensions -> <repo>/extensions   (symlink, created by bootstrap)
```

Override the location with `AIES_HOME=/somewhere/aies ./bin/aies`. Tests always
do this, so they never touch the real profile.

Delete the whole profile with `rm -rf ~/.local/share/aies`; your repository and
your normal Pi installation are untouched.

## What is isolated, and what is not

Isolated by `PI_CODING_AGENT_DIR` (verified by the test suite):

settings, credentials, models and model cache, sessions, trust decisions,
extensions, prompts, themes, tool binaries, and installed packages.

**Not** isolated, by design of Pi itself:

| Thing | Effect | How AIES handles it |
|---|---|---|
| `~/.agents/skills/` (cross-harness skills) | would load every global skill | `aies` always passes `--no-skills`; add AIES skills explicitly with `--skill` |
| `.pi/` in the current directory | project-local settings and resources | left to Pi's project trust prompt; `pi --no-approve` opts out per run |
| `AGENTS.md` / `CLAUDE.md` | project context files | intentional: they describe the project you work in |

## Commands

`aies` is a launcher, not a CLI. Everything that is not an `--aies-*` flag is
passed to `pi` verbatim:

```bash
aies                          # interactive session
aies -p "explain this file"   # non-interactive
aies --mode rpc               # headless JSON-RPC
aies install npm:some-pkg     # installs into the AIES profile
aies list                     # lists packages of the AIES profile
aies update --self            # updates the official pi binary
aies --aies-info              # AIES-only: print resolved paths and exit
```

Only these arguments are interpreted by AIES:

| Argument | Meaning |
|---|---|
| `--aies-info` | print the resolved profile paths and exit |
| `--aies-*` | reserved for AIES; unknown ones exit with code 2 |

## Repository layout

| Path | Role |
|---|---|
| `bin/aies` | the launcher: resolves the profile, bootstraps it, execs `pi` |
| `scripts/bootstrap-profile.sh` | idempotent profile setup (symlinks, settings seed) |
| `profile/settings.json` | seed for the profile's `settings.json`, copied once |
| `extensions/` | AIES extensions, linked into the isolated profile |
| `extensions/aies-identity.ts` | profile visibility: startup notice and `/aies-info` |
| `extensions/aies-runtime/` | session metrics: footer line, `/aies-status`, no behavior changes |
| `tests/isolation.test.mjs` | deterministic isolation checks (no credentials) |
| `tests/observability.test.mjs` | metric rules and rendering, driven through a fake `ExtensionAPI` |
| `tests/observability-runtime.test.mjs` | the observer inside a real Pi process, over RPC |
| `scripts/check-isolation.sh` | one-command entry point for the checks |
| `docs/ARCHITECTURE.md` | how the launcher and the profile actually work |
| `docs/DECISIONS.md` | decisions taken, with their rationale |
| `odd/tasks/` | task tracking for the current phase |

Versioned state is only what lives in this repository. Everything under
`AIES_HOME` is generated runtime state and is never committed.

## Verification

```bash
npm run check:isolation
```

Then, by hand:

```bash
aies          # one footer line: AIES · ctx 34k/peak 41k · tools 8 · files 4 · 02:14
/aies-info    # prints the extension path, agent dir, project config dir, cwd, mode
/aies-status  # the same metrics unfolded: context, tools, exploration, runtime
pi            # your normal Pi must still start exactly as before
```

The metrics line and `/aies-status` come from
`extensions/aies-runtime/`. They measure and never govern: no counter, ratio or
threshold changes what Pi does with a tool call, a delegation or a compaction.

## Scope

Phase 1 shipped: repository structure, profile isolation, the `aies` command,
minimal configuration, one identity extension, and the isolation checks.

Phase 2 (current) ships the observability baseline: one footer line and one
diagnostic command, measuring context, parent tool activity, exploration, tool
output volume, session runtime and tool surface. It measures only.

Explicitly out of scope for this phase: acting on any metric (delegation
triggers, context pressure, proactive compaction), dashboards, subagents,
orchestration, code review, memory, autopilot, theming, branding, CI and
publishing.
