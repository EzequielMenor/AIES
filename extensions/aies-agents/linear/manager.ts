/**
 * AIES-008: Ticket Manager.
 *
 * Central coordinator for active Linear ticket state in the Parent session.
 * Connects transport, workflow policy, and verification state.
 *
 * Remote work is mediated. Every operation runs against
 * `HostMediatedLinearTransport`, which answers from the calls the Parent already
 * completed and fails with a `remote_required` directive for the next missing one.
 * The manager keeps the in-flight directive plus every answer collected for it, so
 * `submitRemote` resumes the interrupted operation instead of restarting it.
 */

import type { McpDiagnostic } from "../mcp/integration.ts";
import type { VerificationState } from "../verification.ts";
import {
  describeRemoteDirective,
  formatCompactContract,
  hasUsableIssueIdentity,
  normalizeTicketContract,
  readIssueIdentity,
  readIssueState,
} from "./contract.ts";
import {
  canSwitchTicket,
  checkDoneGate,
  detectRemoteConflict,
  resolveTargetStatus,
} from "./policy.ts";
import {
  HostMediatedLinearTransport,
  isLinearRemoteRequired,
  linearRemoteKey,
  LinearTransportError,
  normalizeStatuses,
  unwrapMcpAnswer,
  type LinearTransport,
} from "./transport.ts";
import type {
  ActiveTicket,
  LinearRemoteDirective,
  TicketOperationResult,
  TicketSnapshot,
  TicketWorkState,
} from "./types.ts";

/** Operations that need a Linear round trip and can be resumed afterwards. */
type MediatedAction = "load" | "start" | "complete" | "block" | "comment" | "refresh";

interface PendingRemote {
  action: MediatedAction;
  input: Record<string, unknown>;
  directive: LinearRemoteDirective;
}

export interface TicketManagerOptions {
  transport?: LinearTransport;
  getVerification: () => VerificationState;
  /**
   * MCP availability probe. Absent in tests. When it reports that the transport
   * cannot be used, the manager fails with that diagnosis instead of asking the
   * Parent for a call that cannot succeed.
   */
  getMcpDiagnostic?: () => McpDiagnostic;
}

/** Build a clear `invalid_remote_payload` refusal for a captured/handed answer. */
function invalidRemotePayload(
  directive: LinearRemoteDirective,
  reason: string,
): TicketOperationResult {
  return {
    ok: false,
    error: "invalid_remote_payload",
    message: `Linear ${directive.tool} returned an unusable answer: ${reason}. The operation was not completed and no partial ticket was activated.`,
  };
}

export class TicketManager {
  private activeTicket: ActiveTicket | null = null;
  private workState: TicketWorkState = "loaded";
  private changedPaths: Set<string> = new Set();
  private transportOverride?: LinearTransport;
  private getVerification: () => VerificationState;
  private mcpProbe?: () => McpDiagnostic;

  /** The call the Parent still owes, if any. */
  private pendingRemote: PendingRemote | null = null;
  /** Answers already collected for the in-flight operation, keyed by directive key. */
  private remoteAnswers: Record<string, unknown> = {};

  constructor(options: TicketManagerOptions) {
    this.transportOverride = options.transport;
    this.getVerification = options.getVerification;
    this.mcpProbe = options.getMcpDiagnostic;
  }

  setTransport(transport: LinearTransport): void {
    this.transportOverride = transport;
  }

  /** The transport in use: the injected one in tests, otherwise the mediated one. */
  getTransport(): LinearTransport {
    return this.transportOverride ?? this.createTransport();
  }

  getActiveTicket(): ActiveTicket | null {
    return this.activeTicket ? { ...this.activeTicket } : null;
  }

  getWorkState(): TicketWorkState {
    return this.workState;
  }

  getChangedPaths(): string[] {
    return Array.from(this.changedPaths);
  }

  recordChangedPaths(paths: string[]): void {
    for (const p of paths) {
      if (p && p.trim()) {
        this.changedPaths.add(p.trim());
      }
    }
  }

  /** The Linear call the Parent still has to perform, if any. */
  getPendingDirective(): LinearRemoteDirective | null {
    return this.pendingRemote ? { ...this.pendingRemote.directive } : null;
  }

  /** Stable key of the pending call, used to match a captured `mcp` result. */
  getPendingRemoteKey(): string | null {
    return this.pendingRemote ? this.pendingRemote.directive.key : null;
  }

  /** Current MCP diagnosis, or null when no probe is wired in. */
  getMcpDiagnostic(): McpDiagnostic | null {
    return this.mcpProbe ? this.mcpProbe() : null;
  }

  /**
   * Hand back the value the Parent obtained from the pending MCP call and resume
   * the interrupted operation. Replay is pure: every remote value comes from an
   * answer the Parent supplied, so re-running the operation cannot repeat a remote
   * write.
   *
   * When an explicit `key` is supplied it must name the pending call: an answer for
   * a different request is refused with `remote_mismatch` and the pending directive
   * is left intact, so a misrouted value never clobbers an operation in flight. The
   * captured payload is validated against the directive before the replay runs, so a
   * truncated or identity-less answer fails clearly instead of activating a partial
   * ticket.
   */
  async submitRemote(value: unknown, key?: string): Promise<TicketOperationResult> {
    const pending = this.pendingRemote;
    if (!pending) {
      return {
        ok: false,
        error: "no_pending_remote",
        message:
          "No Linear remote call is pending. Repeat the action without `remote` to receive the directive for the call that is still needed.",
      };
    }
    if (key && key.trim()) {
      const explicitKey = key.trim();
      if (explicitKey !== pending.directive.key) {
        return {
          ok: false,
          error: "remote_mismatch",
          message: `The supplied remote answer is for a different Linear call and was refused; the pending operation was left intact. Pending call: ${pending.directive.key}`,
        };
      }
    }
    const answer = unwrapMcpAnswer(value);
    const invalid = this.validatePendingAnswer(pending.directive, answer);
    if (invalid) {
      this.clearRemoteSession();
      return invalid;
    }
    const resolvedKey = key && key.trim() ? key.trim() : pending.directive.key;
    this.remoteAnswers = { ...this.remoteAnswers, [resolvedKey]: answer };
    this.pendingRemote = null;
    return this.run(pending.action, pending.input);
  }

  /**
   * Deterministically capture a `mcp` proxy result observed by the `tool_result`
   * handler and resume the pending Linear operation without any LLM-mediated
   * reproduction of the payload. The `input` is the `mcp` call's own
   * `{ server, tool, args }`; it must match the pending directive exactly, computed
   * with `linearRemoteKey`. When there is no pending remote, or the call does not
   * match, this returns `null` and leaves the operation untouched (the manual
   * `remote` fallback still applies).
   */
  async captureRemote(
    input: { server?: unknown; tool?: unknown; args?: unknown },
    value: unknown,
  ): Promise<TicketOperationResult | null> {
    const pending = this.pendingRemote;
    if (!pending) return null;
    const server = typeof input.server === "string" ? input.server : "";
    const tool = typeof input.tool === "string" ? input.tool : "";
    const args =
      input.args && typeof input.args === "object" && !Array.isArray(input.args)
        ? (input.args as Record<string, unknown>)
        : {};
    if (linearRemoteKey(server, tool, args) !== pending.directive.key) return null;
    return this.submitRemote(value, pending.directive.key);
  }

  /**
   * Reject a captured/handed-back answer that cannot satisfy the pending directive
   * before the replay runs, so a corrupt or unrelated payload never activates a
   * partial ticket. Returns an error result, or `null` when the answer is usable.
   */
  private validatePendingAnswer(
    directive: LinearRemoteDirective,
    answer: unknown,
  ): TicketOperationResult | null {
    if (directive.tool === "get_issue" || directive.tool === "save_issue") {
      // A genuine `null` for `get_issue` still means "not found" and is handled by
      // the replay; anything that is present but not a usable issue object is corrupt.
      if (answer === null || answer === undefined) return null;
      if (typeof answer !== "object" || Array.isArray(answer)) {
        return invalidRemotePayload(
          directive,
          "the captured payload is not a JSON object (it looks truncated or corrupt)",
        );
      }
      if (!hasUsableIssueIdentity(answer)) {
        return invalidRemotePayload(
          directive,
          "the captured issue payload carries no usable identity (no identifier or id)",
        );
      }
      const requestedId =
        typeof directive.args.id === "string" ? directive.args.id.trim() : "";
      if (requestedId) {
        const identity = readIssueIdentity(answer) ?? "";
        if (identity.toLowerCase() !== requestedId.toLowerCase()) {
          return invalidRemotePayload(
            directive,
            `the captured issue identity '${identity}' does not match the requested ticket '${requestedId}'`,
          );
        }
      }
      return null;
    }
    if (directive.tool === "list_issue_statuses") {
      const wrapped =
        answer && typeof answer === "object" && !Array.isArray(answer)
          ? (answer as { statuses?: unknown; states?: unknown; nodes?: unknown })
          : undefined;
      const arrayLike =
        Array.isArray(answer) ||
        (wrapped !== undefined &&
          (Array.isArray(wrapped.statuses) || Array.isArray(wrapped.states) || Array.isArray(wrapped.nodes)));
      if (!arrayLike || normalizeStatuses(answer).length === 0) {
        return invalidRemotePayload(
          directive,
          "the captured workflow-state payload is not a non-empty status array",
        );
      }
      return null;
    }
    return null;
  }

  async loadTicket(ticketId: string, options?: { force?: boolean }): Promise<TicketOperationResult> {
    return this.run("load", { ticketId, force: options?.force === true });
  }

  async startWork(): Promise<TicketOperationResult> {
    return this.run("start", {});
  }

  async completeTicket(options?: { evidence?: string; comment?: string }): Promise<TicketOperationResult> {
    return this.run("complete", { evidence: options?.evidence, comment: options?.comment });
  }

  async blockTicket(options: { evidence: string; comment?: string }): Promise<TicketOperationResult> {
    return this.run("block", { evidence: options.evidence, comment: options.comment });
  }

  async addComment(comment: string): Promise<TicketOperationResult> {
    return this.run("comment", { comment });
  }

  async refresh(): Promise<TicketOperationResult> {
    return this.run("refresh", {});
  }

  async run(action: MediatedAction, input: Record<string, unknown>): Promise<TicketOperationResult> {
    const blocked = this.blockedByMcp();
    if (blocked) {
      this.clearRemoteSession();
      return blocked;
    }

    try {
      const result = await this.perform(action, input);
      this.clearRemoteSession();
      return result;
    } catch (error) {
      if (isLinearRemoteRequired(error)) {
        const directive = error.directive;
        this.pendingRemote = { action, input, directive };
        return {
          ok: false,
          error: "remote_required",
          message: `Linear remote call required: ${directive.tool}`,
          directive,
          details: { directive, instruction: describeRemoteDirective(directive) },
        };
      }
      const code = error instanceof LinearTransportError ? error.code : "transport_error";
      const message = error instanceof Error ? error.message : String(error);
      this.clearRemoteSession();
      return { ok: false, error: code, message: `Linear ${action} failed: ${message}` };
    }
  }

  toSnapshot(): TicketSnapshot | null {
    if (!this.activeTicket) return null;
    return {
      ticketId: this.activeTicket.identifier,
      activeTicket: { ...this.activeTicket },
      workState: this.workState,
      lastKnownLinearStatus: this.activeTicket.status,
      changedPaths: Array.from(this.changedPaths),
      persistedAt: Date.now(),
    };
  }

  restoreFromSnapshot(snapshot: TicketSnapshot): void {
    if (!snapshot || !snapshot.activeTicket) return;
    this.activeTicket = { ...snapshot.activeTicket };
    this.workState = snapshot.workState ?? "loaded";
    this.changedPaths = new Set(snapshot.changedPaths ?? []);
  }

  reset(): void {
    this.activeTicket = null;
    this.workState = "loaded";
    this.changedPaths.clear();
    this.clearRemoteSession();
  }

  private createTransport(): LinearTransport {
    return this.transportOverride ?? new HostMediatedLinearTransport(this.remoteAnswers);
  }

  private clearRemoteSession(): void {
    this.pendingRemote = null;
    this.remoteAnswers = {};
  }

  private blockedByMcp(): TicketOperationResult | null {
    if (this.transportOverride || !this.mcpProbe) return null;
    const diagnostic = this.mcpProbe();
    if (diagnostic.usable) return null;
    return {
      ok: false,
      error: diagnostic.code === "needs_auth" ? "auth_unavailable" : "mcp_unavailable",
      message: `Linear is unavailable: ${diagnostic.code}`,
      details: { mcp: diagnostic },
    };
  }

  private async perform(action: MediatedAction, input: Record<string, unknown>): Promise<TicketOperationResult> {
    switch (action) {
      case "load":
        return this.performLoad(String(input.ticketId ?? ""), { force: input.force === true });
      case "start":
        return this.performStart();
      case "complete":
        return this.performComplete({
          evidence: typeof input.evidence === "string" ? input.evidence : undefined,
          comment: typeof input.comment === "string" ? input.comment : undefined,
        });
      case "block":
        return this.performBlock({
          evidence: String(input.evidence ?? ""),
          comment: typeof input.comment === "string" ? input.comment : undefined,
        });
      case "comment":
        return this.performComment(String(input.comment ?? ""));
      case "refresh":
        return this.performRefresh();
      default:
        return { ok: false, error: "unsupported_action", message: `Unsupported Linear action: ${String(action)}` };
    }
  }

  private async performLoad(
    ticketId: string,
    options?: { force?: boolean },
  ): Promise<TicketOperationResult> {
    const trimmedId = ticketId.trim();
    if (!trimmedId) {
      return { ok: false, error: "invalid_id", message: "Ticket ID is required." };
    }

    const switchCheck = canSwitchTicket(this.activeTicket, this.workState, trimmedId, options?.force);
    if (!switchCheck.allowed) {
      return {
        ok: false,
        error: "ticket_in_progress",
        message: switchCheck.reason ?? "Cannot switch tickets while current ticket is in progress.",
      };
    }

    let raw;
    try {
      raw = await this.createTransport().getIssue(trimmedId);
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      const code = err instanceof LinearTransportError ? err.code : "transport_error";
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: code, message: `Failed to load ticket "${trimmedId}": ${message}` };
    }

    if (!raw) {
      return { ok: false, error: "not_found", message: `Ticket "${trimmedId}" not found on Linear.` };
    }

    if (!hasUsableIssueIdentity(raw)) {
      return {
        ok: false,
        error: "invalid_remote_payload",
        message: `Linear returned an issue without usable identity (no identifier, id or uuid) for "${trimmedId}". The ticket was not activated.`,
      };
    }

    this.activeTicket = normalizeTicketContract(raw);
    this.workState = "loaded";
    this.changedPaths.clear();

    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: this.workState,
      contract: formatCompactContract(this.activeTicket),
      message: `Active ticket set to ${this.activeTicket.identifier}: ${this.activeTicket.title}`,
    };
  }

  private async performStart(): Promise<TicketOperationResult> {
    const active = this.activeTicket;
    if (!active) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    if (this.workState === "working") {
      return {
        ok: true,
        ticket: this.getActiveTicket()!,
        workState: "working",
        message: `Work already in progress for ${active.identifier}.`,
      };
    }

    const moved: ActiveTicket = { ...active };
    if (active.statusType !== "started") {
      try {
        const transport = this.createTransport();
        const statuses = await transport.getStatuses(active.team);
        const startedStatus = resolveTargetStatus(statuses, "started");
        if (startedStatus && startedStatus.id !== active.statusId) {
          const updated = await transport.updateIssue(active.identifier, { statusId: startedStatus.id });
          const state = readIssueState(updated);
          moved.status = state.name !== "Unknown" ? state.name : startedStatus.name;
          moved.statusId = state.id ?? startedStatus.id;
          moved.statusType = state.type ?? startedStatus.type;
        }
      } catch (err) {
        if (isLinearRemoteRequired(err)) throw err;
        // A status transition failure must not abort local work.
      }
    }

    this.activeTicket = moved;
    this.workState = "working";
    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: this.workState,
      message: `Started work on ${moved.identifier} (${moved.status}).`,
    };
  }

  private async performComplete(
    options?: { evidence?: string; comment?: string },
  ): Promise<TicketOperationResult> {
    const active = this.activeTicket;
    if (!active) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    const verification = this.getVerification();
    const gate = checkDoneGate(verification, Array.from(this.changedPaths));
    if (!gate.allowed) {
      return { ok: false, error: "verify_gate_denied", message: `Done Gate DENIED: ${gate.reason}` };
    }

    const transport = this.createTransport();

    let fresh;
    try {
      fresh = await transport.getIssue(active.identifier);
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      const code = err instanceof LinearTransportError ? err.code : "network_failure";
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: code,
        message: `Linear sync failed (${code}): ${message}. Local implementation remains verified PASS. Sync pending.`,
      };
    }

    if (!fresh) {
      return { ok: false, error: "not_found", message: `Remote ticket "${active.identifier}" no longer exists.` };
    }

    const conflict = detectRemoteConflict(active, fresh);
    if (conflict.conflict) {
      return {
        ok: false,
        error: "remote_conflict",
        message: `Remote conflict: ${conflict.reason} Completion blocked to avoid overwriting remote changes.`,
      };
    }

    let statuses;
    try {
      statuses = await transport.getStatuses(active.team);
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "sync_error", message: `Linear status lookup failed: ${message}. Local code verified PASS.` };
    }

    const completedStatus = resolveTargetStatus(statuses, "completed");
    if (!completedStatus) {
      return {
        ok: false,
        error: "sync_error",
        message: "Linear exposes no completed workflow state for this team, so the ticket was not updated.",
      };
    }

    const moved: ActiveTicket = { ...active };
    try {
      const updated = await transport.updateIssue(active.identifier, { statusId: completedStatus.id });
      const state = readIssueState(updated);
      moved.status = state.name !== "Unknown" ? state.name : completedStatus.name;
      moved.statusId = state.id ?? completedStatus.id;
      moved.statusType = state.type ?? "completed";
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      const code = err instanceof LinearTransportError ? err.code : "sync_error";
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: code, message: `Linear status update failed: ${message}. Local code verified PASS.` };
    }

    const completionComment =
      options?.comment || `Implemented ${active.identifier}. Verified PASS on revision ${verification.revision}.`;
    try {
      await transport.addComment(active.identifier, completionComment);
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      // A comment failure after the status update is not fatal.
    }

    this.activeTicket = moved;
    this.workState = "complete";
    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: this.workState,
      message: `Ticket ${moved.identifier} marked Done in Linear.`,
    };
  }

  private async performBlock(options: { evidence: string; comment?: string }): Promise<TicketOperationResult> {
    const active = this.activeTicket;
    if (!active) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    const blockerComment = `Blocked: ${options.evidence}${options.comment ? ` — ${options.comment}` : ""}`;
    try {
      await this.createTransport().addComment(active.identifier, blockerComment);
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      // A comment failure must not prevent recording the blocker locally.
    }

    this.workState = "blocked";
    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: this.workState,
      message: `Ticket ${active.identifier} marked blocked: ${options.evidence}`,
    };
  }

  private async performComment(comment: string): Promise<TicketOperationResult> {
    const active = this.activeTicket;
    if (!active) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    const trimmed = comment.trim();
    if (!trimmed) {
      return { ok: false, error: "empty_comment", message: "Comment body cannot be empty." };
    }

    try {
      await this.createTransport().addComment(active.identifier, trimmed);
      return { ok: true, message: `Added comment to ${active.identifier}.` };
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "comment_failed", message: `Failed to add comment: ${message}` };
    }
  }

  private async performRefresh(): Promise<TicketOperationResult> {
    const active = this.activeTicket;
    if (!active) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    try {
      const fresh = await this.createTransport().getIssue(active.identifier);
      if (!fresh) {
        return { ok: false, error: "not_found", message: "Ticket no longer exists on remote." };
      }
      if (!hasUsableIssueIdentity(fresh)) {
        return {
          ok: false,
          error: "invalid_remote_payload",
          message: `Linear returned an issue without usable identity (no identifier, id or uuid) for "${active.identifier}". The active ticket was left unchanged.`,
        };
      }
      this.activeTicket = normalizeTicketContract(fresh);
      return {
        ok: true,
        ticket: this.getActiveTicket()!,
        workState: this.workState,
        contract: formatCompactContract(this.activeTicket),
        message: `Refreshed ticket ${this.activeTicket.identifier} from remote.`,
      };
    } catch (err) {
      if (isLinearRemoteRequired(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "refresh_failed", message: `Refresh failed: ${message}` };
    }
  }
}
