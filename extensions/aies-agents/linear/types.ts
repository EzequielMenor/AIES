/**
 * AIES-008: Linear Ticket Workflow Types.
 */

export type TicketWorkState =
  | "loaded"
  | "working"
  | "verification_required"
  | "verified"
  | "blocked"
  | "complete";

/** Workflow state as Linear's MCP projection reports it. */
export interface LinearIssueStateRef {
  id: string;
  name: string;
  type?: string;
  color?: string;
}

export interface LinearIssueRaw {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  /**
   * Current workflow state. Linear's MCP projection carries it as a plain status
   * name plus a flat `statusType`, while other payloads carry a state object, so
   * both shapes are accepted (see `readIssueState`).
   */
  state?: LinearIssueStateRef | string;
  status?: LinearIssueStateRef | string;
  /** Flat state type used by the MCP issue projection ("started", "completed", ...). */
  statusType?: string;
  /** Workflow history; the entry without `endedAt` holds the current state id. */
  stateHistory?: Array<{
    state?: LinearIssueStateRef | string;
    startedAt?: string;
    endedAt?: string | null;
  }>;
  project?: { id: string; name: string } | string;
  labels?: Array<{ id: string; name: string } | string>;
  /** Owning team, as a name or an object. */
  team?: string | { id?: string; name?: string };
  teamId?: string;
  url?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface LinearStatus {
  id: string;
  name: string;
  type: string; // "unstarted" | "started" | "completed" | "canceled" | "backlog" | "triage"
  color?: string;
  position?: number;
}

export interface LinearIssueUpdate {
  statusId?: string;
  stateId?: string;
  title?: string;
  description?: string;
}

export interface ActiveTicket {
  id: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  status: string;
  statusId?: string;
  statusType?: string;
  project?: string;
  /** Owning team name or id, required to resolve the team's workflow states. */
  team?: string;
  labels?: string[];
  url?: string;
  loadedAt: number;
}

export interface TicketOperationResult {
  ok: boolean;
  ticket?: ActiveTicket;
  workState?: TicketWorkState;
  contract?: string;
  error?: string;
  message?: string;
  details?: Record<string, unknown>;
}

export interface TicketSnapshot {
  ticketId: string;
  activeTicket: ActiveTicket;
  workState: TicketWorkState;
  lastKnownLinearStatus: string;
  changedPaths: string[];
  persistedAt: number;
}
