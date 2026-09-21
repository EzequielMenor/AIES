/**
 * Execution runner for isolated Explore child agents.
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context (no parent history/sentinel leakage).
 * - Read-only tool surface (read, grep, find, ls, scoped tgrep).
 * - Isolated from parent extensions (no metric pollution).
 * - Defensively parses and caps handoff output.
 */

import { parseExploreHandoff, type ExploreHandoff, type ExploreStatus } from "./handoff.ts";
import { resolveAgentThinkingLevel, resolveExploreModel } from "./model.ts";
import type { AiesThinkingLevel } from "../aies-models/capabilities.ts";
import type { AgentObservatory, AgentStatus } from "./observatory.ts";
import {
  beginChildObservation,
  executeChildSession,
  finishChildObservation,
  projectModelIdentity,
  resolveRoleSystemPrompt,
} from "./session.ts";
import { createTgrepToolDefinition, type TgrepRunner } from "./tgrep.ts";

/** The complete tool surface an Explore child may use. Read-only by design. */
export const EXPLORE_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "tgrep"];

export interface RunExploreOptions {
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
  /** Session-local presentation registry; the runner only opens and closes a record. */
  observatory?: AgentObservatory;
  /** Provider display label pre-resolved by the caller; the registry falls back to the id. */
  providerLabel?: string;
}

/** Map the Explore domain status onto the registry lifecycle. */
function toAgentStatus(status: ExploreStatus | undefined): AgentStatus {
  if (status === "failed") return "failed";
  if (status === "blocked") return "blocked";
  return "completed";
}

/** A compact, structured fact line: never a transcript and never the summary. */
function summarizeExploreHandoff(handoff: ExploreHandoff | undefined): string {
  const evidence = handoff?.evidence.length ?? 0;
  const issues = handoff?.issues.length ?? 0;
  const hallmark = evidence === 1 ? "hallazgo" : "hallazgos";
  const incident = issues === 1 ? "incidencia" : "incidencias";
  return `${evidence} ${hallmark} · ${issues} ${incident}`;
}

/**
 * Execute an isolated exploration task in a dedicated child AgentSession.
 */
export async function runExploreAgent(options: RunExploreOptions): Promise<ExploreHandoff> {
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

  const systemPrompt = resolveRoleSystemPrompt("explore", agentDir, options.systemPrompt);
  const model = options.model ?? (await resolveExploreModel(modelRuntime, parentModel, agentDir));
  const thinkingLevel = options.thinkingLevel ?? resolveAgentThinkingLevel("explore", model, agentDir);
  const identity = projectModelIdentity(model);

  const customTgrep = createTgrepToolDefinition(cwd, {
    runner: options.tgrepRunner,
  });

  let agentId: string | undefined;
  let handoff: ExploreHandoff | undefined;

  try {
    agentId = beginChildObservation(observatory, {
      role: "explore",
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
      tools: [...EXPLORE_TOOLS],
      customTools: [customTgrep],
      signal,
      sessionManager: options.sessionManager,
      observatory,
      agentId,
    });

    handoff = parseExploreHandoff(rawOutput);
  } catch (error: any) {
    handoff = {
      status: "failed",
      summary: `Explore session failed: ${error?.message ?? String(error)}`,
      evidence: [],
      issues: [error?.message ?? String(error)],
      next: ["Check child agent configuration or retry exploration."],
    };
  } finally {
    finishChildObservation(observatory, agentId, {
      status: toAgentStatus(handoff?.status),
      result: summarizeExploreHandoff(handoff),
      at: Date.now(),
    });
  }

  return handoff as ExploreHandoff;
}
