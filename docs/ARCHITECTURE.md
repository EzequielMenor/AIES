# AIES architecture

Three layers, one responsibility each.

```
+---------------------------------------------------------------+
| AIES repository (versioned)                                   |
|   bin/aies  extensions/  skills/  prompts/  themes/  profile/  |
+-----------------------------------|---------------------------+
                                    | symlinks + settings seed
                                    v
+---------------------------------------------------------------+
| AIES profile (generated, ~/.local/share/aies/agent)           |
|   PI_CODING_AGENT_DIR for every aies run                      |
+-----------------------------------|---------------------------+
                                    | env var + args
                                    v
+---------------------------------------------------------------+
| Pi (official binary, unmodified)                              |
|   sessions, models, tools, TUI, RPC, extension loader         |
+---------------------------------------------------------------+
```

## Why an env var and not a fork

Pi resolves its own profile in `getAgentDir()` from `PI_CODING_AGENT_DIR`, and
derives everything else from that one directory: settings, credentials, models,
sessions, trust, extensions, prompts, themes, tool binaries and installed
packages. Overriding that single variable isolates the whole profile, so there
is nothing to fork and nothing to re-implement.

The variable name is derived from the package's `piConfig.name`, so a rebranded
fork would use a different one. AIES does not fork, so it uses the official
name and stays compatible with upstream.

## The launcher (`bin/aies`)

Contract:

| Argument | Behaviour |
|---|---|
| `--aies-info` | print resolved paths, exit 0 |
| `--aies-*` | reserved; unknown flags exit 2 |
| `install`, `remove`, `uninstall`, `update`, `list`, `config`, `auth` | passed straight to `pi` (no session flags) |
| anything else | passed to `pi` as a session run |

Sequence for a session run:

1. Resolve `AIES_REPO` from the script location.
2. Resolve `AIES_HOME` (default `~/.local/share/aies`, override via env) and
   `AIES_AGENT_DIR = $AIES_HOME/agent`.
3. Run `scripts/bootstrap-profile.sh` (idempotent, fast, quiet).
4. Export `PI_CODING_AGENT_DIR` and unset `PI_CODING_AGENT_SESSION_DIR`, so an
   inherited value cannot leak the ambient profile in.
5. Add `--no-skills`, plus `--skill <repo>/skills` once that directory has
   content.
6. `exec pi "$@"`.

`exec` matters: signals and exit codes belong to Pi, and AIES is transparent.

## The bootstrap (`scripts/bootstrap-profile.sh`)

Idempotent, safe to run before every launch:

- `mkdir -p` the agent dir (Pi would create it anyway).
- Symlink `extensions/`, `prompts/` and `themes/` from the repo into the profile
  so Pi auto-discovers them from the isolated directory. A stale symlink (the
  repository moved) is replaced; a real directory is left untouched and reported
  on stderr, never deleted.
- Copy `profile/settings.json` to the profile **once**. After that Pi owns the
  file (`aies install`, `/settings`, ...).

`skills/` is deliberately not linked: AIES runs with `--no-skills` and adds its
own skills explicitly, which keeps cross-harness global skills out of the
profile.

## The identity extension (`extensions/aies-identity.ts`)

The smallest thing that answers "which profile am I actually running in?":

- on `session_start`: footer status `AIES` and a notice with the resolved agent
  directory;
- `/aies-info`: extension path, agent dir, project config directory name, cwd,
  run mode.

It asks Pi directly (`getAgentDir()`, `VERSION`, `CONFIG_DIR_NAME`) instead of
reading `process.env`, so what it prints is Pi's own resolution, not AIES's
assumption.

## Verification model

All checks run with a temporary `AIES_HOME` and a deliberately hostile ambient
environment (`PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` pointing at
the real Pi profile), so the suite proves both isolation and override.

| Check | Evidence |
|---|---|
| launcher resolution | `aies --aies-info` under a temporary `AIES_HOME` |
| Pi's own resolution | `getAgentDir()` from Pi's public API equals the temporary agent dir |
| profile bootstrap | `extensions` is a symlink into the repo; `settings.json` seeded |
| session storage | RPC `get_state` returns a session file inside the isolated profile |
| extension loading | RPC `get_commands` shows the identity extension with `baseDir` = isolated agent dir, and nothing from the ambient profile |
| skills policy | RPC `get_commands` contains zero `source: "skill"` entries |
| package isolation | `aies list` output excludes every package of the ambient profile |
| non-regression | sha256 of the ambient profile's `settings.json`, `auth.json`, `models.json` and the session directory listing are unchanged |

No credentials and no model calls are involved, so the suite runs anywhere.

## Generated versus versioned

| Versioned in this repo | Generated at runtime |
|---|---|
| `bin/`, `scripts/`, `extensions/`, `profile/`, `tests/`, `docs/`, `odd/` | everything under `AIES_HOME` |
| `package.json`, `package-lock.json`, `README.md`, `AGENTS.md` | resource symlinks inside the profile |

Rule: Pi's runtime writes never enter the repository; repository content only
reaches the profile through symlinks and the one-time settings seed.
