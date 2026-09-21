/**
 * Execution runner for isolated Worker child agents (AIES-004).
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context (no parent history/sentinel leakage).
 * - Focused implementation tool surface (read, grep, find, ls, tgrep, edit, write, guarded bash).
 * - Guarded against destructive commands (git clean, reset --hard, push, sudo).
 * - Isolated from parent extensions (no metric pollution).
 * - Defensively parses and caps handoff output.
 */

import {
  createContainedEditToolDefinition,
  createContainedWriteToolDefinition,
} from "./contained-tools.ts";
import { parseWorkerHandoff, type WorkerHandoff, type WorkerStatus } from "./handoff.ts";
import { resolveAgentThinkingLevel, resolveWorkerModel } from "./model.ts";
import type { AiesThinkingLevel } from "../aies-models/capabilities.ts";
import type { AgentObservatory, AgentStatus } from "./observatory.ts";
import type { SandboxConfigOptions } from "./sandbox.ts";
import {
  beginChildObservation,
  executeChildSession,
  finishChildObservation,
  projectModelIdentity,
  resolveRoleSystemPrompt,
} from "./session.ts";
import { createTgrepToolDefinition, type TgrepRunner } from "./tgrep.ts";
import { createWorkerBashToolDefinition, type WorkerBashRunner } from "./worker-guard.ts";

/** The complete tool surface a Worker child may use. */
export const WORKER_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "tgrep",
  "edit",
  "write",
  "bash",
];

export interface RunWorkerOptions {
  task: string;
  context?: string;
  cwd: string;
  agentDir: string;
  modelRuntime?: any;
  parentModel?: any;
  model?: any;
  /** Explicit thinking level override; otherwise the validated stored preference is used. */
  thinkingLevel?: AiesThinkingLevel;
  systemPrompt?: string;
  signal?: AbortSignal;
  sessionManager?: any;
  tgrepRunner?: TgrepRunner;
  bashRunner?: WorkerBashRunner;
  sandboxOptions?: SandboxConfigOptions;
  /** Session-local presentation registry; the runner only opens and closes a record. */
  observatory?: AgentObservatory;
  /** Provider display label pre-resolved by the caller; the registry falls back to the id. */
  providerLabel?: string;
}

/** Map the Worker domain status onto the registry lifecycle. */
function toAgentStatus(status: WorkerStatus | undefined): AgentStatus {
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  return "completed";
}

/** A compact, structured fact line: never a transcript and never the summary. */
function summarizeWorkerHandoff(handoff: WorkerHandoff | undefined): string {
  const changes = handoff?.changes.length ?? 0;
  const checks = handoff?.checks.length ?? 0;
  const changeText = changes === 1 ? "1 archivo modificado" : `${changes} archivos modificados`;
  const checkText = checks === 0 ? "sin checks" : checks === 1 ? "1 check" : `${checks} checks`;
  return `${changeText} · ${checkText}`;
}

/**
 * Execute an isolated implementation task in a dedicated child AgentSession.
 */
export async function runWorkerAgent(options: RunWorkerOptions): Promise<WorkerHandoff> {
  const {
    task,
    context,
    cwd,
    agentDir,
    modelRuntime,
    parentModel,
    signal,
    observatory,
  } = options;

  const systemPrompt = resolveRoleSystemPrompt("worker", agentDir, options.systemPrompt);
  const model = options.model ?? (await resolveWorkerModel(modelRuntime, parentModel, agentDir));
  const thinkingLevel = options.thinkingLevel ?? resolveAgentThinkingLevel("worker", model, agentDir);
  const identity = projectModelIdentity(model);

  const customTgrep = createTgrepToolDefinition(cwd, {
    runner: options.tgrepRunner,
  });

  const guardedBash = createWorkerBashToolDefinition(cwd, {
    runner: options.bashRunner,
    sandboxOptions: options.sandboxOptions,
  });

  const containedWrite = createContainedWriteToolDefinition(cwd);
  const containedEdit = createContainedEditToolDefinition(cwd);

  let agentId: string | undefined;
  let handoff: WorkerHandoff | undefined;

  try {
    agentId = beginChildObservation(observatory, {
      role: "worker",
      modelId: identity.modelId,
      modelLabel: identity.modelLabel,
      providerId: identity.providerId,
      providerLabel: options.providerLabel ?? null,
      at: Date.now(),
    });

    const rawOutput = await executeChildSession({
      task,
      context,
      cwd,
      agentDir,
      systemPrompt,
      model,
      modelRuntime,
      thinkingLevel,
      tools: [...WORKER_TOOLS],
      customTools: [customTgrep, guardedBash, containedWrite, containedEdit],
      signal,
      sessionManager: options.sessionManager,
      observatory,
      agentId,
    });

    handoff = parseWorkerHandoff(rawOutput);
  } catch (error: any) {
    handoff = {
      status: "failed",
      summary: `Worker session failed: ${error?.message ?? String(error)}`,
      changes: [],
      checks: [],
      issues: [error?.message ?? String(error)],
      next: ["Check child agent configuration or re-scope the work unit."],
    };
  } finally {
    finishChildObservation(observatory, agentId, {
      status: toAgentStatus(handoff?.status),
      result: summarizeWorkerHandoff(handoff),
      at: Date.now(),
    });
  }

  return handoff as WorkerHandoff;
}
