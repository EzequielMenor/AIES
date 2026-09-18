/**
 * AIES-008: Linear Transport Layer.
 *
 * Separates transport mechanics from workflow policy.
 * Provides:
 * - LinearTransport interface
 * - LinearTransportError classification
 * - FakeLinearTransport (in-memory deterministic fake for test suite)
 * - McpLinearTransport (MCP proxy/tool integration for runtime)
 */

import type { LinearIssueRaw, LinearIssueUpdate, LinearStatus } from "./types.ts";

export type LinearErrorCode =
  | "not_found"
  | "auth_unavailable"
  | "mcp_unavailable"
  | "permission_denied"
  | "network_failure"
  | "invalid_transition"
  | "remote_conflict";

export class LinearTransportError extends Error {
  readonly code: LinearErrorCode;

  constructor(code: LinearErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LinearTransportError";
    this.code = code;
  }
}

export interface LinearTransport {
  getIssue(id: string): Promise<LinearIssueRaw | null>;
  updateIssue(id: string, update: LinearIssueUpdate): Promise<LinearIssueRaw>;
  getStatuses(teamIdOrProjectId?: string): Promise<LinearStatus[]>;
  addComment(id: string, body: string): Promise<void>;
}

/**
 * Deterministic in-memory fake transport for tests and offline verification.
 */
export class FakeLinearTransport implements LinearTransport {
  private issues = new Map<string, LinearIssueRaw>();
  private statuses: LinearStatus[] = [
    { id: "status-backlog", name: "Backlog", type: "backlog" },
    { id: "status-todo", name: "Todo", type: "unstarted" },
    { id: "status-in-progress", name: "In Progress", type: "started" },
    { id: "status-in-review", name: "In Review", type: "started" },
    { id: "status-done", name: "Done", type: "completed" },
    { id: "status-canceled", name: "Canceled", type: "canceled" },
  ];
  private comments: Array<{ issueId: string; body: string; createdAt: string }> = [];

  public queriedIssueIds: string[] = [];
  public updatedIssues: Array<{ id: string; update: LinearIssueUpdate }> = [];
  public addedComments: Array<{ id: string; body: string }> = [];

  public simulatedError: LinearErrorCode | null = null;
  public simulateConflictOnNextUpdate = false;

  constructor(initialIssues?: LinearIssueRaw[], initialStatuses?: LinearStatus[]) {
    if (initialIssues) {
      for (const issue of initialIssues) {
        this.seedIssue(issue);
      }
    }
    if (initialStatuses) {
      this.statuses = [...initialStatuses];
    }
  }

  seedIssue(issue: Partial<LinearIssueRaw> & { identifier: string; title: string }): LinearIssueRaw {
    const fullIssue: LinearIssueRaw = {
      id: issue.id ?? `id-${issue.identifier.toLowerCase()}`,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      state: issue.state ?? { id: "status-todo", name: "Todo", type: "unstarted" },
      status: issue.status,
      project: issue.project,
      labels: issue.labels,
      url: issue.url ?? `https://linear.app/issue/${issue.identifier}`,
      updatedAt: issue.updatedAt ?? new Date().toISOString(),
      ...issue,
    };
    this.issues.set(fullIssue.identifier, fullIssue);
    this.issues.set(fullIssue.id, fullIssue);
    return fullIssue;
  }

  seedStatus(status: LinearStatus): void {
    const idx = this.statuses.findIndex((s) => s.id === status.id || s.name === status.name);
    if (idx >= 0) {
      this.statuses[idx] = status;
    } else {
      this.statuses.push(status);
    }
  }

  setSimulatedError(code: LinearErrorCode | null): void {
    this.simulatedError = code;
  }

  private checkSimulatedError(): void {
    if (this.simulatedError) {
      const code = this.simulatedError;
      throw new LinearTransportError(code, `Simulated Linear error: ${code}`);
    }
  }

  async getIssue(id: string): Promise<LinearIssueRaw | null> {
    this.checkSimulatedError();
    this.queriedIssueIds.push(id);
    const issue = this.issues.get(id);
    if (!issue) return null;
    return JSON.parse(JSON.stringify(issue)) as LinearIssueRaw;
  }

  async updateIssue(id: string, update: LinearIssueUpdate): Promise<LinearIssueRaw> {
    this.checkSimulatedError();
    this.updatedIssues.push({ id, update });

    if (this.simulateConflictOnNextUpdate) {
      this.simulateConflictOnNextUpdate = false;
      throw new LinearTransportError("remote_conflict", `Conflict updating issue ${id}: remote state changed`);
    }

    const issue = this.issues.get(id);
    if (!issue) {
      throw new LinearTransportError("not_found", `Issue ${id} not found on remote`);
    }

    if (update.statusId || update.stateId) {
      const targetId = update.statusId || update.stateId;
      const status = this.statuses.find((s) => s.id === targetId || s.name.toLowerCase() === targetId?.toLowerCase());
      if (!status) {
        throw new LinearTransportError("invalid_transition", `Unknown status ${targetId}`);
      }
      issue.state = { id: status.id, name: status.name, type: status.type };
      if (issue.status) {
        issue.status = { id: status.id, name: status.name, type: status.type };
      }
    }

    if (update.title !== undefined) {
      issue.title = update.title;
    }
    if (update.description !== undefined) {
      issue.description = update.description;
    }

    issue.updatedAt = new Date().toISOString();
    return JSON.parse(JSON.stringify(issue)) as LinearIssueRaw;
  }

  async getStatuses(_teamIdOrProjectId?: string): Promise<LinearStatus[]> {
    this.checkSimulatedError();
    return [...this.statuses];
  }

  async addComment(id: string, body: string): Promise<void> {
    this.checkSimulatedError();
    this.addedComments.push({ id, body });
    this.comments.push({ issueId: id, body, createdAt: new Date().toISOString() });
  }

  getComments(issueId?: string): Array<{ issueId: string; body: string; createdAt: string }> {
    if (issueId) {
      return this.comments.filter((c) => c.issueId === issueId);
    }
    return [...this.comments];
  }
}

/**
 * MCP-backed transport reusing existing MCP infrastructure or proxy.
 */
export type McpToolCaller = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export class McpLinearTransport implements LinearTransport {
  private toolCaller?: McpToolCaller;

  constructor(toolCaller?: McpToolCaller) {
    this.toolCaller = toolCaller;
  }

  private async call(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.toolCaller) {
      // Check if API key or auth is available in environment
      if (!process.env.LINEAR_API_KEY) {
        throw new LinearTransportError(
          "auth_unavailable",
          "Linear authentication is not configured. Configure LINEAR_API_KEY or run /mcp-auth linear.",
        );
      }
      throw new LinearTransportError(
        "mcp_unavailable",
        "Linear MCP tool caller is not registered in this runtime context.",
      );
    }

    try {
      return await this.toolCaller("linear", toolName, args);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/not found|404/i.test(msg)) {
        throw new LinearTransportError("not_found", msg, { cause: err });
      }
      if (/unauthorized|forbidden|auth/i.test(msg)) {
        throw new LinearTransportError("auth_unavailable", msg, { cause: err });
      }
      if (/conflict|409/i.test(msg)) {
        throw new LinearTransportError("remote_conflict", msg, { cause: err });
      }
      if (/network|fetch|timeout|econnrefused/i.test(msg)) {
        throw new LinearTransportError("network_failure", msg, { cause: err });
      }
      throw new LinearTransportError("mcp_unavailable", msg, { cause: err });
    }
  }

  async getIssue(id: string): Promise<LinearIssueRaw | null> {
    try {
      const res = (await this.call("get_issue", { id })) as any;
      if (!res) return null;
      // Handle tool result formatting if wrapped in text content
      if (res && typeof res === "object") {
        if ("content" in res && Array.isArray(res.content) && res.content[0]?.text) {
          try {
            return JSON.parse(res.content[0].text) as LinearIssueRaw;
          } catch {
            // Text is not JSON
          }
        }
        return res as LinearIssueRaw;
      }
      return null;
    } catch (err) {
      if (err instanceof LinearTransportError && err.code === "not_found") {
        return null;
      }
      throw err;
    }
  }

  async updateIssue(id: string, update: LinearIssueUpdate): Promise<LinearIssueRaw> {
    const params: Record<string, unknown> = { id };
    if (update.statusId || update.stateId) {
      params.stateId = update.statusId || update.stateId;
    }
    if (update.title !== undefined) params.title = update.title;
    if (update.description !== undefined) params.description = update.description;

    const res = (await this.call("save_issue", params)) as any;
    if (res && typeof res === "object") {
      if ("content" in res && Array.isArray(res.content) && res.content[0]?.text) {
        try {
          return JSON.parse(res.content[0].text) as LinearIssueRaw;
        } catch {}
      }
      return res as LinearIssueRaw;
    }
    return { id, identifier: id, title: "" };
  }

  async getStatuses(teamIdOrProjectId?: string): Promise<LinearStatus[]> {
    const params: Record<string, unknown> = {};
    if (teamIdOrProjectId) {
      params.teamId = teamIdOrProjectId;
    }
    const res = (await this.call("list_issue_statuses", params)) as any;
    if (Array.isArray(res)) return res as LinearStatus[];
    if (res && typeof res === "object") {
      if ("statuses" in res && Array.isArray(res.statuses)) return res.statuses as LinearStatus[];
      if ("content" in res && Array.isArray(res.content) && res.content[0]?.text) {
        try {
          const parsed = JSON.parse(res.content[0].text);
          if (Array.isArray(parsed)) return parsed as LinearStatus[];
          if (parsed && typeof parsed === "object" && Array.isArray(parsed.statuses)) return parsed.statuses;
        } catch {}
      }
    }
    return [];
  }

  async addComment(id: string, body: string): Promise<void> {
    await this.call("save_comment", { issueId: id, body });
  }
}
