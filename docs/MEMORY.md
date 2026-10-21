# AIES memory: ProjectMem integration plan

Status: accepted (D42, which supersedes the discarded Mem0 plan D41). Phase 1 (P1 bridge plus
manual tools), phase 2 (recall) and phase 3 (gated automatic writes) are implemented and
verified; see sections 10 to 12. Automatic injection of recalled text was removed (section 11);
automatic writes exist but `memory.writes` stays off by default.
Facts about ProjectMem come from its README and source at version 0.3.4 (October 2026) and
from the isolated spike in section 6. Every claim is labelled **executed** (run in the spike),
**read** (read in the source, not run) or **unverified**.

Why not Mem0: it needs an embedding model (a paid API or a local service) for every save and
search. The requirement is zero extra cost, no model calls and no resident service. The Mem0
analysis is kept in section 9 only for the findings that still apply.

## 1. What ProjectMem is (verified)

- Python package, MIT, version 0.3.4, `requires-python >= 3.10`, dependencies `typer`, `mcp`
  (< 3) and `watchdog`. Entry points `pjm`, `projectmem` and `pjm-mcp`. Installs and runs on
  macOS arm64 with Python 3.14 (**executed**).
- Storage is plain files in `<root>/.projectmem/`: `events.jsonl` (append-only log, source of
  truth), `summary.md` (regenerated), `config.toml`, `plan.md`, `PROJECT_MAP.md`,
  `AI_INSTRUCTIONS.md`. No database, no index (**executed**).
- Event types: `decision`, `issue`, `attempt` (`worked`/`failed`/`partial`), `fix`, `note`.
- Search is a case-insensitive substring (or regex) scan of the whole log. No embeddings, no
  ranking (**read**; substring matching **executed**). `pjm context --tokens N [--focus PATH]`
  builds a token-budgeted briefing: warnings (failed attempts), recent decisions, relevant
  fixes (**executed**).
- Superseding: `pjm decision "..." --supersedes <evt_id>` keeps the old event, marks it
  `(superseded)` in search, and drops it from `context` (**executed**). Nothing is ever
  deleted. Staleness checks against git history exist for decisions that cite files (**read**,
  not run).
- No telemetry. The only network call in the source is `pjm doctor --online` (**read**). All
  spike commands ran with a dead proxy in the environment and succeeded (**executed**; weak
  evidence, the source reading is the stronger one).
- MCP server `pjm-mcp`: 17 tools, 12 read and 5 write (`log_issue`, `record_attempt`,
  `record_fix`, `add_decision`, `add_note`). Every tool takes an optional `project`.
  Started with `--root <dir>` it is **pinned**: any `project=` naming another root is refused
  with `ResolutionError`, for reads and writes (**executed**, section 6).
- Secret redaction exists but is narrow (`sk-`, `ghp_`, `AKIA`, JWT, Bearer, PEM, Slack,
  Stripe, Google keys), runs inside `append_event`, swallows its own errors and can be turned
  off with `PROJECTMEM_NO_REDACT`. `sk-...` was redacted; `password=hunter2` was **not**
  (**executed**). It is a safety net, not a filter.
- `pjm init` (**read**): creates `.projectmem/`, edits `.gitignore`, creates or edits
  `CLAUDE.md` and `AGENTS.md`, installs git hooks, starts a file watcher, backfills 20 commits,
  reads global memory. Flags that disable each of these: `--no-hooks --no-watch --no-backfill
  --no-global --no-claude-md --no-stack-detect --no-structure --no-mcp-config`. With all of
  them in a non-git directory it created only `.projectmem/` (6 files) and a `.gitignore` in
  that directory (**executed**). `pjm doctor --fix` registers projects found under common
  folders; it must not be run.
- Hooks (**read**, not installed in the spike): pre-commit runs `pjm precheck ... || true` in
  the foreground (cannot block), post-commit and post-merge run in the background. They ignore
  `core.hooksPath` and `.git` files (worktrees). AIES does not install them.
- Global memory (`$PROJECTMEM_HOME/global`, default `~/.projectmem/global`) is fed
  automatically from failed attempts and `gotcha:`/`lesson:` notes, with no off switch
  (**read**). The registry (`projects.json`) and a meta file live in `$PROJECTMEM_HOME`.
- **Pitfall found (executed).** With `PROJECTMEM_HOME` unset, even `venv/bin/pjm --help` of
  0.3.4 wrote `~/.projectmem/projects.meta.json`. This happened once during the spike (see
  section 6). The wrapper must always set `PROJECTMEM_HOME`.
- The machine already has a global `pjm 0.2.0` and a `~/.projectmem` registry with four
  projects. It was not modified, and AIES must never use it.

## 2. Compatibility with AIES (audit)

| Area | Finding | Consequence |
|---|---|---|
| Children | `executeChildSession` (`extensions/aies-agents/session.ts:440`) uses `noExtensions`, `noSkills`, an in-memory session and no MCP (D17 item 9) | Only the Parent can reach memory; a child never gets a memory tool |
| MCP trust | `mcp/trust.ts` is a closed profile: `PI_MCP_CONFIG_MODE=exclusive`, servers must match `profile/mcp-adapter.json` by name, `url` and `auth` | A stdio `pjm-mcp` does not fit without widening D38; not worth it |
| Context | `before_agent_start` (`aies-identity.ts:50`), `session_start` (`aies-agents/index.ts:443`), Pi `context` event | Ephemeral injection point already exists |
| Identity | D40 binding: `repos` table in `aies.json`, `resolveRepoIdentity` (`repo-guard.ts:75`), project key via `checkTicketRepo` | Stable store key, independent of model text and of the path |
| Done Gate | Counts non-ignored files in the repository (`linear/change-evidence.ts:95`) and compares a Git fingerprint (`linear/manager.ts:177-205`) | The store must live outside every repository |
| Budgets | `profile/aies.json:17-22`, defaults in `context-governor.ts:63-68` | Recall has its own hard cap inside that envelope |
| Hard rules | Nothing under `AIES_HOME` in git; Pi public API only; no premature abstraction; tests with a temporary `AIES_HOME` | One module, CLI bridge, no interface layer |

## 3. Recommended architecture (single option)

ProjectMem is the **storage engine**, driven through its CLI by one AIES extension. There is
no MCP server in the AIES runtime.

```
aies (Parent, bound repo)  --D40 binding-->  projectKey  (e.g. AIES, COREOS)
        |
        v
extensions/aies-memory/   spawn("pjm", args, { cwd: $AIES_HOME/memory/<projectKey>,
        |                                      env: PROJECTMEM_HOME=$AIES_HOME/memory/_home })
        v
$AIES_HOME/memory/<projectKey>/.projectmem/   (pseudo-root, outside every repository)
```

1. **Store location.** One pseudo-root per project key under `$AIES_HOME/memory/`, created
   by the extension with `pjm init` and every `--no-*` flag (to be re-checked in P1 against
   a bare directory). The repository itself is never touched: no `.projectmem/`, no
   `CLAUDE.md`, no hooks, no watcher, no `.gitignore` edit, no Done Gate noise.
2. **Isolation by construction.** The extension chooses `cwd` and `PROJECTMEM_HOME` from the
   D40 binding. The model passes no project, root or path to any tool. The registry and global
   memory in `$PROJECTMEM_HOME` are private to AIES; no tool reads global memory, so
   cross-project recall is off. An unbound repository or a ticket from another project: no
   memory, fail closed (same rule as `checkTicketRepo`).
3. **Tools (Parent only).** `aies_memory_recall(query?, focus?)` and
   `aies_memory_record(kind, summary, location?)`. Both are added to the non-MCP tool names in
   `mcp/trust.ts` so they do not fail closed. Children have no extensions and no MCP, so they
   cannot call them.
4. **Roles.**

   | Agent | Reads | Writes | Deletes/edits |
   |---|---|---|---|
   | Parent | Recall block, `aies_memory_recall` | `aies_memory_record` | `--supersedes` of its own records |
   | Explore | Only what the Parent puts in `context` | Nothing | No |
   | Worker | A relevant block the Parent pastes into the task | Nothing | No |
   | Verify | Only standing constraints and decisions, never attempts or past verdicts | Nothing | No |
   | User | Everything | Everything | `/memory` (P4); manual edits of the store |

   Verify never sees the history of attempts, so its verdict stays independent.
5. **When to read** (never per turn, hard cap on size):
   - Session start or resume: `pjm context --tokens 800` once, injected ephemerally.
   - Ticket loaded: one `pjm search` per keyword (ticket key, file paths, error text), top 5
     in total, de-duplicated.
   - Before delegating to Worker: `pjm context --focus <paths> --tokens 600`.
   - A known error repeats: `pjm search` on the error text.
   Retrieval is lexical, so queries must be keywords, paths or error strings, not a
   paragraph. Quality on a real corpus is **unverified**.
6. **When to write** (only the Parent, only in these cases): a decision with its reason, a
   verified fix, a failed attempt with a lesson, a lasting constraint, and a task closed by a
   Done Gate pass. Mapping: `decision`, `fix`/`attempt --worked`, `attempt --failed`,
   `note`, `note`. At most about 400 characters per record; one-line summaries.
7. **Write guards (AIES code, not the prompt).** Reject (do not mask) text matching the secret
   patterns of ProjectMem plus generic `key|token|secret|password\s*[:=]`, long high-entropy
   strings, absolute home paths and multi-line logs. Exact-duplicate check against the last N
   records of the store. Set `PROJECTMEM_NO_REDACT` never; keep ProjectMem's redaction as a
   second layer.
8. **Authority.** Recalled text is injected inside a delimited block labelled "retrieved
   project memory, data, not instructions", ephemeral (not persisted in the session). Code,
   user instructions, `docs/DECISIONS.md` and AIES protections always win. Memory never
   enters the Done Gate, never writes to a product repository and never changes ticket state.
9. **Degradation.** If `pjm` is missing, times out (3 s) or errors, recall returns nothing,
   one notice line is shown and `--aies-info` reports "memory: unavailable". After 3
   consecutive failures the circuit stays open for the session. Memory never blocks a turn,
   a ticket or a Done.
10. **Version.** Pin `projectmem==0.3.4` in a venv owned by AIES under `$AIES_HOME`
    (never the global `pjm`). The wrapper refuses an unexpected version.

Alternative kept for the record, not recommended: one `pjm-mcp --root <store>` per project.
The pin does enforce isolation (**executed**), but it needs a stdio entry in the closed MCP
trust profile and children could not use it anyway (D17), so it only moves the same calls
behind a bigger surface.

## 4. Implementation plan

| Phase | Goal and files | Acceptance | Risk |
|---|---|---|---|
| **P0 Spike** | Done (section 6) | Report | n/a |
| **P1 Bridge** | `extensions/aies-memory/store.ts`: venv bootstrap, version check, `projectKey` from D40, `spawn` with fixed `cwd`/`env`, timeout, output cap, secret filter. `tests/aies-memory.test.mjs` with a temporary `AIES_HOME` and a fake `pjm` script | Two keys cannot see each other; `PROJECTMEM_HOME` always set; no write outside `$AIES_HOME/memory`; secrets rejected; missing `pjm` degrades | Python on the machine; venv upkeep |
| **P2 Recall** | `index.ts` tool `aies_memory_recall`, session-start and ticket-load injection, `mcp/trust.ts` entry, `--aies-info` line | Block size bounded; children have no tool; unbound repo gives nothing; `done-gate-session` tests unchanged | `context` event differs in the installed Pi |
| **P3 Record** | `aies_memory_record`, write rules in the Parent prompt and enforcement in code | Only after Verify PASS and Done for task records; duplicates dropped; Done Gate unaffected | Prompt ignored, so enforce in code |
| **P4 Delegation** | Parent pastes recall into Explore/Worker `context`; Verify gets constraints only | Verify transcript contains no attempt history | Leaking history to Verify |
| **P5 User control** | `/memory list|show|supersede|export` (Pi `registerCommand`; no second CLI, hard rule 4) | Export is the JSONL; supersede works | Command API |
| **P6 E2E** | Disposable repository and tracker stub in a temp dir | Section 5 | Real CoreOS only with explicit approval |

Proportional verification: `reviewer` on P1 to P3 (persistence, isolation, secrets), `qa` on
the rest. `npm test`, `npm run check:isolation` and `bash -n bin/aies scripts/*.sh` close each
phase.

## 5. E2E proof and acceptance criteria

1. In a disposable repository an agent solves a task; the Parent records a decision, a failed
   attempt and the verified fix.
2. Session closed; a new `aies` process starts.
3. The new session recalls the lesson at ticket load, within the size cap, with no model call
   made by the memory path.
4. The Worker receives the relevant block and avoids the failed attempt.
5. A second project key cannot read it (different store, model-supplied project ignored,
   foreign ticket refused).
6. `--supersedes` retires a decision: it disappears from recall but stays in the log.
7. A secret in a record is rejected; a memory containing an instruction does not alter
   behaviour (it is data); the repository `git status` is clean afterwards.
8. With `pjm` removed, `aies` starts and works with a one-line notice.

Bypass attempts to include: a project, root or path in tool arguments; `../` in `location`; a
ticket from another project; a child calling a memory tool; a write that tries to change
ticket state; an instruction hidden in a stored note.

## 6. Spike results (October 2026, all in a throwaway directory)

Environment: `uv venv` with Python 3.14.0 on arm64, `projectmem==0.3.4`,
`PROJECTMEM_HOME` pointing into the throwaway directory, invalid proxy variables set. No
repository, Plane or hook was touched.

| # | Test | Result |
|---|---|---|
| 1 | Install | Installs from PyPI; `pjm`, `pjm-mcp`, `projectmem` present (**executed**) |
| 2 | `pjm init` with every `--no-*` flag in two bare directories A and B | Created only `.projectmem/` (6 files) and `.gitignore` per directory, plus two files in `PROJECTMEM_HOME`. No `CLAUDE.md`, hooks or watcher (**executed**). Needs no `.git` |
| 3 | Save a decision, an issue, a failed and a worked attempt, a fix, a note | All recorded as JSONL events (**executed**) |
| 4 | Recall in a different process | `search` and `context` returned them (**executed**), so persistence across processes works |
| 5 | Isolation A/B by working directory | B found nothing for A's term (**executed**) |
| 6 | `pjm-mcp --root B` called through the MCP client | 17 tools; calls without `project` landed in B; with `project=A` both `search_events` and `add_note` returned `ResolutionError` and B/A logs were unchanged (**executed**) |
| 7 | Supersede | Old decision shown as `(superseded)` in search and absent from `context`; new one present (**executed**) |
| 8 | Redaction | `sk-...` replaced by `[REDACTED:openai_key]`; `password=hunter2` stored as is (**executed**) |
| 9 | Context cost | A 1000-token budget produced 268 words with 5 records; size follows the budget, not the log. Real-corpus size **unverified** |
| 10 | Queries | One local process per call, no model call anywhere in the path (**read** + dead proxy **executed**) |
| 11 | Global promotion | No file appeared in `home/global` for these events (no declared library); behaviour with libraries is **read**, not run |
| 12 | Hooks, watcher, `doctor`, git staleness, concurrent writers, large logs | **Not run** (hooks and watcher are not used; no concurrency test) |

### Incident: stray file in the real profile of ProjectMem
The first command of the spike, `venv/bin/pjm --help`, ran before `PROJECTMEM_HOME` was
exported. Version 0.3.4 wrote `~/.projectmem/projects.meta.json` (29 bytes, a version stamp).
Nothing else in `~/.projectmem` changed (`projects.json` and `global/` are as before). I did
not delete it because the removal was blocked by the permission policy; it is harmless to
`pjm 0.2.0` and can be removed with `rm ~/.projectmem/projects.meta.json`. Lesson recorded in
the design: the wrapper never runs `pjm` without `PROJECTMEM_HOME`.

## 7. Costs, maintenance and risks

- Cost: zero. No API, no model, no embedding, no service. A call is one short-lived process
  (tens of milliseconds, **not benchmarked**). Disk: a few hundred bytes per event.
- Context: about 800 tokens per session start and 600 per delegation at most; none per turn.
- Maintenance: pinned version bump by hand; venv under `$AIES_HOME`; occasional manual
  pruning (supersede, or edit the JSONL).
- Risks:
  - Young project (0.3.x, one maintainer); format or CLI may change. Mitigation: pin, and the
    JSONL is trivially portable.
  - Lexical search only: a paraphrased problem will not match. Mitigation: record keywords and
    paths in summaries; the quality is unmeasured.
  - Linear scan grows with the log (**read**). Fine for thousands of events; revisit later.
  - No file locking on `events.jsonl`: only the Parent writes, one process at a time.
  - Redaction is weak: AIES filter is mandatory.
  - Memory poisoning through repository content the Parent summarises: mitigated by
    Parent-only writes, size caps, the non-privileged block and user review, not eliminated.
  - Python becomes an optional dependency of AIES (a venv); the system works without it.
  - The wrapper depends on CLI text output (no JSON for `search`; `context` has `--format
    json`). Parsing must be defensive.
  - `ARCHITECTURE.md` does not yet describe D26 to D40; update separately.

## 8. Decisions that need your approval

1. D42: CLI bridge without MCP (recommended) versus a pinned `pjm-mcp` per project (needs a
   change of the closed MCP trust profile).
2. Store outside the repository under `$AIES_HOME/memory/` (recommended) versus
   `.projectmem/` inside each repository (shareable through git, but collides with the Done
   Gate and with `init` editing `CLAUDE.md`/`AGENTS.md`).
3. Pin `projectmem==0.3.4` in an AIES-owned venv and never use the global `pjm 0.2.0`.
4. Verify receives constraints and decisions only (recommended).
5. Parent-only writes in the five cases of section 3.6 (recommended).
6. Whether to remove `~/.projectmem/projects.meta.json` (section 6).

## 9. History: the discarded Mem0 plan (D41)

Mem0 OSS (Node library, `infer: false`, SQLite per scope) was investigated and a P0 spike run
with a fake local embedder. It was dropped because every save and search needs an embedding
model. Findings that still apply to any memory in AIES:

- The scope must come from the D40 binding on every call and fail closed; tools take no scope
  argument and reserved metadata supplied by the model is discarded. (ProjectMem gets this by
  choosing `cwd` and `PROJECTMEM_HOME` in code.)
- A wildcard-like scope value was accepted by Mem0; any identifier used as a path or key must
  be validated against a strict regex. Here: `projectKey` as a path component, so
  `^[A-Za-z0-9._-]+$`, no `..`.
- Deleting from the main store left text in a history table; ProjectMem is append-only, so
  "forget" means editing the JSONL and regenerating the summary by hand.
- Memory is recovery context, never authority; the Parent is the single writer; children have
  no extensions or MCP.
- Done Gate check: a code change through `bash` after a Verify PASS is still denied by the
  Git fingerprint (`linear/manager.ts:177-205`, tested in `tests/done-gate-session.test.mjs`).
- Four pre-existing failures in `tests/eze-493-test-harness.test.mjs` come from a `TMPDIR`
  with a trailing slash (`TMPDIR="${TMPDIR%/}" node --test ...` passes 18/18). They are
  unrelated to memory and not fixed.

## 10. Phase 1 as implemented, manual use and next step

Files: `extensions/aies-memory/{guards,scope,store,index}.ts`, `scripts/memory-bootstrap.sh`,
`tests/aies-memory.test.mjs` (66 tests, including a real run against the pinned ProjectMem),
`bin/aies` (`memory=` line in `--aies-info`), `extensions/aies-agents/mcp/trust.ts` (tool names).

### Set up (once per profile)
```bash
AIES_HOME=<profile> bash scripts/memory-bootstrap.sh   # venv at $AIES_HOME/memory/_venv, projectmem==0.3.4
aies --aies-info                                         # memory= line: available | unavailable (reason)
```
Without the venv AIES works normally and reports memory as unavailable.

### Manual use inside AIES (Pi command, user-authored)
```
/memory status
/memory search <text>                 substring search, top 10, size-capped
/memory context [relative/path]       token-budgeted briefing of the project
/memory list                          recent events
/memory decision|fix|failed|note <text>
/memory supersede <evt_id> <text>     retire an older decision with a new one
```
The store is `$AIES_HOME/memory/<projectKey>/.projectmem/`; `events.jsonl` can be read or
edited by hand (append-only log; "forget" means editing it, then `pjm regenerate` with the
venv binary and `PROJECTMEM_HOME=$AIES_HOME/memory/_home`). The project is always the one
bound to the current repository (D40); there is no way to name another one.

### Parent tools
`aies_memory_search`, `aies_memory_context` (read) and `aies_memory_record` (write). None takes
a project, scope or path. `aies_memory_record` answers "disabled" unless `memory.writes` is
`true` in `$PI_CODING_AGENT_DIR/aies.json` (default false, so nothing is written
automatically). Children (Explore, Worker, Verify) have no extensions and cannot call them.
Output is wrapped as `<retrieved-project-memory>` data with the closing tag escaped.

### Verified in phase 1 (executed)
Persistence across processes; isolation between two projects; rejection of `..`, separators,
absolute, NUL, over-long and reserved keys and of symlinked store directories; unbound or
ambiguous repository gives no memory; decision save and recall; supersede; secret rejection
(known token families, credential assignments, URLs with credentials, home paths, `.env`
lines, high-entropy strings); size, volume and duplicate caps; truncation and timeouts;
degradation without ProjectMem; a throwaway git repository stays clean; `~/.projectmem` is
byte-identical before and after; no forbidden subcommand can be built; no network model. Full
suite: 1911 pass, 0 fail with `TMPDIR` without a trailing slash (the 4 known harness failures
otherwise). Independent review (`reviewer`): PASS with reservations, no blocking finding.

### Known limitations (from the review, accepted for V1)
- Pattern filters miss `password hunter2` (no `:` or `=`), short base64 and secrets split by
  spaces. Writes remain Parent-only and disabled by default for the model.
- Any `command_failed`, even a legitimate pjm refusal, counts toward the 3-failure circuit.
- The pinned version is checked once per session.
- `status()` and `--aies-info` create `$AIES_HOME/memory/_home` if missing.
- `realpath` to `spawn` has a TOCTOU window and `events.jsonl` as a symlink is checked on read
  only; exploitable only by the same user.
- Two sessions on one project can pass the duplicate and volume checks concurrently.
- `pjm fix`/`attempt` need an open issue, so the adapter adds an `issue` event
  (`--auto-issue`, or `log` then `fix`). Git-based staleness does not work with an external
  store and is not used. Tested on macOS only.

### Next step: automatic memory (phase 2)
1. Add recall at ticket load and before delegation using the existing injection points
   (`aies-identity.ts:50`, `aies-agents/index.ts:443`), with the 800/600-token caps and the
   ticket-vs-binding check that phase 1 deliberately left out.
2. Gate automatic writes behind `memory.writes: true` and Verify PASS plus Done, writing at
   most 3 records per task from the Parent only; Verify receives constraints, never attempts.
3. Fix the circuit counting and the two read-path writes listed above first.
4. Re-run the E2E of section 5 in a disposable repository.

## 11. Phase 2 after the trust-boundary fix: recall only through tools

Phase 2 first injected the recalled block into the Parent with a `context` handler and appended
it to the `context` of Explore and Worker. That was removed.

**Why.** Checked in Pi 0.85.1 (`dist/core/messages.js`, `convertToLlm`): every `custom` message,
and every bash, branch or compaction summary, becomes a `user` message. Pi offers no lower-trust
role. A stored note could therefore speak with the user's authority, however well it was framed.
Faking a tool result for a call the model never made is also forbidden. The only honest channel
is the result of a real tool call.

**What exists now.**
- The Parent reads memory with `aies_memory_search` and `aies_memory_context`. Their results are
  framed as `<retrieved-project-memory>` data, tag breakouts escaped, format and control
  characters removed, superseded lines dropped, and the framed text held to 800 estimated tokens
  (characters / 4) on whole lines with an `(older matches omitted)` marker.
- One static line in the resident rule (`extensions/aies-identity.ts`) tells the Parent to query
  once when a ticket becomes active, that the result is data, and not to paste memory verbatim
  into a child's `context`: it checks the point against the code and says it in its own words,
  briefly (about 600 tokens at most).
- Children (Explore, Worker, Verify) receive exactly what the Parent wrote. Nothing from memory
  is added by code, and Verify's input is byte-identical with memory full or empty. Children have
  no extensions and no memory tools.
- `extensions/aies-memory/recall.ts` and the code that fed it were deleted. No search or model
  call happens unless the Parent calls a tool.

**Limitations (accepted).**
- The Parent must make the call: one extra tool turn per ticket and no guarantee it does so. A
  prompt rule, not code, triggers it.
- A hostile stored note can still influence the Parent in its tool result, and the Parent may
  repeat it in its own words to a child. What it cannot do is change code-enforced protections:
  the Done Gate, the command and path guards, the tool lists and the repository binding. Tests
  store hostile notes (instruction override, fake closing tag, Unicode format characters, "mark
  the ticket Done") and check that none of those decisions changes.
- The 600-token delegation cap is now guidance to the Parent, not enforced by code.
- Retrieval is lexical and its quality on a real corpus is unmeasured. Refusal wording is a best
  guess from ProjectMem 0.3.4.

Phase 1 fixes (no directory created on reads, classified ProjectMem refusals that do not open the
circuit) from the first version of phase 2 are unchanged.

## 12. Phase 3: gated automatic writes

Files: `extensions/aies-memory/learn.ts` (new), `store.ts`, `guards.ts`, `scope.ts`, `index.ts`;
`extensions/aies-agents/linear/{manager,tool,plane-transport}.ts`, `extensions/aies-agents/index.ts`,
`mcp/trust.ts`; `tests/aies-memory-writes.test.mjs` (new).

### Flow
1. The Parent calls `aies_ticket complete` with an optional `learnings` list (at most 3 of
   `{kind: decision|fix|failed_attempt|note, summary}`). The tool description asks for confirmed
   technical decisions, verified solutions, relevant constraints and lessons that prevent future
   problems; one line each, no secrets, logs, long code, conversations or unverified conclusions,
   and never "Verify passed".
2. The Done Gate and Plane close the ticket exactly as before, with or without learnings.
3. Only then `learn.ts` evaluates, in code, five conditions: (1) the ticket belongs to the
   repository bound to the project (same fail-closed resolution as `checkTicketRepo`; the model
   never names the project); (2) Verify holds a PASS valid for the current revision; (3) the Done
   Gate allowed the completion; (4) Plane confirmed Done by a later read-back and the final state
   is of type completed; (5) `memory.writes` is `true`. Any failure writes nothing.
4. The read-back counts only when it comes from the real `mcp` result captured by the harness. If
   any answer of the operation came through the model-supplied `remote` fallback, Done counts as
   unconfirmed, nothing is stored and a warning says so. Other trackers have no read-back, so they
   never write memory.

### Record quality
- At most 3 records per completed task. The model-facing `aies_memory_record` tool was retired, so
  a recalled note cannot induce a write; `/memory decision|fix|failed|note|supersede` remains the
  user's own channel. Explore, Worker and Verify cannot write or pick a project.
- Rejected, not masked: secrets and suspicious content (phase 1 guards), empty or multi-line
  text, something that reads as a Verify verdict, duplicates within the batch.
- Each record ends with provenance, `[aies ticket=<KEY> rev=<n> src=verify-pass id=<12 hex>]`,
  kept intact when the text is trimmed. `id` is a SHA-256 of project key, ticket, revision and
  normalised kind plus summary. Duplicates are detected by the id of that final suffix, so a
  retry, a restart, a repeated completion or a second session writes it once. Identical text is
  also treated as a duplicate.
- Automatic writes never use `supersede`. If a non-superseded decision on the same topic (the text
  before `: `) already exists with different content, nothing is written and the conflict is
  shown; the user decides with `/memory supersede`. A conflict is not queued and is lost unless
  the user acts on it.
- The check-then-append runs under an exclusive lock file (`O_EXCL`, stale after 60 s) inside the
  project's memory directory. It is advisory: it covers processes of the same user on the same
  machine and not network file systems.

### Failure and recovery
- ProjectMem failing after Plane closed never undoes Done and never repeats a Plane call.
- Learnings that could not be stored are kept in
  `$AIES_HOME/memory/<projectKey>/_pending/` (schema, id and age validated; at most 20 files of
  8 KB, expiry 14 days; symlinks refused). A warning and a line in the tool result report
  "saved N, pending M".
- `/memory retry` (user action) writes them again with the same duplicate checks. It requires
  `memory.writes: true` and the same project; a pending file of another project is neither written
  nor deleted. It does not touch Plane. Pending files are trusted like the store itself: someone
  who can plant a file in `$AIES_HOME` can also edit `events.jsonl`.
- `complete` with only a PASS-less change (for example docs) stores nothing.

### Verified (executed)
- `tests/aies-memory-writes.test.mjs`, 48 tests including a run against the pinned ProjectMem:
  write after a current PASS and confirmed Done; none after FAIL, BLOCKED, a stale PASS, a ticket
  not completed, `memory.writes` off, a non-Plane tracker, a forged `remote` read-back, a ticket
  of another project or an unbound repository; project isolation; the 3-record cap; deduplication
  across repeated completion, restart and two concurrent writers; recall of the lesson from a new
  session through `aies_memory_search`; Verify verdicts rejected; secrets rejected; hostile stored
  notes changing no condition; ProjectMem failure after Done, pending file, warning and
  idempotent `/memory retry`; Verify without Worker history; the disposable repository stays
  clean and `~/.projectmem` is untouched.
- Independent review (`reviewer`): PASS with reservations. Fixed afterwards: read-back could be
  forged through `remote`; the identity rule told the Parent to paste memory; the duplicate check
  matched a marker anywhere in the text; `/memory retry` ignored `memory.writes`.
- Known pre-existing failure, unrelated: `mcp-integration` "Exclusive MCP config isolation".

### Not enabled
`memory.writes` is off in every profile, including yours. To try it, set `"memory": {"writes":
true}` in `$PI_CODING_AGENT_DIR/aies.json` of a throwaway profile first.
