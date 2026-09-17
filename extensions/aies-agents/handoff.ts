/**
 * Structured handoff parser and formatter for Explore child agents.
 *
 * Ensures child findings are parsed into a deterministic schema and formatted
 * compactly for the parent session, capped defensively under 6,000 characters.
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

/** Maximum length of the formatted handoff returned to parent context. */
export const MAX_HANDOFF_CHARS = 6000;

function sanitizeStatus(val: unknown): ExploreStatus {
  if (val === "done" || val === "blocked" || val === "failed") return val;
  return "done";
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

function sanitizeHandoff(parsed: Record<string, unknown>): ExploreHandoff {
  return {
    status: sanitizeStatus(parsed.status),
    summary: typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : "Exploration completed without an explicit summary.",
    evidence: sanitizeEvidence(parsed.evidence),
    issues: sanitizeStringList(parsed.issues),
    next: sanitizeStringList(parsed.next),
  };
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

  // 1. Try markdown fenced code block with json
  const jsonBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?```/gu;
  let match: RegExpExecArray | null;
  while ((match = jsonBlockRegex.exec(rawText)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return sanitizeHandoff(parsed as Record<string, unknown>);
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
        return sanitizeHandoff(parsed as Record<string, unknown>);
      }
    } catch {
      // Fallback
    }
  }

  // 3. Graceful fallback if model did not emit structured JSON
  return {
    status: "done",
    summary: rawText.slice(0, 1000).trim(),
    evidence: [],
    issues: ["Model response did not provide a structured JSON handoff block."],
    next: [],
  };
}

/**
 * Formats structured handoff into concise markdown, defensively capped.
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
