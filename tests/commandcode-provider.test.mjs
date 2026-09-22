/**
 * Command Code provider (`extensions/aies-provider-commandcode`).
 *
 * Everything here is offline and profile-free: the catalog is a committed
 * static file precisely because AIES startup must stay deterministic and
 * zero-network, so the test reads that file and drives the extension with a
 * fake `pi` object. No request is ever sent to api.commandcode.ai and the real
 * or ambient profile is never touched.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  COMMANDCODE_API_KEY,
  COMMANDCODE_BASE_URL,
  COMMANDCODE_MODELS_FILE,
  COMMANDCODE_PROVIDER_ID,
  COMMANDCODE_PROVIDER_NAME,
  default as commandCodeProvider,
  loadCommandCodeCatalog,
} from "../extensions/aies-provider-commandcode/index.ts";
import { deriveMaxTokens } from "../scripts/refresh-commandcode-models.mjs";

/** Catalog Pi accepts for a custom provider, checked structurally. */
const ALLOWED_APIS = new Set(["anthropic-messages", "openai-completions"]);
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"];

/** Models that must keep their per-model Anthropic transport. */
const ANTHROPIC_IDS = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
];

function readCatalogFile() {
  return JSON.parse(readFileSync(COMMANDCODE_MODELS_FILE, "utf8"));
}

/** Minimal stand-in for the extension API surface this extension uses. */
function fakePi() {
  const calls = { registerProvider: [], registerCommand: [], events: [] };
  return {
    calls,
    registerProvider(id, config) {
      calls.registerProvider.push({ id, config });
    },
    registerCommand(name, options) {
      calls.registerCommand.push({ name, options });
    },
    on(event, handler) {
      calls.events.push({ event, handler });
    },
  };
}

describe("Command Code static catalog (models.json)", () => {
  const catalog = readCatalogFile();

  it("is a non-empty array with unique, exact provider ids", () => {
    assert.ok(Array.isArray(catalog), "models.json must be an array");
    assert.ok(catalog.length >= 76, `expected the full published catalog, got ${catalog.length}`);

    const ids = catalog.map((model) => model.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate model id in the catalog");
    // The endpoint publishes vendor-prefixed ids for open-weight models and bare
    // ids for the first-party families; both are kept verbatim.
    assert.ok(ids.includes("claude-sonnet-5"));
    assert.ok(ids.includes("gpt-5.6-sol"));
    assert.ok(ids.includes("deepseek/deepseek-v4-flash"));
    assert.ok(ids.includes("Qwen/Qwen3.8-Max"));
    assert.ok(ids.includes("inclusionai/ling-3.0-flash-sante:free"));
  });

  it("declares only fields Pi can register, with sane numbers", () => {
    for (const model of catalog) {
      assert.equal(typeof model.id, "string");
      assert.equal(typeof model.name, "string");
      assert.ok(model.name.length > 0, `${model.id} has an empty name`);
      assert.equal(typeof model.reasoning, "boolean");
      assert.ok(Array.isArray(model.input) && model.input.includes("text"), `${model.id} needs text input`);
      for (const kind of model.input) assert.ok(["text", "image"].includes(kind), `${model.id}: ${kind}`);
      assert.ok(ALLOWED_APIS.has(model.api), `${model.id} declares api ${model.api}`);
      for (const key of COST_KEYS) {
        const rate = model.cost?.[key];
        assert.equal(typeof rate, "number", `${model.id}.cost.${key} must be a number`);
        assert.ok(Number.isFinite(rate) && rate >= 0, `${model.id}.cost.${key} = ${rate}`);
      }
      assert.ok(model.contextWindow > 0 && Number.isInteger(model.contextWindow), `${model.id} contextWindow`);
      assert.ok(model.maxTokens > 0 && model.maxTokens < model.contextWindow, `${model.id} maxTokens`);
    }
  });

  it("splits the transport by endpoint: Claude on /messages, everything else on chat", () => {
    const anthropic = catalog.filter((model) => model.api === "anthropic-messages").map((model) => model.id);
    assert.deepEqual(anthropic.sort(), [...ANTHROPIC_IDS].sort());
    for (const model of catalog.filter((m) => m.api !== "anthropic-messages")) {
      assert.equal(model.api, "openai-completions", `${model.id} must use the OpenAI transport`);
    }
  });

  it("keeps the base list price, not a promotional deal price", () => {
    const byId = new Map(catalog.map((model) => [model.id, model]));
    // MiniMax M3 runs a 50% deal (0.30/1.20) against a 0.60/2.40 list price.
    assert.equal(byId.get("MiniMaxAI/MiniMax-M3").cost.input, 0.6);
    assert.equal(byId.get("MiniMaxAI/MiniMax-M3").cost.output, 2.4);
    // Grok 4.7 is 40% off 2.00/6.00 while the deal lasts.
    assert.equal(byId.get("xai/grok-4.7").cost.input, 2);
    assert.equal(byId.get("xai/grok-4.7").cost.output, 6);
    // The free tier publishes no list price, so it stays at 0 rather than guessing.
    assert.equal(byId.get("poolside/laguna-s-2.1-free").cost.input, 0);
    assert.equal(byId.get("poolside/laguna-s-2.1-free").cost.output, 0);
  });

  it("marks vision and reasoning from the published capabilities", () => {
    const byId = new Map(catalog.map((model) => [model.id, model]));
    assert.deepEqual(byId.get("claude-sonnet-5").input, ["text", "image"]);
    assert.equal(byId.get("claude-sonnet-5").reasoning, true);
    assert.deepEqual(byId.get("deepseek/deepseek-v4-flash").input, ["text"]);
    assert.equal(byId.get("deepseek/deepseek-v4-flash-vision-exp").input.includes("image"), true);
    assert.ok(catalog.some((model) => model.input.includes("image")), "at least one multimodal model");
  });
});

describe("Command Code measured maxTokens overrides", () => {
  const catalog = readCatalogFile();
  const byId = new Map(catalog.map((model) => [model.id, model]));

  // The derivation is an assumption; a measured provider cap must survive a
  // regeneration instead of reverting to a value the API rejects.
  const OVERRIDDEN_ID = "poolside/laguna-s-2.1-free";
  const OVERRIDDEN_MAX_TOKENS = 32768;
  const MIN_MAX_TOKENS = 8192;
  const MAX_MAX_TOKENS = 64000;

  it("gives the overridden model its measured cap", () => {
    const model = byId.get(OVERRIDDEN_ID);
    assert.ok(model, `${OVERRIDDEN_ID} must be in the catalog`);
    assert.equal(model.maxTokens, OVERRIDDEN_MAX_TOKENS);
    // Its context window would derive 64000, so only the override explains 32768.
    assert.equal(
      Math.max(MIN_MAX_TOKENS, Math.min(MAX_MAX_TOKENS, Math.floor(model.contextWindow / 4))),
      MAX_MAX_TOKENS,
    );
  });

  it("returns the override for the overridden id regardless of contextWindow", () => {
    for (const contextWindow of [1, 256000, 100000000]) {
      assert.equal(deriveMaxTokens(contextWindow, OVERRIDDEN_ID), OVERRIDDEN_MAX_TOKENS);
    }
  });

  it("derives the clamped assumption for a non-overridden id", () => {
    assert.equal(deriveMaxTokens(128000, "deepseek/deepseek-v4-flash"), 32000);
    assert.equal(deriveMaxTokens(1000000, "some-unlisted-model"), MAX_MAX_TOKENS);
    assert.equal(deriveMaxTokens(1000, "some-unlisted-model"), MIN_MAX_TOKENS);
  });

  it("keeps every committed maxTokens inside the documented range and below contextWindow", () => {
    for (const model of catalog) {
      assert.ok(
        model.maxTokens >= MIN_MAX_TOKENS && model.maxTokens <= MAX_MAX_TOKENS,
        `${model.id} maxTokens ${model.maxTokens} outside ${MIN_MAX_TOKENS}..${MAX_MAX_TOKENS}`,
      );
      assert.ok(model.maxTokens <= model.contextWindow, `${model.id} maxTokens > contextWindow`);
    }
  });
});

describe("Command Code extension factory", () => {
  it("registers one provider carrying the whole catalog", () => {
    const pi = fakePi();
    commandCodeProvider(pi);

    assert.equal(pi.calls.registerProvider.length, 1);
    const [provider] = pi.calls.registerProvider;
    assert.equal(provider.id, COMMANDCODE_PROVIDER_ID);
    assert.equal(provider.config.name, COMMANDCODE_PROVIDER_NAME);
    assert.equal(provider.config.baseUrl, COMMANDCODE_BASE_URL);
    assert.equal(provider.config.apiKey, COMMANDCODE_API_KEY);
    assert.equal(provider.config.api, "openai-completions");
    assert.ok(!/sk-|Bearer /.test(JSON.stringify(provider.config)), "no credential material in the config");

    const registered = readCatalogFile();
    assert.equal(provider.config.models.length, registered.length);
    assert.deepEqual(
      provider.config.models.map((model) => model.id).sort(),
      registered.map((model) => model.id).sort(),
    );
    assert.equal(pi.calls.events.length, 0, "a healthy catalog must not warn on session start");
    assert.ok(
      pi.calls.registerCommand.some((command) => command.name === "aies-commandcode"),
      "the provider exposes a diagnostic command",
    );
  });

  it("reports the catalog and its auth status through /aies-commandcode", async () => {
    const catalog = readCatalogFile();
    const anthropic = catalog.filter((model) => model.api === "anthropic-messages").length;

    const pi = fakePi();
    commandCodeProvider(pi);
    const command = pi.calls.registerCommand.find((entry) => entry.name === "aies-commandcode");
    assert.ok(command, "the diagnostic command was not registered");

    const shown = [];
    const ctx = {
      ui: { notify: (message, type) => shown.push({ message, type }) },
      modelRegistry: {
        getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
        getAvailable: () =>
          Array.from({ length: catalog.length }, (_value, index) => ({
            provider: COMMANDCODE_PROVIDER_ID,
            id: `m${index}`,
          })),
      },
    };
    await command.options.handler("", ctx);

    assert.equal(shown.length, 1);
    assert.equal(shown[0].type, "info");
    assert.match(shown[0].message, /provider "commandcode"/);
    assert.ok(
      shown[0].message.includes(
        `${catalog.length} models (anthropic-messages=${anthropic} openai-completions=${catalog.length - anthropic})`,
      ),
      `unexpected report:\n${shown[0].message}`,
    );
    assert.match(shown[0].message, /credencial guardada/);
    assert.match(shown[0].message, /api\.commandcode\.ai\/provider\/v1/);
    assert.ok(!/sk-[A-Za-z0-9]/.test(shown[0].message), "the report must never print a key");
  });

  it("never throws on a broken catalog, registers nothing and says why once", () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-commandcode-"));
    const originalError = console.error;
    try {
      const cases = [
        ["missing file", null],
        ["invalid json", "{ not json"],
        ["empty array", "[]"],
        ["array of junk", '[{"id":"x"},42]'],
      ];

      for (const [label, body] of cases) {
        const path = join(dir, `${label.replace(/\W+/g, "-")}.json`);
        if (body !== null) writeFileSync(path, body, "utf8");

        const catalog = loadCommandCodeCatalog(path);
        assert.equal(catalog.models.length, 0, `${label}: must not register anything`);
        assert.ok(catalog.fatal, `${label}: must report a reason`);

        const diagnostics = [];
        console.error = (message) => {
          diagnostics.push(String(message));
        };
        const pi = fakePi();
        try {
          commandCodeProvider(pi, { catalogPath: path });
        } finally {
          console.error = originalError;
        }

        assert.equal(pi.calls.registerProvider.length, 0, `${label}: provider must stay unregistered`);
        assert.equal(diagnostics.length, 1, `${label}: exactly one load-time diagnostic`);
        assert.match(diagnostics[0], /refresh-commandcode-models\.mjs/);
        assert.equal(pi.calls.events.length, 1, `${label}: warns once on session start`);
      }
    } finally {
      console.error = originalError;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops the invalid rows but keeps the rest of the catalog", () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-commandcode-partial-"));
    try {
      const path = join(dir, "models.json");
      writeFileSync(
        path,
        JSON.stringify([
          {
            id: "good-model",
            name: "Good Model",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
            contextWindow: 200000,
            maxTokens: 50000,
            api: "openai-completions",
          },
          { id: "no-cost", contextWindow: 100, maxTokens: 10, input: ["text"] },
          {
            id: "wrong-api",
            name: "Wrong API",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100000,
            maxTokens: 4096,
            api: "grpc-stream",
          },
        ]),
        "utf8",
      );

      const catalog = loadCommandCodeCatalog(path);
      assert.equal(catalog.fatal, undefined);
      assert.deepEqual(catalog.models.map((model) => model.id), ["good-model"]);
      assert.equal(catalog.skipped.length, 2);
      assert.deepEqual(catalog.models[0].input, ["text", "image"]);

      const pi = fakePi();
      commandCodeProvider(pi, { catalogPath: path });
      assert.equal(pi.calls.registerProvider.length, 1, "a partially valid catalog still registers");
      assert.deepEqual(
        pi.calls.registerProvider[0].config.models.map((model) => model.id),
        ["good-model"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Command Code registry-driven auth reporting", () => {
  const CATALOG_SIZE = readCatalogFile().length;

  /** `count` fake commandcode models, as `getAvailable()` returns them. */
  function availableModels(count = CATALOG_SIZE) {
    return Array.from({ length: count }, (_value, index) => ({
      provider: COMMANDCODE_PROVIDER_ID,
      id: `m${index}`,
    }));
  }

  /** A fake registry with the given auth status and available models. */
  function registry({ status, available = availableModels() } = {}) {
    return {
      getProviderAuthStatus: () => status,
      getAvailable: () => available,
    };
  }

  /** Run the registered `/aies-commandcode` handler and return its notification. */
  async function report(ctx) {
    const pi = fakePi();
    commandCodeProvider(pi);
    const command = pi.calls.registerCommand.find((entry) => entry.name === "aies-commandcode");
    assert.ok(command, "the diagnostic command was not registered");
    const shown = [];
    await command.options.handler("", {
      ...ctx,
      ui: { notify: (message, type) => shown.push({ message, type }) },
    });
    assert.equal(shown.length, 1);
    return shown[0];
  }

  it("reports a missing credential as disconnected with zero available models", async () => {
    const { message } = await report({
      modelRegistry: registry({ status: { configured: false }, available: [] }),
    });
    assert.match(message, /no conectado/);
    assert.match(message, /\/login commandcode/);
    assert.match(message, /0\/76 modelos/);
  });

  it("reports a stored credential as connected", async () => {
    const { message } = await report({
      modelRegistry: registry({ status: { configured: true, source: "stored" } }),
    });
    assert.match(message, /credencial guardada/);
    assert.match(message, /76\/76 modelos/);
    assert.equal(message.includes("no conectado"), false);
  });

  it("names the environment variable as the credential source", async () => {
    const { message } = await report({
      modelRegistry: registry({
        status: { configured: true, source: "environment", label: "COMMANDCODE_API_KEY" },
      }),
    });
    assert.match(message, /variable de entorno/);
    assert.match(message, /COMMANDCODE_API_KEY/);
  });

  it("names a non-persisted runtime key", async () => {
    const { message } = await report({
      modelRegistry: registry({ status: { configured: true, source: "runtime" } }),
    });
    assert.match(message, /no persistida/);
  });

  it("falls back to a plain configured line when the source is absent", async () => {
    const { message } = await report({ modelRegistry: registry({ status: { configured: true } }) });
    assert.match(message, /configurada/);
  });

  it("keeps reporting a stored credential when the environment variable is gone", async () => {
    const previous = process.env.COMMANDCODE_API_KEY;
    delete process.env.COMMANDCODE_API_KEY;
    try {
      const { message } = await report({
        modelRegistry: registry({ status: { configured: true, source: "stored" } }),
      });
      assert.match(message, /credencial guardada/);
      assert.equal(message.includes("no conectado"), false);
    } finally {
      if (previous === undefined) delete process.env.COMMANDCODE_API_KEY;
      else process.env.COMMANDCODE_API_KEY = previous;
    }
  });

  it("degrades without throwing for a missing, partial or hostile registry", async () => {
    const cases = [
      {},
      { modelRegistry: {} },
      {
        modelRegistry: {
          getProviderAuthStatus: () => {
            throw new Error("boom");
          },
          getAvailable: () => availableModels(),
        },
      },
      {
        modelRegistry: {
          getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
          getAvailable: () => {
            throw new Error("boom");
          },
        },
      },
    ];

    for (const ctx of cases) {
      const { message } = await report(ctx);
      assert.match(message, /catálogo/, `catalog line missing for ${JSON.stringify(ctx)}`);
      assert.match(message, /baseUrl/);
      assert.match(message, /regenerar/);
      assert.match(message, /disponibles/);
    }
  });

  it("never renders credential-looking material", async () => {
    for (const status of [
      { configured: false },
      { configured: true, source: "stored" },
      { configured: true, source: "environment", label: "COMMANDCODE_API_KEY" },
      { configured: true },
    ]) {
      const { message } = await report({ modelRegistry: registry({ status }) });
      assert.ok(!/sk-[A-Za-z0-9]/.test(message), "no api-key shape");
      assert.ok(!/Bearer /.test(message), "no bearer token");
      assert.ok(!/-----BEGIN/.test(message), "no PEM block");
      assert.ok(!/eyJ[A-Za-z0-9_-]{8,}/.test(message), "no JWT");
    }
  });
});
