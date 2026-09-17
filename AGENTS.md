# AGENTS.md - working on AIES

This file is for AI agents working **on** the AIES repository. It is project
context, not part of the isolated runtime.

## What this project is

AIES is a harness layer on top of Pi. Pi is the runtime; AIES is the opinionated
configuration, extensions and conventions around it.

Read `docs/ARCHITECTURE.md` before changing the launcher, and
`docs/DECISIONS.md` before changing a decision that is already recorded there.

## Hard rules

1. **Never modify the ambient Pi installation.** Do not write to `~/.pi/**`, do
   not touch `~/.agents/**`, and do not change the user's global git config.
2. **Run against an isolated profile.** When you need a real run, use
   `AIES_HOME=/tmp/<something>` so no real profile is involved. The test suite
   already does this; do not add tests that use the default profile.
3. **Pi stays the runtime.** Do not fork, vendor, patch or re-implement Pi. Use
   documented flags, the `PI_CODING_AGENT_DIR` contract, and the public API
   exported by `@earendil-works/pi-coding-agent`. Do not import from `dist/`
   internals.
4. **`bin/aies` stays a launcher.** It resolves the profile, bootstraps it, and
   execs `pi`. No second CLI, no subcommand framework, no runtime of our own.
   Only `--aies-*` arguments may be interpreted.
5. **No premature abstraction.** Add a layer only when a second caller exists.
6. **Nothing under `AIES_HOME` is ever committed**, and no repo file is copied
   into the profile except `profile/settings.json` (once) and the resource
   symlinks.

## Conventions

- Code, comments, identifiers, filenames, commits and docs are in English.
- JavaScript is ESM (`type: "module"`), Node >= 22, no build step.
- Extensions are TypeScript files loaded directly by Pi. Prefer `import type`
  for the type surface and value imports only for what Pi actually exports.
- No `console.log` left behind in committed code; CLI scripts may print their
  intended output.
- Shell scripts: `#!/usr/bin/env bash` with `set -euo pipefail`, quoted
  expansions, and no destructive command without an existence guard.
- Commit messages: Conventional Commits, one work unit per commit
  (`feat`, `fix`, `chore`, `docs`, `test`, `refactor`).

## Before you finish a change

```bash
npm test                    # isolation checks, no credentials needed
npm run check:isolation     # the same checks plus the resolved profile report
bash -n bin/aies scripts/*.sh
```

If you touched the launcher, also confirm by hand that `aies --aies-info`
reports the profile you expected, and that plain `pi` still starts unchanged.

## Git hooks

The global `init.templateDir` template installs a `pre-commit` hook that runs
`gga run`. That hook was removed from this repository: it arrived by accident
and blocked every commit with a tool that is not installed. `gga` is not used
anywhere in AIES, by explicit user decision.

If a hook appears again here, do **not** work around it with `--no-verify` and
do not reach for `gga`. Report it and ask.
