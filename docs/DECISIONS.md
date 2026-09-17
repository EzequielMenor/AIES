# Decisions

Recorded decisions with their rationale. Numbered, append-only: to change one,
add a new entry that supersedes it instead of editing history.

---

## D1 - Pi is the runtime, AIES never becomes one

**Decision.** AIES uses the official `pi` binary and the documented extension
API. No fork, no vendored copy, no alternative CLI, no agent loop of its own.

**Why.** Pi already owns sessions, models, tools, TUI, RPC, the extension
loader and the profile layout. Re-implementing any of that means maintaining it
forever and drifting from upstream. The interesting part of a personal
engineering environment is the opinionated layer on top, not the runtime below.

**Consequence.** `bin/aies` must stay a launcher. Any feature that cannot be
expressed as an extension, a skill, a prompt, a theme, a setting or a flag is a
signal that the feature does not belong in AIES.

---

## D2 - Isolation through `PI_CODING_AGENT_DIR`

**Decision.** Every `aies` run sets `PI_CODING_AGENT_DIR` to
`$AIES_HOME/agent`, unsets `PI_CODING_AGENT_SESSION_DIR`, and never writes to
the ambient Pi profile.

**Why.** It is Pi's own, documented mechanism, and the resolution lives in
`getAgentDir()`: settings, credentials, models, sessions, trust, extensions,
prompts, themes, tool binaries and installed packages all derive from that one
path. Verified against Pi 0.85.1, including that Pi creates a missing profile
directory automatically.

**Consequence.** "Isolated" must be stated precisely, because the variable does
not cover everything. `~/.agents/skills/`, project-local `.pi/`, and
`AGENTS.md` / `CLAUDE.md` are out of its scope. Those three are documented in
the README and one of them is neutralised by D4.

---

## D3 - Profile lives outside the repository

**Decision.** Default profile: `~/.local/share/aies/agent`. Overridable with
`AIES_HOME`.

**Why.** Runtime state is not source code: it must survive a repository move,
must not end up in git by accident, and must be deletable in one command.
Keeping it outside the repository also makes accidental commits impossible
rather than merely ignored.

**Consequence.** The suite always sets `AIES_HOME` to a temporary directory, so
no test can ever touch the real profile.

---

## D4 - AIES owns its skills; global skills stay out

**Decision.** `aies` always passes `--no-skills` and adds `--skill
<repo>/skills` once that directory has content.

**Why.** `~/.agents/skills/` is a cross-harness convention that
`PI_CODING_AGENT_DIR` does not isolate; without this, every AIES session loads
skills shared with other harnesses, which makes AIES behaviour depend on state
outside the project. A reproducible profile was worth more than reusing those
skills by default.

**Consequence.** AIES skills live in this repository and are explicit. A skill
the user wants in both environments must exist in both places.

---

## D5 - `aies` is a launcher with a one-flag contract

**Decision.** `bin/aies` resolves the profile, bootstraps it, and execs `pi`.
Only `--aies-*` arguments are interpreted; the single implemented flag is
`--aies-info`. Pi subcommands bypass the session flags and go straight through.

**Why.** A second CLI would duplicate Pi's argument surface and age badly.
Argument passthrough means every current and future Pi flag works in AIES for
free, and the isolation stays in one place.

**Consequence.** Refusing unknown `--aies-*` flags loudly (exit 2) keeps the
reserved namespace honest instead of silently swallowing a typo.

---

## D6 - Own git repository, one work-unit commit per task

**Decision.** `git init` inside this directory, work on a feature branch, and
close every task in `odd/tasks/` with a Conventional Commit that carries tests
and docs alongside the behaviour. No remote is configured.

**Why.** The directory previously sat inside a git repository rooted at `$HOME`,
which makes change tracking meaningless. Commits per work unit keep the change
reviewable and recoverable.

**Consequence.** No push and no pull request without an explicit decision.

---

## D7 - npm as the package manager of this repository

**Decision.** `npm` for the dev dependency and the lockfile, even though the
user's global tooling is pnpm.

**Why.** It matches Pi's default `npmCommand`, so package behaviour here and
inside Pi agree. One less difference to reason about.

**Consequence.** `package-lock.json` is versioned; `node_modules/` is not.

---

## D8 - AIES-002 measures, and persists only through Pi's own entries

**Decision.** The runtime observer is a sensor with no actuator. It keeps its
state in memory and checkpoints it with `pi.appendEntry("aies-metrics", ...)`,
restoring from the last such entry on `session_start`. No SQLite, no JSONL of our
own, no analytics pipeline. The observer also owns the `aies` footer status key,
which `aies-identity.ts` stopped writing.

**Why.** A governance layer (AIES-003) is only defensible on top of numbers that
already proved stable and comparable, and a phase that both measures and decides
cannot tell which one broke. Custom entries are Pi's documented mechanism for
state that survives a restart and never enters the model's context, so resume
support costs one append and one scan instead of a storage layer to maintain.
One writer per status key keeps the footer honest without relying on extension
load order.

**Consequence.** Counters survive `/resume` and `/fork`, and are lost on a hard
kill between checkpoints - documented, not engineered around. No threshold exists
anywhere in this code: nothing can block, delegate, compact or route because of a
metric yet. And because a Pi subagent runs in its own session, the parent only
sees one call to its own tool: measuring subagent activity is a separate phase's
problem, not a silent gap here.

---

## D9 - Isolated Explore primitive (AIES-003)

**Decision.** AIES implements delegation as a single parent tool `aies_delegate`
which, for AIES-003, exclusively supports the `explore` role. The child runs in
a separate Pi `AgentSession` with fresh context (no parent history or reasoning
leakage), a strictly read-only tool surface (`read`, `grep`, `find`, `ls`, and
scoped `tgrep`; no `bash`, `edit`, or `write`), and returns a structured handoff
(`status`, `summary`, `evidence`, `issues`, `next`) capped defensively under
6,000 characters. Child sessions disable extensions (`noExtensions: true`), so
internal child calls never contaminate parent metrics.

**Why.** Context pollution is the primary failure mode of long-horizon AI coding:
exploratory reads, large directory listings, and searches fill the context
window, degrading subsequent reasoning. Running an isolated child agent allows
thorough codebase exploration while preserving parent context headroom. Generic
`bash` was intentionally removed to avoid maintaining fragile shell command
blacklists; scoped search tools (`tgrep`, `grep`, `find`) provide safe,
containment-verified repository exploration.

**Consequence.** The parent session only sees one tool call (`aies_delegate`)
and receives a concise, structured answer. The child cannot execute arbitrary
terminal commands or modify the workspace. Automatic delegation routing and
other roles (`planner`, `worker`) are deferred to subsequent phases.

---

## D10 - Isolated Worker child agent and Parent Routing Policy (AIES-004)

**Decision.** AIES expands `aies_delegate` to support the `worker` role alongside
`explore`, and introduces a hybrid routing policy with soft signals and hard
guardrails on the parent session. The child Worker runs in an isolated Pi
`AgentSession` (`noExtensions: true`, in-memory session manager, fresh context)
with tools for localized reading, writing (`edit`, `write`), and development checks
(`read`, `grep`, `find`, `ls`, `tgrep`, and guarded `bash`). Guarded `bash` blocks
destructive operations (`git clean`, `reset --hard`, `checkout --`, `restore`,
`push`, `merge`, `rebase`, `branch -D`, mass `rm`, `sudo`, `deploy`, `publish`).
The parent retains coordination and small inline work (typos, single comments,
1-2 file inspection), while routing guardrails enforce boundaries (soft pressure
at 3 reads / 7 tools; hard block at 5 reads / 12 tools). Boundary counters reset
on delegation while global telemetry continues to accumulate.

**Why.** Preserves parent session context and reasoning capacity during multi-turn
implementation tasks without turning AIES into an absurd dispatcher where a 1-line
fix requires a subagent. Pure prompt routing is vulnerable to drift, while rigid
counter dispatching breaks natural workflows; combining model judgment with
deterministic guardrails ensures the parent stays high-level and children do the
heavy lifting. Worktree protection prevents repeating real-world incidents such as
unintended `git clean -fd` discarding concurrent working tree state.

**Consequence.** Trivial edits remain direct and fast; complex or multi-file
implementations must be delegated to Worker. Verification, autonomous planning,
linear workflow, and multi-worker execution remain deferred to subsequent phases.

---


## Open issues

### O1 - Broken global `pre-commit` hook (resolved)

**Situation.** `init.templateDir` is `~/.git-templates`, and its `pre-commit`
runs `gga run || exit 1`. `git init` copies that hook verbatim into every new
repository (verified: identical sha256), and `gga` is not installed anywhere on
this machine and is not defined in any shell rc file. The second command in the
hook (`openwiki --update`) is non-blocking, and `openwiki` does exist.

**Decision.** The local, unversioned `.git/hooks/pre-commit` was deleted in this
repository only. `~/.git-templates` was left untouched. No commit uses
`--no-verify`.

**Why.** The hook arrived by accident, not by requirement: it is not part of
AIES, and it guards nothing here because the tool it calls does not exist. A
broken gate that blocks every commit is worse than no gate, and bypassing it
with `--no-verify` on every commit would normalise silently skipping checks.
Removing the local file is the smallest change that makes the gate honest.

**Standing constraint.** `gga` is not used anywhere in AIES, by explicit user
decision. Do not reintroduce it, and do not bypass hooks with `--no-verify`.

**Follow-up (deliberately not acted on).** Any future `git init` still inherits
the same broken hook from the global template. Fixing that means editing
`~/.git-templates`, which is the user's call and outside this repository.

### O2 - The name "AIES" is already taken by a different project

**Situation.** `github.com/EzequielMenor/AIES` exists and holds a different
architecture: an autonomous harness with its own runtime, subagents and
roadmap. Two working copies exist locally (`~/repos/AIES`, `~/.aies`), plus
backup directories.

**Status.** Not blocking this phase. No remote is configured in this repository,
and the two projects are unrelated in code, dependencies and design.

**Needed decision.** Before any push: rename one of them, use a new repository,
or explicitly declare this one a successor and archive the other.
