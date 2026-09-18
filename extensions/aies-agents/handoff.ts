/**
 * Structured handoff parser and formatter for Explore and Worker child agents.
 *
 * Ensures child findings and changes are parsed into deterministic schemas
 * and formatted compactly for the parent session, capped defensively under 6,000 characters.
 */

export type ExploreStatus = "done" | "blocked" | "failed";

export interface ExploreEvidence {
  file: string;
  lines?: string;
  note?: string;
}

export interface ExploreHandoff {
  status: ExploreStatus;
  summary: string;
  evidence: ExploreEvidence[];
  issues: string[];
  next: string[];
}

export type WorkerStatus = "done" | "blocked" | "failed";

export interface WorkerChange {
  file: string;
  description?: string;
}

export interface WorkerCheck {
  check: string;
  result?: string;
}

export interface WorkerHandoff {
  status: WorkerStatus;
  summary: string;
  changes: WorkerChange[];
  checks: WorkerCheck[];
  issues: string[];
  next: string[];
}

/** What independent verification concluded about the real repository state. */
export type VerifyStatus = "pass" | "fail" | "blocked";

export interface VerifyCriterion {
  criterion: string;
  status: VerifyStatus;
  evidence?: string;
}

export interface VerifyCheck {
  check: string;
  result?: string;
}

export interface VerifyDefect {
  severity: "blocking" | "non_blocking";
  file?: string;
  description: string;
  evidence?: string;
}

/**
 * Verify's structured verdict. Facts only: no transcript, no reasoning, no diff
 * and no whole files. The parent owns the "this work unit is verified" claim;
 * Verify only reports what it observed.
 */
export interface VerifyHandoff {
  status: VerifyStatus;
  summary: string;
  criteria: VerifyCriterion[];
  checks: VerifyCheck[];
  defects: VerifyDefect[];
  next: string[];
}

/** Maximum length of the formatted handoff returned to parent context. */
export const MAX_HANDOFF_CHARS = 6000;

function sanitizeStatus<T extends string>(val: unknown, fallback: T): T {
  if (val === "done" || val === "blocked" || val === "failed") return val as unknown as T;
  return fallback;
}

function sanitizeEvidence(val: unknown): ExploreEvidence[] {
  if (!Array.isArray(val)) return [];
  const list: ExploreEvidence[] = [];
  for (const item of val) {
    if (item && typeof item === "object") {
      const entry = item as Record<string, unknown>;
      if (typeof entry.file === "string" && entry.file.trim()) {
        list.push({
          file: entry.file.trim(),
          lines: typeof entry.lines === "string" && entry.lines.trim() ? entry.lines.trim() : undefined,
          note: typeof entry.note === "string" && entry.note.trim() ? entry.note.trim() : undefined,
        });
      }
    }
  }
  return list;
}

function sanitizeChanges(val: unknown): WorkerChange[] {
  if (!Array.isArray(val)) return [];
  const list: WorkerChange[] = [];
  for (const item of val) {
    if (item && typeof item === "object") {
      const entry = item as Record<string, unknown>;
      if (typeof entry.file === "string" && entry.file.trim()) {
        list.push({
          file: entry.file.trim(),
          description:
            typeof entry.description === "string" && entry.description.trim()
              ? entry.description.trim()
              : undefined,
        });
      }
    }
  }
  return list;
}

function sanitizeChecks(val: unknown): WorkerCheck[] {
  if (!Array.isArray(val)) return [];
  const list: WorkerCheck[] = [];
  for (const item of val) {
    if (item && typeof item === "object") {
      const entry = item as Record<string, unknown>;
      if (typeof entry.check === "string" && entry.check.trim()) {
        list.push({
          check: entry.check.trim(),
          result: typeof entry.result === "string" && entry.result.trim() ? entry.result.trim() : undefined,
        });
      }
    }
  }
  return list;
}

function sanitizeStringList(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  const out: string[] = [];
  for (const item of val) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
    }
  }
  return out;
}

function sanitizeExploreHandoff(parsed: Record<string, unknown>): ExploreHandoff {
  return {
    status: sanitizeStatus<ExploreStatus>(parsed.status, "done"),
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Exploration completed without an explicit summary.",
    evidence: sanitizeEvidence(parsed.evidence),
    issues: sanitizeStringList(parsed.issues),
    next: sanitizeStringList(parsed.next),
  };
}

function sanitizeWorkerHandoff(parsed: Record<string, unknown>): WorkerHandoff {
  return {
    status: sanitizeStatus<WorkerStatus>(parsed.status, "done"),
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Work unit completed without an explicit summary.",
    changes: sanitizeChanges(parsed.changes),
    checks: sanitizeChecks(parsed.checks),
    issues: sanitizeStringList(parsed.issues),
    next: sanitizeStringList(parsed.next).slice(0, 1),
  };
}

function sanitizeVerifyStatus(val: unknown): VerifyStatus | undefined {
  return val === "pass" || val === "fail" || val === "blocked" ? val : undefined;
}

function sanitizeCriteria(val: unknown): VerifyCriterion[] {
  if (!Array.isArray(val)) return [];
  const list: VerifyCriterion[] = [];
  for (const item of val) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const criterion = typeof entry.criterion === "string" ? entry.criterion.trim() : "";
    if (!criterion) continue;
    list.push({
      criterion,
      status: sanitizeVerifyStatus(entry.status) ?? "blocked",
      evidence:
        typeof entry.evidence === "string" && entry.evidence.trim()
          ? entry.evidence.trim()
          : undefined,
    });
  }
  return list;
}

function sanitizeDefects(val: unknown): VerifyDefect[] {
  if (!Array.isArray(val)) return [];
  const list: VerifyDefect[] = [];
  for (const item of val) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (!description) continue;
    list.push({
      severity: entry.severity === "blocking" ? "blocking" : "non_blocking",
      file: typeof entry.file === "string" && entry.file.trim() ? entry.file.trim() : undefined,
      description,
      evidence:
        typeof entry.evidence === "string" && entry.evidence.trim()
          ? entry.evidence.trim()
          : undefined,
    });
  }
  return list;
}

/**
 * A verdict is only as good as the proof behind it. A `pass` that carries no
 * evidence anywhere is downgraded to `blocked`: the parent must never read
 * "looks good" as a verification result.
 */
function hasEvidence(handoff: VerifyHandoff): boolean {
  return handoff.criteria.some((entry) => Boolean(entry.evidence))
    || handoff.checks.some((entry) => Boolean(entry.result));
}

function sanitizeVerifyHandoff(parsed: Record<string, unknown>): VerifyHandoff {
  const handoff: VerifyHandoff = {
    status: sanitizeVerifyStatus(parsed.status) ?? "blocked",
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Verification finished without an explicit summary.",
    criteria: sanitizeCriteria(parsed.criteria),
    checks: sanitizeChecks(parsed.checks),
    defects: sanitizeDefects(parsed.defects),
    next: sanitizeStringList(parsed.next).slice(0, 1),
  };

  if (handoff.status === "pass" && !hasEvidence(handoff)) {
    return {
      ...handoff,
      status: "blocked",
      summary: `Pass reported without evidence; treated as blocked. ${handoff.summary}`,
    };
  }

  return handoff;
}

/**
 * A small, deterministic identity for a failure: the blocking defects, or the
 * failing criteria when no defect was described. Two verifications that report
 * the same signature describe the same unfixed problem, which is what the repair
 * policy uses to stop early instead of looping.
 */
export function verifyFailureSignature(handoff: VerifyHandoff): string {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/\s+/gu, " ").trim().slice(0, 80);
  const location = (value: string) =>
    value.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/^\/+/u, "").trim();

  const blocking = handoff.defects
    .filter((defect) => defect.severity === "blocking")
    .map((defect) => `${normalize(location(defect.file ?? "?"))}::${normalize(defect.description)}`);

  if (blocking.length > 0) return [...blocking].sort().join(" | ");

  const failing = handoff.criteria
    .filter((entry) => entry.status !== "pass")
    .map((entry) => `${normalize(entry.criterion)}::${normalize(entry.evidence ?? entry.status)}`);

  if (failing.length > 0) return [...failing].sort().join(" | ");

  return normalize(handoff.summary);
}

function extractJsonBlock(rawText: string): Record<string, unknown> | null {
  // 1. Try markdown fenced code block with json
  const jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gu;
  let match: RegExpExecArray | null;
  while ((match = jsonBlockRegex.exec(rawText)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Continue to next block if any
    }
  }

  // 2. Try raw JSON object containing "status"
  const rawJsonMatch = /\{[\s\S]*"status"[\s\S]*\}/u.exec(rawText);
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fallback
    }
  }

  return null;
}

/**
 * Parse raw child agent output into a structured ExploreHandoff.
 */
export function parseExploreHandoff(rawText: string | undefined): ExploreHandoff {
  if (!rawText || !rawText.trim()) {
    return {
      status: "failed",
      summary: "Explore child returned no output.",
      evidence: [],
      issues: ["Empty response from child agent."],
      next: [],
    };
  }

  const parsed = extractJsonBlock(rawText);
  if (parsed) {
    return sanitizeExploreHandoff(parsed);
  }

  // Graceful fallback if model did not emit structured JSON
  return {
    status: "done",
    summary: rawText.slice(0, 1000).trim(),
    evidence: [],
    issues: ["Model response did not provide a structured JSON handoff block."],
    next: [],
  };
}

/**
 * Formats structured Explore handoff into concise markdown, defensively capped.
 */
export function formatExploreHandoff(handoff: ExploreHandoff): string {
  const lines: string[] = [
    `### Explore Result: ${handoff.status.toUpperCase()}`,
    "",
    `**Summary**: ${handoff.summary}`,
  ];

  if (handoff.evidence.length > 0) {
    lines.push("", "**Evidence**:");
    for (const item of handoff.evidence) {
      const loc = item.lines ? ` (lines ${item.lines})` : "";
      const note = item.note ? `: ${item.note}` : "";
      lines.push(`- \`${item.file}\`${loc}${note}`);
    }
  }

  if (handoff.issues.length > 0) {
    lines.push("", "**Issues & Blockers**:");
    for (const issue of handoff.issues) {
      lines.push(`- ${issue}`);
    }
  }

  if (handoff.next.length > 0) {
    lines.push("", "**Recommended Next Steps**:");
    for (const step of handoff.next) {
      lines.push(`- ${step}`);
    }
  }

  let formatted = lines.join("\n");
  if (formatted.length > MAX_HANDOFF_CHARS) {
    formatted = `${formatted.slice(0, MAX_HANDOFF_CHARS)}\n\n[Truncated: explore handoff exceeded 6,000 characters]`;
  }
  return formatted;
}

/**
 * Parse raw child agent output into a structured WorkerHandoff.
 */
export function parseWorkerHandoff(rawText: string | undefined): WorkerHandoff {
  if (!rawText || !rawText.trim()) {
    return {
      status: "failed",
      summary: "Worker child returned no output.",
      changes: [],
      checks: [],
      issues: ["Empty response from child agent."],
      next: [],
    };
  }

  const parsed = extractJsonBlock(rawText);
  if (parsed) {
    return sanitizeWorkerHandoff(parsed);
  }

  // Graceful fallback if model did not emit structured JSON
  return {
    status: "done",
    summary: rawText.slice(0, 1000).trim(),
    changes: [],
    checks: [],
    issues: ["Model response did not provide a structured JSON handoff block."],
    next: [],
  };
}

/**
 * Formats structured Worker handoff into concise markdown, defensively capped.
 */
export function formatWorkerHandoff(handoff: WorkerHandoff): string {
  const lines: string[] = [
    `### Worker Result: ${handoff.status.toUpperCase()}`,
    "",
    `**Summary**: ${handoff.summary}`,
  ];

  if (handoff.changes.length > 0) {
    lines.push("", "**Changes**:");
    for (const item of handoff.changes) {
      const desc = item.description ? `: ${item.description}` : "";
      lines.push(`- \`${item.file}\`${desc}`);
    }
  }

  if (handoff.checks.length > 0) {
    lines.push("", "**Checks & Tests**:");
    for (const item of handoff.checks) {
      const res = item.result ? `: ${item.result}` : "";
      lines.push(`- \`${item.check}\`${res}`);
    }
  }

  if (handoff.issues.length > 0) {
    lines.push("", "**Issues & Blockers**:");
    for (const issue of handoff.issues) {
      lines.push(`- ${issue}`);
    }
  }

  if (handoff.next.length > 0) {
    lines.push("", "**Recommended Next Step**:");
    for (const step of handoff.next.slice(0, 1)) {
      lines.push(`- ${step}`);
    }
  }

  let formatted = lines.join("\n");
  if (formatted.length > MAX_HANDOFF_CHARS) {
    formatted = `${formatted.slice(0, MAX_HANDOFF_CHARS)}\n\n[Truncated: worker handoff exceeded 6,000 characters]`;
  }
  return formatted;
}

/**
 * Parse raw Verify child output into a structured VerifyHandoff. An unreadable
 * answer is `blocked`, never `pass`: the conservative default for a verifier is
 * "I could not prove it", not "it is fine".
 */
export function parseVerifyHandoff(rawText: string | undefined): VerifyHandoff {
  if (!rawText || !rawText.trim()) {
    return {
      status: "blocked",
      summary: "Verify child returned no output.",
      criteria: [],
      checks: [],
      defects: [],
      next: [],
    };
  }

  const parsed = extractJsonBlock(rawText);
  if (parsed) {
    return sanitizeVerifyHandoff(parsed);
  }

  return {
    status: "blocked",
    summary: rawText.slice(0, 1000).trim(),
    criteria: [],
    checks: [],
    defects: [
      {
        severity: "blocking",
        description: "Verify response did not provide a structured JSON handoff block.",
      },
    ],
    next: ["Re-run verification with the structured handoff schema."],
  };
}

/**
 * Formats a Verify handoff into concise markdown, defensively capped.
 */
export function formatVerifyHandoff(handoff: VerifyHandoff): string {
  const lines: string[] = [
    `### Verify Result: ${handoff.status.toUpperCase()}`,
    "",
    `**Summary**: ${handoff.summary}`,
  ];

  if (handoff.criteria.length > 0) {
    lines.push("", "**Criteria**:");
    for (const item of handoff.criteria) {
      const evidence = item.evidence ? ` — ${item.evidence}` : "";
      lines.push(`- ${item.status.toUpperCase()} \`${item.criterion}\`${evidence}`);
    }
  }

  if (handoff.checks.length > 0) {
    lines.push("", "**Checks**:");
    for (const item of handoff.checks) {
      const result = item.result ? `: ${item.result}` : "";
      lines.push(`- \`${item.check}\`${result}`);
    }
  }

  const defects = handoff.defects.filter((defect) => defect.severity === "blocking");
  if (defects.length > 0) {
    lines.push("", "**Blocking defects**:");
    for (const defect of defects) {
      const location = defect.file ? `\`${defect.file}\` ` : "";
      const evidence = defect.evidence ? ` (${defect.evidence})` : "";
      lines.push(`- ${location}${defect.description}${evidence}`);
    }
  }

  const nonBlocking = handoff.defects.length - defects.length;
  if (nonBlocking > 0) {
    lines.push("", `**Non-blocking defects**: ${nonBlocking}`);
  }

  if (handoff.next.length > 0) {
    lines.push("", "**Next**:");
    for (const step of handoff.next.slice(0, 1)) {
      lines.push(`- ${step}`);
    }
  }

  let formatted = lines.join("\n");
  if (formatted.length > MAX_HANDOFF_CHARS) {
    formatted = `${formatted.slice(0, MAX_HANDOFF_CHARS)}\n\n[Truncated: verify handoff exceeded 6,000 characters]`;
  }
  return formatted;
}

/**
 * The compact defect list handed to a repair Worker, built from the verdict and
 * nothing else. It deliberately cannot carry the verify transcript.
 */
export function formatRepairBrief(handoff: VerifyHandoff): string {
  const lines: string[] = [];

  for (const defect of handoff.defects.filter((entry) => entry.severity === "blocking")) {
    const location = defect.file ? `${defect.file}: ` : "";
    const evidence = defect.evidence ? ` (evidence: ${defect.evidence})` : "";
    lines.push(`- ${location}${defect.description}${evidence}`);
  }

  for (const entry of handoff.criteria.filter((item) => item.status !== "pass")) {
    const evidence = entry.evidence ? ` (${entry.evidence})` : "";
    lines.push(`- criterion ${entry.status}: ${entry.criterion}${evidence}`);
  }

  return lines.join("\n");
}
