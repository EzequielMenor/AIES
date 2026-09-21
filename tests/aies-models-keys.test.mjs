/**
 * AIES-010D bugfix: `/aies-models` keyboard handling.
 *
 * Regression-first coverage for the frozen-UI bug where arrows, Esc and the
 * confirm keys were dead because the overlay ignored the keybindings manager Pi
 * injects into `ctx.ui.custom()` and hand-matched legacy raw bytes only.
 *
 * The tests drive the real `handleModelsCommand` command through a fake TUI
 * host, so they exercise the whole path: keybindings manager -> decoder ->
 * reducer -> done/apply. Pure reducer cases cover the parts that are hard to
 * observe through the host.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { projectModelOption } from "../extensions/aies-models/capabilities.ts";
import { AIES_CONFIG_FILE } from "../extensions/aies-models/config.ts";
import {
  createOverlayState,
  decodeOverlayKey,
  reduceOverlayKey,
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
function createHost({ models, keybindings }) {
  const sessions = [];
  const pi = fakePi();
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp",
    model: undefined,
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

/** The text of the currently marked row in the overlay, without the marker. */
function selectedLabel(component, width = 80) {
  const marked = component.render(width).find((line) => line.startsWith("› "));
  return marked ? marked.slice(2) : undefined;
}

/** Feed one or more keys to the overlay, one call per key as the host does. */
function press(session, ...keys) {
  for (const key of keys) session.component.handleInput(key);
}

describe("raw key decoding (fallback)", () => {
  it("maps arrows, vim keys, effort keys, confirm, escape and quit", () => {
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

  it("keeps the raw fallback alive when the manager throws", async () => {
    const keybindings = {
      matches() {
        throw new Error("unusable manager");
      },
    };
    const host = createHost({ models: [option({ id: "m1" })], keybindings });
    const { command, session } = open(host);
    session.component.handleInput("j"); // raw down -> explore
    assert.equal(selectedLabel(session.component), "Explore");
    session.component.handleInput("\x1b[A"); // raw up -> parent
    assert.equal(selectedLabel(session.component), "Parent");
    press(session, "\r", "\r"); // confirm through
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
      assert.equal(selectedLabel(session.component), "Explore");
      session.component.handleInput(up); // up back to parent
      assert.equal(selectedLabel(session.component), "Parent", `up=${JSON.stringify(up)}`);
      press(session, "\r", "\r");
      await command;
      assert.equal(session.doneCalls[0].role, "parent");
    }
  });

  it("treats raw ArrowDown and j as the same down action", async () => {
    for (const down of ["\x1b[B", "j"]) {
      const host = createHost({ models: [option({ id: "m1" })] });
      const { command, session } = open(host);
      session.component.handleInput(down);
      assert.equal(selectedLabel(session.component), "Explore", `down=${JSON.stringify(down)}`);
      press(session, "\r", "\r");
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
    assert.equal(selectedLabel(session.component), "Explore");
    session.component.handleInput("\x1b[1;1A"); // Kitty-style up
    assert.equal(selectedLabel(session.component), "Parent");
    press(session, "\r", "\r");
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
  });
});

describe("effort selection with left/right", () => {
  const context = { models: [option({ id: "m1", reasoning: true })] };

  it("moves the thinking index with right/left and l/h at the thinking step", () => {
    let state = createOverlayState();
    state = reduceOverlayKey(state, "confirm", context);
    state = reduceOverlayKey(state, "confirm", context);
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

    const modelState = reduceOverlayKey(reduceOverlayKey(createOverlayState(), "confirm", context), "left", context);
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
      press(session, "\r", "\r"); // role -> model -> thinking
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
    press(session, "\r", "\r"); // role -> model -> thinking
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
    session.component.handleInput("\r"); // role -> model
    assert.equal(selectedLabel(session.component), models[0].label);
    session.component.handleInput("escape"); // model -> role
    assert.equal(selectedLabel(session.component), "Parent");
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
    session.component.handleInput("\r"); // role -> model
    session.component.handleInput("\r"); // model -> thinking
    assert.equal(selectedLabel(session.component), "off");
    session.component.handleInput("escape"); // thinking -> model
    assert.equal(selectedLabel(session.component), models[0].label);
    session.component.handleInput("\x1b"); // cancel from model? no: model -> role
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
    session.component.handleInput("\r"); // role -> model
    session.component.handleInput("\x1b"); // model -> role
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
    session.component.handleInput("\x13"); // role -> model (Ctrl+S)
    session.component.handleInput("\x13"); // model -> done (Ctrl+S)
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
    assert.equal(session.doneCalls[0].option.id, "m1");
    assert.equal(existsSync(join(agentDir, "settings.json")), true);
  });

  it("confirms with the manager-mapped save binding", async () => {
    useAgentDir();
    const keybindings = fakeKeybindings({ "app.models.save": ["\x1b[115;5u"] });
    const host = createHost({ models: [option({ id: "m1" })], keybindings });
    const { command, session } = open(host);
    session.component.handleInput("\x1b[115;5u"); // role -> model
    session.component.handleInput("\x1b[115;5u"); // model -> done
    await command;
    assert.equal(session.doneCalls[0].role, "parent");
    assert.equal(session.doneCalls[0].option.id, "m1");
  });

  it("confirms with j/k regression keys", async () => {
    useAgentDir();
    const models = [option({ id: "m1" }), option({ id: "m2" })];
    const host = createHost({ models });
    const { command, session } = open(host);
    session.component.handleInput("j"); // role -> explore
    session.component.handleInput("\r"); // role -> model
    session.component.handleInput("j"); // pick second model
    assert.equal(selectedLabel(session.component), models[1].label);
    press(session, "\r", "\r"); // model -> done (non-reasoning)
    await command;
    assert.equal(session.doneCalls[0].role, "explore");
    assert.equal(session.doneCalls[0].option.id, "m2");
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

  it("cancels on q from any step", async () => {
    for (const step of ["role", "model", "thinking"]) {
      useAgentDir();
      const host = createHost({ models: [option({ id: "m1", reasoning: true })] });
      const { command, session } = open(host);
      if (step === "model") session.component.handleInput("\r");
      if (step === "thinking") press(session, "\r", "\r");
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
    second.session.component.handleInput("\r"); // role -> model
    second.session.component.handleInput("\r"); // complete
    await second.command;
    assert.equal(host.sessions.length, 2);
    assert.equal(second.session.doneCalls[0].role, "parent");
  });
});
