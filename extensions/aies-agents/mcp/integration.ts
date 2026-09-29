/**
 * AIES MCP integration sensor.
 *
 * AIES owns no MCP transport. `pi-mcp-adapter` is declared by the isolated AIES
 * profile and is the only MCP client in an AIES session: its `mcp` proxy tool is
 * the single way an AIES-side remote call can happen.
 *
 * This module is a pure sensor over the adapter's versioned status channel. It
 * exists so an unusable transport fails with a real, actionable instruction
 * instead of a fabricated one. It never connects a server, never authenticates,
 * never touches credentials and never exposes a secret.
 */

import { LINEAR_MCP_SERVER } from "../linear/transport.ts";

/** Versioned shared channel `pi-mcp-adapter` publishes read-only status on. */
export const MCP_STATUS_CHANNEL = "pi-mcp-adapter/status/v1";

/** The adapter's proxy tool: the only MCP tool an AIES session registers. */
export const MCP_PROXY_TOOL = "mcp";

const MCP_SERVER_STATES = ["connected", "cached", "failed", "needs-auth", "not-connected", "disabled"] as const;

export type McpServerState = (typeof MCP_SERVER_STATES)[number];

export interface McpServerSnapshot {
  name: string;
  status: McpServerState;
  toolCount: number;
  directToolCount: number;
  disabled: boolean;
}

export interface McpIntegrationState {
  /** True once the adapter published at least one status snapshot. */
  adapterObserved: boolean;
  servers: Map<string, McpServerSnapshot>;
  totalTools: number;
  connectedCount: number;
  observedAt: number;
}

export interface McpIntegrationSnapshot {
  adapterObserved: boolean;
  servers: McpServerSnapshot[];
  totalTools: number;
  totalDirectTools: number;
  connectedCount: number;
  observedAt: number;
}

export type McpDiagnosticCode =
  | "unknown"
  | "ready"
  | "adapter_missing"
  | "server_missing"
  | "needs_auth"
  | "disabled"
  | "server_failed";

export interface McpDiagnostic {
  code: McpDiagnosticCode;
  /** True when an MCP call may be attempted. */
  usable: boolean;
  server: string;
}

export function createMcpIntegrationState(now = Date.now()): McpIntegrationState {
  return { adapterObserved: false, servers: new Map(), totalTools: 0, connectedCount: 0, observedAt: now };
}

/** True when a session tool list proves the adapter is loaded. */
export function isMcpAdapterLoaded(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => name === MCP_PROXY_TOOL || name === "mcpScript" || name.startsWith("mcp__"));
}

/**
 * Fold one adapter status snapshot into the sensor state. The payload is treated
 * as untrusted: unknown fields, unknown server states and non-numeric counters are
 * ignored instead of trusted.
 */
export function applyMcpStatusEvent(
  state: McpIntegrationState,
  payload: unknown,
  now = Date.now(),
): McpIntegrationState {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return state;
  const record = payload as { servers?: unknown; totalTools?: unknown; connectedCount?: unknown };
  if (!Array.isArray(record.servers)) return state;

  const servers = new Map<string, McpServerSnapshot>();
  for (const entry of record.servers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.name !== "string" || !raw.name.trim()) continue;
    const status =
      typeof raw.status === "string" && (MCP_SERVER_STATES as readonly string[]).includes(raw.status)
        ? (raw.status as McpServerState)
        : "not-connected";
    servers.set(raw.name, {
      name: raw.name,
      status,
      toolCount: typeof raw.toolCount === "number" ? raw.toolCount : 0,
      directToolCount: typeof raw.directToolCount === "number" ? raw.directToolCount : 0,
      disabled: raw.disabled === true,
    });
  }

  return {
    adapterObserved: true,
    servers,
    totalTools: typeof record.totalTools === "number" ? record.totalTools : 0,
    connectedCount: typeof record.connectedCount === "number" ? record.connectedCount : 0,
    observedAt: now,
  };
}

export function toMcpIntegrationSnapshot(state: McpIntegrationState): McpIntegrationSnapshot {
  const servers = [...state.servers.values()];
  return {
    adapterObserved: state.adapterObserved,
    servers,
    totalTools: state.totalTools,
    totalDirectTools: servers.reduce((total, server) => total + server.directToolCount, 0),
    connectedCount: state.connectedCount,
    observedAt: state.observedAt,
  };
}

export interface McpDiagnosticOptions {
  server?: string;
  /** `pi.getAllTools()` names, used to tell "adapter absent" from "not reported yet". */
  adapterToolNames?: readonly string[];
}

/**
 * Decide whether the given MCP server can be used right now, and why not when it
 * cannot. A missing status snapshot is never reported as a failure while the
 * adapter is loaded: the adapter owns its own error reporting, and a race at
 * session start must not become a false diagnosis.
 */
export function diagnoseMcpServer(state: McpIntegrationState, options: McpDiagnosticOptions = {}): McpDiagnostic {
  const server = options.server ?? LINEAR_MCP_SERVER;
  if (options.adapterToolNames && !isMcpAdapterLoaded(options.adapterToolNames)) {
    return { code: "adapter_missing", usable: false, server };
  }
  // No snapshot yet, or a snapshot that names no server at all. The adapter
  // publishes an empty snapshot on shutdown and publishes one before it has
  // reconciled any server, so an empty list is not evidence that the configured
  // server is missing: only a snapshot that lists other servers and omits this one
  // is. Reporting a missing server here would block a call the adapter can still
  // serve and would ask the user to repair a correct profile.
  if (!state.adapterObserved || state.servers.size === 0) {
    return { code: "unknown", usable: true, server };
  }

  const entry = state.servers.get(server);
  if (!entry) return { code: "server_missing", usable: false, server };
  if (entry.disabled || entry.status === "disabled") return { code: "disabled", usable: false, server };
  if (entry.status === "needs-auth") return { code: "needs_auth", usable: false, server };
  if (entry.status === "failed") return { code: "server_failed", usable: false, server };
  return { code: "ready", usable: true, server };
}

/**
 * The instruction to follow for a diagnostic. Commands that only exist in an
 * interactive session are never recommended in a non-interactive one, and the
 * primary instruction for missing authentication is always OAuth.
 */
export function describeMcpDiagnostic(diagnostic: McpDiagnostic, options: { mode?: string } = {}): string {
  const mode = options.mode ?? "unknown";
  const interactive = mode === "tui";
  switch (diagnostic.code) {
    case "adapter_missing":
      return [
        "pi-mcp-adapter is not loaded in this AIES profile, so MCP servers such as Linear cannot be reached.",
        "The profile declares npm:pi-mcp-adapter. Run any aies command once with network access so Pi installs it, or run:",
        "  aies install npm:pi-mcp-adapter",
      ].join("\n");
    case "server_missing":
      return [
        `No "${diagnostic.server}" MCP server is configured in this AIES profile.`,
        'Expected in $AIES_HOME/agent/mcp-adapter.json, pointing at https://mcp.linear.app/mcp with auth "oauth".',
      ].join("\n");
    case "needs_auth":
      return interactive
        ? `Linear needs authentication.\n\nRun:\n  /mcp-auth ${diagnostic.server}`
        : [
            `Linear needs authentication, and this session is not interactive (mode: ${mode}).`,
            `Authenticate from an interactive AIES session with /mcp-auth ${diagnostic.server}, then retry.`,
          ].join("\n");
    case "disabled":
      return [
        `The "${diagnostic.server}" MCP server is disabled in this AIES profile.`,
        `Enable it with /mcp enable ${diagnostic.server} and reload, or remove the disabled flag from $AIES_HOME/agent/mcp-adapter.json.`,
      ].join("\n");
    case "server_failed":
      return [
        `The "${diagnostic.server}" MCP server failed to connect.`,
        `Reconnect with /mcp reconnect ${diagnostic.server}, then retry.`,
      ].join("\n");
    default:
      return "";
  }
}
