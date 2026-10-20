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
 *
 * EZE-503 adds one piece of session state to the same owner: the explicit user
 * request to keep the last step ("no commit todavía"). It is recorded from the
 * user's own input, survives the work that follows, and outranks a fresh Verify
 * PASS at the Done Gate.
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
import { trackerLabel, trackerLabelForServer } from "./labels.ts";
import { readFinalActionDirective, type PendingFinalAction } from "./pending-action.ts";
import { HostMediatedPlaneTransport, PlaneWriteUnconfirmedError } from "./plane-transport.ts";
import {
  HostMediatedLinearTransport,
  isLinearRemoteRequired,
  linearRemoteKey,
  LinearTransportError,
  normalizeStatuses,
  unwrapMcpAnswer,
  type TrackerTransport,
} from "./transport.ts";
import { DEFAULT_TRACKER_ID, selectTracker, type TrackerSelection } from "./tracker.ts";
import type {
  ActiveTicket,
  LinearRemoteDirective,
  TicketOperationResult,
  TicketSnapshot,
  TicketWorkState,
  TrackerId,
} from "./types.ts";

/** Operations that need a Linear round trip and can be resumed afterwards. */
type MediatedAction = "load" | "start" | "complete" | "block" | "comment" | "refresh";

interface PendingRemote {
  action: MediatedAction;
  input: Record<string, unknown>;
  directive: LinearRemoteDirective;
}

export interface TicketManagerOptions {
  transport?: TrackerTransport;
  getVerification: () => VerificationState;
  /**
   * MCP availability probe. Absent in tests. When it reports that the transport
   * cannot be used, the manager fails with that diagnosis instead of asking the
   * Parent for a call that cannot succeed.
   */
  getMcpDiagnostic?: () => McpDiagnostic;
  /**
   * D33: the configured tracker. Absent, it is read from `$PI_CODING_AGENT_DIR/aies.json`
   * on every operation, so a changed profile takes effect without a restart.
   */
  selectTracker?: () => TrackerSelection;
}

/** Build a clear `invalid_remote_payload` refusal for a captured/handed answer. */
function invalidRemotePayload(
  directive: LinearRemoteDirective,
  reason: string,
): TicketOperationResult {
  return {
    ok: false,
    error: "invalid_remote_payload",
    message: `${trackerLabelForServer(directive.server)} ${directive.tool} returned an unusable answer: ${reason}. The operation was not completed and no partial ticket was activated.`,
  };
}

export class TicketManager {
  private activeTicket: ActiveTicket | null = null;
  private workState: TicketWorkState = "loaded";
  private changedPaths: Set<string> = new Set();
  private transportOverride?: TrackerTransport;
  private getVerification: () => VerificationState;
  private mcpProbe?: () => McpDiagnostic;
  private trackerSelector: () => TrackerSelection;

  /** The call the Parent still owes, if any. */
  private pendingRemote: PendingRemote | null = null;
  /** Answers already collected for the in-flight operation, keyed by directive key. */
  private remoteAnswers: Record<string, unknown> = {};

  /** EZE-503: an explicit user request to hold the final step, if one stands. */
  private pendingFinalAction: PendingFinalAction | null = null;

  constructor(options: TicketManagerOptions) {
    this.transportOverride = options.transport;
    this.getVerification = options.getVerification;
    this.mcpProbe = options.getMcpDiagnostic;
    this.trackerSelector = options.selectTracker ?? (() => selectTracker());
  }

  setTransport(transport: TrackerTransport): void {
    this.transportOverride = transport;
  }

  /** The transport in use: the injected one in tests, otherwise the mediated one. */
  getTransport(): TrackerTransport {
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

  /**
   * Read one submitted user input (EZE-503). Only explicit wording changes the
   * hold: an input that says nothing about finalization leaves it in place, so a
   * Verify PASS, a continuation turn or a plain "seguí" can never quietly re-open
   * the Done path the user paused. Returns the state that stands afterwards.
   */
  recordUserInput(text: string): PendingFinalAction | null {
    const directive = readFinalActionDirective(text);
    if (!directive) return this.pendingFinalAction;
    this.pendingFinalAction = directive.kind === "hold" ? directive.pending : null;
    return this.pendingFinalAction;
  }

  /** The held final step, or null when the user never asked to keep one. */
  getPendingFinalAction(): PendingFinalAction | null {
    return this.pendingFinalAction ? { ...this.pendingFinalAction } : null;
  }

  /** The Linear call the Parent still has to perform, if any. */
  getPendingDirective(): LinearRemoteDirective | null {
    return this.pendingRemote ? { ...this.pendingRemote.directive } : null;
  }

  /** The mediated action that emitted the pending call (D33 part C), or null when none is pending. */
  getPendingRemoteAction(): MediatedAction | null {
    return this.pendingRemote ? this.pendingRemote.action : null;
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
          `No ${this.trackerName()} remote call is pending. Repeat the action without \`remote\` to receive the directive for the call that is still needed.`,
      };
    }
    if (key && key.trim()) {
      const explicitKey = key.trim();
      if (explicitKey !== pending.directive.key) {
        return {
          ok: false,
          error: "remote_mismatch",
          message: `The supplied remote answer is for a different ${this.trackerName()} call and was refused; the pending operation was left intact. Pending call: ${pending.directive.key}`,
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
    // The captured call must be the MCP call the directive names. A staged directive (D36 part 3)
    // shares that call with an earlier one, so it is matched by the call and answered by its own key.
    const wanted = pending.directive;
    if (linearRemoteKey(server, tool, args) !== linearRemoteKey(wanted.server, wanted.tool, wanted.args)) return null;
    return this.submitRemote(value, wanted.key);
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

  async completeTicket(options?: {
    evidence?: string;
    comment?: string;
    /** The user confirmed the held step; see `performComplete`. */
    force?: boolean;
  }): Promise<TicketOperationResult> {
    return this.run("complete", {
      evidence: options?.evidence,
      comment: options?.comment,
      force: options?.force === true,
    });
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
    // D33: an unknown tracker refuses before any transport is chosen, so it can never
    // send an MCP call or change a ticket.
    const selection = this.trackerSelector();
    if (!selection.ok) {
      this.clearRemoteSession();
      return { ok: false, error: selection.error, message: selection.message };
    }

    // D33 item 2: a ticket loaded from one tracker is never operated through another.
    // A change while a ticket is active fails closed, with no remote call.
    const active = this.activeTicket;
    const activeTracker = active ? (active.tracker ?? DEFAULT_TRACKER_ID) : null;
    if (active && activeTracker !== selection.tracker.id) {
      this.clearRemoteSession();
      return {
        ok: false,
        error: "tracker_mismatch",
        message: `Ticket ${active.identifier} was loaded with tracker "${activeTracker}" but the configured tracker is "${selection.tracker.id}". No remote call was made and the current state is unchanged.`,
      };
    }

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
          message: `${trackerLabel(selection.tracker.id)} remote call required: ${directive.tool}`,
          directive,
          details: { directive, instruction: describeRemoteDirective(directive) },
        };
      }
      const code = error instanceof LinearTransportError ? error.code : "transport_error";
      const message = error instanceof Error ? error.message : String(error);
      this.clearRemoteSession();
      return { ok: false, error: code, message: `${trackerLabel(selection.tracker.id)} ${action} failed: ${message}` };
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
      pendingFinalAction: this.pendingFinalAction ? { ...this.pendingFinalAction } : null,
      tracker: this.activeTicket.tracker ?? DEFAULT_TRACKER_ID,
      persistedAt: Date.now(),
    };
  }

  /**
   * Resume a stored ticket. A snapshot from another tracker, or a configured tracker
   * that cannot be used, is refused (D33 item 2): nothing is activated, the current
   * state is kept and no remote call is made. A snapshot without a tracker predates
   * the field and is Linear.
   */
  restoreFromSnapshot(snapshot: TicketSnapshot): TicketOperationResult {
    if (!snapshot || !snapshot.activeTicket) return { ok: true };

    const selection = this.trackerSelector();
    if (!selection.ok) {
      return { ok: false, error: selection.error, message: `Ticket snapshot not restored: ${selection.message}` };
    }
    const origin: unknown = snapshot.tracker ?? DEFAULT_TRACKER_ID;
    if (origin !== selection.tracker.id) {
      return {
        ok: false,
        error: "tracker_mismatch",
        message: `Ticket snapshot not restored: it was recorded with tracker "${String(origin)}" but the configured tracker is "${selection.tracker.id}". No remote call was made and the current state is unchanged.`,
      };
    }

    this.activeTicket = { ...snapshot.activeTicket, tracker: selection.tracker.id };
    this.workState = snapshot.workState ?? "loaded";
    this.changedPaths = new Set(snapshot.changedPaths ?? []);
    this.pendingFinalAction = snapshot.pendingFinalAction ?? null;
    return { ok: true };
  }

  reset(): void {
    this.activeTicket = null;
    this.workState = "loaded";
    this.changedPaths.clear();
    this.pendingFinalAction = null;
    this.clearRemoteSession();
  }

  private createTransport(): TrackerTransport {
    if (this.transportOverride) return this.transportOverride;
    const selection = this.trackerSelector();
    if (!selection.ok) throw new LinearTransportError("mcp_unavailable", selection.message);
    if (selection.tracker.id === "plane") {
      return new HostMediatedPlaneTransport(this.remoteAnswers, selection.tracker.mcpServer);
    }
    return new HostMediatedLinearTransport(this.remoteAnswers, selection.tracker.mcpServer);
  }

  /**
   * The tracker a ticket is loaded from. `run` has already accepted the configured
   * tracker before any load reaches this point, so the fallback is never taken.
   */
  private activeTrackerId(): TrackerId {
    const selection = this.trackerSelector();
    return selection.ok ? selection.tracker.id : DEFAULT_TRACKER_ID;
  }

  /** The name of the configured tracker, for the texts this manager shows. */
  trackerName(): string {
    const selection = this.trackerSelector();
    return trackerLabel(selection.ok ? selection.tracker.id : undefined);
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
      message: `${this.trackerName()} is unavailable: ${diagnostic.code}`,
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
          force: input.force === true,
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
        return { ok: false, error: "unsupported_action", message: `Unsupported ${this.trackerName()} action: ${String(action)}` };
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
      return { ok: false, error: "not_found", message: `Ticket "${trimmedId}" not found on ${this.trackerName()}.` };
    }

    if (!hasUsableIssueIdentity(raw)) {
      return {
        ok: false,
        error: "invalid_remote_payload",
        message: `${this.trackerName()} returned an issue without usable identity (no identifier, id or uuid) for "${trimmedId}". The ticket was not activated.`,
      };
    }

    this.activeTicket = { ...normalizeTicketContract(raw), tracker: this.activeTrackerId() };
    this.workState = "loaded";
    this.changedPaths.clear();
    // The held step belonged to the previous work unit, not to this ticket.
    this.pendingFinalAction = null;

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
        // D36 part 3: a Plane start the read-back did not confirm does not move the local ticket.
        if (err instanceof PlaneWriteUnconfirmedError) {
          return { ok: false, error: err.code, message: `Plane start failed: ${err.message}` };
        }
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
    options?: { evidence?: string; comment?: string; force?: boolean },
  ): Promise<TicketOperationResult> {
    const active = this.activeTicket;
    if (!active) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    // EZE-503: `force` is the only way past a held final step, and it stands for
    // the user's confirmation of the held review/commit, never for impatience.
    if (options?.force) this.pendingFinalAction = null;

    const verification = this.getVerification();
    const gate = checkDoneGate(verification, Array.from(this.changedPaths), this.pendingFinalAction);
    if (!gate.allowed) {
      if (gate.code === "pending_final_action") {
        return {
          ok: false,
          error: "pending_final_action",
          message:
            `Done Gate HELD: ${gate.reason} Nothing was sent to ${this.trackerName()} and the ticket stays open; ` +
            `the verification record is unchanged (status ${verification.status}, revision ${verification.revision}). ` +
            "Report the pending step to the user and wait: complete only after they confirm it, " +
            "or repeat with force: true as their explicit confirmation.",
        };
      }
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
        message: `${this.trackerName()} sync failed (${code}): ${message}. Local implementation remains verified PASS. Sync pending.`,
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
      return { ok: false, error: "sync_error", message: `${this.trackerName()} status lookup failed: ${message}. Local code verified PASS.` };
    }

    const completedStatus = resolveTargetStatus(statuses, "completed");
    if (!completedStatus) {
      return {
        ok: false,
        error: "sync_error",
        message: `${this.trackerName()} exposes no completed workflow state for this team, so the ticket was not updated.`,
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
      return { ok: false, error: code, message: `${this.trackerName()} status update failed: ${message}. Local code verified PASS.` };
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
      message: `Ticket ${moved.identifier} marked Done in ${this.trackerName()}.`,
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
          message: `${this.trackerName()} returned an issue without usable identity (no identifier, id or uuid) for "${active.identifier}". The active ticket was left unchanged.`,
        };
      }
      // D33: a Plane ticket keeps its tracker across a refresh, or the next operation refuses it.
      const refreshed = normalizeTicketContract(fresh);
      this.activeTicket = active.tracker === "plane" ? { ...refreshed, tracker: "plane" } : refreshed;
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
