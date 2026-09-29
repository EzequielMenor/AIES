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

import { execFileSync } from "node:child_process";
import { Type, type Static } from "typebox";
import { getAgentDir, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { runExploreAgent } from "./explore.ts";
import {
  formatExploreHandoff,
  formatVerifyHandoff,
  formatWorkerHandoff,
  isProtocolError,
  normalizeCriteriaList,
  type ExploreHandoff,
  type VerifyHandoff,
  type WorkerHandoff,
} from "./handoff.ts";
import { observatory } from "./observatory.ts";
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
        "The agent role to delegate to: 'worker' to implement or fix a known target/files directly (Fast-Path, preferred when target is scoped), 'explore' ONLY to investigate unknown codebase architecture or search across >2 unknown files, 'verify' to prove independent of the implementer",
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
    Type.Union(
      [
        Type.Array(Type.String()),
        Type.String(),
      ],
      {
        description:
          "For 'verify': the verifiable acceptance criteria the work unit is judged against. Required for that role",
      },
    ),
  ),
  changedPaths: Type.Optional(
    Type.Array(Type.String(), {
      description: "For 'verify': the repository-relative paths the change touched, as facts",
    }),
  ),
  baseRef: Type.Optional(
    Type.String({
      description:
        "For 'verify': optional base commit or ref. Omit it: aies_delegate automatically resolves it from git HEAD when not supplied",
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

/**
 * Resolve the child provider display label once. It is presentation only: a
 * missing registry, a missing provider or a throwing registry degrades to no
 * label and never fails the delegation.
 */
export function resolveProviderDisplayLabel(
  modelRegistry: { getProviderDisplayName?: (provider: string) => string } | null | undefined,
  model: { provider?: unknown } | null | undefined,
): string | undefined {
  const provider = typeof model?.provider === "string" && model.provider ? model.provider : undefined;
  if (!provider) return undefined;
  try {
    const label = modelRegistry?.getProviderDisplayName?.(provider);
    return typeof label === "string" && label.trim() ? label.trim() : undefined;
  } catch {
    return undefined;
  }
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

  if (normalizeCriteriaList(params.criteria).length === 0) {
    return "aies_delegate role 'verify' requires 'criteria': the verifiable acceptance criteria the work unit is judged against.";
  }

  return undefined;
}

/**
 * Resolve the baseRef for verify: prefer explicit parameter if provided;
 * otherwise resolve git HEAD automatically so Parent never spends a tool roundtrip
 * running `git rev-parse HEAD`.
 */
export function resolveBaseRef(cwd: string, explicit?: string): string | undefined {
  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }
  try {
    const out = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Presentation only (AIES-010B). The delegation card and its durable entry are
 * the primary surface; these hooks keep the tool row quiet and expose the raw
 * handoff only on expansion. Execution, `content`, `details` and the schema are
 * untouched.
 */

/** Minimal structural `Component`: Pi renders whatever `render(width)` returns. */
interface ToolRowComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** A row that occupies no space, so Pi hides the tool line entirely. */
const EMPTY_ROW: ToolRowComponent = { render: () => [], invalidate() {} };

function textRow(text: string): ToolRowComponent {
  const lines = text.length > 0 ? text.split("\n") : [];
  return { render: () => lines, invalidate() {} };
}

/** The slice of Pi's theme this projection uses; colors always come from the host. */
interface RowTheme {
  fg(color: string, text: string): string;
}

/** The exact marker `execute` uses for a rejected verify request; presentation reads it, never rewrites it. */
const VERIFY_REQUEST_REJECTED = "Verify request rejected:";

/** Collapsed rows are AIES-owned copy: an arbitrary or raw `details.error` never reaches the user. */
const DELEGATE_ERROR_FALLBACK = "falló la operación";

const DELEGATE_ROLE_LABEL: Record<string, string> = {
  explore: "Explore",
  worker: "Worker",
  verify: "Verify",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function delegateRole(args: Record<string, unknown>): string {
  const role = nonEmptyString(args.role);
  if (!role) return "Agente";
  return DELEGATE_ROLE_LABEL[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

/** The complete text Pi handed back, unchanged. */
function resultText(result: { content?: ReadonlyArray<{ type?: string; text?: string }> }): string {
  const parts: string[] = [];
  for (const block of result?.content ?? []) {
    if (block && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** A short role line: identifies the child without repeating the task prompt. */
function delegateRunningRow(args: Record<string, unknown>, theme: RowTheme): string {
  return theme.fg("accent", `◆ ${delegateRole(args)} · trabajando…`);
}

/**
 * A concise visible failure. Derived from structured details first, so a raw
 * handoff never becomes the collapsed row; a rejected verify request is the one
 * prose marker the tool itself emits. An arbitrary `details.error` code degrades
 * to a safe Spanish phrase instead of leaking the internal identifier.
 */
function delegateFailureReason(result: { content?: ReadonlyArray<{ type?: string; text?: string }>; details?: unknown }, isError: boolean): string | undefined {
  const details = asRecord(result?.details);
  if (details) {
    // A Verify protocol fault is its own fact, never a domain status.
    if (details.kind === "protocol_error") return "error de protocolo de verificación";
    const status = nonEmptyString(details.status);
    if (status === "failed") return "falló";
    if (status === "blocked") return "bloqueado";
    if (nonEmptyString(details.error)) return DELEGATE_ERROR_FALLBACK;
  }
  if (isError === true) return "falló";
  if (resultText(result).startsWith(VERIFY_REQUEST_REJECTED)) return "solicitud de verificación rechazada";
  return undefined;
}

function delegateErrorRow(args: Record<string, unknown>, reason: string, theme: RowTheme): string {
  return theme.fg("error", `✗ ${delegateRole(args)} · ${reason}`);
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
      "Delegate directly to 'worker' (bypassing 'explore') when the work unit or target file/function is already known, localized or scoped (e.g. fixing a known function, test, or file). Do NOT call 'explore' for localized or already-identified targets.",
      "Use aies_delegate({ role: 'explore', ... }) ONLY when the relevant files, architecture or root cause are unknown and require broad discovery across >2 files.",
      "Use aies_delegate({ role: 'worker', ... }) to implement changes, edit files, and run tests. Worker reads the files it modifies, so prior Explore is unnecessary when the target is known.",
      "Use aies_delegate({ role: 'verify', task, criteria, changedPaths }) after a behaviour-bearing Worker change, before calling it complete. Pass facts only: never the Worker's summary, reasoning or transcript. Do NOT run bash commands like 'git rev-parse HEAD' to discover baseRef: aies_delegate automatically resolves baseRef if omitted.",
      "After a 'verify' result that is a protocol error, do NOT retry verification automatically or treat it as PASS/FAIL/BLOCKED: surface the protocol fault to the user and fix the Verify configuration or the completion call first.",
      "Do NOT implement substantial multi-file changes directly in the parent session.",
      "Do NOT mark a work unit verified yourself: only a valid 'verify' PASS supports that claim.",
    ],
    parameters: DelegateParamsSchema,
    renderShell: "self",
    renderCall(args, theme, context) {
      // The activity card owns the surface from the moment execution starts, so the
      // call chrome disappears then. Before that, one short role line is enough.
      if (context?.executionStarted === true) return EMPTY_ROW;
      return textRow(delegateRunningRow(args as Record<string, unknown>, theme as unknown as RowTheme));
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const args = (context?.args ?? {}) as Record<string, unknown>;
      const paint = theme as unknown as RowTheme;
      if (isPartial) return textRow(delegateRunningRow(args, paint));
      if (expanded) return textRow(resultText(result));

      const reason = delegateFailureReason(result, context?.isError === true);
      if (reason) return textRow(delegateErrorRow(args, reason, paint));
      return EMPTY_ROW;
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      const { role, task, context } = params;
      const agentDir = getAgentDir();
      const providerLabel = resolveProviderDisplayLabel(ctx.modelRegistry, ctx.model);

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
          modelRuntime: ctx.modelRegistry,
          parentModel: ctx.model,
          signal,
          observatory,
          providerLabel,
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
          modelRuntime: ctx.modelRegistry,
          parentModel: ctx.model,
          signal,
          observatory,
          providerLabel,
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
            content: [{ type: "text", text: `${VERIFY_REQUEST_REJECTED} ${invalid}` }],
            isError: true,
          };
        }

        const criteria = normalizeCriteriaList(params.criteria);
        const changedPaths = stringList(params.changedPaths);
        const startedAt = Date.now();

        const handoff = await runVerifyAgent({
          task,
          criteria,
          changedPaths,
          baseRef: resolveBaseRef(ctx.cwd, params.baseRef),
          checks: stringList(params.checks),
          cwd: ctx.cwd,
          agentDir,
          modelRuntime: ctx.modelRegistry,
          parentModel: ctx.model,
          signal,
          observatory,
          providerLabel,
        });

        const next = applyVerifyResult(applyVerifyStart(current, startedAt), handoff, Date.now());

        if (isProtocolError(handoff)) {
          return {
            content: [
              {
                type: "text",
                text: `⚠ Verificación: error de protocolo (${handoff.code}). No se marca PASS ni FAIL, no se repara y no se reintenta automáticamente: revisá la configuración del agente Verify o volvé a delegar la verificación.\n\n${commit(next)}`,
              },
            ],
            details: { ...handoff, verification: toVerificationReport(next) },
            isError: true,
          };
        }

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
