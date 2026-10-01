# AIES Real Dogfooding Log

This directory records the empirical, unvarnished history of real dogfooding runs of AIES.

## Purpose

The dogfooding log exists to:
1. **Record ground truth**: Preserve what actually occurred during development runs—exact tickets, models, token consumption, wall-clock times, delegation trees, and tool invocations.
2. **Prevent narrative revisionism**: Separate observed facts and measured results from model thinking, hypotheses, and retroactive justifications.
3. **Identify architectural bottlenecks**: Provide empirical evidence of where time, tokens, and context are wasted (e.g., redundant investigations, lossy MCP proxying, fragile verification contracts, and session amnesia).
4. **Establish quantitative baselines**: Provide concrete before/after baselines to measure the impact of upcoming enhancements (such as AIES v1.1 and Work Unit Memory).

For the narrative synthesis of the September 30 – October 1, 2026 dogfooding period, see [2026-09-30--2026-10-01.md](./2026-09-30--2026-10-01.md).

## Metric Definitions

To ensure accurate interpretation of the figures in this log, metrics are defined as follows:

- **Wall-clock**: The total elapsed real-world time measured from the start of the session to its final event or termination.
- **Main tokens**: Tokens consumed strictly within the Parent/main conversational thread (including user prompts, system instructions, tool calls, thinking/reasoning blocks, and assistant responses).
- **Agent tokens**: Tokens consumed across all delegated child sessions (Explore, Worker, Verify).
- **Total tokens**: The arithmetic sum of main tokens and agent tokens.
- **Cache-read caveat**: Token counts reported by providers and runtime telemetries may include substantial amounts of cached input tokens (`cacheRead`). Consequently, high token counts do not necessarily represent fresh, billable generation tokens or proportional API costs.
- **Model heterogeneity**: The `Parent Model` indicates the LLM powering the main orchestrator thread. It does **not** imply that child delegations used the same model. Individual child roles (Explore, Worker, Verify) can be independently mapped to separate models via `aies.json` or environment variables, as shown in Session 8 (EZE-493).
- **Cost comparability caveat**: Cost comparisons between sessions require equivalent underlying telemetry. Several sessions in this sprint operated under providers where child agent costs were unrecorded (`null`), making cross-session financial comparisons incomplete.

## Chronological Table of Runs

| Date & Time (UTC) | Ticket | Goal | Parent Model | Child Model(s) | Wall-clock | Delegations | Tokens (Agents / Total) | Result | Key Findings | Note Link |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-09-30 07:40 | EZE-488 | Structural Verify criteria matching | Qwen3.8 Flash | Qwen3.8 Flash | 142.6 min | 7 (1 exp, 4 wrk, 2 ver) | 56.1M / 60.1M | BLOCKED (402 infra) | Child Verify failed on exact string match; 402 payment failure blocked headless smoke; ESM module caching discovered. | [Session 1](./sessions/2026-09-30-0740-eze-488.md) |
| 2026-09-30 15:29 | EZE-488 | Single-delegation verification of EZE-488 diff | DeepSeek v4.1 Flash | DeepSeek v4.1 Flash | 35.3 min | 1 (1 ver) | 4.2M / 4.4M | BLOCKED (self-hosting) | Self-hosting paradox: Verify's read-only sandbox blocked `npm test` due to nested sandbox sockets and profile writes. | [Session 2](./sessions/2026-09-30-1529-eze-488.md) |
| 2026-09-30 16:25 | EZE-490 | Direct MCP capture for Linear payloads | DeepSeek v4.1 Flash | DeepSeek v4.1 Flash | 50.2 min | 4 (1 exp, 2 wrk, 1 ver) | 8.0M / 9.7M | PASS | Parent LLM lossy copying of `remote` was dropping `## Aceptación`; direct `tool_result` event capture fixed it. | [Session 3](./sessions/2026-09-30-1625-eze-490.md) |
| 2026-09-30 18:53 | EZE-489 | Prevent cross-repo ticket mutations | DeepSeek v4.1 Flash | DeepSeek v4.1 Flash | 128.7 min | 10 (1 exp, 5 wrk, 4 ver) | 11.9M / 14.3M | PASS (rev. 4) | High delegation churn (10 calls); path lookup rework caused uniqueness bug and missing docs D30; demonstrated amnesia. | [Session 4](./sessions/2026-09-30-1853-eze-489.md) |
| 2026-10-01 07:01 | EZE-492 | Fresh runtime requirement after extension edits | DeepSeek v4.1 Flash | DeepSeek v4.1 Flash | 28.0 min | 3 (1 exp, 1 wrk, 1 ver) | 2.1M / 3.4M | PASS (premature Done) | In-process children run stale cached modules; created `runtime-freshness.ts`; ticket marked Done in Linear before commit/review. | [Session 5](./sessions/2026-10-01-0701-eze-492.md) |
| 2026-10-01 07:37 | EZE-492 | Cover `models.json` & verify `stale_runtime` block | DeepSeek v4.1 Flash | DeepSeek v4.1 Flash | 3.0 min | 2 (1 wrk, 1 ver) | 128K / 717K | BLOCKED (stale runtime) | Guard detected modified extension and blocked same-process Verify in 3 ms; required process relaunch. | [Session 6](./sessions/2026-10-01-0737-eze-492.md) |
| 2026-10-01 07:48 | EZE-492 | Clean fresh-process verification of EZE-492 | DeepSeek v4.1 Flash | DeepSeek v4.1 Flash | 13.4 min | 1 (1 ver) | 956K / 1.3M | PASS | Clean single-pass verification confirmed all 7 criteria without modifying code or committing prematurely. | [Session 7](./sessions/2026-10-01-0748-eze-492.md) |
| 2026-10-01 14:28 | EZE-493 | Self-hosting test harness and isolated profiles | GPT-6 Luna | GLM-5.3 Flash (Exp), MiMo-v2.6 Flash (Wrk), GPT-6 Luna (Ver) | 162.8 min | 7 (1 exp, 4 wrk, 2 ver) | 22.9M / 23.3M | PASS (rev. 4) | `scripts/test-harness.sh` isolates profiles and skips nested sandbox sockets (19 skips); Linear Done before commit. | [Session 8](./sessions/2026-10-01-1428-eze-493.md) |
