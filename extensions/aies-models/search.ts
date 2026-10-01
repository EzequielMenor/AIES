/**
 * Pure fuzzy matcher for the `/aies-models` picker (EZE-453 / T10).
 *
 * Pi's own `/model` selector filters with `fuzzyFilter` from Pi's bundled TUI
 * package. AIES cannot import that package here: it is not a dependency of this
 * repository and the overlay modules are deliberately host-free so they stay
 * testable without a terminal. Instead of vendoring an untestable dependency,
 * this module owns the small behaviour that matters to the picker — a
 * subsequence matcher ranked so a contiguous, early, tight, word-boundary match
 * wins — and nothing else.
 *
 * Pi's haystack (`getModelSelectorSearchText`) leads with the provider, then
 * `provider/id`, then the provider, then the bare id, then the display name.
 * `modelSearchText` mirrors that exactly, including the deliberate choice not to
 * put the bare id first: an exact `provider/…` query must outrank a proxy-style
 * id that merely shares a suffix.
 *
 * Everything here is pure, deterministic, total and never throws.
 */

/** Longest accepted search query; keeps the rendered query line bounded. */
export const MAX_QUERY_LENGTH = 48;

/**
 * Packing weights for the score. The four ranking criteria are lexicographic,
 * so each criterion owns a disjoint bit field and a higher-priority field can
 * never be outweighed by a lower-priority one. The fields are exact for any
 * realistic search text (well under 1024 characters); longer, hostile input is
 * clamped deterministically rather than throwing.
 */
const RUNS_WEIGHT = 2 ** 40;
const FIRST_WEIGHT = 2 ** 30;
const SPAN_WEIGHT = 2 ** 20;
const BOUNDARY_WEIGHT = 2 ** 8;
const FIELD_CEILING = 1023;
const BOUNDARY_CEILING = 255;

/** Pi's own selector haystack. The provider leads and the bare id is not first. */
export function modelSearchText(input: { id: string; provider: string; name?: string }): string {
  const provider = typeof input?.provider === "string" ? input.provider : "";
  const id = typeof input?.id === "string" ? input.id : "";
  const name = typeof input?.name === "string" && input.name ? ` ${input.name}` : "";
  return `${provider} ${provider}/${id} ${provider} ${id}${name}`;
}

/** One candidate match's four ranking metrics, in priority order. */
interface MatchMetrics {
  /** Adjacent matched-character pairs; higher is better. */
  runs: number;
  /** Index of the first matched character; lower is better. */
  first: number;
  /** `lastIndex - firstIndex`; lower is better. */
  span: number;
  /** Matches immediately after a space or `/` (or at the very start); higher is better. */
  boundaries: number;
}

function isBoundary(haystack: string, index: number): boolean {
  if (index === 0) return true;
  const previous = haystack[index - 1];
  return previous === " " || previous === "/";
}

/** Whether `candidate` beats `current` under the documented lexicographic priority. */
function beats(candidate: MatchMetrics, current: MatchMetrics | undefined): boolean {
  if (!current) return true;
  if (candidate.runs !== current.runs) return candidate.runs > current.runs;
  if (candidate.first !== current.first) return candidate.first < current.first;
  if (candidate.span !== current.span) return candidate.span < current.span;
  return candidate.boundaries > current.boundaries;
}

/**
 * The best match of `needle` inside `haystack`, both already lowercased.
 *
 * For every position where the first query character appears this makes the
 * greedy earliest choice for each subsequent character — which is optimal for
 * feasibility — and keeps the candidate whose metrics win, so a later start with
 * more contiguous characters can beat an earlier, scattered one.
 */
function bestMatch(needle: string, haystack: string): MatchMetrics | undefined {
  const length = needle.length;
  const lastStart = haystack.length - length;
  let best: MatchMetrics | undefined;

  for (let start = 0; start <= lastStart; start += 1) {
    if (haystack[start] !== needle[0]) continue;

    const positions: number[] = [start];
    let cursor = start + 1;
    let matched = true;
    for (let queryIndex = 1; queryIndex < length; queryIndex += 1) {
      let found = -1;
      for (let index = cursor; index < haystack.length; index += 1) {
        if (haystack[index] === needle[queryIndex]) {
          found = index;
          break;
        }
      }
      if (found < 0) {
        matched = false;
        break;
      }
      positions.push(found);
      cursor = found + 1;
    }
    // Greedy takes the earliest match for every character, so a failure here
    // means no later start can match either: the available suffix only shrinks.
    if (!matched) break;

    let runs = 0;
    let boundaries = 0;
    for (let index = 0; index < positions.length; index += 1) {
      if (index > 0 && positions[index] === positions[index - 1] + 1) runs += 1;
      if (isBoundary(haystack, positions[index])) boundaries += 1;
    }

    const first = positions[0] ?? 0;
    const candidate: MatchMetrics = {
      runs,
      first,
      span: (positions[positions.length - 1] ?? first) - first,
      boundaries,
    };
    if (beats(candidate, best)) best = candidate;
  }

  return best;
}

/** Clamp one metric into its bit field, inverted so a smaller value ranks higher. */
function rankField(value: number, ceiling: number): number {
  return ceiling - Math.min(Math.max(value, 0), ceiling);
}

/** Pack the metrics into one comparable number. */
function scoreOf(metrics: MatchMetrics): number {
  return (
    metrics.runs * RUNS_WEIGHT +
    rankField(metrics.first, FIELD_CEILING) * FIRST_WEIGHT +
    rankField(metrics.span, FIELD_CEILING) * SPAN_WEIGHT +
    Math.min(metrics.boundaries, BOUNDARY_CEILING) * BOUNDARY_WEIGHT
  );
}

/** Trim and clamp any query to the accepted search length. */
function normalizeQuery(query: unknown): string {
  if (typeof query !== "string") return "";
  return query.slice(0, MAX_QUERY_LENGTH).trim();
}

/**
 * Subsequence fuzzy score, higher is better; `undefined` when the query does not
 * match. Case-insensitive; an empty query matches everything with `0`. Every
 * query character must appear in `text` in order (subsequence, not substring).
 */
export function fuzzyScore(query: string, text: string): number | undefined {
  const needle = normalizeQuery(query).toLowerCase();
  if (needle.length === 0) return 0;
  if (typeof text !== "string") return undefined;

  const haystack = text.toLowerCase();
  if (needle.length > haystack.length) return undefined;

  const match = bestMatch(needle, haystack);
  return match ? scoreOf(match) : undefined;
}

/**
 * Filter and rank. An empty or whitespace query returns the items in their
 * original order and drops nothing. A non-empty query is clamped to
 * `MAX_QUERY_LENGTH`; only matching items survive, sorted by descending score
 * with ties broken by the original index, so the result is stable.
 */
export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (!Array.isArray(items)) return [];
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return [...items];

  const scored: { item: T; score: number; index: number }[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as T;
    const score = fuzzyScore(normalized, text(item));
    if (score === undefined) continue;
    scored.push({ item, score, index });
  }

  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.map((entry) => entry.item);
}
