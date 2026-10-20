/**
 * D33 phase 3 prerequisite (D33 item 8, amends D32): while a hold stands, no Plane
 * `workitem update` may carry `state`. Plane states are UUIDs on writes, so the
 * block cannot match a completion by name and therefore covers every state move.
 * Comments, reads and updates without `state` stay allowed, and no hold means no block.
 *
 * Drives the real agents extension through its `input` and `tool_call` handlers,
 * exactly as the EZE-503 tests do. No Pi runtime, no network, no credential.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import aiesAgents from "../extensions/aies-agents/index.ts";
import {
  describePendingFinalAction,
  holdBypassReason,
  isDirectPlaneStateWrite,
  readFinalActionDirective,
} from "../extensions/aies-agents/linear/pending-action.ts";
import { TRUSTED, useTrustedProfileEnv } from "./helpers/mcp-profile.mjs";

/** The hold and the state-write predicate under a trusted profile unless a test says otherwise (D38). */
const holdReason = (toolName, input, activeTicket, pending, trust = TRUSTED) => holdBypassReason(toolName, input, activeTicket, pending, trust);
const stateWrite = (toolName, input, trust = TRUSTED) => isDirectPlaneStateWrite(toolName, input, trust);
const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

const WORKITEM = "9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b";
const PROJECT = "5b2f0c1e-7d3a-4f6b-9a8e-1c2d3e4f5a6b";
const IN_PROGRESS = "c0a1f000-0000-4000-8000-000000000003";

const planeStateUpdate = {
  server: "plane",
  tool: "workitem",
  args: { action: "update", project_id: PROJECT, workitem_id: WORKITEM, state: IN_PROGRESS },
};

function createAgentsHost() {
  const handlers = new Map();
  const pi = {
    events: { on: () => () => {}, emit: () => {} },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    getAllTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    getActiveTools() {
      return [{ name: "read" }, { name: "edit" }, { name: "write" }, { name: "mcp" }];
    },
    appendEntry() {},
    sendUserMessage() {},
  };
  aiesAgents(pi);
  return {
    async input(text) {
      for (const handler of handlers.get("input") ?? []) {
        await handler({ type: "input", text, source: "interactive" }, { cwd: REPO, mode: "print", hasUI: false });
      }
    },
    async blockOf(toolName, input) {
      const results = [];
      for (const handler of handlers.get("tool_call") ?? []) {
        results.push(await handler({ type: "tool_call", toolName, input }, { cwd: REPO, mode: "print", hasUI: false }));
      }
      return results.find((result) => result && result.block) ?? null;
    },
  };
}

const PENDING = { kind: "review", quote: "quiero revisarlo antes" };

// The hook tests below read the profile from the environment: a trusted one, for the whole file (D38).
let restoreProfileEnv;
beforeEach(() => {
  restoreProfileEnv = useTrustedProfileEnv();
});
afterEach(() => restoreProfileEnv());

describe("D33 phase 3: the Plane state-write predicate", () => {
  it("recognises a workitem update that carries a state", () => {
    assert.equal(stateWrite("mcp", planeStateUpdate), true);
  });

  it("recognises the same write when the args arrive as a JSON string", () => {
    const input = { ...planeStateUpdate, args: JSON.stringify(planeStateUpdate.args) };
    assert.equal(stateWrite("mcp", input), true, "fail closed: an encoded state write is still a state write");
  });

  it("does not match comments, reads, updates without a state, or other servers", () => {
    assert.equal(stateWrite("mcp", { server: "plane", tool: "workitem_comment", args: { action: "create", comment_html: "<p>x</p>" } }), false);
    assert.equal(stateWrite("mcp", { server: "plane", tool: "workitem", args: { action: "retrieve_by_identifier", workitem_identifier: "AIES-38" } }), false);
    assert.equal(stateWrite("mcp", { server: "plane", tool: "workitem", args: { action: "update", workitem_id: WORKITEM, name: "New title" } }), false);
    assert.equal(stateWrite("mcp", { server: "plane", tool: "state", args: { action: "list", project_id: PROJECT } }), false);
    assert.equal(stateWrite("mcp", { server: "linear", tool: "workitem", args: { action: "update", state: IN_PROGRESS } }), false);
    assert.equal(stateWrite("read", planeStateUpdate), false);
  });
});

describe("D33 phase 3: the hold reason for Plane", () => {
  it("blocks a state write while a hold stands, in Spanish, naming Plane and the user's words", () => {
    const reason = holdReason("mcp", planeStateUpdate, null, PENDING);
    assert.ok(reason, "a held state write must be refused");
    assert.match(reason, /^Bloqueado:/);
    assert.match(reason, /Plane/);
    assert.match(reason, /quiero revisarlo antes/);
    assert.match(reason, /No se envió ningún cambio de estado/);
    assert.match(reason, /aies_ticket action "complete"/);
    assert.ok(reason.includes(describePendingFinalAction(PENDING)));
  });

  it("returns no reason for a comment, a read or an update without state, even while held", () => {
    const comment = { server: "plane", tool: "workitem_comment", args: { action: "create", project_id: PROJECT, workitem_id: WORKITEM, comment_html: "<p>note</p>" } };
    const read = { server: "plane", tool: "workitem", args: { action: "retrieve_by_identifier", workitem_identifier: "AIES-38", expand: "state,project" } };
    const rename = { server: "plane", tool: "workitem", args: { action: "update", project_id: PROJECT, workitem_id: WORKITEM, name: "Renamed" } };
    assert.equal(holdReason("mcp", comment, null, PENDING), null);
    assert.equal(holdReason("mcp", read, null, PENDING), null);
    assert.equal(holdReason("mcp", rename, null, PENDING), null);
  });
});

describe("D33 phase 3: the tool_call hook refuses the Plane bypass only while a hold stands", () => {
  it("refuses a direct Plane state write while the user holds the final step", async () => {
    const host = createAgentsHost();
    await host.input("quiero revisarlo antes");
    const block = await host.blockOf("mcp", planeStateUpdate);
    assert.ok(block, "the held state write must be blocked by the hook");
    assert.match(block.reason, /Plane/);
    assert.match(block.reason, /Bloqueado/);
  });

  it("refuses the same state write when no hold stands and no directive is pending (D33 phase 4, part C)", async () => {
    const host = createAgentsHost();
    const block = await host.blockOf("mcp", planeStateUpdate);
    assert.ok(block, "a state write is only ever made by the directive aies_ticket has pending");
    assert.match(block.reason, /Bloqueado/);
  });

  it("allows a held session to comment, read and rename, and never blocks them as a state write", async () => {
    const host = createAgentsHost();
    await host.input("no commit todavía");
    const comment = await host.blockOf("mcp", {
      server: "plane",
      tool: "workitem_comment",
      args: { action: "create", project_id: PROJECT, workitem_id: WORKITEM, comment_html: "<p>note</p>" },
    });
    const read = await host.blockOf("mcp", {
      server: "plane",
      tool: "workitem",
      args: { action: "retrieve_by_identifier", workitem_identifier: "AIES-38", expand: "state,project" },
    });
    assert.equal(comment, null);
    assert.equal(read, null);
  });

  it("lifts with the user's explicit release; the state write still needs the pending directive", async () => {
    const host = createAgentsHost();
    await host.input("quiero revisarlo antes");
    assert.ok(await host.blockOf("mcp", planeStateUpdate));
    await host.input("ya lo revisé, podés commitear");
    const block = await host.blockOf("mcp", planeStateUpdate);
    assert.ok(block, "without a pending directive a state write stays refused after the release");
    assert.doesNotMatch(block.reason, /quiero revisarlo antes/, "the released hold is no longer the reason");
  });

  it("a continuation turn cannot set or lift the hold", async () => {
    const host = createAgentsHost();
    await host.input("seguí");
    const block = await host.blockOf("mcp", planeStateUpdate);
    assert.ok(block, "without a directive a state write is refused; a continuation turn never authorises it");
    assert.doesNotMatch(block.reason, /quiero revisarlo antes/);
  });
});

describe("D33 phase 3: the EZE-503 reading of user words is unchanged", () => {
  it("still reads a hold from explicit wording and nothing from a question", () => {
    assert.deepEqual(readFinalActionDirective("no commit todavía")?.kind, "hold");
    assert.equal(readFinalActionDirective("¿puedo commitear?"), null);
  });
});
