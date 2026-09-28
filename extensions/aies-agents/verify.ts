/**
 * Execution runner for isolated Verify child agents (AIES-005, AIES-010B T4).
 *
 * Spawns an isolated Pi AgentSession:
 * - Fresh context: no parent history, no Worker transcript, no Worker reasoning.
 * - Factual input only, composed by `buildVerifyTaskInput` from the work unit and
 *   the acceptance criteria. There is no free-form context field to fill.
 * - Inspection-only tool surface (`read`, `grep`, `find`, `ls`, `tgrep`, and a
 *   guarded read-only `bash`); no `edit` and no `write` exist in the session.
 * - Isolated from parent extensions, so its checks never inflate parent metrics.
 * - The verdict is captured structurally through one schema-validated completion
 *   tool. Final prose is not authoritative: a missing, invalid or duplicated
 *   completion is a protocol error, never a domain `blocked`.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  createVerifyProtocolError,
  isProtocolError,
  validateVerifyCompletion,
  type VerifyRunResult,
  type VerifyVerdict,
} from "./handoff.ts";
import { resolveAgentThinkingLevel, resolveVerifyModel } from "./model.ts";
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
import { buildVerifyTaskInput } from "./verification.ts";
import { createVerifyBashToolDefinition, type VerifyBashRunner } from "./verify-guard.ts";

/** The complete built-in tool surface a Verify child may use. There is no mutation tool. */
export const VERIFY_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "tgrep", "bash"];

/** The single completion primitive the isolated Verify child calls exactly once. */
export const VERIFY_COMPLETE_TOOL = "aies_verify_complete";

/** Shape of the structured verdict the completion tool accepts. */
export const VerifyCompleteSchema = Type.Object({
  status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")], {
    description: "The verdict: pass, fail or blocked",
  }),
  summary: Type.String({
    description: "2-4 sentences: what was inspected and what the real repository state is",
  }),
  criteria: Type.Array(
    Type.Object({
      criterion: Type.String({ description: "The acceptance criterion, restated" }),
      status: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("blocked")]),
      evidence: Type.Optional(
        Type.String({ description: "File, line or symbol plus the observed value" }),
      ),
    }),
    { description: "One entry per acceptance criterion, each with its own evidence" },
  ),
  checks: Type.Array(
    Type.Object({
      check: Type.String({ description: "Command executed" }),
      result: Type.Optional(Type.String({ description: "Exit status and the relevant output" })),
    }),
  ),
  defects: Type.Array(
    Type.Object({
      severity: Type.Union([Type.Literal("blocking"), Type.Literal("non_blocking")]),
      file: Type.Optional(Type.String()),
      description: Type.String({ description: "What is wrong, concretely" }),
      evidence: Type.Optional(Type.String({ description: "How to reproduce it" })),
    }),
  ),
  next: Type.Array(Type.String(), { description: "At most one recommended next step" }),
});

export type VerifyCompleteParams = {
  status: "pass" | "fail" | "blocked";
  summary: string;
  criteria: Array<{ criterion: string; status: "pass" | "fail" | "blocked"; evidence?: string }>;
  checks: Array<{ check: string; result?: string }>;
  defects: Array<{
    severity: "blocking" | "non_blocking";
    file?: string;
    description: string;
    evidence?: string;
  }>;
  next: string[];
};

/**
 * Mutable state shared between the completion tool and the runner. The first
 * valid call wins; any later valid call marks the run as a duplicate.
 */
export interface VerifyCompletionCollector {
  attempted: boolean;
  verdict: VerifyVerdict | undefined;
  duplicate: boolean;
  lastInvalidReason: string | undefined;
}

/** A fresh collector for one Verify run. */
export function createVerifyCompletionCollector(): VerifyCompletionCollector {
  return { attempted: false, verdict: undefined, duplicate: false, lastInvalidReason: undefined };
}

/**
 * The schema-validated completion tool. It validates shape and semantics
 * host-side: an invalid attempt is rejected so the child may correct it once in
 * the same turn; a duplicate valid verdict fails closed.
 */
export function createVerifyCompleteTool(params: {
  criteria: string[];
  collector: VerifyCompletionCollector;
}): ToolDefinition<typeof VerifyCompleteSchema, unknown> {
  const { criteria, collector } = params;

  return {
    name: VERIFY_COMPLETE_TOOL,
    label: "AIES Verify Complete",
    description:
      "Report the structured verification verdict. Call this exactly once, after inspecting the artifact and running the checks. The parent reads the verdict from here; your final prose is not authoritative and may be empty.",
    promptSnippet: `${VERIFY_COMPLETE_TOOL}: Report the structured verification verdict (pass | fail | blocked) with per-criterion evidence.`,
    promptGuidelines: [
      `Call ${VERIFY_COMPLETE_TOOL} exactly once, at the end of your inspection, with the structured verdict.`,
      "Copy each supplied acceptance criterion into `criteria` exactly as given; do not paraphrase, merge or split them.",
      "Give non-empty evidence for every supplied criterion. A PASS must represent and pass every acceptance criterion, each with its own evidence; never claim PASS from prose alone.",
      "If a call is rejected, correct the completion and call it again in the same turn.",
    ],
    parameters: VerifyCompleteSchema,
    async execute(_toolCallId, input: VerifyCompleteParams) {
      const validation = validateVerifyCompletion(input, criteria);
      collector.attempted = true;

      if (!validation.ok) {
        collector.lastInvalidReason = validation.reason;
        return {
          content: [
            {
              type: "text",
              text: `Completion rejected: ${validation.reason}. Correct it and call ${VERIFY_COMPLETE_TOOL} again with a valid verdict.`,
            },
          ],
          details: { accepted: false, reason: validation.reason },
          isError: true,
        };
      }

      if (collector.verdict) {
        collector.duplicate = true;
        return {
          content: [
            {
              type: "text",
              text: "A completion was already recorded for this run. A second verdict is not accepted; stop now.",
            },
          ],
          details: { accepted: false, reason: "duplicate_completion" },
          isError: true,
        };
      }

      collector.verdict = { kind: "verdict", ...validation.handoff! };
      return {
        content: [{ type: "text", text: "Verdict recorded. Stop now; the parent reads it from here." }],
        details: { accepted: true },
      };
    },
  };
}

/** Resolve the collector into a discriminated run result. */
function resolveVerifyResult(collector: VerifyCompletionCollector): VerifyRunResult {
  if (collector.duplicate) {
    return createVerifyProtocolError(
      "duplicate_completion",
      "the verify child reported more than one valid verdict",
    );
  }
  if (collector.verdict) return collector.verdict;
  if (collector.attempted) {
    return createVerifyProtocolError(
      "invalid_completion",
      collector.lastInvalidReason ?? "the verify child produced an invalid completion",
    );
  }
  // The completion tool is the sole runtime authority. Final assistant prose is
  // never a verdict, even when it contains a perfectly valid handoff: a child
  // that never called the tool has not reported a result.
  return createVerifyProtocolError(
    "missing_completion",
    "the verify child never called the completion tool",
  );
}

export interface RunVerifyOptions {
  /** The work unit being verified, as a fact. */
  task: string;
  /** Verifiable acceptance criteria. The verdict is judged against these. */
  criteria: string[];
  changedPaths?: string[];
  baseRef?: string;
  checks?: string[];
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
  bashRunner?: VerifyBashRunner;
  sandboxOptions?: SandboxConfigOptions;
  /** Session-local presentation registry; the runner only opens and closes a record. */
  observatory?: AgentObservatory;
  /** Provider display label pre-resolved by the caller; the registry falls back to the id. */
  providerLabel?: string;
}

/** A protocol error is never a domain verdict: it is a failed observation. */
function verifyAgentStatus(result: VerifyRunResult): AgentStatus {
  if (isProtocolError(result)) return "failed";
  if (result.status === "pass") return "completed";
  if (result.status === "fail") return "failed";
  return "blocked";
}

/** A compact, structured fact line: never a transcript and never the summary. */
function summarizeVerifyResult(result: VerifyRunResult): string {
  if (isProtocolError(result)) return "error de protocolo";
  const total = result.criteria.length;
  const passed = result.criteria.filter((entry) => entry.status === "pass").length;
  return `${passed}/${total} criterios`;
}

/**
 * Execute an independent verification run in a dedicated child AgentSession.
 */
export async function runVerifyAgent(options: RunVerifyOptions): Promise<VerifyRunResult> {
  const { task, criteria, cwd, agentDir, modelRuntime, parentModel, signal, observatory } = options;

  const systemPrompt = resolveRoleSystemPrompt("verify", agentDir, options.systemPrompt);

  // The child prompt is the structured verification input, nothing else.
  const verifyInput = buildVerifyTaskInput({
    task,
    criteria,
    changedPaths: options.changedPaths,
    baseRef: options.baseRef,
    checks: options.checks,
  });

  const customTgrep = createTgrepToolDefinition(cwd, { runner: options.tgrepRunner });
  const guardedBash = createVerifyBashToolDefinition(cwd, {
    runner: options.bashRunner,
    sandboxOptions: options.sandboxOptions,
  });

  const collector = createVerifyCompletionCollector();
  const completeTool = createVerifyCompleteTool({ criteria, collector });

  let agentId: string | undefined;
  let result: VerifyRunResult = createVerifyProtocolError(
    "session_failure",
    "verification did not run",
  );

  try {
    // Resolution lives inside the guarded path: an explicitly configured model
    // that cannot resolve must surface as an explicit protocol fault, never as a
    // verdict and never as a silent parent-model fallback (EZE-454).
    const model = options.model ?? (await resolveVerifyModel(modelRuntime, parentModel, agentDir));
    const thinkingLevel = options.thinkingLevel ?? resolveAgentThinkingLevel("verify", model, agentDir);
    const identity = projectModelIdentity(model);

    agentId = beginChildObservation(observatory, {
      role: "verify",
      modelId: identity.modelId,
      modelLabel: identity.modelLabel,
      providerId: identity.providerId,
      providerLabel: options.providerLabel ?? null,
      at: Date.now(),
    });

    await executeChildSession({
      task: verifyInput,
      cwd,
      agentDir,
      systemPrompt,
      model,
      modelRuntime,
      thinkingLevel,
      tools: [...VERIFY_TOOLS, VERIFY_COMPLETE_TOOL],
      customTools: [customTgrep, guardedBash, completeTool],
      signal,
      sessionManager: options.sessionManager,
      observatory,
      agentId,
    });

    result = resolveVerifyResult(collector);
  } catch (error: any) {
    // A captured verdict survives a failing continuation: the completion, not the
    // prose or the stream, is the authority.
    if (collector.duplicate) {
      result = createVerifyProtocolError(
        "duplicate_completion",
        "the verify child reported more than one valid verdict",
      );
    } else if (collector.verdict) {
      result = collector.verdict;
    } else {
      result = createVerifyProtocolError(
        "session_failure",
        `Verify session failed: ${error?.message ?? String(error)}`,
      );
    }
  } finally {
    finishChildObservation(observatory, agentId, {
      status: verifyAgentStatus(result),
      result: summarizeVerifyResult(result),
      paths: options.changedPaths ?? [],
      at: Date.now(),
    });
  }

  return result;
}
