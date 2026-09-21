/**
 * The single, version-guarded private compatibility module for the optional
 * physical right rail (AIES-010D / T7).
 *
 * Pi exposes no public passive side-rail primitive; the host keeps its fullscreen
 * layout tree behind `Symbol.for("@earendil-works/pi-tui/layout-node")`. Gentle
 * patches that tree, and the user authorized exactly one isolated copy of the same
 * mechanism for AIES. The rules that keep it safe:
 *
 * - It never patches Pi, Gentle or `node_modules`; it only wraps the layout node
 *   the host already exposes on its own TUI instance and restores it on dispose.
 * - It is guarded to the Pi minor families actually audited (`0.85`, `0.86`).
 * - Every failure, an unsupported version, a missing private hook, a non-fullscreen
 *   host or a throwing render is non-fatal: the module no-ops or delegates to the
 *   host, so the existing below-editor dock and narrow footer stay the fallback.
 *
 * The projection itself is pure: `renderRightRail` reuses the dock's labelled
 * facts and adds the project and git branch the rail is there to show.
 */

import type { AgentRecord } from "../aies-agents/observatory.ts";
import type { AgentsSnapshot } from "./agents.ts";
import { formatDuration } from "./format.ts";
import { agentFact, compactStatusRows, sectionHeading, statusBox, statusTitle } from "./panel.ts";
import { PLAIN_PAINT, type Paint } from "./paint.ts";

/** The fullscreen width at which the physical rail is worth its columns. */
export const RIGHT_RAIL_MIN_WIDTH = 120;

/** The rail's own column budget. */
export const RIGHT_RAIL_CONTENT_WIDTH = 46;

/** Below this the rail content is not worth drawing at all. */
const MIN_CONTENT_WIDTH = 30;

/** The host's private fullscreen layout symbol, read by name, never patched. */
export const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");

/** The Pi minor families whose private layout shape was audited for AIES. */
const SUPPORTED_PI_MINORS: ReadonlySet<string> = new Set(["0.85", "0.86"]);

/** True only for a version whose private layout shape AIES actually audited. */
export function isSupportedPiVersion(version: string | undefined): boolean {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)(?:\.|$)/u.exec(version.trim());
  if (!match) return false;
  return SUPPORTED_PI_MINORS.has(`${match[1]}.${match[2]}`);
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

export interface RightRailOptions {
  width?: number;
  paint?: Paint;
  /** The working directory the project name is derived from. */
  project?: string;
  /** The host's git branch, when the host reported one. */
  branch?: string | null;
}

/** Rows the rail's Agents section shows before collapsing the rest. */
const MAX_RAIL_AGENTS = 3;

/** Elapsed time of a child, omitted for a running child with nothing to show yet. */
function railElapsed(record: AgentRecord, now: number): string | undefined {
  if (typeof record.startedAt !== "number") return undefined;
  const hasDetail = Boolean(record.currentActivity) || (Array.isArray(record.changedPaths) && record.changedPaths.length > 0);
  if (record.status === "running" && !hasDetail) return undefined;
  const end = typeof record.finishedAt === "number" ? record.finishedAt : now;
  return formatDuration(Math.max(0, end - record.startedAt));
}

/**
 * The bounded Agents section: active children first, then the newest finished
 * ones, never more than `MAX_RAIL_AGENTS` rows. An idle run keeps the section
 * explicit and quiet instead of leaving an unexplained hole under the heading.
 */
function railAgentRows(snapshot: AgentsSnapshot, now: number, paint: Paint): string[] {
  const records = Array.isArray(snapshot.agents) ? snapshot.agents : [];
  if (records.length === 0) return [paint.fg("dim", "en espera")];

  const ordered = [...records].sort((left, right) => {
    if (left.status === "running" && right.status !== "running") return -1;
    if (right.status === "running" && left.status !== "running") return 1;
    return right.startedAt - left.startedAt;
  });

  const rows = ordered.slice(0, MAX_RAIL_AGENTS).map((record) => {
    const elapsed = railElapsed(record, now);
    return elapsed ? `${agentFact(record)} · ${elapsed}` : agentFact(record);
  });
  if (ordered.length > MAX_RAIL_AGENTS) rows.push(`… ${ordered.length - MAX_RAIL_AGENTS} más`);
  return rows;
}

/**
 * The pure rail projection: a `Status` section (project, branch and the dock's
 * labelled facts) over an `Agents` section (bounded active/recent children).
 * `[]` when the width cannot carry the card.
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
  const width = Math.min(columns, RIGHT_RAIL_CONTENT_WIDTH);
  const project = projectLabel(options.project);
  const branch = branchLabel(options.branch);

  const rows: string[] = [sectionHeading("Status", paint, "accent")];
  if (project) rows.push(`Proyecto  ${project}`);
  if (branch) rows.push(`Rama      ${branch}`);
  rows.push(...compactStatusRows(snapshot, now));
  rows.push(sectionHeading("Agents", paint, "accent"));
  rows.push(...railAgentRows(snapshot, now, paint));
  return statusBox(statusTitle(snapshot), rows, width, paint);
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
    if (!isSupportedPiVersion(options.version)) return noopHandle();

    const host = tui as RailHost | undefined;
    if (!host || host.mode !== "fullscreen") return noopHandle();
    const root = host.layoutRoot;
    if (!root || typeof root[LAYOUT_NODE] !== "function") return noopHandle();

    const original = root[LAYOUT_NODE] as () => unknown;
    const descriptor = Object.getOwnPropertyDescriptor(root, LAYOUT_NODE);
    const breakpoint = typeof options.breakpoint === "number" ? options.breakpoint : RIGHT_RAIL_MIN_WIDTH;

    let railLines: string[] = [];
    let showing = false;
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
    const stack: RailLayoutNode = {
      type: "hstack",
      gap: 2,
      align: "stretch",
      entries: [
        { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
        {
          component: rail,
          basis: RIGHT_RAIL_CONTENT_WIDTH,
          grow: 0,
          shrink: 0,
          minSize: RIGHT_RAIL_CONTENT_WIDTH,
        },
      ],
    };

    const replacement = (): unknown => {
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
      return stack;
    };

    root[LAYOUT_NODE] = replacement;
    host.requestRender?.();

    let disposed = false;
    return {
      active: true,
      showing: () => showing && !disposed,
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
