/**
 * AIES runtime observer (AIES-002).
 *
 * Measures the parent session: context pressure, direct tool activity,
 * exploration, tool output volume, session runtime and tool surface. It is a
 * sensor, not an actuator: it never blocks a call, never rewrites a result,
 * never delegates, never compacts and never changes routing. Every handler
 * returns void, and every measurement sits behind a guard, so a broken observer
 * degrades into silence instead of changing how Pi behaves.
 *
 * State lives in `state.ts` and rendering in `status.ts`, both pure; this file is
 * the only place in AIES-002 that touches Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  applyActiveToolCount,
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
import { renderFooter, renderStatusReport } from "./status.ts";
import { getSandboxStatus } from "../aies-agents/sandbox.ts";
import { getPermissionTelemetry } from "../aies-agents/permissions.ts";
import { getContextGovernorTelemetry } from "../aies-agents/context-governor.ts";
import { getActiveContinuationController } from "../aies-agents/autonomy/controller.ts";

/** Custom entry type carrying the metrics snapshot across a resume. */
const ENTRY_TYPE = "aies-metrics";

/** Footer refresh period. Only the elapsed segment depends on it. */
const REFRESH_INTERVAL_MS = 5000;

/** Footer status key. `aies-identity.ts` defers to this extension for it. */
const STATUS_KEY = "aies";

/** Native tools that change the artifact a verification verdict referred to. */
const PARENT_MUTATION_TOOLS = ["edit", "write"];

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
  let footer = "";
  let persisted = "";

  /** Measurement must never surface as a Pi extension error. */
  function guard(action: () => void): void {
    try {
      action();
    } catch {
      // Observation is optional; Pi's behaviour is not.
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
   * Sample the state and, in the interactive TUI only, refresh the footer. The
   * line is pushed when its text actually changed, so it never repaints itself.
   */
  function render(ctx: ExtensionContext): void {
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

    if (ctx.mode !== "tui") return;

    const next = renderFooter(toSnapshot(state), Date.now());
    if (next === footer) return;
    footer = next;
    ctx.ui.setStatus(STATUS_KEY, next);
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

  function startClock(ctx: ExtensionContext): void {
    stopClock();
    if (ctx.mode !== "tui") return;
    clock = setInterval(() => guard(() => render(ctx)), REFRESH_INTERVAL_MS);
    clock.unref?.();
  }

  function stopClock(): void {
    if (!clock) return;
    clearInterval(clock);
    clock = undefined;
  }

  pi.on("session_start", async (event, ctx) => {
    guard(() => {
      const now = Date.now();
      footer = "";
      persisted = "";

      state = createState(now);
      state = applySessionMeta(state, {
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
      });
      state = applyModel(state, ctx.model);
      if (event.reason !== "new") restore(ctx, now);

      render(ctx);
      startClock(ctx);
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
        state = applyDelegationStart(state, role, Date.now());
        if (role === "verify") state = applyVerificationStart(state);
      }
      render(ctx);
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    guard(() => {
      state = applyToolResult(state, { content: event.content, isError: event.isError }, Date.now());
      if (event.toolName === "aies_delegate") {
        const outcome = event.isError ? "failed" : "done";
        state = applyDelegationEnd(state, outcome, Date.now());

        // The delegation tool reports the verification facts; the observer records them.
        const details = event.details as Record<string, unknown> | undefined;
        if (details?.verification) state = applyVerificationReport(state, details.verification);
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

  pi.on("session_shutdown", async (_event, _ctx) => {
    guard(persist);
    stopClock();
  });

  pi.registerCommand("aies-status", {
    description: "Show the AIES session metrics (measurement only)",
    handler: async (_args, ctx) => {
      guard(() => {
        state = applyModel(state, ctx.model);
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
        // Outside TUI and RPC there is no notification channel to report to.
        ctx.ui.notify(renderStatusReport(toSnapshot(state), Date.now()), "info");
      });
    },
  });
}
