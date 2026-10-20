/**
 * `aies_delegate` must run one at a time.
 *
 * Pi runs sibling tool calls from the same assistant message concurrently unless
 * the tool declares `executionMode: "sequential"`. The delegate tool mutates
 * shared state (the verification registry, routing counters, the global sandbox
 * manager), so two overlapping delegations could lose updates or reset each
 * other's counters. These tests pin the declaration at both levels:
 *
 * 1. The factory returns a tool definition that declares sequential execution.
 * 2. The real agents extension registers that same definition with Pi.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import aiesAgents from "../extensions/aies-agents/index.ts";
import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";

/** Minimal Pi host that records registered tools; only what the agents extension touches. */
function createFakeHost() {
  const tools = [];
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on() {},
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand() {},
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    appendEntry() {},
    sendUserMessage() {},
  };
  return { pi, tools };
}

describe("aies_delegate execution mode", () => {
  it("createDelegateTool declares sequential execution", () => {
    const tool = createDelegateTool();

    assert.equal(tool.name, "aies_delegate");
    assert.equal(tool.executionMode, "sequential");
  });

  it("the registered aies_delegate tool declares sequential execution", () => {
    const { pi, tools } = createFakeHost();
    aiesAgents(pi);

    const registered = tools.find((tool) => tool.name === "aies_delegate");
    assert.ok(registered, "the agents extension must register aies_delegate");
    assert.equal(registered.executionMode, "sequential");
  });
});
