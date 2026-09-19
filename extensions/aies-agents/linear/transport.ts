/**
 * AIES-008: Linear Transport Layer.
 *
 * Separates transport mechanics from workflow policy. Provides:
 * - `LinearTransport`: the policy-facing seam, kept fakeable for tests.
 * - `LinearTransportError`: typed failure classification.
 * - `FakeLinearTransport`: deterministic in-memory transport for the test suite.
 * - `HostMediatedLinearTransport`: the runtime transport.
 *
 * AIES owns no MCP transport. Pi exposes no programmatic tool invocation to
 * extensions, so the only MCP client in an AIES session is the Parent agent,
 * through the `mcp` proxy tool registered by `pi-mcp-adapter`. The runtime
 * transport therefore never sends a request: it declares the exact MCP call it
 * needs and fails with `remote_required`, the Parent performs that call and hands
 * its result back, and the interrupted operation is replayed over the accumulated
 * answers until it completes. Replay is pure, because every remote value comes
 * from an answer the Parent already supplied.
 */

import type { LinearIssueRaw, LinearIssueUpdate, LinearRemoteDirective, LinearStatus } from "./types.ts";

export type LinearErrorCode =
  | "not_found"
  | "auth_unavailable"
  | "mcp_unavailable"
  | "remote_required"
  | "permission_denied"
  | "network_failure"
  | "invalid_transition"
  | "remote_conflict";

export class LinearTransportError extends Error {
  readonly code: LinearErrorCode;
  /** Present for `remote_required`: the exact call the Parent has to perform. */
  readonly directive?: LinearRemoteDirective;

  constructor(
    code: LinearErrorCode,
    message: string,
    options?: { cause?: unknown; directive?: LinearRemoteDirective },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LinearTransportError";
    this.code = code;
    this.directive = options?.directive;
  }
}

/** A missing remote value the Parent has to fetch through the MCP proxy tool. */
export function isLinearRemoteRequired(
  error: unknown,
): error is LinearTransportError & { directive: LinearRemoteDirective } {
  return error instanceof LinearTransportError && error.code === "remote_required" && error.directive !== undefined;
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

/** MCP server AIES declares for Linear in `profile/mcp.json`. */
export const LINEAR_MCP_SERVER = "linear";

/** Linear MCP tool names whose arguments were verified against the live server. */
const LINEAR_TOOLS = {
  getIssue: "get_issue",
  saveIssue: "save_issue",
  listIssueStatuses: "list_issue_statuses",
  saveComment: "save_comment",
} as const;

/** Stable identity of one MCP call: same server, same tool, same arguments. */
export function linearRemoteKey(server: string, tool: string, args: Record<string, unknown>): string {
  const rendered = Object.keys(args)
    .sort()
    .map((key) => `${key}=${JSON.stringify(args[key]) ?? "null"}`);
  return rendered.length > 0 ? `${server}:${tool}(${rendered.join(",")})` : `${server}:${tool}`;
}

function asTextParts(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const texts: string[] = [];
  for (const part of value) {
    if (!part || typeof part !== "object" || typeof (part as { text?: unknown }).text !== "string") return undefined;
    texts.push((part as { text: string }).text);
  }
  return texts.join("");
}

function parseJsonPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Reduce whatever the Parent hands back from the `mcp` proxy tool to the payload
 * the Linear tool actually returned: a JSON text part, a structured result, or the
 * value itself.
 */
export function unwrapMcpAnswer(value: unknown): unknown {
  if (typeof value === "string") return parseJsonPayload(value) ?? value;
  if (Array.isArray(value)) return parseJsonPayload(asTextParts(value) ?? "") ?? value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const text = asTextParts(record.content);
    if (text !== undefined) {
      const parsed = parseJsonPayload(text);
      return parsed !== undefined ? parsed : text;
    }
    if (record.structuredContent !== undefined) return record.structuredContent;
  }
  return value;
}

/**
 * Read a Parent-supplied answer. The key is optional: the answer may be the bare
 * value for the pending call, or `{ key, value }` to name the call explicitly.
 */
export function readRemoteAnswer(value: unknown): { key?: string; value: unknown } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as { key?: unknown; value?: unknown };
    if (typeof record.key === "string" && record.key.trim() && "value" in record) {
      return { key: record.key.trim(), value: record.value };
    }
  }
  return { value };
}

function normalizeStatuses(value: unknown): LinearStatus[] {
  if (Array.isArray(value)) return value as LinearStatus[];
  if (value && typeof value === "object") {
    const record = value as { statuses?: unknown; states?: unknown; nodes?: unknown };
    for (const candidate of [record.statuses, record.states, record.nodes]) {
      if (Array.isArray(candidate)) return candidate as LinearStatus[];
    }
  }
  return [];
}

/**
 * Runtime Linear transport.
 *
 * Every call is answered from work the Parent already completed, or fails with a
 * `remote_required` directive for the first call that is still missing. It never
 * opens a connection, never holds a credential and never reads the environment.
 */
export class HostMediatedLinearTransport implements LinearTransport {
  private readonly answers: Readonly<Record<string, unknown>>;
  private readonly server: string;

  constructor(answers: Readonly<Record<string, unknown>> = {}, server: string = LINEAR_MCP_SERVER) {
    this.answers = answers;
    this.server = server;
  }

  private answer<T>(tool: string, args: Record<string, unknown>, purpose: string): T {
    const key = linearRemoteKey(this.server, tool, args);
    if (Object.prototype.hasOwnProperty.call(this.answers, key)) {
      return this.answers[key] as T;
    }
    const directive: LinearRemoteDirective = { key, server: this.server, tool, args, purpose };
    throw new LinearTransportError("remote_required", `Linear remote call required: ${tool} (${purpose})`, {
      directive,
    });
  }

  async getIssue(id: string): Promise<LinearIssueRaw | null> {
    const value = this.answer<unknown>(LINEAR_TOOLS.getIssue, { id }, "read the ticket contract");
    if (!value || typeof value !== "object") return null;
    return value as LinearIssueRaw;
  }

  async updateIssue(id: string, update: LinearIssueUpdate): Promise<LinearIssueRaw> {
    const args: Record<string, unknown> = { id };
    const stateRef = update.statusId ?? update.stateId;
    if (stateRef) args.state = stateRef;
    if (update.title !== undefined) args.title = update.title;
    if (update.description !== undefined) args.description = update.description;

    const value = this.answer<unknown>(LINEAR_TOOLS.saveIssue, args, "update the ticket");
    if (value && typeof value === "object") return value as LinearIssueRaw;
    return { id, identifier: id, title: "" };
  }

  async getStatuses(teamIdOrProjectId?: string): Promise<LinearStatus[]> {
    const team = teamIdOrProjectId?.trim();
    if (!team) {
      throw new LinearTransportError(
        "mcp_unavailable",
        "Cannot resolve Linear workflow states: the active ticket does not expose its team.",
      );
    }
    const value = this.answer<unknown>(LINEAR_TOOLS.listIssueStatuses, { team }, "resolve the team workflow states");
    return normalizeStatuses(value);
  }

  async addComment(id: string, body: string): Promise<void> {
    this.answer<unknown>(LINEAR_TOOLS.saveComment, { issueId: id, body }, "record the ticket comment");
  }
}
