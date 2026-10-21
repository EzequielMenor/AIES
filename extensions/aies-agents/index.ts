/**
 * AIES agents extension (AIES-004, AIES-005, AIES-007).
 *
 * Registers the `aies_delegate` tool, enforces parent routing guardrails,
 * governs parent context budgets and compaction, and owns the verification record:
 * a parent edit or write invalidates a PASS, and the delegate tool itself records
 * Worker runs and verification verdicts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDelegateTool, delegationRole } from "./delegate.ts";
import {
  applyRoutingDelegationEnd,
  applyRoutingDelegationStart,
  applyRoutingToolCall,
  checkRoutingGuardrail,
  createRoutingState,
  type RoutingState,
} from "./routing.ts";
import {
  applyWorkUnitChange,
  createVerificationState,
  isVerificationValid,
  type VerificationState,
} from "./verification.ts";
import {
  getContextGovernor,
  type ContextGovernor,
} from "./context-governor.ts";
import { TicketManager, linearDoneGateBypassReason } from "./linear/manager.ts";
import { holdBypassReason, isDirectLinearCompletion, planeWriteBypassReason } from "./linear/pending-action.ts";
import { trackerLabelForServer } from "./linear/labels.ts";
import { selectTracker } from "./linear/tracker.ts";
import { checkTicketRepo, repoGuardBlockReason } from "./repo-guard.ts";
import { describeWorkspaceNotice } from "./workspace-notice.ts";
import { createTicketTool, notifyFollowUp } from "./linear/tool.ts";
import { learningsAfterDone } from "../aies-memory/learn.ts";
import { registerTicketCommand } from "./linear/command.ts";
import type { TicketOperationResult, TicketSnapshot } from "./linear/types.ts";
import { AGENTS_CHANNEL, observatory, type ObservatorySnapshot } from "./observatory.ts";
import {
  applyMcpStatusEvent,
  createMcpIntegrationState,
  diagnoseMcpServer,
  MCP_STATUS_CHANNEL,
  type McpIntegrationState,
} from "./mcp/integration.ts";
import { currentMcpTrust, initMcpTrust } from "./mcp/trust.ts";
import {
  ContinuationController,
  getActiveContinuationController,
  registerAutonomyCommand,
  setActiveContinuationController,
  type AutonomySnapshot,
} from "./autonomy/index.ts";
import { resetPermissionTelemetry } from "./permissions.ts";

/** Native tools that change the work unit when the parent uses them directly. */
const PARENT_MUTATION_TOOLS = ["edit", "write"];

/**
 * Model-facing summary appended to a captured `mcp` tool result so the Parent sees
 * the resumed Linear outcome (the loaded contract, the next `remote_required`
 * directive to run, or a clear failure) without a second `aies_ticket` call.
 */
function describeCapturedOutcome(result: TicketOperationResult, tracker: string): string {
  const parts = [`AIES captured this \`mcp\` result automatically and resumed the pending ${tracker} operation.`];
  if (result.contract) parts.push(result.contract);
  if (result.message) parts.push(result.message);
  const instruction =
    result.details && typeof result.details.instruction === "string" ? result.details.instruction : undefined;
  if (instruction) parts.push(instruction);
  return parts.join("\n\n");
}

let activeTicketManager: TicketManager | undefined;

export function getActiveTicketManager(): TicketManager | undefined {
  return activeTicketManager;
}

let activeResetSessionState: (() => void) | undefined;

/**
 * Single, explicit reset boundary for a new AIES session (EZE-485).
 * Resets all session-ephemeral child observations, telemetry counters,
 * active ticket state, autonomy controller state, and routing/verification states.
 */
export function resetSessionState(): void {
  observatory.reset();
  resetPermissionTelemetry();
  getContextGovernor().reset();
  getActiveTicketManager()?.reset();
  getActiveContinuationController()?.reset();
  activeResetSessionState?.();
}

/** The minimal event surface the observatory bridge needs. */
export interface ObservatoryEventSink {
  emit?(channel: string, data: unknown): void;
}

/**
 * Re-publish every observatory mutation on the shared `pi.events` bus. Pi loads
 * each extension through its own module registry, so the registry singleton is
 * not shared with `aies-runtime`; the bus is the documented bridge. The registry
 * already emits exactly once per mutation, so this adds no per-keystroke noise,
 * and the guard keeps a missing bus or a throwing subscriber from ever breaking
 * a child run.
 */
export function publishObservatoryOn(events: ObservatoryEventSink | undefined): () => void {
  const publish = (snapshot: ObservatorySnapshot): void => {
    try {
      events?.emit?.(AGENTS_CHANNEL, snapshot);
    } catch {
      // A broken or absent event bus never breaks a child run.
    }
  };

  try {
    return observatory.subscribe(publish);
  } catch {
    return () => {};
  }
}

export { getActiveContinuationController };


/**
 * Session tool names, or undefined when the host cannot report them. It separates
 * "the MCP adapter is absent" from "the adapter has not reported a status snapshot
 * yet", because only the first one is a real failure.
 */
/**
 * The MCP server of the tracker this profile selects (D33). A refused selection
 * yields no server, so the probe keeps its Linear default and the refusal is reported
 * by the ticket operation itself.
 */
function activeTrackerServer(): string | undefined {
  const selection = selectTracker();
  return selection.ok ? selection.tracker.mcpServer : undefined;
}

function sessionToolNames(pi: ExtensionAPI): string[] | undefined {
  try {
    return pi.getAllTools().map((tool) => tool.name);
  } catch {
    return undefined;
  }
}

export default function aiesAgents(pi: ExtensionAPI): void {
  // D38: the MCP profile is judged once, at startup, before any tool call. The adapter does not reload
  // in place, so the verdict is the one the session can rely on (see `mcp/trust.ts`).
  initMcpTrust(process.env, process.argv);

  let routingState: RoutingState = createRoutingState();
  let verification: VerificationState = createVerificationState();
  const governor: ContextGovernor = getContextGovernor();

  // The MCP adapter publishes read-only status on a versioned channel. AIES reads
  // it so an unusable Linear transport fails with a real instruction, and resets
  // the sensor per session so a previous session's snapshot cannot decide this
  // one's diagnosis.
  let mcpState: McpIntegrationState = createMcpIntegrationState();
  pi.events.on(MCP_STATUS_CHANNEL, (payload: unknown) => {
    mcpState = applyMcpStatusEvent(mcpState, payload, Date.now());
  });

  function resetLocalAgentState(): void {
    routingState = createRoutingState();
    verification = createVerificationState();
    mcpState = createMcpIntegrationState();
  }
  activeResetSessionState = resetLocalAgentState;

  // The registry watches the children; this bridge lets the UI extension see it.
  // Subscribed once per extension instance and never per event: the registry
  // already emits exactly one snapshot per mutation.
  publishObservatoryOn(pi.events);

  const ticketManager = new TicketManager({
    getVerification: () => verification,
    getMcpDiagnostic: () =>
      diagnoseMcpServer(mcpState, { server: activeTrackerServer(), adapterToolNames: sessionToolNames(pi) }),
    // EZE-496: the Done Gate reads the working tree of the session, not only what this session reported.
    changeProbe: { cwd: () => process.cwd() },
    // D42 phase 3: runs only after the tracker accepted Done. The runtime decides whether anything is stored.
    afterDone: learningsAfterDone({ cwd: () => process.cwd() }),
  });
  activeTicketManager = ticketManager;

  const controller = new ContinuationController({
    pi,
    getRouting: () => routingState,
    getVerification: () => verification,
    getGovernor: () => governor,
    getTicketManager: () => ticketManager,
  });
  setActiveContinuationController(controller);

  pi.registerTool(createTicketTool(ticketManager));
  registerTicketCommand(pi, ticketManager);
  registerAutonomyCommand(pi, controller, ticketManager);

  pi.registerTool(
    createDelegateTool({
      verification: {
        get: () => verification,
        set: (next) => {
          verification = next;
          // EZE-496: a PASS is bound to the changes it verified, so a later change needs a new one.
          if (isVerificationValid(next)) ticketManager.recordVerifiedState();
        },
      },
    }),
  );

  pi.on("input", async (event) => {
    // EZE-503: this is the only place real user input arrives, and the held final
    // step is read from the user's own words ("no commit todavía", "quiero
    // revisarlo antes"). AIES' own hidden instructions are `source: "extension"`
    // and never speak for the user, so a continuation turn cannot set or lift a hold.
    if (event?.source === "extension") return;
    const text = typeof event?.text === "string" ? event.text : "";
    if (text) ticketManager.recordUserInput(text);
  });

  pi.on("tool_call", async (event, ctx) => {
    const input = event.input as Record<string, unknown> | undefined;

    // EZE-489: the ticket's repository and this session's repository must agree.
    // Fast path first: no active ticket or an explicit override means no git
    // resolution at all, so an ordinary session pays nothing for this guard.
    const activeTicket = ticketManager.getActiveTicket();
    if (activeTicket && process.env.AIES_ALLOW_REPO_MISMATCH !== "1") {
      const decision = checkTicketRepo(
        {
          identifier: activeTicket.identifier,
          project: activeTicket.project,
          projectIdentifier: activeTicket.projectIdentifier,
          tracker: activeTicket.tracker,
        },
        ctx.cwd,
      );
      if (decision.status === "mismatch") {
        const reason = repoGuardBlockReason(event.toolName, input, decision, decision.actualRoot);
        if (reason) return { block: true, reason };
      }
    }

    // EZE-503: a held final step also blocks the bypass used in the EZE-492
    // session, a direct `mcp save_issue` into a Done state. The verification record
    // and the open ticket are left exactly as they were.
    // D33 item 8: the hold also covers Plane, whose state is a UUID, so every guarded
    // tracker is checked; Linear is still matched against the active ticket only.
    // D38: the trust in the MCP profile for this call. An untrusted profile refuses every tool that
    // is not a Pi base tool or an AIES tool, so the checks below run only on a trusted profile.
    const mcpTrust = currentMcpTrust(process.env, process.argv);
    const pendingFinalAction = ticketManager.getPendingFinalAction();
    if (pendingFinalAction) {
      const held = holdBypassReason(event.toolName, input, activeTicket, pendingFinalAction, mcpTrust);
      if (held) return { block: true, reason: held };
    }

    // D33 phase 4, part C, reduced by D38: a Plane call must be on the closed list. A state
    // moves only through the directive aies_ticket has pending (and, for completion, only
    // while the Done Gate allows it). Every other Plane write, and every unknown action, is
    // refused in every session.
    const planeWrite = planeWriteBypassReason(event.toolName, input, {
      pending: ticketManager.getPendingDirective(),
      pendingAction: ticketManager.getPendingRemoteAction(),
      doneGate: () => ticketManager.evaluateDoneGate(),
      trust: mcpTrust,
    });
    if (planeWrite) return { block: true, reason: planeWrite };

    // EZE-496: a direct Linear Done (`save_issue` into a completed state) is refused unless the
    // same Done Gate that `aies_ticket complete` uses allows it. Nothing is sent when it is refused.
    if (activeTicket && isDirectLinearCompletion(event.toolName, input, activeTicket)) {
      const gate = ticketManager.evaluateDoneGate();
      if (!gate.allowed) return { block: true, reason: linearDoneGateBypassReason(activeTicket, gate.reason) };
    }

    // Check hard guardrails before tool execution (routing limits + context governor ceiling)
    const guard = checkRoutingGuardrail(
      routingState,
      {
        toolName: event.toolName,
        input,
      },
      governor,
    );

    if (guard.block) {
      return { block: true, reason: guard.reason };
    }

    if (event.toolName === "aies_delegate") {
      routingState = applyRoutingDelegationStart(routingState, delegationRole(input), Date.now());
      return;
    }

    // A direct parent edit to a behaviour-bearing path expires an old PASS.
    if (PARENT_MUTATION_TOOLS.includes(event.toolName)) {
      const path = typeof input?.path === "string" ? input.path : "unknown path";
      verification = applyWorkUnitChange(verification, [path], `parent ${event.toolName} on ${path}`);
      if (path !== "unknown path") {
        ticketManager.recordChangedPaths([path]);
      }
    }

    routingState = applyRoutingToolCall(
      routingState,
      { toolName: event.toolName, input },
      ctx.cwd,
    );
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "aies_delegate") {
      const input = event.input as Record<string, unknown> | undefined;
      const outcome = event.isError ? "failed" : "done";
      routingState = applyRoutingDelegationEnd(
        routingState,
        delegationRole(input),
        outcome,
        Date.now(),
      );

      // When Worker completes, record modified paths in active ticket manager
      if (delegationRole(input) === "worker" && !event.isError) {
        const details = event.details as Record<string, unknown> | undefined;
        if (Array.isArray(details?.changes)) {
          const files = (details.changes as Array<{ file?: string }>).map((c) => c.file).filter((f): f is string => Boolean(f));
          ticketManager.recordChangedPaths(files);
        }
      }
      return;
    }

    // Capture Linear errors if aies_ticket was called
    if (event.toolName === "aies_ticket") {
      const details = event.details as Record<string, unknown> | undefined;
      if (details?.error && typeof details.error === "string") {
        controller.setLinearError(details.error);
      } else if (!event.isError) {
        controller.setLinearError(undefined);
      }
    }

    // EZE-490: deterministically capture a `mcp` proxy result that satisfies the
    // pending Linear remote call and resume the operation here, so the Parent never
    // has to copy/serialize the payload back through `remote`. This runs BEFORE the
    // context-governor hygiene filter and only fires for a matching pending call.
    let capturedContent: undefined | (typeof event.content) = undefined;
    if (event.toolName === "mcp" && !event.isError) {
      const input = event.input as { server?: unknown; tool?: unknown; args?: unknown } | undefined;
      if (input && typeof input.tool === "string") {
        const resumed = await ticketManager.captureRemote(
          { server: input.server, tool: input.tool, args: input.args },
          event.content,
        );
        if (resumed) {
          notifyFollowUp(resumed, ctx);
          capturedContent = [...event.content, { type: "text", text: describeCapturedOutcome(resumed, trackerLabelForServer(input.server)) }];
        }
      }
    }

    // Feed current context usage to governor
    try {
      governor.updateUsage(ctx.getContextUsage());
    } catch {
      // Degrade silently if context is unavailable
    }

    // Apply tool output hygiene and oversized truncation (handoffs already bypassed)
    const filter = governor.processToolResult({
      toolName: event.toolName,
      content: capturedContent ?? event.content,
      isError: event.isError,
    });

    if (filter.modified || capturedContent) {
      return { content: filter.content };
    }
  });

  pi.on("turn_start", async () => {
    controller.notifyTurnStart();
  });

  pi.on("turn_end", async (_event, ctx) => {
    controller.notifyTurnEnd();
    try {
      governor.updateUsage(ctx.getContextUsage());
    } catch {}
  });

  pi.on("agent_settled", async (_event, ctx) => {
    try {
      governor.updateUsage(ctx.getContextUsage());
      if (governor.isCompactPending() || governor.isCompacting()) {
        await governor.handleSettled(ctx);
        governor.updateUsage(ctx.getContextUsage());
      }
    } catch {}

    // Persist active ticket snapshot to session entry
    const snapshot = ticketManager.toSnapshot();
    if (snapshot) {
      try {
        pi.appendEntry("aies-ticket", snapshot);
      } catch {}
    }

    // Persist autonomy snapshot to session entry
    const autonomySnap = controller.toSnapshot();
    if (autonomySnap) {
      try {
        pi.appendEntry("aies-autonomy", autonomySnap);
      } catch {}
    }

    // Evaluate and trigger bounded continuation
    try {
      await controller.handleSettled(ctx, {
        ticketManager,
        verification,
        routing: routingState,
        governor,
      });
    } catch {}
  });

  pi.on("session_compact", async () => {
    governor.onCompactionSuccess();
  });

  pi.on("session_compact_failed", async (event) => {
    governor.onCompactionFailure(event.errorMessage ?? "Compaction failed");
  });

  pi.on("session_start", async (event, ctx) => {
    // D40: one line about the tracker and the repository binding. Headless sessions stay
    // silent, and a failure here never blocks startup.
    if (event.reason === "startup" && ctx.hasUI) {
      try {
        const notice = describeWorkspaceNotice(typeof ctx.cwd === "string" ? ctx.cwd : process.cwd());
        ctx.ui.notify(notice.message, notice.level);
      } catch {}
    }
    if (event.reason === "new") {
      resetSessionState();
    } else if (event.reason === "resume" || event.reason === "reload") {
      routingState = createRoutingState();
      verification = createVerificationState();
      try {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type === "custom" && entry.customType === "aies-ticket" && entry.data) {
            // D33: a snapshot from another tracker is refused, and the refusal is shown.
            const restored = ticketManager.restoreFromSnapshot(entry.data as TicketSnapshot);
            if (!restored.ok) ctx.ui.notify(restored.message ?? "Ticket snapshot not restored.", "error");
            break;
          }
        }
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type === "custom" && entry.customType === "aies-autonomy" && entry.data) {
            controller.restoreFromSnapshot(entry.data as AutonomySnapshot);
            break;
          }
        }
      } catch {}
    } else {
      routingState = createRoutingState();
      verification = createVerificationState();
    }
  });
}

