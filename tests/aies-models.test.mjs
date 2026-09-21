/**
 * AIES-010D / T12: profile-local theme and `/aies-models`.
 *
 * Regression-first coverage for the registry-backed model picker:
 * 1. Thinking effort is capability-valid from real model metadata.
 * 2. Choices come only from `ctx.modelRegistry.getAvailable()`.
 * 3. The overlay is keyboard-first and pure/testable.
 * 4. Headless mode prints bounded readable text and never calls custom UI.
 * 5. Child preferences persist atomically into the isolated profile.
 * 6. Parent defaults persist through Pi's public `SettingsManager`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  THINKING_LEVELS,
  availableModelOptions,
  isThinkingLevelSupported,
  normalizeThinkingLevel,
  projectModelOption,
  supportedThinkingLevels,
} from "../extensions/aies-models/capabilities.ts";
import {
  AIES_CONFIG_FILE,
  persistParentDefaults,
  readChildPreference,
  readChildPreferences,
  writeChildPreference,
} from "../extensions/aies-models/config.ts";
import {
  ROLE_ORDER,
  createOverlayState,
  decodeOverlayKey,
  reduceOverlayKey,
  renderOverlayState,
} from "../extensions/aies-models/overlay.ts";
import { renderHeadlessModels } from "../extensions/aies-models/headless.ts";
import aiesModels, { handleModelsCommand } from "../extensions/aies-models/index.ts";

const tempDirs = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function model(overrides = {}) {
  return {
    provider: "faux",
    id: "faux-1",
    name: "Faux Model",
    reasoning: false,
    ...overrides,
  };
}

function option(overrides = {}) {
  const projected = projectModelOption(model(overrides));
  assert.ok(projected, "projectModelOption must project a valid model");
  return projected;
}

describe("thinking capability", () => {
  it("offers only off for a non-reasoning model", () => {
    assert.deepEqual(supportedThinkingLevels(model({ reasoning: false })), ["off"]);
    assert.equal(isThinkingLevelSupported(model({ reasoning: false }), "off"), true);
    assert.equal(isThinkingLevelSupported(model({ reasoning: false }), "low"), false);
  });

  it("offers ordinary levels through high for a reasoning model without a map", () => {
    assert.deepEqual(supportedThinkingLevels(model({ reasoning: true })), [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("never offers xhigh or max unless the map explicitly supports them", () => {
    const levels = supportedThinkingLevels(
      model({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );
    assert.deepEqual(levels, ["off", "minimal", "low", "medium", "high", "xhigh"]);
    assert.equal(isThinkingLevelSupported(model({ reasoning: true }), "max"), false);
  });

  it("drops levels mapped to null, including off", () => {
    const modelLike = model({
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
    });
    assert.deepEqual(supportedThinkingLevels(modelLike), ["high", "max"]);
    assert.equal(isThinkingLevelSupported(modelLike, "off"), false);
    assert.equal(isThinkingLevelSupported(modelLike, "medium"), false);
  });

  it("normalizes only to a supported level and never clamps", () => {
    const reasoning = model({ reasoning: true });
    assert.equal(normalizeThinkingLevel(reasoning, "high"), "high");
    assert.equal(normalizeThinkingLevel(reasoning, "xhigh"), undefined);
    assert.equal(normalizeThinkingLevel(model({ reasoning: false }), "off"), "off");
    assert.equal(normalizeThinkingLevel(model({ reasoning: false }), "low"), undefined);
  });

  it("returns no choices for a missing model", () => {
    assert.deepEqual(supportedThinkingLevels(undefined), []);
    assert.deepEqual(supportedThinkingLevels(null), []);
  });

  it("keeps the canonical level order stable", () => {
    assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("available model projection", () => {
  it("projects only the available models", () => {
    const available = model({ id: "available-1", name: "Available One" });
    const hidden = model({ id: "hidden-1", name: "Hidden One" });
    const registry = {
      getAvailable: () => [available],
      getAll: () => [available, hidden],
    };

    const options = availableModelOptions(registry);
    assert.equal(options.length, 1);
    assert.equal(options[0].id, "available-1");
    assert.equal(options[0].value, "faux/available-1");
    assert.ok(options[0].label.includes("faux"));
    assert.ok(options[0].label.includes("Available One"));
  });

  it("degrades to an empty list for a missing or throwing registry", () => {
    assert.deepEqual(availableModelOptions(undefined), []);
    assert.deepEqual(
      availableModelOptions({
        getAvailable() {
          throw new Error("boom");
        },
      }),
      [],
    );
  });

  it("labels the provider and model clearly and carries capability levels", () => {
    const projected = option({ id: "deep", name: "Deep", reasoning: true });
    assert.equal(projected.provider, "faux");
    assert.equal(projected.id, "deep");
    assert.equal(projected.name, "Deep");
    assert.equal(projected.reasoning, true);
    assert.deepEqual(projected.levels, ["off", "minimal", "low", "medium", "high"]);
  });

  it("rejects a model without a provider or id", () => {
    assert.equal(projectModelOption({ name: "no ids" }), undefined);
    assert.equal(projectModelOption(undefined), undefined);
  });
});

describe("overlay keyboard flow", () => {
  const context = {
    models: [
      option({ id: "m1", reasoning: true }),
      option({ id: "m2", reasoning: true }),
      option({ id: "m3", reasoning: true }),
    ],
  };

  it("decodes arrows, j/k, h/l, confirm, quit and esc", () => {
    assert.equal(decodeOverlayKey("\x1b[A"), "up");
    assert.equal(decodeOverlayKey("\x1b[B"), "down");
    assert.equal(decodeOverlayKey("k"), "up");
    assert.equal(decodeOverlayKey("j"), "down");
    assert.equal(decodeOverlayKey("\x1b[D"), "left");
    assert.equal(decodeOverlayKey("\x1b[C"), "right");
    assert.equal(decodeOverlayKey("h"), "left");
    assert.equal(decodeOverlayKey("l"), "right");
    assert.equal(decodeOverlayKey("\r"), "confirm");
    assert.equal(decodeOverlayKey("\n"), "confirm");
    assert.equal(decodeOverlayKey("\x13"), "confirm");
    assert.equal(decodeOverlayKey("q"), "quit");
    assert.equal(decodeOverlayKey("\x1b"), "escape");
    assert.equal(decodeOverlayKey("x"), undefined);
  });

  it("moves the role selection with arrows and j/k", () => {
    let state = createOverlayState();
    assert.equal(state.roleIndex, 0);
    state = reduceOverlayKey(state, "down", context);
    assert.equal(state.roleIndex, 1);
    state = reduceOverlayKey(state, "k", context);
    assert.equal(state.roleIndex, 0);
    // Clamped, never wrapped.
    state = reduceOverlayKey(state, "up", context);
    assert.equal(state.roleIndex, 0);
  });

  it("advances role -> model -> thinking and confirms a selection", () => {
    let state = createOverlayState();
    state = reduceOverlayKey(state, "enter", context);
    assert.equal(state.step, "model");
    assert.equal(state.role, "parent");
    state = reduceOverlayKey(state, "j", context);
    assert.equal(state.modelIndex, 1);
    state = reduceOverlayKey(state, "enter", context);
    assert.equal(state.step, "thinking");
    assert.equal(state.model.id, "m2");
    state = reduceOverlayKey(state, "enter", context);
    assert.equal(state.step, "done");
    assert.equal(state.thinking, "off");
  });

  it("goes back one screen on escape and cancels from the first", () => {
    let state = createOverlayState();
    state = reduceOverlayKey(state, "enter", context);
    state = reduceOverlayKey(state, "enter", context);
    assert.equal(state.step, "thinking");
    state = reduceOverlayKey(state, "escape", context);
    assert.equal(state.step, "model");
    state = reduceOverlayKey(state, "escape", context);
    assert.equal(state.step, "role");
    state = reduceOverlayKey(state, "escape", context);
    assert.equal(state.cancelled, true);
  });

  it("renders a bounded, keyboard-first view for every step", () => {
    for (const step of ["role", "model"]) {
      let state = createOverlayState();
      if (step === "model") state = reduceOverlayKey(state, "enter", context);
      const view = renderOverlayState(state, context);
      assert.ok(view.lines.length > 0);
      assert.ok(view.lines.some((line) => line.includes("›")));
      assert.ok(view.help.length > 0);
    }
  });

  it("exposes the four preference roles in product order", () => {
    assert.deepEqual(ROLE_ORDER, ["parent", "explore", "worker", "verify"]);
  });
});

describe("headless projection", () => {
  it("prints bounded readable text without any custom UI", () => {
    const models = Array.from({ length: 60 }, (_value, index) => option({ id: `m${index}`, name: `Model ${index}` }));
    const text = renderHeadlessModels({
      models,
      preferences: { parent: { model: "faux/m0", thinkingLevel: "high" } },
      maxLines: 10,
      maxChars: 500,
    });

    const lines = text.split("\n");
    assert.ok(lines.length <= 10, `expected <= 10 lines, got ${lines.length}`);
    assert.ok(text.length <= 500, `expected <= 500 chars, got ${text.length}`);
    assert.match(text, /Parent/u);
    assert.match(text, /faux\/m0/u);
  });
});

describe("isolated child configuration", () => {
  it("preserves unrelated keys and writes atomically", () => {
    const dir = tempDir("aies-models-config-");
    writeFileSync(
      join(dir, AIES_CONFIG_FILE),
      JSON.stringify({
        $schema: "schema",
        agents: { explore: { model: "faux/m1" } },
        permissions: { sandbox: true },
      }),
    );

    const result = writeChildPreference(dir, "worker", {
      model: "faux/m2",
      thinkingLevel: "high",
    });
    assert.deepEqual(result, { ok: true });

    const written = JSON.parse(readFileSync(join(dir, AIES_CONFIG_FILE), "utf8"));
    assert.equal(written.permissions.sandbox, true);
    assert.equal(written.agents.explore.model, "faux/m1");
    assert.deepEqual(written.agents.worker, { model: "faux/m2", thinkingLevel: "high" });

    // Atomic rename leaves no temporary sibling behind.
    assert.deepEqual(readdirSync(dir), [AIES_CONFIG_FILE]);

    const preference = readChildPreference(dir, "worker");
    assert.deepEqual(preference, { model: "faux/m2", thinkingLevel: "high" });
  });

  it("refuses to clobber an unparseable config", () => {
    const dir = tempDir("aies-models-invalid-");
    const path = join(dir, AIES_CONFIG_FILE);
    writeFileSync(path, "{ this is not json");

    const result = writeChildPreference(dir, "verify", { model: "faux/m3" });
    assert.equal(result.ok, false);
    assert.equal(readFileSync(path, "utf8"), "{ this is not json");
  });

  it("fails safely when the isolated agent dir is absent", () => {
    const result = writeChildPreference(undefined, "explore", { model: "faux/m1" });
    assert.equal(result.ok, false);
  });

  it("returns no preferences for a missing or unreadable file", () => {
    assert.deepEqual(readChildPreferences(join(tmpdir(), "aies-nonexistent-dir-xyz")), {});
  });
});

describe("parent default persistence", () => {
  it("persists default provider, model and model thinking level through SettingsManager", async () => {
    const agentDir = tempDir("aies-models-parent-");
    const cwd = tempDir("aies-models-cwd-");

    const result = await persistParentDefaults({
      cwd,
      agentDir,
      provider: "faux",
      modelId: "faux-1",
      thinkingLevel: "high",
    });
    assert.deepEqual(result, { ok: true });

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.defaultProvider, "faux");
    assert.equal(settings.defaultModel, "faux-1");
    assert.equal(settings.modelThinkingLevels["faux/faux-1"], "high");
  });

  it("fails safely when PI_CODING_AGENT_DIR is absent", async () => {
    const cwd = tempDir("aies-models-cwd-");
    const result = await persistParentDefaults({
      cwd,
      agentDir: undefined,
      provider: "faux",
      modelId: "faux-1",
    });
    assert.equal(result.ok, false);
  });

  it("persists an explicitly supported extended level without dropping it", async () => {
    const agentDir = tempDir("aies-models-parent-");
    const cwd = tempDir("aies-models-cwd-");

    const result = await persistParentDefaults({
      cwd,
      agentDir,
      provider: "faux",
      modelId: "deep",
      thinkingLevel: "xhigh",
      model: { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
    });
    assert.deepEqual(result, { ok: true });

    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    assert.equal(settings.modelThinkingLevels["faux/deep"], "xhigh");
  });
});

describe("command wiring", () => {
  function fakePi() {
    const commands = [];
    return {
      commands,
      setModel: async () => true,
      setThinkingLevel() {},
      registerCommand(name, definition) {
        commands.push({ name, definition });
      },
    };
  }

  it("registers the /aies-models command", () => {
    const pi = fakePi();
    aiesModels(pi);
    assert.deepEqual(pi.commands.map((command) => command.name), ["aies-models"]);
  });

  it("never calls custom UI in headless mode and prints bounded text", async () => {
    const notifications = [];
    let customCalls = 0;
    const ctx = {
      mode: "print",
      hasUI: false,
      cwd: "/tmp",
      model: undefined,
      modelRegistry: { getAvailable: () => [model()] },
      ui: {
        notify: (message) => notifications.push(message),
        custom: () => {
          customCalls += 1;
          return Promise.resolve(null);
        },
      },
    };

    await handleModelsCommand(fakePi(), ctx);
    assert.equal(customCalls, 0, "headless must never call custom UI");
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0].length > 0);
  });

  it("uses a keyboard-first overlay in TUI mode and persists a child preference", async () => {
    const agentDir = tempDir("aies-models-command-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    let overlayOptions;
    let component;
    const pi = fakePi();
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: "/tmp",
      model: undefined,
      modelRegistry: { getAvailable: () => [model({ reasoning: true })] },
      ui: {
        notify() {},
        custom(factory, options) {
          overlayOptions = options;
          component = factory(
            { requestRender() {} },
            { fg: (_color, text) => text, bold: (text) => text },
            { matches: () => false },
            () => {},
          );
          assert.ok(component, "the overlay factory must return a component");
          return new Promise((resolve) => {
            // Confirm the preselected model + default thinking level.
            component.handleInput("\r"); // role -> model
            component.handleInput("\r"); // model -> thinking
            component.handleInput("\r"); // thinking -> done
            resolve({ role: "worker", option: option({ id: "faux-1" }), thinkingLevel: "high" });
          });
        },
      },
    };

    try {
      await handleModelsCommand(pi, ctx);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }

    assert.equal(overlayOptions?.overlay, true, "TUI must use the overlay custom UI");
    const written = JSON.parse(readFileSync(join(agentDir, AIES_CONFIG_FILE), "utf8"));
    assert.equal(written.agents.worker.model, "faux/faux-1");
    assert.equal(written.agents.worker.thinkingLevel, "high");
  });

  it("refuses visibly and persists nothing when Pi rejects the Parent model", async () => {
    const agentDir = tempDir("aies-models-refuse-");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const notifications = [];
    const pi = { ...fakePi(), setModel: async () => false };
    const ctx = {
      mode: "tui",
      hasUI: true,
      cwd: "/tmp",
      model: undefined,
      modelRegistry: { getAvailable: () => [model()] },
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
        custom: () =>
          Promise.resolve({ role: "parent", option: option({ id: "faux-1" }), thinkingLevel: "off" }),
      },
    };

    try {
      await handleModelsCommand(pi, ctx);
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }

    assert.ok(
      notifications.some((entry) => entry.type === "error"),
      "a rejected session model must stay visible as an error",
    );
    assert.equal(
      existsSync(join(agentDir, "settings.json")),
      false,
      "a rejected Parent selection must not persist any default",
    );
  });
});
