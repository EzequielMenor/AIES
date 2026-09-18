/**
 * Delegation tool (aies_delegate) for AIES (AIES-004, AIES-005).
 *
 * Exposes a single tool for parent sessions to launch isolated child agents:
 * - "explore": isolated read-only investigation with scoped search tools.
 * - "worker": isolated implementation with workspace editing and guarded bash.
 * - "verify": isolated independent verification, inspection only. It never
 *   receives a Worker transcript: its input is the work unit, the acceptance
 *   criteria and the facts needed to reproduce the checks, and passing free-form
 *   `context` to this role is rejected.
 */

import { Type, type Static } from "typebox";
import { getAgentDir, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { runExploreAgent } from "./explore.ts";
import {
  formatExploreHandoff,
  formatVerifyHandoff,
  formatWorkerHandoff,
  type ExploreHandoff,
  type VerifyHandoff,
  type WorkerHandoff,
} from "./handoff.ts";
import type { DelegationRole } from "./routing.ts";
import {
  applyVerifyResult,
  applyVerifyStart,
  applyWorkerRepairStart,
  applyWorkerResult,
  createVerificationState,
  formatVerificationNote,
  toVerificationReport,
  type VerificationState,
} from "./verification.ts";
import { runVerifyAgent } from "./verify.ts";
import { runWorkerAgent } from "./worker.ts";

export const DelegateParamsSchema = Type.Object({
  role: Type.Union(
    [Type.Literal("explore"), Type.Literal("worker"), Type.Literal("verify")],
    {
      description:
        "The agent role to delegate to: 'explore' to investigate, 'worker' to implement, 'verify' to prove independent of the implementer",
    },
  ),
  task: Type.String({
    description: "The specific investigation task, implementation work unit, or verification work unit",
  }),
  context: Type.Optional(
    Type.String({
      description:
        "Optional background context, acceptance criteria, or findings from Explore. Not accepted for 'verify', which takes factual fields only",
    }),
  ),
  criteria: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "For 'verify': the verifiable acceptance criteria the work unit is judged against. Required for that role",
    }),
  ),
  changedPaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "For 'verify': the repository-relative paths the change touched, as facts",
    }),
  ),
  baseRef: Type.Optional(
    Type.String({
      description: "For 'verify': the base commit or ref the change is compared against",
    }),
  ),
  checks: Type.Optional(
    Type.Array(Type.String(), {
      description: "For 'verify': checks worth running to reproduce the expected behaviour",
    }),
  ),
});

export type DelegateParams = Static<typeof DelegateParamsSchema>;
export type DelegateHandoff = ExploreHandoff | WorkerHandoff | VerifyHandoff;

/** Owner of the verification record, held by the extension that registers the tool. */
export interface VerificationStore {
  get(): VerificationState;
  set(next: VerificationState): void;
}

export interface CreateDelegateToolOptions {
  verification?: VerificationStore;
}

/** The delegated role, defaulting to 'explore' for an unrecognised input. */
export function delegationRole(input: Record<string, unknown> | undefined): DelegationRole {
  const role = input?.role;
  if (role === "worker" || role === "verify") return role;
  return "explore";
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) out.push(entry.trim());
  }
  return out;
}

/** The verify role takes facts, never a free-form narrative from another agent. */
function verifyRequestError(params: DelegateParams): string | undefined {
  if (typeof params.context === "string" && params.context.trim()) {
    return "aies_delegate role 'verify' does not accept free-form context: pass criteria, changedPaths, baseRef and checks instead. Independent verification must not receive the implementer's narrative.";
  }

  if (stringList(params.criteria).length === 0) {
    return "aies_delegate role 'verify' requires 'criteria': the verifiable acceptance criteria the work unit is judged against.";
  }

  return undefined;
}

export function createDelegateTool(
  options?: CreateDelegateToolOptions,
): ToolDefinition<typeof DelegateParamsSchema, DelegateHandoff> {
  const store = options?.verification;

  return {
    name: "aies_delegate",
    label: "AIES Delegate",
    description:
      "Delegate a task to an isolated child agent without polluting parent context. Use 'explore' for investigation, 'worker' for implementation and tests, and 'verify' to check the real repository state against acceptance criteria.",
    promptSnippet:
      "aies_delegate: Delegate an exploration ('explore'), implementation ('worker') or independent verification ('verify') task to an isolated child agent.",
    promptGuidelines: [
      "Use aies_delegate({ role: 'explore', ... }) when investigating the codebase or checking >2 files.",
      "Use aies_delegate({ role: 'worker', ... }) when implementing concrete changes, editing files, or running tests.",
      "Use aies_delegate({ role: 'verify', task, criteria, changedPaths }) after a behaviour-bearing Worker change, before calling it complete. Pass facts only: never the Worker's summary, reasoning or transcript.",
      "Do NOT implement substantial multi-file changes directly in the parent session.",
      "Do NOT mark a work unit verified yourself: only a valid 'verify' PASS supports that claim.",
    ],
    parameters: DelegateParamsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const { role, task, context } = params;
      const agentDir = getAgentDir();

      const current = store ? store.get() : createVerificationState();
      const commit = (next: VerificationState) => {
        if (store) store.set(next);
        return formatVerificationNote(toVerificationReport(next));
      };

      if (role === "explore") {
        const handoff = await runExploreAgent({
          task,
          context,
          cwd: ctx.cwd,
          agentDir,
          parentModel: ctx.model,
          signal,
        });

        return {
          content: [{ type: "text", text: formatExploreHandoff(handoff) }],
          details: handoff,
        };
      }

      if (role === "worker") {
        // A Worker started while a FAIL is pending is a repair cycle.
        const started = applyWorkerRepairStart(current);

        const handoff = await runWorkerAgent({
          task,
          context,
          cwd: ctx.cwd,
          agentDir,
          parentModel: ctx.model,
          signal,
        });

        const next = applyWorkerResult(
          started,
          handoff.changes.map((change) => change.file),
        );

        return {
          content: [
            {
              type: "text",
              text: `${formatWorkerHandoff(handoff)}\n\n${commit(next)}`,
            },
          ],
          details: { ...handoff, verification: toVerificationReport(next) },
        };
      }

      if (role === "verify") {
        const invalid = verifyRequestError(params);
        if (invalid) {
          return {
            content: [{ type: "text", text: `Verify request rejected: ${invalid}` }],
            isError: true,
          };
        }

        const criteria = stringList(params.criteria);
        const changedPaths = stringList(params.changedPaths);
        const startedAt = Date.now();

        const handoff = await runVerifyAgent({
          task,
          criteria,
          changedPaths,
          baseRef: typeof params.baseRef === "string" ? params.baseRef.trim() : undefined,
          checks: stringList(params.checks),
          cwd: ctx.cwd,
          agentDir,
          parentModel: ctx.model,
          signal,
        });

        const next = applyVerifyResult(applyVerifyStart(current, startedAt), handoff, Date.now());

        return {
          content: [
            {
              type: "text",
              text: `${formatVerifyHandoff(handoff)}\n\n${commit(next)}`,
            },
          ],
          details: { ...handoff, verification: toVerificationReport(next) },
        };
      }

      throw new Error(
        `Unsupported delegation role: "${role}". Only "explore", "worker" and "verify" are supported.`,
      );
    },
  };
}
