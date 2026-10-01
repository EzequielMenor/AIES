# AIES hotfix - Linear MCP integration and parent-mediated transport

Status: complete (one interactive check handed to the user)
Branch: `fix/aies-linear-mcp-auth`
Scope: Hotfix between AIES-010 and AIES-011. Two coupled defects found by the first
real `/aies-run` attempt:

1. The isolated AIES profile never loaded `pi-mcp-adapter`, so `/mcp` and
   `/mcp-auth` did not exist inside `aies`, while AIES-008's runtime transport
   told the user to run `/mcp-auth linear`.
2. AIES-008's `McpLinearTransport` never had a working caller. Pi exposes no
   programmatic tool invocation to extensions (`ExtensionAPI` offers
   `registerTool`, `getAllTools`, `setActiveTools`, `events` and `exec` only), so
   the `McpToolCaller` seam was never filled and the only live path was a bogus
   `LINEAR_API_KEY` fallback.

## Root cause (evidence)

- `aies --aies-info` resolves `PI_CODING_AGENT_DIR=$AIES_HOME/agent`; the seeded
  `profile/settings.json` was `{"packages": []}` and
  `scripts/bootstrap-profile.sh` only linked `agents extensions prompts themes`.
- `pi-mcp-adapter@2.34.0` lives in the ambient profile as a Pi *package*
  (`~/.pi/agent/npm/node_modules/pi-mcp-adapter`, declared in
  `~/.pi/agent/settings.json`), so it loaded in `pi` and not in `aies`.
- The adapter's interop surface for other extensions is read-only: a versioned
  status channel, runtime *server registration*, and the `pi-mcp-adapter/oauth`
  token subpath. There is no extension-side tool caller.
- `extensions/aies-agents/linear/transport.ts` had no reader of
  `process.env.LINEAR_API_KEY` other than its own error branch.
- The issue payload AIES-008 assumed (`state: {id,name,type}`) is not what the
  official Linear MCP server returns: `status` and `statusType` are flat, the state
  id only appears in `stateHistory`, and `list_issue_statuses` requires `team`.

## User decision (locked)

**Parent-mediated transport (full).** AIES stops owning MCP transport. The
`LinearTransport` interface stays as the fakeable policy seam; the runtime
implementation delegates every remote read/write to the Parent agent through the
adapter's `mcp` proxy tool, using an explicit `remote_required` directive and a
pure replay cache.

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| H1 | Adapter ownership | The AIES profile declares `npm:pi-mcp-adapter`; Pi installs it into `$AIES_HOME/agent/npm/`. No fork, vendor, patch or copy. |
| H2 | MCP config ownership | Repo owns the declared template `profile/mcp.json`; the runtime file is `$AIES_HOME/agent/mcp.json`, seeded and reconciled idempotently by `scripts/seed-profile-config.mjs`. |
| H3 | Config isolation | `bin/aies` exports `PI_MCP_CONFIG_MODE=exclusive`, so the adapter reads only the profile's own `mcp.json`. |
| H4 | Tool surface | One server, no `directTools`, `scriptMode: false`: the `mcp` gateway plus (once cached) one `mcp__linear` namespace proxy. Zero Linear schemas. |
| H5 | Transport | `HostMediatedLinearTransport` throws `remote_required` with a directive; `TicketManager` keeps the pending directive plus the answers and replays the operation purely. |
| H6 | Credentials | OAuth tokens live in the OS credential store, keyed by server name and bound to the MCP URL. Nothing enters the repo or `mcp.json`. |
| H7 | Parent only | Children are created with `noExtensions: true` and explicit tool allowlists. |
| H8 | Headless | No AIES code path starts an OAuth flow. Interactive-only commands appear only in `tui`. |

## Work units

| Unit | Commit | Evidence |
|------|--------|----------|
| T1 profile MCP integration | `b0c4ce7` | Launcher reconciles idempotently (identical digests on a second run), user additions survive, a seeded `{"packages": []}` profile upgrades. Suite 299/299. |
| T2 real Linear payload | `2ea5a0b` | `get_issue`/`list_issue_statuses` captured live; `Status: Unknown` fixed, state id read from `stateHistory`, team captured, In Progress preferred over In Review. Suite 304/304. |
| T3 parent-mediated transport | `d895c0b` | `McpLinearTransport` and the API-key fallback removed; `HostMediatedLinearTransport`, directive types, answer unwrapping, the MCP status sensor and honest diagnostics added. |
| T4 commands and composition root | `7a4f04e` | `/aies-ticket` and `/aies-run` delegate on `remote_required` and stay synchronous with an in-process transport; the sensor is wired per session. Suite 342/342. |
| T5 child isolation tests | `0b975fb` | Child allowlists as exported constants, extension discovery off, no MCP tool/Linear schema/credential in a child, no AIES-sourced `mcp` command, no credential in the profile config, runtime artifacts ignored. Suite 349/349. |
| T6 documentation | `6396bf0` | README, ARCHITECTURE, UX and D17. |
| T7 exclusive-mode proof | `f75844f` | The adapter's own `loadMcpConfig` read against a sandbox home: with exclusive mode only `linear` is read; the control shows a host-global server being merged without it. |
| T8 measured surface correction | `ecc2b1a` | The adapter also registers one `mcp__<server>` namespace proxy once a catalog is cached; docs and the assertion now describe the measured surface (3647 bytes, zero Linear schemas). |
| T9 empty-snapshot fix | `d09d49c` | Found by the real command smoke: an empty status snapshot is not a missing server. Suite 352/352. |

## Real smoke evidence

- `aies --aies-info`: `PI_CODING_AGENT_DIR=/Users/ezequielmenor/.local/share/aies/agent`.
- RPC `get_commands` in the real profile: `mcp` and `mcp-auth`, both sourced from
  `~/.local/share/aies/agent/npm/node_modules/pi-mcp-adapter/index.ts`. Pi installed
  the declared package into the isolated profile on the first real run.
- RPC `/mcp status`: `linear: cached; not listening (disconnected) (66 tools, cached)`
  and footer `MCP: 1 server enabled` - configured, 66-tool catalog known, not
  connected. Lazy confirmed live.
- Headless EZE-422 read (print/json, `--model qwen-token-plan/qwen3.8-max`):
  tool sequence `aies_ticket` -> `mcp` -> `aies_ticket`, answer
  `EZE-422 - Status: Todo`. No API key, no browser.
- RPC `/aies-ticket EZE-422` after the T9 fix: footer `1 server enabled` ->
  `connecting to linear...` -> `1 server enabled (1 connected)`, tool sequence
  `aies_ticket` -> `mcp` -> `aies_ticket`, ticket contract returned with the status
  untouched.
- Proxy envelope verified against the live server: `mcp({server:"linear",tool:"get_issue",args:{id:"EZE-422"}})`
  returns the issue JSON directly.
- Surface measured in the real profile: `aies_ticket` 2184 B, `aies_delegate` 2031 B,
  `mcp` 3035 B, `mcp__linear` 612 B. The Linear catalog alone is 80338 B (66 tools).
- `npm run check:isolation`: 352/352, resolved profile report correct.
- Ambient `pi`: `settings.json`/`mcp.json` mtimes unchanged, and a real turn answered
  `PI-OK`.

## Deliberately not run

`/aies-run EZE-422` would start bounded autonomy on a real ticket and flip its Linear
status to In Progress, then delegate Explore/Worker/Verify to implement
`src/calculator.js` in whatever working directory the session has. That is a real,
user-visible mutation of the board plus real autonomous work in a project that is
not this one, so it is left to the user, in the target project, on request.

`/mcp-auth linear` needs a browser. On this machine it was not required: the adapter
reuses the OS credential record for server `linear` at `https://mcp.linear.app/mcp`,
which is why every real call above succeeded without authenticating again.

## Non-goals

No AIES-011 work, no additional MCP servers, no new direct tools, no Linear GraphQL
or SDK migration, no `/aies-linear-auth` wrapper, no polling, no second CLI.

## T10 - child Keychain access (AIES-006 invariant)

AIES-006 promises credentials stay in the Parent/host. OAuth broke that: the
adapter stores Linear's credentials in the macOS login Keychain (service
`pi-mcp-adapter.oauth`, account `sha256-<sha256("linear")>`), and a sandboxed AIES
child could still read them.

**Measured hole.** Through AIES's own production runner `executeSandboxedCommand`,
with an ACTIVE Seatbelt sandbox whose outside-write control correctly failed with
"Operation not permitted": role `worker` running `node` + `@napi-rs/keyring` (the
same primitive the adapter uses) returned `len=502` for the Linear credential, and
role `verify` returned the same `len=502`. `security find-generic-password -w` is
already blocked from any process by the item's ACL, so the CLI is not the hole; the
in-process `SecItemCopyMatching` path is.

**Cause.** `@anthropic-ai/sandbox-runtime` (0.0.76) hard-codes `(allow mach-lookup)`
for `com.apple.securityd.xpc` and `com.apple.SecurityServer` in its macOS profile
and exposes no option to withdraw them (`allowMachLookup` is additive).
`filesystem.denyRead` cannot help because securityd reads the keychain, not the
sandboxed process. Nested `sandbox-exec` is impossible (`sandbox_apply: Operation
not permitted`).

**Fix.** SBPL resolves an operation by its LAST matching rule, so
`withdrawKeychainAccess` appends denies for both Mach services after the runtime's
own security block, withdrawing Keychain access for the whole sandboxed subtree. It
fails closed: a profile without exactly one recognisable security block is refused
instead of run.

**Measured result after the fix.** `len=502` became `null`, while `node -e '1+1'`,
`ls`, `git status` and the outside-write denial all behaved exactly as before.
