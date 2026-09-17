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
