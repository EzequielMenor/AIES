/**
 * D33 phase 3: the Plane tracker transport.
 *
 * `HostMediatedPlaneTransport` follows the same rule as `HostMediatedLinearTransport`
 * (D17): it never opens a connection. Each call is answered from an `mcp` result the
 * Parent already captured for the server `plane`, or it fails with a
 * `remote_required` directive for the first call still missing. The directives use
 * the verified Plane tool shapes:
 *
 *   workitem          retrieve_by_identifier   read the ticket (expand=state,project)
 *   workitem          update                   write the workflow state UUID
 *   workitem          retrieve_by_identifier   read the state back (a separate stage)
 *   state             list                     the project's workflow states
 *   workitem_comment  create                   the comment as escaped HTML
 *
 * D36 part 3: a state write is confirmed only by the read-back. The write's own answer
 * is not evidence of the state. The read-back has the same arguments as the read before
 * the write, so it runs under its own stage (`mediatedAnswer`): the Parent gets a normal
 * directive for it, and the pre-write answer cannot satisfy it. A read-back that does not
 * show the written state throws `PlaneWriteUnconfirmedError`, and the caller does not move
 * the local ticket. The comment is only written after that confirmation. The MCP calls
 * carry no extra argument.
 *
 * Identity is `PROJECT-N` (D33 item 7). The project and work item UUIDs are internal:
 * a write needs them, and they come from the retrieve answer for the same ticket.
 * That answer is one of the replayed answers, so no transport signature changes and
 * no second source of truth exists.
 *
 * `FakePlaneTransport` is the offline counterpart. It stores Plane-shaped records and
 * reads them with the same normalizer the runtime uses, so the contract suite
 * exercises the code path that production runs.
 */

import { isPlaneIdentifier, isPlaneUuid, normalizePlaneStates, normalizePlaneWorkItem } from "./contract.ts";
import { LinearTransportError, mediatedAnswer, type LinearErrorCode, type TrackerTransport } from "./transport.ts";
import type { LinearIssueRaw, LinearIssueUpdate, LinearStatus } from "./types.ts";

/** MCP server AIES declares for Plane in `profile/mcp-adapter.json`. */
export const PLANE_MCP_SERVER = "plane";

/** The stage of the read-back that confirms a state write (D36 part 3). */
const CONFIRM_STAGE = "confirm-state";

/**
 * A Plane state write that the read-back did not confirm (D36 part 3). Its code is the
 * typed reason (`remote_conflict`, `not_found` or `invalid_remote_payload`). The local
 * ticket must not move, and the ticket stays open and recoverable.
 */
export class PlaneWriteUnconfirmedError extends LinearTransportError {
  constructor(code: LinearErrorCode, detail: string) {
    super(code, `${detail} The ticket was not moved in AIES and stays open; retry the action or check the state in Plane.`);
    this.name = "PlaneWriteUnconfirmedError";
  }
}

/**
 * The work items `confirmState` returned. Membership proves that this transport ran the read-back check
 * over the answer it was given and that the state matched; a payload cannot add itself to the set, and a
 * transport that never reads back (the offline fake) never does. It does NOT prove the answer came from
 * Plane: the answers are whatever the Parent supplied. The manager therefore also requires that every
 * answer of the operation was captured from the real `mcp` result (`captureRemote`), never handed over by
 * the model through `remote`, before a completion may feed project memory.
 */
const READ_BACK_CONFIRMED = new WeakSet<object>();

/** True when `item` is the read-back that confirmed a Plane state write (D36 part 3). */
export function isReadBackConfirmed(item: unknown): boolean {
  return typeof item === "object" && item !== null && READ_BACK_CONFIRMED.has(item);
}

/** Plane MCP tool names, as the adapter's proxy addresses them. */
const PLANE_TOOLS = {
  workItem: "workitem",
  state: "state",
  comment: "workitem_comment",
} as const;

function retrieveArgs(identifier: string): Record<string, unknown> {
  return { action: "retrieve_by_identifier", workitem_identifier: identifier, expand: "state,project" };
}

/** A ticket is named by `PROJECT-N` only. A UUID or any other shape is refused before any call. */
function requireTicketKey(id: string): void {
  if (!isPlaneIdentifier(id)) {
    throw new LinearTransportError(
      "invalid_remote_payload",
      `"${id}" is not a Plane ticket identifier (PROJECT-N). A work item UUID is never a ticket identity.`,
    );
  }
}

/** The work item an answer describes. An answer for another ticket is refused, never activated. */
function readWorkItemAnswer(requested: string, value: unknown): LinearIssueRaw {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LinearTransportError("invalid_remote_payload", `Plane returned an unusable answer for ${requested}.`);
  }
  const item = normalizePlaneWorkItem(value);
  if (item.identifier && item.identifier !== requested) {
    throw new LinearTransportError(
      "invalid_remote_payload",
      `Plane returned work item ${item.identifier} for the requested ${requested}. The answer was refused.`,
    );
  }
  return item;
}

/** The comment body as Plane stores it: the text escaped, one paragraph, line breaks kept. */
export function planeCommentHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `<p>${escaped.replace(/\r?\n/g, "<br>")}</p>`;
}

/** What a write needs: the work item and its project, both as Plane UUIDs. */
interface PlaneWriteTarget {
  item: LinearIssueRaw;
  workItemId: string;
  projectId: string;
}

/**
 * Runtime Plane transport, mediated by the Parent.
 *
 * Every call is answered from work the Parent already completed, or fails with a
 * `remote_required` directive for the first missing call. It never opens a
 * connection, never holds a credential and never reads the environment.
 */
export class HostMediatedPlaneTransport implements TrackerTransport {
  private readonly answers: Readonly<Record<string, unknown>>;
  private readonly server: string;

  constructor(answers: Readonly<Record<string, unknown>> = {}, server: string = PLANE_MCP_SERVER) {
    this.answers = answers;
    this.server = server;
  }

  private answer<T>(tool: string, args: Record<string, unknown>, purpose: string, stage: string = ""): T {
    return mediatedAnswer<T>(this.answers, this.server, tool, args, purpose, "Plane", stage);
  }

  /** Resolve the UUIDs a write needs from the retrieve answer for this ticket. */
  private writeTarget(identifier: string): PlaneWriteTarget {
    const value = this.answer<unknown>(PLANE_TOOLS.workItem, retrieveArgs(identifier), "read the ticket contract");
    if (value === null || value === undefined) {
      throw new LinearTransportError("not_found", `Work item ${identifier} not found on Plane.`);
    }
    const item = readWorkItemAnswer(identifier, value);
    const workItemId = typeof item.planeId === "string" ? item.planeId : "";
    const projectId = typeof item.planeProjectId === "string" ? item.planeProjectId : "";
    if (!item.identifier || !workItemId || !projectId) {
      throw new LinearTransportError(
        "invalid_remote_payload",
        `The Plane answer for ${identifier} carries no work item or project id, so nothing was written.`,
      );
    }
    return { item, workItemId, projectId };
  }

  async getIssue(id: string): Promise<LinearIssueRaw | null> {
    requireTicketKey(id);
    const value = this.answer<unknown>(PLANE_TOOLS.workItem, retrieveArgs(id), "read the ticket contract");
    if (value === null || value === undefined) return null;
    return readWorkItemAnswer(id, value);
  }

  async updateIssue(id: string, update: LinearIssueUpdate): Promise<LinearIssueRaw> {
    requireTicketKey(id);
    if (update.title !== undefined || update.description !== undefined) {
      throw new LinearTransportError(
        "invalid_transition",
        "The Plane transport moves the workflow state only; title and description are not mapped yet.",
      );
    }
    const target = this.writeTarget(id);
    const stateRef = (update.statusId ?? update.stateId)?.trim();
    if (!stateRef) return target.item;

    // Plane takes a state UUID on writes. A name is resolved through the project's state list.
    const stateId = isPlaneUuid(stateRef) ? stateRef : await this.stateIdByName(target.projectId, stateRef);
    // The write's own answer is not evidence of the state: only the read-back confirms it (D36 part 3).
    this.answer<unknown>(
      PLANE_TOOLS.workItem,
      { action: "update", project_id: target.projectId, workitem_id: target.workItemId, state: stateId },
      "update the ticket workflow state",
    );
    return this.confirmState(id, stateId);
  }

  /**
   * D36 part 3: the state written is the state read back. The read-back runs under its own
   * stage, so its directive is a normal one and the pre-write answer cannot stand in for it.
   * Anything other than the requested ticket in the written state is refused.
   */
  private confirmState(identifier: string, stateId: string): LinearIssueRaw {
    const value = this.answer<unknown>(
      PLANE_TOOLS.workItem,
      retrieveArgs(identifier),
      "confirm the workflow state by reading the ticket back",
      CONFIRM_STAGE,
    );
    if (value === null || value === undefined) {
      throw new PlaneWriteUnconfirmedError("not_found", `Plane returned no work item for ${identifier} when the state was read back.`);
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      throw new PlaneWriteUnconfirmedError("invalid_remote_payload", `Plane returned an unusable read-back for ${identifier}.`);
    }
    const item = normalizePlaneWorkItem(value);
    if (item.identifier !== identifier) {
      throw new PlaneWriteUnconfirmedError(
        "invalid_remote_payload",
        `The read-back for ${identifier} names ${item.identifier || "no work item"}.`,
      );
    }
    const actual = item.state?.id ?? "";
    if (!actual) {
      throw new PlaneWriteUnconfirmedError("invalid_remote_payload", `The read-back for ${identifier} carries no workflow state.`);
    }
    if (actual.toLowerCase() !== stateId.toLowerCase()) {
      throw new PlaneWriteUnconfirmedError(
        "remote_conflict",
        `Plane reports state ${actual} for ${identifier} after the write, not the state AIES wrote (${stateId}).`,
      );
    }
    READ_BACK_CONFIRMED.add(item);
    return item;
  }

  async getStatuses(teamIdOrProjectId?: string): Promise<LinearStatus[]> {
    const project = teamIdOrProjectId?.trim();
    if (!project) {
      throw new LinearTransportError(
        "mcp_unavailable",
        "Cannot resolve Plane workflow states: the active ticket does not expose its project.",
      );
    }
    if (!isPlaneUuid(project)) {
      throw new LinearTransportError(
        "mcp_unavailable",
        "Cannot resolve Plane workflow states: the project reference is not a Plane project id.",
      );
    }
    const value = this.answer<unknown>(
      PLANE_TOOLS.state,
      { action: "list", project_id: project },
      "resolve the project workflow states",
    );
    return normalizePlaneStates(value);
  }

  async addComment(id: string, body: string): Promise<void> {
    requireTicketKey(id);
    const target = this.writeTarget(id);
    this.answer<unknown>(
      PLANE_TOOLS.comment,
      {
        action: "create",
        project_id: target.projectId,
        workitem_id: target.workItemId,
        comment_html: planeCommentHtml(body),
      },
      "record the ticket comment",
    );
  }

  private async stateIdByName(projectId: string, name: string): Promise<string> {
    const wanted = name.trim().toLowerCase();
    const match = (await this.getStatuses(projectId)).find((status) => status.name.trim().toLowerCase() === wanted);
    if (!match) {
      throw new LinearTransportError("invalid_transition", `The Plane project has no workflow state named "${name}".`);
    }
    return match.id;
  }
}

interface FakePlaneProject {
  id: string;
  identifier: string;
  name: string;
}

interface FakePlaneRecord {
  id: string;
  sequence_id: number;
  name: string;
  description_stripped: string;
  project: FakePlaneProject;
  state: { id: string; name: string; group: string };
}

/** Plane's default workflow states, with the groups Plane reports. */
const FAKE_PLANE_STATES: ReadonlyArray<{ name: string; group: string }> = [
  { name: "Backlog", group: "backlog" },
  { name: "Todo", group: "unstarted" },
  { name: "In Progress", group: "started" },
  { name: "Done", group: "completed" },
  { name: "Cancelled", group: "cancelled" },
];

function fakeUuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Deterministic in-memory Plane for the test suite. Records are kept in the Plane
 * shape and read through `normalizePlaneWorkItem`, so it runs the same read path as
 * the runtime. Plane keeps states per project; the fake shares one set, which is
 * enough for the contract and the lifecycle. Writes accept state UUIDs only, as the
 * runtime sends them.
 */
export class FakePlaneTransport implements TrackerTransport {
  private readonly states = FAKE_PLANE_STATES.map((seed, index) => ({
    id: fakeUuid(0x100 + index),
    name: seed.name,
    group: seed.group,
  }));
  private readonly projects = new Map<string, FakePlaneProject>();
  private readonly items = new Map<string, FakePlaneRecord>();
  private nextUuid = 0x1000;

  public queriedIdentifiers: string[] = [];
  public updatedIssues: Array<{ id: string; update: LinearIssueUpdate }> = [];
  public addedComments: Array<{ id: string; body: string; commentHtml: string }> = [];

  public simulatedError: LinearErrorCode | null = null;

  constructor() {
    this.ensureProject("AIES", "AIES");
  }

  setSimulatedError(code: LinearErrorCode | null): void {
    this.simulatedError = code;
  }

  private check(): void {
    if (this.simulatedError) {
      throw new LinearTransportError(this.simulatedError, `Simulated Plane error: ${this.simulatedError}`);
    }
  }

  private ensureProject(identifier: string, name: string): FakePlaneProject {
    const existing = [...this.projects.values()].find((project) => project.identifier === identifier);
    if (existing) return existing;
    const project = { id: fakeUuid(this.nextUuid++), identifier, name };
    this.projects.set(project.id, project);
    return project;
  }

  /** Make a work item exist on the fake remote, as Plane would hold it. */
  seedIssue(issue: {
    identifier: string;
    title: string;
    description?: string;
    state?: string;
    project?: { name?: string };
  }): void {
    const match = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/.exec(issue.identifier);
    if (!match) throw new Error(`fake Plane identifiers are PROJECT-N, got ${issue.identifier}`);
    const project = this.ensureProject(match[1], issue.project?.name ?? match[1]);
    const stateName = issue.state ?? "Todo";
    const state = this.states.find((candidate) => candidate.name === stateName);
    if (!state) throw new Error(`fake Plane has no state named ${stateName}`);
    this.items.set(issue.identifier, {
      id: fakeUuid(this.nextUuid++),
      sequence_id: Number(match[2]),
      name: issue.title,
      description_stripped: issue.description ?? "",
      project: { ...project },
      state: { ...state },
    });
  }

  /** Move a work item from outside AIES, as another person would in Plane. */
  moveExternally(identifier: string, stateName: string): void {
    const item = this.items.get(identifier);
    const state = this.states.find((candidate) => candidate.name === stateName);
    if (!item || !state) throw new Error(`fake Plane cannot move ${identifier} to ${stateName}`);
    item.state = { ...state };
  }

  async getIssue(id: string): Promise<LinearIssueRaw | null> {
    this.check();
    requireTicketKey(id);
    this.queriedIdentifiers.push(id);
    const record = this.items.get(id);
    return record ? normalizePlaneWorkItem(structuredClone(record)) : null;
  }

  async updateIssue(id: string, update: LinearIssueUpdate): Promise<LinearIssueRaw> {
    this.check();
    this.updatedIssues.push({ id, update });
    const record = this.items.get(id);
    if (!record) throw new LinearTransportError("not_found", `Work item ${id} not found on Plane`);
    if (update.title !== undefined || update.description !== undefined) {
      throw new LinearTransportError("invalid_transition", "The fake Plane moves the workflow state only.");
    }
    const ref = (update.statusId ?? update.stateId)?.trim();
    if (ref) {
      const state = this.states.find((candidate) => candidate.id === ref);
      if (!state) throw new LinearTransportError("invalid_transition", `Unknown Plane state ${ref}`);
      record.state = { ...state };
    }
    return normalizePlaneWorkItem(structuredClone(record));
  }

  async getStatuses(_teamIdOrProjectId?: string): Promise<LinearStatus[]> {
    this.check();
    return normalizePlaneStates({ results: this.states.map((state) => ({ ...state })) });
  }

  async addComment(id: string, body: string): Promise<void> {
    this.check();
    if (!this.items.has(id)) throw new LinearTransportError("not_found", `Work item ${id} not found on Plane`);
    this.addedComments.push({ id, body, commentHtml: planeCommentHtml(body) });
  }
}
