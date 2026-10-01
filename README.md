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

> Phase status: isolated bootstrap (AIES-001), session metrics baseline
> (AIES-002), isolated child delegation (AIES-003 explore, AIES-004 worker and
> routing, AIES-005 independent verify), permission boundaries and OS sandbox
> (AIES-006), context governor (AIES-007), Linear ticket workflow (AIES-008),
> bounded task autonomy (AIES-009), and the Gentle-inspired presentation layer
> (AIES-010, see [docs/UX.md](docs/UX.md)).
> See [Scope](#scope).

## Requirements

- `pi` on `PATH`, any version providing `PI_CODING_AGENT_DIR`, verified against 0.85.1 and 0.87.0
- Node.js >= 22 (for the test suite and the dev-time type surface)
- bash

The optional right rail is a bounded enhancement, not a supported Pi surface.
It mounts only on a fullscreen host whose layout tree AIES recognizes; otherwise
the below-editor dock and narrow footer take over, with no workflow change.

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

Linear is read through the official Linear MCP server instead; that needs a one-time
`/mcp-auth linear` in an interactive session, described under "Linear over MCP".

## Profile layout

```
~/.local/share/aies/agent        <- PI_CODING_AGENT_DIR for every aies run
├── settings.json                <- seeded from profile/settings.json once, then owned by pi
├── mcp.json                     <- MCP servers AIES loads; seeded from profile/mcp.json, then reconciled
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
| `~/.config/mcp/mcp.json`, `~/.agents/mcp.json` (host-global MCP servers) | would add servers to every AIES session | `aies` exports `PI_MCP_CONFIG_MODE=exclusive`, so only the profile's own `mcp.json` is read |
| `.mcp.json` / `.pi/mcp.json` in the current directory | would add project-local MCP servers | same: exclusive mode ignores them |
| MCP OAuth credentials (OS credential store) | live outside the profile, by design of the adapter | keyed by server name and bound to the MCP URL; never copied into the repository or into `mcp.json` |

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

## Linear over MCP

AIES has no Linear client of its own. Linear is reached through the official Linear
MCP server, which the adapter loads in the AIES profile:

```text
aies  ->  /mcp-auth linear  ->  OAuth  ->  mcp proxy tool  ->  https://mcp.linear.app/mcp
```

One-time setup, in an interactive session:

```bash
aies
/mcp                  # "linear" must be listed and configured
/mcp-auth linear      # completes the OAuth flow in your browser
```

Then, in the same or a later session:

```text
/aies-ticket EZE-422  # loads the ticket and shows its compact contract
/aies-run EZE-422     # loads it, starts the work and enables bounded autonomy
```

`/mcp` and `/mcp-auth` come from `pi-mcp-adapter`; AIES does not wrap them. AIES
does not read `LINEAR_API_KEY`, so no environment variable is needed. If you prefer
a bearer token over OAuth, edit the server in `$AIES_HOME/agent/mcp.json`
(`auth: "bearer"`, `bearerTokenEnv: "LINEAR_API_KEY"`); that is a deliberate opt-out
of the OAuth path.

The Linear server exposes 66 tools. AIES keeps them behind the adapter's proxy
tools for that server (`mcp`, plus one `mcp__linear` namespace proxy once the
server's catalog is cached), so a session pays for two small definitions instead of
the catalog. `lifecycle: "lazy"` means no connection is made at startup, and
credentials are stored by the adapter in the OS credential store, never in this
repository.

## Command Code (GOAT plan)

`extensions/aies-provider-commandcode/` registers the `commandcode` provider, so the
whole Command Code catalog is selectable from `/model`, `/aies-models` and
`aies --list-models`:

```bash
aies
/login commandcode               # the ordinary path: the key lives in the AIES profile
```

`/login commandcode` is the ordinary, persistent path. Pi prompts for the key as
a secret, never echoes it, and writes it into `$AIES_HOME/agent/auth.json` as an
`api_key` entry with mode `0600`, so it survives restarts with no shell setup.
`COMMANDCODE_API_KEY` remains supported for CI, headless runs and testing, where a
fresh profile has no `auth.json`; a stored credential always wins over it. AIES
never reads or forwards the key itself: the extension declares
`apiKey: "$COMMANDCODE_API_KEY"` and Pi resolves it per request.

The catalog loads either way. With no credential at all Pi still registers the
provider but reports zero available `commandcode` models — the models are simply
not selectable, which is expected and is now surfaced by `/aies-models` as a
`no conectado` provider instead of being invisible.

| Item | Value |
|---|---|
| Provider id | `commandcode` (models are `commandcode/<id>`) |
| Base URL | `https://api.commandcode.ai/provider/v1` |
| Models | 76 registered: 68 on `openai-completions`, 8 Claude rows on `anthropic-messages` |
| Diagnostic | `/aies-commandcode` — catalog size per transport, base URL, the registry auth source and `disponibles n/76` |

### The catalog is static, on purpose

Pi can fetch a provider catalog at load time; AIES does not, because startup must
be deterministic and zero-network (`scripts/check-isolation.sh` proves it). The list
lives in the repository as `extensions/aies-provider-commandcode/models.json`:

```bash
# maintenance only — requires network, never run by tests, hooks or the launcher
node scripts/refresh-commandcode-models.mjs
node scripts/refresh-commandcode-models.mjs --models-json saved.json --docs-html saved.html  # offline rerun
```

What the generator encodes, and what it cannot know:

- **ids** are copied verbatim from `GET /provider/v1/models`, including the vendor
  prefix (`deepseek/deepseek-v4-flash`) that open-weight families use and the bare
  form the first-party families use. The one id the endpoint spells with a snapshot
  date (`claude-haiku-4-5-20251001`) keeps the endpoint form, not the docs form.
- **`api`** is `anthropic-messages` only for models served on `/messages`, and
  `openai-completions` for the rest. 60 of them also advertise `/responses`, which
  AIES does not use.
- **`cost`** is the base list price per 1M tokens published on the GOAT plan page.
  Time-limited deals are ignored on purpose: the catalog stores the list rate
  (e.g. MiniMax M3 at `0.60/2.40`, not the discounted `0.30/1.20`). The two free
  models publish no list rate, so they stay at `0` and cost tracking under-reports
  them. Long-context price steps are collapsed into the standard tier.
- **`maxTokens`** is an assumption, not a vendor limit: neither the endpoint nor the
  docs publish a maximum output length, so the generator writes
  `clamp(floor(contextWindow / 4), 8192, 64000)`. The assumption is backed by a
  measured override map in the generator, because the clamp proved wrong for at
  least one model: `poolside/laguna-s-2.1-free` advertises a `64000` clamp but the
  API caps output at `32768`, so the catalog stores the measured value. Without an
  override the failure mode is a provider HTTP 400 that names the cap
  (`max_tokens (64000): Input should be less than or equal to 32768`).
- **`input: ["text", "image"]`** only where the docs mark the model as vision.
- `gpt-6-astra` appears on the plan page but is not served by the provider API, so
  it is not registered; a refresh prints those differences instead of guessing.

## Repository layout

| Path | Role |
|---|---|
| `bin/aies` | the launcher: resolves the profile, bootstraps it, execs `pi` |
| `scripts/bootstrap-profile.sh` | idempotent profile setup (symlinks, settings seed) |
| `profile/settings.json` | seed for the profile's `settings.json`, copied once |
| `profile/aies.json` | seed configuration for AIES agents, copied once |
| `agents/explore.md` | role prompt for the isolated explore child agent |
| `agents/worker.md` | role prompt for the isolated worker child agent |
| `agents/verify.md` | role prompt for the isolated read-only verify child agent |
| `extensions/` | AIES extensions, linked into the isolated profile |
| `extensions/aies-identity.ts` | profile visibility: startup notice and `/aies-info` |
| `extensions/aies-runtime/` | session metrics: footer line, `/aies-status`, no behavior changes |
| `extensions/aies-agents/` | agent delegation: the `aies_delegate` tool, the three child runners, routing and the verification record |
| `extensions/aies-provider-commandcode/` | the `commandcode` provider and its committed static model catalog |
| `extensions/aies-providers/` | provider credential health: a `turn_end` observer that records a rejected credential, no command |
| `scripts/refresh-commandcode-models.mjs` | regenerates that catalog; manual, the only Command Code script that needs network |
| `tests/isolation.test.mjs` | deterministic isolation checks (no credentials) |
| `tests/observability.test.mjs` | metric rules and rendering, driven through a fake `ExtensionAPI` |
| `tests/observability-runtime.test.mjs` | the observer inside a real Pi process, over RPC |
| `tests/explore.test.mjs` | child exploration isolation, tool surface, handoff & execution |
| `tests/worker.test.mjs` | worker isolation, mutation, command guard, routing handoff |
| `tests/routing.test.mjs` | the deterministic routing policy and its guardrails |
| `tests/verify.test.mjs` | verify read-only policy, independence, verdicts, invalidation, repair budget |
| `tests/smoke-verify.test.mjs` | Parent -> Worker defect -> Verify FAIL -> repair -> Verify PASS |
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
aies          # while verifying:  AIES · VERIFY · ctx 44k · V:? · 02:11
aies          # after a verdict:  AIES · ctx 46k · V:PASS · 02:28
/aies-info    # prints the extension path, agent dir, project config dir, cwd, mode
/aies-status  # the same metrics unfolded: context, tools, exploration, delegations, verification, runtime
pi            # your normal Pi must still start exactly as before
```

The metrics line and `/aies-status` come from
`extensions/aies-runtime/`. They measure and never govern: no counter, ratio or
threshold changes what Pi does with a tool call, a delegation or a compaction.
`V:` is the verification segment: `?` in flight, `PASS`, `STALE` (a PASS the
artifact outgrew), `FAIL`, `BLOCKED`.

## Independent verification

`aies_delegate` has a third role. Worker changes the repository; Verify proves
whether the change actually works, from the repository itself:

```ts
aies_delegate({
  role: "verify",
  task: "Bring the request timeout to 2000ms",
  criteria: ["TIMEOUT_MS in config.js is 2000", "npm test passes"],
  changedPaths: ["config.js"],
  baseRef: "HEAD~1",
})
```

- the child is isolated, has no `edit`/`write`, and its `bash` refuses to mutate
  the workspace (mutating git, deletion, movement, in-place editing, installs,
  file redirection, command substitution);
- it answers `pass | fail | blocked` with per-criterion evidence, checks and
  defects, never a transcript, and a PASS without evidence is treated as blocked;
- free-form `context` is rejected for this role, so the implementer's summary and
  reasoning cannot reach the verifier;
- a PASS is tied to the behaviour-bearing revision it verified: a later code edit
  or Worker run makes it stale (the footer says `V:STALE`), a documentation-only
  edit does not;
- a FAIL can be repaired twice, and a failure that repeats its signature stops the
  loop early. The repair Worker receives the defects, not the Verify transcript.

Suggested checks run through the guarded shell; a check that cannot run is
`blocked`, which is not the same as a defect.

## Scope

Phase 1 shipped: repository structure, profile isolation, the `aies` command,
minimal configuration, one identity extension, and the isolation checks.

Phase 2 shipped the observability baseline: one footer line and one diagnostic
command, measuring context, parent tool activity, exploration, tool output
volume, session runtime and tool surface.

Phase 3 shipped the isolated explore delegation primitive. Phase 4 shipped the
isolated Worker and the parent routing policy (Inline Direct, Explore, Worker)
with soft signals and hard guardrails. Phase 5 closed the verification loop with
an independent, isolated Verify role. Phase 6 shipped permission boundaries and
OS-level sandboxing with Darwin Seatbelt. Phase 7 established the Context
Governor with operational budgets, proactive single-flight compaction, and
tool-output hygiene.

Phase 8 established the Linear Ticket Workflow:
- the Parent session is the sole owner of Linear workflow; child agents have zero Linear tools or schemas;
- raw issue payloads normalize into compact contracts (< 2,500 chars) with explicit criteria extraction;
- transport abstraction with deterministic in-memory fakes and typed MCP integration;
- programmatic Done Gate strictly requiring fresh valid Verify PASS for behavior-bearing changes;
- remote conflict detection before completion;
- snapshot persistence across session boundaries.

Phase 9 establishes Bounded Task Autonomy & Continuation Controller:
- single continuation authority (`ContinuationController`) evaluating at `agent_settled`;
- single-flight follow-up message (`/aies-run [ticketId | stop | status]`);
- strict ordering with Context Governor: compaction is strictly awaited to `onComplete` before continuation;
- safe stopping on completion, permission prompt (`ask`), verification stop, or blockers;
- circuit breakers: 20-continuation ceiling and 3-consecutive-identical-fingerprint progress check;
- session resume safety: restored sessions restore ticket and metrics but remain paused (`enabled = false`).

Phase 10 (current) establishes the presentation layer (see [docs/UX.md](docs/UX.md)):
- one workflow vocabulary (`IDLE, EXPLORE, WORK, VERIFY, REPAIR, WAIT, BLOCKED, DONE`) plus independent indicators;
- a quiet one-line footer (`AIES · EZE-417 · WORK · ctx 42k · AUTO`) that degrades by priority on narrow terminals;
- one live widget per running child plus one durable, context-free line per finished child;
- actionable permission prompts, and explicit BLOCKED/DONE summaries;
- a human `/aies-status` view with the full telemetry dump moved behind `/aies-status detalle`;
- no new agents, no new subsystems, no own UI framework: UI is a projection of runtime state.

Explicitly out of scope: infinite multi-ticket backlog runners, unmonitored git push/PR, and background auto-polling.
