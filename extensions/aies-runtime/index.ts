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

import {
  applyActiveToolCount,
  applyActivityFacts,
  applyCompaction,
  applyContextUsage,
  applyDelegationEnd,
  applyDelegationStart,
  applyModel,
  applyParentMutation,
  applyContextGovernorSync,
  applyPermissionsSync,
  applyResumedAt,
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
  toSnapshot,
  type AiesState,
} from "./state.ts";
import { renderFooter, renderHeader } from "../aies-ui/footer.ts";
import { renderStatusReport } from "./status.ts";
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
import { getSandboxStatus } from "../aies-agents/sandbox.ts";
import { getPermissionTelemetry } from "../aies-agents/permissions.ts";
import { getContextGovernorTelemetry } from "../aies-agents/context-governor.ts";
import { getActiveContinuationController } from "../aies-agents/autonomy/controller.ts";

/** Custom entry type carrying the metrics snapshot across a resume. */
const ENTRY_TYPE = "aies-metrics";

/** One widget per active child, above the editor. */
const ACTIVITY_KEY = "aies-activity";

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
  theme?: unknown;
}

function arrayLength(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
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
  let persisted = "";
  let widgetTui: WidgetTui | undefined;
  let footerTui: WidgetTui | undefined;
  let headerTui: WidgetTui | undefined;
  let widgetRegistered = false;

  // Autonomy transitions are edges, not levels: a new signal is one transition.
  let autonomySignal = "";
  let autonomyEnabled = false;
  let autonomyStopReason: string | null = null;

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

    if (enabling) notify(ctx, `◆ AUTO · ${ticket ?? "sesión"}`, "info");
    if (newStop && stopReason) handleStopReason(ctx, stopReason);
  }

  function handleStopReason(ctx: ExtensionContext, stopReason: string): void {
    if (stopReason === "user_required") {
      notify(ctx, "! Autonomía en pausa: necesita tu intervención.", "warning");
      return;
    }

    if (stopReason === "completed") {
      const { data, headline } = doneSummary();
      appendEntry(SUMMARY_ENTRY_TYPE, data);
      notify(ctx, headline, "info");
      return;
    }

    const sentence = BLOCKED_SENTENCES[stopReason];
    if (sentence) {
      const { data, headline } = blockedSummary(sentence);
      appendEntry(SUMMARY_ENTRY_TYPE, data);
      notify(ctx, headline, "info");
      return;
    }

    // `user_stopped`, the continuation limit and anything unrecognised: notify only.
    if (stopReason === "user_stopped") notify(ctx, "Autonomía detenida.", "info");
    else if (stopReason === "continuation_limit") notify(ctx, "Se alcanzó el límite de continuaciones automáticas.", "info");
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
    const snapshot = toSnapshot(state);
    const ticket = currentTicket();
    const data: DoneSummaryInput & { kind: "done" } = {
      kind: "done",
      ticket,
      linear: snapshot.ticket?.status ?? "Done",
      durationMs: Math.max(0, Date.now() - snapshot.startedAt),
    };
    const verification = verificationText();
    if (verification) data.verification = verification;
    return { data, headline: ticket ? `✓ ${ticket} completado` : "✓ Tarea completada" };
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
              const snapshot = toSnapshot(state);
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

  /** Ask Pi to repaint the shell and the widget. Every surface is optional. */
  function requestRender(): void {
    if (typeof footerTui?.requestRender === "function") footerTui.requestRender();
    if (typeof headerTui?.requestRender === "function") headerTui.requestRender();
    if (widgetRegistered && typeof widgetTui?.requestRender === "function") widgetTui.requestRender();
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
      ui.setFooter((tui: unknown, theme: unknown) => {
        footerTui = tui as WidgetTui;
        return {
          render: (width: number): string[] => [
            renderFooter(toSnapshot(state), Date.now(), {
              width,
              cwd: ctx.cwd,
              paint: themePaint(theme as ThemeLike | undefined),
            }),
          ],
          invalidate() {},
        };
      });
    } catch {
      footerTui = undefined;
    }
  }

  /** Install the responsive active-ticket header. No ticket means no header lines. */
  function installHeader(ctx: ExtensionContext): void {
    const ui = uiOf(ctx);
    if (!ui || typeof ui.setHeader !== "function") return;
    try {
      ui.setHeader((tui: unknown, theme: unknown) => {
        headerTui = tui as WidgetTui;
        return {
          render: (width: number): string[] =>
            renderHeader(toSnapshot(state), width, { paint: themePaint(theme as ThemeLike | undefined) }),
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
  }

  /**
   * Sample the state and, in the interactive TUI only, repaint the shell and the
   * activity widget and keep the single timer armed. The footer and header are
   * repainted only when their text actually changed, so the shell never repaints
   * itself between events.
   */
  function render(ctx: ExtensionContext): void {
    syncObservation(ctx);
    observeAutonomy(ctx);

    if (ctx.mode !== "tui") return;

    const snapshot = toSnapshot(state);
    const now = Date.now();
    const nextFooter = renderFooter(snapshot, now, { width: SHELL_MEMO_WIDTH, cwd: ctx.cwd });
    const nextHeader = renderHeader(snapshot, SHELL_MEMO_WIDTH).join("\n");
    if (nextFooter !== footer || nextHeader !== header) {
      footer = nextFooter;
      header = nextHeader;
      requestRender();
    }

    syncActivity(ctx);
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
  }

  /** Two durable entry renderers: the finished child line and the workflow summary. */
  function registerEntryRenderers(): void {
    if (typeof (pi as { registerEntryRenderer?: unknown }).registerEntryRenderer !== "function") return;

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
    } catch {
      // A host without entry renderers simply keeps the entries invisible.
    }
  }

  guard(() => registerEntryRenderers());

  pi.on("session_start", async (event, ctx) => {
    guard(() => {
      const now = Date.now();
      footer = "";
      header = "";
      footerTui = undefined;
      headerTui = undefined;
      persisted = "";
      autonomySignal = "";
      autonomyEnabled = false;
      autonomyStopReason = null;
      lastVerify = undefined;

      state = createState(now);
      state = applySessionMeta(state, {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
      state = applyModel(state, ctx.model);
      if (event.reason !== "new") restore(ctx, now);

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
    guard(() => clearShell(ctx));
    stopClock();
  });

  pi.registerCommand("aies-status", {
    description: "Muestra el estado de la sesión AIES (solo medición); `/aies-status detalle` imprime el reporte completo",
    handler: async (args, ctx) => {
      guard(() => {
        state = applyModel(state, ctx.model);
        syncObservation(ctx);

        const snapshot = toSnapshot(state);
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
