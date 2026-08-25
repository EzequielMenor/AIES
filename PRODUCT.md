# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack
Astro

## Users
Software engineers, AI developers, and technical builders frustrated with single-agent context bloat, runaway token costs, and lack of real verification in AI-assisted development.

## Product Purpose
AIES is a lightweight, rigorous harness and runtime that organizes the work of AI agents through adaptive task decomposition, strict context isolation, and decoupled verification.

## Positioning
A pure "no-tools" orchestrator combined with ephemeral specialized workers (Explorer, Implementer, Verifier). It does not bloat conversation history or enforce heavy-handed bureaucracy on one-line fixes.

## Operating Context
Standalone CLI tool (`aies`), terminal stream UI, Node.js runtime on top of `pi-coding-agent`, local repository development workflows.

## Capabilities and Constraints
- Ephemeral subagents destroyed after every work unit (clean context per turn)
- Pure orchestrator operating strictly on explicit `RuntimeState`
- Zod schema validation boundaries for model outputs
- Deterministic loop with execution limits & dynamic re-decomposition
- Zero secrets stored in repo; uses environment keys or Pi auth store

## Brand Commitments
- Technical, high-contrast terminal aesthetic, direct, developer-first, evidence-based (P-19).
- Clean architectural clarity over marketing fluff.

## Evidence on Hand
- Working v1 runtime (`runtime/src/cli.ts`, ~3,600 LOC TypeScript)
- 20 Architectural Principles (`01-Concept/Principles.md`)
- 10 Architecture Decision Records (`05-Decisions/`)
- Empirical research and benchmarks (`06-research/` H-01 context reduction 40-60%)
- Quickstart installer script (`curl -fsSL https://raw.githubusercontent.com/EzequielMenor/AIES/main/install.sh | bash`)

## Product Principles
- AIES organizes the work; the agents perform the work.
- Intentional context: never drag search/read noise into the main reasoning thread.
- Proportional process: zero overhead for trivial edits, strict decomposition for complex work.
- Decoupled verification: the worker writing the code never self-certifies without objective checks.
