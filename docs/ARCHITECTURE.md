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
- on `before_agent_start`: the one resident Parent rule (AIES-010B) — answer in
  Spanish, keep commands, code, technical names and identifiers in their original
  language, and do not narrate internal steps the UI already shows. It is
  appended once and skipped when already present;
- `/aies-info`: extension path, agent dir, project config directory name, cwd,
  run mode.

It asks Pi directly (`getAgentDir()`, `VERSION`, `CONFIG_DIR_NAME`) instead of
reading `process.env`, so what it prints is Pi's own resolution, not AIES's
assumption. The footer and the ticket header are not its business: since AIES-002
the runtime observer owns them and renders both from one snapshot.

Child sessions are created with `noExtensions: true`, so they never load this
extension and never receive the Parent rule: their prompts stay technical.

## The runtime observer (`extensions/aies-runtime/`)

AIES-002. Sensors, no actuators: it measures the parent session and changes
nothing about how Pi runs it. Since AIES-010B and AIES-010C it also installs the
shell (the full footer and the ticket header), the widgets, the `/aies-status` and
`/agents` commands and the quiet renderers for six generic tools; no handler
returns a value, so none of it can block a call or patch a result.

| Module | Job |
|---|---|
| `state.ts` | The typed state and its transitions. Pure: no Pi import, no I/O, no timers. Token counts come from Pi, never estimated here. Since AIES-010C it also holds `RunUsageState` and the ephemeral `agents` projection |
| `usage.ts` | `aggregateUsage`, the pure Main / Agents / Total reduction. An unknown cost propagates as `null` and is never estimated |
| `status.ts` | Turns a snapshot into the `/aies-status` report. Pure presentation |
| `quiet-tools.ts` | The Pi boundary of the quiet generic tool surface: the six public `create*Tool(cwd)` instances with `execute` delegated untouched and only renderers added |
| `index.ts` | The only runtime file that touches Pi: events -> state -> strings, the footer and header, the three widgets, the `/agents` view and the quiet-tool registration |

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

The footer names an in-flight verification through the workflow stage and the
independent indicator:

```
✧ AIES · EZE-417 · VERIFY · ctx 45k
✧ AIES · EZE-417 · ctx 46k · V:PASS
```

`V:BLOCKED` and `V:?` are not footer vocabulary: the stage already carries them.
`V:ERROR` is kept because a verification protocol fault is its own fact. The full
footer specification lives in the presentation layer and in `docs/UX.md`.

Two invariants, both under test: no handler ever returns a value (nothing can
block a call or patch a result), and every measurement sits behind a guard (the
observer degrades into silence instead of into a Pi extension error). No
threshold, counter or ratio in this observer feeds any decision: routing policy is
AIES-003 and lives in `aies-agents`.

The footer, the header and the panel refresh on events and on one adaptive timer
— 1s while a child is active, 5s otherwise — and only when their text actually
changed, so they never repaint themselves. The clock is `unref`ed and cleared on
`session_shutdown`.

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

- the counters describe the **parent** session only. The parent sees one call to
  its own delegation tool, so child reads and child cost are never in these
  counters; AIES-010C observes child usage through a separate registry (see the
  presentation layer), and the two sources are aggregated once, never merged;
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
| `verify` | Independent proof of the real artifact | `read`, `grep`, `find`, `ls`, `tgrep`, read-only guarded `bash`, and the `aies_verify_complete` completion tool | `edit`, `write`, and every mutating command (mutating git, file deletion or movement, in-place editing, dependency installation, file redirection, command substitution) | `agents/verify.md` |

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
| `extensions/aies-agents/session.ts` | Shared isolated child `AgentSession` creation and disposal lifecycle, plus the single event listener that observes a child for the Agent Observatory |
| `extensions/aies-agents/observatory.ts` | The ephemeral, session-local Agent Observatory registry: pure, no Pi import, no persistence, no authority |
| `extensions/aies-agents/tgrep.ts` | Scoped code search tool with path containment, output limits, and fallback |
| `extensions/aies-agents/command-guard.ts` | The command mechanics and rules Worker and Verify share, parameterised by role |
| `extensions/aies-agents/worker-guard.ts` | Worker command policy and guarded bash tool definition |
| `extensions/aies-agents/verify-guard.ts` | Verify read-only command policy and guarded bash tool definition |
| `extensions/aies-agents/handoff.ts` | Structured parsers and defensive formatters for the three handoffs, the Verify verdict/protocol-error split, and the failure signature |
| `extensions/aies-agents/verification.ts` | Verification record, PASS invalidation, requirement rule, repair policy and prompts |
| `extensions/aies-agents/model.ts` | Model resolution: env (`AIES_<ROLE>_MODEL`) > `aies.json` (`agents.<role>.model`) > parent model |
| `extensions/aies-agents/explore.ts` | Isolated Explore child agent runner |
| `extensions/aies-agents/worker.ts` | Isolated Worker child agent runner |
| `extensions/aies-agents/verify.ts` | Isolated Verify child agent runner, including the schema-validated `aies_verify_complete` completion tool |
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
| `pass` | Every verifiable criterion is satisfied, the relevant checks pass, and no blocking defect is known. A PASS requires evidence: the completion tool rejects a PASS with no per-criterion evidence, or one carrying a blocking defect, as an `invalid_completion` protocol error rather than a verdict |
| `fail` | The repository violates a criterion, or a reproducible defect related to the change exists, with its path and evidence |
| `blocked` | The verdict cannot be reached for a cause external to the change: missing credential, unreachable service, unavailable dependency, unrunnable check, persistent infrastructure flake, or a genuinely ambiguous criterion |

The verdict itself is captured structurally. The isolated Verify child calls the
schema-validated completion tool `aies_verify_complete`, and the parent reads the
captured call, not the child's final prose. Exactly one valid completion is
authoritative: an invalid attempt is rejected host-side so the child may correct
it once in the same turn, while a missing completion, an invalid-only sequence or
a second valid completion is a `protocol_error`, its own fact with codes
`missing_completion | invalid_completion | duplicate_completion | session_failure`.
It is never read as `pass`, `fail` or `blocked`: it consumes one attempt, spends
zero repair budget, sets the footer indicator `V:ERROR`, and `planVerification`
stops the loop without an automatic retry. A captured verdict survives a later
prose or provider-continuation failure, because the completion, not the stream,
is the authority.

### Verification state and invalidation

The parent-side record is `verification.ts`; the observer keeps a projection of it
for the footer.

| Field | Meaning |
|---|---|
| `status` | `none \| running \| pass \| fail \| blocked \| protocol_error` |
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

## Permission boundaries (AIES-006)

AIES enforces a defense-in-depth security model across three independent layers,
preventing autonomous child agents from escaping workspace boundaries or mutating
sensitive host state.

```
+-------------------------------------------------------------------------+
| Layer 1: Capability Surface (tool availability per role)                |
|   Explore: read, grep, find, ls, tgrep                                  |
|   Worker:  read, grep, find, ls, tgrep, contained write & edit, bash    |
|   Verify:  read, grep, find, ls, tgrep, read-only bash                  |
|   Parent:  delegation, full tool surface, credentials                   |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Layer 2: Permission Policy Taxonomy (ALLOW / ASK / DENY)                |
|   ALLOW: safe local development (reads, workspace edits, tests, diff)   |
|   ASK:   boundary-crossing actions (npm install, package mutation)      |
|          -> UI available: prompts user confirm                          |
|          -> Headless / child agent: automatic ASK -> DENY               |
|   DENY:  destructive or irreversible (sudo, push, reset --hard, clean)  |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Layer 3: OS / Runtime Sandbox Boundary (@anthropic-ai/sandbox-runtime)  |
|   Syscall-level containment (Seatbelt on macOS, bubblewrap on Linux)    |
|   Worker: allowWrite workspaceRoot + /tmp; denyRead credentials         |
|   Verify: source-read-only; allowWrite designated output roots only     |
|   Fallback: Worker degrades with warning; Verify strictly halts         |
+-------------------------------------------------------------------------+
```

### 1. Capability surface

Each role receives only the tools required for its contract:
- **Explore**: Strictly read-only (`read`, `grep`, `find`, `ls`, `tgrep`). No `edit`, `write`, or `bash`.
- **Worker**: Workspace-contained `edit` and `write` (which reject path escapes and secret files at the tool boundary), plus guarded, sandboxed `bash`.
- **Verify**: Strictly read-only tool surface with no `edit` or `write`. Bash tool is restricted to read-only inspection, check execution, and scoped queries.
- **Parent**: Owns host credentials and model keys. Children never inherit ambient credentials.

### 2. Permission policy taxonomy

Commands executed in child sessions are evaluated before execution:
- **ALLOW**: Routine, reversible operations inside workspace (file reads, edits, linters, tests, builds, git status/diff/log).
- **ASK**: Deliberate actions requiring human authorization (package manager installations and additions). When interactive UI is available (`hasUI`), prompts the user with `ui.confirm()`. In headless runs or child sessions, automatically converts to **DENY** (`ASK -> DENY`). Children cannot self-approve.
- **DENY**: High-risk or irreversible operations blocked without exception (`sudo`, `git push`, `git reset --hard`, `git clean -fd`, `git checkout .`, `git restore .`, `git branch -D`, mass deletions, secret paths).

### 3. OS runtime sandbox boundary

Syscall containment uses `@anthropic-ai/sandbox-runtime` (Apple Seatbelt `sandbox-exec` on macOS, `bubblewrap` on Linux):
- **No Regex Security Theatre**: Verifier read-only integrity is enforced by the operating system kernel, not regex matching on command strings. Indirect write attempts via `node -e "fs.writeFileSync(...)"`, `python3`, `ruby`, or third-party binaries fail at the OS syscall layer (`EACCES` / `Operation not permitted`).
- **Verify Output Roots**: Pre-creates permitted output subdirectories (`.cache`, `coverage`, `dist`, `build`, etc.) on the host filesystem before initializing the Seatbelt sandbox, enabling test runners and compilers to emit build artifacts while keeping the entire source tree strictly read-only.
- **Secret Protection**: `COMMON_DENY_READ` blocks reading `~/.ssh`, `~/.aws`, `~/.gnupg`, and Pi's `auth.json`. Workspace secrets (`.env*`, `*.pem`, `*.key`) are anchored in both `denyRead` and `denyWrite` at the sandbox level and blocked by contained tools.
- **Symlink Escape Protection**: Symlink traversals are resolved to canonical target paths by the OS kernel. Symlinks inside permitted output roots pointing to source, or inside the workspace pointing outside, fail on write with OS-level permission denial (`Operation not permitted`), leaving target files untouched.
- **Graceful Degradation**: If sandboxing is disabled (`AIES_SANDBOX=0`) or unsupported on the host platform, Worker logs a warning and falls back to unsandboxed execution. Verify strictly refuses execution (`throw new Error(...)`) because independent verification requires OS-level enforcement to guarantee artifact integrity.

## Context governor (AIES-007)

AIES-007 establishes the **Context Governor** (`extensions/aies-agents/context-governor.ts`)
as the single conceptual authority governing the Parent session context size and lifecycle.

### Operational budget versus provider window

Modern model providers offer context windows of 1M tokens or more. That capacity
is an upper physical limit, not a healthy working memory size. An unmanaged parent
session accumulating hundreds of thousands of tokens suffers from:
- **Severe tool output bloat**: Raw outputs, file reads, and search dumps dominate tokens.
- **Context saturation and reasoning degradation**: Needles get lost in haystacks; model focus degrades.
- **Cost and latency inflation**: Every subsequent turn incurs massive processing overhead.

Pi's native compaction activates only when approaching the provider's physical limit.
AIES decouples the **AIES operational budget** from the **provider context window**:
delegation is the primary prevention mechanism, and proactive compaction is the secondary
safety net.

### Delegation as primary prevention, compaction as secondary mechanism

```
+-------------------------------------------------------------------------+
| Prevention (Primary): Child Agent Delegation (aies_delegate)            |
|   - Explore investigates codebases (read-only)                          |
|   - Worker implements changes in isolated sub-sessions                  |
|   - Verify tests artifacts with independent OS containment              |
|   => Large tool outputs stay inside disposable child sessions           |
+-------------------------------------------------------------------------+
                                    |
                                    v (Parent context grows from conversations & decisions)
+-------------------------------------------------------------------------+
| Hygiene: Tool-Output Hygiene (Parent Session)                           |
|   - Outputs > 32k chars truncated with head+tail retention (12k chars)  |
|   - aies_delegate handoffs STRICTLY exempt (verdict/defect protection)  |
+-------------------------------------------------------------------------+
                                    |
                                    v (If Parent reaches operational compaction threshold)
+-------------------------------------------------------------------------+
| Safe Compaction (Secondary): Single-Flight Compaction at agent_settled  |
|   - Triggers at settled boundary (never mid-turn or during tools)       |
|   - Wraps Pi's callback-based ctx.compact() into an async Promise       |
|   - Curated prompt preserves decisions, architecture, tasks & contracts |
+-------------------------------------------------------------------------+
```

### Context budgets and zones

Configured in `profile/aies.json` under `context`:

| Zone | Condition | Behavior |
|---|---|---|
| `green` | `< 80k` tokens | Normal operation. |
| `amber` | `>= 80k` tokens | Target threshold reached. Routing signals encourage delegation. |
| `pressure` | `>= 100k` tokens | Context pressure active. Footer displays warning (`ctx ...!`). Soft pressure to delegate. |
| `compact` | `>= 120k` tokens | Scheduled for compaction at next `agent_settled`. |
| `ceiling` | `>= 150k` tokens | Hard operational ceiling. Direct heavy tools (`read`, `edit`, `write`, search, heavy bash) blocked; `aies_delegate` remains strictly allowed. |

For models with smaller context windows (e.g. 128k), budgets adapt dynamically:
`effectiveThreshold = min(absoluteThreshold, floor(ratio * contextWindow))`.

### Proactive compaction at safe boundary

Compaction in the parent session obeys strict lifecycle invariants:
1. **Safe Boundary (`agent_settled`)**: Compaction is never triggered mid-turn or during tool execution. When tokens cross `compactTokens` (120k), a compaction request is scheduled and executed once the agent has fully settled.
2. **Async Serialization (Single-Flight)**: Pi's `ctx.compact({ customInstructions, onComplete, onError })` executes an asynchronous IIFE. The governor wraps this callback contract into a Promise (`compactingPromise`) and tracks `isCompacting`, preventing concurrent or overlapping compactions.
3. **Structured Instruction Retention (`AIES_COMPACTION_INSTRUCTIONS`)**: Instead of generic summarization, compaction is instructed to preserve architectural decisions, completed work, active tasks, verification status, file paths, and external constraints, while eliminating verbose intermediate tool outputs.
4. **Resilience**: If compaction fails, the governor records the failure, enters a cool-down state (`compactionCooldownUntil`), and allows conversation to continue without crashing Pi.

### Tool-output hygiene

Parent tool results exceeding 32,000 characters are sanitized before being committed to conversation history:
- **Head + Tail Truncation**: Retains the first 8,000 characters and last 4,000 characters, joined by a structured marker: `[... AIES Context Governor: X characters omitted ...]`.
- **Handoff Protection**: Results from `aies_delegate` are strictly exempt from truncation, ensuring that structured child handoffs (verdicts, defects, evidence, diffs) arrive intact.

## Linear ticket workflow (AIES-008)

AIES-008 establishes Linear tickets as the **operational unit of work** for an AIES parent session.
Linear acts as the external source of truth for active ticket identifiers, status, acceptance criteria,
and project metadata, while never serving as memory, repository context, backlog dump, or giant prompt.

### Parent ownership and child isolation

```
+-------------------------------------------------------------------------+
| Parent Session (Sole Owner of Linear Workflow)                          |
|   - aies_ticket tool (load, start, complete, block, comment, show)      |
|   - /aies-ticket [id] command for developer ergonomics                  |
|   - pi-mcp-adapter: the single mcp proxy tool that reaches Linear       |
|   - Normalizes raw issue into compact contract (< 2,500 chars)          |
|   - Evaluates Done Gate against independent verification state          |
+-------------------------------------------------------------------------+
       |                                  |                        |
       | minimal goal & question          | work unit & ACs        | exact criteria & diff
       v                                  v                        v
+------------------+             +------------------+    +-------------------+
| Explore Agent    |             | Worker Agent     |    | Verify Agent      |
|   NO Linear tools|             |   NO Linear tools|    |   NO Linear tools |
|   NO Linear MCP  |             |   NO Linear MCP  |    |   NO Linear MCP   |
+------------------+             +------------------+    +-------------------+
```

- **Single Active Ticket per Session**: 1 ticket = 1 logical unit of work. Attempting to switch tickets while another is in progress requires explicit completion or forced confirmation.
- **Strict Child Isolation**: Explore, Worker, and Verify sessions receive minimal child contracts derived from the active ticket. Their tool surfaces, prompts, and permissions contain zero Linear tools or schemas.

### Compact operational contract

Linear issues frequently contain tens of thousands of characters of issue descriptions, screenshots, HTML, and discussions. Injecting raw payloads into the Parent session causes instant context bloat.
`extensions/aies-agents/linear/contract.ts` extracts:
1. **Explicit Acceptance Criteria**: Parsed from checklist items (`- [ ]`, `- [x]`) and explicit criteria sections.
2. **Derived Expectations**: Fallback bullet points and imperative requirements (`must`, `shall`, `ensure`).
3. **Ambiguity Flagging**: Highlights uncertain (`TBD`, `TODO`, `?`) items for parent clarification.
4. **Context Hygiene Cap**: Bounded strictly under 2,500 characters, summarizing long descriptions and truncating safely.

### Transport abstraction

`LinearTransport` decouples workflow policy from transport mechanics:
- `FakeLinearTransport`: In-memory, deterministic fake implementing full issue state tracking, comment history, status queries, conflict simulation, and synthetic errors for testing without network or credentials.
- `HostMediatedLinearTransport`: The runtime transport. AIES owns no MCP client, so it never sends a request: it answers from the calls the Parent already performed and otherwise fails with `LinearTransportError("remote_required")` carrying a `LinearRemoteDirective` (server, tool, exact arguments, purpose, and a stable key). Typed codes: `not_found`, `auth_unavailable`, `mcp_unavailable`, `remote_required`, `permission_denied`, `network_failure`, `invalid_transition`, `remote_conflict`.

`TicketManager` keeps the pending directive plus every answer collected for it and
replays the interrupted operation over that cache, so `aies_ticket` resumes an
operation with `remote` instead of restarting it. Replay is pure: every remote value
is an answer the Parent already supplied, which is what makes a resumed multi-call
operation safe.

### MCP integration

```text
AIES profile
├── settings.json   declares npm:pi-mcp-adapter   (Pi installs it into $AIES_HOME/agent/npm)
└── mcp.json        declares one server: linear   (https://mcp.linear.app/mcp, oauth, lazy)

PI_MCP_CONFIG_MODE=exclusive  ->  the adapter reads only that mcp.json
```

- **Ownership**: the repository declares `profile/mcp.json`; the runtime file is
  `$AIES_HOME/agent/mcp.json`, seeded and reconciled by
  `scripts/seed-profile-config.mjs`. User additions to either file survive, and only
  the declared package, server and settings are restored.
- **Surface**: no `directTools` and `scriptMode: false`, so the 66 tools of the
  Linear server stay behind the adapter's proxy tools for that server (`mcp`, plus
  one `mcp__linear` namespace proxy once its catalog is cached) and no Linear
  schema is resident.
- **Presentation settings**: `profile/mcp.json` also pins the adapter's quiet
  result mode — `toolResultRendering: "compact"`, `collapsedResultLines: 1`,
  `notifyOnStartupConnect: false`, `mcpFooterStatus: "off"`. They change only how
  an MCP result is drawn; the `mcp` schema, the model-visible content and the
  parent-mediated `remote_required -> mcp -> replay` flow are unchanged.
- **Diagnostics**: `extensions/aies-agents/mcp/integration.ts` reads the adapter's
  versioned status channel and turns a missing adapter, a missing server, a disabled
  server, a failed server or missing authentication into an instruction that is real
  for the current session mode. No AIES code path reads or advertises an API key, and
  no headless path attempts an interactive OAuth flow.
- **Children**: Explore, Worker and Verify are created with `noExtensions: true` and
  explicit tool allowlists, so the adapter, `mcp` and every Linear schema stay in the
  Parent session.

### Programmatic Done Gate

Marking a ticket as Done in Linear is governed strictly by the verification authority (`extensions/aies-agents/linear/policy.ts`):

```
Request Linear complete
          │
  requiresVerification?
          │
         yes ──► valid fresh Verify PASS?
          │               │           │
          │              no          yes
          │               │           │
          │             DENY        ALLOW
          │
         no ──► ALLOW (docs-only / trivial changes)
```

- **Behavior-Bearing Changes**: Changes touching code or configuration strictly require a valid, fresh Verify PASS (`verifiedRevision === revision && verification.status === "pass"`). Any other status (`none`, `fail`, `blocked`, `running`, or stale PASS) programmatically denies completion.
- **Documentation Changes**: Changes touching only documentation (`.md`, `.txt`, docs directories) complete without requiring a Verify child session.
- **Remote Refresh & Conflict Detection**: `completeTicket()` always queries the remote issue immediately before updating status. If the remote ticket was marked `completed` or `canceled` externally, completion is blocked to avoid overwriting remote work.
- **Preserved PASS on Network Error**: If Linear is unreachable during completion, the operation reports a sync error, but the local verified PASS remains intact; the Worker is never asked to re-run.

### State persistence and observability

- **Pi Session Snapshot**: On `agent_settled`, `TicketManager` persists an `aies-ticket` entry to the Pi session, storing active ticket identifier, work state, and touched paths. On session resume or reload, ticket state is restored without remote network calls.
- **Status & Footer**: The footer displays the active ticket identifier (`AIES · EZE-123 · ...`), and `/aies-status` renders a dedicated `Ticket:` report section displaying ticket status, criteria progress, and Done Gate readiness.

## Bounded task autonomy (`extensions/aies-agents/autonomy/`)

AIES-009. Bounded autonomy is controlled continuation of an active Linear ticket workflow (`LOAD -> START -> PLAN/ROUTE -> EXPLORE -> WORKER -> VERIFY -> REPAIR? -> PASS -> LINEAR COMPLETE -> DONE`). It is NOT an infinite autopilot, multi-ticket runner, or backlog crawler.

```
+-------------------------------------------------------------------------+
| ContinuationController (extensions/aies-agents/autonomy/)               |
|   - Evaluates at agent_settled boundary only                            |
|   - Coordinates strictly with Context Governor (awaits onComplete)      |
|   - Single-flight deduplication: exactly one follow-up per settle       |
|   - Stops on completion, blockers, permission prompt, or no-progress    |
|   - Circuit breaker: MAX_AUTO_CONTINUATIONS = 20                        |
+-------------------------------------------------------------------------+
        |
        v pi.sendUserMessage(AIES_CONTINUATION_PROMPT, { deliverAs: "followUp" })
+-------------------------------------------------------------------------+
| Parent Agent Turn (Pi Session)                                          |
|   - Follows Linear ticket contract, routing guardrails & Done Gate      |
|   - Child delegations (Explore, Worker, Verify) run in isolated context |
+-------------------------------------------------------------------------+
```

### Components

| Module | Responsibility |
|---|---|
| `types.ts` | State interfaces (`AutonomyState`, `ContinuationDecision`, `AutonomyTelemetry`, `AutonomySnapshot`) |
| `policy.ts` | Pure evaluation (`evaluateContinuation`) and state fingerprinting (`computeStateFingerprint`) |
| `controller.ts` | Runtime authority (`ContinuationController`): lifecycle hooks, single-flight deduplication, Pi message dispatch |
| `command.ts` | Developer command (`/aies-run [ticketId \| stop \| status]`) |
| `index.ts` | Barrel export |

### Coordination with Context Governor (AIES-007)

Mandatory ordering: context compaction takes priority over task continuation. When context pressure enters the `compact` zone at the end of a turn:
1. `governor.handleSettled(ctx)` wraps Pi's callback-based `ctx.compact()` in a Promise and awaits completion.
2. `controller.handleSettled(ctx)` runs only after `onComplete` is reached.
3. If compaction fails at ceiling, the controller halts autonomy with `context_failure` to prevent runaway token exhaustion.

### Stop and Pause Conditions

- `completed`: Ticket marked Done in Linear through Done Gate. Autonomy halts cleanly with 0 additional follow-ups.
- `user_required`: Permission prompt (`ask`) or substantial task scope change pauses autonomy safely for human input.
- `blocked`: Verification blocked, OS sandbox unavailable, Linear remote conflict, or Linear network failure post-PASS.
- `repair_limit` / `verification_failed`: Verification policy exhausted repair attempts or repeated failure signatures.
- `no_progress`: 3 consecutive settled states produce the exact same fingerprint.
- `continuation_limit`: Circuit breaker triggers after 20 consecutive autonomous continuations on a ticket.
- `user_stopped`: Manually cancelled via `/aies-run stop`.

### Session Resume Safety

Session snapshot persistence records `aies-autonomy` state entries across `/resume`. On restart, ticket and metrics are restored, but autonomy is explicitly set to `enabled = false`. Work never continues autonomously without an explicit user command.

## Presentation layer (`extensions/aies-ui/`)

AIES-010 and AIES-010B turn the functional phases into one readable experience
without adding intelligence. The presentation layer is pure and Pi-free; Pi
remains the UI runtime.

```
extensions/aies-ui/          pure: snapshot -> strings, no Pi import, no state
  paint.ts                   semantic colors behind an injected Paint adapter
  format.ts                  formatTokens, formatDuration, formatCost, clip, singleLine
  vocabulary.ts              deriveStage + independent indicators
  footer.ts                  renderFooter/renderHeader with width degradation
  panel.ts                   the status panel and its responsive bands
  activity.ts                live child card, finished line, entry data
  agents.ts                  mini agents widget, /agents view, selectAgent
  tools.ts                   quiet projections for the six generic tools
  approval.ts                structured permission prompt
  summary.ts                 DONE/BLOCKED cards, /aies-status overview, /aies-run status
extensions/aies-runtime/     the only writer of the footer, the header and the widgets
```

AIES-010B replaces the AIES `setStatus` footer segment with a full custom footer
and adds a responsive active-ticket header, both installed by `aies-runtime` and
both read from the same snapshot. All AIES user-facing copy is Spanish; commands,
code, paths, identifiers, models and the technical tokens (`IDLE`..`DONE`,
`PASS`/`FAIL`/`BLOCKED`, `V:*`, `AUTO`) stay in their original language.
`/aies-status` defaults to the human overview and keeps the full telemetry behind
`detalle`/`all`.

AIES-010C makes the active run legible at a glance without adding intelligence.
It adds the session-local Agent Observatory and the run telemetry, a status panel
below the editor on wide terminals, a compact mini agents widget, one interactive
`/agents` view, quiet rendering for the six generic Pi tools, and a compact DONE
projection. Every new fact is a reading of a snapshot; nothing here routes,
verifies or persists.

### The Agent Observatory and run telemetry (AIES-010C)

The Agent Observatory is **ephemeral presentation state, not agent
orchestration**. `extensions/aies-agents/observatory.ts` is a session-local
registry that observes the existing Explore, Worker and Verify children. It
imports nothing (no Pi, no filesystem, no clock of its own), holds no transcript
and no reasoning, and has no authority: it never routes, authorizes, persists,
retries or changes a child's prompt. It is reset on `session_start` and never
restored from the session file.

| Field group | What a record carries |
|---|---|
| Identity | A stable `<role>-<ordinal>` id, the role and the lifecycle `status` (`running`, `completed`, `failed`, `blocked`) |
| Timing | `startedAt` and `finishedAt`, supplied by the caller |
| Model / provider | `modelId`, `modelLabel`, `providerId`, `providerLabel`, resolved by the role runner |
| Activity | `currentActivity` and a bounded ring of the last 5 mechanically worded tool events (`Leyendo`, `Buscando`, `Editando`, `Ejecutando`, `Comprobando`) |
| Work | `toolCount`, `changedPaths`, and a compact single-line `result` |
| Usage | `totalTokens` and `cost`, sampled from the child's own `SessionStats` |

Child wiring: `session.ts` attaches exactly one event-driven `session.subscribe`
listener per observed child. Tool starts become mechanical activities, and
`turn_end` / `agent_settled` / `agent_end` sample the public `SessionStats`
(`tokens.total`, `cost`) before disposal. `explore.ts`, `worker.ts` and
`verify.ts` each open and close exactly one record in a `finally`, so a record
exists even when the child throws. `delegate.ts` passes the singleton and a
provider display label. Handoff shapes, prompts, tool surfaces and routing are
unchanged: the registry only watches.

**Crossing the extension boundary.** Pi loads each extension through its own
jiti instance (`moduleCache: false`), so the `observatory` singleton that
`aies-agents` mutates is **not** the module `aies-runtime` imports. The registry
therefore crosses the boundary on Pi's documented `pi.events` bus: `aies-agents`
re-publishes every registry mutation on the stable `aies:agents` channel, and
`aies-runtime` consumes it, folds it through `applyAgents` and repaints once. An
absent bus or a silent publisher leaves the projection empty; it never crashes
the runtime.

The `agents` projection is deliberately ephemeral. `toSnapshot` never writes it
and `fromSnapshot` never reads it, so a resume or `/fork` cannot resurrect a
finished child as if it were still running.

**Run telemetry.** `usage.ts` reduces usage into three buckets with
`aggregateUsage`: Main, Agents and Total.

- **Main** is the Parent usage since the current run's baseline. The baseline is
  the first Parent sample after `applyRunStart`, and Parent usage comes from the
  session's own assistant `usage` records, reduced incrementally (each entry is
  read once and the cache is reset on `session_start`).
- **Agents** is the sum of the observatory's child records, whose usage the
  wiring sampled from the child session before disposal.
- **Total** is `main + agents`, counted once.
- An unknown cost is `null` at every level and is never estimated; when any
  included bucket has an unknown cost, the aggregate cost is `null` too.

Child usage cannot double count into Main: a delegated child runs in an isolated
in-memory session created with `noExtensions: true`, the Parent session's entries
never contain child usage, and `aies_delegate` returns no nested `usage` field.
Main excludes children by construction, and Agents is the registry alone, so the
Total adds each token exactly once.

### Authority boundary

The UI is a projection and never an authority:

```
runtime state  ->  UI projection        (correct)
widget text    ->  inferred workflow   (never)
```

Every renderer takes a snapshot and returns strings. `renderStatusReport` (the
detailed telemetry dump) and the footer read the same snapshot, so they cannot
disagree. No renderer is a writer, and no renderer is consulted by routing,
verification, permissions, the governor or the continuation controller.

### Workflow vocabulary

One stage dimension: `IDLE, EXPLORE, WORK, VERIFY, REPAIR, WAIT, BLOCKED, DONE`,
derived by `deriveStage` from the active delegation, the verification record and
the autonomy stop reason, in that documented order. Autonomy (`AUTO`), context
health (`ctx 42k`, `ctx 104k !`, `compactando…`), verification (`V:PASS`,
`V:FAIL`, `V:STALE`, `V:ERROR`) and permissions (`PERM`, `SANDBOX OFF`) are
independent indicators and are never folded into the stage.

### Pi surfaces and ownership

| Surface | Pi API | Owner | Lifetime |
|---|---|---|---|
| Custom footer | `ctx.ui.setFooter` | `aies-runtime` | until cleared or session end |
| Startup ticket header | `ctx.ui.setHeader` | `aies-runtime` | until cleared or session end; renders no lines while the panel is visible |
| Widget `aies-activity` | `ctx.ui.setWidget` (factory, above editor) | `aies-runtime` | while a child runs; cleared as soon as it finishes |
| Widget `aies-agents` | `ctx.ui.setWidget` (factory, above editor) | `aies-runtime` | while the observatory has records |
| Widget `aies-panel` | `ctx.ui.setWidget` (factory, below editor) | `aies-runtime` | while the terminal is at least 72 columns |
| `/agents` view | `ctx.ui.custom` | `aies-runtime` | until Escape |
| Finished child / DONE / BLOCKED entries | `pi.appendEntry` + `pi.registerEntryRenderer` | `aies-runtime` | persisted in the session file |
| Quiet generic tool rows | `pi.registerTool` with `renderCall`/`renderResult` | `aies-runtime` | re-registered once per working directory |
| Permission prompt | `ctx.ui.confirm` | `aies-agents` | until answered |

The panel is content-driven. At `>= 72` terminal columns the status panel is a
persistent widget below the editor and the startup ticket header renders no
lines, so the two never duplicate a fact; below that the panel is absent and the
responsive ticket header is the identity surface. While the panel is visible the
footer renders its minimal form (identity, ticket, stage, context and alarms) so
it does not repeat what the panel already shows; otherwise the rich footer
returns. The panel is never a sidebar, takes no editor width and holds no state.

One timer exists, owned by `aies-runtime`: 1s while a child is active, 5s
otherwise, cleared on shutdown and unreferenced so it can never hold the process
open. The observatory adds no timer of its own; its widget repaints from the
registry subscription and that single clock.

### AIES tool rendering

AIES-owned plumbing receives presentation-only hooks. `aies_ticket` and
`aies_delegate` define `renderCall`/`renderResult` that project structured args
and details into one compact Spanish row, hide settled chrome, keep a real error
visible when collapsed, and print the original content byte-identical when
expanded. Since AIES-010C the six generic tools that carry raw file and shell
traffic (`read`, `bash`, `grep`, `find`, `edit`, `write`) are re-registered
through the documented Pi override pattern: `quiet-tools.ts` creates one public
`create*Tool(cwd)` instance per tool, delegates `execute` to it unchanged, and
adds only the `extensions/aies-ui/tools.ts` projections. The native shell is kept
(no `renderShell: "self"`), so Pi still frames a failure, and expanded output is
the raw text byte for byte. Tool hooks never touch execution, `content`,
`details`, the error flag or the schema, and they never send a conversation
message. The external `mcp` tool is still not wrapped or replaced: the adapter's
quiet result mode is pinned in `profile/mcp.json` (see above), which changes only
the drawing of an MCP result.

### No context pollution

Pi distinguishes a *message* (`pi.sendMessage`, which participates in the LLM
context) from a *custom entry* (`pi.appendEntry`, documented as not sent to the
LLM). AIES uses `sendMessage` for zero UI purposes. Progress, the live card, the
finished-child line and the DONE/BLOCKED summaries use `setFooter`, `setHeader`,
`setWidget`, `notify` and `appendEntry` + `registerEntryRenderer`, so everything
the human watches stays invisible to the model. `tests/aies-ui-seam.test.mjs`
fails if any UI path starts sending messages, and fails if the retired
`setStatus` is used again.

The DONE and BLOCKED summaries travel through one publish path. The DONE card is
edge-triggered on the observed ticket reaching Linear's completed state, and
autonomy stopping with `completed` shares the same single latch, so a run appends
exactly one DONE `aies-summary` entry. The durable entry is always appended, and its
headline is sent through `notify` only where the durable card cannot be drawn (a
non-TUI mode, or a host without entry renderers), so the human never sees the same
headline twice.

### Degradation

- Terminal width: at `>= 100` columns the status panel (a widget below the
  editor) is a borderless block of at most 4 lines, each at most `72` columns
  wide; from `72` columns it is a single-column box of at most 6 lines, at most
  `72` columns wide; below `72` it renders nothing and the responsive ticket
  header is the identity surface. While the panel is present the footer is
  minimal; otherwise it drops segments by documented priority
  (model -> cwd -> `V:PASS` -> `AUTO` -> stage -> `ctx`) and keeps identity,
  ticket and alarms (`V:FAIL`, `V:STALE`, `V:ERROR`, `PERM`, `SANDBOX OFF`). The
  ticket header collapses to one line below 60 columns, the activity card is boxed
  from 48 columns and capped at `72`, and the mini agents widget renders from 48
  columns.
- No UI (print, json, RPC without dialogs): no widget, no status, no entries, no
  panel. The workflow is unchanged; `/aies-status` still answers and `/agents`
  answers through `notify`.
- A failing projection is swallowed: observation is optional, Pi's behaviour is not.

Detailed reference: `docs/UX.md`.

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
| presentation invariants (AIES-010) | footer vocabulary and width degradation, stage derivation, activity lifecycle, approval prompt and DONE/BLOCKED summaries, driven directly from real snapshots (`tests/aies-ui.test.mjs`) |
| presentation is context-free (AIES-010) | a fake `ExtensionAPI` records every call; the UI path must use only `setFooter`/`setHeader`/`setWidget`/`appendEntry`/`notify` and never `sendMessage`, and it fails if the retired `setStatus` is used (`tests/aies-ui-seam.test.mjs`) |
| Verify completion authority (AIES-010B) | the schema-validated `aies_verify_complete` tool as the sole verdict source, `protocol_error` separated from `pass`/`fail`/`blocked`, one attempt with zero repairs and no rerun, and a captured verdict that survives a failing final prose (`tests/verify.test.mjs`, `tests/smoke-verify.test.mjs`) |
| Spanish presentation (AIES-010B) | the resident Parent rule, the Spanish identity/footer/status/approval copy, the responsive ticket header, and the absence of a raw child summary in the card or entry, driven directly (`tests/spanish-ux.test.mjs`) |
| AIES tool rendering (AIES-010B) | `aies_ticket`/`aies_delegate` compact pending/success/error rows, visible collapsed errors and byte-identical expanded content (`tests/tool-rendering.test.mjs`), plus the effective compact MCP presentation settings (`tests/isolation.test.mjs`) |
| observatory registry (AIES-010C) | the pure module boundary (no Pi, filesystem or network), sequential `<role>-<ordinal>` ids, the bounded 5-entry activity ring, mechanical Spanish wording, changed paths, live/final usage, missing cost and the Main/Agents/Total reduction without double counting (`tests/agent-observatory.test.mjs`) |
| observatory child wiring (AIES-010C) | exactly one `subscribe` listener per child, usage sampled only on lifecycle boundaries, the last sample surviving disposal, and a throwing observer or unavailable `subscribe` never failing the run (`tests/agent-observatory-wiring.test.mjs`) |
| run telemetry (AIES-010C) | the run baseline subtracted from Parent lifetime usage, run start/restart, Main kept Parent-only, Agents as the registry sum, and an unknown cost propagating as `null` (`tests/run-telemetry.test.mjs`) |
| status panel (AIES-010C) | the wide borderless / mid box / hidden tiers and their breakpoints, row omission with no value, and `formatCost` rendering an em dash for an unknown value (`tests/aies-panel.test.mjs`) |
| `/agents` view (AIES-010C) | the mini widget cap and `… N más` overflow, the detail rows, and the wrap-around `selectAgent` navigation (`tests/agents-view.test.mjs`) |
| observatory UI seam (AIES-010C) | the panel below the editor with no duplicate ticket header, the minimal footer exactly while the panel is visible, the `aies-agents` widget, `/agents` navigation and the compact DONE telemetry, all through a fake `ExtensionAPI` (`tests/observatory-ui.test.mjs`) |
| quiet generic tools (AIES-010C) | the six re-registered tools delegating `execute` untouched, collapsed success rows, the always-visible bounded error rows, the truncation hint and byte-identical expanded output (`tests/quiet-tools.test.mjs`) |
| Linear identity boundary (AIES-010C) | a remote issue without a non-empty `identifier`/`id` rejected before normalization or state mutation, uuid-only payloads refused, the active ticket preserved on invalid refresh, and `no_pending_remote` kept as the stale-replay guard (`tests/linear.test.mjs`) |
| skills policy | RPC `get_commands` contains zero `source: "skill"` entries |
| package isolation | `aies list` output excludes every package of the ambient profile |
| non-regression | sha256 of the ambient profile's `settings.json`, `auth.json`, `models.json` and the session directory listing are unchanged |

No credentials and no model calls are involved, so the suite runs anywhere. The
checks above are unit and integration checks: they prove the wiring, not a live
Linear workflow. The shell additionally ran by hand in a real TUI — `/aies-status`
and `/aies-status detalle` render in Spanish in cmux, and the shell renders
correctly in an 80-column `tmux`. The AIES-010C suites bring the suite to 607
passing tests across the observatory, telemetry, panel, agents view and quiet tool
checks listed above.

The phase also ran live smokes in a scratch `aies-smoke` repository on the
isolated profile. `EZE-424` (a 140-column TUI) and `EZE-425` reached
`Worker -> Verify PASS -> Linear Done`, with Linear really reaching `Done`. One
`EZE-425` attempt stopped on `BLOCKED · V:ERROR` because the scratch fixture
itself left `npm test` red, so Verify could not close its criteria: that is the
protocol-error path rendering correctly, not a product defect, and the fixture was
repaired before the successful run. `aies -p "/aies-status"` exits 0 with no TUI
surface, and `--mode rpc` slash-command prompts fail identically in ambient `pi`,
so that failure is Pi's RPC behavior and not an AIES regression. Startup measures
`0.19s` against a `0.18-0.20s` baseline, and the observer still owns exactly one
adaptive interval.

## Generated versus versioned

| Versioned in this repo | Generated at runtime |
|---|---|
| `bin/`, `scripts/`, `extensions/`, `profile/`, `tests/`, `docs/`, `odd/` | everything under `AIES_HOME` |
| `package.json`, `package-lock.json`, `README.md`, `AGENTS.md` | resource symlinks inside the profile |

Rule: Pi's runtime writes never enter the repository; repository content only
reaches the profile through symlinks and the one-time settings seed.
