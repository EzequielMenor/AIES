# Runtime v1 — AIES-core

> The TypeScript/Node implementation of the spec on top of **pi** (`@earendil-works/pi-coding-agent@~0.84.2`). The full package is described in `runtime/README.md`. This page explains the architecture and where to look when changing something.

## 1. Where AIES-core lives

The runtime lives entirely under `runtime/`:

```text
runtime/
├── package.json              # @aies/core, bin "aies" → dist/cli.js, scripts (build/test*/research:metrics)
├── tsconfig.json             # ESM, strict, Node ≥20
├── aies.config.json          # provider + models per role (no secrets); orchestratorThinkingLevel; limits
├── README.md                 # state of implementation, gate findings, scripts, smoke
├── .gitignore
├── src/
│   ├── cli.ts                # aies "<tarea>" / aies (REPL) entrypoint (CLI standalone)
│   ├── cli-persistence.ts    # REPL session persistence
│   ├── config.ts             # Zod-validated aies.config.json loader (AIES_CONFIG env override)
│   ├── intervention.ts       # SIGINT → StopController (1st → request stop, 2nd → exit 130)
│   ├── limits.ts             # LIMIT_POLICY + limitsFromConfig
│   ├── observability.ts      # shapes of decision/result/compaction log entries + serializers
│   ├── core/                 # domain (no pi): state.ts, loop.ts, events.ts, types.ts, observation.ts
│   ├── orchestrator/         # ORCHESTRATOR_SYSTEM_PROMPT + createDecide + Zod parse.ts
│   ├── workers/              # capabilities.ts (allowlists), session-factory.ts, tools.ts, prompts.ts
│   ├── persistence/          # file_store.ts + recover.ts (ADR-008)
│   ├── research/             # metrics.ts (log.jsonl → NFR metrics) + baseline.ts (single-agent runner)
│   ├── self-check/           # step-3/4/5/11 verifications without pi (loop/persistence/orch/compaction/workers)
│   ├── telemetry/            # domain types + pi-events.ts (mapeo pi → dominio)
│   └── extension/            # @deprecated 2026-08-20 — código legacy de la extensión de Pi; se elimina en v2
├── dist/                     # tsc output; consumed by the bin and the scripts
├── fixtures/smoke-repo/      # tiny ESM repo (AGENTS.md + src/math.js) for the smoke run
└── node_modules/             # gitignored
```

The runtime is **the only module** of this repo that imports `@earendil-works/pi-coding-agent`. The decoupling lives in `workers/session-factory.ts` (workers) and `orchestrator/decide.ts` (decide) — the rest of the domínio (`core/`, `state.ts`, `loop.ts`, `parse.ts`) stays pure. That is the price of `ADR-009` (DIP over a 0.x SDK) and the place to refactor if pi is replaced.

> La extensión de Pi (`src/extension/`) está **deprecated** desde 2026-08-20. La CLI standalone (`src/cli.ts`) es el único entry point. Ver `05-Decisions/ADR-010-extension-de-pi.md`.

## 2. The wiring (CLI → loop)

The CLI entrypoint is `runtime/src/cli.ts`. From argv it dispatches into two modes:

- **Oneshot** — `aies "<tarea>"` (or any non-empty positional argument): runs one task to a terminal state and exits 0/1.
- **REPL** — `aies` (no args): interactive prompt `❯ `; each line is a new task over the same project. Commands: `/help`, `/state`, `/state --json`, `/resume`, `/clear`, `/exit | /quit`. See `cli.ts::HELP_TEXT`.

```text
cli.ts
  ├── loadConfig()                              # aies.config.json (Zod)
  ├── limitsFromConfig(cfg)                     # limits.ts
  ├── store = new LocalStore(cwd)               # cli-persistence.ts (<cwd>/.aies/)
  ├── decide = createDecide({ cwd, model, thinkingLevel, signal })
  │                                            # orchestrator/decide.ts — AgentSession efímera por turno
  ├── execute = buildExecute(wctx, signal)      # workers/tools.ts::runWorker (WorkerToolContext)
  ├── controller = new AbortController()        # SIGINT → abort (no exit, no kill)
  ├── renderer = new StreamRenderer(...)        # ui/stream-renderer.ts (merged into handlers below)
  └── runCycle(task, { ... })                   # runLoop(state, { decide, execute, handlers, ... })
        └─ store.saveState(finalState)
```

What this means:

- Los modos: argv con texto posicional corre `runOneshot(taskArg)`; sin texto entra en `runRepl()` hasta `/exit`. El REPL carga `.aies/state.json`; si está `En curso`, avisa y `/resume` continúa el snapshot (`resumeFrom`). SIGINT aborta el run sin matar el proceso.
- **Persistence path** — the CLI uses `LocalStore` (`cli-persistence.ts`) at `<cwd>/.aies/{state.json,log.jsonl}`. The legacy `persistence/file_store.ts` (used by the deprecated extension) lives at `<agentDir>/aies/<sha1(cwd).slice(0,16)>/{state.json,log.jsonl}` and is still exercised by `self-check/persistence.ts`. Both write JSONL append-only and `state.json` atomically (`.tmp` + rename).
- **`runLoop`** runs while `taskState ∈ {Recibida, En curso}`. Each iteration is `decide(state) → execute(state, decision) → applyOperationResult`. Limits, parse failures, and SIGINT are checked before each turn; see [architecture.md §3](architecture.md#3-the-decision-loop).
- **Worker call** — `execute` invokes `workers/tools.ts::runWorker(cap, …)`, which builds an ephemeral `AgentSession` via `workers/session-factory.ts::createWorkerSession` with the capability's tool allowlist (`workers/capabilities.ts`), the persona prompt (`workers/prompts.ts::CAPABILITY_PROMPT`), and an `AbortSignal` wired to `controller.signal`.

## 3. The pi boundary

`ADR-009` is "pi in-process; AIES-core owns the loop; the binding is two modules." Today, after the host/pi-binding removal (Fase 4), the only modules that import `@earendil-works/pi-coding-agent` are:

- `workers/session-factory.ts` — workers (ephemeral `AgentSession` per unit).
- `orchestrator/decide.ts` — orchestrator (ephemeral `AgentSession` per turn with `noTools: "all"`).
- `telemetry/pi-events.ts` — type-only imports of pi events for the mapping layer.

The rest of the domain (`core/`, `state.ts`, `loop.ts`, `parse.ts`, `persistence/`, `observability/`) stays pure. The `self-checks` and the test suite are how this is verified.

### The `pi` API surface in use (`runtime/README.md` §Gate)

| Use | pi API | Where |
|---|---|---|
| Multi-provider runtime | `ModelRuntime.create()` | `orchestrator/decide.ts` |
| Session factory | `createAgentSession({...})` | `workers/session-factory.ts`, `orchestrator/decide.ts` |
| Orchestrator | `noTools: "all"` + `systemPromptOverride` via `DefaultResourceLoader` | `orchestrator/decide.ts` |
| Worker | `tools: string[]` allowlist + ephemeral `SessionManager.inMemory(cwd)` | `workers/session-factory.ts` |
| Telemetry | `getSessionStats()` (cumulative → delta per turn), `getContextUsage()` | `workers/session-factory.ts` |
| Context ceiling | `autoCompactionEnabled` + events `compaction_start` / `compaction_end` | `telemetry/pi-events.ts::mapCompaction` |
| Project context | `DefaultResourceLoader` (reads `AGENTS.md`, etc.) | `workers/session-factory.ts`, `orchestrator/decide.ts` |

The spec called for `systemPromptOverride` on `createAgentSession`; that option does **not** exist there. The correct wiring is `DefaultResourceLoader({ systemPromptOverride, appendSystemPromptOverride })`. That is the only correction between spec and code (`runtime/README.md` §Gate, table row `systemPromptOverride`).

## 4. Persistence (`ADR-008`)

Two stores coexist for the two surfaces (CLI active, extension legacy):

**`runtime/src/cli-persistence.ts` — `LocalStore`** (active CLI path):

- Path: `<cwd>/.aies/{state.json, log.jsonl}`.
- `state.json` is written atomically (`.tmp` + rename).
- `log.jsonl` is append-only; one JSON object per line.
- `loadState()` returns the parsed state, or `null` on absent/corrupt (the CLI surfaces this to the user; see §2).

**`runtime/src/persistence/file_store.ts` — `FileStore`** (legacy extension path):

- `agentDir` is pi's `getAgentDir()` (typically `~/.pi/agent/`).
- Path: `<agentDir>/aies/<sha1(cwd).slice(0,16)>/{state.json, log.jsonl}`.
- Same atomic-write + append-only semantics as `LocalStore`.

**`runtime/src/persistence/recover.ts`** wraps `FileStore.loadState()` and returns `absent | ok | corrupt`. On `corrupt` it emits a synthetic decision "sesión limpia (state.json corrupto); log previo conservado" and keeps `log.jsonl` intact. The same pattern ("sesión nueva (sin state.json previo)") is emitted on `absent`.

## 5. Observability (`log.jsonl`)

Defined in `runtime/src/observability.ts`. Three entry shapes:

- **`type: "decision"`** — one per turn of the loop; carries `operación`, `ajustePlan`, `motivo`, optional `unidad`, `capacidad`, `comunicación`, `condición`, `parseFail`, and the orchestrator's turn telemetry (`usage` / `contextUsage` / `telemetryUnavailable` / `telemetryReason`). Optional `ts` (ISO).
- **`type: "resultado"`** — one per executed operation; carries `resultado` text, `kind` (`info | unidad | comunicación | terminación | fallo | límite | parse_error`), `unidadId`, telemetry, and optional `límite_alcanzado`. (`atribución` was an E-01A experimental field; the flag is gone in the current CLI.)
- **`type: "compaction"`** — `compaction_start`/`compaction_end` events from pi, with `tokensBefore`/`estimatedTokensAfter`/`willRetry` and the reason. These are not loop turns; they leave a footprint for `RNF-18/19` and `H-01`.

The CLI assigns `ts: new Date().toISOString()` at emission time, so wall-clock per turn is computable from the log alone.

## 6. Running it

From the [quickstart](quickstart.md):

```bash
cd runtime
pnpm install    # o npm install
pnpm run build
ANTHROPIC_API_KEY=sk-ant-... aies "lista los archivos del proyecto"
# log.jsonl at <cwd>/.aies/log.jsonl
pnpm run research:metrics -- .aies/log.jsonl
```

### What `pnpm test` covers (no pi needed)

`pnpm test` runs the vitest suites (`parse`, `unitid`, `loop`, `cost`, `smoke-e2e`) plus the five self-checks in `runtime/src/self-check/`:

- `tests/parse.test.ts` — Zod parser against the orchestrator schema.
- `tests/unitid.test.ts` — non-existent unit id is not terminal (re-emit, not `Fallida`).
- `tests/loop.test.ts` — happy path of MVP-v0-Scope §9, plus C3 (3 parse-failures → intervención) and ADR-005 (limit → intervención, not Fallida).
- `tests/cost.test.ts` — cost telemetry deltas (cost stays `off` per `ADR-005`).
- `tests/smoke-e2e.test.ts` — vitest e2e harness around the loop and persistence.
- `self-check/persistence.js` — state.json + log.jsonl, recovery on corrupt (uses `FileStore`).
- `self-check/orchestrator.js` — Zod parser against the orchestrator schema.
- `self-check/compaction.js` — pi → domain mapping for `compaction_start` / `compaction_end` (imports `telemetry/pi-events.ts::mapCompaction`).
- `self-check/workers.js` — capability allowlists + Verifier verdict parsing.

The `extension` self-check was removed with `ADR-010`. Each self-check is also available via its own `pnpm run test:*` script in `runtime/package.json`. They are *self-contained*: stubs for the session-factory seam let them run without keys and without pi in the loop.

### End-to-end verification

There is no `pnpm run smoke` script anymore — the legacy one was removed. The end-to-end path is now `pnpm run test:e2e` (`vitest run tests/smoke-e2e.test.ts`), which exercises the CLI's loop and persistence paths against a vitest harness that mocks decide/execute and runs `node` for real verification. With no key, the harness degrades gracefully: three auth-fails → intervención, task remains `Recibida`, no crash. With a key, it should reach `Completada` and the verification step fires.

## 7. Telemetry boundaries (C2)

`WorkerTelemetry` is **observability**, not correctness (`runtime/src/telemetry/types.ts`, ADR-009 C2):

- `usage` / `contextUsage` are *null* if pi didn't return them; the decision proceeds on text, never on telemetry.
- `telemetryUnavailable: true` + `reason` mark a missing/stale observation; AIES warns in `log.jsonl` and continues with the iteration backstop (RNF-19: never silent continuation).
- `contextUsage.tokens: null` is a **real** state in pi (post-`autoCompaction`, pre-response), not a bug — AIES maps it to `telemetry_unavailable` and keeps going.
- `getSessionStats()` is session-cumulative. `telemetry/session.ts::readSessionTelemetry` returns the **delta** (`after − before`) per turn, using the helpers in `telemetry/pi-events.ts` (`mapContextUsage`, `normalizePercent`). `cost` is delta'd the same way.

## 8. Config and limits (`ADR-005`, `MVP-v0-Scope §4`)

`runtime/aies.config.json`:

```json
{
  "provider": "anthropic",
  "models": { "orchestrator": "claude-sonnet-4-5",
              "explorer":     "claude-haiku-4-5",
              "implementer":  "claude-sonnet-4-5",
              "verifier":     "claude-haiku-4-5" },
  "orchestratorThinkingLevel": "low",
  "limits": { "maxIterations": 12 }
}
```

- Provider and model names are versioned in the repo. Keys come **only** from env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) via `ModelRuntime.create()`.
- `AIES_CONFIG` env var overrides the config path (used in `06-research/experiments/` for alternate lanes).
- `orchestratorThinkingLevel` is `low` by default (provisional, ADR-007). Calibration in `06-research`.
- `maxIterations = 12` is the backstop. Cost is `off`; context is `observed-autoCompaction-backstop-iter` (i.e., observed via pi's native compaction and backed by the iteration cap).

## 9. Common changes and where to start

- **Change the orchestrator prompt or decision schema** → `runtime/src/orchestrator/prompts.ts` (`ORCHESTRATOR_SYSTEM_PROMPT`) and `runtime/src/orchestrator/parse.ts` (Zod). Both must move together.
- **Add a new capability** → `runtime/src/workers/capabilities.ts` (allowlist) and `runtime/src/workers/tools.ts` (`runWorker`). Plus update `runtime/aies.config.json` for the model.
- **Change how pi is wrapped** → `runtime/src/workers/session-factory.ts` and `runtime/src/orchestrator/decide.ts` (workers + orchestrator session construction). Event mapping lives in `runtime/src/telemetry/pi-events.ts`.
- **Change a limit** → `runtime/src/limits.ts` and `runtime/aies.config.json`. ADR-005 says values come from `06-research`.
- **Add a new log entry shape** → `runtime/src/observability.ts` and the type union in `LogEntry`. Update the metrics extractor in `runtime/src/research/metrics.ts` to consume it.
- **Add a metrics dimension** → extend the `MetricsReport` in `runtime/src/research/metrics.ts`; the dataset is `log.jsonl`.

See [architecture.md](architecture.md) for the conceptual model behind each of these, and the [principles](../01-Concept/Principles.md) and [ADRs](../05-Decisions/) for the policy that pins them down.
