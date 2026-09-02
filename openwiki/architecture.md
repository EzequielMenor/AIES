# Architecture — AIES

> Conceptual model behind the spec. Canonical definitions live in `03-Architecture/` and `04-Behavior/`. This page summarizes and links.

The single rule is the same as on the [quickstart](quickstart.md): **AIES organizes the work; the agents perform the work.** Everything below is a consequence of that split.

## 1. Task and Work Unit

The two units of intent in AIES come from `02-Requirements/Task-Model.md`.

- **Task** — the developer's request. Has an `objetivo`, optional `alcance`, `restricciones`, `resultadoEsperado` and a `condicionFinalizacion`. Conceptually, it also carries an evolving `estado`.
- **Work Unit** — the small, verifiable chunk a Task is decomposed into. Has its own `objetivo`, `alcance`, `infoNecesaria`, `resultadoEsperado`, `condicionFinalizacion`, `capacidad` (capability to delegate to) and `estado`. A unit is *Terminada* only when its result is produced, its condition is met, and it has been verified when required (P-12, REQ-F-13).

```text
Task (developer intent)
   │  decomposed by  (Task-Model §3)
   ▼
1..n Work Units (verifiable, capability-tagged)
```

The runtime carries these as `Task`, `WorkUnit`, `UnitDefinition` in `runtime/src/core/state.ts`. `UnitDefinition` is what the orchestrator emits in an `ajustePlan` (no code, diffs, commands inside — only structure). See `Decision-Model.md §4.2`.

## 2. State

The state is **the only input** to every decision (`P-09`, `REQ-F-14`). It is explicit, versioned, and lives outside the repository so it can be paused and resumed (`ADR-008`, `ADR-013`). Conceptual shape from `Runtime-Model.md §3.1`, realized in `RuntimeState` (`runtime/src/core/state.ts`); the shared enums and Zod schemas are the single source of truth in `runtime/src/core/state-schema.ts` (`STATE_VERSION = 2`):

| Field | What it tracks |
|---|---|
| `version` | schema version (`STATE_VERSION = 2`); v1 snapshots are migrated on load, unsupported ones are rejected as `corrupt` |
| `taskState` | `Recibida` → `En curso` → `Completada` \| `Fallida` |
| `task`, `units`, `knownInfo`, `results` | the task's intent, the plan, accumulated knowledge, results |
| `iterations`, `unitSeq` | loop progress |
| `nextStep` | a string the orchestrator leaves for the next iteration |
| `limits` | `maxIterations` (12) + `maxConsecutiveNoProgress` (3) — see §7 and `ADR-013` §7 |
| `consecutiveNoProgress` | consecutive turns without real progress; bounded by `limits.maxConsecutiveNoProgress` |
| `runStatus` | operational status orthogonal to `taskState`: `ready` / `paused_by_user` / `waiting_for_user` / `terminal` |
| `humanWait` | when `runStatus.waiting_for_user`, the persisted `CommunicationRequest` (pregunta/razón/infoFaltante) |
| `terminalCondition`, `outcomes` | explicit terminal reason + `execution` / `verification` / `scope` |

`outcomes` is the instrumented triple (`Fix 3`, computed by `computeOutcomes`): `execution` is the path through the loop; `verification` aggregates per-unit pass/fail from structured `WorkerReport`s (see §5 and `ADR-013` §5); `scope` stays `unknown` until a criterion is defined (no implicit inference).

The `TaskState` and `UnitState` enums are the lifecycle vocabulary of `04-Behavior/Lifecycle.md`. `UnitState` adds `Sustituida` in v2 — a unit replaced by a re-plan stays observable in the state/log but is excluded from the active plan (`ADR-013` §3, invariante 8). The orchestrator moves the task to `En curso` on the first iteration by emitting `ajustePlan.tipo = "determinar el proceso"` (C3).

## 3. The decision loop

From `Runtime-Model.md §2` and `04-Behavior/Lifecycle.md §2`:

```text
       ┌─────────────────────────────────┐
       │                                 │
       ▼                                 │
  ┌─────────┐    ┌───────────┐    ┌───────────┐
  │ Estado  │──▶ │ Decisión  │──▶ │ Operación │
  └─────────┘    └───────────┘    └───────────┘
       ▲                              │
       │       ┌───────────┐          │
       └───────│ Resultado │◀─────────┘
               └───────────┘
```

The implementation lives in `runtime/src/core/loop.ts` (`runLoop`). Its invariants are not negotiable:

- **Pensar + Decidir** — one node. The orchestrator reads the state, never the conversation (`P-09`).
- **Una operación por turno** — exactly one of `obtener información | ejecutar una unidad | comunicar al desarrollador | terminar`. The catalogue is closed (Decision-Model §5/§7).
- **`ajustePlan` is a sibling**, not nested in `operación` — it mutates the plan, not the project (Decision-Model §4.2).
- **Apply before operate** — when the decision carries an `ajustePlan`, it is applied to state first, then the operation of the same turn runs against the post-ajuste state (C3).
- **Parse fail is recoverable** — a bad JSON decision is not a crash and not a reset. It is re-fed as info-insuficiente; three in a row → pedir intervención (`runtime/src/core/loop.ts`, C3 / REQ-F-18).
- **Non-existent unit id is not terminal** — if a decision references a `unidad` that isn't in the state, the loop records a `fallo` result, sets `nextStep` to the reason, increments `iterations`, and re-emits to the orchestrator. No fallback to a different unit; no `Fallida` at this layer. The iteration cap is the backstop if the orchestrator fails to correct (`runtime/src/core/loop.ts`, ADR-005).
- **Iteration cap is a backstop, not a verdict** — when `iterations ≥ maxIterations`, the loop asks for intervention by default (state remains `En curso`, runnable from the REPL). Termination is the controllable fallback (`ADR-005`).
- **Intervention is an entry** — SIGINT enters as a synthetic result and the task is marked `Fallida` (Runtime §7, `runtime/src/intervention.ts`).
- **Compaction is observable, not enforced** — `compaction_start` / `compaction_end` from pi are mapped to `log.jsonl` entries; AIES never assumes no-overflow and keeps the iteration backstop (RNF-18/19).
- **Loop guards on `runStatus`** — the loop refuses to enter if `runStatus !== "ready"` (invariante 9, `ADR-013` §4). `paused_by_user` and `waiting_for_user` are operational states orthogonal to `taskState`; only an external `/resume` (or a user reply that clears the `humanWait`) re-enables the loop.
- **Atomic checkpoint before each worker** — `runLoop` persists state immediately before invoking a worker; a checkpoint failure aborts the unit before any mutation (`ADR-013` §3).
- **`comunicar al desarrollador` is blocking** — it sets `runStatus = waiting_for_user` with the `CommunicationRequest` (pregunta/razón/infoFaltante) and does NOT invoke `execute`. The loop only resumes when a new human entry arrives (typically via `/resume` with a guide); it is never used to delegate a fixable error to the user (`ADR-013` §4).
- **No-progress counter** — `consecutiveNoProgress` tracks turns without real progress (new evidence, unit/strategy change, new cause, criteria reduction). A repeated report or finding does not reset the counter; it is bounded by `limits.maxConsecutiveNoProgress` and produces a controlled termination rather than silent continuation (`ADR-013` §7).

The decision JSON shape (the orchestrator's only output) is locked down by a Zod schema in `runtime/src/orchestrator/parse.ts`. Strict mode (`strict()` on every schema) rejects extra keys — this is the trust boundary (C3): an LLM writes to the loop only through validated JSON.

## 4. Capabilities vs. agents

Two related but distinct dimensions, from `03-Architecture/Capability-Model.md` and `Agent-Model.md`:

- **What needs to be done** = capability. Closed vocabulary in v0: `explorer`, `implementer`, `verifier` (`runtime/src/workers/capabilities.ts`). Capabilities describe purpose, entry, and expected result — not *how*.
- **Who does it** = agent/worker. v0 ships one worker per capability, each as a separate ephemeral `AgentSession` (`SessionManager.inMemory`, `MVP-v0-Scope §1`).

```text
Task ──descomponer──▶ Work Unit ──requiere──▶ Capability ──provista por──▶ Worker
```

The capability's tool allowlist is enforced **by absence in the session** (P-01, RNF-05, ADR-009): a capability the worker does not have literally cannot be used because the tool is not in the session's allowlist. Allowlists in v0 (`runtime/src/workers/capabilities.ts`):

| Capability | Tools | Why |
|---|---|---|
| `explorer` | `read grep find ls` | read-only (P-10, REQ-F-18) |
| `implementer` | `read edit write bash grep find` | can change the project |
| `verifier` | `read bash grep find ls` | runs checks but never edits (ADR-002) |

Verifier must end its turn with a literal line `VEREDICTO: PASS` or `VEREDICTO: FAIL` (`runtime/src/workers/index.ts::parseVerdict`). If the verifier needs to *change* code, it does not — that's a new Implementer unit and the loop routes it back to the orchestrator.

## 5. Verification as a capability

`ADR-002` resolves the recurring question of who verifies:

- The orchestrator does not verify (mixes coordination with execution; breaks P-01/P-02/REQ-F-03).
- Implementer-does-its-own-verify is not a universal rule (forces the same shape on every task; P-06).
- A mandatory verifier-on-every-task is not universal either (forces extra agents when no value is added; P-17 / Non-Goals §5).

Resolution: **verification is its own capability**, invoked when the task justifies it. v0 materializes this as the `verifier` capability above. The orchestrator decides whether to delegate a verification unit based on the unit's `condicionFinalizacion` and the results so far (`Decision-Model §5/§6`).

In v2 (per `ADR-013` §5) the implementer and verifier both end their turn with a single JSON `WorkerReport` (`status`, `summary`, `criteria`, `unmetCriteria`) parsed tolerantly by `runtime/src/workers/tools.ts::parseWorkerReport`. A missing or invalid report is **never** inferred as success — the unit stays `unsatisfied` and a contract error is surfaced; the verifier's legacy `VEREDICTO: PASS|FAIL` line is still accepted for back-compat. The orchestrator may also close a unit via deterministic checks (grep, tests, typecheck, build, artifact read) without a verifier round.

## 6. Re-decomposition

When a unit is too large, mis-specified, or stuck (signals listed in `Task-Model.md §7.2` and `ADR-006`): the orchestrator can emit `ajustePlan.tipo = "re-descomponer"` (or `cambiar de estrategia`) with a new set of `UnitDefinition`s and, in v2, an optional `reemplaza: string[]` listing existing unit IDs. `applyAjustePlan` moves those units to `Sustituida` (observable in the state/log but excluded from the active plan) and returns `{ state, createdUnitIds, substitutedIds }` so the orchestrator can refer to the new units by planned index in the same turn (`ADR-013` §3, invariantes 8/13). Partial accepted results are preserved (`P-13`, `RNF-10`).

Re-descomposition is **a facet of the decision**, not a separate action — same `DecideOutcome`, sibling field, applied before the operation of the same turn. The orchestrator can also pass a `feedbackCorrectivo` when executing the new unit, and the loop will route the feedback to the worker as additional context (`ADR-013` §6).

## 7. Limits

Limits are policy, not enforcement. From `ADR-005` and `runtime/src/limits.ts`:

- `maxIterations = 12` — provisional; calibration belongs to `06-research` (per ADR-004 §evidence-not-intuition).
- `cost: "off"` — usage is measured per turn for `RNF-17` but never gates the loop in v0.
- `context: observed-autoCompaction-backstop-iter` — pi's native `autoCompaction` is observed and logged; the iteration cap is the hard backstop if telemetry is missing or stale (RNF-18/19; never silent continuation).

The repertoire when a limit is hit (ADR-005) is: *pedir intervención* (default), *terminar controladamente*, *cambiar de estrategia*, *ampliación preautorizada*. `ADR-005` ties each of these to a concrete outcome: intervention leaves the task `En curso` and resumable; controlled termination marks it `Fallida` with the reason preserved.

## 8. Where to look in source

| Concern | Canonical doc | Code |
|---|---|---|
| Task / Work Unit | `02-Requirements/Task-Model.md` | `runtime/src/core/state.ts` (`Task`, `WorkUnit`, `UnitDefinition`) |
| Runtime state shape | `03-Architecture/Runtime-Model.md §3.1` | `runtime/src/core/state.ts` (`RuntimeState`) |
| Decision schema | `03-Architecture/Decision-Model.md §2/§4/§11` | `runtime/src/core/state-schema.ts` (catálogos v2), `runtime/src/core/state.ts` (`Decision`), `runtime/src/orchestrator/parse.ts` |
| Decision loop invariants | `04-Behavior/Lifecycle.md`, `ADR-005`/C3, `ADR-013` §3/4/7 | `runtime/src/core/loop.ts` |
| Capabilities | `03-Architecture/Capability-Model.md` | `runtime/src/workers/capabilities.ts`, `runtime/src/workers/tools.ts` |
| Verifier as capability | `ADR-002`, `ADR-013` §5 | `runtime/src/workers/prompts.ts::VERIFIER_PROMPT`, `workers/tools.ts::parseVerdict` + `parseWorkerReport` |
| Limits policy | `ADR-005`, `ADR-013` §7 | `runtime/src/limits.ts` (`maxConsecutiveNoProgress`) |
| Re-descomposition | `ADR-006`, `ADR-013` §3 | `runtime/src/core/state.ts::applyAjustePlan` (soporta `reemplaza`, devuelve `substitutedIds`) |
| Interactive auth & commands | `ADR-014` | `runtime/src/commands.ts` (registry), `runtime/src/ui/prompt-ui.ts`, `runtime/src/auth.ts` |
| Telemetry types | ADR-009 / RNF-07/17 | `runtime/src/telemetry/types.ts` |

See also: [Runtime](runtime.md) for how the v1 wires these, and the [principles](../01-Concept/Principles.md) and [ADRs](../05-Decisions/) for the policy that binds the model.
