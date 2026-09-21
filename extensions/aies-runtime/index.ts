/**
 * AIES runtime observer (AIES-002) and UI projection (AIES-010).
 *
 * Measures the parent session and projects that state onto Pi's public UI
 * surfaces. It is a sensor and a renderer, never an actuator: it never blocks a
 * call, never rewrites a result, never delegates, never compacts and never
 * changes routing. Every handler returns void, and every measurement sits behind
 * a guard, so a broken observer degrades into silence instead of changing how Pi
 * behaves.
 *
 * State lives in `state.ts`, rendering in `aies-ui/` and the compatibility
 * re-exports in `status.ts`, all pure; this file is the only place in the runtime
 * that touches Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION } from "@earendil-works/pi-coding-agent";

import {
  applyActiveToolCount,
  applyActivityFacts,
  applyAgents,
  applyCompaction,
  applyContextUsage,
  applyDelegationEnd,
  applyDelegationStart,
  applyModel,
  applyParentMutation,
  applyContextGovernorSync,
  applyPermissionsSync,
  applyResumedAt,
  applyRunStart,
  applyRunUsage,
  applySessionMeta,
  applyStopReason,
  applyTicketObservationSync,
  applyAutonomySync,
  applyToolCall,
  applyToolResult,
  applyVerificationReport,
  applyVerificationStart,
  createState,
  fromSnapshot,
  runStartedAt,
  toSnapshot,
  type AiesState,
} from "./state.ts";
import { renderFooter, renderHeader } from "../aies-ui/footer.ts";
import { PANEL_MIN_WIDTH, renderStatusPanel } from "../aies-ui/panel.ts";
import {
  installRightRail,
  renderRightRail,
  type RightRailHandle,
} from "../aies-ui/right-rail.ts";
import { renderStatusReport } from "./status.ts";
import {
  renderAgentsView,
  selectAgent,
  type AgentsSnapshot,
} from "../aies-ui/agents.ts";
import {
  isActivityVisible,
  renderActivityCard,
  renderActivityEntry,
  type ActivityRecord,
} from "../aies-ui/activity.ts";
import {
  renderBlockedSummary,
  renderDoneSummary,
  renderStatusOverview,
  type BlockedSummaryInput,
  type DoneSummaryInput,
} from "../aies-ui/summary.ts";
import { deriveStage } from "../aies-ui/vocabulary.ts";
import { themePaint } from "../aies-ui/paint.ts";
import { registerQuietTools } from "./quiet-tools.ts";
import { getSandboxStatus } from "../aies-agents/sandbox.ts";
import { getPermissionTelemetry } from "../aies-agents/permissions.ts";
import { getContextGovernorTelemetry } from "../aies-agents/context-governor.ts";
import { AGENTS_CHANNEL, type ObservatorySnapshot } from "../aies-agents/observatory.ts";
import { getActiveContinuationController } from "../aies-agents/autonomy/controller.ts";

/** Custom entry type carrying the metrics snapshot across a resume. */
const ENTRY_TYPE = "aies-metrics";

/** One widget per active child, above the editor. */
const ACTIVITY_KEY = "aies-activity";

/** The persistent status panel, rendered below the editor. */
const PANEL_KEY = "aies-panel";

/** Durable transcript entries: one per finished child, one per workflow summary. */
const AGENT_ENTRY_TYPE = "aies-agent";
const SUMMARY_ENTRY_TYPE = "aies-summary";

/** Native tools that change the artifact a verification verdict referred to. */
const PARENT_MUTATION_TOOLS = ["edit", "write"];

/** One timer, re-armed only when the wanted period changes. */
const ACTIVE_REFRESH_MS = 1000;
const IDLE_REFRESH_MS = 5000;

/**
 * The footer and header memo is computed at a comfortably wide cell count, so a
 * content change repaints while a terminal-resize change is left to Pi's own TUI
 * diffing.
 */
const SHELL_MEMO_WIDTH = 1000;

/** The completed-work label for each child role. */
const ROLE_DONE_LABEL: Record<string, string> = {
  explore: "exploración terminada",
  worker: "implementación terminada",
  verify: "verificación terminada",
};

/** Spanish sentences for every autonomy stop reason that deserves a BLOCKED card. */
const BLOCKED_SENTENCES: Record<string, { happened: string; needs?: string; pending?: string }> = {
  blocked: {
    happened: "El workflow se detuvo en un bloqueo.",
    needs: "resolver el bloqueo y reanudar con `/aies-run`.",
  },
  linear_conflict: {
    happened: "Linear cambió de estado por fuera de AIES.",
    needs: "revisar el ticket en Linear antes de continuar.",
  },
  linear_sync_failed: {
    happened: "Linear no pudo sincronizarse.",
    pending: "El código está verificado y no se volverá a ejecutar.",
  },
  permission_denied: {
    happened: "Una operación requería autorización y no se concedió.",
    needs: "autorizar la operación que AIES necesitaba.",
  },
  sandbox_unavailable: {
    happened: "El sandbox del sistema operativo no está disponible.",
    needs: "habilitar el sandbox o ejecutar sin autonomía.",
  },
  no_progress: {
    happened: "Tres iteraciones consecutivas no cambiaron nada.",
    needs: "revisar el bloqueo antes de reintentar.",
  },
  verification_failed: {
    happened: "La verificación falló de forma repetida.",
    needs: "revisar los defectos que reportó Verify.",
  },
  verification_protocol_error: {
    happened: "La verificación devolvió un error de protocolo y no produjo un veredicto válido.",
    needs: "revisar la configuración del agente Verify o volver a delegar la verificación.",
  },
  repair_limit: {
    happened: "Se agotaron los intentos de reparación.",
    needs: "revisar el defecto original a mano.",
  },
  context_failure: {
    happened: "El contexto no pudo compactarse.",
    needs: "revisar la sesión antes de continuar.",
  },
};

/** The slice of Pi's TUI the activity widget needs. */
interface WidgetTui {
  requestRender?(force?: boolean): void;
}

/** Pi's theme, read structurally because a partial host may not provide one. */
interface ThemeLike {
  fg(color: string, text: string): string;
}

/** The UI surface, read defensively so a partial host degrades to silence. */
interface UiSurface {
  setFooter?(factory: unknown): void;
  setHeader?(factory: unknown): void;
  setWidget?(key: string, content: unknown, options?: unknown): void;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  custom?(factory: unknown, options?: unknown): Promise<unknown>;
  theme?: unknown;
}

/** The slice of the injected keybinding manager `/agents` uses, when present. */
interface KeybindingsLike {
  matches?(data: string, binding: string): boolean;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

/** The shared event-bus surface, read structurally so a partial host degrades to silence. */
interface EventsSurface {
  on?(channel: string, handler: (data: unknown) => void): unknown;
}

function eventsOf(pi: ExtensionAPI): EventsSurface | undefined {
  try {
    return (pi as unknown as { events?: EventsSurface }).events;
  } catch {
    return undefined;
  }
}

/** The observatory projection the bus carries; an unreadable payload is empty. */
function asAgentSnapshot(payload: unknown): ObservatorySnapshot {
  return Array.isArray(payload) ? (payload as ObservatorySnapshot) : [];
}

/**
 * A check reads clean when its `result` is a non-empty string that is neither
 * `"false"` nor visibly a failure. An unreadable shape is never a pass; it is
 * simply not counted.
 */
function checkReadsClean(check: unknown): boolean {
  if (!check || typeof check !== "object" || Array.isArray(check)) return false;
  const result = (check as Record<string, unknown>).result;
  if (typeof result !== "string" || !result) return false;
  if (result === "false") return false;
  return !result.includes("fail") && !result.includes("FAIL");
}

function passedChecks(value: unknown): number | undefined {
  if (!Array.isArray(value)) return undefined;
  let passed = 0;
  for (const check of value) {
    if (checkReadsClean(check)) passed += 1;
  }
  return passed;
}

/** The facts the child reported, reduced to the numbers the UI can trust. */
function activityFacts(role: string, details: Record<string, unknown> | undefined): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  if (!details) return facts;

  if (role === "explore") {
    const evidence = arrayLength(details.evidence);
    if (evidence !== undefined) facts.evidenceCount = evidence;
    return facts;
  }

  if (role === "worker") {
    const changes = arrayLength(details.changes);
    if (changes !== undefined) facts.changedFiles = changes;
    const total = arrayLength(details.checks);
    if (total !== undefined) facts.checksTotal = total;
    const passed = passedChecks(details.checks);
    if (passed !== undefined) facts.checksPassed = passed;
    return facts;
  }

  if (role === "verify") {
    if (Array.isArray(details.criteria)) {
      facts.criteriaTotal = details.criteria.length;
      facts.criteriaPassed = details.criteria.filter(
        (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).status === "pass",
      ).length;
    }
    if (Array.isArray(details.defects)) {
      facts.blockingDefects = details.defects.filter(
        (entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).severity === "blocking",
      ).length;
    }
    const total = arrayLength(details.checks);
    if (total !== undefined) facts.checksTotal = total;
    const passed = passedChecks(details.checks);
    if (passed !== undefined) facts.checksPassed = passed;
  }

  return facts;
}

/** The activity outcome. `explore`/`worker` speak `done|blocked|failed`; Verify speaks `pass|fail|blocked` plus a protocol fault. */
function activityOutcome(role: string, details: Record<string, unknown> | undefined, isError: boolean): string {
  const status = details?.status;

  if (role === "verify") {
    const verification = details?.verification;
    const vStatus = verification && typeof verification === "object" && !Array.isArray(verification)
      ? (verification as Record<string, unknown>).status
      : undefined;

    // A protocol fault is its own outcome: never collapsed into domain FAIL by isError.
    if (status === "protocol_error" || vStatus === "protocol_error" || details?.kind === "protocol_error") {
      return "protocol_error";
    }
    if (status === "pass") return "done";
    if (status === "fail") return "failed";
    if (status === "blocked") return "blocked";
    if (vStatus === "pass") return "done";
    if (vStatus === "fail") return "failed";
    if (vStatus === "blocked") return "blocked";
    if (isError) return "failed";
    return "done";
  }

  if (isError) return "failed";
  if (status === "done" || status === "blocked" || status === "failed") return status;
  return "done";
}

/** A session that never did anything measurable gets no entry in its own file. */
function worthPersisting(snapshot: ReturnType<typeof toSnapshot>): boolean {
  return snapshot.toolCalls > 0
    || snapshot.toolResults > 0
    || snapshot.compactionCount > 0
    || snapshot.peakContextTokens > 0
    || snapshot.stopReason !== undefined;
}

export default function aiesRuntime(pi: ExtensionAPI): void {
  let state: AiesState = createState(Date.now());
  let clock: ReturnType<typeof setInterval> | undefined;
  let clockPeriod: number | undefined;
  let footer = "";
  let header = "";
  let panel = "";
  let persisted = "";
  let widgetTui: WidgetTui | undefined;
  let footerTui: WidgetTui | undefined;
  let headerTui: WidgetTui | undefined;
  let widgetRegistered = false;
  let panelWidgetTui: WidgetTui | undefined;
  let panelWidgetRegistered = false;
  // The isolated private right-rail shim, installed only when the host accepts the
  // version-guarded fullscreen hook. When `active`, the below-editor dock yields.
  let railHandle: RightRailHandle | undefined;
  // The host's git branch, read from the footer factory's public data provider.
  let branchReader: (() => string | null) | undefined;
  let observatoryUnsubscribe: (() => void) | undefined;

  // Whether this host accepted AIES's durable summary renderer. Only a host that
  // draws the card may skip the headline notify; everywhere else the notify is
  // the only surface, so headless users still get exactly one summary line.
  let summaryCardsRendered = false;

  // Whether the status panel owns the run status. Single source for the footer
  // minimal form and the header/panel exclusivity; recomputed on every render
  // pass so a resize degrades cleanly.
  let panelVisible = false;

  // Autonomy transitions are edges, not levels: a new signal is one transition.
  let autonomySignal = "";
  let autonomyEnabled = false;
  let autonomyStopReason: string | null = null;

  // The DONE card is emitted at most once per run, from either completion path
  // (the observed ticket reaching Linear's completed state, or autonomy stopping
  // with `completed`). A new run re-arms the latch.
  let doneEmitted = false;
  // Whether the observed ticket has already been read as completed in this run,
  // so the DONE edge fires once per completion rather than on every render.
  let ticketWasComplete = false;
  // A Linear `statusType: "completed"` seen on the ticket tool result, kept out
  // of the persisted snapshot because the runtime only observes it.
  let ticketStatusTypeComplete = false;

  // The last verdict facts Verify reported, kept for the BLOCKED summary.
  let lastVerify: { criteriaPassed?: number; criteriaTotal?: number; checksPassed?: number } | undefined;

  /** Measurement and rendering must never surface as a Pi extension error. */
  function guard(action: () => void): void {
    try {
      action();
    } catch {
      // Observation is optional; Pi's behaviour is not.
    }
  }

  function uiOf(ctx: ExtensionContext): UiSurface | undefined {
    try {
      return (ctx as unknown as { ui?: UiSurface }).ui;
    } catch {
      return undefined;
    }
  }

  /**
   * The real terminal width. `process.stdout.columns` is the only terminal-size
   * source AIES reads: no query, no cursor movement. A host without a TTY
   * reports `undefined` and the shell keeps its responsive fallbacks.
   */
  function terminalColumns(): number | undefined {
    try {
      const columns = process.stdout?.columns;
      return typeof columns === "number" && Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Recompute the single `panelVisible` boolean and return the measured width. */
  function measurePanelVisibility(): number | undefined {
    const columns = terminalColumns();
    panelVisible = columns !== undefined && columns >= PANEL_MIN_WIDTH;
    return columns;
  }

  /**
   * The UI projection the renderers read: the snapshot plus the ephemeral agent
   * records. `toSnapshot` never carries `agents`, so every surface builds the
   * projection here and no two surfaces can disagree.
   */
  function uiSnapshot(): AgentsSnapshot {
    return { ...toSnapshot(state), agents: state.agents };
  }

  /**
   * Consume the observatory snapshots the agents extension re-publishes on the
   * shared `pi.events` bus. Pi loads each extension through its own module
   * registry, so the registry singleton is not shared across the boundary; the
   * bus is the documented bridge. A host without the bus, or a silent publisher,
   * simply leaves the projection empty: the registry is optional observation and
   * must never crash the runtime. Returns the bus unsubscribe for shutdown.
   */
  function subscribeToAgentsBus(ctx: ExtensionContext): (() => void) | undefined {
    const events = eventsOf(pi);
    if (!events || typeof events.on !== "function") return undefined;

    try {
      const unsubscribe = events.on(AGENTS_CHANNEL, (payload: unknown) => {
        guard(() => {
          state = applyAgents(state, asAgentSnapshot(payload));
          requestRender();
        });
      });
      return typeof unsubscribe === "function" ? (unsubscribe as () => void) : undefined;
    } catch {
      return undefined;
    }
  }

  function usageOf(ctx: ExtensionContext) {
    try {
      return ctx.getContextUsage();
    } catch {
      return undefined;
    }
  }

  function activeToolCount(): number | undefined {
    try {
      return pi.getActiveTools().length;
    } catch {
      return undefined;
    }
  }

  /**
   * Incremental Parent usage cache. The observer samples on its 1s cadence while
   * a child runs, and AIES-010C forbids re-parsing the whole session for
   * presentation on every pass. We hold the number of entries already reduced
   * plus the running cumulative totals, so each sample reduces only the entries
   * appended since the last index and never rescans the session.
   */
  let usageCache: { count: number; totalTokens: number; cost: number; costKnown: boolean } | undefined;

  function resetParentUsageCache(): void {
    usageCache = undefined;
  }

  /**
   * Cumulative Parent usage from the only real surface Pi exposes for it: the
   * assistant `usage` records of this session's entries. No child token can be in
   * here — a delegated child runs in an isolated in-memory session and
   * `aies_delegate` returns no nested usage — so Main can never include a child.
   * Returns `undefined` when Pi cannot answer, and the caller keeps the last
   * known run telemetry; unknown cost stays `null`.
   */
  function parentUsageOf(ctx: ExtensionContext): { totalTokens: number; cost: number | null } | undefined {
    let entries;
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      return undefined;
    }

    // A cache from a different (or compacted) session cannot be trusted: rebuild
    // it from the current entries instead of carrying another session's totals.
    if (!usageCache || usageCache.count > entries.length) {
      usageCache = { count: 0, totalTokens: 0, cost: 0, costKnown: true };
    }

    for (let index = usageCache.count; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.type !== "message") continue;
      const message = entry.message as { role?: unknown; usage?: unknown };
      if (message.role !== "assistant") continue;
      const usage = message.usage as { totalTokens?: unknown; cost?: { total?: unknown } } | undefined;
      if (!usage || typeof usage !== "object") continue;

      if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens)) {
        usageCache.totalTokens += usage.totalTokens;
      }
      const total = usage.cost && typeof usage.cost === "object" ? (usage.cost as { total?: unknown }).total : undefined;
      if (typeof total === "number" && Number.isFinite(total)) usageCache.cost += total;
      else usageCache.costKnown = false;
    }
    // Every entry up to the current length is now reduced exactly once, including
    // the ones skipped by the guards above.
    usageCache.count = entries.length;

    return {
      totalTokens: usageCache.totalTokens,
      cost: usageCache.costKnown ? usageCache.cost : null,
    };
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
    const ui = uiOf(ctx);
    if (!ui || typeof ui.notify !== "function") return;
    try {
      ui.notify(message, type);
    } catch {
      // A host without a notification channel stays silent.
    }
  }

  function appendEntry(type: string, data: unknown): void {
    if (typeof (pi as { appendEntry?: unknown }).appendEntry !== "function") return;
    try {
      pi.appendEntry(type, data);
    } catch {
      // A session that cannot take entries simply keeps its state in memory.
    }
  }

  /**
   * Whether the durable summary entry is actually drawn on this host. Only a TUI
   * that accepted AIES's entry renderer paints the card; every other host (no
   * TUI, or no entry-renderer support) cannot, so the headline must travel through
   * `notify` there instead of being silently lost.
   */
  function summaryCardIsDrawn(ctx: ExtensionContext): boolean {
    return ctx.mode === "tui" && summaryCardsRendered;
  }

  /**
   * Emit one summary across exactly one visible surface: append the durable card
   * always, and notify its headline only where the card is not drawn. The card and
   * the notify are never both visible, which stops the completed row from printing
   * twice in one transcript.
   */
  function publishSummary(ctx: ExtensionContext, data: unknown, headline: string): void {
    appendEntry(SUMMARY_ENTRY_TYPE, data);
    if (!summaryCardIsDrawn(ctx)) notify(ctx, headline, "info");
  }

  /** Sample every telemetry source into the state. */
  function syncObservation(ctx: ExtensionContext): void {
    state = applyContextUsage(state, usageOf(ctx));
    state = applyActiveToolCount(state, activeToolCount());

    const telemetry = getPermissionTelemetry();
    state = applyPermissionsSync(state, {
      sandbox: getSandboxStatus(),
      denials: telemetry.denials,
      approvals: telemetry.approvals,
      sandboxFailures: telemetry.sandboxFailures,
    });
    state = applyContextGovernorSync(state, getContextGovernorTelemetry());

    const autonomyCtrl = getActiveContinuationController();
    if (autonomyCtrl) {
      const s = autonomyCtrl.getState();
      state = applyAutonomySync(state, {
        enabled: s.enabled,
        ticketId: s.ticketId,
        continuationCount: s.continuationCount,
        stopReason: s.stopReason,
        lastStep: s.lastStepDescription,
      });
    }
  }

  /**
   * Fold the ephemeral agents projection and the cumulative Parent usage into
   * the run telemetry. The projection is filled by the shared bus, not by a
   * direct singleton read: Pi loads each extension through its own module
   * registry, so the registry the agents extension mutates is not this module's.
   * It reuses the observer's single render pass and adds no timer, loop or
   * poller; a session that cannot answer leaves the last known numbers intact
   * through `parentUsageOf` returning undefined.
   */
  function sampleRunUsage(ctx: ExtensionContext): void {
    state = applyRunUsage(state, parentUsageOf(ctx), state.agents ?? [], Date.now());
  }

  /** Fire at most once per autonomy edge (enable, or a new stop reason). */
  function observeAutonomy(ctx: ExtensionContext): void {
    const autonomy = state.autonomy;
    if (!autonomy) return;

    const enabled = autonomy.enabled === true;
    const ticket = autonomy.ticketId ?? null;
    const stopReason = autonomy.stopReason ?? null;

    const signal = `${enabled}|${stopReason ?? ""}|${ticket ?? ""}`;
    if (signal === autonomySignal) return;
    autonomySignal = signal;

    const enabling = enabled && !autonomyEnabled;
    const newStop = stopReason !== null && stopReason !== autonomyStopReason;

    autonomyEnabled = enabled;
    autonomyStopReason = stopReason;

    if (enabling) {
      // Autonomy just started a ticket run: the panel reports from here, not from
      // the whole session's lifetime usage, and the DONE latch re-arms. The AUTO
      // badge in the footer/rail is the signal; a duplicate notification would
      // only repeat the command that started it.
      state = applyRunStart(state, Date.now());
      doneEmitted = false;
    }
    if (newStop && stopReason) handleStopReason(ctx, stopReason);
  }

  function handleStopReason(ctx: ExtensionContext, stopReason: string): void {
    if (stopReason === "user_required") {
      notify(ctx, "! Autonomía en pausa: necesita tu intervención.", "warning");
      return;
    }

    if (stopReason === "completed") {
      emitDone(ctx);
      return;
    }

    const sentence = BLOCKED_SENTENCES[stopReason];
    if (sentence) {
      const { data, headline } = blockedSummary(sentence);
      publishSummary(ctx, data, headline);
      return;
    }

    // `user_stopped` is the user's own stop command, which already confirms it;
    // the continuation limit is a real fact worth stating once. Anything else
    // stays silent rather than narrating internal AIES steps.
    if (stopReason === "continuation_limit") notify(ctx, "Se alcanzó el límite de continuaciones automáticas.", "info");
  }

  /**
   * Emit the DONE card at most once per run. Both completion paths (the observed
   * ticket reaching Linear's completed state, and autonomy stopping with
   * `completed`) share this one latch, so a run appends exactly one summary.
   */
  function emitDone(ctx: ExtensionContext): void {
    if (doneEmitted) return;
    doneEmitted = true;
    const { data, headline } = doneSummary();
    publishSummary(ctx, data, headline);
  }

  /** Whether the observed ticket has reached Linear's completed state. */
  function ticketReachedCompletion(snapshot: AgentsSnapshot): boolean {
    const ticket = snapshot.ticket;
    if (!ticket?.active) return false;
    if (ticket.workState === "complete") return true;
    if (ticketStatusTypeComplete) return true;
    const status = typeof ticket.status === "string" ? ticket.status.trim().toLowerCase() : "";
    return status === "done" || status === "completed";
  }

  /**
   * Edge-triggered DONE emission, independent of the autonomy controller: the
   * moment the observed ticket reaches the completed state, with a single latch
   * so a long run of renders cannot append more than one card. Observing a
   * non-completed ticket clears the edge for the next completion.
   */
  function observeTicketCompletion(ctx: ExtensionContext): void {
    const complete = ticketReachedCompletion(uiSnapshot());
    if (!complete) {
      ticketWasComplete = false;
      return;
    }
    if (doneEmitted || ticketWasComplete) return;
    ticketWasComplete = true;
    emitDone(ctx);
  }

  function verificationText(): string | undefined {
    if (
      lastVerify
      && typeof lastVerify.criteriaPassed === "number"
      && typeof lastVerify.criteriaTotal === "number"
      && typeof lastVerify.checksPassed === "number"
    ) {
      return `PASS · ${lastVerify.criteriaPassed}/${lastVerify.criteriaTotal} criterios · ${lastVerify.checksPassed} checks`;
    }
    if (state.verification?.valid) return "PASS";
    return undefined;
  }

  function currentTicket(): string | undefined {
    const snapshot = toSnapshot(state);
    if (snapshot.ticket?.active && snapshot.ticket.identifier) return snapshot.ticket.identifier;
    return state.autonomy?.ticketId ?? undefined;
  }

  function doneSummary(): { data: DoneSummaryInput & { kind: "done" }; headline: string } {
    const snapshot = uiSnapshot();
    const ticket = currentTicket();
    const data: DoneSummaryInput & { kind: "done" } = {
      kind: "done",
      ticket,
      linear: snapshot.ticket?.status ?? "Done",
    };
    // The run's own start, never the session's: a session that opened long before
    // the ticket would otherwise report a meaningless duration.
    const runStart = runStartedAt(snapshot);
    if (runStart !== undefined) data.durationMs = Math.max(0, Date.now() - runStart);
    const verification = verificationText();
    if (verification) data.verification = verification;

    // One compact row per session child: role, outcome glyph and the child's own
    // already-bound result. Nothing here is re-narrated from the raw summary.
    const agentRows = (snapshot.agents ?? []).map((record) => ({
      role: capitalizeRole(record.role),
      glyph: statusGlyph(record.status),
      text: singleLineText(record.result),
    }));
    if (agentRows.length) data.agents = agentRows;

    // Run telemetry straight from `runUsage`; a zero run prints neither row.
    const run = snapshot.runUsage;
    if (run && run.total.totalTokens > 0) {
      data.tokens = { total: run.total.totalTokens, main: run.main.totalTokens, agents: run.agents.totalTokens };
    }
    if (run && run.total.cost !== null && (run.total.totalTokens > 0 || run.total.cost > 0)) {
      data.cost = run.total.cost;
    }

    const warnings = doneWarnings(snapshot);
    if (warnings.length) data.warnings = warnings;

    return { data, headline: ticket ? `✓ ${ticket} · completado` : "✓ Tarea completada" };
  }

  /** A genuine warning only: a failed child, a protocol fault or a Linear sync failure. */
  function doneWarnings(snapshot: AgentsSnapshot): string[] {
    const warnings: string[] = [];
    const records = snapshot.agents ?? [];
    const notCompleted = records.filter((record) => record.status === "failed" || record.status === "blocked").length;
    if (notCompleted === 1) warnings.push("1 agente no completó");
    else if (notCompleted > 1) warnings.push(`${notCompleted} agentes no completaron`);
    if (snapshot.verification?.status === "protocol_error") warnings.push("la verificación terminó con un error de protocolo");
    if (state.autonomy?.stopReason === "linear_sync_failed") warnings.push("Linear no sincronizó");
    return warnings;
  }

  function blockedVerification(): string | undefined {
    switch (state.verification?.status) {
      case "pass":
        return "V:PASS";
      case "fail":
        return "V:FAIL";
      case "blocked":
        return "V:BLOCKED";
      case "protocol_error":
        return "V:ERROR";
      default:
        return undefined;
    }
  }

  function blockedSummary(
    sentence: { happened: string; needs?: string; pending?: string },
  ): { data: BlockedSummaryInput & { kind: "blocked" }; headline: string } {
    const ticket = currentTicket();
    const data: BlockedSummaryInput & { kind: "blocked" } = {
      kind: "blocked",
      ticket,
      happened: sentence.happened,
    };
    if (sentence.needs) data.needs = sentence.needs;

    const activity = state.activity;
    if (activity && typeof activity.finishedAt === "number" && activity.outcome === "done") {
      const label = ROLE_DONE_LABEL[activity.role];
      if (label) data.done = [label];
    }

    if (sentence.pending) data.pending = sentence.pending;
    else if (state.verification && state.verification.attempts === 0) data.pending = "Verify pendiente";

    const verification = blockedVerification();
    if (verification) data.verification = verification;

    return { data, headline: ticket ? `! ${ticket} bloqueado` : "! Bloqueado" };
  }

  /** Keep the facts the summaries need; never a model, which the parent cannot observe. */
  function rememberActivity(role: string, facts: Record<string, unknown>): void {
    if (role === "verify") {
      lastVerify = {
        criteriaPassed: typeof facts.criteriaPassed === "number" ? facts.criteriaPassed : undefined,
        criteriaTotal: typeof facts.criteriaTotal === "number" ? facts.criteriaTotal : undefined,
        checksPassed: typeof facts.checksPassed === "number" ? facts.checksPassed : undefined,
      };
    }
  }

  /**
   * Register the single activity widget through the factory form, so its render
   * closure reads the live state (elapsed time and TTL stay current) instead of a
   * captured snapshot. Cleared when no activity is visible.
   */
  function syncActivity(ctx: ExtensionContext): void {
    const ui = uiOf(ctx);
    if (!ui || typeof ui.setWidget !== "function") return;

    const activity = state.activity;
    const wanted = activity ? isActivityVisible(activity, Date.now()) : false;

    if (wanted) {
      if (widgetRegistered) return;
      try {
        ui.setWidget(ACTIVITY_KEY, (tui: unknown, theme: unknown) => {
          widgetTui = tui as WidgetTui;
          return {
            render: (width: number): string[] => {
              const current = state.activity;
              if (!current) return [];
              const snapshot = uiSnapshot();
              return renderActivityCard(current, deriveStage(snapshot), Date.now(), {
                width,
                paint: themePaint(theme as ThemeLike | undefined),
                ticketTitle: snapshot.ticket?.active ? snapshot.ticket.title : undefined,
              });
            },
            invalidate() {},
          };
        });
        widgetRegistered = true;
      } catch {
        widgetRegistered = false;
        widgetTui = undefined;
      }
      return;
    }

    if (widgetRegistered) clearWidget(ui);
  }

  function clearWidget(ui: UiSurface): void {
    try {
      ui.setWidget?.(ACTIVITY_KEY, undefined);
    } catch {
      // Clearing a widget that cannot be cleared is not an error.
    }
    widgetRegistered = false;
    widgetTui = undefined;
  }

  function clearActivity(ctx: ExtensionContext): void {
    const ui = uiOf(ctx);
    if (widgetRegistered && ui) clearWidget(ui);
    widgetRegistered = false;
    widgetTui = undefined;
  }

  /**
   * The persistent status panel, below the editor. It appears only while the
   * terminal is wide enough for `renderStatusPanel` to produce lines, is cleared
   * the moment it would render empty or the session ends, and re-renders in place
   * from the live snapshot: no timer of its own.
   */
  function syncPanelWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    const ui = uiOf(ctx);
    if (!ui || typeof ui.setWidget !== "function") return;

    if (panelVisible) {
      if (panelWidgetRegistered) return;
      try {
        ui.setWidget(
          PANEL_KEY,
          (tui: unknown, theme: unknown) => {
            panelWidgetTui = tui as WidgetTui;
            // The one isolated private hook: it self-guards on the Pi version and
            // the host shape, and no-ops into the below-editor fallback otherwise.
            railHandle?.dispose();
            railHandle = installRightRail(tui, {
              version: VERSION,
              render: (width: number): string[] =>
                renderRightRail(uiSnapshot(), Date.now(), {
                  width,
                  project: ctx.cwd,
                  branch: branchReader?.() ?? null,
                  paint: themePaint(theme as ThemeLike | undefined),
                }),
            });
            return {
              render: (width: number): string[] => {
                // While the physical rail owns the status the dock yields; it stays
                // the responsive fallback wherever the rail is not showing. The
                // rail's own guard already proves it is showing at the outer wide
                // breakpoint, so the dock must not re-derive wideness from `width`:
                // Pi hands this widget its post-layout width, which the rail has
                // already reduced below the rail breakpoint, and re-testing it here
                // is exactly what let the rail and the dock render together.
                if (railHandle?.showing()) return [];
                return renderStatusPanel(uiSnapshot(), Date.now(), {
                  width,
                  paint: themePaint(theme as ThemeLike | undefined),
                });
              },
              invalidate() {},
            };
          },
          { placement: "belowEditor" },
        );
        panelWidgetRegistered = true;
      } catch {
        panelWidgetRegistered = false;
        panelWidgetTui = undefined;
      }
      return;
    }

    if (panelWidgetRegistered) clearPanelWidget(ui);
  }

  function clearPanelWidget(ui: UiSurface): void {
    try {
      ui.setWidget?.(PANEL_KEY, undefined);
    } catch {
      // Clearing a widget that cannot be cleared is not an error.
    }
    panelWidgetRegistered = false;
    panelWidgetTui = undefined;
  }

  function clearPanel(ctx: ExtensionContext): void {
    const ui = uiOf(ctx);
    if (panelWidgetRegistered && ui) clearPanelWidget(ui);
    panelWidgetRegistered = false;
    panelWidgetTui = undefined;
    // Shutdown disposes the private hook and restores the host layout exactly.
    railHandle?.dispose();
    railHandle = undefined;
    branchReader = undefined;
  }

  /** Ask Pi to repaint the shell and the widgets. Every surface is optional. */
  function requestRender(): void {
    if (typeof footerTui?.requestRender === "function") footerTui.requestRender();
    if (typeof headerTui?.requestRender === "function") headerTui.requestRender();
    if (widgetRegistered && typeof widgetTui?.requestRender === "function") widgetTui.requestRender();
    if (panelWidgetRegistered && typeof panelWidgetTui?.requestRender === "function") panelWidgetTui.requestRender();
  }

  /**
   * Install the full custom footer. The factory reads the live runtime state and
   * the Pi theme on every render, so colors always follow the host and no ANSI is
   * ever hand-built. Replaces the AIES `setStatus` segment entirely.
   */
  function installFooter(ctx: ExtensionContext): void {
    const ui = uiOf(ctx);
    if (!ui || typeof ui.setFooter !== "function") return;
    try {
      ui.setFooter((tui: unknown, theme: unknown, footerData: unknown) => {
        footerTui = tui as WidgetTui;
        // Pi's public footer data provider is the only source of the git branch.
        // A host without it simply leaves the rail's Rama row out.
        const data = footerData as { getGitBranch?: () => string | null } | undefined;
        if (data && typeof data.getGitBranch === "function") {
          branchReader = () => {
            try {
              return data.getGitBranch?.() ?? null;
            } catch {
              return null;
            }
          };
        }
        return {
          render: (width: number): string[] => [
            renderFooter(uiSnapshot(), Date.now(), {
              width,
              cwd: ctx.cwd,
              paint: themePaint(theme as ThemeLike | undefined),
              panelVisible,
            }),
          ],
          invalidate() {},
        };
      });
    } catch {
      footerTui = undefined;
    }
  }

  /**
   * Install the header band. The persistent panel widget owns the run status, so
   * while it is visible the ticket header stays silent; below `PANEL_MIN_WIDTH`
   * the responsive ticket header is the identity fallback. The two never render
   * the same fact at once.
   */
  function installHeader(ctx: ExtensionContext): void {
    const ui = uiOf(ctx);
    if (!ui || typeof ui.setHeader !== "function") return;
    try {
      ui.setHeader((tui: unknown, theme: unknown) => {
        headerTui = tui as WidgetTui;
        return {
          render: (width: number): string[] => {
            measurePanelVisibility();
            if (panelVisible) return [];
            const paint = themePaint(theme as ThemeLike | undefined);
            return renderHeader(toSnapshot(state), width, { paint });
          },
          invalidate() {},
        };
      });
    } catch {
      headerTui = undefined;
    }
  }

  /** Restore Pi's built-in footer and header. Called on session shutdown. */
  function clearShell(ctx: ExtensionContext): void {
    const ui = uiOf(ctx);
    try {
      ui?.setFooter?.(undefined);
    } catch {
      // Restoring a footer that cannot be restored is not an error.
    }
    try {
      ui?.setHeader?.(undefined);
    } catch {
      // Restoring a header that cannot be restored is not an error.
    }
    footerTui = undefined;
    headerTui = undefined;
  }

  /**
   * Keep exactly one interval, at 1s while a child runs and 5s otherwise, and
   * re-arm it only when the wanted period differs from the current one.
   */
  function armClock(ctx: ExtensionContext): void {
    const childActive = state.activity !== undefined && typeof state.activity.finishedAt !== "number";
    const wanted = childActive ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
    if (clock && clockPeriod === wanted) return;

    stopClock();
    clockPeriod = wanted;
    clock = setInterval(() => guard(() => tick(ctx)), wanted);
    clock.unref?.();
  }

  function stopClock(): void {
    if (!clock) return;
    clearInterval(clock);
    clock = undefined;
    clockPeriod = undefined;
  }

  function tick(ctx: ExtensionContext): void {
    render(ctx);
    if (widgetRegistered && typeof widgetTui?.requestRender === "function") {
      widgetTui.requestRender();
    }
    if (panelWidgetRegistered && typeof panelWidgetTui?.requestRender === "function") {
      panelWidgetTui.requestRender();
    }
  }

  /**
   * The panel string the memo compares. It is computed at a comfortably wide cell
   * count, so a content change repaints while a terminal-resize change is left to
   * Pi's own TUI diffing, exactly like the footer and header.
   */
  function panelMemo(snapshot: AgentsSnapshot, now: number): string {
    return renderStatusPanel(snapshot, now, { width: SHELL_MEMO_WIDTH }).join("\n");
  }

  /**
   * Sample the state and, in the interactive TUI only, repaint the shell and the
   * widgets and keep the single timer armed. The footer, the header and the
   * persistent panel are repainted only when their text actually changed, so the
   * shell never repaints itself between events.
   */
  function render(ctx: ExtensionContext): void {
    syncObservation(ctx);
    observeAutonomy(ctx);
    sampleRunUsage(ctx);
    observeTicketCompletion(ctx);

    if (ctx.mode !== "tui") return;

    measurePanelVisibility();
    const snapshot = uiSnapshot();
    const now = Date.now();
    const nextFooter = renderFooter(snapshot, now, { width: SHELL_MEMO_WIDTH, cwd: ctx.cwd, panelVisible });
    const nextHeader = renderHeader(toSnapshot(state), SHELL_MEMO_WIDTH).join("\n");
    const nextPanel = panelMemo(snapshot, now);
    if (nextFooter !== footer || nextHeader !== header || nextPanel !== panel) {
      footer = nextFooter;
      header = nextHeader;
      panel = nextPanel;
      requestRender();
    }

    syncActivity(ctx);
    syncPanelWidget(ctx);
    armClock(ctx);
  }

  /** Persist through Pi's own session entries: no database, no analytics file. */
  function persist(): void {
    const payload = toSnapshot(state);
    if (!worthPersisting(payload)) return;

    const serialized = JSON.stringify(payload);
    if (serialized === persisted) return;

    try {
      pi.appendEntry(ENTRY_TYPE, payload);
      persisted = serialized;
    } catch {
      // A session that cannot take entries simply keeps its metrics in memory.
    }
  }

  /**
   * Seed from the newest snapshot in the loaded session. A Pi session is
   * append-only and survives `/resume`, so cumulative counters keep their meaning
   * across a restart; without a snapshot the counters start from zero.
   */
  function restore(ctx: ExtensionContext, now: number): void {
    let entries;
    try {
      entries = ctx.sessionManager.getEntries();
    } catch {
      return;
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        state = applyResumedAt(fromSnapshot(entry.data, state.session.startedAt), now);
        break;
      }
    }

    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.type === "custom" && entry.customType === "aies-ticket" && entry.data) {
        const data = entry.data as Record<string, unknown>;
        const t = data.activeTicket as Record<string, unknown> | undefined;
        if (t) {
          state = applyTicketObservationSync(state, {
            active: true,
            identifier: typeof t.identifier === "string" ? t.identifier : undefined,
            title: typeof t.title === "string" ? t.title : undefined,
            status: typeof t.status === "string" ? t.status : undefined,
            workState: typeof data.workState === "string" ? (data.workState as any) : undefined,
            validVerify: data.workState === "complete",
          });
        }
        break;
      }
    }

    // A resumed session whose ticket already finished must not replay the DONE card.
    if (toSnapshot(state).ticket?.workState === "complete") {
      ticketWasComplete = true;
      doneEmitted = true;
    }
  }

  /** Two durable entry renderers: the finished child line and the workflow summary. */
  function registerEntryRenderers(): void {
    if (typeof (pi as { registerEntryRenderer?: unknown }).registerEntryRenderer !== "function") {
      summaryCardsRendered = false;
      return;
    }

    try {
      pi.registerEntryRenderer(AGENT_ENTRY_TYPE, (entry, _options, theme) => {
        const activity = activityOf(entry?.data);
        if (!activity) return undefined;

        // The durable line never leaks the raw child summary; the technical
        // handoff stays reachable through Pi's own expanded tool detail.
        const paint = themePaint(theme as unknown as ThemeLike | undefined);
        const lines = [renderActivityEntry(activity, { paint })];
        return { render: () => lines, invalidate() {} };
      });

      pi.registerEntryRenderer(SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
        const data = entryData(entry?.data);
        const paint = themePaint(theme as unknown as ThemeLike | undefined);
        const lines = data.kind === "blocked"
          ? renderBlockedSummary(data as unknown as BlockedSummaryInput, { paint })
          : renderDoneSummary(data as unknown as DoneSummaryInput, { paint });
        return { render: () => lines, invalidate() {} };
      });
      summaryCardsRendered = true;
    } catch {
      // A host without entry renderers simply keeps the entries invisible.
      summaryCardsRendered = false;
    }
  }

  guard(() => registerEntryRenderers());

  pi.on("session_start", async (event, ctx) => {
    guard(() => {
      const now = Date.now();
      footer = "";
      header = "";
      panel = "";
      footerTui = undefined;
      headerTui = undefined;
      persisted = "";
      autonomySignal = "";
      autonomyEnabled = false;
      autonomyStopReason = null;
      doneEmitted = false;
      ticketWasComplete = false;
      ticketStatusTypeComplete = false;
      lastVerify = undefined;

      // A session switch must not carry another session's cumulative Parent
      // usage: reset the incremental cache before the first sample.
      resetParentUsageCache();

      // The observatory registry is one session's run, owned by the agents
      // extension and delivered over the shared bus. Subscribe to the bus with
      // this context and start from an empty projection, so records never leak
      // across sessions and a missing publisher degrades to an empty registry.
      observatoryUnsubscribe?.();
      observatoryUnsubscribe = subscribeToAgentsBus(ctx);

      panelVisible = false;
      railHandle?.dispose();
      railHandle = undefined;
      branchReader = undefined;

      state = createState(now);
      state = applyAgents(state, []);
      state = applySessionMeta(state, {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
      state = applyModel(state, ctx.model);
      if (event.reason !== "new") restore(ctx, now);

      // Quiet rendering for the six generic Pi tools, with the real session cwd.
      // Idempotent per host: a reload or resume in the same directory registers
      // nothing new and leaks no instance. Its own guard keeps a partial host
      // from taking the footer, header or widgets down with it.
      guard(() => registerQuietTools(pi, ctx.cwd));

      if (ctx.mode === "tui") {
        installFooter(ctx);
        installHeader(ctx);
      }
      render(ctx);
    });
  });

  pi.on("tool_call", async (event, ctx) => {
    guard(() => {
      state = applyToolCall(
        state,
        { toolName: event.toolName, input: event.input as Record<string, unknown> | undefined },
        Date.now(),
        ctx.cwd,
      );

      if (PARENT_MUTATION_TOOLS.includes(event.toolName)) {
        state = applyParentMutation(state);
      }

      if (event.toolName === "aies_delegate") {
        const input = event.input as Record<string, unknown> | undefined;
        const role = typeof input?.role === "string" ? input.role : "explore";
        const task = typeof input?.task === "string" ? input.task : undefined;
        state = applyDelegationStart(state, role, Date.now(), task);
        if (role === "verify") state = applyVerificationStart(state);
      }
      render(ctx);
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    guard(() => {
      state = applyToolResult(state, { content: event.content, isError: event.isError }, Date.now());

      if (event.toolName === "aies_delegate") {
        const details = event.details as Record<string, unknown> | undefined;
        const role = state.activity?.role ?? state.delegations.activeRole ?? "explore";

        // The child's facts land on the activity record before it is finished.
        const facts = activityFacts(role, details);
        state = applyActivityFacts(state, facts);

        state = applyDelegationEnd(state, activityOutcome(role, details, event.isError === true), Date.now());

        // The delegation tool reports the verification facts; the observer records them.
        if (details?.verification) state = applyVerificationReport(state, details.verification);

        rememberActivity(role, facts);
        const activity = state.activity;
        if (activity) appendEntry(AGENT_ENTRY_TYPE, { activity: { ...activity } });
      }

      if (event.toolName === "aies_ticket") {
        const details = event.details as Record<string, unknown> | undefined;
        if (details?.ticket) {
          const t = details.ticket as Record<string, unknown>;
          ticketStatusTypeComplete = t.statusType === "completed";
          state = applyTicketObservationSync(state, {
            active: true,
            identifier: typeof t.identifier === "string" ? t.identifier : undefined,
            title: typeof t.title === "string" ? t.title : undefined,
            status: typeof t.status === "string" ? t.status : undefined,
            workState: typeof details.workState === "string" ? (details.workState as any) : undefined,
            validVerify: details.workState === "complete",
          });
        }
      }
      render(ctx);
    });
  });

  pi.on("turn_end", async (event, ctx) => {
    guard(() => {
      if (event.message.role === "assistant") {
        state = applyStopReason(state, event.message.stopReason, Date.now());
      }
      render(ctx);
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    guard(() => {
      if (state.delegations.activeRole) {
        state = applyDelegationEnd(state, "interrupted", Date.now());
      }
      render(ctx);
      persist();
    });
  });

  pi.on("session_compact", async (_event, ctx) => {
    guard(() => {
      state = applyCompaction(state, Date.now());
      render(ctx);
    });
  });

  pi.on("model_select", async (event, ctx) => {
    guard(() => {
      state = applyModel(state, event.model);
      render(ctx);
    });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    guard(persist);
    guard(() => clearActivity(ctx));
    guard(() => clearPanel(ctx));
    guard(() => clearShell(ctx));
    stopClock();
    observatoryUnsubscribe?.();
    observatoryUnsubscribe = undefined;
  });

  pi.registerCommand("aies-status", {
    description: "Muestra el estado de la sesión AIES (solo medición); `/aies-status detalle` imprime el reporte completo",
    handler: async (args, ctx) => {
      guard(() => {
        state = applyModel(state, ctx.model);
        syncObservation(ctx);
        sampleRunUsage(ctx);

        const snapshot = uiSnapshot();
        const now = Date.now();
        const trimmed = typeof args === "string" ? args.trim().toLowerCase() : "";
        const detailed = trimmed === "detalle" || trimmed === "all";
        const message = detailed
          ? renderStatusReport(snapshot, now)
          : renderStatusOverview(snapshot, now);

        notify(ctx, message, "info");
      });
    },
  });

  pi.registerCommand("agents", {
    description: "Muestra los agentes de la sesión y el detalle del agente seleccionado",
    handler: async (_args, ctx) => {
      try {
        state = applyModel(state, ctx.model);
        syncObservation(ctx);
        sampleRunUsage(ctx);

        const ui = uiOf(ctx);
        const custom = ui?.custom;

        // print/json/rpc and any host without a dialog channel get the same text
        // through notify, which is already a no-op where no channel exists.
        if (ctx.mode !== "tui" || typeof custom !== "function") {
          notify(ctx, renderAgentsView(state.agents, 0, Date.now()).join("\n"), "info");
          return;
        }

        let selected = 0;
        await custom((tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => {
          const keys = agentKeys(keybindings);
          return {
            render: (width: number): string[] =>
              renderAgentsView(state.agents, selected, Date.now(), {
                width,
                paint: themePaint(theme as ThemeLike | undefined),
              }),
            handleInput: (data: string): void => {
              if (keys.cancel(data)) {
                done(null);
                return;
              }
              const direction = keys.direction(data);
              if (!direction) return;
              selected = selectAgent(state.agents, selected, direction);
              if (typeof (tui as WidgetTui)?.requestRender === "function") (tui as WidgetTui).requestRender?.();
            },
            invalidate() {},
          };
        });
      } catch {
        // A UI failure degrades to silence and never reaches the conversation.
      }
    },
  });
}

/** Read an activity record back out of a durable entry, defensively. */
function activityOf(data: unknown): ActivityRecord | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const activity = (data as Record<string, unknown>).activity;
  if (!activity || typeof activity !== "object" || Array.isArray(activity)) return undefined;

  const candidate = activity as Record<string, unknown>;
  if (typeof candidate.role !== "string" || typeof candidate.startedAt !== "number") return undefined;
  return activity as ActivityRecord;
}

function entryData(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/** Collapse a value to one trimmed line, or an empty string. */
function singleLineText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

/** `Worker`: the role label the DONE row uses. */
function capitalizeRole(role: unknown): string {
  const text = singleLineText(role);
  if (!text) return "Agente";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The outcome glyph for a finished child: mirrors the observatory's own mapping. */
function statusGlyph(status: unknown): string {
  switch (status) {
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "blocked":
      return "!";
    default:
      return "◆";
  }
}

interface AgentKeys {
  direction(data: string): "up" | "down" | "left" | "right" | undefined;
  cancel(data: string): boolean;
}

/**
 * Bind the `/agents` keys to the injected keybinding manager when the host
 * provides one, with raw arrow/escape fallbacks so a partial host still works.
 */
function agentKeys(keybindings: unknown): AgentKeys {
  const manager = keybindings as KeybindingsLike | undefined;
  const matches = (data: string, binding: string): boolean => {
    if (manager && typeof manager.matches === "function") {
      try {
        if (manager.matches(data, binding) === true) return true;
      } catch {
        // An unusable manager falls back to the raw sequences below.
      }
    }
    return false;
  };

  return {
    direction: (data) => {
      if (matches(data, "tui.select.up") || data === "\x1b[A") return "up";
      if (matches(data, "tui.select.down") || data === "\x1b[B") return "down";
      if (matches(data, "tui.editor.cursorLeft") || data === "\x1b[D") return "left";
      if (matches(data, "tui.editor.cursorRight") || data === "\x1b[C") return "right";
      return undefined;
    },
    cancel: (data) => matches(data, "tui.select.cancel") || data === "\x1b" || data === "escape",
  };
}
