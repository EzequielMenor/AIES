/**
 * Command Code provider (`commandcode`) for Pi — GOAT plan.
 *
 * Registers the provider together with every model the Command Code provider
 * API serves, so `/model`, `--list-models`, `/aies-models` and the AIES role
 * pickers can select them. Contract:
 *
 * - The catalog is a committed, static `models.json` next to this module. It is
 *   never fetched at load time: AIES startup has to stay deterministic and
 *   zero-network (`scripts/check-isolation.sh` proves it). Regenerating it is a
 *   manual, network-requiring step:
 *   `node scripts/refresh-commandcode-models.mjs`.
 * - One `registerProvider` call covers both wire protocols. Pi allows a
 *   per-model `api` override, so the Anthropic-only rows use
 *   `"anthropic-messages"` and everything else inherits the provider-level
 *   `"openai-completions"`.
 * - Auth is the user's own credential. The ordinary path is the stored
 *   credential written by `/login commandcode`; it takes precedence over the
 *   declared config expression. `COMMANDCODE_API_KEY`
 *   (`"$COMMANDCODE_API_KEY"`) is the CI, headless and testing path and is only
 *   consulted when no stored credential exists. No key is read, printed or
 *   hardcoded here.
 * - Prices are the base (list) rates published on the GOAT plan page, in
 *   USD per 1M tokens; time-limited "deal" discounts are deliberately not
 *   baked in. Models the docs publish without any rate (the free tier) stay at
 *   `0`. `maxTokens` is a documented assumption, not a vendor limit.
 * - A missing or malformed `models.json` degrades to "provider not registered"
 *   with a single load-time diagnostic plus a warning on session start; it must
 *   never break the rest of the profile.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Provider id: models surface as `commandcode/<id>` and auth as `/login commandcode`. */
export const COMMANDCODE_PROVIDER_ID = "commandcode";
/** Display name shown in the provider lists. */
export const COMMANDCODE_PROVIDER_NAME = "Command Code";
/** Provider API root; the same key works for the CLI and this API. */
export const COMMANDCODE_BASE_URL = "https://api.commandcode.ai/provider/v1";
/** Environment variable holding the key, referenced through Pi's `$ENV` syntax. */
export const COMMANDCODE_API_KEY = "$COMMANDCODE_API_KEY";

/** Static catalog committed with the extension. */
export const COMMANDCODE_MODELS_FILE = join(MODULE_DIR, "models.json");

/** Outcome of reading the catalog: usable models, plus what was dropped. */
export interface CommandCodeCatalog {
  models: ProviderModelConfig[];
  /** Why the catalog could not be used at all, or `undefined` when it loaded. */
  fatal?: string;
  /** Entries that failed validation and were skipped. */
  skipped: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A cost rate is a non-negative number; anything else makes the row unusable. */
function rate(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

/**
 * Narrows one untrusted JSON entry to a `ProviderModelConfig`.
 *
 * Returns `{ reason }` when a required field is absent or has the wrong type,
 * so one broken row cannot take the whole provider down.
 */
function parseModel(value: unknown, index: number): { model: ProviderModelConfig } | { reason: string } {
  const raw = asRecord(value);
  if (!raw) return { reason: `entry ${index} is not an object` };

  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  if (!id) return { reason: `entry ${index} has no id` };

  const contextWindow = finiteNumber(raw.contextWindow);
  if (contextWindow === undefined || contextWindow <= 0) {
    return { reason: `${id} has an invalid contextWindow` };
  }
  const maxTokens = finiteNumber(raw.maxTokens);
  if (maxTokens === undefined || maxTokens <= 0) {
    return { reason: `${id} has an invalid maxTokens` };
  }

  const cost = asRecord(raw.cost);
  if (!cost) return { reason: `${id} has no cost block` };
  const inputCost = rate(cost.input);
  const outputCost = rate(cost.output);
  const cacheReadCost = rate(cost.cacheRead);
  const cacheWriteCost = rate(cost.cacheWrite);
  if (
    inputCost === undefined ||
    outputCost === undefined ||
    cacheReadCost === undefined ||
    cacheWriteCost === undefined
  ) {
    return { reason: `${id} has an invalid cost block` };
  }

  const declaredInput = Array.isArray(raw.input)
    ? raw.input.filter((kind): kind is "text" | "image" => kind === "text" || kind === "image")
    : [];
  if (!declaredInput.includes("text")) return { reason: `${id} does not accept text input` };

  const declaredApi = raw.api === undefined ? undefined : String(raw.api);
  if (
    declaredApi !== undefined &&
    declaredApi !== "anthropic-messages" &&
    declaredApi !== "openai-completions"
  ) {
    return { reason: `${id} declares an api this extension cannot register ("${declaredApi}")` };
  }

  const model: ProviderModelConfig = {
    id,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id,
    reasoning: raw.reasoning === true,
    input: [...new Set(declaredInput)],
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead: cacheReadCost,
      cacheWrite: cacheWriteCost,
    },
    contextWindow,
    maxTokens,
  };
  if (declaredApi !== undefined) model.api = declaredApi;
  return { model };
}

/**
 * Reads and validates the static catalog. Never throws: callers get a possibly
 * empty list plus the reason it could not be used.
 */
export function loadCommandCodeCatalog(path: string = COMMANDCODE_MODELS_FILE): CommandCodeCatalog {
  let text: string;
  try {
    if (!existsSync(path)) return { models: [], skipped: [], fatal: `missing catalog: ${path}` };
    text = readFileSync(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { models: [], skipped: [], fatal: `cannot read ${path}: ${message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { models: [], skipped: [], fatal: `invalid JSON in ${path}: ${message}` };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { models: [], skipped: [], fatal: `${path} must contain a non-empty array` };
  }

  const models: ProviderModelConfig[] = [];
  const skipped: string[] = [];
  for (const [index, entry] of parsed.entries()) {
    const result = parseModel(entry, index);
    if ("model" in result) models.push(result.model);
    else skipped.push(result.reason);
  }

  if (!models.length) {
    return { models: [], skipped, fatal: `no valid model in ${path}` };
  }
  return { models, skipped };
}

/** One-line description of the catalog, used by the load error and `/aies-commandcode`. */
function describeCatalog(catalog: CommandCodeCatalog): string {
  const perApi = new Map<string, number>();
  for (const model of catalog.models) {
    const api = model.api ?? "openai-completions";
    perApi.set(api, (perApi.get(api) ?? 0) + 1);
  }
  const counts = [...perApi.entries()].map(([api, count]) => `${api}=${count}`).join(" ");
  const dropped = catalog.skipped.length ? `, ${catalog.skipped.length} skipped` : "";
  return `${catalog.models.length} models (${counts}${dropped})`;
}

/** Warns in every host; a notification must never be able to break a session. */
function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, type);
  } catch {
    // A host without notifications keeps the session silent rather than noisy.
  }
}

/** The narrow slice of the model registry this command reads. */
interface RegistryView {
  getProviderAuthStatus?: (provider: string) => unknown;
  getAvailable?: () => unknown;
}

/** A guarded registry view: a missing or non-object registry is `undefined`. */
function registryView(ctx: ExtensionContext | undefined): RegistryView | undefined {
  const registry = (ctx as { modelRegistry?: unknown } | undefined)?.modelRegistry;
  return registry && typeof registry === "object" ? (registry as RegistryView) : undefined;
}

/** The auth status fields this command renders. */
interface ProviderAuthView {
  configured: boolean;
  source?: string;
}

/** Pi's auth status for the provider, or `undefined` when the host cannot answer. */
function providerAuthView(ctx: ExtensionContext): ProviderAuthView | undefined {
  const registry = registryView(ctx);
  if (typeof registry?.getProviderAuthStatus !== "function") return undefined;
  try {
    const raw = registry.getProviderAuthStatus(COMMANDCODE_PROVIDER_ID);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const record = raw as { configured?: unknown; source?: unknown };
    return {
      configured: record.configured === true,
      ...(typeof record.source === "string" ? { source: record.source } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Human description of where the credential comes from; never a credential value. */
function authDescription(status: ProviderAuthView | undefined): string {
  if (status?.configured !== true) return "no conectado — ejecutá /login commandcode";
  switch (status.source) {
    case "stored":
      return "credencial guardada en auth.json — /login commandcode para cambiarla";
    case "environment":
      return "variable de entorno (COMMANDCODE_API_KEY)";
    case "runtime":
      return "clave de runtime (no persistida)";
    default:
      return status.source ? `configurada (${status.source})` : "configurada";
  }
}

/** How many `commandcode` models the registry offers right now; `0` when unknown. */
function availableModelCount(ctx: ExtensionContext): number {
  const registry = registryView(ctx);
  if (typeof registry?.getAvailable !== "function") return 0;
  try {
    const available = registry.getAvailable();
    if (!Array.isArray(available)) return 0;
    return available.filter((entry) => {
      const provider = (entry as { provider?: unknown } | undefined)?.provider;
      return provider === COMMANDCODE_PROVIDER_ID;
    }).length;
  } catch {
    return 0;
  }
}

export interface CommandCodeProviderOptions {
  /**
   * Catalog override for tests and experiments. Production loaders call the
   * factory with no options, so the committed file next to this module is used.
   */
  catalogPath?: string;
}

export default function aiesProviderCommandCode(
  pi: ExtensionAPI,
  { catalogPath = COMMANDCODE_MODELS_FILE }: CommandCodeProviderOptions = {},
) {
  const catalog = loadCommandCodeCatalog(catalogPath);

  if (catalog.fatal) {
    // Single load-time diagnostic: stdout/stderr is the only channel available
    // before the runner binds a UI, and the repository forbids stray logging.
    console.error(
      `aies-provider-commandcode: ${catalog.fatal}; the "${COMMANDCODE_PROVIDER_ID}" provider is not registered. ` +
        "Regenerate the catalog with: node scripts/refresh-commandcode-models.mjs",
    );
    pi.on("session_start", async (_event, ctx) => {
      notify(
        ctx,
        `Command Code no disponible: ${catalog.fatal}. Regenera el catálogo con scripts/refresh-commandcode-models.mjs`,
        "warning",
      );
    });
    return;
  }

  pi.registerProvider(COMMANDCODE_PROVIDER_ID, {
    name: COMMANDCODE_PROVIDER_NAME,
    baseUrl: COMMANDCODE_BASE_URL,
    apiKey: COMMANDCODE_API_KEY,
    api: "openai-completions",
    models: catalog.models,
  });

  pi.registerCommand("aies-commandcode", {
    description: "Show the Command Code provider catalog and its auth status",
    handler: async (_args, ctx) => {
      const rows = [
        `${COMMANDCODE_PROVIDER_NAME} · provider "${COMMANDCODE_PROVIDER_ID}"`,
        `  catálogo        ${describeCatalog(catalog)} (estático, ${catalogPath})`,
        `  baseUrl         ${COMMANDCODE_BASE_URL}`,
        `  auth            ${authDescription(providerAuthView(ctx))}`,
        `  disponibles     ${availableModelCount(ctx)}/${catalog.models.length} modelos`,
        "  regenerar       node scripts/refresh-commandcode-models.mjs",
      ];
      if (catalog.skipped.length) {
        rows.push(`  descartados    ${catalog.skipped.slice(0, 3).join("; ")}`);
      }
      notify(ctx, rows.join("\n"), "info");
    },
  });
}
