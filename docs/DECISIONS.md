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

## D11 - Independent verification, bounded repair, and a PASS that expires (AIES-005)

**Decision.** AIES adds a third child role, `verify`, with its own prompt, its own
read-only command policy and no mutation primitive at all: `read`, `grep`, `find`,
`ls`, `tgrep` and a guarded `bash` that refuses mutating git subcommands, file
deletion or movement, in-place editing, dependency installation and file
redirection, and the command substitution that would hide a command from the
guard. The role receives facts only - work unit, acceptance criteria,
changed paths, base ref, suggested checks - and rejects free-form `context`, so a
Worker transcript has no field to travel in. It answers `pass | fail | blocked`
with per-criterion evidence, checks and defects, capped like the other handoffs,
and a `pass` without any evidence is downgraded to `blocked` when the handoff is
parsed. The parent keeps the record (`verification.ts`): a monotonic
behaviour-bearing revision ties a PASS to the artifact it verified, so a relevant
parent edit or Worker run invalidates it by moving the revision, without hashing
anything, while a documentation-only change does not expire a PASS. A FAIL may be
repaired twice; a failure whose signature repeats stops the loop early. The repair
Worker gets the original work unit, the criteria and the concrete defects, never
the Verify transcript, and the next verification runs in a fresh session. The
verdict never authorises delivery.

**Why.** A Worker reporting "tests pass" is a claim, not evidence, and a parent
that accepts it has no independent signal that the change it believes it made is
the change that exists. Independence here is cheapest in context, not in model:
a fresh session, a different prompt, the real artifact and the absence of the
implementer's narrative. Bounding the repair loop and stopping on a repeated
failure signature keeps a broken premise from burning unbounded tokens, which is
the failure mode a verification gate creates when it is added without a budget.
Tying the verdict to a revision counter rather than a content hash keeps the
invalidation rule small enough to test directly.

**Consequence.** "This work unit is verified" is now a claim the parent can only
support with a valid PASS, and an old PASS stops being valid the moment the
artifact changes. Verify is read-only as a matter of tool surface and policy, not
of sandbox: caches, build artifacts, coverage files and temp files produced by
running the repository's own checks are tolerated, and the full permission layer
is explicitly AIES-006. Verification measures and reports; it does not commit,
push, merge, deploy or close anything.


---

## D12 - Permission boundaries: 3-layer model and OS sandbox via `@anthropic-ai/sandbox-runtime` (AIES-006)

**Decision.** AIES establishes a three-layer permission boundary:
1. **Capability surface**: what tools each role possesses (Explore: strictly read-only tools, no shell; Worker: read, search, edit, write, sandboxed bash; Verify: read, search, read-only sandboxed bash, no edit/write tools).
2. **Permission policy**: small ALLOW / ASK / DENY taxonomy. Routine local work is ALLOW; boundary-crossing actions (dependency changes, non-routine network) are ASK (requires user approval when UI is available; blocked/denied in headless/child sessions); dangerous/irreversible actions (sudo, secrets access, out-of-workspace writes, destructive git) are DENY.
3. **OS/runtime boundary**: syscall-level filesystem and network containment via `@anthropic-ai/sandbox-runtime` (Seatbelt on macOS, bubblewrap on Linux). Worker is constrained to workspace-write; Verify is strictly source-read-only with explicit allowed output roots (`.cache`, `coverage`, `dist`, `build`, `/tmp`).

Parent retains model API keys and coordinates from the host; child tool executions run under the OS sandbox. When the sandbox is unavailable, Explore remains operational, Worker falls back explicitly to limited mode, and Verify is BLOCKED because its source-read-only guarantee requires OS-level enforcement.

### Evaluated Options & Decision Gate

| Criteria | Option A: Command Guards Only | Option B: `@anthropic-ai/sandbox-runtime` (Selected) | Option C: Gondolin / Micro-VM | Option D: Manual Seatbelt / Docker |
|---|---|---|---|---|
| **Seguridad** | Weak (regex bypasses via `node -e`, `python -c`, scripts) | Strong (OS kernel syscall enforcement via Seatbelt/bwrap) | Strongest (hardware virtualization boundary via QEMU) | Medium-High (Docker daemon or fragile custom profiles) |
| **Complejidad** | Low initial, endless regex whack-a-mole | Low (well-maintained small package, official Pi pattern) | Very high (QEMU, guest kernel, VFS mounts, path translation) | High (maintaining custom `.sb` profiles or Docker daemon) |
| **macOS** | Native | Native (uses built-in `/usr/bin/sandbox-exec`) | Heavy (QEMU on Mac, guest Linux can't run Darwin binaries) | Docker Desktop required or custom Scheme profiles |
| **Latencia** | <1 ms | 25-30 ms init, <1 ms command wrap | 2,000 - 5,000 ms VM boot, 9p I/O lag | 1,000 - 3,000 ms container start |
| **Mantenimiento** | Unbounded blacklist maintenance | Anthropic-maintained (`@anthropic-ai/sandbox-runtime`) | High (VM images, QEMU versions, guest toolchains) | Permanent custom maintenance |
| **Integración AgentSession**| Direct | Seamless (`wrapWithSandbox` in child bash runner; host auth intact) | Intrusive (rewrites all 7 tools, guest/host path translation) | Cumbersome |
| **Tests** | Unit tests on strings only | Deterministic real OS containment tests without mocks | Requires QEMU in test runner (slow, flaky) | Requires running daemon |
| **Side effects** | High risk of accidental disk mutations | Contained: source protected, allowed output roots work | Virtual disk divergence, sync latency | Volume permission issues |
| **Dev experience** | Annoying false positives and security theatre | Fast, native toolchain, clear OS permission errors | Toolchain mismatch (Linux guest on Mac host) | Docker overhead |

**Why Option B.** Pi already provides an official sandbox extension example using `@anthropic-ai/sandbox-runtime` (`examples/extensions/sandbox`). It satisfies every requirement of AIES: local, personal environment without multi-tenant VM overhead; native macOS Darwin performance; clean separation between host credentials/model and sandboxed tool executions; and robust syscall-level protection against indirect code execution (`node -e`, `python -c`, build tools) modifying sources or escaping the workspace.

**Consequence.** AIES depends on `@anthropic-ai/sandbox-runtime` as a runtime dependency. Command guards are relieved from regex security theatre and focus exclusively on semantic policy (git invariants, ASK vs DENY). Verify gains a genuine source-read-only guarantee enforced by the OS.

---

## D13 - Context Governor: Single Authority, Proactive Compaction at Safe Boundary, and Tool-Output Hygiene

**Decision.** A single conceptual authority (`ContextGovernor`) governs the context of the Parent session. It enforces operational budgets (Green, Amber, Pressure, Compact, Ceiling) adapted to the provider's `contextWindow`, coordinates single-flight proactive compaction at the safe boundary (`agent_settled`), awaits completion via Promise-wrapped callbacks, and enforces tool-output hygiene (head+tail truncation for outputs exceeding 32k characters while strictly preserving child delegation handoffs).

**Why.** Real-world Pi sessions previously experienced massive context bloat (~347k tokens, ~109k tool result tokens) because native Pi compaction only protects against buffer overflow near full window capacity (~1M tokens), not against operational context degradation. Delegations (AIES-003, AIES-004, AIES-005) are the primary defense against context bloat by moving heavy discovery, editing, and verification into child sessions; compaction is a secondary safety net for the context that inevitably accumulates in the Parent. Fragmenting compaction triggers, routing pressure, and output hygiene across separate controllers creates races and duplicate counters.

**Key Invariants.**
1. `provider contextWindow != AIES operational context budget`: Never operate at the ceiling of the provider window; reserve ample headroom.
2. `delegation is primary prevention; compaction is secondary safety`: Favour delegating Explore and Worker before context bloat forces compaction.
3. `single flight & safe boundary`: Never invoke `ctx.compact()` mid-turn or during arbitrary tool execution. Mark `compactPending = true` and dispatch exactly once at `agent_settled`.
4. `async serialization`: Because Pi's `ctx.compact({ onComplete, onError })` operates via callbacks and returns `void`, wrap it in a Promise so post-compaction state is never considered complete before the real `onComplete` callback runs.
5. `clean failure handling`: If compaction fails, record the error and transition to a safe state without retrying in an infinite loop. If at ceiling and compaction fails, require context intervention while keeping `aies_delegate` unblocked.
6. `handoff integrity`: Tool outputs for `aies_delegate` are never truncated by the generic governor, preserving structured verdicts, defects, and verification evidence.

**Consequence.** Parent context remains lean and responsive throughout long tasks. Direct heavy work is stopped at the ceiling while delegation remains available as the escape route. Verification state and permissions survive compaction intact.

---

## D14 - Linear Ticket Workflow: Parent Ownership, Compact Contract, Transport Abstraction, and Programmatic Done Gate

**Decision.**
1. The Parent session is the sole owner of Linear workflow. Children (Explore, Worker, Verify) have no Linear tools, no Linear MCP schemas, and no direct issue mutations.
2. Linear serves strictly as the source of truth for active ticket ID, status, acceptance criteria, and project metadata; it never serves as memory, repo context, backlog dump, or giant prompt.
3. Raw Linear issue payloads are normalized into a compact contract strictly bounded under 2,500 characters (`formatCompactContract`), extracting explicit checklist criteria and flagging ambiguities.
4. Transport mechanics are abstracted behind `LinearTransport` (`FakeLinearTransport` for deterministic, offline testing; `HostMediatedLinearTransport` at runtime, see D17).
5. Done Gate is enforced programmatically by the verification authority: behavior-bearing changes require a fresh, valid Verify PASS (`verifiedRevision === revision && verification.status === "pass"`). Stale PASS, fail, blocked, or running strictly deny marking Done. Docs-only changes complete without Verify.
6. `completeTicket()` refreshes remote issue state before updating; if remote state changed externally to completed or canceled, a remote conflict is raised and completion is blocked to prevent overwriting remote work.
7. Autonomy and multi-ticket continuation are strictly deferred to AIES-009.

**Why.**
- Exposing Linear tools or schemas to child agents wastes tokens, risks accidental status transitions or comment spam, and introduces ambient credential leakage into untrusted child contexts.
- Raw issue payloads often exceed 30k+ characters with HTML, image links, and thread discussions. Injecting raw issues directly into the parent causes instant context bloat.
- Testing against live Linear or relying on ambient credentials in test environments creates flaky tests, risks mutating real production backlogs, and breaks when offline or in CI.
- Human or LLM self-reporting of "I tested it and it works" cannot be trusted to mark tickets Done; only the independent Verify authority (AIES-005) executing real repository checks with OS-level containment (AIES-006) provides trustworthy verification evidence.

**Consequence.**
- The parent tool surface expands by exactly one tool: `aies_ticket`. A single ergonomics command `/aies-ticket` is provided for developers.
- Children remain cleanly isolated with zero Linear exposure.
- All test suites execute deterministically without network calls or credentials.
- Linear state stays in sync with real verified repository state without spam or premature completion.

---

## D15 - Bounded Task Autonomy: ContinuationController at Safe Settled Boundary, Strict Compaction Ordering, and Circuit Breakers

**Decision.**
1. Bounded task autonomy is controlled continuation of an active Linear ticket workflow (`LOAD -> START -> PLAN/ROUTE -> EXPLORE -> WORKER -> VERIFY -> REPAIR? -> PASS -> LINEAR COMPLETE -> DONE`). It is NOT an infinite autopilot, multi-ticket runner, or backlog crawler.
2. A single conceptual authority (`ContinuationController`) decides whether to continue automatically. It evaluates exclusively at the `agent_settled` boundary (the Pi lifecycle event fired when an agent run has fully settled and no automatic retry, compaction, or queued continuation will run).
3. Continuation is single-flight: exactly one follow-up message (`pi.sendUserMessage(AIES_CONTINUATION_PROMPT, { deliverAs: "followUp" })`) is dispatched per settled event. Duplicate settled events while a continuation turn is pending are ignored.
4. Compaction takes strict priority over continuation: when compaction is pending at settled boundary, `governor.handleSettled(ctx)` is awaited to `onComplete` BEFORE `controller.handleSettled` evaluates. Compaction and continuation never run concurrently.
5. Circuit breakers: maximum 20 continuations per ticket (`continuation_limit`), and automatic stop if 3 consecutive settled states produce the exact same fingerprint (`no_progress`).
6. Safety pauses: user permission prompts (`ask`), substantial task scope changes, or blockers halt autonomy safely and return control to the developer.
7. Session resume safety: session snapshots persist autonomy metrics and ticket state across `/resume`, but `state.enabled` is unconditionally restored as `false`.

**Why.**
- An unconstrained agent loop risks spinning endlessly, consuming tokens and API quotas on failing repairs or unrecognized deadlocks. Bounding continuation to a single active ticket with hard limits (20 turns, 3 identical fingerprints) guarantees bounded execution.
- Pi's `agent_settled` hook is the only structurally safe boundary for extension-initiated turn continuations. Triggering follow-ups mid-turn or during tool execution creates race conditions with Pi's internal turn management.
- Firing follow-up turns while compaction is in progress risks corrupting session context or compacting while the LLM is responding. Awaiting compaction to `onComplete` ensures clean, serial context transitions.
- Automatic resume after session restore risks unmonitored code execution in background terminals. Explicit user activation via `/aies-run` ensures human oversight.

**Consequence.**
- Developers can activate bounded autonomy via `/aies-run [ticketId]` and safely let AIES progress through explore, implement, verify, repair, and complete phases.
- Autonomy halts cleanly upon reaching Done or facing a real blocker, with zero infinite loops.
- Existing routing, verification, permission, context governor, and Linear gate invariants remain strictly enforced.

---

## D16 - Presentation Layer: UI as a Projection, One Vocabulary, Pi-Owned Rendering, and No Context Pollution

**Decision.**
1. The UI is a projection of runtime state and never an authority. Every renderer is a pure function of a state snapshot; no widget text is ever read back to infer workflow state.
2. Presentation lives in one pure module, `extensions/aies-ui/`, with no Pi import and no state. `aies-runtime` owns the Pi surfaces (one footer status key, one widget key, the entry renderers); `aies-agents` owns the approval dialog. No UI framework, no component registry, no second runtime is introduced.
3. High-level workflow state has exactly one dimension with eight values (`IDLE, EXPLORE, WORK, VERIFY, REPAIR, WAIT, BLOCKED, DONE`). Autonomy, context, verification and permissions are independent indicators and are never folded into the stage.
4. The footer is one line: identity, ticket, stage, context health, autonomy, and alarms only. Counters, peaks, percentages, ceilings, elapsed time and per-phase telemetry are not footer vocabulary; they live behind `/aies-status`.
5. A running child is one live widget updated in place, never one message per event; a finished child leaves one compact durable transcript line and its widget expires after 60 seconds.
6. Progress and completion surfaces must never enter the LLM context. `setStatus`, `setWidget`, `notify` and `appendEntry` + `registerEntryRenderer` are used; `sendMessage` is never used for UI. Pi documents custom entries as not participating in LLM context, which is what makes durable UI free.
7. Permission policy is untouched: `ASK` keeps its `ASK -> DENY` behaviour without UI, and only its presentation becomes an actionable prompt with action, side effect and reason.
8. Every surface degrades to silence. A failing projection, a non-TUI mode or a narrow terminal changes what is drawn, never what the workflow does.

**Why.**
- AIES-002..009 each added a visible surface. The footer accumulated one segment per phase, mixed Spanish and English inside a single line, and ended up closer to a telemetry dump than to an answer to "what is happening?".
- Deriving state from rendered text would create a second, silent source of truth. That is the failure mode this decision exists to prevent.
- Progress text sent as conversation messages is billed as context and pollutes the parent that delegation exists to protect. The one-line guarantee keeps observation free.
- A user-visible framework would be a new subsystem with its own lifecycle, tests and upgrade path, for a product that shows one child at a time.

**Consequence.**
- The number of always-visible elements decreases while the amount of information available on demand stays the same.
- All AIES rendering becomes testable without a terminal, because the renderers take a snapshot and return strings.
- Behavioural authorities (routing, verification, sandbox, Context Governor thresholds, Linear Done Gate, continuation decisions, repair limits, model routing) keep their semantics; only their presentation changes.
- Related detailed reference: `docs/UX.md`.

---

## D17 - Linear over the official MCP server: a profile-owned adapter, a parent-mediated transport, and no AIES MCP client

**Decision.**
1. The isolated AIES profile declares `npm:pi-mcp-adapter` in `profile/settings.json` and exactly one MCP server, `linear`, in `profile/mcp.json`, pointing at `https://mcp.linear.app/mcp` with `auth: "oauth"` and `lifecycle: "lazy"`. Pi installs the declared package into `$AIES_HOME/agent/npm/`; AIES does not fork, vendor, patch or copy the adapter, and does not implement an MCP client.
2. `scripts/seed-profile-config.mjs` seeds what is missing and restores only what the template declares, so user additions to the profile survive. It never touches the network and never writes a credential.
3. `bin/aies` exports `PI_MCP_CONFIG_MODE=exclusive`, so the adapter reads only `$AIES_HOME/agent/mcp.json`. Host-global MCP configs (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`) and project-local `.mcp.json` / `.pi/mcp.json` are never merged into an AIES session.
4. The profile sets no `directTools` and sets `settings.scriptMode: false`, so the Linear server's 66 tools stay behind the adapter's proxy surface for that server: the `mcp` gateway plus one `mcp__linear` namespace proxy once its catalog is cached. That is about 3.6 KB of resident definition instead of the roughly 80 KB catalog, and zero resident Linear schemas.
5. AIES owns no MCP transport. Pi exposes no programmatic tool invocation to extensions, so `HostMediatedLinearTransport` never sends a request: it answers from the calls the Parent already performed and otherwise fails with `LinearTransportError("remote_required")` carrying a `LinearRemoteDirective`. `TicketManager` keeps the pending directive and the answers collected for it and replays the interrupted operation over that cache, and `aies_ticket` accepts `remote` to resume it. Replay is pure, because every remote value is an answer the Parent already supplied.
6. OAuth is the primary authentication path. The interactive instruction is `/mcp-auth linear`, which the adapter owns; AIES registers no MCP command of its own. No AIES code path reads, forwards or advertises `LINEAR_API_KEY`.
7. Headless sessions (`print`, `json`, `rpc`) never start an OAuth flow. They report that authentication has to happen in an interactive AIES session.
8. Credentials live in the adapter's OS credential store, keyed by server name and bound to the MCP URL. Nothing is written to the repository and nothing is written to `$AIES_HOME/agent/mcp.json`. Because the key is the server name plus URL, `aies` and `pi` share one credential record for `linear`; AIES does not have its own credential namespace.
9. Explore, Worker and Verify are created with `noExtensions: true` and explicit tool allowlists, so the adapter, `mcp`, `mcpScript` and every Linear schema are absent from a child session.

**Why.**
- The adapter is the only component that should own MCP transport, OAuth, credential storage and tool registration. Reusing it keeps AIES out of a protocol and a credential store it would otherwise have to get right on its own.
- A hosted MCP server can expose dozens of tools. Registering them directly would spend context on every turn for tools a ticket workflow rarely calls, and the Linear catalog alone is 66 tools.
- Reading host-global or project-local MCP configuration would silently import servers into an AIES session, which breaks the isolation guarantee the whole project rests on.
- Making the Parent perform every remote call keeps one visible, auditable step between AIES policy and Linear, and keeps credentials out of child sessions entirely.
- An extension cannot invoke a tool, so a transport that pretends to call MCP can only ever fail. Declaring the call honestly is the only design that survives contact with the real runtime.

**Consequence.**
- A Linear operation the Parent has not answered yet costs an extra tool round trip, and a multi-call operation like `complete` costs one per missing call. The alternative was a fabricated success.
- `LINEAR_API_KEY` is no longer a supported path in AIES code. A bearer token remains an explicit opt-out configured in `$AIES_HOME/agent/mcp.json` (`auth: "bearer"`, `bearerTokenEnv: "LINEAR_API_KEY"`), which the user owns and AIES never reads.
- The repository is the source of truth for the declared package and server; `$AIES_HOME/agent/mcp.json` is the runtime file Pi and the adapter own.

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
