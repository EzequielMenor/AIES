# OpenWiki — AIES

> Documentación derivada de la spec (`01-Concept/…06-research/`) y del runtime v1 (`runtime/`). Las páginas resumen y enlazan; las definiciones canónicas viven en los `.md` originales.
>
> El repo incluye también un [`README.md`](../README.md) en la raíz con la visión general del proyecto, la filosofía, los non-goals y el mapa de lectura recomendado. La spec (`01-Concept/`, `02-Requirements/`, `03-Architecture/`, `04-Behavior/`, `05-Decisions/`, `06-research/`) sigue siendo la fuente canónica.

## What is AIES

AIES is a **harness** — the configuration, rules, state, and coordination that organize the work of AI agents during development tasks. It is **not** an agent, a model, a workflow, or a memory system. The single rule is:

> AIES organizes the work; the agents perform the work.

The design starts from six motivating problems (`01-Concept/Problem.md`): context overload in a single agent, oversized process for small tasks, loss of visibility when the agent does everything, no continuity between sessions, wasted cost from using the strongest model for everything, and large tasks becoming uncontrollable.

## Repository map

The repo is a spec + a working v1 runtime, both in the same tree.

| Area | What it is | Where |
|---|---|---|
| **Concept** | Why AIES exists; vision, problem, goals, principles, non-goals | `01-Concept/` |
| **Requirements** | `REQ-F-01…27`, `RNF-01…20`, glossary, task model (`Task`, `Work Unit`) | `02-Requirements/` |
| **Architecture** | Component, runtime, decision, agent, capability, and MVP-v0 scope models | `03-Architecture/` |
| **Behavior** | Lifecycle of a task | `04-Behavior/` |
| **Decisions** | ADR-001…ADR-014 (architecture decisions record; `ADR-010` deprecated); the runtime is now at **schema v2** (`STATE_VERSION=2` in `runtime/src/core/state-schema.ts`, per `ADR-013`) | `05-Decisions/` |
| **Research** | Measurement and validation scaffolding (hypotheses `H-01…H-06`, baselines, experiments) | `06-research/` |
| **Runtime v1** | The TypeScript implementation of the spec on top of `pi` | `runtime/` |
| **Product brief** | Top-level one-pager: platform, users, capabilities, brand commitments | `PRODUCT.md` |
| **Design system** | Top-level design tokens, typography, components (editorial engineering aesthetic) | `DESIGN.md` |
| **Website** | Public marketing site built from `DESIGN.md`; Astro 5 + Tailwind, sections consumed by `src/pages/index.astro` and `src/pages/roadmap.astro`; deployed to Cloudflare Workers via `wrangler deploy` (`website/wrangler.jsonc`) | `website/` (`pnpm dev` / `pnpm build` / `pnpm deploy` from `website/`) |
| **pnpm workspace** | Root manifest grouping `runtime/` and `website/` into a single workspace (`onlyBuiltDependencies: @google/genai, esbuild, protobufjs, sharp, workerd`) | `pnpm-workspace.yaml`, `pnpm-lock.yaml` |

The traceability chain is `01-Concept → 02-Requirements → 03-Architecture → 04-Behavior ↔ 05-Decisions → runtime → 06-research`. Concept is the only source of truth for goals, principles, and non-goals; later phases derive from it and must not contradict it. The repo-root `pnpm-workspace.yaml` ties `runtime/` and `website/` into one pnpm workspace; per-package install (`pnpm install` inside `runtime/` or `website/`) still works because of the workspace, and `pnpm install` from the repo root installs both.

## Runtime v1 at a glance

The v1 runtime (`runtime/`, currently `0.4.0`) realizes everything described in `03-Architecture/MVP-v0-Scope.md` and ships as a **standalone CLI** built on top of `pi` (`@earendil-works/pi-coding-agent@~0.84`). The whole package is small: ~3 600 lines of TypeScript.

> `ADR-010` (AIES como extensión de Pi) está **retirado** desde 2026-09: el código bajo `runtime/src/extension/` y `src/intervention.ts` se eliminó. La CLI standalone (`src/cli.ts`) es el único entry point.

- **AIES-core** owns the decision loop (`runtime/src/core/loop.ts`). **pi** is the engine that runs the orchestrator and workers as ephemeral `AgentSession`s and provides the multi-provider `ModelRuntime`. The binding to pi is in two modules only — `workers/session-factory.ts` (workers) and `orchestrator/decide.ts` (orchestrator) — plus the type-only mapping in `telemetry/pi-events.ts` (`ADR-009`).
- **Standalone CLI** (`runtime/src/cli.ts`) — oneshot (`aies "<tarea>"`), headless explícito (`aies run "<tarea>"`; admite tarea por stdin via `cat task.txt | aies run`, mismos exit codes 0/1/2) o REPL (`aies`, prompt `❯ `). State and log live under `<cwd>/.aies/{state.json,log.jsonl}` via `cli-persistence.ts::LocalStore`. Output uses `ui/stream-renderer.ts` (verbosity opcional con `AIES_VERBOSE=1`).
- **Three v1 capabilities** (one worker each): `explorer` (read-only), `implementer` (read/write/edit/bash), `verifier` (read/bash — never edits). Allowlists are in `runtime/src/workers/capabilities.ts`. Each is invoked from the loop via `workers/tools.ts::runWorker` (ephemeral `AgentSession` per call). The verifier capability runs **deterministic-first** (real project checks — typecheck/tests/lint — before spending verifier LLM tokens) and the implementer is followed by an automatic repair loop (max 3 attempts) when those checks fail (`runtime/src/verification/engine.ts`).
- **Model-per-role, strict** — each role (`orchestrator`, `explorer`, `implementer`, `verifier`) resolves its own `provider/model-id` against the runtime catalog (`model-runtime.ts::resolveRoleModels`). Explicit role assignments that don't resolve → actionable error, no silent fallback. `AIES_MODEL` env var overrides all roles for one run; `aies.config.json` is the persistent source. `/model` assigns per-role and persists; `/models` lists the catalog with auth status. The `WorkerInfo.model` and the `modelo` field in `log.jsonl` carry the resolved label so each turn is auditable.
- **One orchestrator per turn** — `orchestrator/decide.ts` builds an ephemeral `AgentSession` with `noTools: "all"` and `systemPromptOverride` set to `ORCHESTRATOR_SYSTEM_PROMPT`. The session is disposed at the end of each turn; the next turn builds a fresh one. The orchestrator never accumulates conversation history — the `RuntimeState` is the only input (P-09, ADR-007).
- **Auth is by the pi-coding-agent credential store** (`~/.pi/agent/auth.json`, managed via `/login` or `aies login <provider>`, supporting api_key; OAuth support depends on each provider) **or env vars as ambient source** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Provider/model names are in `runtime/aies.config.json`. No secrets in the repo.

Install and run (recommended):

```bash
curl -fsSL https://raw.githubusercontent.com/EzequielMenor/AIES/main/install.sh | bash
aies "lista los archivos del proyecto"
```

Use `aies update` to rerun the installer and update an existing installation. Before pulling, the installer detects dirty/divergent state and never overwrites it silently: non-interactive runs preserve the full installation in `~/.aies.bak.<timestamp>` and reinstall clean; interactive runs can choose `backup`, `stash`, or `abort` (`AIES_UPDATE_STRATEGY` also sets it). The installer then verifies the build, symlinked binary, and `aies --version` against the new runtime package. It clones to `~/.aies`, builds, and symlinks `aies` into `~/.local/bin/`. Manual install:

```bash
cd runtime
pnpm install   # o npm install
pnpm run build
ANTHROPIC_API_KEY=sk-ant-... aies "lista los archivos del proyecto"
```

The JSONL log is the dataset for `06-research/`; emit metrics with:

```bash
pnpm run research:metrics -- .aies/log.jsonl
```

## Where to go next

- **[Architecture](architecture.md)** — the conceptual model: tasks, work units, state, the decision loop, capabilities vs. agents, verification as a capability.
- **[Runtime](runtime.md)** — the v1 implementation: directory layout, how the loop is wired, where the persistence/observability/telemetry boundaries live, and how to run the test suites and the metrics extractor.
- **[Project overview](../README.md)** — the repo-root `README.md`: the philosophy, the non-goals, the ADRs table, and the recommended reading map for newcomers.
- **[Principles & non-goals](../01-Concept/Principles.md)** — the 20 architectural principles that bind the spec.
- **[Non-goals](../01-Concept/Non-Goals.md)** — what AIES explicitly is **not**.
- **[ADRs](../05-Decisions/)** — the architecture decisions, `ADR-001`…`ADR-014`. `ADR-010` is **Deprecated** (kept as historical record); `ADR-013` covers the runtime v1→v2 reliability refactor and `ADR-014` covers the interactive auth + `/`-discovery rework.
- **[Research scaffolding](../06-research/README.md)** — hypotheses `H-01`…`H-06`, baselines, experiments, metrics per NFR §3.

## Operational notes

- Node ≥ 22.19.0. ESM, strict TypeScript.
- Provider keys are read from the environment by `ModelRuntime.create()`; never stored in the repo.
- With no key, the runtime degrades gracefully: the harness is verified, no round-trip is executed.
- The repo is shipped with a `.gitignore` that excludes `node_modules/`, `dist/`, `.env`, and `*.log`.
- The runtime's own `.gitignore` (`runtime/.gitignore`) further excludes vitest artifacts and similar.
