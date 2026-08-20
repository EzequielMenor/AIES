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

The state is **the only input** to every decision (`P-09`, `REQ-F-14`). It is explicit, versioned, and lives outside the repository so it can be paused and resumed (`ADR-008`). Conceptual shape from `Runtime-Model.md §3.1`, realized in `RuntimeState` (`runtime/src/core/state.ts`):

| Field | What it tracks |
|---|---|
| `taskState` | `Recibida` → `En curso` → `Completada` \| `Fallida` |
| `task`, `units`, `knownInfo`, `results` | the task's intent, the plan, accumulated knowledge, results |
| `iterations`, `unitSeq` | loop progress |
| `nextStep` | a string the orchestrator leaves for the next iteration |
| `limits`, `consecutiveParseFailures` | limits backstop and parse-failure accumulator (C3, ADR-005) |
| `terminalCondition`, `outcomes` | explicit terminal reason + `execution` / `verification` / `scope` |

`outcomes` is the instrumented triple (`Fix 3`): `execution` is the path through the loop; `verification` aggregates per-unit pass/fail; `scope` stays `unknown` until a criterion is defined (no implicit inference).

The `TaskState` and `UnitState` enums are the lifecycle vocabulary of `04-Behavior/Lifecycle.md`. The orchestrator moves the task to `En curso` on the first iteration by emitting `ajustePlan.tipo = "determinar el proceso"` (C3).

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

## 6. Re-decomposition

When a unit is too large, mis-specified, or stuck (signals listed in `Task-Model.md §7.2` and `ADR-006`): the orchestrator can emit `ajustePlan.tipo = "re-descomponer"` with a new set of `UnitDefinition`s. The previous unit is replaced; partial accepted results are kept (`P-13`, `RNF-10`).

Re-descomposition is **a facet of the decision**, not a separate action — same `DecideOutcome`, sibling field, applied before the operation of the same turn.

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
| Decision schema | `03-Architecture/Decision-Model.md §2/§4/§11` | `runtime/src/core/state.ts` (`Decision`), `runtime/src/orchestrator/parse.ts` |
| Decision loop invariants | `04-Behavior/Lifecycle.md`, ADR-005/C3 | `runtime/src/core/loop.ts` |
| Capabilities | `03-Architecture/Capability-Model.md` | `runtime/src/workers/capabilities.ts`, `runtime/src/workers/tools.ts` |
| Verifier as capability | `ADR-002` | `runtime/src/workers/prompts.ts::VERIFIER_PROMPT`, `workers/tools.ts::parseVerdict` |
| Limits policy | `ADR-005` | `runtime/src/limits.ts` |
| Re-descomposition | `ADR-006` | `runtime/src/core/state.ts::applyAjustePlan` |
| Telemetry types | ADR-009 / RNF-07/17 | `runtime/src/telemetry/types.ts` |

See also: [Runtime](runtime.md) for how the v1 wires these, and the [principles](../01-Concept/Principles.md) and [ADRs](../05-Decisions/) for the policy that binds the model.
