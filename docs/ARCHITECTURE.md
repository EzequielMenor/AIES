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

- on `session_start`: a notice with the resolved agent directory;
- `/aies-info`: extension path, agent dir, project config directory name, cwd,
  run mode.

It asks Pi directly (`getAgentDir()`, `VERSION`, `CONFIG_DIR_NAME`) instead of
reading `process.env`, so what it prints is Pi's own resolution, not AIES's
assumption. The footer status line is not its business: since AIES-002 the
runtime observer owns it, and that line starts with `AIES` too.

## The runtime observer (`extensions/aies-runtime/`)

AIES-002. Sensors, no actuators: it measures the parent session and changes
nothing about how Pi runs it. It registers one footer line and one command, and
no tools.

| Module | Job |
|---|---|
| `state.ts` | The typed state and its transitions. Pure: no Pi import, no I/O, no timers. Token counts come from Pi, never estimated here |
| `status.ts` | Turns a snapshot into the footer line and the `/aies-status` report. Pure presentation |
| `index.ts` | The only file in AIES-002 that touches Pi |

What it reads, from `session_start`, `tool_call`, `tool_result`, `turn_end`,
`model_select`, `session_compact`, `agent_settled` and `session_shutdown`:

- **context**: current tokens, peak tokens (monotonic, and tagged with the window
  it was measured against), compaction count;
- **parent tools**: calls, calls per tool, results, results that errored;
- **exploration**: source reads (`read`, `view_file`), searches (`grep`, `find`,
  `ls`, `glob`, `codegraph`), `bash` calls whose command is an obvious inspection
  command, and the distinct paths given to the reading tools;
- **output volume**: approximate characters Pi handed back to the model, plus the
  largest single result;
- **runtime**: model and provider, elapsed, session id and file, last stop
  reason, active tool count;
- **verification** (AIES-005): the verdict the delegation tool reported, the runs
  it counted, the duration it measured, and the parent mutations seen since a
  PASS - which is what turns an old `V:PASS` into `V:STALE` in the footer.

The footer names an in-flight verification as well:

```
AIES · VERIFY · ctx 44k/peak 46k · tools 6 · files 3 · V:? · 02:11
AIES · ctx 46k/peak 46k · tools 8 · files 3 · V:PASS · 02:28
```

Two invariants, both under test: no handler ever returns a value (nothing can
block a call or patch a result), and every measurement sits behind a guard (the
observer degrades into silence instead of into a Pi extension error). No
threshold, counter or ratio feeds any decision yet: that is AIES-003.

The footer refreshes on events and every five seconds, and only when its text
actually changed, so it never repaints itself. The clock is `unref`ed and cleared
on `session_shutdown`.

### Where the numbers come from, and where they stop

Tokens, model, session identity and the tool surface are read from Pi, not
reconstructed: `ctx.getContextUsage()`, `ctx.model`, `ctx.sessionManager`,
`pi.getActiveTools()`. AIES never estimates a token count and never truncates a
result to make one cheaper to measure.

State lives in memory. On `agent_settled` and `session_shutdown` the observer
appends one `aies-metrics` custom entry (see D8), which is Pi's own mechanism and
never enters the model's context. A `/resume` therefore keeps its cumulative
counters and its peak; a session interrupted by a hard kill loses whatever was not
checkpointed yet, and a `/new` starts clean by definition. Known limits:

- the counters describe the **parent** session only. What a subagent reads or
  costs is invisible here, because the parent only sees one call to its own tool;
- `filesInspected` counts paths given to the reading tools, not files a `grep`
  matched. A shell command contributes one counter and no paths: this is a
  heuristic with a test, not a shell parser;
- `search` and `shell inspection` counters are comparable between sessions, not
  exact measures of how much was read;
- output size counts text blocks and base64 image payloads as characters. It is
  a volume signal, not the token bill Pi already reports.

## Child agent delegation (`extensions/aies-agents/`, `agents/`)

AIES-003, AIES-004 and AIES-005 provide three isolated child roles via
`aies_delegate`:

```ts
aies_delegate({
  role: "explore" | "worker" | "verify",
  task:   "Investigate, implement a work unit, or verify one",
  context?:      "Explore or Worker only: background context and findings",
  criteria?:     "Verify only, required: the acceptance criteria to judge",
  changedPaths?: "Verify only: the paths the change touched, as facts",
  baseRef?:      "Verify only: the commit or ref to compare against",
  checks?:       "Verify only: checks worth running to reproduce the behaviour",
})
```

### Roles and tool surfaces

| Role | Job | Allowed tools | Denied tools | Prompt |
|---|---|---|---|---|
| `explore` | Read-only codebase investigation | `read`, `grep`, `find`, `ls`, `tgrep` | `bash`, `edit`, `write` | `agents/explore.md` |
| `worker` | Concrete work unit implementation | `read`, `grep`, `find`, `ls`, `tgrep`, `edit`, `write`, guarded `bash` | Destructive/remote bash (`git clean`, `reset --hard`, `git push`, `sudo`, mass `rm`) | `agents/worker.md` |
| `verify` | Independent proof of the real artifact | `read`, `grep`, `find`, `ls`, `tgrep`, read-only guarded `bash` | `edit`, `write`, and every mutating command (mutating git, file deletion or movement, in-place editing, dependency installation, file redirection, command substitution) | `agents/verify.md` |

### Delegation lifecycle and isolation guarantees

```
Parent Session (AgentSession)
  │
  ├─ Decides route: Inline Direct | Explore | Worker | Verify
  │
  ├─ Calls aies_delegate({ role, task, ... })
  │
  ├─ Spawns Child AgentSession (via session.ts)
  │    ├── Fresh context (no parent history, sentinels, or reasoning)
  │    ├── System prompt: agents/<role>.md
  │    ├── Role-specific tool whitelist and custom tools
  │    ├── Extensions: noExtensions: true (parent metrics unaffected)
  │    └── Session: in-memory (no disk clutter)
  │
  ├─ Child investigates, implements or verifies, concluding with structured JSON
  │
  ├─ Child session disposed (session.dispose())
  │
  └─ Returns compact formatted handoff (< 6,000 chars) to parent
```

| Module | Role |
|---|---|
| `agents/explore.md` | Role prompt defining progressive disclosure and read-only search rules |
| `agents/worker.md` | Role prompt defining scoped implementation, worktree protection, and checks |
| `agents/verify.md` | Role prompt defining independent verification and the three verdicts |
| `extensions/aies-agents/session.ts` | Shared isolated child `AgentSession` creation and disposal lifecycle |
| `extensions/aies-agents/tgrep.ts` | Scoped code search tool with path containment, output limits, and fallback |
| `extensions/aies-agents/command-guard.ts` | The command mechanics and rules Worker and Verify share, parameterised by role |
| `extensions/aies-agents/worker-guard.ts` | Worker command policy and guarded bash tool definition |
| `extensions/aies-agents/verify-guard.ts` | Verify read-only command policy and guarded bash tool definition |
| `extensions/aies-agents/handoff.ts` | Structured parsers and defensive formatters for the three handoffs, plus the failure signature |
| `extensions/aies-agents/verification.ts` | Verification record, PASS invalidation, requirement rule, repair policy and prompts |
| `extensions/aies-agents/model.ts` | Model resolution: env (`AIES_<ROLE>_MODEL`) > `aies.json` (`agents.<role>.model`) > parent model |
| `extensions/aies-agents/explore.ts` | Isolated Explore child agent runner |
| `extensions/aies-agents/worker.ts` | Isolated Worker child agent runner |
| `extensions/aies-agents/verify.ts` | Isolated Verify child agent runner |
| `extensions/aies-agents/routing.ts` | Parent routing policy, soft signals, and hard guardrails |
| `extensions/aies-agents/delegate.ts` | Definition of the `aies_delegate` tool supporting the three roles |
| `extensions/aies-agents/index.ts` | Extension entry point: registers `aies_delegate`, the routing hooks, and the verification record |

### Parent routing policy and guardrails

Four routes:
- **INLINE DIRECT**: Trivial changes (typos, single comments, localized edits, 1-2 source reads).
- **EXPLORE**: Unknown scope, broad code search, or reading >2 files.
- **WORKER**: Non-trivial multi-file changes (>= 2 files), iterative test/check cycles.
- **VERIFY**: Independent proof that a behaviour-bearing change actually works.
  It is not driven by the pressure counters: `requiresVerification()` decides from
  the changed paths, and a documentation-only change does not need it.

Guardrails:
- **Soft signals** inform model decisions:
  - 3 exploratory reads -> soft pressure to delegate Explore.
  - 7 tool calls since boundary -> soft pressure to evaluate delegation.
  - >3 files inspected -> suggestion to delegate Explore.
- **Hard guardrails** block direct runaway actions:
  - 5 exploratory reads -> direct reads blocked (`parent exploration budget exceeded; delegate Explore`).
  - 12 tool calls since boundary -> direct tools blocked (`parent tool budget exceeded; re-evaluation required`).
- Delegation resets boundary counters (`toolsSinceBoundary = 0`, `readsSinceBoundary = 0`, `filesSinceBoundary = []`) while global AIES-002 telemetry accumulates.

## Independent verification (AIES-005)

Worker and Verify are not the same role. Worker optimises for making the change
work; Verify optimises for demonstrating whether it works. Verify never receives
the Worker's conclusion: its prompt is composed from the work unit, the acceptance
criteria, the changed paths, the base ref, the suggested checks and the cwd, and
passing free-form `context` to the role is rejected with an error. The same
command, run under two policies, is the difference between implementing and
proving: Verify has no `edit`, no `write`, and a shell that refuses to write.

| Verdict | Meaning |
|---|---|
| `pass` | Every verifiable criterion is satisfied, the relevant checks pass, and no blocking defect is known. A PASS requires evidence: a verdict without any evidence is downgraded to `blocked` when the handoff is parsed |
| `fail` | The repository violates a criterion, or a reproducible defect related to the change exists, with its path and evidence |
| `blocked` | The verdict cannot be reached for a cause external to the change: missing credential, unreachable service, unavailable dependency, unrunnable check, persistent infrastructure flake, or a genuinely ambiguous criterion |

### Verification state and invalidation

The parent-side record is `verification.ts`; the observer keeps a projection of it
for the footer.

| Field | Meaning |
|---|---|
| `status` | `none \| running \| pass \| fail \| blocked` |
| `attempts` | Verification runs started (ceiling of 4) |
| `repairs` | Worker runs started while a FAIL was awaiting repair (ceiling of 2) |
| `revision` | Monotonic behaviour-bearing revision: one per relevant parent mutation or Worker run. A documentation-only change does not move it |
| `verifiedRevision` | The revision the last PASS verified |
| `lastFailureSignature` / `repeatedFailures` | The failure identity, and how many times in a row it repeated |
| `awaitingVerification` | A behaviour-bearing change is waiting for proof |

Invalidation is a counter comparison, not a hash: a PASS is valid only while
`verifiedRevision === revision`. A parent `edit` or `write` on a behaviour-bearing
path, and any behaviour-bearing completed Worker run, moves the revision forward,
so an old PASS stops describing the artifact without anyone having to detect that
it did. A documentation-only edit is not a behaviour change, so it does not expire
a PASS; the classification is the same `requiresVerification()` the routing rule
uses.

### Repair policy

```
Worker -> Verify #1 FAIL -> repair #1 -> Verify #2 FAIL -> repair #2 -> Verify #3
                                        PASS -> verified, FAIL -> stop
```

Two repair cycles at most, plus an early stop when the same failure signature
repeats. A repair Worker receives the original work unit, the acceptance criteria
and the concrete defects (`buildRepairContext`), never the Verify transcript, and
the next verification always runs in a fresh session.

### Authority

Verify returns evidence; the parent decides. Neither Worker nor Verify can set
`verified = true`, and a review of the loop is informational: it does not commit,
push, or close anything.

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
| observability wiring | RPC `get_commands` lists `/aies-status` from `extensions/aies-runtime/index.ts`, and RPC `prompt "/aies-status"` returns the report |
| observability invariants | the reducer rules, the classification and both renderings, driven directly and through a fake `ExtensionAPI` (`tests/observability.test.mjs`) |
| verification invariants (AIES-005) | the read-only command policy, the handoff rules, PASS invalidation, the repair budget and the repeated-failure stop, driven directly (`tests/verify.test.mjs`) |
| verification end to end | Parent -> Worker leaves a real defect -> Verify FAIL -> repair -> fresh Verify PASS on a fixture (`tests/smoke-verify.test.mjs`) |
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
