/**
 * The single, compatibility-guarded private module for the optional physical
 * right rail (AIES-010D / T7).
 *
 * Pi exposes no public passive side-rail primitive; the host keeps its fullscreen
 * layout tree behind `Symbol.for("@earendil-works/pi-tui/layout-node")`. Gentle
 * patches that tree, and the user authorized exactly one isolated copy of the same
 * mechanism for AIES. The rules that keep it safe:
 *
 * - It never patches Pi, Gentle or `node_modules`; it only wraps the layout node
 *   the host already exposes on its own TUI instance and restores it on dispose.
 * - The gate is feature detection, not a version allow-list. 0.85, 0.86 and 0.87
 *   are the Pi minors that were hand-audited; the version only provides a
 *   fail-closed floor (`piVersionMayAttemptRail`): anything older than 0.85 or
 *   unparseable never attempts the hook, while a newer minor is attempted on the
 *   strength of the structural probe below, failing closed when the shape does not
 *   match.
 * - Before wrapping, the shim lazily probes the host's own layout node and only
 *   proceeds when it speaks the audited `StackLayoutNode` vocabulary
 *   (`isRecognizedStackLayoutNode`). A rejection — wrong shape or a throw — latches
 *   the shim off permanently and delegates to the host, so an unverified future Pi
 *   never gets a half-built layout injected into it.
 * - Every failure, a below-floor or unparseable version, a missing private hook, a
 *   non-fullscreen host, an unrecognized node or a throwing render is non-fatal:
 *   the module no-ops or delegates to the host, so the existing below-editor dock
 *   and narrow footer stay the fallback.
 *
 * The projection itself is pure: `renderRightRail` reuses the dock's labelled
 * facts and adds the project and git branch the rail is there to show.
 */

import { runStartedAt } from "../aies-runtime/state.ts";
import type { AgentRecord } from "../aies-agents/observatory.ts";
import type { AgentsSnapshot } from "./agents.ts";
import {
  agentContextText,
  agentCostText,
  agentElapsed,
  agentName,
  agentReason,
  agentStateView,
  agentTokensText,
  agentToolText,
  CONTEXT_UNKNOWN,
  COST_UNAVAILABLE,
  totalsLine,
  type AgentStateView,
} from "./agent-monitor.ts";
import { clipToWidth, displayWidth, formatCost, formatDuration, formatTokens, singleLine } from "./format.ts";
import { sectionHeading, statusBox, statusTitle, type StatusRow } from "./panel.ts";
import { PLAIN_PAINT, type Paint, type SemanticColor } from "./paint.ts";
import { deriveStage, GLYPH, isCompacting, isContextPressure, SPACING, STAGE_TONE, type Stage } from "./vocabulary.ts";
import { deriveTodos, renderTodos } from "./todos.ts";

/** The fullscreen width at which the physical rail is worth its columns. */
export const RIGHT_RAIL_MIN_WIDTH = 120;

/** The rail's own column budget. */
export const RIGHT_RAIL_CONTENT_WIDTH = 46;

/** From this terminal width the rail grows to `RIGHT_RAIL_WIDE_CONTENT_WIDTH` columns. */
export const RIGHT_RAIL_WIDE_MIN_WIDTH = 160;

/** The rail's column budget on a wide terminal; below the breakpoint it stays at 46. */
export const RIGHT_RAIL_WIDE_CONTENT_WIDTH = 58;

/** The rail column budget for a terminal width (the rail itself needs `RIGHT_RAIL_MIN_WIDTH`). */
export function railContentWidth(terminalColumns: number): number {
  return terminalColumns >= RIGHT_RAIL_WIDE_MIN_WIDTH ? RIGHT_RAIL_WIDE_CONTENT_WIDTH : RIGHT_RAIL_CONTENT_WIDTH;
}

/** Below this content width an agent is one line; at or above it a full card may be drawn. */
export const RAIL_CARD_MIN_WIDTH = 40;

/** The frame's top and bottom borders: a card is drawn only when they fit too. */
const RAIL_FRAME_ROWS = 2;

/**
 * Rows the rail keeps for what follows the agent cards (the blank line, the
 * collapsed Todos line and the totals footer). A card is drawn only when the
 * height budget still covers it plus this reserve; otherwise the agent is one line.
 */
export const RAIL_AFTER_AGENTS_RESERVE = 3;

/** Below this the rail content is not worth drawing at all. */
const MIN_CONTENT_WIDTH = 30;

/** The host's private fullscreen layout symbol, read by name, never patched. */
export const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** The audited major/minor floor below which the shim refuses to even attempt the hook. */
const RAIL_FLOOR_MAJOR = 0;
const RAIL_FLOOR_MINOR = 85;

/**
 * True when the runtime version may *attempt* the private rail. This is a
 * fail-closed floor, not an allow-list: any parseable `major.minor` at or above
 * the audited 0.85 floor is attempted, because feature detection — not the
 * version — decides whether the rail is actually safe on that host.
 */
export function piVersionMayAttemptRail(version: string | undefined): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > RAIL_FLOOR_MAJOR || minor >= RAIL_FLOOR_MINOR;
}

/**
 * The audited host-layout vocabulary the shim is allowed to wrap. It is read
 * structurally, never by identity: a stack node with a valid `entries` array is
 * accepted — an empty array is a legitimate stack — and anything else (a future
 * rename, a different renderer, a throw) makes the shim latch off so the dock
 * keeps working.
 */
export function isRecognizedStackLayoutNode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const candidate = node as { type?: unknown; entries?: unknown };
  if (candidate.type !== "vstack" && candidate.type !== "hstack") return false;
  if (!Array.isArray(candidate.entries)) return false;
  return candidate.entries.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    return isRenderableComponent((entry as { component?: unknown }).component);
  });
}

/** True when a value looks like a Pi TUI component the layout engine can render. */
function isRenderableComponent(value: unknown): boolean {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return false;
  const candidate = value as { render?: unknown } & Record<symbol, unknown>;
  return typeof candidate.render === "function" || typeof candidate[LAYOUT_NODE] === "function";
}

/** The project name the rail shows: the repository directory's last segment. */
export function projectLabel(cwd: string | undefined): string | undefined {
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim().replace(/[\\/]+$/u, "");
  if (!trimmed) return undefined;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const name = index >= 0 ? trimmed.slice(index + 1) : trimmed;
  return name || undefined;
}

/** The branch label, or `undefined` for an empty/unknown branch. */
export function branchLabel(branch: string | null | undefined): string | undefined {
  if (typeof branch !== "string") return undefined;
  const trimmed = branch.trim();
  return trimmed || undefined;
}

/** A short, readable commit sha derived from a full or abbreviated HEAD. */
export function shortShaLabel(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().replace(/[^0-9a-fA-F]/gu, "");
  return hex ? hex.slice(0, 7) : undefined;
}

/** The facts the branch projection reads; all of them are already available locally. */
export interface BranchFacts {
  /** The change branch an active ticket already carries, when one is known. */
  changeBranch?: string | null;
  /** Pi's workspace branch, or `"detached"` for a detached HEAD. */
  workspaceBranch?: string | null;
  /** A commit sha read once from the workspace, used only while detached. */
  shortSha?: string | null;
}

/**
 * Project the one branch the rail shows, in documented precedence: the active
 * ticket's change branch, then the workspace branch, then `detached @ <sha>`,
 * then nothing (the caller renders an em dash). It reads only facts already in
 * hand and never queries git on a cadence.
 */
export function projectBranch(facts: BranchFacts): string | undefined {
  const change = branchLabel(facts.changeBranch);
  if (change) return change;
  const workspace = branchLabel(facts.workspaceBranch);
  if (workspace && workspace !== "detached") return workspace;
  const sha = shortShaLabel(facts.shortSha);
  if (sha) return `detached @ ${sha}`;
  return undefined;
}

export interface RightRailOptions {
  width?: number;
  /**
   * The rows the host can actually show. It is a layout input only: Status is
   * never dropped, active agents are never hidden for Todos, and Todos collapse
   * to `Todos · n/m` before an agent row is lost.
   */
  height?: number;
  paint?: Paint;
  /** The working directory the project name is derived from. */
  project?: string;
  /** The host's workspace git branch, when the host reported one. */
  branch?: string | null;
  /** The active ticket's change branch, when the workflow already knows one. */
  changeBranch?: string | null;
  /** A short commit sha for the detached case, read once and cached. */
  shortSha?: string | null;
  /** When the run reached DONE, so its displayed time stays final. */
  runEndedAt?: number;
}

/** Rows the rail's Agents section shows before collapsing the rest. */
export const MAX_RAIL_AGENTS = 3;

/**
 * The longest Status label (`Tiempo total`) fixes the value column: every label is
 * padded to it plus one space, so all values start at the same column and the
 * token/cost buckets below align with them.
 */
const LABEL_COLUMN = "Tiempo total".length + 1;

/**
 * The one glyph per workflow stage. It reuses the shared glyph vocabulary rather
 * than inventing a symbol: `STAGE_TONE` carries the mood, the glyph its lifecycle
 * family, and the label the exact step.
 */
const STAGE_GLYPH: Record<Stage, string> = {
  IDLE: GLYPH.idle,
  EXPLORE: GLYPH.running,
  WORK: GLYPH.running,
  VERIFY: GLYPH.running,
  REPAIR: GLYPH.running,
  WAIT: GLYPH.warning,
  BLOCKED: GLYPH.blocked,
  FINALIZING: GLYPH.running,
  DONE: GLYPH.done,
};

/** Elapsed time of a child, omitted for a running child with nothing to show yet. */
function railElapsed(record: AgentRecord, now: number): string | undefined {
  if (typeof record.startedAt !== "number") return undefined;
  const hasDetail = Boolean(record.currentActivity) || (Array.isArray(record.changedPaths) && record.changedPaths.length > 0);
  if (record.status === "running" && !hasDetail) return undefined;
  return agentElapsed(record, now);
}

/** Active children first, then the newest. */
function orderedAgents(snapshot: AgentsSnapshot): AgentRecord[] {
  const records = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  return [...records].sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (right.status === "running" && left.status !== "running") return 1;
    return right.startedAt - left.startedAt;
  });
}

/** Clip a plain cell to `width` terminal cells (CJK and emoji count two) without collapsing spacing. */
function fit(text: string, width: number): string {
  return clipToWidth(text, width);
}

function plainRow(text: string, paint: Paint, tone: SemanticColor, inner: number): StatusRow {
  const fitted = fit(text, inner);
  return { text: fitted, painted: paint.fg(tone, fitted) };
}

/** The one-line form of an agent: state, name, time, and the reason when it failed or is blocked. */
function railAgentLine(
  record: AgentRecord,
  index: number,
  view: AgentStateView,
  now: number,
  paint: Paint,
  inner: number,
): StatusRow {
  const elapsed = railElapsed(record, now);
  const cost = agentCostText(record) === COST_UNAVAILABLE ? "" : ` · ${agentCostText(record)}`;
  const head = `${view.glyph} ${agentName(record, index)} ${view.label}${elapsed ? ` ${elapsed}` : ""}${cost}`;
  const reason = view.state === "error" || view.state === "blocked" ? ` · ${agentReason(record)}` : "";
  return plainRow(`${head}${reason}`, paint, view.tone, inner);
}

/**
 * The full card of an agent: header, model/cost/tokens, the context bar, and one
 * line for the current tool or, on error/blocked, the redacted reason.
 */
function railAgentCard(
  record: AgentRecord,
  index: number,
  view: AgentStateView,
  now: number,
  paint: Paint,
  inner: number,
): StatusRow[] {
  const elapsed = railElapsed(record, now);
  const rows: StatusRow[] = [
    plainRow(`${view.glyph} ${agentName(record, index)}  ${view.label}${elapsed ? `  ${elapsed}` : ""}`, paint, view.tone, inner),
  ];

  const suffix = ` · ${agentCostText(record)} · ${agentTokensText(record)}`;
  const model = singleLine(record.modelLabel ?? record.modelId ?? "");
  const modelRoom = inner - 2 - displayWidth(suffix);
  const metrics = modelRoom >= 4 && model ? `${fit(model, modelRoom)}${suffix}` : suffix.slice(3);
  rows.push(plainRow(`  ${metrics}`, paint, "muted", inner));

  const context = agentContextText(record);
  rows.push(plainRow(`  ${context}`, paint, context === CONTEXT_UNKNOWN ? "dim" : "muted", inner));

  if (view.state === "error" || view.state === "blocked") {
    rows.push(plainRow(`  ↳ ${agentReason(record)}`, paint, view.tone, inner));
  } else if (view.state === "working") {
    const tool = agentToolText(record);
    if (tool) rows.push(plainRow(`  ▸ ${tool}`, paint, "text", inner));
  }
  return rows;
}

/** Rows a card takes for this record (header, metrics, context, optional detail line). */
function railCardHeight(record: AgentRecord, view: AgentStateView): number {
  if (view.state === "error" || view.state === "blocked") return 4;
  return view.state === "working" && agentToolText(record) ? 4 : 3;
}

/**
 * A `label  value` row: the label is muted, the value keeps its own tone, and
 * the label column is padded to the longest label so every value starts at the
 * same column. A row whose value is empty is omitted, never invented.
 */
function railFact(
  paint: Paint,
  label: string,
  value: string | undefined,
  tone: SemanticColor = "text",
): StatusRow | undefined {
  const text = singleLine(value ?? "");
  if (!text) return undefined;
  const labelCell = label.padEnd(LABEL_COLUMN);
  return { text: `${labelCell}${text}`, painted: `${paint.fg("muted", labelCell)}${paint.fg(tone, text)}` };
}

/**
 * Tokens and cost as vertical Main/Agents/Total groups. A rail is too narrow for
 * the dock's single line, so the three buckets never truncate into one another.
 * An unobserved bucket renders an em dash, never a fabricated zero, and the
 * sections stay hidden until a run is in flight or real data arrived.
 */
function railUsageRows(snapshot: AgentsSnapshot, paint: Paint): StatusRow[] {
  const usage = snapshot.runUsage;
  if (!usage) return [];

  const hasObservedTokens = usage.total.totalTokens > 0;
  const hasObservedCost = usage.main.cost !== null || usage.agents.cost !== null;
  const runInFlight = usage.active === true || usage.startedAt !== undefined;
  if (!runInFlight && !hasObservedTokens && !hasObservedCost) return [];

  const rows: StatusRow[] = [];
  const heading = (name: string): StatusRow => ({ text: name, painted: paint.fg("accent", name) });
  const bucket = (name: string, value: string): StatusRow => {
    const labelCell = `  ${name.padEnd(LABEL_COLUMN - 2)}`;
    return { text: `${labelCell}${value}`, painted: `${paint.fg("muted", labelCell)}${paint.fg("text", value)}` };
  };
  const tokenCell = (tokens: number) => (tokens > 0 ? formatTokens(tokens) : "—");

  rows.push(heading("Tokens"));
  rows.push(bucket("Main", tokenCell(usage.main.totalTokens)));
  rows.push(bucket("Agents", tokenCell(usage.agents.totalTokens)));
  rows.push(bucket("Total", tokenCell(usage.total.totalTokens)));

  rows.push(heading("Coste"));
  rows.push(bucket("Main", formatCost(usage.main.cost)));
  rows.push(bucket("Agents", formatCost(usage.agents.cost)));
  rows.push(bucket("Total", formatCost(usage.total.cost)));
  return rows;
}

/** The vertical, non-empty Status facts the rail shows above Agents and Todos. */
function railStatusRows(
  snapshot: AgentsSnapshot,
  now: number,
  paint: Paint,
  project: string | undefined,
  branch: string | undefined,
  runEndedAt: number | undefined,
): StatusRow[] {
  const ticket = snapshot.ticket?.active && snapshot.ticket.identifier ? singleLine(snapshot.ticket.identifier) : undefined;
  // EZE-487: while a delegation is active, the child runs a model that may differ
  // from the parent's session model, so the Modelo/Proveedor rows report the
  // running child's real metadata from the observatory record. With no active
  // delegation the rail keeps reading the parent's snapshot model.
  const activeRole = snapshot.delegations?.activeRole;
  const runningChild = activeRole
    ? Array.isArray(snapshot.agents)
      ? snapshot.agents.find((agent) => agent.role === activeRole && agent.status === "running")
      : undefined
    : undefined;
  const model =
    singleLine(
      (
        runningChild
          ? runningChild.modelLabel ?? runningChild.modelId
          : snapshot.model?.label ?? snapshot.model?.id
      ) ?? "",
    ) || undefined;
  const provider =
    singleLine(
      (runningChild ? runningChild.providerLabel ?? runningChild.providerId : snapshot.model?.provider) ?? "",
    ) || undefined;
  const pressure = isContextPressure(snapshot) ? " !" : "";
  const compacting = isCompacting(snapshot) ? " · compactando…" : "";
  // The total belongs to the run, never to the active delegation or child.
  const startedAt = runStartedAt(snapshot);
  const endAt = typeof runEndedAt === "number" && Number.isFinite(runEndedAt)
    ? Math.min(runEndedAt, now)
    : now;
  const elapsed = startedAt === undefined ? undefined : formatDuration(Math.max(0, endAt - startedAt));
  const stage = deriveStage(snapshot);

  const rows = [
    railFact(paint, "Proyecto", project),
    // The branch row always exists: with no source it reads as a dash, never
    // vanishing and leaving the reader to wonder whether it was measured.
    railFact(paint, "Rama", branch ?? "—"),
    railFact(paint, "Ticket", ticket, "accent"),
    // The stage is the one highlighted value: its tone and glyph make IDLE,
    // EXPLORE, WORK, VERIFY and DONE read apart at a glance.
    railFact(paint, "Etapa", `${STAGE_GLYPH[stage]} ${stage}`, STAGE_TONE[stage]),
    railFact(paint, "Modelo", model),
    railFact(paint, "Proveedor", provider),
    railFact(paint, "Contexto", `${formatTokens(snapshot.contextTokens)}${pressure}${compacting}`),
    // No run, no clock: IDLE stays a dash instead of a session timer.
    railFact(paint, "Tiempo total", elapsed ?? "—"),
  ].filter((row): row is StatusRow => Boolean(row));

  return [...rows, ...railUsageRows(snapshot, paint)];
}

function usableHeight(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

/**
 * The pure rail projection: one card with three coherent sections — `Status`
 * (project, branch, ticket, stage, model, provider, context, run time and split
 * tokens/cost), `Agents` (bounded active/recent children) and `Todos` (the
 * derived run checklist). `[]` when the width cannot carry the card.
 */
export function renderRightRail(
  snapshot: AgentsSnapshot,
  now: number,
  options: RightRailOptions = {},
): string[] {
  const columns = typeof options.width === "number" && Number.isFinite(options.width)
    ? Math.floor(options.width)
    : undefined;
  if (columns === undefined || columns < MIN_CONTENT_WIDTH) return [];

  const paint = options.paint ?? PLAIN_PAINT;
  const width = Math.min(columns, railContentWidth(columns));
  const project = projectLabel(options.project);
  const branch = projectBranch({
    changeBranch: options.changeBranch,
    workspaceBranch: options.branch,
    shortSha: options.shortSha,
  });

  const lines: Array<string | StatusRow> = [
    { text: "Status", painted: sectionHeading("Status", paint, "accent") },
    ...railStatusRows(snapshot, now, paint, project, branch, options.runEndedAt),
  ];
  lines.push({ text: "Agents", painted: sectionHeading("Agents", paint, "accent") });

  // Agent budget: at most `MAX_RAIL_AGENTS` agents, active children first. Each is
  // a card when the width and the height budget allow it, otherwise one line.
  const ordered = orderedAgents(snapshot);
  const inner = width - 4;
  const cardsFit = width >= RAIL_CARD_MIN_WIDTH;
  const height = usableHeight(options.height);
  let remaining = height === undefined ? Number.POSITIVE_INFINITY : height - lines.length;

  if (ordered.length === 0) {
    lines.push({ text: "en espera", painted: paint.fg("dim", "en espera") });
    remaining -= 1;
  }

  let shown = 0;
  for (const [position, record] of ordered.slice(0, MAX_RAIL_AGENTS).entries()) {
    const active = record.status === "running";
    // A finished child is dropped under height pressure; an active one never is.
    if (!active && remaining - SPACING.gap <= 0) break;
    const view = agentStateView(record);
    const index = ordered.length - 1 - position;
    const cardRows = railCardHeight(record, view);
    if (cardsFit && remaining - cardRows >= RAIL_AFTER_AGENTS_RESERVE + RAIL_FRAME_ROWS) {
      lines.push(...railAgentCard(record, index, view, now, paint, inner));
      remaining -= cardRows;
    } else {
      lines.push(railAgentLine(record, index, view, now, paint, inner));
      remaining -= 1;
    }
    shown += 1;
  }

  const hidden = ordered.length - shown;
  if (hidden > 0) {
    lines.push(plainRow(`+${hidden} más · ver /agents`, paint, "dim", inner));
    remaining -= 1;
  }

  // Totals over every agent, never only the visible ones.
  if (ordered.length > 0 && remaining >= RAIL_AFTER_AGENTS_RESERVE) {
    lines.push(plainRow(totalsLine(ordered, now, inner), paint, "muted", inner));
    remaining -= 1;
  }

  // Todos last: with room the full checklist, otherwise the `Todos · n/m` line.
  lines.push("");
  const todoBudget = height === undefined ? undefined : Math.max(0, remaining - 1);
  const todos = deriveTodos(snapshot);
  const paintedTodos = renderTodos(todos, { paint, maxRows: todoBudget });
  // The same pure section rendered plain lets the frame measure each column while
  // the painted rows keep their color, so a themed Todos block stays aligned.
  const plainTodos = renderTodos(todos, { paint: PLAIN_PAINT, maxRows: todoBudget });
  lines.push(...paintedTodos.map((painted, index) => ({ text: plainTodos[index] ?? painted, painted })));

  return statusBox(statusTitle(snapshot), lines, width, paint);
}

/** The narrow slice of Pi's TUI the install reads; every field is optional. */
interface RailHost {
  mode?: string;
  terminal?: { columns?: number };
  layoutRoot?: Record<symbol, unknown> | undefined;
  requestRender?(): void;
}

interface RailComponent {
  render(width?: number): string[];
  invalidate(): void;
}

interface RailLayoutNode {
  type: string;
  gap?: number;
  align?: string;
  entries?: Array<Record<string, unknown>>;
}

export interface RightRailInstallOptions {
  /** The running Pi version. The caller supplies it; this module never imports Pi. */
  version?: string;
  /** The live rail renderer, called with the terminal width on every frame. */
  render(width: number): string[];
  /** The column breakpoint below which the host layout is used unchanged. */
  breakpoint?: number;
}

export interface RightRailHandle {
  /** True only when the private hook is installed and the host shape was accepted. */
  active: boolean;
  /**
   * True only when the rail actually produced lines on the last layout pass. A
   * failed or empty render leaves this false so the below-editor dock can take
   * over instead of leaving the human with no status surface.
   */
  showing(): boolean;
  dispose(): void;
}

function noopHandle(): RightRailHandle {
  return { active: false, showing: () => false, dispose() {} };
}

/**
 * Install the rail by wrapping the host's private fullscreen layout node, or
 * no-op. The returned handle is always safe to call: `active` tells the caller
 * whether the below-editor dock should yield, and `dispose` restores the exact
 * descriptor the host had.
 */
export function installRightRail(tui: unknown, options: RightRailInstallOptions): RightRailHandle {
  try {
    if (!options || typeof options.render !== "function") return noopHandle();
    if (!piVersionMayAttemptRail(options.version)) return noopHandle();

    const host = tui as RailHost | undefined;
    if (!host || host.mode !== "fullscreen") return noopHandle();
    const root = host.layoutRoot;
    if (!root || typeof root[LAYOUT_NODE] !== "function") return noopHandle();

    const original = root[LAYOUT_NODE] as () => unknown;
    const descriptor = Object.getOwnPropertyDescriptor(root, LAYOUT_NODE);
    const breakpoint = typeof options.breakpoint === "number" ? options.breakpoint : RIGHT_RAIL_MIN_WIDTH;

    let railLines: string[] = [];
    let showing = false;
    let disposed = false;
    // The structural probe runs once, lazily, on the first layout pass. Until then
    // the hook is installed and the version gates have passed, so `active` is true.
    let probe: "untested" | "recognized" | "incompatible" = "untested";
    const rail: RailComponent = {
      render: () => railLines,
      invalidate() {
        host.requestRender?.();
      },
    };
    // The transcript side is a stable wrapper: the host layout node is delegated
    // to lazily, exactly where Pi would have called it.
    const transcript: RailComponent & Record<symbol, unknown> = {
      render: () => [],
      invalidate() {},
      [LAYOUT_NODE]: () => original.call(root),
    };
    const railEntry: Record<string, unknown> = {
      component: rail,
      basis: RIGHT_RAIL_CONTENT_WIDTH,
      grow: 0,
      shrink: 0,
      minSize: RIGHT_RAIL_CONTENT_WIDTH,
    };
    const stack: RailLayoutNode = {
      type: "hstack",
      gap: 2,
      align: "stretch",
      entries: [{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 }, railEntry],
    };

    const replacement = (): unknown => {
      // A latched incompatibility delegates permanently: the host's own node and
      // its own throws are passed straight through, so the dock takes over.
      if (probe === "incompatible") return original.call(root);

      // The probe reads the host's own layout node once, during a layout pass and
      // never at install time, then requires the audited stack vocabulary. A
      // rejection — wrong shape or a throw — latches the shim off for good.
      if (probe === "untested") {
        let hostNode: unknown;
        try {
          hostNode = original.call(root);
        } catch (error) {
          probe = "incompatible";
          showing = false;
          throw error;
        }
        if (!isRecognizedStackLayoutNode(hostNode)) {
          probe = "incompatible";
          showing = false;
          return hostNode;
        }
        probe = "recognized";
      }

      const columns = host.terminal?.columns;
      if (typeof columns !== "number" || columns < breakpoint) {
        showing = false;
        return original.call(root);
      }
      let lines: string[] = [];
      try {
        const rendered = options.render(columns);
        lines = Array.isArray(rendered) ? rendered : [];
      } catch {
        lines = [];
      }
      if (lines.length === 0) {
        showing = false;
        return original.call(root);
      }
      railLines = lines;
      showing = true;
      // The rail column follows the terminal: 46 columns, 58 from 160 columns.
      const contentWidth = railContentWidth(columns);
      railEntry.basis = contentWidth;
      railEntry.minSize = contentWidth;
      return stack;
    };

    root[LAYOUT_NODE] = replacement;
    host.requestRender?.();

    return {
      // `active` reflects reality: installed until the probe latches off or dispose runs.
      get active() {
        return !disposed && probe !== "incompatible";
      },
      showing: () => showing && !disposed && probe !== "incompatible",
      dispose() {
        if (disposed) return;
        disposed = true;
        showing = false;
        try {
          if (root[LAYOUT_NODE] !== replacement) return;
          if (descriptor) Object.defineProperty(root, LAYOUT_NODE, descriptor);
          else Reflect.deleteProperty(root, LAYOUT_NODE);
        } catch {
          // Restoring the private hook is best effort and never fatal.
        }
      },
    };
  } catch {
    return noopHandle();
  }
}
