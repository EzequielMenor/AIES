#!/usr/bin/env node
/**
 * Regenerates `extensions/aies-provider-commandcode/models.json`.
 *
 * REQUIRES NETWORK. It is a maintenance tool run by hand, never part of
 * `npm test`, `npm run check:isolation`, the launcher or any git hook: the AIES
 * contract is a deterministic, zero-network startup, so the provider ships a
 * static catalog instead of fetching one at load time.
 *
 *   node scripts/refresh-commandcode-models.mjs
 *   node scripts/refresh-commandcode-models.mjs --models-json /path/provider-models.json \
 *        --docs-html /path/goat.html          # offline rerun from saved dumps
 *
 * Two sources are merged, because neither one is complete:
 *   1. `GET <baseUrl>/models` (public, no key) — the ids the provider API
 *      actually serves, the display names, `context_length` and
 *      `supported_endpoints`, which decide the wire API per model.
 *   2. The GOAT plan docs page (`https://commandcode.ai/docs/plans/goat`) —
 *      the pricing catalog embedded in its React Server Components payload:
 *      per-million rates, `reasoning`, `vision`, context window.
 *
 * Documented rules:
 *   - `api`: `"anthropic-messages"` when a model is served only on `/messages`,
 *     otherwise `"openai-completions"` (`/chat/completions`, and `/responses`
 *     where advertised, which Pi does not use for this provider).
 *   - `cost`: the BASE list rates. Discounted "deal" rows expose the public list
 *     price as `tiers[].listRates`, so that wins over the promotional
 *     `tiers[].rates`. Models with no catalog entry at all, and the free-tier
 *     deals that publish no list price, get `0` (they are billed outside the
 *     per-token meter); see the README section.
 *   - `contextWindow`: the endpoint's `context_length`, corrected to the catalog
 *     value when the catalog is larger (the docs publish the full window).
 *   - `maxTokens`: the derived assumption `clamp(floor(contextWindow / 4),
 *     8192, 64000)` unless `MAX_TOKEN_OVERRIDES` records a measured cap for the
 *     id, in which case the measured value wins. Neither source publishes a
 *     maximum output length, so a real request is the only way to learn the true
 *     cap; measured caps live in the override map rather than in the formula.
 *   - `input`: `["text"]`, plus `"image"` only when the catalog marks the model
 *     `vision` (or its name says "Vision").
 *   - model order: the order returned by the endpoint (newest first), so a
 *     refresh produces a readable diff.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Provider metadata; must stay in sync with the extension. */
const PROVIDER_API = "https://api.commandcode.ai/provider/v1";
const MODELS_ENDPOINT = `${PROVIDER_API}/models`;
const DOCS_PAGE = "https://commandcode.ai/docs/plans/goat";
const DEFAULT_OUT = join(REPO, "extensions", "aies-provider-commandcode", "models.json");

function parseArgs(argv) {
  const options = { out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "usage: node scripts/refresh-commandcode-models.mjs " +
          "[--models-json <file>] [--docs-html <file>] [--out <file>]\n" +
          "  --models-json  use a saved GET /provider/v1/models body instead of the network\n" +
          "  --docs-html    use a saved GOAT plan HTML page instead of the network\n",
      );
      process.exit(0);
    }
    const value = argv[i + 1];
    if (arg === "--models-json" || arg === "--docs-html" || arg === "--out") {
      if (!value) throw new Error(`${arg} needs a value`);
      options[arg.replace(/^--/, "")] = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** Reads a local file or fetches a URL, so the same code serves both modes. */
async function readSource(pathOrUrl, asJson) {
  if (/^https?:\/\//.test(pathOrUrl)) {
    const response = await fetch(pathOrUrl, { headers: { accept: asJson ? "application/json" : "text/html" } });
    if (!response.ok) throw new Error(`GET ${pathOrUrl} -> HTTP ${response.status}`);
    return asJson ? response.json() : response.text();
  }
  const text = readFileSync(resolve(pathOrUrl), "utf8");
  return asJson ? JSON.parse(text) : text;
}

/**
 * Pulls the RSC payload out of a Next.js docs page and returns the model catalog.
 *
 * The page ships its data as a series of `self.__next_f.push([1,"…"])` string
 * literals. Each literal is JSON-decoded (which unescapes the doubled quotes)
 * and the results are concatenated; inside that text the catalog is the value of
 * a single `"models":[ … ]` key, brace-matched and parsed as JSON.
 */
function extractCatalog(html) {
  const marker = 'self.__next_f.push([1,"';
  let payload = "";
  for (let i = 0; ; ) {
    const start = html.indexOf(marker, i);
    if (start < 0) break;
    let cursor = start + marker.length;
    let literal = "";
    while (cursor < html.length) {
      const char = html[cursor];
      if (char === "\\") {
        literal += char + html[cursor + 1];
        cursor += 2;
        continue;
      }
      if (char === '"') break;
      literal += char;
      cursor += 1;
    }
    i = cursor + 1;
    try {
      payload += JSON.parse(`"${literal}"`);
    } catch {
      // A chunk that is not a plain JSON string carries no catalog data.
    }
  }

  const key = '"models":[';
  const at = payload.indexOf(key);
  if (at < 0) throw new Error("docs catalog not found: the page layout may have changed");
  const open = payload.indexOf("[", at + key.length - 1);
  const close = matchBrackets(payload, open);
  if (close < 0) throw new Error("docs catalog is unbalanced: refusing to guess");
  return JSON.parse(payload.slice(open, close + 1));
}

/** Index of the bracket that closes the one at `start`, string-aware. */
function matchBrackets(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The RSC payload uses the string "$undefined" for an absent value. */
function defined(value) {
  return typeof value === "string" ? undefined : value;
}

function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? round6(value) : fallback;
}

/** Prices are published per 1M tokens with at most a few decimals. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Base (non-promotional) rates for a catalog entry. */
function baseRates(entry) {
  const tiers = Array.isArray(entry.tiers) ? entry.tiers : [];
  const standard = tiers.find((tier) => tier?.label === "Standard") ?? tiers[0] ?? {};
  // `listRates` is the public list price while a time-limited deal discounts
  // `rates`; the static catalog must carry the base price. A repeated
  // `listRates` can be an RSC back-reference string, which is not usable.
  const list = defined(standard.listRates);
  const rates = defined(standard.rates) ?? {};
  const base = { ...rates, ...(list && typeof list === "object" ? list : {}) };

  const cacheWrite =
    typeof base.cacheWrite === "number"
      ? base.cacheWrite
      : numberOr(defined(entry.cacheWriteCost), 0);

  return {
    input: numberOr(base.input, numberOr(defined(entry.inputCost), 0)),
    output: numberOr(base.output, numberOr(defined(entry.outputCost), 0)),
    cacheRead: numberOr(base.cacheRead, numberOr(defined(entry.cacheReadCost), 0)),
    cacheWrite: round6(cacheWrite),
  };
}

/**
 * Finds the catalog entry for an endpoint model.
 *
 * The endpoint is authoritative for ids, but the docs catalog can lag by a
 * snapshot suffix (`claude-haiku-4-5-20251001` vs `claude-haiku-4-5`), so the
 * lookup degrades from exact id to display name to longest id prefix.
 */
function findCatalog(byId, byName, entry) {
  const exact = byId.get(entry.id);
  if (exact) return { match: exact, how: "id" };

  const named = byName.get(entry.name.toLowerCase());
  if (named) return { match: named, how: "name" };

  let best;
  for (const id of byId.keys()) {
    if (entry.id.startsWith(`${id}-`) && (!best || id.length > best.id.length)) best = { id, length: id.length };
  }
  if (best) return { match: byId.get(best.id), how: "prefix" };

  return { match: undefined, how: "none" };
}

/**
 * Measured `maxTokens` caps that contradict the derived assumption.
 *
 * `deriveMaxTokens` is an assumption because neither the provider endpoint nor
 * the plan page publishes a maximum output length. When a real request proves
 * the assumption wrong, the measured cap is recorded here so a regeneration
 * keeps it instead of silently reverting to a value the API rejects.
 *
 * Evidence is a provider HTTP 400 naming the cap; only measured values belong
 * here, never a value copied from marketing or docs.
 */
const MAX_TOKEN_OVERRIDES = {
  // HTTP 400 from the provider API on 2026-09-22:
  // "max_tokens (64000): Input should be less than or equal to 32768"
  "poolside/laguna-s-2.1-free": 32768,
};

/**
 * Max output tokens for a model.
 *
 * Returns the measured `MAX_TOKEN_OVERRIDES` cap when the id has one, otherwise
 * the documented assumption `clamp(floor(contextWindow / 4), 8192, 64000)`.
 */
export function deriveMaxTokens(contextWindow, id) {
  return MAX_TOKEN_OVERRIDES[id] ?? Math.max(8192, Math.min(64000, Math.floor(contextWindow / 4)));
}

function toProviderModel(entry, catalog, notes) {
  const endpoints = Array.isArray(entry.supported_endpoints) ? entry.supported_endpoints : [];
  const anthropicOnly = endpoints.includes("/messages") && !endpoints.includes("/chat/completions");

  const contextWindow = Math.max(Number(entry.context_length) || 0, Number(catalog?.contextWindow) || 0);
  if (!contextWindow) throw new Error(`model ${entry.id} has no usable context window`);

  const vision = catalog?.vision === true || /\bvision\b/i.test(String(catalog?.name ?? entry.name ?? ""));
  const cost = baseRates(catalog ?? {});

  if (!catalog) notes.missing.push(entry.id);
  else if (catalog.contextWindow && Number(entry.context_length) !== catalog.contextWindow) {
    notes.context.push(`${entry.id}: endpoint ${entry.context_length} -> docs ${catalog.contextWindow}`);
  }
  if (cost.input === 0 && cost.output === 0) notes.zeroCost.push(entry.id);
  if (Object.hasOwn(MAX_TOKEN_OVERRIDES, entry.id)) notes.overrides.push(entry.id);

  const model = {
    id: entry.id,
    name: entry.name || entry.id,
    api: anthropicOnly ? "anthropic-messages" : "openai-completions",
    reasoning: catalog?.reasoning === true,
    input: vision ? ["text", "image"] : ["text"],
    cost,
    contextWindow,
    maxTokens: deriveMaxTokens(contextWindow, entry.id),
  };
  // Key order mirrors Pi's ProviderModelConfig for reviewable diffs.
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    api: model.api,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const endpointPayload = await readSource(
    options["models-json"] ?? MODELS_ENDPOINT,
    true,
  );
  const docsHtml = await readSource(options["docs-html"] ?? DOCS_PAGE, false);

  const endpointModels = Array.isArray(endpointPayload?.data) ? endpointPayload.data : [];
  if (!endpointModels.length) throw new Error(`${MODELS_ENDPOINT} returned no models`);

  const catalog = extractCatalog(docsHtml);
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const byName = new Map(catalog.map((entry) => [String(entry.name).toLowerCase(), entry]));

  const notes = { missing: [], context: [], zeroCost: [], overrides: [] };
  const models = [];
  for (const entry of endpointModels) {
    if (typeof entry?.id !== "string") continue;
    const { match } = findCatalog(byId, byName, entry);
    models.push(toProviderModel(entry, match, notes));
  }

  const ids = new Set(models.map((model) => model.id));
  if (ids.size !== models.length) throw new Error("duplicate model ids after merge");
  // An override for an id the endpoint no longer serves is stale and must be
  // loud, otherwise it rots unnoticed while pretending to still apply.
  const staleOverrides = Object.keys(MAX_TOKEN_OVERRIDES).filter((id) => !ids.has(id));

  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(models, null, 2)}\n`, "utf8");

  const perApi = models.reduce((acc, model) => {
    acc[model.api] = (acc[model.api] ?? 0) + 1;
    return acc;
  }, {});
  process.stdout.write(
    [
      `wrote ${options.out}`,
      `  endpoint models: ${models.length}  docs catalog models: ${catalog.length}`,
      `  by api: ${Object.entries(perApi).map(([api, count]) => `${api}=${count}`).join("  ")}`,
      `  unmatched docs entries: ${catalog.filter((entry) => !ids.has(entry.id)).map((entry) => entry.id).join(", ") || "none"}`,
      `  no catalog match (rates 0): ${notes.missing.join(", ") || "none"}`,
      `  context corrected from docs: ${notes.context.join(", ") || "none"}`,
      `  free / unbilled models: ${notes.zeroCost.join(", ") || "none"}`,
      `  maxTokens overrides applied: ${notes.overrides.length}${notes.overrides.length ? ` (${notes.overrides.join(", ")})` : ""}`,
      `  maxTokens overrides stale: ${staleOverrides.join(", ") || "none"}${staleOverrides.length ? "  WARNING: that id is no longer served, remove or re-measure it" : ""}`,
      "",
    ].join("\n"),
  );
}

// Only run the generator when executed directly; importing the module (the tests
// do) must not touch the network.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
