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
  normalizeTicketContract,
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
  LinearTransportError,
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

  /** Current MCP diagnosis, or null when no probe is wired in. */
  getMcpDiagnostic(): McpDiagnostic | null {
    return this.mcpProbe ? this.mcpProbe() : null;
  }

  /**
   * Hand back the value the Parent obtained from the pending MCP call and resume
   * the interrupted operation. Replay is pure: every remote value comes from an
   * answer the Parent supplied, so re-running the operation cannot repeat a remote
   * write.
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
    const resolvedKey = key && key.trim() ? key.trim() : pending.directive.key;
    this.remoteAnswers = { ...this.remoteAnswers, [resolvedKey]: unwrapMcpAnswer(value) };
    this.pendingRemote = null;
    return this.run(pending.action, pending.input);
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
