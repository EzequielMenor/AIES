# Runtime v0 — AIES-core

> The TypeScript/Node implementation of the spec on top of **pi** (`@earendil-works/pi-coding-agent@~0.84.2`). The full package is described in `runtime/README.md`. This page explains the architecture and where to look when changing something.

## 1. Where AIES-core lives

The runtime lives entirely under `runtime/`:

```text
runtime/
├── package.json              # @aies/core, bin "aies" → dist/cli.js, scripts (build/spike/test*/smoke/research:metrics)
├── tsconfig.json             # ESM, strict, Node ≥20
├── aies.config.json          # provider + models per role (no secrets); orchestratorThinkingLevel; limits
├── README.md                 # state of implementation, gate findings, scripts, smoke
├── .gitignore
├── src/
│   ├── cli.ts                # aies run / aies resume / --help entrypoint
│   ├── config.ts             # Zod-validated aies.config.json loader (AIES_CONFIG env override)
│   ├── intervention.ts       # SIGINT → StopController (1st → request stop, 2nd → exit 130)
│   ├── limits.ts             # LIMIT_POLICY + limitsFromConfig
│   ├── observability.ts      # shapes of decision/result/compaction log entries + serializers
│   ├── spike.ts              # GATE — verifies the pi 0.84 facade works in vivo
│   ├── core/                 # domain (no pi): state.ts (types + transitions), loop.ts (runLoop)
│   ├── orchestrator/         # ORCHESTRATOR_SYSTEM_PROMPT + createDecide + Zod parse.ts
│   ├── workers/              # capabilities.ts (allowlists), index.ts (createExecute)
│   ├── pi-binding/           # ONLY module importing @earendil-works/pi-coding-agent (ADR-009)
│   ├── persistence/          # file_store.ts + recover.ts (ADR-008)
│   ├── research/             # metrics.ts (log.jsonl → NFR metrics) + baseline.ts (single-agent runner)
│   ├── self-check/           # step-3/4/5/11 verifications without pi (loop/persistence/orch/compaction/workers)
│   ├── telemetry/            # domain types (WorkerTelemetry, TelemetryUsage, ContextUsage, CompactionObservation)
│   └── host/                 # Host/HostSession/TurnError interfaces — the facade domain sees
├── dist/                     # tsc output; consumed by the bin and the scripts
├── fixtures/smoke-repo/      # tiny ESM repo (AGENTS.md + src/math.js) for the smoke run
└── node_modules/             # gitignored
```

The runtime is **the only module** of this repo that imports `@earendil-works/pi-coding-agent`. Everything else talks to the `Host` / `HostSession` facade in `runtime/src/host/types.ts`. That is the price of `ADR-009` (DIP over a 0.x SDK) and the place to refactor if pi is replaced.

## 2. The wiring (CLI → loop)

The CLI entrypoint is `runtime/src/cli.ts`. `aies run "<tarea>"` and `aies resume` are the two paths through it.

```text
cli.ts
  ├── loadConfig()                              # aies.config.json (Zod)
  ├── createHost({ cwd, provider, models, … })  # pi-binding/index.ts → ModelRuntime + agentDir
  ├── createStore(agentDir, cwd)                # persistence/file_store.ts
  ├── recover(agentDir, cwd)                    # persistence/recover.ts (absent/ok/corrupt → safe state)
  ├── host.createOrchestrator(onCompaction)     # AgentSession noTools:"all" + systemPromptOverride
  ├── createStopSignal()                        # SIGINT
  ├── runLoop(state, {
  │     decide:   createDecide({ session: orchSession }),         # orchestrator/
  │     execute:  createExecute({ host, out, onCompaction,
  │                                localSessionFactory?: AIES_NO_WORKERS=1 }),
  │     emit:     (entry) => store.appendLog(...),
  │     onLimit:  () => "intervenir",
  │     stopSignal: stop.stopSignal,
  │   })
  ├── orchSession.dispose()
  └── store.saveState(finalState)
```

What this means:

- **`aies run` vs `aies resume`** — `recover()` reads `<agentDir>/aies/<hash(cwd)>/state.json`. If absent, a fresh task is created. If a non-terminal task is present, it is resumed (`Recibida`/`En curso`). If `state.json` is corrupt, the session starts clean and the readable `log.jsonl` is preserved as history (`ADR-008 §5`).
- **`createHost`** resolves `agentDir` via pi's `getAgentDir()` and builds the `ModelRuntime` with `ModelRuntime.create()`. No secrets in the repo.
- **`runLoop`** runs while `taskState ∈ {Recibida, En curso}`. Each iteration is `decide(state) → execute(state, decision) → applyOperationResult`. Limits, parse failures, and SIGINT are checked before each turn; see [architecture.md §3](architecture.md#3-the-decision-loop).
- **`E-01A` experimental flag** — setting `AIES_NO_WORKERS=1` swaps `host.createWorker(cap)` for a local ephemeral session per call. Same persona/tools/model/prompt; telemetry is attributed to the orchestrator in `log.jsonl`. This is the experimental arm of E-01 (`06-research/experiments/E-01-H-01-contexto-vs-baseline.md`).

## 3. The Host facade and the pi-binding boundary

`ADR-009` is "pi in-process; AIES-core owns the loop; the binding is one module." That module is `runtime/src/pi-binding/`:

- `index.ts` is the only file that *calls* `createAgentSession`, `SessionManager.inMemory`, `ModelRuntime.create`, `getAgentDir`. It exposes:
  - `createHost({ cwd, provider, models, thinking, workerTools, orchestratorSystemPrompt })` → `Host`.
  - `createWorkerSession`, `createBaselineSession` — same factory, different tool allowlists.
  - `Host` carries `createOrchestrator(onCompaction)`, `createWorker(capability)`, `createLocalSession(capability)` (E-01A), `agentDir`, and a `dispose()`.
- `events.ts` is the **only** place that touches pi types beyond the constructor. It maps pi events (`AgentSessionEvent`, `SessionStats`, `ContextUsage`) into domain types (`WorkerTelemetry`, `CompactionObservation`).

The `Host` / `HostSession` / `TurnError` interfaces in `runtime/src/host/types.ts` are what the rest of the codebase depends on — no pi types cross this boundary. The orchestrator, workers, loop, persistence, observability, research — none of them import from `@earendil-works/pi-coding-agent`. The `spike` (`runtime/src/spike.ts`) and the self-checks are how this is verified.

### The `pi` API surface in use (`runtime/README.md` §Gate)

| Use | pi API | Where |
|---|---|---|
| Multi-provider runtime | `ModelRuntime.create()` | `pi-binding/index.ts` |
| Session factory | `createAgentSession({...})` | `pi-binding/index.ts` |
| Orchestrator | `noTools: "all"` + `systemPromptOverride` via `DefaultResourceLoader` | `pi-binding/index.ts::createOrchestratorSession` |
| Worker | `tools: string[]` allowlist + ephemeral `SessionManager.inMemory(cwd)` | `pi-binding/index.ts::createWorkerSession` |
| Telemetry | `getSessionStats()` (cumulative → delta per turn), `getContextUsage()` | `pi-binding/events.ts::computeTelemetry` |
| Context ceiling | `autoCompactionEnabled` + events `compaction_start` / `compaction_end` | `pi-binding/events.ts::mapCompaction` |
| Project context | `DefaultResourceLoader` (reads `AGENTS.md`, etc.) | `pi-binding/index.ts` |
| Project resources override | `systemPromptOverride: (base) => …` and `appendSystemPromptOverride: () => []` | `pi-binding/index.ts::createOrchestratorSession` |

The spec called for `systemPromptOverride` on `createAgentSession`; that option does **not** exist there. The correct wiring is `DefaultResourceLoader({ systemPromptOverride, appendSystemPromptOverride })`. That is the only correction between spec and code (`runtime/README.md` §Gate, table row `systemPromptOverride`).

## 4. Persistence (`ADR-008`)

`runtime/src/persistence/file_store.ts`:

- `agentDir` is pi's `getAgentDir()` (typically `~/.pi/agent/`).
- Path: `<agentDir>/aies/<sha1(cwd).slice(0,16)>/{state.json, log.jsonl}`.
- `state.json` is written atomically (`.tmp` + rename).
- `log.jsonl` is append-only; one JSON object per line.

`runtime/src/persistence/recover.ts`:

- `loadState()` returns `absent | ok | corrupt`.
- On `ok`, the persisted state is used (resume path).
- On `absent`, the CLI creates a new task.
- On `corrupt`, the CLI starts a **clean session**, emits a synthetic decision "sesión limpia (state.json corrupto); log previo conservado", and keeps `log.jsonl` intact.

The CLI also emits a synthetic decision when starting from `absent` (`"sesión nueva (sin state.json previo)"`).

## 5. Observability (`log.jsonl`)

Defined in `runtime/src/observability.ts`. Three entry shapes:

- **`type: "decision"`** — one per turn of the loop; carries `operación`, `ajustePlan`, `motivo`, optional `unidad`, `capacidad`, `comunicación`, `condición`, `parseFail`, and the orchestrator's turn telemetry (`usage` / `contextUsage` / `telemetryUnavailable` / `telemetryReason`). Optional `ts` (ISO).
- **`type: "resultado"`** — one per executed operation; carries `resultado` text, `kind` (`info | unidad | comunicación | terminación | fallo | límite | parse_error`), `unidadId`, telemetry, optional `límite_alcanzado` and `atribución` (E-01A: `"orquestador"` for the no-workers experimental branch).
- **`type: "compaction"`** — `compaction_start`/`compaction_end` events from pi, with `tokensBefore`/`estimatedTokensAfter`/`willRetry` and the reason. These are not loop turns; they leave a footprint for `RNF-18/19` and `H-01`.

The CLI assigns `ts: new Date().toISOString()` at emission time, so wall-clock per turn is computable from the log alone.

## 6. Running it

From the [quickstart](quickstart.md):

```bash
cd runtime
npm install
npm run build
ANTHROPIC_API_KEY=sk-ant-... npm run smoke
# log.jsonl at ~/.pi/agent/aies/<hash(cwd)>/log.jsonl
npm run research:metrics -- ~/.pi/agent/aies/<hash(cwd)>/log.jsonl
```

### What `npm test` covers (no pi needed)

`npm test` runs the five self-checks in `runtime/src/self-check/`:

- `loop.js` — happy path of MVP-v0-Scope §9, plus C3 (3 parse-failures → intervención) and ADR-005 (limit → intervención, not Fallida).
- `persistence.js` — state.json + log.jsonl, recovery on corrupt.
- `orchestrator.js` — Zod parser against the orchestrator schema.
- `compaction.js` — pi → domain mapping for `compaction_start` / `compaction_end`.
- `workers.js` — capability allowlists + Verifier verdict parsing.

These are *self-contained*: they use stubs for the host (`runtime/src/host/types.ts` is the seam) so they run without keys and without pi in the loop. The `spike` (`npm run spike`) is the gate against the *real* pi API.

### `npm run spike` (GATE)

Constructs the orchestrator session in vivo. With a key: runs an eco turn and reports real `usage` / `contextUsage`. Without a key: builds the session, reports the structured telemetry with `telemetry_unavailable: true` + reason. Either outcome closes the gate; only the live round-trip needs a key (`runtime/README.md` §Gate).

### `npm run smoke`

Runs `aies run --cwd fixtures/smoke-repo "añade una función greet() a src/math.ts que devuelva 'hello'"`. The smoke task is an ESM micro-repo with a `AGENTS.md` (the loader picks it up via `DefaultResourceLoader`). With no key, the harness degrades gracefully: three auth-fails → intervención (Runtime §7), task remains `Recibida`, no crash. With a key, it should reach `Completada` and the verification step fires.

## 7. Telemetry boundaries (C2)

`WorkerTelemetry` is **observability**, not correctness (`runtime/src/telemetry/types.ts`, ADR-009 C2):

- `usage` / `contextUsage` are *null* if pi didn't return them; the decision proceeds on text, never on telemetry.
- `telemetryUnavailable: true` + `reason` mark a missing/stale observation; AIES warns in `log.jsonl` and continues with the iteration backstop (RNF-19: never silent continuation).
- `contextUsage.tokens: null` is a **real** state in pi (post-`autoCompaction`, pre-response), not a bug — AIES maps it to `telemetry_unavailable` and keeps going.
- `getSessionStats()` is session-cumulative. `pi-binding/events.ts::computeTelemetry` returns the **delta** (`after − before`) per turn. `cost` is delta'd the same way.

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

- **Change the orchestrator prompt or decision schema** → `runtime/src/orchestrator/index.ts` (`ORCHESTRATOR_SYSTEM_PROMPT`) and `runtime/src/orchestrator/parse.ts` (Zod). Both must move together.
- **Add a new capability** → `runtime/src/workers/capabilities.ts` (allowlist) and `runtime/src/workers/index.ts` (`persona`, `buildWorkerPrompt`). Plus update `runtime/aies.config.json` for the model.
- **Change how pi is wrapped** → `runtime/src/pi-binding/index.ts` and `runtime/src/pi-binding/events.ts`. Everything else only sees `Host`/`HostSession` in `runtime/src/host/types.ts`.
- **Change a limit** → `runtime/src/limits.ts` and `runtime/aies.config.json`. ADR-005 says values come from `06-research`.
- **Add a new log entry shape** → `runtime/src/observability.ts` and the type union in `LogEntry`. Update the metrics extractor in `runtime/src/research/metrics.ts` to consume it.
- **Add a metrics dimension** → extend the `MetricsReport` in `runtime/src/research/metrics.ts`; the dataset is `log.jsonl`.

See [architecture.md](architecture.md) for the conceptual model behind each of these, and [conventions.md](conventions.md) for the principles and ADRs that pin them down.
