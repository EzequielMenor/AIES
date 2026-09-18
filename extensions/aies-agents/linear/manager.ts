/**
 * AIES-008: Ticket Manager.
 *
 * Central coordinator for active Linear ticket state in the Parent session.
 * Connects transport, workflow policy, and verification state.
 */

import type { VerificationState } from "../verification.ts";
import {
  formatCompactContract,
  normalizeTicketContract,
} from "./contract.ts";
import {
  canSwitchTicket,
  checkDoneGate,
  detectRemoteConflict,
  resolveTargetStatus,
} from "./policy.ts";
import {
  LinearTransportError,
  McpLinearTransport,
  type LinearTransport,
} from "./transport.ts";
import type {
  ActiveTicket,
  TicketOperationResult,
  TicketSnapshot,
  TicketWorkState,
} from "./types.ts";

export interface TicketManagerOptions {
  transport?: LinearTransport;
  getVerification: () => VerificationState;
}

export class TicketManager {
  private activeTicket: ActiveTicket | null = null;
  private workState: TicketWorkState = "loaded";
  private changedPaths: Set<string> = new Set();
  private transport: LinearTransport;
  private getVerification: () => VerificationState;

  constructor(options: TicketManagerOptions) {
    this.transport = options.transport ?? new McpLinearTransport();
    this.getVerification = options.getVerification;
  }

  setTransport(transport: LinearTransport): void {
    this.transport = transport;
  }

  getTransport(): LinearTransport {
    return this.transport;
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

  async loadTicket(ticketId: string, options?: { force?: boolean }): Promise<TicketOperationResult> {
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
      raw = await this.transport.getIssue(trimmedId);
    } catch (err: unknown) {
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

  async startWork(): Promise<TicketOperationResult> {
    if (!this.activeTicket) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    if (this.workState === "working") {
      return {
        ok: true,
        ticket: this.getActiveTicket()!,
        workState: "working",
        message: `Work already in progress for ${this.activeTicket.identifier}.`,
      };
    }

    // Attempt to transition remote status to started if currently unstarted/backlog
    if (this.activeTicket.statusType !== "started") {
      try {
        const statuses = await this.transport.getStatuses();
        const startedStatus = resolveTargetStatus(statuses, "started");
        if (startedStatus && startedStatus.id !== this.activeTicket.statusId) {
          const updated = await this.transport.updateIssue(this.activeTicket.identifier, {
            statusId: startedStatus.id,
          });
          this.activeTicket.status = updated.state?.name || startedStatus.name;
          this.activeTicket.statusId = startedStatus.id;
          this.activeTicket.statusType = startedStatus.type;
        }
      } catch (err) {
        // Status transition failure at start does not abort local work, but logs note
      }
    }

    this.workState = "working";
    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: "working",
      message: `Started work on ${this.activeTicket.identifier} (${this.activeTicket.status}).`,
    };
  }

  async completeTicket(options?: { evidence?: string; comment?: string }): Promise<TicketOperationResult> {
    if (!this.activeTicket) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    // 1. Programmatic Done Gate
    const verification = this.getVerification();
    const gate = checkDoneGate(verification, Array.from(this.changedPaths));
    if (!gate.allowed) {
      return {
        ok: false,
        error: "verify_gate_denied",
        message: `Done Gate DENIED: ${gate.reason}`,
      };
    }

    // 2. Remote refresh & conflict detection
    let fresh;
    try {
      fresh = await this.transport.getIssue(this.activeTicket.identifier);
    } catch (err: unknown) {
      const code = err instanceof LinearTransportError ? err.code : "network_failure";
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: code,
        message: `Linear sync failed (${code}): ${message}. Local implementation remains verified PASS. Sync pending.`,
      };
    }

    if (!fresh) {
      return {
        ok: false,
        error: "not_found",
        message: `Remote ticket "${this.activeTicket.identifier}" no longer exists.`,
      };
    }

    const conflict = detectRemoteConflict(this.activeTicket, fresh);
    if (conflict.conflict) {
      return {
        ok: false,
        error: "remote_conflict",
        message: `Remote conflict: ${conflict.reason} Completion blocked to avoid overwriting remote changes.`,
      };
    }

    // 3. Resolve completed status
    try {
      const statuses = await this.transport.getStatuses();
      const completedStatus = resolveTargetStatus(statuses, "completed");
      if (completedStatus) {
        const updated = await this.transport.updateIssue(this.activeTicket.identifier, {
          statusId: completedStatus.id,
        });
        this.activeTicket.status = updated.state?.name || completedStatus.name;
        this.activeTicket.statusId = completedStatus.id;
        this.activeTicket.statusType = "completed";
      }
    } catch (err: unknown) {
      const code = err instanceof LinearTransportError ? err.code : "sync_error";
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: code,
        message: `Linear status update failed: ${message}. Local code verified PASS.`,
      };
    }

    // 4. Optional completion comment (compact, zero spam)
    const completionComment =
      options?.comment ||
      `Implemented ${this.activeTicket.identifier}. Verified PASS on revision ${verification.revision}.`;
    try {
      await this.transport.addComment(this.activeTicket.identifier, completionComment);
    } catch {
      // Non-fatal if comment fails after status updated
    }

    this.workState = "complete";
    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: "complete",
      message: `Ticket ${this.activeTicket.identifier} marked Done in Linear.`,
    };
  }

  async blockTicket(options: { evidence: string; comment?: string }): Promise<TicketOperationResult> {
    if (!this.activeTicket) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    this.workState = "blocked";
    const blockerComment = `Blocked: ${options.evidence}${options.comment ? ` — ${options.comment}` : ""}`;
    try {
      await this.transport.addComment(this.activeTicket.identifier, blockerComment);
    } catch {}

    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: "blocked",
      message: `Ticket ${this.activeTicket.identifier} marked blocked: ${options.evidence}`,
    };
  }

  async addComment(comment: string): Promise<TicketOperationResult> {
    if (!this.activeTicket) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    const trimmed = comment.trim();
    if (!trimmed) {
      return { ok: false, error: "empty_comment", message: "Comment body cannot be empty." };
    }

    try {
      await this.transport.addComment(this.activeTicket.identifier, trimmed);
      return { ok: true, message: `Added comment to ${this.activeTicket.identifier}.` };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "comment_failed", message: `Failed to add comment: ${message}` };
    }
  }

  async refresh(): Promise<TicketOperationResult> {
    if (!this.activeTicket) {
      return { ok: false, error: "no_active_ticket", message: "No active ticket loaded." };
    }

    try {
      const fresh = await this.transport.getIssue(this.activeTicket.identifier);
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
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: "refresh_failed", message: `Refresh failed: ${message}` };
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
  }
}
