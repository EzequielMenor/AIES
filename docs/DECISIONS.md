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
1. The isolated AIES profile declares `npm:pi-mcp-adapter` in `profile/settings.json` and exactly one MCP server, `linear`, in `profile/mcp-adapter.json`, pointing at `https://mcp.linear.app/mcp` with `auth: "oauth"` and `lifecycle: "lazy"`. Pi installs the declared package into `$AIES_HOME/agent/npm/`; AIES does not fork, vendor, patch or copy the adapter, and does not implement an MCP client.
2. `scripts/seed-profile-config.mjs` selects the config format from the installed adapter version: v2 uses `mcp.json`, while v3+ uses `mcp-adapter.json`. If the adapter is not installed yet, it defaults to v3+. For v3+, legacy servers/settings are merged with destination values taking precedence, the destination is validated, and only then is `mcp.json` removed. The v2 template remains solely for version-aware compatibility.
3. `bin/aies` exports `PI_MCP_CONFIG_MODE=exclusive`, so v3+ reads only `$AIES_HOME/agent/mcp-adapter.json`. Host-global MCP configs (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`) and project-local `.mcp.json` / `.pi/mcp.json` are never merged into an AIES session.
4. The profile sets no `directTools` and sets `settings.scriptMode: false`, so the Linear server's 66 tools stay behind the adapter's proxy surface for that server: the `mcp` gateway plus one `mcp__linear` namespace proxy once its catalog is cached. That is about 3.6 KB of resident definition instead of the roughly 80 KB catalog, and zero resident Linear schemas.
5. AIES owns no MCP transport. Pi exposes no programmatic tool invocation to extensions, so `HostMediatedLinearTransport` never sends a request: it answers from the calls the Parent already performed and otherwise fails with `LinearTransportError("remote_required")` carrying a `LinearRemoteDirective`. `TicketManager` keeps the pending directive and the answers collected for it and replays the interrupted operation over that cache, and `aies_ticket` accepts `remote` to resume it. Replay is pure, because every remote value is an answer the Parent already supplied.
6. OAuth is the primary authentication path. The interactive instruction is `/mcp-auth linear`, which the adapter owns; AIES registers no MCP command of its own. No AIES code path reads, forwards or advertises `LINEAR_API_KEY`.
7. Headless sessions (`print`, `json`, `rpc`) never start an OAuth flow. They report that authentication has to happen in an interactive AIES session.
8. Credentials live in the adapter's OS credential store, keyed by server name and bound to the MCP URL. Nothing is written to the repository or either profile config file. Because the key is the server name plus URL, `aies` and `pi` share one credential record for `linear`; AIES does not have its own credential namespace.
9. Explore, Worker and Verify are created with `noExtensions: true` and explicit tool allowlists, so the adapter, `mcp`, `mcpScript` and every Linear schema are absent from a child session.

**Why.**
- The adapter is the only component that should own MCP transport, OAuth, credential storage and tool registration. Reusing it keeps AIES out of a protocol and a credential store it would otherwise have to get right on its own.
- A hosted MCP server can expose dozens of tools. Registering them directly would spend context on every turn for tools a ticket workflow rarely calls, and the Linear catalog alone is 66 tools.
- Reading host-global or project-local MCP configuration would silently import servers into an AIES session, which breaks the isolation guarantee the whole project rests on.
- Making the Parent perform every remote call keeps one visible, auditable step between AIES policy and Linear, and keeps credentials out of child sessions entirely.
- An extension cannot invoke a tool, so a transport that pretends to call MCP can only ever fail. Declaring the call honestly is the only design that survives contact with the real runtime.

**Consequence.**
- A Linear operation the Parent has not answered yet costs an extra tool round trip, and a multi-call operation like `complete` costs one per missing call. The alternative was a fabricated success.
- `LINEAR_API_KEY` is no longer a supported path in AIES code. A bearer token remains an explicit opt-out configured in the active adapter config (`mcp-adapter.json` on v3+, `mcp.json` on v2; `auth: "bearer"`, `bearerTokenEnv: "LINEAR_API_KEY"`), which the user owns and AIES never reads.
- The repository is the source of truth for the declared package and server; the version-appropriate profile config is the runtime file Pi and the adapter own.

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
5. The adapter's quiet result mode is pinned in `profile/mcp-adapter.json`
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


## D23 - Fullscreen is Pi-owned; AIES uses a fixed status dock, not a private sidebar (AIES-010D)

**Decision.**
1. The isolated profile sets Pi 0.85.1's documented `tuiMode: "fullscreen"`,
   `fullscreenExitOutput: "resume-hint"`, `fullscreenScrollbar: "auto"`,
   `quietStartup: true` and `hideThinkingBlock: true`. Pi owns alternate-screen
   entry, transcript scrolling, resize, Ctrl+C/exit teardown and terminal
   restoration. AIES emits no ANSI and performs no manual clear.
2. AIES does not copy gentle-pi 3.2.1's responsive right rail. That rail patches
   Pi's layout tree through the experimental private symbol
   `Symbol.for("@earendil-works/pi-tui/layout-node")`; no public passive sidebar
   primitive exists in Pi 0.85.1. The supported approximation remains the fixed
   `belowEditor` widget, full at 120+ columns, compact at 80–119 and absent below
   80. It is documented as a status dock, never presented as a real sidebar.
3. The full dock is bounded to 96 columns and six lines; the compact dock to 72
   columns and seven lines. Both carry identity/ticket/stage, model/provider,
   context, elapsed time, measured Main/Agents/Total usage and at most two agent
   facts when those values exist. Below 80 columns the rich one-line footer is the
   fallback; while the dock exists the footer is minimal and non-duplicative.
4. The standalone `aies-agents` widget is removed. Its bounded mini-overview now
   lives in the status dock; the live `aies-activity` card and selectable
   `/agents` registry view remain unchanged.
5. The six quiet generic tool overrides set the public `renderShell: "self"`.
   Execution, schema, result bytes and Pi's expansion state remain unchanged;
   AIES owns the compact success/error projection, so routine success has no
   large colored shell and failures remain red with real detail.
6. The identity extension no longer emits a startup profile notification.
   `/aies-info` remains the explicit isolation diagnostic. Thinking visibility is
   controlled only by Pi's public setting; no reasoning is intercepted.

**Why.** AIES-010C improved information density but regular TUI mode still left
shell history and bootstrap chrome around the product, and the generic-tool
success shell still dominated the transcript. The exact gentle-pi 3.2.1 audit
showed that the desired right rail is not available at AIES's public API boundary.
Native fullscreen provides the material product change without forking Pi; a
bounded fixed dock preserves hierarchy without pretending an internal patch is a
supported integration.

**Consequence.** AIES launches as a clean fullscreen application and restores the
previous terminal screen on exit, while headless modes keep their previous
behavior. The dock, live child card, `/agents`, compact transcript entries and
rich narrow footer now form one responsive hierarchy. This supersedes D21 items
1–2 (breakpoints/layout), item 4's standalone `aies-agents` widget, item 5's
native tool shell, and the consequence that named three widget keys. D1 and D16
remain intact: Pi is still the runtime, every UI surface remains a projection,
and no private Pi import or renderer was added. Detailed reference:
`docs/UX.md` §2, §3, §5, §6, §17, §18, §19 and §22.

---

## D24 - One user-authorized, version-guarded private shim for the optional right rail (AIES-010D)

**Decision.**
1. The Pi 0.86.1 re-audit confirmed result B: Pi still exposes no public passive
   side-rail primitive. `ExtensionWidgetOptions.placement` is limited to
   `aboveEditor | belowEditor`, `ExtensionUIContext` has no root-composition or
   sidebar API, and the host keeps its fullscreen layout tree behind the private
   symbol `Symbol.for("@earendil-works/pi-tui/layout-node")`. The below-editor
   status dock therefore remains the supported status surface.
2. With explicit user authorization, AIES adds exactly one isolated private
   compatibility module, `extensions/aies-ui/right-rail.ts`, to present an
   optional physical right rail at `140` columns or more on a fullscreen host. It
   is the only place in AIES that reads the private layout symbol. It wraps the
   layout node the host already exposes on its own TUI instance, delegates the
   transcript side to the original node, and restores the exact descriptor on
   dispose. It never patches Pi, gentle-pi or `node_modules`.
3. The shim is version-guarded to the Pi minor families actually audited (`0.85`
   and `0.86`) and activates only in fullscreen. Every other version, mode,
   missing hook, throwing render or empty render is a fail-safe no-op that
   delegates to the host, so the below-editor dock and the rich narrow footer stay
   the fallback and no failure can leave the human with no status surface.
4. The rail reuses the dock's labelled facts and adds project and git branch,
   capped at 46 columns of content. While the rail is showing at or above the
   breakpoint the dock yields; everywhere else the dock renders as before.
5. Pi keeps sole ownership of the fullscreen lifecycle: alternate-screen entry,
   transcript scrolling, resize, Ctrl+C/exit teardown and terminal restoration.
   AIES emits no ANSI and performs no manual clear. No global installation
   changes: nothing outside the AIES profile and repository is written, and
   `~/.pi`, `~/.agents` and `node_modules` are untouched.

**Why.** The requested right rail is a real product improvement, but it is not a
supported Pi integration: it depends on a private, experimental symbol that can
change without notice. Refusing it entirely would leave a visual gap the user
explicitly authorized closing; copying Gentle's rail as if it were public would be
dishonest about the boundary. One isolated shim, guarded by version, bounded in
scope, with the current dock as an unconditional fallback, is the narrowest way to
gain the rail without pretending the internal is stable or scattering the
dependency across the codebase.

**Consequence.** AIES gains an optional physical rail without a public API it
does not have and without a global modification. This is deliberate technical
debt: it must be re-audited before trusting on every Pi minor or major bump and
removed as soon as Pi exposes a public passive side-rail primitive, or sooner if
the private hook can no longer be maintained safely. Until removal, the
below-editor dock is the contract and the rail is a bounded enhancement. This
supersedes D23 item 2 and refines D23's consequence that "no private Pi import or
renderer was added": one private read now exists, in one module, under the guard
above. Pi remains the runtime and every surface remains a projection. No visual
acceptance is claimed here: the real wide `IDLE`/`WORKER`/`VERIFY`/`DONE` states,
the narrow layout, scrollback isolation and `/exit`/Ctrl+C restoration remain
T9's to validate.

**T9 correction (120, not 140).** The original breakpoint above is corrected:
the physical rail presents from `120` real terminal columns, not `140`. The
product contract is one breakpoint per tier — `>=120` rail, `80`–`119` compact
below-editor dock, `<80` rich footer — and a supported host that cannot install
the rail keeps the full dock from `120` as the fallback. The rail's own `46`
content columns plus the `2`-column gap are unchanged, so `237` terminal columns
still leave `189` for the transcript. This correction is appended rather than
rewriting the entry above, per the append-only decision history. The T9 visual
acceptance remains open and is not claimed here.

**0.87.0 re-audit correction (feature detection, not an allow-list).** Pi was
updated from `0.86.1` to `0.87.0` on this machine, and AIES then stopped showing
its physical right rail and fell back to the below-editor dock, on the same host
where Gentle AI kept its sidebar. The root cause was the shim's own guard, not a
Pi layout change: `extensions/aies-ui/right-rail.ts` gated installation on
`SUPPORTED_PI_MINORS = {0.85, 0.86}` and returned a no-op handle before it ever
inspected the host, so the designed dock fallback took over. The measured audit
found Pi's private layout shape effectively identical across `0.85.1` → `0.87.0`:
`pi-tui`'s `dist/layout-node.js` and `dist/layout-node.d.ts` are identical
(`StackLayoutNode { type: "vstack" | "hstack", entries, gap, align }`),
`dist/layout.js` is byte-identical (MD5 `624eed4a0131380c109222c24abce831`),
`layoutRoot` is referenced identically in both versions and keeps the same
`this.layoutRoot ?? this.implicitScrollView` semantics, and the only real
`tui-alt-screen.js` diffs are clipboard-error flash text, scroll-to-end label
centering and WezTerm Kitty row clearing. The fullscreen sticky dock arrived in
Pi `0.84.0`, already inside the audited range. All three commands run the same
Pi `0.87.0`: global `pi` is `0.87.0`, `aies` execs that binary
(`aies --aies-info` → `pi_version=0.87.0`) and `extensions/aies-runtime/index.ts`
reads the host's own `VERSION`, and Gentle is a Pi *package* in the same global
`0.87.0` (`~/.pi/agent/settings.json` → `lastChangelogVersion: "0.87.0"`) whose
pinned `@earendil-works/pi-tui@0.85.1` is only a library import for
`ScrollView`/`VStack`, never the host runtime. Gentle's working sidebar therefore
proves the internals still exist. The public-API re-audit on `0.87.0` still finds
no passive side-rail: `setWidget` placement is still
`aboveEditor | belowEditor`, `layoutRoot` is declared `private`, and
`LAYOUT_NODE`/`getLayoutNode` are not exported from `pi-tui`'s index;
`setLayoutRoot()` is public but *replaces* the root, so it is not a migration
target and the single shim stays. The gate is corrected: `AUDITED_PI_MINORS
{0.85, 0.86, 0.87}` now only documents what was hand-audited,
`piVersionMayAttemptRail()` is a fail-closed floor (anything parseable at or
above `0.85` may attempt the rail; below `0.85` or unparseable never does), and
`isRecognizedStackLayoutNode()` lazily probes the host's own layout node once,
inside a layout pass and never at install time, accepting only the audited stack
vocabulary. A rejection or a throw latches the shim off permanently and delegates
to the host, so an unverified future Pi self-heals when the shape still matches
and fails closed when it does not, with the below-editor dock and the narrow
footer as the fallback. The fallback tiers, the `46`-column content width, the
`hstack` entry shape, `showing()` as the dock's sole yield signal, the exact
descriptor restore on `dispose()` and the removal condition (delete the shim once
Pi exposes a public passive side-rail) are unchanged. This correction supersedes
D24 item 3 and the guard detail in D25 item 8, both of which state the retired
`0.85`/`0.86` allow-list; those entries are left as written history. This
correction is appended rather than rewriting the entry above, per the append-only
decision history.

**Dead-code correction (2026-09-21).** The audited-minor set was subsequently
reduced to prose in the shim's header comment and the `isSupportedPiVersion()` /
`AUDITED_PI_MINORS` symbols were deleted as dead code — the floor already admits
every minor they listed — so D25 item 8's retired guard wording is now superseded
by that prose as well.

Detailed reference: `docs/UX.md` §2, §3, §5, §6, §17, §18 and §19.

---

## D25 - Final shell, theme and role model preferences: one theme-backed shell, run-local Todos, and a registry-backed `/aies-models` (AIES-010D)

**Decision.**
1. The fullscreen shell keeps one responsive hierarchy owned by `aies-runtime`:
   `>= 120` columns on a supported fullscreen host shows the optional physical
   rail (`Status` > active `Agents` > `Todos`); with no rail the full below-editor
   dock renders from `120`; `80`–`119` shows the compact dock with a bounded
   `Todos · n/m` row; below `80` no dock renders and the rich one-line footer plus
   the responsive ticket header are the identity surface. While a dock or rail is
   visible the ticket header stays quiet and the footer is minimal, so no fact is
   drawn twice. The compact dock is at most 8 lines including the Todos row.
2. Live child activity has exactly one owner per width: while the rail is showing
   it owns the live child and the inline `aies-activity` card is suppressed;
   wherever the rail is unavailable the inline card is the fallback, and a
   finished child still leaves exactly one durable transcript line.
3. Todos are a run-local, ephemeral projection of state AIES already measures.
   They are derived, bounded, lower priority than `Status` and active agents,
   never persisted and never authored by the model, and collapse to `Todos · n/m`
   before an active agent row is lost.
4. The profile-local `aies` theme (`themes/aies.json`, selected by
   `profile/settings.json`) is the single visual vocabulary for the rail, dock,
   `/agents`, summaries and footer; it is loaded through Pi's supported theme
   mechanism and AIES ships no hardcoded ANSI.
5. `/aies-models` lists only `ctx.modelRegistry.getAvailable()` models, offers
   only the thinking levels each model's `thinkingLevelMap` supports (never
   clamping an unsupported level), and persists the Parent default through Pi's
   isolated `SettingsManager` and each child role into the isolated `aies.json`.
   A saved preference applies to the next child, never to an active one.
6. `bootstrap-profile.sh` seeds only `profile/settings.json`, once;
   `profile/aies.json` is deliberately not copied. A fresh profile starts from
   built-in defaults and Pi creates its own `aies.json` only after a user saves a
   child role.
7. DONE and BLOCKED stay deterministic and runtime-owned: exactly one durable
   entry each, from one publish path, never a Parent-authored second summary.
8. The single private seam is unchanged and still the only non-public Pi access:
   `extensions/aies-ui/right-rail.ts`, guarded to Pi `0.85`/`0.86` and fail-safe
   on every miss.

**Why.** AIES-010C left three gaps: the wide live-child card duplicated the rail's
activity section, the run had no compact visible plan, and model/effort choice had
no supported surface at all. A single theme-backed vocabulary, a derived checklist
with no authority, and a registry-backed picker close those gaps without adding
routing, persistence or a second renderer. Keeping the Todo projection out of
persistence and out of the model is what stops a presentation phase from becoming
a task store.

**Consequence.** The shell shows the same run at three widths without repeating a
fact, the rail owns the live child where it exists, and role models and effort are
configurable from the registry alone. This records no new architecture or product
beyond the implemented T10–T12 work: routing, verification, permissions, sandbox,
Context Governor thresholds, Linear policy and the repair budget keep their
semantics.

**Supersedes D24's activation detail.** D24's `140`-column rail activation and its
appended T9 correction are obsolete: the contract in force is one breakpoint per
tier — `>=120` rail, `80`–`119` compact dock, `<80` rich footer. D24's core
decision (one user-authorized, version-guarded private shim, with the below-editor
dock as the unconditional fallback) and its technical-debt condition stand
unchanged: the shim must be re-audited on every Pi minor or major bump and removed
once Pi exposes a public passive side-rail primitive, or sooner if it can no longer
be maintained safely. Real visual acceptance remains T14's and is not claimed
here. Detailed reference: `docs/UX.md` §2, §3, §5, §6, §14, §15, §16 and §19.

---

## D26 - Command Code as an AIES provider: a committed static catalog, not a runtime fetch

**Decision.** AIES ships `extensions/aies-provider-commandcode/`: one
`pi.registerProvider("commandcode", …)` call, one committed `models.json` with the
76 models the provider API serves, and `apiKey: "$COMMANDCODE_API_KEY"`. Pi may
fetch a provider catalog inside the extension factory; AIES does not. The catalog
is regenerated by hand with `scripts/refresh-commandcode-models.mjs`, which is the
only Command Code artifact that touches the network and is never wired into the
launcher, `npm test` or `scripts/check-isolation.sh`. The per-model `api` override
carries both wire protocols in one provider: `anthropic-messages` for the eight
models the endpoint serves only on `/messages`, `openai-completions` for the rest.
A malformed or missing catalog degrades to "provider not registered" with one
load-time diagnostic; it never breaks the rest of the profile.

**Why.** A runtime fetch would make every `aies` start depend on a third-party
endpoint and would contradict the determinism the isolation checks assert
(zero network, zero credentials). Static also means the reviewed file is exactly
what the model pickers show. The prices stored are the base list rates from the
GOAT plan page, not the promotional ones, because a deal expires and a cost model
that silently changes under a session is worse than a conservative one; the two
free models have no published list rate and stay at `0`. `maxTokens` is a
documented derivation (`clamp(floor(contextWindow / 4), 8192, 64000)`) because
neither the endpoint nor the docs state an output cap.

**Consequence.** `commandcode/*` models appear in `/model`, `/aies-models` and
`aies --list-models` as soon as auth is configured — without it Pi loads the
catalog but keeps the models unavailable, which is expected behaviour and is
documented. A stored credential written by `/login commandcode` owns the provider
and takes precedence over `$COMMANDCODE_API_KEY`, which remains the CI, headless
and testing path; with no credential the zero-model state is no longer invisible,
because `/aies-models` reports the provider as disconnected (`0/76`). Refreshing
the catalog is a deliberate, reviewable diff in version control, and the generator
prints what it could not match instead of inventing values (e.g. `gpt-6-astra` is
advertised on the plan page but not served by the API, so it stays out).

The `maxTokens` derivation proved wrong for at least one model: a live smoke of
`poolside/laguna-s-2.1-free` failed with an HTTP 400 naming the real cap
(`max_tokens (64000): Input should be less than or equal to 32768`). Rather than
lower the global clamp, which would needlessly degrade the models that genuinely
accept 64000, the generator carries a measured `MAX_TOKEN_OVERRIDES` map so a
regeneration keeps the observed `32768` instead of silently reverting to a value
the API rejects.

---

## D27 - Provider credential health: availability is presence, so AIES records rejection evidence (EZE-453)

**Decision.** AIES adds `extensions/aies-providers/` as the only owner of provider
credential health. Pi's availability predicate tests credential *presence* only and
never validates it, so a present-but-wrong key still advertises its models
(measured on Pi 0.87.0: a dummy `ANTHROPIC_API_KEY` yields 14 "available" anthropic
models). Availability is therefore not evidence that a credential works. The only
sound runtime signal that a credential was *rejected* is the failed turn: Pi fires
neither `after_provider_response` nor `error` on an HTTP 401, but `turn_end` fires
with `message.stopReason === "error"` and the provider body in
`message.errorMessage`. AIES classifies that failure with a pure classifier and
persists one record per provider under the `providerHealth` key of the isolated
`$PI_CODING_AGENT_DIR/aies.json`. The record stores a truncated SHA-256 digest of
the credential, never the secret, so a re-login changes the digest and the record
self-heals. The policy is `connected + credential usable -> selectable`;
`disconnected` or `rejected -> not selectable`. The rule is **fail-open**: when
the current credential cannot be resolved, AIES records nothing and never
suppresses a provider on stale evidence. The classification is deliberately narrow
— 401/403 and explicit authentication/authorization tokens only, never rate
limits, 5xx, network faults or aborts.

**Why.** A provider AIES cannot trust must not present itself as usable, and
availability cannot answer that because it only proves a credential exists.
Waiting for a real failing request is the only observation point Pi exposes, so the
smallest honest design is a passive observer that records what the runtime already
learned, keyed by the credential's digest so the evidence expires by itself.
Storing a digest instead of the secret is what lets the record heal without ever
holding sensitive material: a fresh `/login` makes the old rejection stop applying.

**Consequence.** This is generic and names no provider, so Anthropic is not
special-cased; any provider that rejects a 401/403 the same way is covered. The
cost is that a rejection is only known after one real failing request — AIES adds
no probe, no startup work, no network and no command. `/aies-models` and
`/aies-commandcode` read the record to mark a provider `credencial rechazada`
instead of offering its models.

---

## D28 - `/aies-models` becomes provider-first, searchable and scope-aware (EZE-453)

**Decision.** `/aies-models` no longer presents a flat model list. It projects the
registry into a provider-first flow — `role -> provider -> model -> thinking` — the
model step has live type-ahead search, the role step shows each role's current
assignment, and `Tab` toggles Pi's `all`/`scoped` model scope. The measured
universe on Pi 0.87.0 is 41 providers and roughly 1600 models in `getAll()` against
2–3 in `getAvailable()`, so a flat alphabetical list is unusable and enumerating
every disconnected vendor is noise. The picker therefore lists usable providers
with their model counts and collapses the non-selectable set to one bounded
overlay line scoped to rejected providers plus extension-registered providers,
while the headless report keeps the detailed block because it is the diagnostic
surface and costs no screen rows. Search and the `all`/`scoped` toggle
deliberately mirror Pi's own `/model` selector so the two surfaces feel alike: a
byte that matches no keybinding action becomes search text in the model step, so
`j`/`k`/`h`/`l`/`q` stop being navigation aliases there. The matcher stays pure and
local because `@earendil-works/pi-tui` is not installed in this repository.

**Why.** The provider step is what makes a catalogue that can hold ~95 selectable
models (76 of them CommandCode) navigable: the user chooses a vendor before a
model instead of scrolling past it. Mirroring Pi's selector is deliberate
consistency — the `all`/`scoped` rule, the search behaviour and the search haystack
(`provider provider/id provider id name`) all come from Pi, so the AIES picker
ranks and toggles the same way the host picker does. Implementing the matcher
locally is the price of keeping the overlay host-free: the alternative is an
untestable dependency AIES does not have.

**Consequence.** The overlay state machine stays host-free and deterministically
testable, at the cost of not reusing Pi's `fuzzyFilter`. The non-selectable
providers no longer drown the signal: the overlay collapses them to one bounded
line (`2 providers no utilizables · anthropic (401), llama.cpp`) while the headless
report keeps the per-provider detail. Role assignments are read, never written, by
the picker: Parent comes from the live session model; Explore, Worker and Verify
come from the persisted `aies.json` preferences. This supersedes D25 item 5, which
described a flat `getAvailable()` list and never showed an unselectable provider.

---

## D29 - Child provider handoff and strict role-model resolution (EZE-454)

**Decision.** Explore, Worker and Verify keep `noExtensions: true` and
`noSkills: true`, but they no longer fail on a provider the parent only knows
through an extension. The parent delegates through its public `ModelRegistry`
facade; when that facade exposes a registered provider config for the selected
child model's provider, `executeChildSession` builds the child an isolated public
`ModelRuntime` from the child's own `agentDir` `auth.json` and `models.json` and
copies that one provider registration. A genuine session `ModelRuntime` passed by
a caller is forwarded untouched, and a facade with no registered config for the
provider keeps Pi's default child runtime, so built-in and `models.json`
providers are unaffected.

Resolution stays ordered env > `aies.json` > parent model, but an *explicit*
source wins or faults: if `AIES_<ROLE>_MODEL` or `aies.json`
(`agents.<role>.model`) names a model the registry cannot resolve, resolution
throws `AgentModelResolutionError`; Explore and Worker return a failed handoff
and Verify returns a `session_failure` protocol fault. It never silently
substitutes the parent model. The parent-model fallback is reserved for the case
where no source configures a role model.

**Why.** EZE-453 introduced the first extension-registered provider (CommandCode)
and exposed the gap: the facade is a resolution source, not a runtime, so the
child was created without it; because child extensions are intentionally off, the
child runtime never registered the provider and the model it was handed could not
authenticate. Copying only the selected provider keeps the isolation contract — no
provider extension and no skill loads — while making the configured child model
usable. Failing loudly on an explicit but unresolvable model is the other half of
the same contract: a delegation that cannot run the configured model must be a
visible fault, never a silent run on the parent model, because the parent's
context and authorization assumptions differ from the child's.

**Consequence.** Stored credentials remain readable through the isolated
`agentDir` auth file, so the ordinary `/login` path works for child sessions with
no environment variable. A misconfigured `AIES_<ROLE>_MODEL` or `aies.json` now
surfaces as an explicit failed delegation instead of a working run on the parent
model. This closes the EZE-454 root cause recorded in EZE-453's evidence.

---

## D30 - Cross-repo ticket guard: the Linear project against the session git toplevel (EZE-489)

**Decision.** The ticket contract keeps no repository or workspace field, and
D14 is deliberate about that: Linear is the source of truth for the work unit,
never for repo context, so no ticket payload is ever asked to name a checkout.
The reliable offline signal is therefore the ticket's **Linear project name**
compared with the **git toplevel of the Parent session cwd**, evaluated by
`extensions/aies-agents/repo-guard.ts` on every `tool_call`:

1. The effective root of `ctx.cwd` is `git rev-parse --show-toplevel` (no shell,
   realpath when readable), falling back to the realpath of the cwd; the identity
   is cached per cwd because the hook sees every tool call.
2. Names are compared normalized: lowercase with spaces, `-`, `_` and `.` removed
   (`Mi-Porfolio` and `miporfolio` are the same repository).
3. A ticket with **no project** is `unknown` and never blocks, so project-less
   tickets keep working exactly as before.
4. An optional explicit binding table `repos` in `$PI_CODING_AGENT_DIR/aies.json`
   (e.g. `{"repos": {"AIES": "/abs/path/to/AIES"}}`) matches the raw project name
   or its normalized form and compares realpaths instead of names, case-insensitive
   on macOS. This is the zero-false-positive path and it is what names the correct
   cwd in the message. No machine-specific absolute path is committed: the
   repository template `profile/aies.json` ships without a `repos` key.
5. The `repos` binding stays the primary, deterministic source of the expected
   root. When no binding resolves, the message enrichment falls back to a search
   bounded to two levels under the parent of the actual toplevel: the direct
   children of that parent together with the children of those children, both levels
   always enumerated and unioned by realpath (the EZE-488 shape, where the expected
   repo sits one level deeper than the wrong cwd). A candidate is a directory whose normalized basename equals
   the normalized project name and that contains `.git`; non-directories, dotfiles,
   `node_modules` and `.git` are skipped and at most 500 entries are read per
   directory. Resolution requires uniqueness: zero candidates or more than one leave
   the root unresolved, so an ambiguous filesystem can never produce a fabricated
   path, and the message then only names the binding to add. The resolved root is a
   realpath. That lookup is message-only and can never change the decision.
6. `AIES_ALLOW_REPO_MISMATCH=1` disables the guard. It is an explicit decision
   escape hatch, not a prompt-level instruction.

The blocked surface under a real mismatch is the mutation surface: `aies_delegate`
with role `worker` or `verify`, `aies_ticket` with action `start`, `edit`,
`write`, and `bash` whenever `checkCommandPolicy(command, effectiveRoot, "verify")`
does not allow it — plus one local rule, because the shared policy does not carry
it: a mutating `git branch <name>` is a mutation, while a bare `git branch`, `-l`,
`--list` and `--show-current` stay read-only. `aies_ticket` `load`, `show`,
`block`, `comment` and `refresh` are never blocked, and **`explore` stays
allowed**: reading the other repository is precisely the diagnosis a mismatch
needs. The block reason is Spanish (D18) with paths, commands, repo names and
ticket identifiers verbatim; it names the ticket, both repositories, the actual
root, states that nothing was delegated and no file was modified, gives the
relaunch command, and quotes the override variable.

**Why.** EZE-488 dogfooding proved the hole: a session launched in
`Mi-Porfolio` held an AIES ticket, Explore read AIES by absolute path, the Worker
was correctly contained to the wrong root and blocked, and the Parent then
implemented directly in AIES — creating a branch and editing files — with no
protection at all. Containment alone was not enough because every child inherits
the Parent cwd (`delegate.ts` passes `cwd: ctx.cwd`), so a wrong session root
propagates: the guard has to run before any work unit starts, in the Parent, and
it has to fail closed on mutation while keeping read access and diagnostics open.
A name comparison against a path field in the ticket was rejected because it would
contradict D14 and would need every ticket edited; a purely prompt-based
instruction was rejected because the defect was exactly a Parent ignoring
instructions while nothing enforced them.

**Consequence.** A mismatched session costs one blocked tool call and an
executable relaunch instruction instead of a wrong-repository branch, so the
recovery is a new session in the right workspace rather than a manual cleanup.
Sessions without an active ticket pay nothing (the guard short-circuits before any
`git` resolution), and the check is cached per cwd. The override is now the only
way to work a foreign ticket in place, and it is a deliberate, visible
environment variable rather than an implicit tolerance.

---

## D31 - Stale-runtime guard: Verify fails fast when startup modules changed (EZE-492)

**Decision.** Pi loads every AIES extension module once, at process start, through
its own jiti instance with `moduleCache:false` (docs/ARCHITECTURE.md), so the set of
loaded modules is frozen for the process lifetime; and `executeChildSession`
(`session.ts`) creates each child — Explore, Worker, Verify — **in-process** via
`createAgentSession`, never as a separate OS process. A Verify child launched after
the Parent edited an `extensions/*.ts` file therefore runs the already-imported
(stale) module code while the working tree already holds the fix. `extensions/aies-
agents/runtime-freshness.ts` detects this and the Verify branch of `delegate.ts`
fails fast before spawning the child:

1. The runtime-loaded set is the module files (`\.ts|tsx|js|jsx|mjs|cjs`) under the
   AIES `extensions/` tree, resolved from this module's own `import.meta.url` through
   `realpathSync` (so the `$AIES_HOME` symlink maps to the real repo and the check is
   independent of the session cwd, since AIES also runs on other repositories), plus
   one explicit non-module resource: `extensions/aies-provider-commandcode/models.json`,
   which is read once at startup by `loadCommandCodeCatalog` (`readFileSync`) before
   `registerProvider()`. It is tracked through an allowlist, not a generic `.json`
   match, so it stays runtime-loaded like a module while docs, tests, READMEs and
   prompts are still ignored.
2. The baseline is the process start, `Math.round(Date.now() - process.uptime() *
   1000)`; a module file is stale when its `mtimeMs` is **strictly later** than that
   baseline. A freshly launched process is always clean.
3. When any file is stale, the Verify delegation returns `status: "blocked"`,
   `error: "stale_runtime"` and a Spanish, fail-fast message (D18) that names the
   stale modules, explains that a same-process PASS would prove the OLD code rather
   than the working tree, and instructs to exit AIES and relaunch (`aies`) before
   re-delegating. The Explore and Worker branches are untouched; there is **no
   environment-variable override**, because the invariant is deliberate.
4. Only `extensions/` counts. `Agents/*.md` prompts are re-read per delegation
   (`readFileSync` in `session.ts`), and docs, tests and scripts are never
   runtime-loaded, so a change to them does not block a verification.

**Rejected alternatives.** Hot reload / module-cache invalidation was rejected: it
reopens the exact failure mode (a half-reloaded runtime whose mutual state is
undefined), fights Pi's fixed module set, and cannot safely re-bind already-
registered tools. An auto-restart of the whole session was rejected as
surprising and outside the launcher contract. A declarative `changedPaths` scoping
(warn only when the edit touches a module the delegation depends on) was rejected
because no reliable per-module dependency graph exists here and an under-estimate
reintroduces silent stale evidence. All of them trade a rare, honest block for a
common, incorrect PASS.

**Consequence.** An extension edit mid-session now requires relaunching AIES before
any Verify can be accepted; that is the intended, visible cost, and it replaces the
EZE-488 failure mode in which a stale runtime produced a misleading PASS that looked
like real verification. Checks that run in fresh subprocesses (for example
`npm test`, which spawns its own `node --test`) keep their own module set and are
never affected, so the Worker's own test evidence stays valid inside the same
session.

---

## D32 - Pending final action: an explicit user hold outranks Verify PASS (EZE-503)

**Decision.** A Verify PASS is a verdict about the work unit, never an authorisation
to close it. In the EZE-492 and EZE-493 sessions the Parent treated `PASS ->
aies_ticket complete` as unconditional and Linear reached `Done` while the user had
just said "no commit todavía" / "quiero revisarlo antes" and the tree was still
uncommitted. The missing rule lives in `extensions/aies-agents/linear/pending-action.ts`
(pure) and is enforced at the three points where a PASS turns into Done:

1. **Capture.** The `input` handler of `extensions/aies-agents/index.ts` records one
   user message at a time. Only explicit wording creates a hold (the held step and a
   hold marker must appear in the same clause); interrogative clauses ("¿puedo
   commitear?") and clauses that merely report state ("no hay commits nuevos") are
   dropped, and an input that says nothing about finalization leaves the hold in
   place. `source: "extension"` — AIES' own hidden continuation instructions — never
   speaks for the user. A release must be explicit too ("ya lo revisé, podés
   commitear", "lgtm"); a bare "dale"/"seguí" does not lift a hold.
2. **Done Gate.** `checkDoneGate()` evaluates the hold before the verification rule
   and answers with its own code (`pending_final_action`, not a Verify failure), so
   the refusal cannot be mistaken for missing evidence. `performComplete()` returns
   without any transport call: the ticket stays open, the verification record is
   untouched and no completion comment is posted.
3. **No bypass, no autopilot.** While a hold stands, a direct `mcp save_issue` that
   names the active ticket and a completion **state name** is blocked in `tool_call`
   (the EZE-492 bypass), and `evaluateContinuation()` pauses with `user_required`
   instead of continuing toward Linear completion, so no follow-up turn can push the
   ticket closed. An opaque status id is never guessed at, and any other Linear write
   is untouched.

`force: true` on `complete` is the single way through, and it stands for the user's
confirmation of the held step, never for the Parent's impatience.

**Rejected alternatives.** Inferring a hold from `git status` (uncommitted changes
therefore block Done) was rejected: it would make a commit universally required,
including for docs-only units and for users who commit later by design, which is the
opposite defect. NLP intent detection or delegating the reading to the model was
rejected as neither deterministic nor testable. Making the Parent responsible for
remembering the wording was rejected because that is exactly how EZE-492 lost it: the
PASS overwrote the instruction. Clearing the hold on any new user input was rejected
because a continuation-style "seguí" would then silently re-open the Done path.

**Consequence.** Completion now needs both a valid PASS and the absence of an
explicit user hold. The cost is a possible false refusal when a user sentence merely
resembles an instruction to wait; the refusal names the recorded words, so the Parent
can ask and continue with `force: true` in one step. A wrong PASS-driven Done, which
is what this replaces, was unrecoverable from inside the session.

---

## D33 - Progressive migration from Linear to Plane: one active tracker per profile, explicit selection, no dual writes

**Decision.** Plane Cloud (workspace `ezequieldev`; projects `AIES`, `COREOS`
and `EZEQU` "Agent Workbench") replaces Linear as the ticket tracker. The
migration is incremental. Linear stays as a temporary compatibility path and as
the default tracker during the transition. Two trackers are not kept as
permanent managers, and bidirectional sync and dual writes are prohibited.

1. The tracker is an explicit `tracker` key (`linear` | `plane`, default
   `linear`) in `$PI_CODING_AGENT_DIR/aies.json`. A profile has exactly one
   active tracker.
2. The ticket snapshot records the tracker it came from. A tracker change while
   a ticket is active fails closed.
3. The tracker is never inferred from an identifier. Plane identifiers
   (`AIES-38`) have the same format as Linear identifiers (`EZE-496`).
4. Plane is reached through its official hosted MCP server. OAuth at
   `https://mcp.plane.so/http/mcp` is the interactive path. Headless sessions
   use the personal access token endpoint `https://mcp.plane.so/http/api-key/mcp`
   with `Authorization: Bearer` and the header `x-workspace-slug: ezequieldev`.
5. The token reaches the adapter only through `bearerTokenEnv` with the variable
   name `PLANE_API_KEY`. AIES never reads, stores, logs or exposes its value to
   the model, and it is not written to the repository or to any log.
   `docs.plane.com` documents a different product and is not the reference for
   this integration.
6. The existing architecture is reused: the Parent is the only owner of the
   tracker, children have no MCP and no extensions, transport is mediated by the
   Parent (`remote_required`, D17), and the Done Gate, the EZE-503 hold, the
   repo-guard and the 2,500-character compact contract stay (D14 principles,
   D17 principles, D22 fail-closed, D30, D32).
7. For Plane, the human ticket identity is `PROJECT-N`, built from
   `project.identifier` and `sequence_id`. Project and work item UUIDs are
   internal fields needed for writes and are never an identity (amends D22).
8. For Plane, while any hold exists, every `workitem update` that carries
   `state` is blocked. `state` is a UUID on writes, so it cannot be matched by
   name (amends D32).
9. The repo-guard compares the ticket's `project.name` and `project.identifier`
   with the `repos` table (amends D30).

**Verified shape.** Checked by reading only; nothing was written to Plane.
`workitem retrieve_by_identifier` with `expand=state,project` returns `id`,
`sequence_id`, `project{id,identifier,name}` and `state{id,name,group}`. On
writes, `state` is a UUID: `workitem update` takes `project_id`, `workitem_id`
and `state`. State groups are `backlog`, `unstarted`, `started`, `completed` and
`cancelled`. Comments use `workitem_comment create` with `comment_html`.

**Why.** Two trackers kept as permanent managers would give the workflow two
authorities and two places where ticket state can diverge. Migrating
incrementally keeps the working Linear path valid while Plane is built and
validated. Identifiers do not say which tracker they belong to, so the tracker
must be declared explicitly. Failing closed on a tracker change protects a
snapshot from being completed in the wrong system.

**Phases.** Each phase is a separate work unit. Phase 2 is the first.

- Phase 2: refactor `TrackerTransport` with no behaviour change (Linear exactly
  as today).
- Phase 3: `PlaneTransport`, an offline fake, and a `plane` server in the
  profile.
- Phase 4: the EZE-503 hold, repo-guard, autonomy, UI and skill made
  tracker-aware.
- Phase 5: end-to-end validation against real Plane in an isolated profile
  (`AIES_HOME=/tmp/...`). Initial tests do not touch real Plane tickets.
- Phase 6: retirement of Linear, only after Plane is fully validated. Its
  acceptance criteria will be set after Phase 5.

**Consequence.** Linear keeps working unchanged through Phase 2, and during the
transition it remains the default tracker. Initial Plane tests run against the
fake and against an isolated profile, never against real tickets.

**Open.**
- The acceptance criteria for Phase 6 are not defined yet.
- How workflow steps map to Plane states is not decided here. The state groups
  above are the only fixed vocabulary.
- How an active ticket is carried across a tracker change is not defined. The
  current rule only says that the change fails closed.

**Status.** Accepted. Implementation proceeds by phases, starting with Phase 2.

---

## D34 - Engram integration: the existing store, a profile-owned stdio server for the Parent, and per-project memory

**Decision.**
1. Engram already runs on this machine: `/opt/homebrew/bin/engram` (v3.4.0),
   with data in `~/.engram/engram.db` (SQLite, WAL) and an `.instance-id`. AIES
   does not create another instance and does not define `ENGRAM_DATA_DIR`.
2. Under `PI_MCP_CONFIG_MODE=exclusive` (D17 item 3), AIES does not inherit
   Pi's ambient MCP configuration. The integration is therefore a stdio MCP
   server owned by the profile (option A, approved): `command: engram`,
   `args: [mcp, --tools=agent, ...]` and `lifecycle: lazy`, declared in
   `profile/mcp-adapter.json` and in the `mcp.json` template. Each session runs
   one process over the same store.
3. Only the Parent (orchestrator) accesses Engram. Children keep no MCP and no
   extensions (D17 item 9), so there is a single write authority.
4. The project is fixed per process with `--project NAME` or `ENGRAM_PROJECT`,
   and calls must OMIT `project`. An explicit project that Engram does not know
   fails with `unknown_project`. `mem_search` returns at most 20 results.
   `mem_current_project` reports the resolved project.
5. Memory has two separate scopes:
   - (a) AIES's own memories (harness decisions, dogfooding, conventions,
     lessons about AIES itself) live in the Engram project `aies`.
   - (b) Memories of projects developed through AIES each live in their own
     Engram project, derived from the repository with the same identity rule as
     D30: the normalised name of the git toplevel.
6. The scopes do not mix by default. Searches and context are bounded to the
   active project. `all_projects` or any cross-project search runs only on an
   explicit user request. AIES knowledge is not injected into project memories,
   and project knowledge is not injected into AIES, unless the user asks.
7. Memory is recovery context, never authority. The ticket lives in the tracker
   (D33), the code in Git, and the decisions in `docs/DECISIONS.md`. Each entry
   carries provenance (repo, ticket, role) and its scope, and is deduplicated by
   a stable `topic_key`.
8. No memory artifacts are written into product repositories. No secrets or
   tokens are stored in memories, and memories are never exposed to children.

**Evidence.** A concurrency spike ran with isolated data; the real database was
left untouched. Four `engram mcp` processes, each doing 25 simultaneous
`mem_save` calls against the same SQLite store, completed 100/100 without
errors.

**Rejected alternatives.** Loading `gentle-engram` into the profile was rejected:
it adds a package and can start another `serve`. rmcp-mux was rejected: it adds
moving parts with no demonstrated need.

**Why.** A second Engram instance would split the same user's memory across two
stores. Exclusive MCP configuration hides the ambient Engram setup from AIES, so
the profile has to declare its own server. Parent-only access keeps one write
authority and keeps memory out of child contexts, in line with D17 item 9.

**Consequence.** The integration is designed here but not implemented. Nothing
in the profile changes until the open point below is resolved. Any option that
writes into a product repository must also satisfy item 8.

**Open (to be validated in implementation).** The exact mechanism that binds the
Engram project to the active repository, when the adapter launches the server
with static configuration, is not decided. The candidates are cwd
auto-detection, `--project` or `ENGRAM_PROJECT`, and a per-repo
`.engram/config.json`. A spike resolves it before implementation.

**Status.** Accepted, pending implementation.

---

## D35 - Subagent reliability: sequential delegation, bounded children, sandbox-gated Verify

**Decision.** Refines D12 (sandbox) and D19/D31 (Verify and stale runtime). Does
not change D32.

1. Sequential delegation. `aies_delegate` declares `executionMode: "sequential"`.
   Pi runs sibling tool calls in parallel by default (`docs/extensions.md` in
   Pi), and the delegations share mutable state. The verification registry is
   read before the `await` and written after it without versioning, so updates
   can be lost. The routing resets its counters when the first child finishes.
   The SandboxManager is global per role and cwd, so a Verify could run under a
   Worker's policy. This last point is deduced by reading the code, not
   reproduced.
2. Bounded children. Child sessions (`executeChildSession`, `session.ts`) are
   cancelled when the parent's signal aborts, by calling the public
   `AgentSession.abort()` API. That call is deliberately not awaited, so a hung
   child cannot block the parent. Children have a total timeout and a turn
   limit: each `turn_start` event counts, N turns are allowed and the N+1th
   aborts. Precedence: `AIES_CHILD_TIMEOUT_MS` / `AIES_CHILD_MAX_TURNS` >
   `agents.<role>.timeoutMs` / `maxTurns` in `aies.json` > defaults. Invalid
   values are ignored. Defaults are 100 minutes (the longest observed in
   dogfooding was a Verify of about 33 minutes; 3 x 33, rounded) and 100 turns
   (dogfooding does not record turns per child, so this is a generous ceiling
   and NOT calibrated). Failures reach the parent as a structured failed handoff
   with the cause (`cancelled` | `timeout` | `max_turns`): `failed` for Explore
   and Worker, `session_failure` for Verify. The listener, the timer and the
   subscription are always removed, and `dispose()` always runs. All three roles
   pass their `role`.
3. Verify requires the OS sandbox. Before creating the Verify child,
   `aies_delegate` checks that the sandbox is active (`isSandboxSupported`, with
   the `isSandboxActive` seam for tests). If it is not, it returns BLOCKED for
   infrastructure (`verify_sandbox_unavailable`) without creating a session or
   calling the model. It does not consume a verification attempt and does not
   mark the revision as verified. Worker does not change: it keeps degrading
   with a warning (D12). The per-command defence in `executeSandboxedCommand` is
   kept.
4. Recovery from a sandbox BLOCKED. `VerificationState` records the cause
   (`blockedCause: 'sandbox_unavailable'`) through `applySandboxBlock`, which
   also clears `verifiedRevision`. The guard
   `verification_blocked_conditions_unchanged` lets a new request through only
   when the cause is `sandbox_unavailable` and the sandbox is active again. Any
   other BLOCKED (a child verdict, or a state with no cause) keeps the rule of
   unchanged conditions. Invariants:
   - Recovering the right to retry NEVER reactivates a previous PASS. Validity
     depends only on `status === 'pass' && verifiedRevision === revision`, and
     the release does not write state.
   - The Done Gate (D14/D32) does not change. It still requires a new, valid
     Verify PASS.
   - The release does not consume attempts. The new Verify spends its own.
   - `VerificationState` is not serialized (on resume it restarts), so there is
     no migration.

**Rejected alternatives.** A custom lock or queue for delegation, because one
declarative Pi line solves the problem without new code. For item 4:
automatically restoring the previous PASS, and deriving the cause from the
message text.

**Why.** Parallel sibling delegations corrupt shared verification state, and a
hung child can block the parent indefinitely. A Verify without an OS sandbox
would run the verifier without the isolation that D12 requires. Recording the
cause lets only the infrastructure failure be retried, without weakening the
rule that a verdict stays bound to its revision.

**Consequence.** Known limits, open and not resolved here:
- A cancelled Worker can leave partial edits behind with a handoff that declares
  `changes: []`. The parent must check `git status`.
- The timeout and turn defaults must be calibrated with real data.
- `permissions.sandbox` in `profile/aies.json` is not read by any code. The only
  real switch is `AIES_SANDBOX`. This is a pending decision.
- On hosts without sandbox support, tests that run verify with a fake child
  through real detection would return BLOCKED. They need `isSandboxActive`
  injected.
- The cause messages for the limits are in English.
- A BLOCKED emitted by the Verify child itself, over a revision with a previous
  PASS, overwrites the state. No path reactivates it.

**Tests.** `tests/delegate-execution-mode.test.mjs`,
`tests/child-session-limits.test.mjs`, `tests/verify-sandbox-gate.test.mjs`,
`tests/verify-sandbox-recovery.test.mjs` and
`tests/verification-blocked-cause.test.mjs`.

**Status.** Accepted; implemented.

---

## D36 - Plane migration phase 4: tracker-neutral surfaces, Plane write guard, incremental MCP seed

**Decision.** Phase 4 of D33, implemented. Five parts, all verified by tests.

1. Plane repo-guard (amends D30). A Plane ticket is compared by
   `project.identifier` and by `project.name`. The `repos` table in `aies.json`
   (explicit project-to-repo mappings) accepts as key either the name or the
   identifier, both normalised with the same function as D30 item 2, and it takes
   priority over the name match. A ticket with no project is `unknown` and never
   blocks. `AIES_ALLOW_REPO_MISMATCH` is kept. The Linear block reason does not
   change byte for byte.
2. Tracker-neutral surfaces, only when the active tracker is `plane`. Linear
   output stays byte for byte the same. Labels come from the tracker descriptor:
   remote directives, manager messages, tool and command descriptions, and the UI
   (summary line, the `Sincronizar <tracker>` label, the DONE card and notices).
   Autonomy stop codes are the generic `tracker_conflict` and `tracker_sync_failed`
   for Plane; Linear keeps emitting `linear_conflict` and `linear_sync_failed`.
   The skill `skills/linear-ticket` becomes `skills/ticket-workflow` with the same
   rules (one active ticket, exact load, transitions, Done Gate, compact feedback).
   `aies_ticket`, `/aies-ticket` and `/aies-run` do not change. Two texts still say
   "Linear" on purpose: `AIES_CONTINUATION_PROMPT` (`autonomy/policy.ts`) and the
   description of the `remote` parameter of `aies_ticket`.
3. Plane write guard (amends D33 item 8 and D32). Correction: D33 item 8 assumed
   that a `workitem update` directive carrying `state` is only emitted after the
   Done Gate passes. That is inaccurate: `start` also emits a `workitem update`
   with the "In Progress" state. The rule in force does not depend on the profile's
   tracker. Each call is read once by one resolver, and that single reading feeds
   both the directive guard and the hold, so the two cannot disagree about which
   Plane tool a call reaches. The resolver follows pi-mcp-adapter 3.2.0 with the
   default tool prefix `server` (an assumption, see the residual risks):
   - The `mcp` proxy with `server` `plane` is Plane. The `mcp` proxy with no
     `server` is read as Plane when its tool name points at Plane: `plane_<tool>`,
     `mcp__plane_<tool>`, or the original name of a Plane tool (`workitem`, `state`,
     `intake` and the others on the analysed list). Tool names are compared without
     case, with spaces, hyphens and dots read as `_`, and an `mcp_` prefix is
     ignored. The action is trimmed and lowercased. Arguments may be an object or a
     JSON string.
   - An explicit `server` other than `plane` is never read as Plane, with one
     exception: `action: install` is blocked with any server (see the gateway
     bullet below).
   - The direct tools `plane_<tool>` and `mcp__plane_<tool>` follow the same rules.
     The namespace proxy `mcp__plane`, called with `{tool, args}`, applies them to
     its `tool` field; a call with no `tool` is blocked.
   - `workitem update` with `state` (or `status`, at any nesting level) is allowed
     only if it matches exactly the pending `aies_ticket` remote directive (server,
     tool, action, `project_id`, `workitem_id`, `state`, with no extra keys) AND
     the pending action is `start`, or it is `complete` with the Done Gate
     re-evaluated at call time. A `complete` directive can remain pending after the
     gate passed and the Parent edits code afterwards, hence the re-evaluation.
   - With an EZE-503 hold, it is always blocked (D32), whatever the directive.
   - Any other case is blocked, with or without a hold.
   - The `state` actions `create`, `update` and `delete`, and the `intake` actions
     `update` and `delete`, are always blocked. Changing the group of a state to
     `completed` would complete every ticket in that state at once, and intake
     decisions accept, reject or duplicate work. The block message points to the
     Plane UI.
   - Fail closed: any unknown action of `workitem`, `state` or `intake`, unreadable
     arguments, JSON arguments with repeated keys after decoding escapes, and Plane
     tools not on the list are blocked.
   - Gateway modes that run no tool pass with `server` `plane` or with no `server`:
     the discovery parameters `search`, `describe`, `instructions`, `connect`,
     `list` and `status` (when the call has no `tool`; a `tool` wins, as in the
     adapter), and the actions `ui-messages`, `auth-start` and `auth-complete`. This
     keeps discovery and OAuth working. The action `install` is blocked with any
     server (`plane`, no server, or another server such as an alias `plane2`),
     because it rewrites an MCP server definition and AIES has no use for it in its
     flow. An unknown action is blocked too. This is stricter than the adapter, which
     ignores an unknown action, and the adapter would otherwise register and persist
     the server in the profile config.
   - `mcp` with no `server` and a tool name that cannot be attributed to any known
     server is blocked (fail closed). The known names are the Plane tools, anything
     with the `linear_` prefix, and the four Linear workflow tools `get_issue`,
     `save_issue`, `list_issue_statuses` and `save_comment`. Consequence: an unlisted
     Linear tool without the `linear_` prefix, or a custom server's tool, called with
     no `server` no longer passes. A call with an explicit `server` is unchanged. The
     recommendation is that the Parent always passes `server`. This is a behaviour
     change against Linear in that edge case. It is accepted and open to review: the
     list of known Linear tools can be widened.
   - `mcpScript` is blocked as a whole, whatever the tracker, including when no
     tracker is selected, because a script could chain calls past the guard.
     `scriptMode` is `false` in the default profile, and no existing test requires
     `mcpScript` to be allowed.
   - Always allowed, without state restriction: reads, `workitem_comment`,
     `workitem update` without `state`, `manage_assignee` and `manage_label`, and
     the tools that do not change a ticket's state (cycle, module, release,
     initiative, milestone, workitem_property, workitem_relation, workitem_type,
     template, project, label, member, page).
   - Linear's guard does not change: it applies only under a hold (D32).
4. Incremental, safe MCP seed (amends D17 item 2, for the seed only).
   `scripts/seed-profile-config.mjs` adds to an existing profile the template
   servers it lacks (`linear` and `plane`) and changes nothing else.
   - It never overwrites an existing entry, even when that entry differs from the
     template. It reports the conflict by server name and by the names of the keys
     that differ, never their values. The report is informational, exits 0, and
     repeats on every start while the difference persists.
   - It keeps custom servers, credentials and settings, and it adds no settings
     keys.
   - Before any write that changes content, and before writing, it makes
     `<file>.bak-YYYYMMDDTHHMMSS` (suffix `-2`, `-3` if that exists). The copy is
     exclusive, never overwrites, and keeps the original permissions.
   - Writes are atomic: a temporary file in the same directory, the original
     permissions, then rename. Symlinks are followed, a UTF-8 BOM is tolerated on
     read, and indentation and key order are kept.
   - Idempotent: a second run changes nothing and creates no backup.
   - Empty configuration, invalid JSON, a root that is not an object,
     `mcpServers` that is null, an array or a string, or a read-only file: the seed
     exits 1 without modifying anything and without quoting the parser text.
     `bootstrap-profile.sh` still continues with the existing profile (D17).
   - The legacy migration (`mcp.json` to `mcp-adapter.json`) keeps its earlier
     semantics. With no destination, the template wins on matching keys. With a
     destination, template-only keys are merged into the existing entry, which an
     existing test pins. It now also backs up `mcp.json` before deleting it.
5. Tracker kept on refresh. A refresh of a Plane ticket keeps its tracker. Before
   this, the tracker was lost, and the next operation would have produced
   `tracker_mismatch`.

**Why.** Phase 4 makes the workflow surfaces tracker-aware without touching the
Linear path, and it closes the gap that D33 item 8 left open: a `start` directive
also writes state, so a hold-only guard would have been wrong in both directions.
The seed must not silently overwrite a profile the user has edited, and a
migration that deletes a file must leave a way back.

**Rejected alternatives.** Guarding only by hold (D33 item 8 as written) was
rejected because it left a path that changes state without the Done Gate. Blocking
only by state name was rejected because the Plane state is a UUID on writes.

**Consequence.** Linear behaves as before, with one edge case: a call with no
`server` to an unlisted Linear tool (no `linear_` prefix) or to a custom server is
now refused (part 3). Plane tickets get tracker-specific
labels, stop codes and repo matching, and the write guard blocks the state
transitions that could close a ticket outside the Done Gate. Open, not resolved
here:

- Residual write risks. `workitem create` (even with `state`), `archive` and
  `delete` are allowed. `create` does not touch the active ticket. `archive` and
  `delete` are irreversible, and they have not been verified against the Plane
  API.
- The Parent's bash can call the Plane API directly if a token is in the
  environment and the hook does not see it. This is the same as with Linear. Open
  decision: a bash policy, or not exposing `PLANE_API_KEY` to the Parent.
- The `remote` fallback of `aies_ticket` accepts Parent replies without checking
  that the write happened. It does not skip the Done Gate, which is re-evaluated.
  This is pre-existing with Linear.
- A call that differs from the directive only in case is allowed, and it is not
  captured automatically.
- The direct tools are named `plane_<tool>` (the guard also reads
  `mcp__plane_<tool>`). They follow the same rules, but the profile does not enable
  `directTools`. The default tool prefix `server` that the resolver assumes is not
  verified. With `toolPrefix` `none`, a direct Plane tool that is not on the
  analysed list would not be recognised; the listed ones still would.
- A Plane endpoint declared in the profile under another server name escapes the
  guard, because the guard classifies by server name. This can happen through a
  manual edit of the profile by the user, or through a seed conflict that is
  reported and not overwritten (part 4).
- The MCP-UI apps of the adapter can call tools through their bridge, outside the
  `tool_call` hook. This route is started by the user. It is not tested.
- An `action` that is empty or null is blocked, although the adapter would ignore
  it. A Plane read tool that is not on the analysed list is also blocked. Both are
  known over-blocking, accepted as fail closed.
- A template server the user removes on purpose returns on the next start. There
  is no marker and no exclusion list.
- Backups accumulate, with no pruning.
- `bin/aies` discards the bootstrap stdout, so the "added" notices never reach the
  user. Backups, conflicts and rejections go to stderr and are not discarded.
- A JSON file with comments or trailing commas is rejected.

**Tests.** `tests/plane-write-guard.test.mjs`,
`tests/plane-write-names.test.mjs`, `tests/plane-write-hook.test.mjs`,
`tests/plane-repo-guard.test.mjs`, `tests/plane-tracker-texts.test.mjs` and
`tests/seed-mcp-merge.test.mjs`.

**Status.** Accepted; implemented (phase 4 of D33). Phase 5 (end-to-end
validation against real Plane in an isolated profile) pending.

---

## D37 - Plane hardening before real writes: closed write list, endpoint identity by definition, read-back confirmation, persistent MCP exclusions, PAT isolation

**Decision.** Hardening of the Plane integration before any real write. Items 1
and 4 amend D36; items 5 amends D33; item 6 states the D17 supersession.

1. **Closed write list (amends D36 item 3).** The Plane guard is deny-by-default
   over the whole Plane server. D36's permissive table, and its residual risk that
   `workitem create`, `archive` and `delete` are allowed, are superseded. Only
   these calls pass:
   - Reads, in any Plane tool and under any name form: `list`, `list_archived`,
     `list_workitems`, `list_projects`, `list_options`, `list_definitions`,
     `list_workspace`, `list_project`, `retrieve`, `retrieve_by_identifier`,
     `retrieve_option`, `search`, `count`, `get_changelog`, `get_features`,
     `get_value`, `worklog_summary`, and the reference tool `get_pql_reference`.
   - `workitem` `update` carrying `state`, matched EXACTLY against the pending
     `aies_ticket` remote directive, and only for `start`, or for `complete` with
     the Done Gate re-evaluated at call time. With a hold (D32) it is always
     blocked.
   - `workitem_comment` `create`.

   Everything else is blocked, with a message that points to the Plane UI:
   `workitem` `update` without `state`; `workitem` `create`, `delete`, `archive`,
   `manage_assignee` and `manage_label`; `state` `create`, `update` and `delete`;
   `workitem_comment` `update` and `delete`; every write of `intake`, `project`,
   `cycle`, `module`, `release`, `milestone`, `initiative`, `template`,
   `workitem_relation`, `workitem_property` and `workitem_type`, including
   `resolve`, which looks a type up and creates it if missing; tools that were not
   inspected action by action (read-only); unknown actions and unknown tools;
   `mcp` with no attributable server; `install` with any server; and `mcpScript`.

2. **Endpoint identity by definition, with inverted attribution (closes the D36 risk
   "endpoint declared under another name").** The configuration the guard reads is
   the one the adapter reads. In `exclusive` mode, pi-mcp-adapter 3.2.0 reads only
   `$PI_CODING_AGENT_DIR/mcp-adapter.json`, or the path given with `--mcp-config`,
   and does NOT read `mcp.json`. The guard also reads `mcp.json` as a conservative
   superset: this can over-block, never under-block. A server is Plane when its
   definition points at Plane: a `url` with host `plane.so`, `*.plane.so`,
   `plane.com` or `*.plane.com`; any `url` that mentions `plane`; or a `command`,
   `args` or `bearerTokenEnv` that mentions `plane`. A server named `linear` whose
   definition points at Plane is Plane. Prefixed names `<alias>_<tool>` and aliases
   follow the same rules.

   Attribution follows one order, and the first rule that applies decides the name:
   1. A declared Plane server: the namespace proxy `mcp__<ns>`, or a direct tool
      `<prefix>_<tool>`.
   2. Positively Linear, never Plane: `mcp__linear`, `linear`, the four workflow
      tools in bare form (`get_issue`, `save_issue`, `list_issue_statuses`,
      `save_comment`), and `linear_<one of those four>`. Any other `linear_*` name is
      read by the Plane rules.
   3. Pi and AIES: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `tgrep`
      and `aies_*`. No Plane rules apply.
   4. Any declared server, Plane or not, by equality or by prefix: the Plane rules.
   5. A bare Plane tool name: the Plane rules.
   6. Any other name in MCP form (`mcp…`): the Plane rules, never "no server".
   7. Under fail closed, any other name that is not Pi or AIES is blocked.

   The `mcp` proxy with an explicit `server` is attributed by that `server` field: a
   declared server whose definition is Plane follows the Plane rules, and a declared
   non-Plane server does not. A name that no rule attributes is read as Plane, so a
   mistake in reading a name can only over-block, never let a Plane call through.

   Fail closed, when the configuration is unreadable, invalid, ambiguous, uses
   `imports`, `claudePlugins`, `agentPluginPaths`, or a mode other than `exclusive`,
   and also when any of these holds: a Plane alias whose name does not start with
   `[A-Za-z0-9]`, starts with `_mcpns_`, is `mcp`, or starts with `mcp-` or `mcp_`,
   or lies outside `[A-Za-z0-9_-]` or is longer than 59 characters; `directTools`
   set to anything other than `false` on a Plane server or in the settings; a
   non-empty `MCP_DIRECT_TOOLS` in the environment; or a `toolPrefix` other than
   `server`, globally or per server. Under fail closed, every server except `linear`,
   and every unrecognised MCP tool, is Plane.

   The reading is cached by file stamp (size, mtime and ctime). Only the profile
   files and `--mcp-config` are parsed; packages and plugins are not parsed, and
   fail closed. Accepted over-blocking, deliberate: a `url` containing `plane`
   anywhere (for example `planetscale`) counts as Plane; a JSON file with comments
   counts as unreadable; `disabled` does not exempt a server; non-Plane declared
   servers have their writes in Plane-shaped form blocked; and, under fail closed,
   tools from other extensions are blocked.

3. **Read-back confirmation (Plane only).** A state write (`start` or `complete`)
   is not confirmed by its own answer. It is confirmed only by a later
   `retrieve_by_identifier` with `expand=state,project` whose `state.id` equals the
   written state and whose identifier is the requested one. The read-back is a
   normal remote directive with the same arguments as the earlier read. It is
   distinguished only by a stage in the internal capture key (`#confirm-state`),
   with no invalid argument. If it does not match, fails or returns unusable data,
   the error is typed (`remote_conflict`, `not_found` or `invalid_remote_payload`)
   through `PlaneWriteUnconfirmedError`: the local state does not advance, the
   ticket stays open and no completion comment is emitted. The `TrackerTransport`
   signatures do not change. Linear is identical.

4. **Persistent MCP server exclusions (amends D36 item 4; closes its open risk "a
   removed server comes back").** The key `mcpExcluded` in
   `$PI_CODING_AGENT_DIR/aies.json` is an array of exact, case-sensitive server
   names. The seed never adds an excluded server: for a new profile, an existing
   one, a v2 profile and the legacy migration alike. It does not remove or modify a
   server that is already present, and it does not create or edit `aies.json`. It
   reports the excluded name on stderr. It stays incremental, idempotent, with
   backup and atomic writes. Fail safe: an unreadable `aies.json`, or an
   `mcpExcluded` that is not an array of strings, makes the seed leave every MCP
   entry alone (no backup), exit with code 1, and the bootstrap continue with the
   existing profile; packages are still reconciled. Example:
   `{"tracker": "plane", "mcpExcluded": ["linear"]}`. Order for the user: add the
   name to the list BEFORE removing the server from the profile, or the seed adds
   it back on the next start. While a server is excluded and absent, one line is
   printed on every start, on purpose. An excluded server that ALREADY appears in
   the user's legacy `mcp.json` is not discarded: the migration keeps it exactly as
   the user wrote it in `mcp-adapter.json`. The excluded template entry is neither
   mixed in nor added from the template, and it is not reported as excluded,
   because the server already exists. This is consistent with "does not remove or
   modify what is already present".

5. **PAT isolation (amends D33 items 4-5 on when the PAT path is activated).**
   `PLANE_API_KEY` and any PAT credential are NOT activated yet. The phase 5
   validation uses OAuth. PAT credentials must not be exposed to the Parent's Bash
   environment: a token in the environment lets a process call the Plane API
   directly, outside any guard. Headless PAT integration will be resolved later
   through a credential mechanism isolated from the Parent. Until then the profile
   declares no PAT endpoint, no headers and no `bearerTokenEnv`.

6. **Linear compatibility and D17 (acceptance of D36).** The behaviour changes
   documented in D36 are accepted: an `mcp` call with no attributable server is
   blocked, `mcpScript` is blocked, and `install` is blocked with any server.
   Unrecognised tools stay blocked. The legitimate Linear flows keep working: the
   four tools `get_issue`, `save_issue`, `list_issue_statuses` and `save_comment`,
   and any call with an explicit server. D17 item 1 ("exactly one MCP server,
   `linear`") is superseded: the profile declares `linear` and `plane`. That has
   been true since D33 and D36; it is stated here.

7. **Phase 5 preparation (facts read, no writes).** The Plane project Agent
   Workbench (`EZEQU`) has no work items. Its states are Backlog (`backlog`), Todo
   (`unstarted`), In Progress (`started`), Done (`completed`), Cancelled
   (`cancelled`), Review (`started`) and Blocked (`started`). Three states share
   the `started` group, so the target of `start` must be resolved by its name
   (`In Progress`), not by group alone. This is to be checked in validation. The
   end-to-end validation uses OAuth (`/mcp-auth plane` in an interactive session
   with an isolated `AIES_HOME`) and a dedicated test ticket, identified and
   authorised by the user before any real write.

**Why.**
- The closed list follows from what the automated flow needs: read, move the state
  through a directive, and comment. Every other mutation can bypass the Done Gate
  or the hold: changing the group of a state, creating a ticket directly in Done,
  archiving or deleting the active ticket, or changing a project's workflows. The
  permissive table of D36 let those through.
- Classifying by name left a Plane endpoint declared under another name outside
  the guard. A server's definition is what says what it reaches.
- A write's own answer is not evidence of the state the remote now holds. Only a
  read after the write can show it.
- A server the user removed from the profile came back on every start, because the
  seed had no record of the removal.
- A token in the environment is usable by any process, including the Parent's
  Bash, which sits outside the guard.

**Rejected alternatives.**
- A deny list of dangerous writes (the D36 table): replaced by deny-by-default
  over the whole Plane server.
- Classifying servers by name alone: replaced by classification by definition.
- Accepting the write's own answer as confirmation: replaced by the read-back.
- Activating the PAT path now, with `PLANE_API_KEY` in the environment: rejected
  by item 5.

**Consequence.** Creating, archiving, deleting, assigning and labelling Plane
tickets is done from the Plane UI until an approved intake feature exists (on the
roadmap). This over-blocking is accepted. Open, not resolved here:
- The read-back costs one extra read per `start` and one per `complete`.
- A retry after a completion that was not confirmed, whose write did arrive,
  yields `remote_conflict` ("already completed externally") and needs a decision
  from the user.
- The `remote` fallback of `aies_ticket` lets the Parent supply answers. The
  read-back does not prevent that. This is a documented limitation.
- The Parent's Bash can still reach the Plane API if a token is in its
  environment. Item 5 keeps the PAT out for now. A credential mechanism isolated
  from the Parent is future work.
- The `start` target name (`In Progress` among three `started` states) is to be
  confirmed in the phase 5 validation.
- Name forms. Four rounds of independent verification found name forms that a
  rebuild of the adapter's names did not cover: aliases containing `.`, spaces, a
  leading `_` or `-`, or more than 59 characters; the prefixes `mcp-` and `mcp_`;
  `toolPrefix` other than `server`; and `directTools`. The order and the fail-closed
  cases in item 2 cover them. A name that no rule attributes is read as Plane, so the
  accepted cost is over-blocking.
- Known over-blocking. A declared non-Plane server (for example `context7`) whose
  namespace or direct tools carry no `action` field is blocked, even when the tool
  is read-only.
- Hidden alias. A hidden alias named exactly `linear_<workflow tool>` (one of the
  four workflow tools) passes as Linear under fail closed. This is the only positive
  exception kept, so that Linear is not blocked.
- Direct Linear tools. Direct `linear_*` tools outside the four workflow tools are
  read by the Plane rules. This affects only Linear with `directTools`.
- Built-in tool list. The Pi built-in tools that rule 3 treats as safe are
  `PI_AND_AIES_TOOLS` in `extensions/aies-agents/linear/pending-action.ts`: `read`,
  `bash`, `edit`, `write`, `grep`, `find`, `ls` and `tgrep`, plus every `aies_*`
  tool. As D21 records, `extensions/aies-runtime/quiet-tools.ts` overrides six of the
  Pi built-ins. This list must be kept up to date when Pi adds built-in tools. A new
  built-in missing from it is not in the safe set: it is blocked under fail closed
  (rule 7), and it is not read as Plane otherwise.
- Not detected by definition: a self-hosted Plane on a domain that does not
  contain `plane`, and an opaque wrapper that hides the endpoint (for example a
  script that conceals it).
- Runtime registration. Servers registered at runtime by other extensions are not
  seen. Worker and Verify children use `noExtensions` and have no `mcp`.
- Configuration directory. The adapter derives the configuration directory from
  `<NAME>_CODING_AGENT_DIR`, according to `PI_PACKAGE_DIR` and `piConfig.name`. The
  guard reads only `PI_CODING_AGENT_DIR`. The agent cannot exploit this; it depends
  on the launcher fixing `exclusive` mode.
- Test coverage. There is no end-to-end test through the real hook with a genuine
  Verify PASS. The real PASS is covered at manager level only.

**Tests.** `tests/plane-closed-list.test.mjs`,
`tests/plane-endpoint-aliases.test.mjs`, `tests/plane-confirmation.test.mjs`, and
the extensions of `tests/seed-mcp-merge.test.mjs`.

**Status.** accepted; implemented (phase 5, real end-to-end validation, pending).

---

## D38 - Closed trusted MCP profile: the guard decides whether the profile is known, not which name is Plane

**Context.** D36 and D37 made the Plane write guard recognise Plane by reconstructing
how `pi-mcp-adapter` 3.2.0 deforms server and tool names (namespaces, prefixes, hashing
above 59 characters, `_mcpns_` encoding, `toolPrefix`) and by reading aliases from server
definitions. Five independent verifications each found one more form, and a generative
test was only as faithful as the replica it checked against. That design could not
guarantee, by construction, that no Plane write evaded the guard.

**Decision (supersedes the attribution parts of D36 item 2 and D37 "endpoint identity
by definition"; the closed list, exact directive, Done Gate, hold and read-back
confirmation of D36/D37 are unchanged).**

1. The guard asks whether the MCP profile is trusted, not which name is Plane.
   `extensions/aies-agents/mcp/trust.ts` judges the profile. It is trusted only when
   `PI_MCP_CONFIG_MODE=exclusive`, `MCP_DIRECT_TOOLS` is empty, the file the adapter
   reads (`$PI_CODING_AGENT_DIR/mcp-adapter.json`, or `--mcp-config`) and the legacy
   `mcp.json` parse, they use no `imports`, plugins, direct tools, or `toolPrefix` other
   than `server` (the adapter's own default, which leaves names unchanged), and
   every declared server is in the repo template `profile/mcp-adapter.json` by exact
   name with the template `url` and `auth` (a subset is valid, so `mcpExcluded` works;
   `disabled`, `lifecycle` and `directTools: false` are tolerated, any other key is not).
2. Trusted: attribution is exact string equality on the declared servers (the `server`
   field of the `mcp` proxy, the namespace tool `mcp__plane`). No canonicalisation,
   prefix, suffix, hash or alias logic exists. A `server` that is not declared (for
   example `Plane`) is refused.
3. Not trusted (unknown, corrupt, modified, or unreadable): default-deny of every tool
   call whose name is not exactly a Pi base tool or an AIES-registered tool
   (`NON_MCP_TOOL_NAMES`). There is no positive exception for Linear: Linear is blocked
   too until the profile is repaired. The message says how.
4. Session snapshot: trust is decided when the extension loads and the raw text of the
   profile files is kept. A call is trusted only if the profile was trusted at load and
   is byte-identical now, so editing the profile can only lower trust, never raise it
   (the adapter does not hot-reload; a hostile profile that is "fixed" mid-session stays
   untrusted).
5. No path guard on the profile files. A first version refused the Parent's `edit` and
   `write` on them; the independent verification showed it was bypassable (`@` prefix,
   `file://`, case-insensitive paths, because it did not resolve paths like Pi), and the
   user chose to remove that layer instead of adding path normalisers. Limitation: the
   Parent's `edit`, `write` and `bash` can change `$AIES_HOME/agent/mcp-adapter.json`,
   `mcp.json`, `aies.json` or `settings.json`. This cannot unlock MCP in the running
   session (point 4) and any untrusted result is fail-closed on the next start. The Worker
   is confined to its workspace (its sandbox writes only to workspace and tmp).
6. Listed tool form. The adapter lists Plane's tools as `plane_<tool>` and resolves that
   name inside the server it is given, so its own search output steers the model to it.
   With `server` exactly `plane` or with no server (the model often omits it), the exact
   form `plane_<tool>` for a known Plane tool is read as `<tool>` and gets the same
   closed-list rules; any other prefixed name (unknown tool, doubled prefix) stays unknown
   and refused. Only Plane lists a `plane_` name on a trusted profile, so a server-less
   name cannot reach Linear. Found in the phase 5 real
   run (`plane_project` blocked on a trusted profile).
7. Extending the trusted set is one change: add the server to `profile/mcp-adapter.json`
   (Engram joins that way when D34 is implemented, after Plane is validated). Custom
   servers are not usable until then; that limitation was accepted by the user.

**Removed.** `linear/plane-endpoints.ts`, `linear/adapter-names.ts`, the name
reconstruction in `linear/pending-action.ts` (892 to 674 lines; with `trust.ts`, a net
reduction of 175 lines), and the generative, name-forms and endpoint-alias tests.

**Residual risks.** Edit/Write (and bash) of the Parent on the profile files are not
blocked (point 5). Trust is checked from the repo template; whoever edits the repo
changes the approved set. The snapshot is taken per extension load, so a `/reload` of the
extension without the adapter reloading would re-take it (not closed). An endpoint reachable only through a
server that is in the template is, by definition, the approved one. The trust section of
`--aies-info`/the MCP diagnostic was not added.

**Tests.** `tests/mcp-trust.test.mjs`, `tests/plane-attribution.test.mjs` and the
adjusted `plane-*` tests.

**Status.** accepted; implemented.

---

## D39 - Plane phase 5, first real run: project reads work through OAuth and the trusted profile

**Context.** D33 phase 5 is the real validation against Plane Cloud, using an isolated
profile (`AIES_HOME=~/.local/share/aies-phase5`), OAuth only (`/mcp-auth plane`), no PAT,
and no write to Plane.

**Validated (observed).** Through AIES, on a profile judged trusted by D38, with the
adapter authenticated by OAuth: `plane_project` with `action: "list"` returned the three
projects of the workspace (AIES, CoreOS, Agent Workbench `EZEQU`), none archived. The read
went through the `tool_call` guard as a read. Plane's 30 tools were listed by the adapter.

**Not validated yet.** Reading a work item by `PROJECT-N` identifier, reading the states of
`EZEQU` and resolving `start` by the name "In Progress", any state change, any comment, and
the end-to-end `aies_ticket` cycle (start, comment, complete with the Done Gate). No write to
Plane has been made and no ticket has been created or modified.

**Findings of the run (both fixed or documented, neither relaxed the trust predicate).**
1. The adapter's `/mcp` panel writes `directTools` into `mcp-adapter.json` when its
   settings are saved (`config.ts`, `writeDirectToolsConfig`). One save put
   `"directTools": true` on `plane`, which D38 judges untrusted, so the session failed
   closed and blocked every MCP tool, as designed. The seed does not repair it (it never
   changes a server that exists). For the isolated test profile the file was restored from
   the template, with a backup, and locked with the immutable flag. Limitation: saving the
   `/mcp` panel makes the profile untrusted until it is restored. Whether to document it or
   change the policy is open and was not decided here.
2. The adapter lists Plane's tools as `plane_<tool>` and the model calls them that way,
   with or without `server`. The first guard knew only the bare names and refused a read.
   D38 point 6 now reads the exact form `plane_<tool>` as `<tool>`.

**Status.** accepted; project reads validated, everything else in phase 5 pending.

---

## D40 - Plane selected per profile, explicit repository binding, and no more aies-phase5 profile

**Context.** The tracker is chosen by the `tracker` key of the profile (D33), and the
repository <-> project binding is the `repos` table of the same file (D30). No command
wrote either. Binding a repository meant editing JSON by hand, and a session started in an
unbound repository gave no sign of it until a ticket was blocked. The `aies-phase5`
profile (D39) existed only to hold `tracker: "plane"` for the Plane runs.

**Decision.**
1. Plane is selected per profile, with `tracker: "plane"` in `aies.json`. The code default
   stays `linear`: an absent key, or a legacy snapshot, still reads as Linear. No
   identifier, ticket or environment variable selects the tracker.
2. The binding is explicit and stored only in the profile. `scripts/bind-project.mjs`
   (`npm run bind`) writes the `repos` table. It requires a repository inside a git work
   tree and stores the realpath of its toplevel. It requires an identifier of letters,
   digits and underscores, stored in uppercase. It refuses a path already bound to another
   project, or a project already bound to another path, unless `--force` is given. Nothing
   is inferred from directory names; the name fallback of D30 applies only to unbound
   repositories.
3. `--tracker plane` sets the key only when it is absent or already `plane`. Switching
   from an explicit `linear` needs `--force`.
4. Every write is atomic (temp file and rename, file mode kept) and preceded by a
   timestamped backup, `aies.json.bak-<timestamp>`, in the profile. Keys other than `repos`
   and `tracker` are preserved as they are.
5. The script resolves the profile as `bin/aies` does, and refuses a profile that does not
   exist yet: the user runs `aies` once first. It reads only `aies.json`. It never reads
   `auth.json` or any MCP file, and it never copies credentials.
6. At startup, with a UI, the session shows one line: the tracker in use, and whether its
   repository is bound. An unbound repository gets a warning with the exact command to bind
   it. A directory outside git gets a warning that ticket work needs a git repository. The
   notice never blocks startup. `aies --aies-info` adds `AIES_PROJECT_ROOT` and `tracker`.
7. The `aies-phase5` profile is no longer needed once the canonical profile
   (`~/.local/share/aies`) has `tracker: "plane"` and Plane's OAuth is done interactively
   in it. Credentials are never copied between profiles: the login is repeated in the
   canonical profile, and the phase-5 profile can then be deleted.

**Rejected alternatives.**
- Inferring the binding from directory names: a name can match more than one repository,
  which is the ambiguity D30 already has to guard against.
- A `/aies-bind` command inside the session: it would give the agent a write path into the
  profile. A script run by the user keeps the write explicit and out of the agent's reach.

**Status.** accepted; implemented with tests (`scripts/bind-project.mjs`, the startup
notice, the `--aies-info` lines). Not yet exercised against Plane Cloud from the canonical
profile; that run belongs to phase 5 (D39) and is still pending.

---

## D41 - Mem0 as the single persistent memory of AIES (replaces D34 for AIES)

> **Superseded by D42 (discarded).** Mem0 needs an embedding model for every save and
> search, against the zero-cost, no-model-call requirement. The text below is kept as
> history; the findings that still apply are summarised in `docs/MEMORY.md` section 9.

**Decision.** Full design in `docs/MEMORY.md` (the Mem0 design itself was replaced).
1. Mem0 OSS (`mem0ai/oss`, Node library, pinned version) is the only persistent memory
   of AIES. D34 (Engram) is superseded for AIES. The Engram installation used by other
   tools is not touched and AIES does not read or write it.
2. The integration is an in-process extension of the Parent (`extensions/aies-memory/`).
   No MCP server, no Docker, no Python, no permanent service. Children keep no extensions
   and no MCP (D17 item 9), so the Parent is the single reader and writer.
3. Memories are written curated (`infer: false`): the Parent writes distilled, verified
   facts. Mem0's v3 automatic extraction is add-only and costs one LLM call per write, so
   it is not used.
4. One SQLite store per scope under `$AIES_HOME/memory/`, where the scope is the project
   key of the D40 binding. Tools take no scope argument; the scope is derived from the
   active binding on every call and fails closed on any mismatch.
5. Memory is recovery context, never authority (D34 item 7 stays): Git, code and
   `docs/DECISIONS.md` win. Retrieved text is injected as ephemeral, delimited data and is
   never an instruction. Memory never enters the Done Gate and never writes into a product
   repository.
6. Only the user deletes or edits memories. The Parent may supersede its own.

**Why.** D34 was accepted but never implemented, so superseding it costs nothing. A
library in the Parent process avoids a second trust template (D38), a process per
session and a service. Curated writes keep unverified conversation out of memory and keep
the model cost of memory at zero.

**Consequence.** First native runtime dependency (`better-sqlite3`) and a third-party one
(`mem0ai`). Nothing is implemented by this decision; phase P0 of `docs/MEMORY.md` is a
spike with a go/no-go.

**P0 spike findings** (details in `docs/MEMORY.md` section 7). Metadata-only `update()`
works; the native build loads from a prebuilt binary; telemetry is on by default and
contacts two external hosts unless `MEM0_TELEMETRY=false` is set before import; `infer:
false` does not deduplicate; `"*"` is accepted as a scope id; `delete` leaves the text in
the history database; the credential comes from `ctx.modelRegistry.getApiKeyForProvider`;
`context`, `registerTool` and `registerCommand` exist in Pi 0.85.1.

**Open.** Real embedding latency, search quality and cost are not measured: no embedder
credential was available in the spike. The embedder choice remains a user decision.

**Status.** Superseded by D42 (discarded before P1). It was never approved or implemented.

---

## D42 - ProjectMem as the persistent memory of AIES, through a CLI bridge (supersedes D41)

**Decision.** Full design, spike and plan in `docs/MEMORY.md`.
1. ProjectMem (`projectmem==0.3.4`, MIT, Python) is the storage engine of AIES memory. No
   embeddings, no model calls, no permanent service. D34 stays superseded for AIES; Engram
   and Mem0 are not part of AIES.
2. The integration is one in-process extension of the Parent, `extensions/aies-memory/`,
   that runs the `pjm` CLI with a `cwd` and `PROJECTMEM_HOME` chosen by AIES code from the
   D40 binding. No MCP server in the runtime, so the closed MCP trust profile (D38) and the
   no-MCP rule for children (D17 item 9) are unchanged.
3. One store per project key under `$AIES_HOME/memory/<projectKey>/.projectmem/`, outside
   every repository. `pjm init` is never run on a real repository; no hooks, no watcher, no
   `CLAUDE.md`/`AGENTS.md` edits, no `pjm doctor --fix`. Global (cross-project) memory is not
   exposed.
4. Parent reads and writes (five defined cases, guarded by an AIES secret filter and size
   cap); Explore and Worker receive only what the Parent passes; Verify receives constraints
   and decisions, never attempts. Retirement is `--supersedes`; the user edits the log.
5. Memory is recovery context, never authority: code, user instructions, `docs/DECISIONS.md`
   and AIES protections win. It never enters the Done Gate. If `pjm` is unavailable, AIES
   works without memory.

**Why.** It meets the zero-cost, no-model, local, per-project requirements. Plain JSONL is
portable. A CLI bridge reuses the Parent-only, in-process pattern and avoids widening the
MCP trust profile; the pinned `pjm-mcp` would isolate correctly but add a stdio entry that
children could not use anyway.

**Spike findings** (`docs/MEMORY.md` section 6, executed in a throwaway directory). `init`
with every `--no-*` flag creates only `.projectmem/` and a `.gitignore` in the target; the
`pjm-mcp --root` pin refuses a foreign `project`; records persist across processes;
`--supersedes` removes a decision from recall; ProjectMem's redaction caught `sk-...` but not
`password=hunter2`; `pjm --help` without `PROJECTMEM_HOME` wrote a stray
`~/.projectmem/projects.meta.json` (the wrapper must always set the variable).

**Consequence.** Python becomes an optional dependency (an AIES-owned venv). Retrieval is
lexical only.

**Git-history features.** With the store outside the repository, ProjectMem's staleness
check runs `git log` in the store directory, which is not a repository, so it does not work
(checked). AIES V1 therefore never calls `brief`, `precheck` or relies on staleness.

**Status.** Accepted (approved by the user; phases 1 to 3 implemented and verified). The
adapter, the read tools `aies_memory_search`/`aies_memory_context` and `/memory` exist.
Automatic injection of recalled text was removed: Pi 0.85.1 turns every custom message into
the user role and has no lower-trust role, so memory reaches the model only as the result of a
real tool call. Automatic writes exist only behind a code gate after a confirmed Done and with
`memory.writes: true` (off by default); the model-facing `aies_memory_record` tool was
retired. Details: `docs/MEMORY.md` sections 11 and 12.

---

## D43 - Subagent monitor V1: passive observation, partial cost never a total, context only from `getContextUsage`

**Decision.**
1. The rail's `Agents` section and `/agents` become a readable monitor of Explore, Worker
   and Verify. It is passive observation: no new capability, no change to delegation,
   limits, sandbox, Verify or cancellation.
2. The child observer samples `getSessionStats()` (token breakdown, cost) and
   `getContextUsage()` on the existing `turn_end` / `agent_settled` / `agent_end` events.
   No timer, no polling, no model call; each read is guarded on its own, so a failing
   metric never fails the run.
3. Context (`contextTokens`, `contextWindow`, `contextPercent`) comes only from
   `getContextUsage()`. Unknown or `null` (for example after a compaction) renders
   `ctx desconocido`, never a bar derived from accumulated tokens.
4. Cost keeps "unknown is null, never zero" (D20). A subscription model shows `coste n/d`;
   a total with any unknown agent cost is marked `$x+ parcial`, or `coste n/d` when none is
   known, and is never shown as complete.
5. Secrets (keys, Bearer, `sk-`, `ghp_`, JWT, `password=`/`secret=`, `KEY=value`, URLs with
   credentials) are redacted before an activity, error, result or label is stored in the
   registry, so no surface can show them. Bash commands stay unshown (category only).
6. The rail grows from 46 to 58 content columns from 160 terminal columns; the 120-column
   floor and the D25 version guards are unchanged. Rejections before start (sandbox,
   stale runtime) are not recorded in V1.

**Why.** The rail showed only a state word per agent. The new data is already exposed by
Pi, so reading it passively costs nothing and cannot touch the run, while redacting at the
source is the only place that covers every present and future surface.

**Appendix (cost, context, cache).**
- Cost under a subscription is an API-equivalent estimate, never billed spend. The child
  record carries `billing` (`subscription` | `api` | `null`), probed once and passively
  from the public `ModelRuntime.isUsingSubscription(providerId)` (an OAuth credential of a
  provider that declares `isSubscription`; openai-codex does), plus the pre-existing
  provider-id heuristic `isSubscriptionOrPlan`. OAuth that is not a declared subscription
  (for example a free tier) stays `null` (unclassified); no OAuth is `api`. It is never
  inferred from a model id; a missing, non-boolean or throwing probe leaves `null`.
  Estimates render with `≈`; a known cost with unknown billing is never shown as billed:
  totals read `≈$x est.`, `$x sin clasificar`, or `$a API + ≈$b est. + $c sin clas.` when mixed,
  and keep the `+ parcial` rule when any cost is missing. The footer puts the cost first and
  falls back to a compact wording and, only as a last resort, to `s/c`, so the qualifiers survive a 46-column rail. The Status block's Main/Agents/Total (D20) is
  unchanged and does not distinguish estimates.
- A real context percent above 0 and below 1 renders `<1%`; exactly 0 renders `0%`.
- The total token count may include cache, so it need not equal input + output; the rail
  adds `+caché` when cache tokens were measured and `/agents` states it.

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

---

## D44 - The stale-runtime guard blocks only on modules the Verify child loads (refines D31)

**Decision.**
1. D31 stays: a stale module the Verify child executes blocks the delegation with
   `stale_runtime` and a relaunch instruction. No override, no hot reload.
2. What counts as stale is now scoped. `verifyHarnessModules()` computes the static
   import closure (value imports, `export ... from`, side-effect and dynamic
   `import("./x")`; `import type` is erased) of `verify.ts` and `session.ts` inside
   `extensions/`: 13 modules today (verify, verify-guard, command-guard, sandbox, session,
   handoff, model, tgrep, verification, permissions, aies-models/capabilities, aies-ui/
   approval and format). `checkVerifyHarnessFreshness()` reports only those. If the closure
   cannot be computed with confidence (unreadable file, unresolvable import) it falls back to
   the whole `extensions/` tree, exactly D31.
3. Why this is sound: a Verify child is created with `noExtensions` and customTools built
   from that closure, so a module outside it (UI, design, memory, runtime) cannot change what
   the child runs; its verdict comes from `read`/`bash` checks on the working tree, which run
   in fresh subprocesses. An in-process Verify therefore stays valid, runs the code the
   Parent already trusts, and uses the Parent's own provider and model (any provider,
   including extension-registered and subscription ones) without moving credentials.

4. Also watched, because they do run in the child: `aies-provider-*` extensions (the model
   transport is copied into the child runtime by `createChildModelRuntime`) and the commandcode
   `models.json` catalog. A loading form the scan cannot follow (`require(`, `createRequire`,
   `import.meta.resolve`, `import(<non-literal>)`) makes the closure unknown and falls back to
   the whole tree.

**Why.** The self-hosting loop (AIES-21) blocked every Verify after a Worker repaired UI or
design code the child never loads, and relaunching only helped until the next repair.

**Rejected.** Running Verify in a fresh child process (first D44 draft, removed): it executes
Worker-edited code outside the OS sandbox, which covers only Verify's bash and cannot be nested
on macOS, with the user's environment and `auth.json` within reach; reducing the credential
exposure does not remove the risk. Hot reload and auto-restart: see D31.

**Consequence.** Edits to the Verify harness itself (the 13 modules) still require a relaunch
before verifying, which is intended: that code is what judges the work. Everything else
verifies without relaunch. The closure is derived from the code, not listed by hand, so it
follows future imports.

**Validation.** Unit and integration tests with a simulated model, plus one real run with
`openai-codex/gpt-6-luna` in a disposable profile and repo: Verify FAIL on a seeded defect,
Worker repairs `aies-design`, Verify PASS in the same process (the D31 whole-tree guard would
have blocked here), Done Gate allowed; touching `verify.ts` blocks with `stale_runtime` and no
model call. The AIES-21 Verify PASS (8/8) was obtained the same way.

**Known issue, not a decision.** The profile's configured Verify model
(`openai-codex/gpt-6.1-sol`, high effort) failed twice on the AIES-21 verification: first a
`protocol_error`, then a 15-minute child timeout without output; the sandbox commands answered
in under 0.5 s, so the stall is model-side. The PASS used `gpt-6-luna` through a temporary
`AIES_VERIFY_MODEL` override for that run only; the profile configuration was not changed.

---

## D45 - `/aies-design` lifecycle: guidance, not gates; no residual turn; the model closes it (AIES-21)

**Decision.**
1. Design is a session-local, opt-in mode with no persistent agent, no registered tool and
   no persisted state. Its guidance reaches the model through the kickoff and a per-turn
   hidden context message, both tagged with a workflow UUID and dropped by the `context`
   hook once the workflow is no longer the active one.
2. Inspection before design is a workflow instruction (inspect the real project, never ask
   what it can answer) and not a tool gate: a gate cannot tell a trivial objective from one
   that needs reading. Explore is used only when inspection leaves relevant context missing
   or the project is too large, and only if `aies_delegate` exists.
3. A kickoff sent while the session is busy is delivered `nextTurn`, never as a queued
   follow-up. Pi gives extensions no way to withdraw a queued follow-up, so a cancel after
   queuing would still be followed by a turn; a stored next-turn message cannot cause one.
4. The workflow closes on `/aies-design cancel|exit|complete|done`, on the plain-text
   cancellations, on session start/shutdown, or when the final assistant message ends with
   a line containing exactly `AIES_DESIGN_DONE`.

**Consequence.** Behavioural guarantees that depend on the model (inspecting first, using
Explore sensibly, emitting the marker) are validated with a real model, not with mocks;
mocks cover routing, isolation and closing.

## D46 - Done needs a bound Verify PASS or the user's no-code exception, never "nothing visible" (refines D14)

**Decision.**
1. The Done Gate no longer reads "no changed paths" or "documentation-only" as "no
   verification needed". Without a valid PASS bound to the working tree, completion is
   refused, whatever Git shows. This closes the case of a ticket loaded after its
   implementation was committed: the baseline then sees no change.
2. `fail`, `blocked` and `running` always refuse, with or without visible changes.
3. The only way to complete without a PASS is `/aies-ticket no-code <reason>`, a slash
   command and therefore user-only. It is recorded per ticket, persisted in the snapshot,
   cleared on load/reset, never an `aies_ticket` action, and it does not outrank a visible
   code change, a standing Verify verdict, a pending final action or unknown Git evidence.

**Consequence.** Documentation-only tickets also need the exception or a PASS (D14 allowed
them to complete silently). Parent cannot declare a ticket code-free by itself.
