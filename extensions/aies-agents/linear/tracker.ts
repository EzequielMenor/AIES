/**
 * D33 phase 2: which ticket tracker this profile uses.
 *
 * The tracker is an explicit `tracker` key in `$PI_CODING_AGENT_DIR/aies.json`.
 * An absent key, or `linear`, selects Linear exactly as before. `plane` selects the
 * Plane transport (D33 phase 3). Any other value fails closed before a transport is
 * chosen: no MCP call and no state change. The tracker is never inferred from an
 * identifier (D33 item 3).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { trackerLabel } from "./labels.ts";
import { PLANE_MCP_SERVER } from "./plane-transport.ts";
import { LINEAR_MCP_SERVER } from "./transport.ts";
import type { TrackerId } from "./types.ts";

/** Tracker of every profile that does not declare one, and of every legacy snapshot. */
export const DEFAULT_TRACKER_ID: TrackerId = "linear";

/** What the generic ticket code needs to reach a tracker's transport today. */
export interface TrackerDescriptor {
  readonly id: TrackerId;
  /** MCP server the tracker is reached through, as declared in the profile. */
  readonly mcpServer: string;
}

export const LINEAR_TRACKER: TrackerDescriptor = { id: "linear", mcpServer: LINEAR_MCP_SERVER };

/** D33 phase 3: the Plane descriptor, selected by `tracker: "plane"` in `aies.json`. */
export const PLANE_TRACKER: TrackerDescriptor = { id: "plane", mcpServer: PLANE_MCP_SERVER };

export type TrackerRefusalCode = "tracker_unknown";

export type TrackerSelection =
  | { ok: true; tracker: TrackerDescriptor }
  | { ok: false; error: TrackerRefusalCode; message: string };

/** Decide the tracker from the raw `tracker` value. Absent (`undefined` or `null`) is Linear. */
export function resolveTrackerSetting(value: unknown): TrackerSelection {
  if (value === undefined || value === null || value === "linear") {
    return { ok: true, tracker: LINEAR_TRACKER };
  }
  if (value === "plane") {
    return { ok: true, tracker: PLANE_TRACKER };
  }
  const shown = typeof value === "string" ? JSON.stringify(value) : `a ${Array.isArray(value) ? "array" : typeof value} value`;
  return {
    ok: false,
    error: "tracker_unknown",
    message: `Unknown tracker ${shown} in aies.json: expected "linear" or "plane". No ticket operation was performed.`,
  };
}

/**
 * The label of the tracker this profile operates, for the texts a command or a tool shows
 * (D33 phase 4). Linear when the profile names no tracker or names one that cannot be used.
 */
export function configuredTrackerLabel(env: NodeJS.ProcessEnv = process.env): string {
  const selection = selectTracker(env);
  return trackerLabel(selection.ok ? selection.tracker.id : undefined);
}

/**
 * Read the `tracker` key from `$PI_CODING_AGENT_DIR/aies.json`, with the same
 * tolerance as `readRepoGuardConfig`: no profile, no file, or an unreadable file
 * yields no setting, which is the Linear default.
 */
export function readTrackerSetting(env: NodeJS.ProcessEnv = process.env): unknown {
  const agentDir = env.PI_CODING_AGENT_DIR;
  if (!agentDir) return undefined;

  const configPath = join(agentDir, "aies.json");
  try {
    if (!existsSync(configPath)) return undefined;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return (parsed as { tracker?: unknown }).tracker;
  } catch {
    return undefined;
  }
}

/** The tracker this profile selects, or the reason it cannot be used. */
export function selectTracker(env: NodeJS.ProcessEnv = process.env): TrackerSelection {
  return resolveTrackerSetting(readTrackerSetting(env));
}
