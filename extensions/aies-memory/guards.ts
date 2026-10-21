/**
 * Input guards for AIES memory (D42). Pure: no filesystem, no process, no Pi.
 *
 * The write guard REJECTS, it never masks. ProjectMem has its own redaction, but it is narrow and
 * can be switched off, so it is only a second layer: nothing that looks like a credential, a
 * personal path or a log excerpt is allowed to reach the store. A rejection names the family that
 * matched and never echoes the text, so a rejected secret is not copied into an error or a log.
 */

/** Longest summary a record may carry. One line, a lesson, not a transcript. */
export const MAX_SUMMARY_CHARS = 400;

/** Longest search query. Retrieval is lexical, so a query is a keyword, a path or an error string. */
export const MAX_QUERY_CHARS = 200;

export type GuardResult = { ok: true; text: string } | { ok: false; reason: string };

interface SecretFamily {
  readonly family: string;
  readonly pattern: RegExp;
}

/**
 * The ProjectMem redaction families (projectmem 0.3.4, redaction.py), loosened on the length so a
 * truncated or lightly edited credential is still caught, then the generic families.
 */
const SECRET_FAMILIES: readonly SecretFamily[] = [
  { family: "OpenAI/Anthropic-style key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/u },
  { family: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}/u },
  { family: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/u },
  { family: "AWS access key", pattern: /\bAKIA[0-9A-Z]{12,}/u },
  { family: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/u },
  { family: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{8,}/u },
  { family: "Stripe key", pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/u },
  { family: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/u },
  { family: "Bearer token", pattern: /(?<![A-Za-z])bearer\s+[A-Za-z0-9._~+/=-]{16,}/iu },
  { family: "PEM block", pattern: /-----BEGIN [A-Z0-9 ]+-----/u },
  {
    family: "credential assignment",
    pattern: /(?:key|token|secret|password|passwd|api[_-]?key)["']?\s*[:=]\s*\S+/iu,
  },
  { family: "URL with embedded credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+(?::[^\s/@]*)?@[^\s/]/iu },
  { family: "absolute home path", pattern: /(?:^|[^A-Za-z0-9_])\/(?:Users|home)\/[^\s/]+/u },
  { family: "Windows home path", pattern: /\b[A-Za-z]:\\Users\\[^\s\\]+/u },
  { family: ".env style line", pattern: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*=\S/u },
];

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * A long base64/hex-looking token. Paths and identifiers with no digit stay allowed; a pure hex
 * run of 32 or more characters is rejected whatever its entropy (use a short hash instead).
 */
function hasHighEntropyToken(text: string): boolean {
  for (const match of text.matchAll(/[A-Za-z0-9+/=_-]{32,}/gu)) {
    const token = match[0];
    if (/^[0-9a-fA-F]+$/u.test(token)) return true;
    if (/\d/u.test(token) && /[A-Za-z]/u.test(token) && shannonEntropy(token) >= 3.5) return true;
  }
  return false;
}

/** Why `text` matches a secret or sensitive family, or undefined when it matches none. */
export function sensitiveFamily(text: string): string | undefined {
  for (const { family, pattern } of SECRET_FAMILIES) {
    if (pattern.test(text)) return family;
  }
  if (hasHighEntropyToken(text)) return "long high-entropy token";
  return undefined;
}

const LINE_BREAK = /[\r\n\u2028\u2029]/u;
/** Control and format characters: NUL, ANSI escapes, tabs, zero-width and bidi overrides. */
const CONTROL = /[\p{Cc}\p{Cf}]/u;

function codePoints(text: string): number {
  return Array.from(text).length;
}

/** Shared by writes and queries: a non-empty single line without control characters. */
function checkLine(raw: unknown, label: string, max: number): GuardResult {
  if (typeof raw !== "string") return { ok: false, reason: `${label} must be text` };
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: `${label} is empty` };
  if (LINE_BREAK.test(text)) return { ok: false, reason: `${label} must be a single line` };
  if (CONTROL.test(text)) return { ok: false, reason: `${label} contains control characters` };
  if (codePoints(text) > max) return { ok: false, reason: `${label} is longer than ${max} characters` };
  return { ok: true, text };
}

/**
 * Validate a record summary. Returns the trimmed text or the reason it is refused. `max` is only raised
 * by a caller that clips the text itself afterwards (automatic learnings), after the whole text passed.
 */
export function checkWriteText(raw: unknown, max: number = MAX_SUMMARY_CHARS): GuardResult {
  const line = checkLine(raw, "summary", max);
  if (!line.ok) return line;
  const family = sensitiveFamily(line.text);
  if (family) {
    return {
      ok: false,
      reason: `summary looks like it contains a ${family}; rewrite it without the sensitive value (nothing was stored)`,
    };
  }
  return line;
}

/** Validate a search query. A query is not stored, so it is not checked for secrets. */
export function checkQueryText(raw: unknown): GuardResult {
  return checkLine(raw, "query", MAX_QUERY_CHARS);
}

/** A project key is used as a directory name: strict, no separators, no dot-only names. */
const PROJECT_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isValidProjectKey(key: unknown): key is string {
  return typeof key === "string" && PROJECT_KEY.test(key) && !key.includes("..");
}

/** A ProjectMem event id as printed by `pjm search`: the whole id, never a prefix. */
const EVENT_ID = /^evt_[0-9a-f]+$/u;

export function isValidEventId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && EVENT_ID.test(id);
}

/**
 * A focus path for `context --focus`: relative, no `..`, no leading dash, a conservative alphabet.
 * Returns the normalised path or undefined when it is refused.
 */
export function checkFocusPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const focus = raw.trim();
  if (focus.length === 0 || focus.length > 200) return undefined;
  if (!/^[A-Za-z0-9._@+/-]+$/u.test(focus)) return undefined;
  if (focus.startsWith("/") || focus.startsWith("-")) return undefined;
  // A trailing slash names a directory; every remaining segment must be a real name.
  const segments = (focus.endsWith("/") ? focus.slice(0, -1) : focus).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return focus;
}
