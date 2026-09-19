/**
 * AIES-008: Compact Ticket Contract & Extraction.
 *
 * Normalizes large remote Linear payloads into bounded, compact operational contracts
 * for the Parent session and child delegations. Protects the Parent context from
 * bloat while preserving exact goal, acceptance criteria, and constraints.
 */

import type { ActiveTicket, LinearIssueRaw } from "./types.ts";

export interface CriteriaExtractionResult {
  criteria: string[];
  isExplicit: boolean;
  derived: string[];
  ambiguous: string[];
}

/**
 * Extract explicit or derived acceptance criteria from ticket description.
 * Does NOT invent requirements. Distinguishes explicit criteria, derived
 * expectations, and ambiguous requirements.
 */
export function extractAcceptanceCriteria(description?: string): CriteriaExtractionResult {
  if (!description || !description.trim()) {
    return { criteria: [], isExplicit: false, derived: [], ambiguous: [] };
  }

  const lines = description.split("\n");
  const criteria: string[] = [];
  const derived: string[] = [];
  const ambiguous: string[] = [];

  let inCriteriaSection = false;
  const sectionHeaderRegex = /^(?:#+\s*|\*{1,2}|_{1,2})?(?:acceptance\s+criteria|criterios\s+de\s+aceptaci[oó]n|ac|acceptance|requirements|requisitos)(?:\*{1,2}|_{1,2}|:)?/i;
  const nextSectionRegex = /^#{1,4}\s+[A-Za-z0-9]/;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (sectionHeaderRegex.test(trimmed)) {
      inCriteriaSection = true;
      continue;
    }

    if (inCriteriaSection && nextSectionRegex.test(trimmed) && !sectionHeaderRegex.test(trimmed)) {
      inCriteriaSection = false;
    }

    // Markdown checklist: - [ ] or - [x]
    const checklistMatch = trimmed.match(/^[-*]\s+\[[ xX]\]\s+(.+)$/);
    if (checklistMatch) {
      const item = checklistMatch[1].trim();
      if (item.includes("?") || /\b(?:tbd|todo|unclear|por definir)\b/i.test(item)) {
        ambiguous.push(item);
      }
      criteria.push(item);
      continue;
    }

    // Bullet or numbered points under criteria section
    if (inCriteriaSection) {
      const bulletMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
      if (bulletMatch) {
        const rawItem = bulletMatch[1].trim();
        const item = rawItem.replace(/^\d+\.\s*/, "").trim();
        if (item.includes("?") || /\b(?:tbd|todo|unclear|por definir)\b/i.test(item)) {
          ambiguous.push(item);
        }
        criteria.push(item);
        continue;
      }
    }

    // Flag standalone ambiguous or unresolved items
    if (/\b(?:tbd|todo|unclear|por definir)\b/i.test(trimmed) || (trimmed.endsWith("?") && trimmed.length > 10)) {
      ambiguous.push(trimmed);
    }
  }

  if (criteria.length > 0) {
    return { criteria, isExplicit: true, derived, ambiguous };
  }

  // Fallback: look for general requirement statements in description
  for (const line of lines) {
    const trimmed = line.trim();
    const bulletMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (bulletMatch) {
      derived.push(bulletMatch[1].trim());
    } else if (/^(?:must|should|shall|ensure|debe|asegurar)\b/i.test(trimmed)) {
      derived.push(trimmed);
    }
  }

  return {
    criteria: derived.slice(0, 10),
    isExplicit: false,
    derived,
    ambiguous,
  };
}

/**
 * Workflow state as AIES reads it from a Linear payload.
 */
export interface IssueStateView {
  id?: string;
  name: string;
  type?: string;
}

function asStateRef(value: unknown): { id?: string; name?: string; type?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const ref = value as { id?: unknown; name?: string; type?: unknown };
  const id = typeof ref.id === "string" && ref.id.trim() ? ref.id.trim() : undefined;
  const name = typeof ref.name === "string" && ref.name.trim() ? ref.name.trim() : undefined;
  const type = typeof ref.type === "string" && ref.type.trim() ? ref.type.trim() : undefined;
  return { id, name, type };
}

function currentHistoryState(raw: LinearIssueRaw): { id?: string; name?: string; type?: string } | undefined {
  const history = Array.isArray(raw.stateHistory) ? raw.stateHistory : [];
  if (history.length === 0) return undefined;
  const open = [...history].reverse().find((entry) => entry && typeof entry === "object" && (entry.endedAt === null || entry.endedAt === undefined));
  return asStateRef((open ?? history[history.length - 1])?.state);
}

/**
 * Read the workflow state from any Linear issue payload shape: a state object, a
 * plain status name with a flat type, or a state history entry. Never guesses a
 * value that the payload does not carry.
 */
export function readIssueState(raw: LinearIssueRaw): IssueStateView {
  const stateObject = asStateRef(raw.state);
  const statusObject = asStateRef(raw.status);
  const history = currentHistoryState(raw);

  const id = stateObject?.id ?? statusObject?.id ?? history?.id;
  const name =
    stateObject?.name ??
    statusObject?.name ??
    (typeof raw.state === "string" && raw.state.trim() ? raw.state.trim() : undefined) ??
    (typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : undefined) ??
    history?.name ??
    "Unknown";
  const type =
    stateObject?.type ??
    statusObject?.type ??
    (typeof raw.statusType === "string" && raw.statusType.trim() ? raw.statusType.trim() : undefined) ??
    history?.type;

  return { id, name, type };
}

/**
 * Read the owning team. The workflow states of that team are required to resolve
 * where a ticket has to move, and Linear's `list_issue_statuses` accepts a team
 * name or id.
 */
export function readIssueTeam(raw: LinearIssueRaw): string | undefined {
  if (typeof raw.team === "string" && raw.team.trim()) return raw.team.trim();
  if (raw.team && typeof raw.team === "object") {
    const member = raw.team as { id?: unknown; name?: unknown };
    if (typeof member.name === "string" && member.name.trim()) return member.name.trim();
    if (typeof member.id === "string" && member.id.trim()) return member.id.trim();
  }
  if (typeof raw.teamId === "string" && raw.teamId.trim()) return raw.teamId.trim();
  return undefined;
}

/**
 * Normalizes a raw Linear issue payload into a lean ActiveTicket representation.
 */
export function normalizeTicketContract(raw: LinearIssueRaw): ActiveTicket {
  const identifier = raw.identifier || raw.id;
  const id = raw.id || identifier;
  const title = (raw.title || "").trim();
  const description = (raw.description || "").trim();

  const extracted = extractAcceptanceCriteria(description);

  const state = readIssueState(raw);

  let project: string | undefined;
  if (typeof raw.project === "string" && raw.project.trim()) {
    project = raw.project.trim();
  } else if (raw.project && typeof raw.project === "object" && raw.project.name) {
    project = raw.project.name;
  }

  const labels: string[] = [];
  if (Array.isArray(raw.labels)) {
    for (const label of raw.labels) {
      if (typeof label === "string") {
        labels.push(label);
      } else if (label && typeof label === "object" && label.name) {
        labels.push(label.name);
      }
    }
  }

  return {
    id,
    identifier,
    title,
    description,
    acceptanceCriteria: extracted.criteria,
    status: state.name,
    statusId: state.id,
    statusType: state.type,
    project,
    team: readIssueTeam(raw),
    labels: labels.length > 0 ? labels : undefined,
    url: raw.url,
    loadedAt: Date.now(),
  };
}

/**
 * Render a compact, context-safe string representation of the active ticket.
 * Enforces a strict character cap (< 2,500 chars) to prevent context bloat.
 */
export function formatCompactContract(ticket: ActiveTicket): string {
  const lines: string[] = [
    `Ticket: ${ticket.identifier} — ${ticket.title}`,
    `Status: ${ticket.status}${ticket.statusType ? ` [${ticket.statusType}]` : ""}`,
  ];

  if (ticket.project) {
    lines.push(`Project: ${ticket.project}`);
  }
  if (ticket.labels && ticket.labels.length > 0) {
    lines.push(`Labels: ${ticket.labels.join(", ")}`);
  }
  if (ticket.url) {
    lines.push(`URL: ${ticket.url}`);
  }

  lines.push("", "Acceptance Criteria:");
  if (ticket.acceptanceCriteria.length > 0) {
    ticket.acceptanceCriteria.forEach((ac, idx) => {
      lines.push(`${idx + 1}. ${ac}`);
    });
  } else {
    lines.push("(No explicit criteria defined; verify against goal)");
  }

  if (ticket.description) {
    const sanitized = ticket.description
      .replace(/<[^>]+>/g, " ")
      .replace(/\r\n/g, "\n")
      .trim();
    if (sanitized) {
      const descSnippet = sanitized.length > 500 ? `${sanitized.slice(0, 480)}...` : sanitized;
      lines.push("", "Summary:", descSnippet);
    }
  }

  let formatted = lines.join("\n");
  if (formatted.length > 2500) {
    formatted = formatted.slice(0, 2400) + "\n[... truncated for context hygiene ...]";
  }
  return formatted;
}

/**
 * Build compact delegation payload for Explore.
 * Receives only: goal, specific question, relevant constraints.
 */
export function buildExploreContract(
  ticket: ActiveTicket,
  question: string,
): { goal: string; question: string; constraints?: string } {
  return {
    goal: `${ticket.identifier}: ${ticket.title}`,
    question,
    constraints: ticket.labels ? `Labels: ${ticket.labels.join(", ")}` : undefined,
  };
}

/**
 * Build compact delegation payload for Worker.
 * Receives only: work unit, relevant acceptance criteria, compact findings.
 */
export function buildWorkerContract(
  ticket: ActiveTicket,
  findings?: string,
): { task: string; context: string } {
  const parts = [
    `WORK UNIT: ${ticket.identifier} — ${ticket.title}`,
    "",
    "ACCEPTANCE CRITERIA:",
    ...ticket.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
  ];
  if (findings) {
    parts.push("", "FINDINGS:", findings);
  }
  return {
    task: `Implement ${ticket.identifier}: ${ticket.title}`,
    context: parts.join("\n"),
  };
}

/**
 * Build compact delegation payload for Verify.
 * Receives only: acceptance criteria, changed paths, suggested checks.
 * Rejects free-form narrative.
 */
export function buildVerifyContract(
  ticket: ActiveTicket,
  changedPaths?: string[],
  checks?: string[],
): { task: string; criteria: string[]; changedPaths?: string[]; checks?: string[] } {
  return {
    task: `Verify ${ticket.identifier}: ${ticket.title}`,
    criteria: ticket.acceptanceCriteria.length > 0 ? ticket.acceptanceCriteria : [ticket.title],
    changedPaths,
    checks,
  };
}
