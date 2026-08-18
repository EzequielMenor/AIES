# OpenWiki plan — AIES

## Context

- No prior `openwiki/` or `.last-update.json` exists.
- No git history; repo is a collection of staged-but-not-committed directories.
- Repo is essentially **two things**:
  1. The AIES design spec (Spanish, Markdown) — concept, requirements, architecture, behavior, decisions, research scaffolding.
  2. The AIES-core v0 runtime (TypeScript/Node) — implements the spec on top of `pi` (`@earendil-works/pi-coding-agent`).

## Wiki structure

- `openwiki/quickstart.md` — entrypoint: what AIES is, the 6-phase spec, runtime v0 at a glance, how to run.
- `openwiki/architecture.md` — the core mental model: task/work unit, state, decision, loop, capabilities/agents, verification.
- `openwiki/runtime.md` — the v0 implementation: how AIES-core is wired on pi, dir structure, build/run, smoke test.
- `openwiki/conventions.md` — the policy & decision docs that bind the spec (decisions 001–009) and the process rules.
- `openwiki/research.md` — the `06-research/` validation scaffolding: hypotheses, baselines, experiments, metrics.
- `openwiki/source-map.md` — source pointers to the canonical docs/ADRs/runtime modules for each topic.

Each page will cross-link to the others. The Spanish spec is canonical — the wiki extracts and **summarizes** it, pointing to original files for the full text.

## Source evidence per page

- quickstart: `01-Concept/Vision.md`, `01-Concept/Problem.md`, `02-Requirements/README.md` (traza), `runtime/README.md`, `runtime/aies.config.json`, `runtime/package.json`.
- architecture: `03-Architecture/Runtime-Model.md`, `03-Architecture/Decision-Model.md`, `03-Architecture/Agent-Model.md`, `03-Architecture/Capability-Model.md`, `03-Architecture/Component-Model.md`, `04-Behavior/Lifecycle.md`, `02-Requirements/Task-Model.md`.
- runtime: `runtime/src/cli.ts`, `runtime/src/core/loop.ts`, `runtime/src/core/state.ts`, `runtime/src/orchestrator/`, `runtime/src/workers/`, `runtime/src/pi-binding/`, `runtime/src/persistence/`, `runtime/src/research/`, `runtime/README.md`, `runtime/aies.config.json`, `runtime/fixtures/smoke-repo/`.
- conventions: `01-Concept/Principles.md`, `01-Concept/Goals.md`, `01-Concept/Non-Goals.md`, `02-Requirements/Functional-Requirements.md`, `02-Requirements/Non-Functional-Requirements.md`, `02-Requirements/Glossary.md`, `05-Decisions/ADR-001` through `ADR-009`.
- research: `06-research/README.md`, `06-research/baselines/agente-unico.md`, `06-research/experiments/`, `06-research/pi-opencode-comparison.md`.
- source-map: pointers across all the above.

## Open questions

- None blocking. The repo is self-contained and the spec is well cross-referenced.
