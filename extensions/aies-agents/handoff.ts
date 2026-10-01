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
  /** 1-based index into the run's acceptance criteria list (EZE-488: structural coverage). */
  index?: number;
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

/** Why a Verify run produced no usable verdict. */
export type VerifyProtocolErrorCode =
  | "missing_completion"
  | "invalid_completion"
  | "duplicate_completion"
  | "session_failure";

/**
 * A handoff failure, not a verdict. It carries no domain status on purpose: a
 * missing, malformed or duplicated completion must never be read as `blocked`,
 * `pass` or `fail`.
 */
export interface VerifyProtocolError {
  kind: "protocol_error";
  code: VerifyProtocolErrorCode;
  message: string;
}

/**
 * A verdict captured structurally from the completion tool. It keeps the direct
 * `.status`/`.criteria`/... fields for compatibility and adds an explicit
discriminant so a verdict can never be confused with a protocol error.
 */
export interface VerifyVerdict extends VerifyHandoff {
  kind: "verdict";
}

export type VerifyRunResult = VerifyVerdict | VerifyProtocolError;

/** True only for the protocol failure, never for a verdict. */
export function isProtocolError(result: VerifyRunResult | VerifyHandoff): result is VerifyProtocolError {
  return (result as { kind?: unknown }).kind === "protocol_error";
}

export function createVerifyProtocolError(code: VerifyProtocolErrorCode, message: string): VerifyProtocolError {
  return { kind: "protocol_error", code, message };
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
    const index = typeof entry.index === "number" && Number.isInteger(entry.index) ? entry.index : undefined;
    if (!criterion && index === undefined) continue;
    // Compatibility: an older handoff may say `met: true|false` instead of `status`.
    const status =
      sanitizeVerifyStatus(entry.status)
      ?? (entry.met === true ? "pass" : entry.met === false ? "fail" : undefined);
    list.push({
      ...(index !== undefined ? { index } : {}),
      criterion,
      status: status ?? "blocked",
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

function strictStatus(val: unknown): VerifyStatus | undefined {
  return sanitizeVerifyStatus(val);
}

function strictCriteria(val: unknown): { ok: true; value: VerifyCriterion[] } | { ok: false; reason: string } {
  if (val === undefined) return { ok: true, value: [] };
  if (!Array.isArray(val)) return { ok: false, reason: "criteria must be an array" };
  const list: VerifyCriterion[] = [];
  for (const item of val) {
    if (!item || typeof item !== "object") return { ok: false, reason: "each criterion must be an object" };
    const entry = item as Record<string, unknown>;
    const criterion = typeof entry.criterion === "string" ? entry.criterion.trim() : "";
    const index = typeof entry.index === "number" && Number.isInteger(entry.index) ? entry.index : undefined;
    if (!criterion && index === undefined) {
      return { ok: false, reason: "each criterion entry needs an index or non-empty text" };
    }
    const status = strictStatus(entry.status);
    if (!status) return { ok: false, reason: `criterion "${criterion || index}" needs status pass|fail|blocked` };
    list.push({
      ...(index !== undefined ? { index } : {}),
      criterion,
      status,
      evidence:
        typeof entry.evidence === "string" && entry.evidence.trim() ? entry.evidence.trim() : undefined,
    });
  }
  return { ok: true, value: list };
}

function strictChecks(val: unknown): { ok: true; value: VerifyCheck[] } | { ok: false; reason: string } {
  if (val === undefined) return { ok: true, value: [] };
  if (!Array.isArray(val)) return { ok: false, reason: "checks must be an array" };
  const list: VerifyCheck[] = [];
  for (const item of val) {
    if (!item || typeof item !== "object") return { ok: false, reason: "each check must be an object" };
    const entry = item as Record<string, unknown>;
    const check = typeof entry.check === "string" ? entry.check.trim() : "";
    if (!check) return { ok: false, reason: "each check needs non-empty text" };
    list.push({
      check,
      result: typeof entry.result === "string" && entry.result.trim() ? entry.result.trim() : undefined,
    });
  }
  return { ok: true, value: list };
}

function strictDefects(val: unknown): { ok: true; value: VerifyDefect[] } | { ok: false; reason: string } {
  if (val === undefined) return { ok: true, value: [] };
  if (!Array.isArray(val)) return { ok: false, reason: "defects must be an array" };
  const list: VerifyDefect[] = [];
  for (const item of val) {
    if (!item || typeof item !== "object") return { ok: false, reason: "each defect must be an object" };
    const entry = item as Record<string, unknown>;
    const description = typeof entry.description === "string" ? entry.description.trim() : "";
    if (!description) return { ok: false, reason: "each defect needs a non-empty description" };
    if (entry.severity !== "blocking" && entry.severity !== "non_blocking") {
      return { ok: false, reason: `defect "${description}" needs severity blocking|non_blocking` };
    }
    list.push({
      severity: entry.severity,
      file: typeof entry.file === "string" && entry.file.trim() ? entry.file.trim() : undefined,
      description,
      evidence:
        typeof entry.evidence === "string" && entry.evidence.trim() ? entry.evidence.trim() : undefined,
    });
  }
  return { ok: true, value: list };
}

/** Strip leading list markers/numbering from a criterion string. */
export function cleanCriterion(text: string): string {
  return text.replace(/^(\s*(\d+[\.\)]|[-*•]|\[[ xX]\])\s*)+/u, "").trim();
}

/**
 * Split and normalize an acceptance criteria list.
 * Handles arrays of strings, single multiline strings, strings with inline
 * numbering ("1. ... 2. ..."), and JSON-array strings ('["a", "b"]'), which
 * `aies_delegate` receives when a caller serializes the criteria list into the
 * string arm of its criteria union (EZE-488: collapsing N criteria into one
 * giant single-line criterion made index coverage impossible to satisfy).
 */
export function normalizeCriteriaList(val: unknown): string[] {
  const rawList: string[] = [];
  if (typeof val === "string") {
    // EZE-488 input boundary: a JSON-array string is parsed and its string
    // elements feed the existing per-item pipeline below. The fallback is
    // deliberate: a criterion TEXT that begins with '[' and ends with ']' but
    // is not valid JSON keeps working as one literal criterion; if such text
    // happens to be valid JSON it now parses as a list instead. Never throws.
    const trimmed = val.trim();
    let parsed: unknown[] | undefined;
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const candidate: unknown = JSON.parse(trimmed);
        if (Array.isArray(candidate)) parsed = candidate;
      } catch {
        // Not valid JSON: fall back to the literal-string behavior below.
      }
    }
    if (parsed) {
      for (const item of parsed) {
        if (typeof item === "string" && item.trim()) {
          rawList.push(item);
        }
      }
    } else {
      rawList.push(val);
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      if (typeof item === "string" && item.trim()) {
        rawList.push(item);
      }
    }
  } else {
    return [];
  }

  const result: string[] = [];
  for (const raw of rawList) {
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const items = line.split(/(?<=[.!?]|^)\s+(?=\d+[\.\)]\s+)/).map((s) => s.trim()).filter(Boolean);
      for (const item of items) {
        const cleaned = cleanCriterion(item);
        if (cleaned) {
          result.push(cleaned);
        }
      }
    }
  }
  return result;
}

/** Collapse a criterion to comparable tokens: strip list prefixes, normalize quotes/ellipsis, punctuation and whitespace. */
export function normalizedCriterion(value: string): string {
  return value
    .replace(/^(\s*(\d+[\.\)]|[-*•]|\[[ xX]\])\s*)+/u, "")
    .toLowerCase()
    .replace(/…/gu, "...")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201C\u201D]/gu, '"')
    .replace(/[\s`"'*_.,;:]+/gu, " ")
    .trim();
}

/** One required criterion matched, or not, to exactly one completion entry. */
export interface CriterionMatch {
  expected: string;
  entry?: VerifyCriterion;
}

/**
 * Match required criteria to completion entries one-to-one. Matching is exact
 * after normalization (case, punctuation and whitespace only) and each
 * completion entry is consumed at most once, so one broad or narrow entry can
 * never cover two required criteria.
 */
export function matchCriteria(required: string[], criteria: VerifyCriterion[]): CriterionMatch[] {
  const normalizedRequired = normalizeCriteriaList(required);
  const used = new Set<number>();
  return normalizedRequired.map((expected) => {
    const target = normalizedCriterion(expected);
    if (!target) return { expected };
    const index = criteria.findIndex(
      (entry, position) => !used.has(position) && normalizedCriterion(entry.criterion) === target,
    );
    if (index === -1) return { expected };
    used.add(index);
    return { expected, entry: criteria[index] };
  });
}

/** The result of validating one completion attempt against the run's criteria. */
export interface VerifyCompletionValidation {
  ok: boolean;
  handoff?: VerifyHandoff;
  reason?: string;
}

/**
 * Semantic validation of a completion attempt. Shape is checked (the schema
 * already does part of it) and then the meaning: a PASS needs evidence, must not
 * contradict a blocking defect, and must represent and pass every acceptance
 * criterion the run was given. An invalid attempt is a protocol failure, never a
 * domain verdict.
 */
export function validateVerifyCompletion(
  input: unknown,
  requiredCriteria: string[] = [],
): VerifyCompletionValidation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "completion must be an object" };
  }
  const parsed = input as Record<string, unknown>;

  const status = strictStatus(parsed.status);
  if (!status) return { ok: false, reason: 'status must be "pass", "fail" or "blocked"' };

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) return { ok: false, reason: "summary is required" };

  const criteria = strictCriteria(parsed.criteria);
  if (!criteria.ok) return { ok: false, reason: criteria.reason };
  const checks = strictChecks(parsed.checks);
  if (!checks.ok) return { ok: false, reason: checks.reason };
  const defects = strictDefects(parsed.defects);
  if (!defects.ok) return { ok: false, reason: defects.reason };

  const handoff: VerifyHandoff = {
    status,
    summary,
    criteria: criteria.value,
    checks: checks.value,
    defects: defects.value,
    next: sanitizeStringList(parsed.next).slice(0, 1),
  };

  if (status === "blocked") {
    const mentionsValidator =
      /\b(?:validator|aies_verify_complete|completion tool|completion gate|completion rejected|rejected every attempt)\b/iu;
    if (mentionsValidator.test(handoff.summary) || handoff.defects.some((d) => mentionsValidator.test(d.description))) {
      return {
        ok: false,
        reason: "validator or completion gate rejection is a protocol error, not a semantic BLOCKED",
      };
    }
    return { ok: true, handoff };
  }

  if (status !== "pass") return { ok: true, handoff };

  if (handoff.defects.some((defect) => defect.severity === "blocking")) {
    return { ok: false, reason: "a PASS cannot carry a blocking defect" };
  }
  if (!hasEvidence(handoff)) {
    return { ok: false, reason: "a PASS needs evidence in its criteria or checks" };
  }

  const normalizedRequired = normalizeCriteriaList(requiredCriteria);
  const N = normalizedRequired.length;

  if (N > 0 && handoff.criteria.length > 0) {
    // EZE-488: index-based structural coverage when the model provides indices.
    const useIndex = handoff.criteria.every((entry) => entry.index !== undefined);

    if (useIndex) {
      // Validate indices are in range 1..N and each appears exactly once.
      const seen = new Map<number, VerifyCriterion>();
      for (const entry of handoff.criteria) {
        const idx = entry.index!;
        if (idx < 1 || idx > N) {
          return { ok: false, reason: `completion criteria index ${idx} out of range 1..${N}` };
        }
        if (seen.has(idx)) {
          return { ok: false, reason: `completion criteria index ${idx} appears more than once` };
        }
        seen.set(idx, entry);
      }
      const missing: string[] = [];
      for (let i = 1; i <= N; i++) {
        if (!seen.has(i)) missing.push(normalizedRequired[i - 1]);
      }
      if (missing.length > 0) {
        return { ok: false, reason: `a PASS must represent every acceptance criterion; missing: ${missing.join("; ")}` };
      }
      // All indices present: check status and evidence per index.
      for (let i = 1; i <= N; i++) {
        const entry = seen.get(i)!;
        if (entry.status !== "pass") {
          return { ok: false, reason: `a PASS requires every acceptance criterion to pass; not passing: ${normalizedRequired[i - 1]}` };
        }
        if (!entry.evidence) {
          return { ok: false, reason: `a PASS needs evidence for every acceptance criterion; missing evidence: ${normalizedRequired[i - 1]}` };
        }
      }
      // Inject canonical criterion text (host-side: handoff stays human-readable).
      for (const entry of handoff.criteria) {
        entry.criterion = normalizedRequired[entry.index! - 1];
      }
    } else {
      // Legacy text-based coverage fallback. It is NOT reachable from the completion
      // tool: `createVerifyCompleteTool.execute` rejects a PASS whose entries lack an
      // index before calling this function (see `verifyCompletionIndexGuidance`). The
      // only callers that can reach it are direct/unit-level calls of
      // `validateVerifyCompletion` without indices. `parseVerifyHandoff` does not use
      // this function at all, and the Linear Done gate never re-validates coverage
      // against a stored PASS, so no production caller depends on this branch.
      const matches = matchCriteria(requiredCriteria, handoff.criteria);
      const uncovered = matches.filter((match) => !match.entry).map((match) => match.expected);
      if (uncovered.length > 0) {
        return { ok: false, reason: `a PASS must represent every acceptance criterion; missing: ${uncovered.join("; ")}` };
      }
      const notPassing = matches.filter((match) => match.entry?.status !== "pass").map((match) => match.expected);
      if (notPassing.length > 0) {
        return { ok: false, reason: `a PASS requires every acceptance criterion to pass; not passing: ${notPassing.join("; ")}` };
      }
      const unevidenced = matches
        .filter((match) => match.entry && !match.entry.evidence)
        .map((match) => match.expected);
      if (unevidenced.length > 0) {
        return { ok: false, reason: `a PASS needs evidence for every acceptance criterion; missing evidence: ${unevidenced.join("; ")}` };
      }
    }
  } else if (N > 0) {
    // No criteria entries at all but required list is non-empty.
    return { ok: false, reason: `a PASS must represent every acceptance criterion; missing: ${normalizedRequired.join("; ")}` };
  }

  return { ok: true, handoff };
}

/**
 * The per-entry shape a completion tool caller must produce, used verbatim in the
 * corrective reason so the model can fix the call instead of guessing.
 */
const VERIFY_INDEX_SHAPE =
  'every criteria entry must carry its 1-based index from the ACCEPTANCE CRITERIA list (one entry per index 1..N, shape {"index": 1, "status": "pass", "evidence": "<what was observed>"}; the "criterion" text is optional)';

/**
 * Tool-level index requirement (EZE-488 follow-up).
 *
 * The completion tool is the only runtime authority for a verdict, and a PASS is a
 * claim about every acceptance criterion of the run. Coverage is therefore decided
 * structurally by index, never by the text the model echoes back: a paraphrase,
 * truncation or typographic rewrite must not be able to fail a substantively correct
 * PASS. `validateVerifyCompletion` keeps a text-based branch for callers that supply
 * no indices at all; this gate is what keeps that branch unreachable from the tool,
 * rejecting with a message that teaches the required per-entry shape instead.
 *
 * Returns the corrective reason, or `undefined` when the completion may go through
 * to `validateVerifyCompletion`: no required criteria, a non-PASS verdict (only a
 * PASS claims full coverage), or a shape the semantic validator describes better.
 */
export function verifyCompletionIndexGuidance(
  completion: unknown,
  requiredCriteria: string[],
): string | undefined {
  const required = normalizeCriteriaList(requiredCriteria);
  if (required.length === 0) return undefined;
  if (!completion || typeof completion !== "object" || Array.isArray(completion)) return undefined;

  const parsed = completion as Record<string, unknown>;
  if (strictStatus(parsed.status) !== "pass") return undefined;
  if (!Array.isArray(parsed.criteria)) return undefined;

  const entries = parsed.criteria as unknown[];
  const missingIndex = entries.find((entry) => {
    const index = entry && typeof entry === "object" ? (entry as Record<string, unknown>).index : undefined;
    return typeof index !== "number" || !Number.isInteger(index);
  });
  if (entries.length === 0) {
    return `a PASS must report every acceptance criterion by index; no criteria entries were reported for ${required.length} required ${required.length === 1 ? "criterion" : "criteria"}: ${VERIFY_INDEX_SHAPE}`;
  }
  if (missingIndex !== undefined) {
    return `a PASS must report every acceptance criterion by index; a criteria entry carries no integer "index"${missingIndex && typeof missingIndex === "object" && "criterion" in missingIndex ? ` (entry "${String((missingIndex as Record<string, unknown>).criterion).slice(0, 80)}")` : ""}: ${VERIFY_INDEX_SHAPE}`;
  }
  return undefined;
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
 * Compatibility parser for a raw Verify child message. It is no longer the
 * authority: the completion tool is. It exists for deterministic tests and for a
 * child that never called the tool, and it never fabricates a domain verdict from
 * prose. Empty, malformed or semantically invalid input becomes a protocol error,
 * not `blocked`.
 */
export function parseVerifyHandoff(rawText: string | undefined): VerifyRunResult {
  const text = typeof rawText === "string" ? rawText : "";
  if (!text.trim()) {
    return createVerifyProtocolError("missing_completion", "the verify child produced no completion");
  }

  const parsed = extractJsonBlock(text);
  if (!parsed) {
    return createVerifyProtocolError(
      "missing_completion",
      "the verify child produced no structured completion",
    );
  }

  const status = sanitizeVerifyStatus(parsed.status);
  if (!status) {
    return createVerifyProtocolError("invalid_completion", "the handoff is missing a valid status");
  }

  const handoff: VerifyHandoff = {
    status,
    summary:
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : "Verification finished without an explicit summary.",
    criteria: sanitizeCriteria(parsed.criteria),
    checks: sanitizeChecks(parsed.checks),
    defects: sanitizeDefects(parsed.defects),
    next: sanitizeStringList(parsed.next).slice(0, 1),
  };

  if (status === "pass") {
    if (handoff.defects.some((defect) => defect.severity === "blocking")) {
      return createVerifyProtocolError("invalid_completion", "a PASS cannot carry a blocking defect");
    }
    if (!hasEvidence(handoff)) {
      return createVerifyProtocolError("invalid_completion", "a PASS needs evidence");
    }
  }

  return { kind: "verdict", ...handoff };
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
      const idx = item.index !== undefined ? `${item.index}. ` : "";
      const label = item.criterion || (item.index !== undefined ? `criterion ${item.index}` : "(unnamed)");
      lines.push(`- ${idx}${item.status.toUpperCase()} \`${label}\`${evidence}`);
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
    const label = entry.criterion || (entry.index !== undefined ? `criterion ${entry.index}` : "criterion");
    lines.push(`- ${label} [${entry.status}]${evidence}`);
  }

  return lines.join("\n");
}
