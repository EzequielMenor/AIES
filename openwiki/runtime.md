# Runtime v1 — AIES-core

> The TypeScript/Node implementation of the spec on top of **pi** (`@earendil-works/pi-coding-agent@~0.84.2`). The runtime package is currently **0.4.0** (`runtime/package.json`). The full package is described in `runtime/README.md`. This page explains the architecture and where to look when changing something.

## 1. Where AIES-core lives

The runtime lives entirely under `runtime/`:

```text
runtime/
├── package.json              # @aies/core, bin "aies" → dist/cli.js, scripts (build/test*/research:metrics)
├── tsconfig.json             # ESM, strict, Node ≥22.19.0
├── aies.config.json          # provider + models per role (no secrets); orchestratorThinkingLevel; limits
├── README.md                 # state of implementation, gate findings, scripts, smoke
├── .gitignore
├── src/
│   ├── cli.ts                # aies "<tarea>" / aies (REPL) entrypoint (CLI standalone)
│   ├── cli-persistence.ts    # REPL session persistence
│   ├── cli-repl-helpers.ts   # helpers del REPL (readPromptLine, banner, slash dispatch) + test
│   ├── commands.ts           # registry único de /commands (fuente de /help y del completer) + test
│   ├── config.ts             # Zod-validated aies.config.json loader (AIES_CONFIG env override)
│   ├── intervention.ts       # legacy StopController (mantenido para extension/ @deprecated); el wireado activo vive en cli.ts (ADR-012: ESC parar / Ctrl+C cerrar → pausa reanudable)
│   ├── limits.ts             # LIMIT_POLICY + limitsFromConfig (incluye maxConsecutiveNoProgress, ADR-013 §7)
│   ├── observability.ts      # shapes of decision/result/compaction log entries + serializers
│   ├── string-utils.ts       # generic helpers used by TUI-01 validation (truncate, etc.) + test
│   ├── utils.ts              # generic helpers (e.g. isValidEmail) + standalone imports
│   ├── core/                 # domain (no pi): state.ts, loop.ts, events.ts, types.ts, observation.ts, state-schema.ts (catálogos v2 compartidos)
│   ├── orchestrator/         # ORCHESTRATOR_SYSTEM_PROMPT + createDecide + Zod parse.ts
│   ├── workers/              # capabilities.ts (allowlists), session-factory.ts, tools.ts, prompts.ts
│   ├── persistence/          # file_store.ts + recover.ts (ADR-008)
│   ├── research/             # metrics.ts (log.jsonl → NFR metrics) + baseline.ts (single-agent runner)
│   ├── self-check/           # step-3/4/5/11 verifications without pi (loop/persistence/orch/compaction/workers)
│   ├── telemetry/            # domain types + pi-events.ts (mapeo pi → dominio)
│   ├── ui/                    # stream-renderer.ts (output), prompt-ui.ts (selector raw /login /model), quiet.ts (silenciadores)
│   └── extension/            # @deprecated 2026-08-20 — código legacy de la extensión de Pi; se elimina en v2
├── dist/                     # tsc output; consumed by the bin and the scripts
├── fixtures/smoke-repo/      # tiny ESM repo (AGENTS.md + src/math.js) for the smoke run
└── node_modules/             # gitignored
```

`runtime/` is one half of the repo-root pnpm workspace declared in `pnpm-workspace.yaml` (the other half is `website/`). Per-package install (`pnpm install` inside `runtime/`) still works; the lockfile lives at the repo root as `pnpm-lock.yaml`.

The runtime is **the only module** of this repo that imports `@earendil-works/pi-coding-agent`. The decoupling lives in `workers/session-factory.ts` (workers) and `orchestrator/decide.ts` (decide) — the rest of the domínio (`core/`, `state.ts`, `loop.ts`, `parse.ts`) stays pure. That is the price of `ADR-009` (DIP over a 0.x SDK) and the place to refactor if pi is replaced.

> La extensión de Pi (`src/extension/`) está **deprecated** desde 2026-08-20. La CLI standalone (`src/cli.ts`) es el único entry point. Ver `05-Decisions/ADR-010-extension-de-pi.md`.

## 2. The wiring (CLI → loop)

The CLI entrypoint is `runtime/src/cli.ts`. From argv it dispatches into three modes:

- **Oneshot** — `aies "<tarea>"` (or any non-empty positional argument): runs one task to a terminal state and exits 0/1.
- **Headless** — `aies run "<tarea>"` (alias explícito del oneshot para CI/scripts; admite `cat task.txt | aies run` para la tarea por stdin). Mismas exit codes 0/1/2 que el oneshot normal.
- **REPL** — `aies` (no args): interactive prompt `❯ `; each line is a new task over the project. Commands: `/help`, `/state`, `/state --json`, `/resume`, `/clear`, `/exit | /quit`. See `cli.ts::HELP_TEXT`.

```text
cli.ts
  ├── loadConfig()                              # aies.config.json (Zod) + VerificationPolicy
  ├── limitsFromConfig(cfg)                     # limits.ts
  ├── resolveModels(runtime, cfg, AIES_MODEL)   # model-per-role real y estricto (sin fallback silencioso)
  ├── store = new LocalStore(cwd)               # cli-persistence.ts (<cwd>/.aies/)
  ├── decide = createDecide({ cwd, model, thinkingLevel, signal, modelRuntime })
  │                                            # orchestrator/decide.ts — AgentSession efímera por turno
  ├── execute = buildExecute(wctx, signal, verification)   # workers/tools.ts::runWorker + verification/engine gate
  ├── controller = new AbortController()        # SIGINT → abort (no exit, no kill en la primera señal; segunda SIGINT → exit 130)
  ├── renderer = new StreamRenderer(...)        # ui/stream-renderer.ts (verbose opcional con AIES_VERBOSE=1)
  └── runCycle(task, { ..., roleModels, modelRuntime, verification })
                                                 # runLoop(state, { decide, execute, handlers, ... })
        └─ store.saveState(finalState)
```

What this means:

- Los modos: argv con texto posicional corre `runOneshot(taskArg)`; sin texto entra en `runRepl()` hasta `/exit`. El REPL carga `.aies/state.json`; si está `En curso` (o `Recibida`), avisa y `/resume` continúa el snapshot (`resumeFrom`). **Señales durante un run (ADR-012):** ESC → pausa (vuelve al prompt). Ctrl+C → pausa, persiste estado, cierra el REPL. 2º Ctrl+C → `process.exit(130)`. `Fallida` se reserva para inviabilidad y terminación por límite.
- **Input del REPL — contrato de Enter** (`cli.ts::readPromptLine`): el REPL NO usa `rl.question()` (resolvería en el primer `\n` del input y enviaría un fragmento de un paste multi-línea al orquestador, con el resto entrando luego como intervención al `onInterventionLine`). En su lugar `readPromptLine` muestra el prompt con `rl.prompt()` y sólo resuelve con el contenido completo cuando llega un `\r` *standalone* en el stream crudo — exactamente lo que envía la tecla Enter. Los `\n` embebidos en un paste (CRLF o LF) NO disparan el orquestador; preservan saltos de línea dentro del mensaje. `close` (Ctrl+C / Ctrl+D) rechaza: no se envía contenido parcial. Las garantías están cubiertas por `src/cli-repl.test.ts`.
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
| Multi-provider runtime | `ModelRuntime.create()` | `model-runtime.ts` (compartido entre orchestrator y workers) |
| Session factory | `createAgentSession({...})` | `workers/session-factory.ts`, `orchestrator/decide.ts` |
| Orchestrator | `noTools: "all"` + `systemPromptOverride` via `DefaultResourceLoader` | `orchestrator/decide.ts` |
| Worker | `tools: string[]` allowlist + ephemeral `SessionManager.inMemory(cwd)` | `workers/session-factory.ts` |
| Worker model-per-role | `models[capability]` resuelto por `resolveRoleModels` (default: orchestrator) | `workers/tools.ts::runWorker` |
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

Defined in `runtime/src/observability.ts`. Four entry shapes:

- **`type: "decision"`** — one per turn of the loop; carries `operación`, `ajustePlan`, `motivo`, optional `unidad`, `capacidad`, `comunicación`, `condición`, `parseFail`, the orchestrator's turn telemetry (`usage` / `contextUsage` / `telemetryUnavailable` / `telemetryReason`) and the model-per-role label (`modelo: "provider/model-id"` cuando `resolveWorkerModel` lo conoce, ausente en tests/entradas sintéticas). Optional `ts` (ISO).
- **`type: "resultado"`** — one per executed operation; carries `resultado` text, `kind` (`info | unidad | comunicación | terminación | fallo | límite | parse_error`), `unidadId`, telemetry, optional `límite_alcanzado`, optional `modelo` (etiqueta del worker que ejecutó la unidad: orchestrator en `obtener información`, capability de la unidad en `ejecutar una unidad`, ausente en comunicar/terminar), y opcional `atribución`. (`atribución` was an E-01A experimental field; the flag is gone in the current CLI.)
- **`type: "compaction"`** — `compaction_start`/`compaction_end` events from pi, with `tokensBefore`/`estimatedTokensAfter`/`willRetry` and the reason. These are not loop turns; they leave a footprint for `RNF-18/19` and `H-01`.
- **`type: "tool"`** — Tool trace (v0.5 *Caja de cristal*): one per completed worker tool-execution, paired call↔result by `runtime/src/core/tool-trace.ts` (`createToolTraceRecorder`, wired in `cli.ts::runCycle`). Carries `herramienta`, `args` relevantes (payloads textuales resumidos como `<N líneas>`, nunca volcados), `target`, `archivos_leidos`/`archivos_modificados`, `resumen` de una línea del resultado, `error`, más `iter`/`unidadId`/`capacidad` para correlación con la vuelta. The main view only shows the `✓/✗ tool target · resumen` line from the renderer; full inspection is `/trace [unidad]`. Metrics extractors ignore this type (filtered by `decision|resultado|compaction`).

The CLI assigns `ts: new Date().toISOString()` at emission time, so wall-clock per turn is computable from the log alone. `modelo` (cuando está) deja huella del modelo real con que corrió cada rol — útil para auditoría de model-per-role y para el extractor de métricas de `06-research`.

## 5.1 Renderer behavior on task failure

`runtime/src/ui/stream-renderer.ts` accumulates state across the loop so that `onTaskFailed(reason)` can paint more than a single line. The contract:

- **`failedUnits: Map<unitId, text>`** — populated by `onWorkerFinish` whenever `result.passed === false`; cleared on `finalize()`.
- **`failedVerifications: string[]`** — populated by `onVerificationResult` when `verdict === "FAIL"`; cleared on `finalize()`.
- **`isRetrySafe: boolean`** — set on `execution:resolved` from the result kind: `fallo` / `parse_error` → `true`, `límite` → `false`, anything else leaves the previous value.
- **`onTaskFailed(reason)`** renders a bar with `✗ TASK FAILED`; if `isRetrySafe` it appends a green `[retry-safe]` marker; then a compact `Fallos: N unidades fallidas · M verificaciones fallidas` line (singular/plural agreed); then, when present, a `Unidades fallidas:` and `Verificaciones fallidas:` block with one bullet per entry.
- **`finalize()`** clears the three pieces of state so the next task starts clean.

The companion tests live in `runtime/src/ui/stream-renderer.test.ts` (retry-safe marker, populated lists, singular/plural, post-`finalize()` reset). The vocabulary is governed by `ROADMAP-TUI.md` §4.6 (state glyphs) and the closing card by §4.7 (`CompletionCard` / `FailureCard`).

## 5.2 Adaptive plan tree and worker telemetry ordering

- **Adaptive plan tree**: When `onDecideSuccess` receives a plan adjustment with 2+ units (`decision.ajustePlan.unidades.length > 1`), `StreamRenderer` renders a visual plan tree using `Plan:` with branch glyphs (`├─` and `└─`) before starting execution.
- **Worker block integrity**: The per-iteration dim telemetry line (`· iter N/max · <tok> tok · $<cost> · ...`) is queued and printed *after* `onWorkerFinish` closes the worker block with `└─ Resultado: ...`, keeping the worker output clean and contiguous.

## 5.3 Deterministic verification pipeline (`runtime/src/verification/engine.ts`)

The default verification surface in 0.4 is **not** the verifier LLM — it is a deterministic check of the project's own scripts. The verifier LLM is now the fallback for residual semantic criteria.

Engine contract (`runtime/src/verification/engine.ts`):

- **Discovery** (`discoverChecks(cwd)`) — reads `package.json` (`packageManager`, `scripts`, deps); falls back to lockfile. Picks, in order: typecheck (`typecheck` / `type-check` / `check-types` script, or `tsc --noEmit` si hay `tsconfig.json` + `typescript`), tests (script `test`), lint (script `lint`). `build` NO se incluye — typecheck+tests suelen aportar más señal que `build` sin un sobrecoste sistemático.
- **Execution** (`runProjectChecks(cwd, opts)`) — corre cada check con timeout duro (default 30 s, configurable vía `repair.checkTimeoutMs`); `spawn` con `detached: true` + `CI=1` en el entorno del hijo para que vitest/jest corran una vez y salgan (no-TTY). El timeout mata al grupo de procesos (`process.kill(-pid, 'SIGKILL')`); no se inventan flags `--watch=false` / `--ci` para runners arbitrarios.
- **Blocked** — si `node_modules/` no existe, retorna `blocked` con un mensaje accionable (dependencias sin instalar); no se ejecuta nada (no es fallo de código).
- **Empty** — `ProjectChecksReport.empty=true` significa que NO hay checks detectables en el proyecto: fallback legítimo al verifier LLM.
- **Failure extraction** — `extractFailure(text)` filtra líneas con `assert/expected/error TS/FAIL/✗/failed/Error/cannot find/is not defined/SyntaxError/TypeError`; la salida se recorta (`OUTPUT_TAIL_CHARS = 4000`) para no volcar megas al prompt.

Cómo lo usa `buildExecute` (`runtime/src/cli.ts::buildExecute(wctx, signal, verification)`):

1. **Verifier (`cap === "verifier"`) — deterministic-first** — `runGate` corre antes del LLM. Si falla: `WorkerReport.status="unsatisfied"` con la salida exacta como evidencia (cero tokens LLM). Si pasa y la unidad NO tiene `criteriosAceptacion`: `status="satisfied"` directo (cero overhead). Si pasa y quedan criterios semánticos: el verifier LLM corre con la nota `checks deterministas ya en exit 0: …` añadida a `evidenciaPrevia`.
2. **Implementer (`cap === "implementer"`) — repair loop** — tras el implementer, `runGate` corre los checks reales. Si fallan, hasta `verification.maxRepairAttempts` ciclos de reparación focalizada: el implementer se re-invoca con un `feedbackCorrectivo` que contiene la salida exacta de los checks fallidos y la orden de corregir SOLO lo necesario para que pasen. La telemetría de cada re-invocación se suma en `mergeTelemetry`. Al terminar (sea en `allPassed` o agotando intentos), el `WorkerReport` se aumenta con los criterios estructurados (`augmentReport`); si los checks deterministas siguen fallando al cerrar, `passed` se queda en `false` (invariante 6 — no se inventa éxito).
3. **Explorer** — no muta el repo; `runGate` se salta.

Las invariantes del pipeline (testeadas en `tests/verification.test.ts` + `tests/recovery.test.ts`):

- **Sin éxito inventado** — si el gate determinista pasa pero el worker no emitió reporte, `passed` se queda en `null`; el bucle lo trata como pendiente, no como verde.
- **Sin flags inventados** — sólo se ejecutan scripts reales del proyecto; el único flag añadido es `CI=1` en el entorno, no en el argv.
- **Reparación acotada** — `maxRepairAttempts` se respeta aunque los checks no pasen; si se agota, la unidad cierra con `passed=false` y el orquestador recibe la salida completa de los checks fallidos.
- **Reporte no se pierde** — el `WorkerReport` del worker se preserva y se le añaden los criterios deterministas (`gateCriteria`); los `unmetCriteria` se concatenan con los nombres de los checks fallidos.

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

`pnpm test` runs the vitest suites (`parse`, `unitid`, `loop`, `cost`, `smoke-e2e`, `update`) plus the `test:cli` suite (CLI, renderer, auth, commands, model-runtime, REPL helpers, workers/tools) and the four self-checks in `runtime/src/self-check/`:

- `tests/parse.test.ts` — Zod parser against the orchestrator schema (incluye variantes discriminadas de `Decision` v2 + `comunicación`/`condición` `nullable`).
- `tests/unitid.test.ts` — non-existent unit id is not terminal (re-emit, not `Fallida`); cubre `UnitRef` planificada/inexistente.
- `tests/loop.test.ts` — happy path of MVP-v0-Scope §9, plus C3 (3 parse-failures → intervención) and ADR-005 (limit → intervención, not Fallida); invariantes ADR-013 (checkpoint previo al worker, runStatus guard, no-progress).
- `tests/cost.test.ts` — cost telemetry deltas (cost stays `off` per `ADR-005`).
- `tests/smoke-e2e.test.ts` — vitest e2e harness around the loop and persistence.
- `tests/dogfooding.test.ts` — siete recorridos (A–G) con fixtures y dobles deterministas que validan las invariantes de `ADR-013` (intención, contrato, mutación de plan, espera humana, verificación, recuperación, no-progreso).
- `tests/verification.test.ts` — verificación determinista (`runtime/src/verification/engine.ts`): descubrimiento de checks, timeout duro, `empty`/`blocked`, criterios estructurados del reporte.
- `tests/recovery.test.ts` — el ciclo completo del MVP: implement → deterministic verify → focused repair → verify again (mockea sólo `runWorker`; correa el gate real contra un proyecto temporal con script `test` determinista).
- `src/cli-repl.test.ts` — contrato del input del REPL (`readPromptLine`): paste multi-línea NO dispara el orquestador hasta que el usuario pulsa Enter; los fragmentos del mensaje NO se filtran como intervención; Ctrl+C rechaza sin enviar contenido parcial.
- `src/cli-repl-helpers.test.ts` — `banner`, `setupSlashDiscovery` y dispatch de comandos vía el registry.
- `src/commands.test.ts` — invariantes del registry (`commands.ts`): unicidad de `name`/alias, idempotencia cross-session, parseo.
- `src/prompt-ui.test.ts` — selector raw de `PromptUI` (search/select/secret/info) usado por `/login`, `/logout` y `/model`.
- `src/string-utils.test.ts` — utilidades genéricas (e.g. `truncate`) creadas durante TUI-01; incluidas en vitest y en `pnpm run test:cli` si se añaden.
- `src/model-runtime.test.ts` — `resolveRoleModels` estricto (sin fallback silencioso), `roleModelLabel`, casos de error accionables (`unknown_provider`/`model_not_found`/`no_auth`/`invalid_ref`).
- `src/workers/tools.test.ts` — `runWorker` con `models` per-capability (model-per-role real) y comportamiento de fallback al `model` del orquestador.
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
  "limits": { "maxIterations": 12 },
  "repair": { "deterministic": true, "maxRepairAttempts": 3, "checkTimeoutMs": 30000 }
}
```

- Provider and model names are versioned in the repo. Keys come from the pi-coding-agent credential store (`~/.pi/agent/auth.json`, managed via `/login` or `aies login <provider>`, supporting api_key and the pi-provided `openai-codex` OAuth flow) or as fallback from env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) via `ModelRuntime.create()`. The interactive registry lives in `runtime/src/commands.ts`; it powers both `/help` and `/` discovery. Supported plan entries are MiniMax Token Plan (`minimax`, `sk-cp-`) and Alibaba Model Studio Token Plan China (Beijing) (`qwen-token-plan-cn`, `sk-sp-`); the retired Qwen OAuth and a separate Alibaba Coding Plan flow are not exposed.
- `AIES_CONFIG` env var overrides the config path (used in `06-research/experiments/` for alternate lanes).
- `AIES_MODEL` env var fuerza un modelo para un único run — cuenta como elección EXPLÍCITA para los cuatro roles; sin resolución válida, la tarea no se ejecuta (`resolveModels` retorna `ok=false` y sale con código 2 en oneshot / bloquea la ejecución en REPL hasta corregir `/model` o `/login`).
- **Model-per-role real** (`runtime/src/model-runtime.ts::resolveRoleModels`): cada rol (`orchestrator | explorer | implementer | verifier`) resuelve su propio `provider/model-id` contra el catálogo real. Política de default — un rol sin elección explícita hereda la `ResolvedModel` del orchestrator (no el id), no el modelo por defecto de pi salvo que el orchestrator tampoco tenga. **Sin fallback silencioso**: una elección explícita que no exista / provider desconocido / sin auth produce `RoleModelFailure` accionable (`unknown_provider`, `model_not_found`, `no_auth`, `invalid_ref`) que el CLI imprime y trata como bloqueo.
- `/model` es ahora el picker per-rol que persiste en `aies.config.json` (`runPickCommand`): `/model` muestra la tabla de asignaciones, `/model <rol>` abre el selector, `/model <rol> <provider/modelo>` es asignación directa y persistente, `/model <query>` (sin rol conocido) cambia sólo el orquestador en sesión (no persiste). Tras cualquier cambio se re-resuelven los cuatro roles. `/models` (o `aies models`) lista el catálogo de modelos disponibles por provider con estado de auth y roles asignados.
- `orchestratorThinkingLevel` is `low` by default (provisional, ADR-007). Calibration in `06-research`.
- `maxIterations = 12` is the backstop. Cost is `off`; context is `observed-autoCompaction-backstop-iter` (i.e., observed via pi's native compaction and backed by the iteration cap).
- **`repair` block** (opcional, default `DEFAULT_VERIFICATION`): `deterministic` (corre los checks reales del proyecto antes/después del verifier), `maxRepairAttempts` (reparación focalizada del implementer ante fallo determinista; cap 10), `checkTimeoutMs` (timeout duro por check; cap 600_000 ms). El bloque se traduce vía `verificationFromConfig(cfg)` y se aplica en `buildExecute`; ver §5.3.
- `AIES_VERBOSE=1` reactiva en el `StreamRenderer` el detalle interno (`Decisión: … Motivo: …` por turno, salida completa de unidades). Por defecto el scrollback no incluye la deliberación del orquestador para mantener "el stream manda, el chrome es mínimo" (sólo se imprimen SIEMPRE el plan multi-unidad y las re-descomposiciones, que son señales reales).

## 9. Common changes and where to start

- **Change the orchestrator prompt or decision schema** → `runtime/src/orchestrator/prompts.ts` (`ORCHESTRATOR_SYSTEM_PROMPT`) and `runtime/src/orchestrator/parse.ts` (Zod). Both must move together. Para cambios en la nulabilidad de campos (p. ej. `comunicación`/`condición` ahora `nullable` además de `optional`): tocar `runtime/src/core/state-schema.ts` Y `parse.ts` juntos.
- **Add a new capability** → `runtime/src/workers/capabilities.ts` (allowlist) and `runtime/src/workers/tools.ts` (`runWorker`). Plus update `runtime/aies.config.json` for the model.
- **Change how pi is wrapped** → `runtime/src/workers/session-factory.ts` and `runtime/src/orchestrator/decide.ts` (workers + orchestrator session construction). Event mapping lives in `runtime/src/telemetry/pi-events.ts`.
- **Change model-per-role resolution** → `runtime/src/model-runtime.ts::resolveRoleModels` (estricto, sin fallback silencioso) + `cli.ts::resolveModels` (imprime los `RoleModelFailure`). Si añades un rol nuevo: añadirlo a `ROLES`, a `RoleModels`, al `WorkerToolContext.models`, y al `commands.ts` registry.
- **Change the deterministic verification pipeline** → `runtime/src/verification/engine.ts` (descubrimiento + ejecución de checks) + `runtime/src/cli.ts::buildExecute` (cableado verifier-deterministic-first y repair loop del implementer). Política en `runtime/src/config.ts::VerificationPolicy` + `verificationFromConfig`; defaults en `DEFAULT_VERIFICATION`. Cobertura: `tests/verification.test.ts` (engine) + `tests/recovery.test.ts` (ciclo completo).
- **Change a limit** → `runtime/src/limits.ts` and `runtime/aies.config.json`. ADR-005 says values come from `06-research`.
- **Add a new log entry shape** → `runtime/src/observability.ts` and the type union in `LogEntry`. Update the metrics extractor in `runtime/src/research/metrics.ts` to consume it.
- **Add a metrics dimension** → extend the `MetricsReport` in `runtime/src/research/metrics.ts`; the dataset is `log.jsonl`.

See [architecture.md](architecture.md) for the conceptual model behind each of these, and the [principles](../01-Concept/Principles.md) and [ADRs](../05-Decisions/) for the policy that pins them down.
