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

import { basename, isAbsolute, relative, sep } from "node:path";

import type { McpDiagnostic } from "../mcp/integration.ts";
import { isVerificationValid, requiresVerification, type VerificationState } from "../verification.ts";
import {
  describeRemoteDirective,
  formatCompactContract,
  hasUsableIssueIdentity,
  normalizeTicketContract,
  readIssueIdentity,
  readIssueState,
} from "./contract.ts";
import { captureBaseline, collectChanges, type ChangeSet } from "./change-evidence.ts";
import {
  canSwitchTicket,
  checkDoneGate,
  detectRemoteConflict,
  resolveTargetStatus,
  type DoneGateResult,
} from "./policy.ts";
import { trackerLabel, trackerLabelForServer } from "./labels.ts";
import { readFinalActionDirective, type PendingFinalAction } from "./pending-action.ts";
import { HostMediatedPlaneTransport, isReadBackConfirmed, PlaneWriteUnconfirmedError } from "./plane-transport.ts";
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

/**
 * What the manager knows about a completion it has just finished, handed to `afterDone` (D42 phase 3).
 * It is built from the transport and the Done Gate, never from tool input.
 */
export interface DoneCompletion {
  ticket: ActiveTicket;
  /** The Verify record as it stands now. */
  verification: VerificationState;
  confirmation: {
    tracker: TrackerId;
    /** The tracker state was confirmed by reading the work item back (Plane only). */
    readBackConfirmed: boolean;
    /** The type of the state the tracker reported after the write. */
    stateType: string | undefined;
    gateAllowed: boolean;
    /** The Verify record the Done Gate judged. */
    verification: { status: string; revision: number; verifiedRevision: number | undefined };
  };
  /** What the Parent proposed with `complete`; untrusted. */
  learnings: unknown;
}

/** What `afterDone` adds to the result: one line for the Parent and, optionally, a notice for the user. */
export interface DoneFollowUp {
  line?: string;
  /** Shown to the user by the caller that has a UI. */
  notify?: { message: string; level: "info" | "warning" };
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
  /**
   * EZE-496: where Git is read for change evidence. Absent, the Done Gate judges the
   * recorded paths alone, as before. Present, the gate also sees what Git shows since
   * the ticket was loaded, and it refuses what it cannot describe.
   */
  changeProbe?: { cwd: () => string };
  /**
   * Called once after a `complete` the tracker has accepted, when the operation had learnings attached.
   * It runs after Done is final: its failure or its absence changes nothing about the completion, and the
   * manager never repeats a tracker operation because of it. Absent in tests that do not need it.
   */
  afterDone?: (done: DoneCompletion) => Promise<DoneFollowUp | undefined>;
}

/** How many paths a diagnosis lists before it reports the rest as a count (EZE-496). */
const DIAGNOSIS_PATH_LIMIT = 20;
/** Longest reason a diagnosis shows (Git error text is otherwise unbounded), and the shown length of a sha. */
const DIAGNOSIS_REASON_CHARS = 1200;
const DIAGNOSIS_SHA_CHARS = 12;

/** A capped list of display paths: the first ones, and how many more were left out. */
export interface DoneGatePathList {
  items: string[];
  more: number;
}

/**
 * Read-only diagnosis of the Done Gate (EZE-496), built from the same computation as
 * `evaluateDoneGate`. Fingerprints and the baseline are shortened; no file content,
 * diff or absolute path is included.
 */
export interface DoneGateDiagnosis {
  decision: "ALLOW" | "DENY";
  code?: DoneGateResultCode;
  reason: string;
  /** Whether a change probe is wired; without one the gate judges the recorded paths alone. */
  probe: boolean;
  /** Baseline commit, shortened; "none" without a probe, "unknown" when it was not recorded. */
  baseline: string;
  evidence: "known" | "unknown" | "not configured";
  unknownReason?: string;
  recordedPaths: DoneGatePathList;
  detectedPaths: DoneGatePathList;
  effectivePaths: DoneGatePathList;
  verificationRequired: { required: boolean; reason: string };
  verification: {
    status: VerificationState["status"];
    revision: number;
    verifiedRevision: number | null;
    valid: boolean;
  };
  fingerprint: {
    /** Shortened change fingerprint; "unknown" when Git could not describe the changes. */
    current: string;
    /** Shortened fingerprint the last PASS covered; "none" when no PASS is bound. */
    verified: string;
    /** Whether the PASS covers the current changes; null when they cannot be compared. */
    matches: boolean | null;
  };
  pendingFinalAction: { kind: string; quote: string } | null;
}

type DoneGateResultCode = NonNullable<DoneGateResult["code"]>;

/** The Spanish refusal for a direct Linear Done the Done Gate does not allow (EZE-496). */
export function linearDoneGateBypassReason(ticket: { identifier: string }, gateReason: string): string {
  return [
    `Bloqueado: no se cierra ${ticket.identifier} en Linear; el Done Gate no lo permite (${gateReason}).`,
    "No se envió ningún cambio de estado y el ticket sigue abierto; la evidencia de Verify queda intacta.",
    'Verificá los cambios con aies_delegate (role "verify") y, con un PASS sobre el estado actual, cerrá con aies_ticket action "complete".',
  ].join("\n");
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

/** What the Done Gate read to reach its verdict (EZE-496). */
interface DoneGateEvidence {
  baselineRev: string | undefined;
  /** What Git shows since the baseline; null when no change probe is wired. */
  changes: ChangeSet | null;
  recordedPaths: string[];
  effectivePaths: string[];
  verificationRequired: { required: boolean; reason: string };
  verification: VerificationState;
  verifiedFingerprint: string | undefined;
}

/**
 * The Git-aware refinement of a verdict (EZE-496): an unknown change state is refused,
 * and a completion that needs Verify needs a PASS bound to the current fingerprint.
 */
function judgeDoneGate(gate: DoneGateResult, evidence: DoneGateEvidence): DoneGateResult {
  const { changes } = evidence;
  if (!changes || !gate.allowed) return gate;

  if (!changes.known) {
    return {
      allowed: false,
      code: "verify_gate_denied",
      reason: `change state unknown: ${changes.reason}. The changes cannot be checked against the Verify PASS, so completion is refused.`,
    };
  }
  if (evidence.verificationRequired.required) {
    if (evidence.verifiedFingerprint === undefined) {
      return {
        allowed: false,
        code: "verify_gate_denied",
        reason: "Verification is not bound to the current changes: no PASS was recorded for this working tree. Run Verify again.",
      };
    }
    if (evidence.verifiedFingerprint !== changes.fingerprint) {
      return {
        allowed: false,
        code: "verify_gate_denied",
        reason: "the changes changed after the Verify PASS (a file was edited or changed outside AIES). Run Verify again.",
      };
    }
  }
  return gate;
}

/** Shortened hash or sha for display: enough to compare, never the full value. */
function shortHash(value: string): string {
  return value.slice(0, 12);
}

export class TicketManager {
  private activeTicket: ActiveTicket | null = null;
  private workState: TicketWorkState = "loaded";
  private changedPaths: Set<string> = new Set();
  private transportOverride?: TrackerTransport;
  private getVerification: () => VerificationState;
  private mcpProbe?: () => McpDiagnostic;
  private trackerSelector: () => TrackerSelection;
  private changeProbe?: { cwd: () => string };
  private afterDone?: (done: DoneCompletion) => Promise<DoneFollowUp | undefined>;
  /** EZE-496: the commit the ticket's changes are measured from; undefined when it could not be recorded. */
  private baselineRev?: string;
  /** EZE-496: the change fingerprint the last Verify PASS covered; undefined when none is bound. */
  private verifiedFingerprint?: string;

  /** The call the Parent still owes, if any. */
  private pendingRemote: PendingRemote | null = null;
  /** Answers already collected for the in-flight operation, keyed by directive key. */
  private remoteAnswers: Record<string, unknown> = {};
  /** True once any answer of the in-flight operation came from the model instead of the captured `mcp` result. */
  private modelAnswered = false;

  /** EZE-503: an explicit user request to hold the final step, if one stands. */
  private pendingFinalAction: PendingFinalAction | null = null;

  constructor(options: TicketManagerOptions) {
    this.transportOverride = options.transport;
    this.getVerification = options.getVerification;
    this.mcpProbe = options.getMcpDiagnostic;
    this.trackerSelector = options.selectTracker ?? (() => selectTracker());
    this.changeProbe = options.changeProbe;
    this.afterDone = options.afterDone;
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
   * Bind the Verify PASS that was just recorded to the changes as they are now (EZE-496).
   * An unknown state leaves no binding, so the gate refuses rather than trusts the PASS.
   */
  recordVerifiedState(): void {
    if (!this.changeProbe) return;
    const current = this.observeChanges();
    this.verifiedFingerprint = current.known ? current.fingerprint : undefined;
  }

  /**
   * The Done Gate verdict for completing the active ticket now. `aies_ticket complete`,
   * the Plane write guard and the direct Linear guard all decide through this method.
   *
   * Without a probe it is `checkDoneGate` over the recorded paths. With a probe the
   * recorded paths are joined with what Git shows since the ticket was loaded, and:
   *  - a change that cannot be described (no baseline, Git failure) is refused, unless
   *    the gate already refuses for another reason;
   *  - a completion that needs Verify needs a PASS bound to the changes as they are
   *    now, so any edit or change made after the PASS asks for a new Verify.
   */
  evaluateDoneGate(): DoneGateResult {
    return this.computeDoneGate().result;
  }

  /**
   * Read-only diagnosis of the Done Gate for `aies_ticket show` (EZE-496). It is built from
   * the same computation as `evaluateDoneGate`, so the two cannot disagree. It changes no
   * state (no baseline capture, no PASS binding, no hold cleared) and makes no tracker call;
   * the only Git reads are the ones `observeChanges` already makes.
   */
  describeDoneGate(): DoneGateDiagnosis {
    const { result, evidence } = this.computeDoneGate();
    const { changes, verifiedFingerprint, verification } = evidence;
    const currentFingerprint = changes?.known ? changes.fingerprint : undefined;
    const pending = this.pendingFinalAction;

    let baseline = "none";
    if (changes) baseline = evidence.baselineRev === undefined ? "unknown" : shortHash(evidence.baselineRev);

    let matches: boolean | null = null;
    if (currentFingerprint !== undefined && verifiedFingerprint !== undefined) {
      matches = currentFingerprint === verifiedFingerprint;
    }

    return {
      decision: result.allowed ? "ALLOW" : "DENY",
      ...(result.code ? { code: result.code } : {}),
      reason: this.scrubText(result.reason, evidence.effectivePaths),
      probe: changes !== null,
      baseline,
      evidence: !changes ? "not configured" : changes.known ? "known" : "unknown",
      ...(changes && !changes.known ? { unknownReason: this.scrubText(changes.reason, evidence.effectivePaths) } : {}),
      recordedPaths: this.displayPathList(evidence.recordedPaths),
      detectedPaths: this.displayPathList(changes?.known ? changes.paths : []),
      effectivePaths: this.displayPathList(evidence.effectivePaths),
      verificationRequired: {
        required: evidence.verificationRequired.required,
        reason: this.scrubText(evidence.verificationRequired.reason, evidence.effectivePaths),
      },
      verification: {
        status: verification.status,
        revision: verification.revision,
        verifiedRevision: verification.verifiedRevision ?? null,
        valid: isVerificationValid(verification),
      },
      fingerprint: {
        current: currentFingerprint !== undefined ? shortHash(currentFingerprint) : "unknown",
        verified: verifiedFingerprint !== undefined ? shortHash(verifiedFingerprint) : "none",
        matches,
      },
      pendingFinalAction: pending ? { kind: pending.kind, quote: pending.quote } : null,
    };
  }

  /**
   * The Done Gate verdict together with the evidence it was reached from. Both
   * `evaluateDoneGate` and `describeDoneGate` read this one computation.
   */
  private computeDoneGate(): { result: DoneGateResult; evidence: DoneGateEvidence } {
    const verification = this.getVerification();
    const recorded = Array.from(this.changedPaths);
    const changes = this.changeProbe ? this.observeChanges() : null;
    const effective = changes?.known ? [...new Set([...recorded, ...changes.paths])] : recorded;
    const gate = checkDoneGate(verification, effective, this.pendingFinalAction);
    const evidence: DoneGateEvidence = {
      baselineRev: this.baselineRev,
      changes,
      recordedPaths: recorded,
      effectivePaths: effective,
      verificationRequired: requiresVerification(effective),
      verification,
      verifiedFingerprint: this.verifiedFingerprint,
    };
    return { result: judgeDoneGate(gate, evidence), evidence };
  }

  /**
   * A path as a diagnosis may show it. Recorded paths can be absolute (they come from the
   * path an edit named), so an absolute path under the probe's directory is shown relative
   * to it, and any other absolute path is shown as its file name only.
   */
  private displayPath(path: string): string {
    if (!isAbsolute(path)) return path;
    const base = this.changeProbe?.cwd();
    if (base) {
      const rel = relative(base, path);
      if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) return rel;
    }
    return `.../${basename(path)}`;
  }

  /**
   * A reason as a diagnosis may show it. The gate's own wording names the raw paths, and an
   * absolute one must not reach the screen, so each is replaced by its display form, and the
   * probe's directory (which Git errors can name) by a placeholder. The gate's reason itself is
   * unchanged, so `complete` keeps saying exactly what it said before.
   */
  private scrubText(text: string, paths: string[]): string {
    let scrubbed = text;
    const absolute = [...new Set(paths.filter((path) => isAbsolute(path)))].sort((a, b) => b.length - a.length);
    for (const path of absolute) scrubbed = scrubbed.split(path).join(this.displayPath(path));
    const base = this.changeProbe?.cwd();
    if (base) scrubbed = scrubbed.split(base).join("<repo>");
    // Git errors can name the baseline: a full object name is shown by its first 12 characters.
    scrubbed = scrubbed.replace(/\b[0-9a-f]{40}(?:[0-9a-f]{24})?\b/giu, (sha) => sha.slice(0, DIAGNOSIS_SHA_CHARS));
    // The documentation-only reason lists every path; keep the same cap as the structured lists.
    scrubbed = scrubbed.replace(/(documentation-only change \()([^)]*)(\))/u, (_match, open: string, list: string, close: string) => {
      const names = list.split(", ");
      if (names.length <= DIAGNOSIS_PATH_LIMIT) return `${open}${list}${close}`;
      return `${open}${names.slice(0, DIAGNOSIS_PATH_LIMIT).join(", ")}, +${names.length - DIAGNOSIS_PATH_LIMIT} more${close}`;
    });
    return scrubbed.length > DIAGNOSIS_REASON_CHARS ? `${scrubbed.slice(0, DIAGNOSIS_REASON_CHARS - 1)}…` : scrubbed;
  }

  /** Display paths, de-duplicated, capped at the diagnosis limit with the number left out. */
  private displayPathList(paths: string[]): DoneGatePathList {
    const unique = [...new Set(paths.map((path) => this.displayPath(path)))];
    return {
      items: unique.slice(0, DIAGNOSIS_PATH_LIMIT),
      more: Math.max(0, unique.length - DIAGNOSIS_PATH_LIMIT),
    };
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

  /**
   * Drop a hold the user never meant (`/aies-ticket cancel-pending`). Only the hold is
   * cleared: verification, changed paths, baseline, work state and the ticket stay as
   * they are, and nothing is sent to the tracker. Returns what was cleared, or null.
   */
  cancelPendingFinalAction(): PendingFinalAction | null {
    const cleared = this.pendingFinalAction;
    this.pendingFinalAction = null;
    return cleared ? { ...cleared } : null;
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
  async submitRemote(value: unknown, key?: string, source: "model" | "capture" = "model"): Promise<TicketOperationResult> {
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
    // An answer the model handed over (the `remote` fallback) is not evidence of anything the tracker said:
    // a completion built on one is never confirmed for project memory (D42 phase 3).
    if (source === "model") this.modelAnswered = true;
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
    return this.submitRemote(value, wanted.key, "capture");
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
    /** Lessons the Parent proposes for project memory; untrusted, and only read after Done is final. */
    learnings?: unknown;
  }): Promise<TicketOperationResult> {
    return this.run("complete", {
      evidence: options?.evidence,
      comment: options?.comment,
      force: options?.force === true,
      learnings: options?.learnings,
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
      const modelAnswered = this.modelAnswered;
      this.clearRemoteSession();
      return action === "complete" ? await this.finishComplete(result, input, modelAnswered) : result;
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
      ...(this.baselineRev !== undefined ? { baselineRev: this.baselineRev } : {}),
      ...(this.verifiedFingerprint !== undefined ? { verifiedFingerprint: this.verifiedFingerprint } : {}),
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
    // EZE-496: a snapshot without a baseline (written before the change evidence existed) restores as
    // unknown, so the gate refuses completion until the ticket is loaded again or Verify runs.
    this.baselineRev = snapshot.baselineRev;
    this.verifiedFingerprint = snapshot.verifiedFingerprint;
    return { ok: true };
  }

  reset(): void {
    this.activeTicket = null;
    this.workState = "loaded";
    this.changedPaths.clear();
    this.pendingFinalAction = null;
    this.baselineRev = undefined;
    this.verifiedFingerprint = undefined;
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
    this.modelAnswered = false;
  }

  /** The commit to measure the ticket's changes from, or undefined when it cannot be recorded. */
  private captureBaselineRev(): string | undefined {
    if (!this.changeProbe) return undefined;
    const baseline = captureBaseline(this.changeProbe.cwd());
    return baseline.ok ? baseline.head : undefined;
  }

  /** What Git shows since the baseline. Unknown when there is no probe or no baseline. */
  private observeChanges(): ChangeSet {
    if (!this.changeProbe) return { known: false, reason: "no change probe is wired" };
    if (this.baselineRev === undefined) {
      return { known: false, reason: "the baseline commit was not recorded when the ticket was loaded" };
    }
    return collectChanges(this.changeProbe.cwd(), this.baselineRev);
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
    if (this.changeProbe) {
      // EZE-496: the changes of this ticket are measured from here, and no earlier PASS covers them.
      this.baselineRev = this.captureBaselineRev();
      this.verifiedFingerprint = undefined;
    }
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
    const gate = this.evaluateDoneGate();
    if (!gate.allowed) {
      if (gate.code === "pending_final_action") {
        return {
          ok: false,
          error: "pending_final_action",
          message:
            `Done Gate HELD: ${gate.reason} Nothing was sent to ${this.trackerName()} and the ticket stays open; ` +
            `the verification record is unchanged (status ${verification.status}, revision ${verification.revision}). ` +
            "Report the pending step to the user and wait: complete only after they confirm it, " +
            "or repeat with force: true as their explicit confirmation. " +
            "If the user never asked to hold this step, tell them they can run /aies-ticket cancel-pending to drop the hold.",
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
    // D42 phase 3: whether the tracker confirmed Done by reading the work item back, and the state type it reported.
    let readBackConfirmed = false;
    let reportedStateType: string | undefined;
    try {
      const updated = await transport.updateIssue(active.identifier, { statusId: completedStatus.id });
      const state = readIssueState(updated);
      moved.status = state.name !== "Unknown" ? state.name : completedStatus.name;
      moved.statusId = state.id ?? completedStatus.id;
      moved.statusType = state.type ?? "completed";
      reportedStateType = state.type;
      readBackConfirmed = active.tracker === "plane" && isReadBackConfirmed(updated);
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
    const completion: DoneCompletion["confirmation"] = {
      tracker: active.tracker ?? DEFAULT_TRACKER_ID,
      readBackConfirmed,
      stateType: reportedStateType,
      gateAllowed: gate.allowed,
      verification: { status: verification.status, revision: verification.revision, verifiedRevision: verification.verifiedRevision },
    };
    return {
      ok: true,
      ticket: this.getActiveTicket()!,
      workState: this.workState,
      message: `Ticket ${moved.identifier} marked Done in ${this.trackerName()}.`,
      // Only Plane reports the indicator (the Linear result stays exactly as it was).
      ...(active.tracker === "plane" ? { details: { completion } } : {}),
    };
  }

  /**
   * D42 phase 3: after Done is final, hand the proposed learnings to `afterDone`. This runs once, on the pass
   * that finished the operation, never on a replay. It cannot fail the completion or repeat a tracker call:
   * the ticket is already closed and every error here is swallowed.
   */
  private async finishComplete(result: TicketOperationResult, input: Record<string, unknown>, modelAnswered: boolean): Promise<TicketOperationResult> {
    if (!this.afterDone || !result.ok || !result.ticket) return result;
    if (input.learnings === undefined || input.learnings === null) return result;
    const verification = this.getVerification();
    // Without the Plane indicator the tracker never confirmed Done by a read-back, so nothing will be stored.
    const reported = result.details?.completion as DoneCompletion["confirmation"] | undefined;
    const confirmation: DoneCompletion["confirmation"] = (reported && { ...reported, readBackConfirmed: reported.readBackConfirmed && !modelAnswered }) ?? {
      tracker: result.ticket.tracker ?? DEFAULT_TRACKER_ID,
      readBackConfirmed: false,
      stateType: result.ticket.statusType,
      gateAllowed: true,
      verification: { status: verification.status, revision: verification.revision, verifiedRevision: verification.verifiedRevision },
    };
    try {
      const follow = await this.afterDone({
        ticket: result.ticket,
        verification: { ...verification },
        confirmation,
        learnings: input.learnings,
      });
      if (!follow) return result;
      return {
        ...result,
        ...(follow.line ? { message: result.message ? `${result.message}\n${follow.line}` : follow.line } : {}),
        details: { ...result.details, ...(reported ? { completion: confirmation } : {}), ...(follow.notify ? { followUp: follow.notify } : {}) },
      };
    } catch {
      return result;
    }
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
