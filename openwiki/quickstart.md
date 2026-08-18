# OpenWiki — AIES

> Documentación derivada de la spec (`01-Concept/…06-research/`) y del runtime v0 (`runtime/`). Las páginas resumen y enlazan; las definiciones canónicas viven en los `.md` originales.

## What is AIES

AIES is a **harness** — the configuration, rules, state, and coordination that organize the work of AI agents during development tasks. It is **not** an agent, a model, a workflow, or a memory system. The single rule is:

> AIES organizes the work; the agents perform the work.

The design starts from six motivating problems (`01-Concept/Problem.md`): context overload in a single agent, oversized process for small tasks, loss of visibility when the agent does everything, no continuity between sessions, wasted cost from using the strongest model for everything, and large tasks becoming uncontrollable.

## Repository map

The repo is a spec + a working v0 runtime, both in the same tree.

| Area | What it is | Where |
|---|---|---|
| **Concept** | Why AIES exists; vision, problem, goals, principles, non-goals | `01-Concept/` |
| **Requirements** | `REQ-F-01…27`, `RNF-01…20`, glossary, task model (`Task`, `Work Unit`) | `02-Requirements/` |
| **Architecture** | Component, runtime, decision, agent, capability, and MVP-v0 scope models | `03-Architecture/` |
| **Behavior** | Lifecycle of a task | `04-Behavior/` |
| **Decisions** | ADR-001…ADR-009 (architecture decisions record) | `05-Decisions/` |
| **Research** | Measurement and validation scaffolding (hypotheses `H-01…H-06`, baselines, experiments) | `06-research/` |
| **Runtime v0** | The TypeScript implementation of the spec on top of `pi` | `runtime/` |

The traceability chain is `01-Concept → 02-Requirements → 03-Architecture → 04-Behavior ↔ 05-Decisions → runtime → 06-research`. Concept is the only source of truth for goals, principles, and non-goals; later phases derive from it and must not contradict it.

## Runtime v0 at a glance

The v0 runtime (`runtime/`) realizes everything described in `03-Architecture/MVP-v0-Scope.md`. The whole package is small: ~3 000 lines of TypeScript.

- **AIES-core** owns the decision loop. **pi** (`@earendil-works/pi-coding-agent`) is the engine that runs workers and provides the multi-provider `ModelRuntime`. See `ADR-009` for the boundary.
- **Three v0 capabilities** (one worker each): `explorer` (read-only), `implementer` (read/write/edit/bash), `verifier` (read/bash — never edits). Allowlists are in `runtime/src/workers/capabilities.ts`.
- **One orchestrator** — a single `AgentSession` with `noTools: "all"` and a system prompt that emits a structured JSON decision. See `ADR-007`.
- **Decisions and results** are written to `log.jsonl`; the runtime state to `state.json`. Both are persisted under `<agentDir>/aies/<hash(cwd)>/` (outside the repo), per `ADR-008`.
- **Auth is by env** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Provider/model names are in `runtime/aies.config.json`. No secrets in the repo.

Run it:

```bash
cd runtime
npm install
npm run build
ANTHROPIC_API_KEY=sk-ant-... npm run smoke
```

The smoke task is a tiny ESM repo at `runtime/fixtures/smoke-repo/` with an `AGENTS.md` the loader picks up. The `log.jsonl` is the dataset for `06-research/`; emit metrics with:

```bash
npm run research:metrics -- <path/a/log.jsonl>
```

## Where to go next

- **[Architecture](architecture.md)** — the conceptual model: tasks, work units, state, the decision loop, capabilities vs. agents, verification as a capability.
- **[Runtime](runtime.md)** — the v0 implementation: directory layout, how the loop is wired, where the persistence/observability/telemetry boundaries live, how to run the smoke and the metrics.
- **[Conventions & decisions](conventions.md)** — the principles, goals, non-goals, requirements, and the nine ADRs that bind the spec.
- **[Research](research.md)** — the `06-research/` validation scaffolding: hypotheses `H-01…H-06`, the two baselines, the experiments started, and the metrics extractor.
- **[Source map](source-map.md)** — direct pointer table: concept → required and source files per topic.

## Operational notes

- Node ≥ 20. ESM, strict TypeScript.
- Provider keys are read from the environment by `ModelRuntime.create()`; never stored in the repo.
- With no key, the runtime degrades gracefully: the harness is verified, no round-trip is executed.
- The repo is shipped with a `.gitignore` that excludes `node_modules/`, `dist/`, `.env`, and `*.log`.
- The runtime's own `.gitignore` (`runtime/.gitignore`) further excludes vitest artifacts and similar.
