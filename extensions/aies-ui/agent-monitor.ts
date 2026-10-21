/**
 * Shared, pure vocabulary of the subagent monitor (the rail's agent cards and the
 * `/agents` expanded card).
 *
 * Passive observation only: every value is read off an `AgentRecord` and never
 * estimated. An unknown cost is `coste n/d`, an unknown context is
 * `ctx desconocido`, and a partial cost total is always marked as partial, so a
 * subscription model can never make a total look complete.
 */

import type { AgentRecord } from "../aies-agents/observatory.ts";
import { capitalize, formatDuration, formatTokens, singleLine } from "./format.ts";
import type { SemanticColor } from "./paint.ts";
import { GLYPH } from "./vocabulary.ts";

/** The five states a child can be shown in. */
export type AgentUiState = "working" | "waiting" | "done" | "error" | "blocked";

export interface AgentStateView {
  state: AgentUiState;
  label: string;
  glyph: string;
  tone: SemanticColor;
}

/** Cost text for a child whose provider reports no monetary cost. */
export const COST_UNAVAILABLE = "coste n/d";

/** Context text for a child whose own context usage is not known. */
export const CONTEXT_UNKNOWN = "ctx desconocido";

/** Cells of the context bar. */
export const CONTEXT_BAR_CELLS = 10;

const STATE_VIEWS: Record<AgentUiState, AgentStateView> = {
  working: { state: "working", label: "trabajando", glyph: GLYPH.running, tone: "running" },
  waiting: { state: "waiting", label: "esperando", glyph: GLYPH.pending, tone: "pending" },
  done: { state: "done", label: "terminado", glyph: GLYPH.done, tone: "success" },
  error: { state: "error", label: "error", glyph: GLYPH.failed, tone: "error" },
  blocked: { state: "blocked", label: "bloqueado", glyph: GLYPH.blocked, tone: "warning" },
};

/** True once a running child has shown any sign of work: an activity, a tool call, a path or tokens. */
function hasActivity(record: AgentRecord): boolean {
  return (
    Boolean(record.currentActivity) ||
    (Array.isArray(record.changedPaths) && record.changedPaths.length > 0) ||
    (typeof record.toolCount === "number" && record.toolCount > 0) ||
    (typeof record.totalTokens === "number" && record.totalTokens > 0)
  );
}

/** The state of a child: a running child is `working` once it reports activity, `waiting` before. */
export function agentStateView(record: AgentRecord): AgentStateView {
  switch (record.status) {
    case "completed":
      return STATE_VIEWS.done;
    case "failed":
      return STATE_VIEWS.error;
    case "blocked":
      return STATE_VIEWS.blocked;
    default:
      return hasActivity(record) ? STATE_VIEWS.working : STATE_VIEWS.waiting;
  }
}

/** `Worker #1`: the role plus the observatory's per-role ordinal. */
export function agentName(record: AgentRecord, index = 0): string {
  const id = singleLine(record.id ?? "");
  const match = /^(.+)-(\d+)$/u.exec(id);
  if (match) return `${capitalize(match[1])} #${match[2]}`;
  return `${capitalize(record.role) || "Agente"} #${index + 1}`;
}

/** Elapsed milliseconds of a child, frozen at its finish. */
export function agentElapsedMs(record: AgentRecord, now: number): number | undefined {
  if (typeof record.startedAt !== "number") return undefined;
  const end = typeof record.finishedAt === "number" ? record.finishedAt : now;
  return Math.max(0, end - record.startedAt);
}

/** `mm:ss` elapsed time of a child, frozen once it finished. */
export function agentElapsed(record: AgentRecord, now: number): string | undefined {
  const elapsed = agentElapsedMs(record, now);
  return elapsed === undefined ? undefined : formatDuration(elapsed);
}

function isCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Dollars for one child: three decimals under a dollar so a small spend never reads `$0.00`. */
export function formatAgentCost(value: number): string {
  if (value === 0) return "$0.00";
  return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`;
}

/** The `≈` prefix marks a subscription amount: an API-equivalent estimate, never billed spend. */
export const ESTIMATE_PREFIX = "≈";

function costAmount(record: AgentRecord, cost: number): string {
  const amount = formatAgentCost(cost);
  return record.billing === "subscription" ? `${ESTIMATE_PREFIX}${amount}` : amount;
}

/** One child's cost (`≈` when it is a subscription estimate), or `coste n/d` when there is none. */
export function agentCostText(record: AgentRecord): string {
  return isCost(record.cost) ? costAmount(record, record.cost) : COST_UNAVAILABLE;
}

/** The cost for a row that already carries the `coste` label: the amount or a bare `n/d`. */
export function agentCostValue(record: AgentRecord): string {
  return isCost(record.cost) ? costAmount(record, record.cost) : "n/d";
}

/** One-line explanation of the cost shown, or empty when none is needed. */
export function agentCostNote(record: AgentRecord): string {
  if (!isCost(record.cost)) return "";
  if (record.billing === "subscription") {
    return "≈ estimación equivalente a API; con suscripción no es gasto facturado";
  }
  return record.billing === "api" ? "" : "facturación desconocida";
}

/** True when cache tokens were measured, so the total is not input plus output. */
export function hasCacheTokens(record: AgentRecord): boolean {
  return (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0) > 0;
}

/** `18.2k↓ 3.1k↑` from the measured breakdown, the total when only that is known, else `tokens —`. */
export function agentTokensText(record: AgentRecord): string {
  const input = record.inputTokens;
  const output = record.outputTokens;
  if (typeof input === "number" && typeof output === "number") {
    return `${formatTokens(input)}↓ ${formatTokens(output)}↑${hasCacheTokens(record) ? " +caché" : ""}`;
  }
  if (typeof record.totalTokens === "number" && record.totalTokens > 0) {
    return `${formatTokens(record.totalTokens)} tok`;
  }
  return "tokens —";
}

/**
 * The context bar, only from the child's own `getContextUsage()` reading. With no
 * known percent there is no bar: it reads `ctx desconocido`.
 */
export function agentContextText(record: AgentRecord, cells = CONTEXT_BAR_CELLS): string {
  const percent = record.contextPercent;
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0) return CONTEXT_UNKNOWN;
  const clamped = Math.min(100, percent);
  const filled = Math.round((clamped / 100) * cells);
  // A real reading above zero but under one percent is `<1%`, never a rounded `0%`.
  const percentText = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
  const bar = `${"█".repeat(filled)}${"░".repeat(cells - filled)}`;
  const window =
    typeof record.contextWindow === "number" && record.contextWindow > 0
      ? ` de ${formatTokens(record.contextWindow)}`
      : "";
  return `ctx ${bar} ${percentText}${window}`;
}

/** The mechanical detail of the current tool: the activity text minus its verb for path tools. */
export function agentToolText(record: AgentRecord): string {
  const tool = singleLine(record.currentTool ?? "");
  const activity = singleLine(record.currentActivity ?? "");
  if (!tool && !activity) return "";
  const pathTools = ["read", "grep", "find", "ls", "edit", "write"];
  const detail = pathTools.includes(tool) ? (/^\S+ (.+)$/u.exec(activity)?.[1] ?? activity) : activity;
  return tool ? `${tool}  ${detail}`.trim() : detail;
}

/** The redacted reason of an error or a block, or a neutral placeholder. */
export function agentReason(record: AgentRecord): string {
  return singleLine(record.result ?? "") || "sin motivo registrado";
}

/** Relative age of an event: `hace 12s`, `hace 3m`, `hace 2h`. */
export function formatRelative(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return `hace ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes}m`;
  return `hace ${Math.floor(minutes / 60)}h`;
}

export interface AgentTotals {
  count: number;
  elapsedMs: number;
  totalTokens: number;
  /** Sum of the costs that are known (all billing kinds). */
  knownCost: number;
  /** Known costs by billing: explicit API, subscription estimate, and unclassified (billing unknown). */
  api: { cost: number; count: number };
  estimated: { cost: number; count: number };
  unclassified: { cost: number; count: number };
  /** Children whose cost is unknown. */
  unknownCostCount: number;
}

/** Totals over every child; an unknown cost is counted apart, never as zero. */
export function agentTotals(records: readonly AgentRecord[], now: number): AgentTotals {
  const totals: AgentTotals = {
    count: 0,
    elapsedMs: 0,
    totalTokens: 0,
    knownCost: 0,
    api: { cost: 0, count: 0 },
    estimated: { cost: 0, count: 0 },
    unclassified: { cost: 0, count: 0 },
    unknownCostCount: 0,
  };
  for (const record of records) {
    totals.count += 1;
    totals.elapsedMs += agentElapsedMs(record, now) ?? 0;
    totals.totalTokens += typeof record.totalTokens === "number" && record.totalTokens > 0 ? record.totalTokens : 0;
    if (isCost(record.cost)) {
      totals.knownCost += record.cost;
      const bucket =
        record.billing === "subscription" ? totals.estimated : record.billing === "api" ? totals.api : totals.unclassified;
      bucket.cost += record.cost;
      bucket.count += 1;
    } else totals.unknownCostCount += 1;
  }
  return totals;
}

/**
 * The total cost. Complete only when every child's cost is known; otherwise it is
 * marked partial (`+` on the amount and ` parcial`) or `coste n/d`. Amounts of
 * different billing never merge: an API amount is plain, a subscription estimate
 * reads `≈$x est.`, and a cost whose billing is unknown reads `sin clasificar`
 * (`sin clas.` when several kinds are mixed). `compact` drops decimals and the
 * spaces around `+` so the qualifiers survive a narrow rail; `"min"` is the last
 * resort and shortens the unclassified qualifier to `s/c`.
 */
export function totalCostText(totals: AgentTotals, compact: boolean | "min" = false): string {
  if (totals.unknownCostCount >= totals.count) return "coste n/d";
  const partial = totals.unknownCostCount > 0;
  const kinds = [
    ["api", totals.api],
    ["est", totals.estimated],
    ["unc", totals.unclassified],
  ] as const;
  const present = kinds.filter(([, bucket]) => bucket.count > 0);
  const multi = present.length > 1;
  const money = (value: number): string => (compact ? `$${value.toFixed(2)}` : formatAgentCost(value));
  const parts = present.map(([kind, bucket], index) => {
    const plus = partial && index === present.length - 1 ? "+" : "";
    const amount = money(bucket.cost);
    if (kind === "est") return `${ESTIMATE_PREFIX}${amount}${plus} est.`;
    if (kind === "api") return `${amount}${plus}${multi ? " API" : ""}`;
    const label = compact === "min" ? "s/c" : compact || multi ? "sin clas." : "sin clasificar";
    return `${amount}${plus} ${label}`;
  });
  const text = parts.join(compact ? "+" : " + ");
  return partial ? `${text} parcial` : text;
}

/**
 * The footer line, cost first so a clipped line loses time or tokens before it
 * loses a qualifier (`parcial`, `est.`, `sin clasificar`). With a `width` the full
 * wording is tried, then the compact one, then the minimal `s/c` one, and the
 * time and tokens are appended only while they fit.
 */
export function totalsLine(records: readonly AgentRecord[], now: number, width = Number.POSITIVE_INFINITY): string {
  const totals = agentTotals(records, now);
  const candidates = [false, true, "min"] as const;
  const fitting = candidates
    .map((level) => `Σ ${totalCostText(totals, level)}`)
    .find((text) => text.length <= width);
  let line = fitting ?? `Σ ${totalCostText(totals, "min")}`;
  const tokens = totals.totalTokens > 0 ? `${formatTokens(totals.totalTokens)} tok` : "tokens —";
  for (const extra of [formatDuration(totals.elapsedMs), tokens]) {
    if (line.length + 3 + extra.length <= width) line += ` · ${extra}`;
  }
  return line;
}
