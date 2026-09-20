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

## D18 - AIES-010B presentation shell: a full Spanish shell, quiet AIES plumbing, and UI-only MCP settings

**Decision.**
1. While an AIES session is active, `aies-runtime` installs a full custom footer
   with `ctx.ui.setFooter` and a responsive active-ticket header with
   `ctx.ui.setHeader`, and restores Pi's built-in footer and header on shutdown.
   The AIES `setStatus` segment is retired. Both surfaces render from the same
   snapshot (this refines D16 item 2, which owned a footer status key) and feed no
   workflow decision.
2. All AIES user-facing copy is Spanish. Commands, code, paths, identifiers,
   models, the stage tokens (`IDLE`..`DONE`), the verdict tokens
   (`PASS`/`FAIL`/`BLOCKED`), the `V:*` indicators and `AUTO` stay in their
   original language.
3. One short resident rule is appended to the Parent system prompt once per agent
   start (`before_agent_start`, idempotent): answer in Spanish, keep technical
   identifiers in their original language, and do not narrate steps the UI already
   shows. Children are created with `noExtensions: true` and never receive it, so
   their prompts stay technical.
4. AIES-owned tool plumbing renders quietly. `aies_ticket` and `aies_delegate`
   receive presentation-only `renderCall`/`renderResult` hooks that never mutate
   execution results, `content`, `details`, the error flag or the schema; expanded
   detail is the original text unchanged; a real error stays visible when
   collapsed; an unknown internal error code degrades to a safe Spanish phrase;
   generic Pi tools keep Pi's rendering; and the external `mcp` tool is not
   wrapped or replaced.
5. The adapter's quiet result mode is pinned in `profile/mcp.json`
   (`toolResultRendering: "compact"`, `collapsedResultLines: 1`,
   `notifyOnStartupConnect: false`, `mcpFooterStatus: "off"`). These are
   presentation settings only: the `mcp` schema, the model-visible content and the
   parent-mediated `remote_required -> mcp -> replay` flow are unchanged.
6. `/aies-status` keeps the human overview as the default and the full telemetry
   behind `detalle`/`all`; both read the same snapshot and cannot disagree.

**Why.** The AIES-010 footer was a status segment that grew one segment per
phase and mixed Spanish and English inside a single line, while AIES-owned tool
plumbing printed raw contract text and internal error codes next to Pi's native
tool rows. A presentation phase should make the AIES workflow legible without
changing the workflow: a single shell, Spanish copy for the human, and quiet rows
with the raw content one expansion away. Pinning the MCP result mode in the
profile is the only admissible way to influence the adapter's drawing, because an
extension cannot wrap an arbitrary tool it does not own.

**Consequence.** Fewer always-visible elements remain, while the human still gets
the same information on demand and the technical identifiers keep their meaning.
No behavioural authority changes: routing, verification, permissions, sandbox,
Context Governor thresholds, Linear policy, autonomy and the repair budget keep
their semantics. Detailed reference: `docs/UX.md` §§5, 9, 13, 21 and 22.

---

## D19 - Verify completion authority: one tool call is the verdict, a protocol error is not a verdict

**Decision.**
1. The isolated Verify child reports its verdict through the schema-validated
   tool `aies_verify_complete`, after inspecting the artifact and running the
   checks; the prompt instructs a single call. Exactly one valid completion is
   authoritative, and the parent reads the captured call, never the child's final
   prose, which may be empty or malformed.
2. A missing completion, an invalid-only sequence or a second valid completion is
   a `protocol_error`, its own fact with codes `missing_completion |
   invalid_completion | duplicate_completion | session_failure`. It carries no
   domain status and is never read as `pass`, `fail` or `blocked`.
3. A captured verdict survives a later prose or provider-continuation failure:
   the completion, not the stream, is the authority.
4. A protocol error consumes one verification attempt, spends zero repair budget,
   sets the verification status `protocol_error` (footer indicator `V:ERROR`), and
   `planVerification` stops the loop without an automatic retry.
5. A `pass` is still validated host-side: it must represent and pass every supplied
   criterion, each with its own non-empty evidence, and it must not carry a
   blocking defect. The completion tool rejects an invalid attempt so the child may
   correct it once in the same turn, while a second valid completion is a protocol
   error.

**Why.** The AIES-010B baseline reproduced the failure this decision removes: on
`EZE-422`, Verify's substantive evidence passed, but malformed final JSON was
converted into a domain `blocked` verdict and retried three times. Treating a
handoff failure as a verdict fabricates a domain signal from a protocol fault,
and retrying a malformed completion burns budget on a formatting problem. Making
one validated tool call the sole authority, and giving a handoff failure its own
non-domain fact, keeps PASS/FAIL/BLOCKED honest and stops the loop instead of
mislabeling it.

**Consequence.** A protocol fault surfaces to the human as `V:ERROR` /
`error de protocolo`; the parent does not retry automatically and must fix the
Verify configuration or re-delegate the verification. `pass`, `fail` and
`blocked` keep their existing meaning, evidence rules and repair budget. This
supersedes the D11 rule that a PASS without evidence is downgraded to `blocked`:
a PASS without evidence is now rejected as an `invalid_completion` protocol
error, never silently turned into a different domain verdict.

---

## D20 - Agent Observatory: an ephemeral registry with real child usage and a Main/Agents/Total that cannot double count (AIES-010C)

**Decision.**
1. `extensions/aies-agents/observatory.ts` is a session-local registry that
   observes the existing Explore, Worker and Verify children. It is **ephemeral
   presentation state, not agent orchestration**: pure (no Pi import, no
   filesystem, no clock of its own), no persistence and no authority. It never
   routes, authorizes, persists, retries or changes a child's prompt, and it holds
   no transcript and no reasoning.
2. A record carries a stable `<role>-<ordinal>` id, the lifecycle `status`
   (`running`, `completed`, `failed`, `blocked`), caller-supplied `startedAt` /
   `finishedAt`, the resolved model and provider identity, a bounded ring of the
   last 5 mechanically worded Spanish activity events (`Leyendo`, `Buscando`,
   `Editando`, `Ejecutando`, `Comprobando`), `changedPaths`, `toolCount`, a
   compact `result` and the child's real `totalTokens` / `cost`.
3. Wiring: `session.ts` attaches exactly one event-driven `session.subscribe`
   listener per observed child. Tool starts become mechanical activities, and
   `turn_end` / `agent_settled` / `agent_end` sample the public `SessionStats`
   (`tokens.total`, `cost`). `explore.ts`, `worker.ts` and `verify.ts` each open
   and close exactly one record in a `finally`, so a record exists even when the
   child throws. `delegate.ts` passes the singleton and a provider display label.
   Handoff shapes, prompts, tool surfaces and routing are unchanged.
4. Telemetry: `extensions/aies-runtime/usage.ts` reduces usage into three buckets
   with `aggregateUsage`. **Main** is the Parent usage since the run baseline;
   **Agents** is the sum of the registry's child records; **Total** is
   `main + agents`, counted once. An unknown cost is `null` and is never
   estimated, and any included bucket with an unknown cost makes the aggregate
   cost `null` too.
5. Parent usage is read from the session's own assistant `usage` records, reduced
   incrementally (each entry is read once and the cache is reset on
   `session_start`); the first sample after a run start becomes the baseline.
   Child usage is sampled from the child's own `SessionStats` before disposal.
   Children are isolated in-memory sessions (`noExtensions: true`), the Parent
   session's entries never contain child usage and `aies_delegate` returns no
   nested `usage` field, so Main excludes children by construction and the Total
   adds each token exactly once.
6. The `agents` projection is ephemeral end to end: `toSnapshot` never writes it
   and `fromSnapshot` never reads it, so a resume or `/fork` starts with an empty
   registry and cannot resurrect a finished child as live.
7. The registry crosses the extension boundary on Pi's documented `pi.events`
   bus. Pi loads each extension through its own jiti instance
   (`moduleCache: false`), so the `observatory` singleton is **not** shared
   between `aies-agents` and `aies-runtime`. `aies-agents` re-publishes every
   registry mutation on the stable `aies:agents` channel; `aies-runtime` consumes
   it, folds it through `applyAgents` and repaints once. An absent bus or a silent
   publisher leaves the projection empty; it never crashes the runtime.

**Why.** AIES-010 and AIES-010B made the workflow legible but left the run opaque
at two points: it could not answer "which agents ran and what did they cost", and
a child's own identity and cost were unobservable while the finished card lingered
on a TTL. Reading the child session's own public usage at its
own lifecycle boundaries is the only measurement that is real instead of
estimated, and doing it in a registry that has no authority keeps a presentation
phase from becoming a second workflow engine. Keeping the projection out of the
persisted snapshot is what stops a `/resume` from fabricating a live child that no
longer exists.

**Consequence.** The status panel, the mini agents widget, `/agents`,
`/aies-status` and the compact DONE card all read this registry, and the child
model, token count and cost are now visible without inventing a value. Because Pi
loads each extension through its own jiti instance, the projection reaches the
runtime only over the `aies:agents` event channel: a silent publisher leaves it
empty rather than failing the run. No behavioural authority changes: routing,
verification, permissions, sandbox, Context Governor thresholds, Linear policy,
autonomy and the repair budget keep their semantics. This refines D8's
consequence that "measuring subagent activity is a separate phase's problem": it
is now that phase, resolved without touching the Parent counters. It refines D16
item 2 by adding the surfaces the registry feeds, and it supersedes the D16 item 5
rule that a finished child's widget expires after a 60 second TTL. Detailed
reference: `docs/UX.md` §6 and §15.

---

## D21 - Presentation shell refinements: a status panel, one identity glyph, one durable entry, and quiet generic tools (AIES-010C)

**Decision.**
1. The status panel is a persistent widget below the editor
   (`ctx.ui.setWidget(PANEL_KEY, factory, { placement: "belowEditor" })`), not
   `ctx.ui.setHeader`: Pi's header is the startup header and scrolls out of view.
   From `100` columns the panel is a borderless block of at most 4 lines, each at
   most `72` columns wide; from `72` to `99` columns it is a single-column box of
   at most 6 lines (4 body rows plus the top and bottom borders) at most `72`
   columns wide; below `72` columns it renders nothing. The startup ticket header
   renders no lines while the panel is visible, so the two never duplicate a fact.
   The panel is not a sidebar: it steals no editor width and holds no state.
2. The footer renders its minimal form while the panel is visible (identity,
   ticket, stage, context and alarms) and the rich footer returns when it is not,
   so the human is never told the same fact twice. The documented drop order
   (model -> cwd -> `V:PASS` -> `AUTO` -> stage -> `ctx`) still applies to the
   rich form; identity, ticket and alarms are never dropped.
3. There is one AIES identity glyph: `✧` in the footer, the panel title and the
   ticket header. The retired `❈` is gone.
4. One durable transcript entry per finished child, and the live card clears as
   soon as the child finishes: the AIES-010B finished-card TTL is removed, so the
   durable entry is the only remaining trace and duplicated `✓ Worker` rows cannot
   recur. The observatory's mini widget (`aies-agents`) is the second widget and
   clears itself when the registry empties.
5. The six generic tools that carry raw file and shell traffic (`read`, `bash`,
   `grep`, `find`, `edit`, `write`) are re-registered through the documented Pi
   override pattern: `extensions/aies-runtime/quiet-tools.ts` creates one public
   `create*Tool(cwd)` instance per tool, delegates `execute` to it untouched, and
   adds only the `extensions/aies-ui/tools.ts` renderers. The native shell is kept
   (no `renderShell: "self"`), so a failure stays framed by Pi; the collapsed row
   is `› <tool> <target>`, a real error never collapses away, and expanded output
   is the raw bytes plus the real detail facts.
6. `/agents` is one `ctx.ui.custom()` component with arrow navigation and Escape
   and with all index math in the pure `selectAgent`; the compact DONE summary
   replaces the verbose DONE card, and `/aies-status` gains the `Uso` section in
   the human overview plus the per-child observatory rows in `detalle`.
7. The DONE card is edge-triggered on the observed ticket reaching Linear's
   completed state, and autonomy stopping with `completed` shares the same single
   latch, so a run appends exactly one DONE `aies-summary` entry. DONE and BLOCKED
   both go through one publish path: the durable entry is always appended, and its
   headline is sent through `notify` only where the durable card cannot be drawn
   (a non-TUI mode, or a host without entry renderers), so the human never sees
   the same headline twice.

**Why.** The AIES-010B shell showed the ticket and the footer but the run's
headline facts (model, context, elapsed, cost, agents) had no home, and the
footer still carried facts a different surface could show better. Pi's own header
is the startup header, which scrolls out of view once the transcript grows, so a
persistent panel below the editor is the only surface that keeps those facts on
screen; making the footer minimal while it is present removes the repetition
without removing the fallback. The quiet generic
tool rows were deferred in AIES-010 as duplication, but the generic tools are the
ones that flood the transcript with raw traffic, and the documented override
pattern lets AIES change only their drawing while Pi keeps execution and the
native error shell. Removing the TTL is what makes "one durable line per child"
literally true instead of a source of duplicates.

**Consequence.** Fewer always-visible slices of the same fact and more
information on demand, all still rendered by pure functions from one snapshot. No
behavioural authority changes: execution, `content`, `details`, the error flag and
the schemas are untouched, and `mcp` is still not wrapped. This refines D18 item 1
(the full custom footer and the startup header are now a footer, a below-editor
panel and a content-driven fallback) and D18 item 4. It supersedes the D16 item 5
finished-card TTL rule and the D18 item 4 statement that generic Pi tools keep
Pi's rendering and are never wrapped, for the six named tools only. It also
supersedes the D16 item 2 "one widget key" phrasing: the shell now owns three
widget keys, one command view (`/agents`) and the quiet tool registration.
Detailed reference: `docs/UX.md` §3, §5, §6, §12, §13, §17, §18 and §22.

---

## D22 - Linear identity boundary fails closed: a remote issue with no usable identity never mutates state (AIES-010C)

**Decision.**
1. `readIssueIdentity` / `hasUsableIssueIdentity` in
   `extensions/aies-agents/linear/contract.ts` accept only a non-empty `identifier`
   first, then a non-empty `id`. The `uuid` the real MCP projection always carries
   is Linear's internal key, not the human ticket key, so it is never accepted as
   the user-facing identity.
2. Both the load path and the remote-refresh path in `TicketManager` reject an
   identity-less payload **before** `normalizeTicketContract` runs and before any
   state mutation, returning the typed error `invalid_remote_payload`. On a failed
   refresh the active ticket is left unchanged.
3. The collapsed `aies_ticket` row renders `respuesta inválida de Linear`.
4. `no_pending_remote` is documented as the expected stale-replay guard: it occurs
   only after the pending operation was already consumed, and repeating the action
   without `remote` safely re-derives the directive. No transport behaviour changed.

**Why.** The EZE-423 smoke proved the defect was reachable: `performLoad()`
accepted any truthy object and `normalizeTicketContract()` let both `identifier`
and `id` collapse to `undefined` before mutating `activeTicket`, so a truthy MCP
replay carrying neither key activated an identity-less ticket. Accepting the
internal `uuid` to satisfy the type would have hidden the missing human key
exactly the way the bug depended on. Rejecting before normalization is the only
boundary that cannot partially mutate state.

**Consequence.** A malformed remote payload is now a visible, typed failure that
preserves the previous ticket, instead of a silent activation. This refines D14's
normalization and remote-refresh rules (items 3 and 6): the compact contract and
the conflict check are unchanged, but normalization is now preceded by a
fail-closed identity gate. It is the one bounded behaviour change AIES-010C made
to the Linear workflow, and it was proven by the EZE-423 smoke, not inferred.
Detailed reference: `docs/ARCHITECTURE.md` (Linear ticket workflow).

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
