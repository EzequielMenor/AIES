/**
 * AIES-010D bugfix + EZE-453 / T10: `/aies-models` keyboard handling.
 *
 * Regression-first coverage for the frozen-UI bug where arrows, Esc and the
 * confirm keys were dead because the overlay ignored the keybindings manager Pi
 * injects into `ctx.ui.custom()` and hand-matched legacy raw bytes only.
 *
 * The tests drive the real `handleModelsCommand` command through a fake TUI
 * host, so they exercise the whole path: keybindings manager -> decoder ->
 * reducer -> done/apply. Pure reducer cases cover the parts that are hard to
 * observe through the host, including T10's type-ahead search and `all`/`scoped`
 * toggle.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { projectModelOption } from "../extensions/aies-models/capabilities.ts";
import { AIES_CONFIG_FILE } from "../extensions/aies-models/config.ts";
import {
  activeSections,
  createOverlayState,
  decodeOverlayKey,
  reduceOverlayKey,
  visibleModels,
} from "../extensions/aies-models/overlay.ts";
import { handleModelsCommand } from "../extensions/aies-models/index.ts";

const tempDirs = [];
const envRestorers = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Isolate the profile so no selection can ever touch an ambient Pi install. */
function useAgentDir() {
  const dir = tempDir("aies-models-keys-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  envRestorers.push(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return dir;
}

afterEach(() => {
  while (envRestorers.length) envRestorers.pop()();
  while (tempDirs.length) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function model(overrides = {}) {
  return { provider: "faux", id: "faux-1", name: "Faux Model", reasoning: false, ...overrides };
}

function option(overrides = {}) {
  const projected = projectModelOption(model(overrides));
  assert.ok(projected, "projectModelOption must project a valid model");
  return projected;
}

/** A hand-built usable section. */
function section(id, models, overrides = {}) {
  return { id, name: overrides.name ?? id, state: "usable", models, totalModels: models.length, ...overrides };
}

/** A hand-built T10 `OverlayContext`. */
function overlayContext({ usable = [], scopedUsable, hasScoped = false, notUsable, assignments = [] } = {}) {
  return {
    usable,
    scopedUsable: scopedUsable ?? usable,
    hasScoped,
    notUsable: notUsable ?? { count: 0, names: [], extra: 0 },
    assignments,
  };
}

/** A minimal keybindings manager shaped like the one Pi injects. */
function fakeKeybindings(map) {
  return {
    matches(data, action) {
      const keys = map[action];
      return Array.isArray(keys) ? keys.includes(data) : false;
    },
  };
}

function fakePi() {
  return {
    setModel: async () => true,
    setThinkingLevel() {},
  };
}

/**
 * A reusable fake TUI host. Every `ctx.ui.custom()` call records a session so
 * the same context can be reopened (as a real command can).
 */
function createHost({ models, keybindings, scopedModels, sessionModel, thinkingLevel }) {
  const sessions = [];
  const pi = fakePi();
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    model: sessionModel,
    thinkingLevel,
    scopedModels,
    modelRegistry: { getAvailable: () => models },
    ui: {
      notify() {},
      custom(factory) {
        let resolve;
        const promise = new Promise((settle) => {
          resolve = settle;
        });
        const doneCalls = [];
        const component = factory(
          { requestRender() {} },
          { fg: (_color, text) => text, bold: (text) => text },
          keybindings ?? { matches: () => false },
          (result) => {
            doneCalls.push(result);
            resolve(result);
          },
        );
        const session = { component, doneCalls, promise };
        sessions.push(session);
        return promise;
      },
    },
  };
  return {
    pi,
    ctx,
    sessions,
    get session() {
      return sessions[sessions.length - 1];
    },
  };
}

/** Run the command and hand back its promise plus the overlay session it opened. */
function open(host) {
  const command = handleModelsCommand(host.pi, host.ctx);
  return { command, session: host.session };
}

/**
 * The label of the currently marked row in the overlay, without the marker and
 * without the shared modal frame's chrome. The frame change (T1) means the
 * marked row now reads `│ › Explore   │`, so the helper locates the marker
 * anywhere on the line instead of assuming it starts the line.
 */
function selectedLabel(component, width = 80) {
  for (const line of component.render(width)) {
    const index = line.indexOf("› ");
    if (index < 0) continue;
    const rest = line.slice(index + 2);
    const end = rest.endsWith(" │") ? rest.length - 2 : rest.length;
    return rest.slice(0, end).trim();
  }
  return undefined;
}

/** The role label of the marked row, without its assignment suffix. */
function selectedRole(component, width = 80) {
  const label = selectedLabel(component, width);
  if (label === undefined) return undefined;
  const separator = label.indexOf(" · ");
  return separator < 0 ? label : label.slice(0, separator).trim();
}

/** Feed one or more keys to the overlay, one call per key as the host does. */
function press(session, ...keys) {
  for (const key of keys) session.component.handleInput(key);
}

describe("raw key decoding (fallback)", () => {
  it("maps arrows, vim keys, effort keys, confirm, escape and quit outside the model step", () => {
    assert.equal(decodeOverlayKey("\x1b[A"), "up");
    assert.equal(decodeOverlayKey("k"), "up");
    assert.equal(decodeOverlayKey("\x1b[B"), "down");
    assert.equal(decodeOverlayKey("j"), "down");
    assert.equal(decodeOverlayKey("\x1b[D"), "left");
    assert.equal(decodeOverlayKey("h"), "left");
    assert.equal(decodeOverlayKey("\x1b[C"), "right");
    assert.equal(decodeOverlayKey("l"), "right");
    assert.equal(decodeOverlayKey("\r"), "confirm");
    assert.equal(decodeOverlayKey("\n"), "confirm");
    assert.equal(decodeOverlayKey("enter"), "confirm");
    assert.equal(decodeOverlayKey("return"), "confirm");
    assert.equal(decodeOverlayKey("\x13"), "confirm");
    assert.equal(decodeOverlayKey("\x1b"), "escape");
    assert.equal(decodeOverlayKey("escape"), "escape");
    assert.equal(decodeOverlayKey("esc"), "escape");
    assert.equal(decodeOverlayKey("q"), "quit");
    assert.equal(decodeOverlayKey("x"), undefined);
  });

  it("keeps the letter aliases outside the model step and types them inside it", () => {
    assert.equal(decodeOverlayKey("k", "provider"), "up");
    assert.equal(decodeOverlayKey("j", "role"), "down");
    assert.equal(decodeOverlayKey("h", "thinking"), "left");
    assert.equal(decodeOverlayKey("l", "provider"), "right");
    assert.equal(decodeOverlayKey("q", "provider"), "quit");
    assert.deepEqual(decodeOverlayKey("j", "model"), { type: "char", value: "j" });
    assert.deepEqual(decodeOverlayKey("k", "model"), { type: "char", value: "k" });
    assert.deepEqual(decodeOverlayKey("h", "model"), { type: "char", value: "h" });
    assert.deepEqual(decodeOverlayKey("l", "model"), { type: "char", value: "l" });
    assert.deepEqual(decodeOverlayKey("q", "model"), { type: "char", value: "q" });
  });

  it("decodes Tab and Backspace and rejects CSI sequences", () => {
    assert.equal(decodeOverlayKey("\t"), "scope");
    assert.equal(decodeOverlayKey("\x7f"), "backspace");
    assert.equal(decodeOverlayKey("\x08"), "backspace");
    assert.equal(decodeOverlayKey("\x1b[A", "model"), "up");
    assert.equal(decodeOverlayKey("\x1b[1;1A", "model"), undefined);
    assert.equal(decodeOverlayKey("\x1b[Z", "model"), undefined);
  });

  it("accepts accented and astral characters as text", () => {
    assert.deepEqual(decodeOverlayKey("á", "model"), { type: "char", value: "á" });
    assert.deepEqual(decodeOverlayKey("👍", "model"), { type: "char", value: "👍" });
    assert.equal(decodeOverlayKey("á", "role"), undefined);
  });

  it("keeps the raw fallback alive when the manager throws", async () => {
    const keybindings = {
      matches() {
        throw new Error("unusable manager");
      },
    };
    const host = createHost({ models: [option({ id: "m1" })], keybindings });
    const { command, session } = open(host);
    session.component.handleInput("j"); // raw down -> explore
    assert.equal(selectedRole(session.component), "Explore");
    session.component.handleInput("\x1b[A"); // raw up -> parent
    assert.equal(selectedRole(session.component), "Parent");
    press(session, "\r", "\r", "\r"); // confirm through
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
  });
});

describe("arrow up/down symmetry", () => {
  it("treats raw ArrowUp and k as the same up action", async () => {
    for (const up of ["\x1b[A", "k"]) {
      const host = createHost({ models: [option({ id: "m1" })] });
      const { command, session } = open(host);
      session.component.handleInput("j"); // down to explore
      assert.equal(selectedRole(session.component), "Explore");
      session.component.handleInput(up); // up back to parent
      assert.equal(selectedRole(session.component), "Parent", `up=${JSON.stringify(up)}`);
      press(session, "\r", "\r", "\r");
      await command;
      assert.equal(session.doneCalls[0].role, "parent");
    }
  });

  it("treats raw ArrowDown and j as the same down action", async () => {
    for (const down of ["\x1b[B", "j"]) {
      const host = createHost({ models: [option({ id: "m1" })] });
      const { command, session } = open(host);
      session.component.handleInput(down);
      assert.equal(selectedRole(session.component), "Explore", `down=${JSON.stringify(down)}`);
      press(session, "\r", "\r", "\r");
      await command;
      assert.equal(session.doneCalls[0].role, "explore");
    }
  });

  it("moves up and down through a manager-mapped Kitty payload", async () => {
    const keybindings = fakeKeybindings({
      "tui.select.up": ["\x1b[1;1A"],
      "tui.select.down": ["\x1b[1;1B"],
    });
    const host = createHost({ models: [option({ id: "m1" })], keybindings });
    const { command, session } = open(host);
    session.component.handleInput("\x1b[1;1B"); // Kitty-style down
    assert.equal(selectedRole(session.component), "Explore");
    session.component.handleInput("\x1b[1;1A"); // Kitty-style up
    assert.equal(selectedRole(session.component), "Parent");
    press(session, "\r", "\r", "\r");
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
  });
});

describe("type-ahead search in the model step", () => {
  const catalogue = [
    option({ id: "Qwen3.8-Flash", name: "Qwen3.8 Flash", reasoning: true }),
    option({ id: "Qwen3.8-Max", name: "Qwen3.8 Max", reasoning: true }),
    option({ id: "MiniMax-M2", name: "MiniMax M2", reasoning: true }),
  ];
  const context = overlayContext({ usable: [section("commandcode", catalogue)] });

  /** Reach the model step. */
  function modelStep() {
    return reduceOverlayKey(reduceOverlayKey(createOverlayState(), "confirm", context), "confirm", context);
  }

  it("types characters into the query, filters the list and resets the index", () => {
    let state = modelStep();
    state = reduceOverlayKey(state, { type: "char", value: "q" }, context);
    state = reduceOverlayKey(state, { type: "char", value: "w" }, context);
    state = reduceOverlayKey(state, { type: "char", value: "e" }, context);
    state = reduceOverlayKey(state, { type: "char", value: "n" }, context);
    assert.equal(state.query, "qwen");
    assert.equal(state.modelIndex, 0);
    assert.deepEqual(
      visibleModels(state, context).map((entry) => entry.id),
      ["Qwen3.8-Flash", "Qwen3.8-Max"],
    );

    state = reduceOverlayKey(state, "down", context);
    assert.equal(state.modelIndex, 1);
    state = reduceOverlayKey(state, { type: "char", value: "3" }, context);
    assert.equal(state.query, "qwen3");
    assert.equal(state.modelIndex, 0, "typing resets the selection to the best match");
  });

  it("clamps the query to MAX_QUERY_LENGTH", () => {
    let state = modelStep();
    for (let index = 0; index < 60; index += 1) {
      state = reduceOverlayKey(state, { type: "char", value: "a" }, context);
    }
    assert.equal(state.query.length, 48);
  });

  it("removes one code point with Backspace and no-ops on an empty query", () => {
    let state = modelStep();
    state = reduceOverlayKey(state, "backspace", context);
    assert.equal(state.query, "");

    state = reduceOverlayKey(state, { type: "char", value: "á" }, context);
    state = reduceOverlayKey(state, "backspace", context);
    assert.equal(state.query, "");

    state = reduceOverlayKey(state, { type: "char", value: "a" }, context);
    state = reduceOverlayKey(state, { type: "char", value: "👍" }, context);
    assert.equal(state.query, "a👍");
    state = reduceOverlayKey(state, "backspace", context);
    assert.equal(state.query, "a", "an astral character is removed whole");
    state = reduceOverlayKey(state, "backspace", context);
    assert.equal(state.query, "");
    state = reduceOverlayKey(state, "\x7f", context);
    assert.equal(state.query, "");
  });

  it("ignores typing and Backspace outside the model step", () => {
    const roleState = createOverlayState();
    assert.equal(reduceOverlayKey(roleState, { type: "char", value: "a" }, context), roleState);
    assert.equal(reduceOverlayKey(roleState, "backspace", context), roleState);
    const providerState = reduceOverlayKey(roleState, "confirm", context);
    assert.equal(reduceOverlayKey(providerState, { type: "char", value: "a" }, context), providerState);
    assert.equal(reduceOverlayKey(providerState, "backspace", context), providerState);
  });

  it("clears the query before leaving the model step on escape", () => {
    let state = modelStep();
    state = reduceOverlayKey(state, { type: "char", value: "q" }, context);
    state = reduceOverlayKey(state, "escape", context);
    assert.equal(state.step, "model");
    assert.equal(state.query, "");
    state = reduceOverlayKey(state, "escape", context);
    assert.equal(state.step, "provider");
  });

  it("keeps j and q as text in the model step end to end", async () => {
    useAgentDir();
    const models = [option({ id: "m1" }), option({ id: "m2" })];
    const host = createHost({ models });
    const { command, session } = open(host);
    session.component.handleInput("\r"); // role -> provider
    session.component.handleInput("\r"); // provider -> model
    session.component.handleInput("j");
    session.component.handleInput("q");
    assert.equal(session.doneCalls.length, 0, "j and q must not navigate or quit in the model step");
    const frame = session.component.render(80).join("\n");
    assert.ok(frame.includes("buscar: jq"), frame);

    press(session, "\x1b", "\x1b"); // clear query, back to provider
    session.component.handleInput("q"); // quit from the provider step
    await command;
    assert.equal(session.doneCalls[0], null);
  });

  it("filters live through the host while arrows still navigate", async () => {
    useAgentDir();
    const models = [
      option({ id: "Alpha", name: "Alpha" }),
      option({ id: "Beta", name: "Beta" }),
      option({ id: "Gamma", name: "Gamma" }),
    ];
    const host = createHost({ models });
    const { command, session } = open(host);
    press(session, "\r", "\r"); // role -> provider -> model
    session.component.handleInput("z"); // "z" matches none of the three
    assert.equal(selectedLabel(session.component), undefined, "an empty filter has no selected row");
    assert.ok(session.component.render(80).join("\n").includes("sin coincidencias para \"z\""));

    session.component.handleInput("\x7f"); // backspace -> full list again
    assert.equal(selectedLabel(session.component), "Alpha");
    session.component.handleInput("\x1b[B"); // arrow down
    assert.equal(selectedLabel(session.component), "Beta");
    press(session, "\r", "\r"); // model -> thinking -> done
    await command;
    assert.equal(session.doneCalls[0].option.id, "Beta");
  });
});

describe("all/scoped toggle", () => {
  const allSections = [
    section("alpha", [option({ id: "a1" }), option({ id: "a2" })]),
    section("beta", [option({ id: "b1" })]),
  ];
  const scopedSections = [section("alpha", [option({ id: "a1" })])];

  function scopedContext() {
    return overlayContext({ usable: allSections, scopedUsable: scopedSections, hasScoped: true });
  }

  it("starts scoped when a scoped set exists and all otherwise", () => {
    assert.equal(createOverlayState({ hasScoped: true }).scope, "scoped");
    assert.equal(createOverlayState({ hasScoped: false }).scope, "all");
    assert.equal(createOverlayState().scope, "all");
  });

  it("resolves the active sections from the scope", () => {
    const context = scopedContext();
    assert.deepEqual(activeSections({ ...createOverlayState({ hasScoped: true }) }, context).map((entry) => entry.id), ["alpha"]);
    assert.deepEqual(activeSections(createOverlayState(), context).map((entry) => entry.id), ["alpha", "beta"]);
    const withoutScope = overlayContext({ usable: allSections });
    assert.deepEqual(
      activeSections({ ...createOverlayState({ hasScoped: true }) }, withoutScope).map((entry) => entry.id),
      ["alpha", "beta"],
      "a scoped flag without a scoped set falls back to all",
    );
  });

  it("toggles scope in the provider and model steps and resets the indices", () => {
    const context = scopedContext();
    let state = reduceOverlayKey(createOverlayState({ hasScoped: true }), "confirm", context);
    assert.equal(state.scope, "scoped");
    state = reduceOverlayKey(state, "scope", context); // -> all, two sections
    assert.equal(state.scope, "all");
    state = reduceOverlayKey(state, "down", context);
    assert.equal(state.providerIndex, 1);
    state = reduceOverlayKey(state, "scope", context); // -> scoped
    assert.equal(state.scope, "scoped");
    assert.equal(state.providerIndex, 0, "a real toggle resets the provider index");

    state = reduceOverlayKey(state, "confirm", context); // -> model
    state = reduceOverlayKey(state, { type: "char", value: "a" }, context);
    state = reduceOverlayKey(state, "scope", context);
    assert.equal(state.scope, "all");
    assert.equal(state.query, "a", "the query survives a scope toggle");
    assert.equal(state.modelIndex, 0);
    assert.equal(state.providerIndex, 0);
  });

  it("is a no-op without a scoped set and outside the provider and model steps", () => {
    const context = overlayContext({ usable: allSections });
    const providerState = reduceOverlayKey(createOverlayState(), "confirm", context);
    assert.equal(reduceOverlayKey(providerState, "scope", context), providerState);

    const scoped = scopedContext();
    const roleState = createOverlayState({ hasScoped: true });
    assert.equal(reduceOverlayKey(roleState, "scope", scoped), roleState);

    const reasoning = option({ id: "a1", reasoning: true });
    const reasoningScoped = overlayContext({
      usable: [section("alpha", [reasoning])],
      scopedUsable: [section("alpha", [reasoning])],
      hasScoped: true,
    });
    let thinkingState = reduceOverlayKey(createOverlayState({ hasScoped: true }), "confirm", reasoningScoped);
    thinkingState = reduceOverlayKey(thinkingState, "confirm", reasoningScoped);
    thinkingState = reduceOverlayKey(thinkingState, "confirm", reasoningScoped);
    assert.equal(thinkingState.step, "thinking");
    assert.equal(reduceOverlayKey(thinkingState, "scope", reasoningScoped), thinkingState);
  });

  it("renders the scope line and only enables scoping when there is a scoped set", async () => {
    const host = createHost({
      models: [option({ id: "m1" }), option({ id: "m2" })],
      scopedModels: [{ model: { provider: "faux", id: "m1" } }],
    });
    const { command, session } = open(host);
    session.component.handleInput("\r"); // role -> provider
    const frame = session.component.render(80).join("\n");
    assert.ok(frame.includes("Scope: all [scoped]"), frame);
    session.component.handleInput("\t");
    assert.ok(session.component.render(80).join("\n").includes("Scope: [all] scoped"));
    session.component.handleInput("\x1b"); // provider -> role
    session.component.handleInput("\x1b"); // cancel
    await command;
    assert.equal(session.doneCalls[0], null);
  });
});

describe("effort selection with left/right", () => {
  const context = overlayContext({
    usable: [section("faux", [option({ id: "m1", reasoning: true })])],
  });

  it("moves the thinking index with right/left and l/h at the thinking step", () => {
    let state = createOverlayState();
    state = reduceOverlayKey(state, "confirm", context); // role -> provider
    state = reduceOverlayKey(state, "confirm", context); // provider -> model
    state = reduceOverlayKey(state, "confirm", context); // model -> thinking
    assert.equal(state.step, "thinking");
    assert.equal(state.thinkingIndex, 0);

    state = reduceOverlayKey(state, "right", context);
    assert.equal(state.thinkingIndex, 1);
    state = reduceOverlayKey(state, "l", context);
    assert.equal(state.thinkingIndex, 2);
    state = reduceOverlayKey(state, "left", context);
    assert.equal(state.thinkingIndex, 1);
    state = reduceOverlayKey(state, "h", context);
    assert.equal(state.thinkingIndex, 0);
    state = reduceOverlayKey(state, "h", context); // clamped, never wraps
    assert.equal(state.thinkingIndex, 0);
  });

  it("is a no-op outside the thinking step", () => {
    const roleState = reduceOverlayKey(createOverlayState(), "right", context);
    assert.equal(roleState.step, "role");
    assert.equal(roleState.roleIndex, 0);
    assert.equal(roleState.thinkingIndex, 0);

    const modelState = reduceOverlayKey(
      reduceOverlayKey(reduceOverlayKey(createOverlayState(), "confirm", context), "confirm", context),
      "left",
      context,
    );
    assert.equal(modelState.step, "model");
    assert.equal(modelState.modelIndex, 0);
    assert.equal(modelState.thinkingIndex, 0);
  });

  it("moves effort with raw and vim keys end to end", async () => {
    for (const [right, left] of [
      ["\x1b[C", "\x1b[D"],
      ["l", "h"],
    ]) {
      const host = createHost({ models: [option({ id: "m1", reasoning: true })] });
      const { command, session } = open(host);
      press(session, "\r", "\r", "\r"); // role -> provider -> model -> thinking
      assert.equal(selectedLabel(session.component), "off");
      session.component.handleInput(right);
      assert.equal(selectedLabel(session.component), "minimal", `right=${JSON.stringify(right)}`);
      session.component.handleInput(left);
      assert.equal(selectedLabel(session.component), "off", `left=${JSON.stringify(left)}`);
      session.component.handleInput("\r"); // thinking -> done
      await command;
      assert.equal(session.doneCalls[0].thinkingLevel, "off");
    }
  });

  it("moves effort through the manager-mapped cursor key", async () => {
    const keybindings = fakeKeybindings({ "tui.editor.cursorRight": ["\x1b[1;1C"] });
    const host = createHost({ models: [option({ id: "m1", reasoning: true })], keybindings });
    const { command, session } = open(host);
    press(session, "\r", "\r", "\r"); // role -> provider -> model -> thinking
    assert.equal(selectedLabel(session.component), "off");
    session.component.handleInput("\x1b[1;1C"); // Kitty-style right
    assert.equal(selectedLabel(session.component), "minimal");
    session.component.handleInput("\r");
    await command;
    assert.equal(session.doneCalls[0].thinkingLevel, "minimal");
  });
});

describe("escape navigation", () => {
  it("cancels from the role view and resolves done(null)", async () => {
    useAgentDir();
    const host = createHost({ models: [option({ id: "m1", reasoning: true })] });
    const { command, session } = open(host);
    session.component.handleInput("\x1b"); // bare Esc
    assert.equal(session.doneCalls.length, 1);
    assert.equal(session.doneCalls[0], null);
    await command;
    assert.equal(session.doneCalls[0], null);
  });

  it("cancels from the role view through a manager-mapped cancel payload", async () => {
    useAgentDir();
    const keybindings = fakeKeybindings({ "tui.select.cancel": ["\x1b[27;1u"] });
    const host = createHost({ models: [option({ id: "m1", reasoning: true })], keybindings });
    const { command, session } = open(host);
    session.component.handleInput("\x1b[27;1u");
    await command;
    assert.equal(session.doneCalls[0], null);
  });

  it("goes model -> role on escape and persists nothing", async () => {
    const agentDir = useAgentDir();
    const models = [option({ id: "m1", reasoning: true })];
    const host = createHost({ models });
    const { command, session } = open(host);
    session.component.handleInput("\r"); // role -> provider
    session.component.handleInput("\r"); // provider -> model
    assert.equal(selectedLabel(session.component), models[0].name);
    session.component.handleInput("escape"); // model -> provider
    assert.equal(selectedLabel(session.component), "faux (1)");
    session.component.handleInput("escape"); // provider -> role
    assert.equal(selectedRole(session.component), "Parent");
    session.component.handleInput("\x1b"); // cancel from role
    await command;
    assert.equal(session.doneCalls[0], null);
    assert.equal(existsSync(join(agentDir, AIES_CONFIG_FILE)), false);
    assert.equal(existsSync(join(agentDir, "settings.json")), false);
  });

  it("goes thinking -> model on escape and persists nothing", async () => {
    const agentDir = useAgentDir();
    const models = [option({ id: "m1", reasoning: true })];
    const host = createHost({ models });
    const { command, session } = open(host);
    session.component.handleInput("\r"); // role -> provider
    session.component.handleInput("\r"); // provider -> model
    session.component.handleInput("\r"); // model -> thinking
    assert.equal(selectedLabel(session.component), "off");
    session.component.handleInput("escape"); // thinking -> model
    assert.equal(selectedLabel(session.component), models[0].name);
    session.component.handleInput("escape"); // model -> provider
    assert.equal(selectedLabel(session.component), "faux (1)");
    session.component.handleInput("\x1b"); // provider -> role
    session.component.handleInput("\x1b"); // role -> cancel
    await command;
    assert.equal(session.doneCalls[0], null);
    assert.equal(existsSync(join(agentDir, AIES_CONFIG_FILE)), false);
    assert.equal(existsSync(join(agentDir, "settings.json")), false);
  });

  it("never persists when the user escapes without confirming", async () => {
    const agentDir = useAgentDir();
    const host = createHost({ models: [option({ id: "m1", reasoning: true })] });
    const { command, session } = open(host);
    session.component.handleInput("\r"); // role -> provider
    session.component.handleInput("\r"); // provider -> model
    session.component.handleInput("\x1b"); // model -> provider
    session.component.handleInput("\x1b"); // provider -> role
    session.component.handleInput("\x1b"); // role -> cancel
    await command;
    assert.equal(session.doneCalls[0], null);
    assert.equal(existsSync(join(agentDir, AIES_CONFIG_FILE)), false);
    assert.equal(existsSync(join(agentDir, "settings.json")), false);
  });
});

describe("confirm via Enter and Ctrl+S", () => {
  it("confirms with raw Ctrl+S exactly like Enter", async () => {
    const agentDir = useAgentDir();
    const host = createHost({ models: [option({ id: "m1" })] }); // non-reasoning: skips thinking
    const { command, session } = open(host);
    session.component.handleInput("\x13"); // role -> provider (Ctrl+S)
    session.component.handleInput("\x13"); // provider -> model (Ctrl+S)
    session.component.handleInput("\x13"); // model -> done (Ctrl+S)
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
    assert.equal(session.doneCalls[0].option.id, "m1");
    assert.equal(existsSync(join(agentDir, "settings.json")), true);
  });

  it("confirms with the manager-mapped save binding in the model step", async () => {
    useAgentDir();
    const keybindings = fakeKeybindings({ "app.models.save": ["\x1b[115;5u"] });
    const host = createHost({ models: [option({ id: "m1" })], keybindings });
    const { command, session } = open(host);
    session.component.handleInput("\x1b[115;5u"); // role -> provider
    session.component.handleInput("\x1b[115;5u"); // provider -> model
    session.component.handleInput("\x1b[115;5u"); // model -> done
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
    assert.equal(session.doneCalls[0].option.id, "m1");
  });

  it("navigates the role step with j and the model step with arrows", async () => {
    useAgentDir();
    const models = [option({ id: "m1" }), option({ id: "m2" })];
    const host = createHost({ models });
    const { command, session } = open(host);
    session.component.handleInput("j"); // role -> explore
    session.component.handleInput("\r"); // role -> provider
    session.component.handleInput("\r"); // provider -> model
    session.component.handleInput("\x1b[B"); // arrow down: pick second model
    assert.equal(selectedLabel(session.component), models[1].name);
    press(session, "\r"); // model -> done (non-reasoning)
    await command;
    assert.equal(session.doneCalls[0].role, "explore");
    assert.equal(session.doneCalls[0].option.id, "m2");
  });
});

describe("shared modal frame", () => {
  it("frames the overlay while navigation keeps working", async () => {
    useAgentDir();
    const models = [option({ id: "m1" }), option({ id: "m2" })];
    const host = createHost({ models });
    const { command, session } = open(host);

    const width = 72;
    const frame = session.component.render(width);
    assert.equal(frame[0].startsWith("╭"), true, frame[0]);
    assert.equal(frame.at(-1).startsWith("╰"), true, frame.at(-1));
    assert.ok(frame[0].includes("Modelo"), "the title is integrated into the frame");
    for (const line of frame) assert.ok(line.length <= width, `overflow: ${line}`);

    session.component.handleInput("j"); // down -> explore
    assert.equal(selectedRole(session.component), "Explore");
    session.component.handleInput("\x1b[A"); // up -> parent
    assert.equal(selectedRole(session.component), "Parent");

    press(session, "\r", "\r", "\r"); // role -> provider -> model -> done (non-reasoning)
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
    assert.equal(session.doneCalls[0].option.id, "m1");
  });

  it("keeps every framed line inside a narrow render width", async () => {
    const host = createHost({ models: [option({ id: "m1", name: "A very long model label indeed" })] });
    const { command, session } = open(host);

    const frame = session.component.render(28);
    for (const line of frame) assert.ok(line.length <= 28, `overflow: ${line}`);
    assert.ok(frame.some((line) => line.includes("…")), "long content is clipped, not wrapped");

    session.component.handleInput("\x1b"); // cancel so the command settles
    await command;
    assert.equal(session.doneCalls[0], null);
  });
});

describe("overlay lifecycle", () => {
  it("ignores input after close and calls done exactly once", async () => {
    useAgentDir();
    const host = createHost({ models: [option({ id: "m1", reasoning: true })] });
    const { command, session } = open(host);
    session.component.handleInput("\x1b"); // cancel
    assert.equal(session.doneCalls.length, 1);
    // Residual keys must not re-trigger the closed overlay.
    session.component.handleInput("\r");
    session.component.handleInput("\r");
    session.component.handleInput("j");
    session.component.handleInput("q");
    session.component.handleInput("\x1b");
    assert.equal(session.doneCalls.length, 1);
    await command;
    assert.equal(session.doneCalls.length, 1);
    assert.equal(session.doneCalls[0], null);
  });

  it("cancels on q from the role, provider and thinking steps", async () => {
    for (const step of ["role", "provider", "thinking"]) {
      useAgentDir();
      const host = createHost({ models: [option({ id: "m1", reasoning: true })] });
      const { command, session } = open(host);
      if (step === "provider") press(session, "\r");
      if (step === "thinking") press(session, "\r", "\r", "\r");
      session.component.handleInput("q");
      await command;
      assert.equal(session.doneCalls.length, 1, `step=${step}`);
      assert.equal(session.doneCalls[0], null, `step=${step}`);
    }
  });

  it("can reopen /aies-models after a close on the same host", async () => {
    useAgentDir();
    const host = createHost({ models: [option({ id: "m1" })] });

    const first = open(host);
    first.session.component.handleInput("\x1b"); // cancel
    await first.command;
    assert.equal(first.session.doneCalls[0], null);
    assert.equal(host.sessions.length, 1);

    const second = open(host);
    second.session.component.handleInput("\r"); // role -> provider
    second.session.component.handleInput("\r"); // provider -> model
    second.session.component.handleInput("\r"); // model -> done
    await second.command;
    assert.equal(host.sessions.length, 2);
    assert.equal(second.session.doneCalls[0].role, "parent");
  });
});
