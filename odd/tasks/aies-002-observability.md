# AIES-002 - Observability baseline

Status: complete
Branch: `feat/aies-002-observability`
Scope: Phase 2 of AIES (sensors only)

## Goal

Answer, for the parent session, how much context it uses, what its peak was, how
many tools it ran directly, how much of that was exploration, how much output
that produced, which model is running, how long the session has been alive,
whether anything was compacted, and which tool surface is active.

## Non-goals (out of scope for this phase)

Delegating, creating subagents, changing routing, blocking tools on thresholds,
proactive compaction, automatic continuation, Linear, Verify, memory, historical
analytics, cost reporting. **This phase measures; it does not govern.**

## Locked decisions

| # | Decision | Value |
|---|----------|-------|
| D1 | Behaviour | zero: no handler returns a value, no event is mutated, no threshold is read |
| D2 | Token source | `ctx.getContextUsage()` only; AIES never estimates tokens |
| D3 | Shape | one extension, three modules: `index.ts` (Pi), `state.ts` (transitions), `status.ts` (rendering) |
| D4 | Peak | monotonic, stored with the context window it was measured against |
| D5 | Exploration | explicit tool tables plus a tested shell heuristic; never a shell parser |
| D6 | Persistence | in memory, checkpointed through `pi.appendEntry("aies-metrics", ...)` |
| D7 | Footer | one line, one owner (`aies-identity.ts` stopped writing the status key) |

## Tasks and commits

| Task | Commit | Subject |
|------|--------|---------|
| T1 Pure state: transitions, classification, snapshot round-trip | this commit | `feat(observability): add parent session metrics` |
| T2 Rendering: footer line and `/aies-status` report | this commit | same commit as T1 |
| T3 Pi wiring: eight hooks, command, clock, checkpoint | this commit | same commit as T1 |
| T4 Deterministic tests: rules, rendering, fake host | this commit | same commit as T1 |
| T5 Real-Pi runtime checks | this commit | same commit as T1 |
| T6 Docs: architecture section, D8, README | this commit | same commit as T1 |

## Verification evidence

| Check | Command | Result |
|-------|---------|--------|
| Metric rules and rendering | `node --test tests/observability.test.mjs` | 45/45 pass |
| Whole suite | `npm test` | 58/58 pass |
| Shell syntax | `bash -n bin/aies scripts/*.sh` | clean |
| Isolation unaffected | `npm run check:isolation` | pass |
| Loads in real Pi | RPC `get_commands` | `/aies-status` from `extensions/aies-runtime/index.ts`, `baseDir` = isolated profile |
| Answers in real Pi | RPC `prompt "/aies-status"` | report rendered, zero `extension_error` events |
| Live tool traffic | real Pi run against an offline scripted provider | footer went `tools 0 · files 0` → `tools 1 · files 1`, `ctx 120/peak 310` (peak kept while current fell) |
| Interactive TUI | `./bin/aies` under a pty | one footer line, refreshed on events and every 5s, no flicker |
| Resume | second Pi process on the same session file | `tool calls 1`, `archivos 1`, `peak 310` restored, plus `esta ejecución` |
| Checkpoint on disk | session `.jsonl` of the smoke profile | one `aies-metrics` custom entry, `toolCalls: 1`, `filesInspected: ["package.json"]` |
| Ambient Pi untouched | sha256 of `~/.pi/agent/{settings,auth,models}.json` + session listing | identical before and after |

The real-run smoke used a throwaway scripted provider in `/tmp` (never committed)
because the AIES profile has no eligible model on this machine: `anthropic`
answers 401 and `qwen-token-plan` answers 403 `AccessDenied.Unpurchased`. A
model-backed interactive run is still worth doing by hand once `/login` works.

## Known limitations

- L1 Counters cover the **parent** session only. A subagent's own tools, files
  and context belong to another session and are invisible here; the parent shows
  one call to its delegation tool.
- L2 `filesInspected` counts paths given to the reading tools. It does not
  attribute files matched by `grep`/`find`, and a shell command adds one counter
  and no paths.
- L3 A session killed between checkpoints loses what was not written yet; `/new`
  starts from zero by definition.
- L4 Output size is approximate characters (text blocks plus base64 image
  payloads), not a token measure.
- L5 `view_file` is counted as a source read although Pi 0.85.1 has no such tool,
  to keep the classification stable if it appears.
- L6 The scripted-provider smoke exercises the real Pi event shapes but is not
  part of the committed suite; it needs no credentials and can be replayed by
  hand.

## What this enables

AIES-003 (gates and actuators) can now read the same numbers the UI shows:
delegation triggers, context pressure, and any later proactive-compaction policy
become decisions on measured state instead of guesses.
