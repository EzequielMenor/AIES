/**
 * Pure usage aggregation for the Agent Observatory (AIES-010C).
 *
 * The Parent bucket is never mixed with child usage: `main` is the Parent usage
 * exactly, `agents` is the sum of the child buckets and `total` is
 * `main + agents`, counted once. Token counts come from provider/runtime usage
 * records; reasoning is already part of output and is never added again.
 *
 * An unknown cost (`null`) is never estimated. When any included usage bucket has
 * an unknown cost, the aggregate cost is `null` too.
 */

/** One usage sample: what provider/runtime reported, nothing derived. */
export interface UsageBucket {
  totalTokens: number;
  cost: number | null;
}

/** Main (Parent), Agents (children) and Total (Main + Agents). */
export interface UsageAggregate {
  main: UsageBucket;
  agents: UsageBucket;
  total: UsageBucket;
}

const ZERO_TOKENS = 0;

function tokensOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : ZERO_TOKENS;
}

function costOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reduce any input shape to a `UsageBucket`, treating an absent bucket as unknown cost. */
export function normalizeUsage(bucket: UsageBucket | null | undefined): UsageBucket {
  if (!bucket) return { totalTokens: ZERO_TOKENS, cost: null };
  return { totalTokens: tokensOf(bucket.totalTokens), cost: costOf(bucket.cost) };
}

/**
 * Aggregate Parent and child usage once each.
 *
 * `parent` is the Parent session usage; `agents` is one bucket per child. An
 * absent child slot is skipped: it is not an included bucket, so it cannot make
 * the aggregate cost unknown.
 */
export function aggregateUsage(
  parent: UsageBucket | null | undefined,
  agents: ReadonlyArray<UsageBucket | null | undefined> | null | undefined = [],
): UsageAggregate {
  const main = normalizeUsage(parent);

  let agentTokens = ZERO_TOKENS;
  let agentCost = ZERO_TOKENS;
  let agentCostKnown = true;

  for (const agent of agents ?? []) {
    if (!agent) continue;
    const normalized = normalizeUsage(agent);
    agentTokens += normalized.totalTokens;
    if (normalized.cost === null) agentCostKnown = false;
    else agentCost += normalized.cost;
  }

  const agentsBucket: UsageBucket = {
    totalTokens: agentTokens,
    cost: agentCostKnown ? agentCost : null,
  };

  const totalCost = main.cost !== null && agentsBucket.cost !== null ? main.cost + agentsBucket.cost : null;

  return {
    main,
    agents: agentsBucket,
    total: { totalTokens: main.totalTokens + agentsBucket.totalTokens, cost: totalCost },
  };
}
