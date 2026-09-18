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

export interface LinearIssueRaw {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  state?: {
    id: string;
    name: string;
    type?: string;
    color?: string;
  };
  status?: {
    id: string;
    name: string;
    type?: string;
  };
  project?: {
    id: string;
    name: string;
  };
  labels?: Array<{ id: string; name: string } | string>;
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
