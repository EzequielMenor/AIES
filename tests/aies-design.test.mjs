import assert from "node:assert/strict";
import { describe, it } from "node:test";

import extension from "../extensions/aies-design/index.ts";

function harness() {
  const commands = new Map();
  const hooks = new Map();
  const messages = [];
  const notices = [];
  let idle = true;
  let aborts = 0;
  const pi = {
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { hooks.set(name, handler); },
    sendMessage(message, options) { messages.push({ message, options }); },
  };
  extension(pi);
  const ctx = {
    ui: { notify: (text) => notices.push(text) },
    isIdle: () => idle,
    abort() { aborts += 1; idle = true; },
  };
  return {
    commands, hooks, messages, notices, ctx,
    setIdle(value) { idle = value; },
    get aborts() { return aborts; },
  };
}

describe("/aies-design lifecycle", () => {
  it("opts in with the supplied objective and design guidance, then permits normal prompts after completion", async () => {
    const h = harness();
    await h.commands.get("aies-design").handler("Improve checkout", h.ctx);
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0].message.content, /Improve checkout/);
    assert.match(h.messages[0].message.content, /inspect the real project/);
    assert.match(h.messages[0].message.content, /styles, and assets/);
    assert.match(h.hooks.get("before_agent_start")().message.content, /new product, redesign, or improvement/);

    await h.commands.get("aies-design").handler("complete", h.ctx);
    assert.equal(h.hooks.get("before_agent_start")(), undefined);
    const stale = [{ customType: "aies-design-kickoff" }, { role: "user", content: "hello" }];
    assert.deepEqual(h.hooks.get("context")({ messages: stale }).messages, [stale[1]]);
  });

  it("does not activate without an objective and cleanly cancels queued guidance", async () => {
    const h = harness();
    await h.commands.get("aies-design").handler(" ", h.ctx);
    assert.equal(h.messages.length, 0);
    assert.equal(h.hooks.get("before_agent_start")(), undefined);
    await h.commands.get("aies-design").handler("new dashboard", h.ctx);
    await h.commands.get("aies-design").handler("cancel", h.ctx);
    assert.equal(h.hooks.get("before_agent_start")(), undefined);
    assert.equal(h.hooks.get("context")({ messages: [{ customType: "aies-design-context" }] }).messages.length, 0);
  });

  it("filters a retained kickoff when a fresh extension resumes a session", async () => {
    const original = harness();
    await original.commands.get("aies-design").handler("Old objective", original.ctx);
    const retainedKickoff = original.messages[0].message;

    const resumed = harness();
    await resumed.commands.get("aies-design").handler("New objective", resumed.ctx);
    const currentKickoff = resumed.messages[0].message;
    assert.notEqual(retainedKickoff.details.workflowId, currentKickoff.details.workflowId);

    const context = resumed.hooks.get("context")({ messages: [retainedKickoff, currentKickoff] });
    assert.deepEqual(context.messages, [currentKickoff]);
  });

  it("filters copied workflow history when a new workflow starts in a fork", async () => {
    const original = harness();
    await original.commands.get("aies-design").handler("Parent objective", original.ctx);
    const copiedHistory = [original.messages[0].message];

    const fork = harness();
    await fork.commands.get("aies-design").handler("Fork objective", fork.ctx);
    const currentKickoff = fork.messages[0].message;
    const context = fork.hooks.get("context")({ messages: [...copiedHistory, currentKickoff] });

    assert.notEqual(copiedHistory[0].details.workflowId, currentKickoff.details.workflowId);
    assert.deepEqual(context.messages, [currentKickoff]);
  });

  it("isolates a new objective from a cancelled queued kickoff", async () => {
    const h = harness();
    await h.commands.get("aies-design").handler("Redesign checkout", h.ctx);
    const cancelledId = h.messages[0].message.details.workflowId;
    await h.commands.get("aies-design").handler("cancel", h.ctx);
    await h.commands.get("aies-design").handler("Improve onboarding", h.ctx);
    const currentId = h.messages[1].message.details.workflowId;
    const queue = [
      ...h.messages.map(({ message }) => message),
      h.hooks.get("before_agent_start")().message,
      { role: "user", content: "ordinary conversation" },
    ];

    const context = h.hooks.get("context")({ messages: queue });
    assert.deepEqual(context.messages.map((message) => message.details?.workflowId ?? message.content), [
      currentId, currentId, "ordinary conversation",
    ]);
    assert.notEqual(cancelledId, currentId);
  });

  it("aborts an active turn for command and textual cancellation without capturing normal prompts", async () => {
    const h = harness();
    await h.commands.get("aies-design").handler("Redesign checkout", h.ctx);
    h.setIdle(false);
    const result = h.hooks.get("input")({ text: "cancel design" }, h.ctx);
    assert.deepEqual(result, { action: "handled" });
    assert.equal(h.aborts, 1);
    assert.equal(h.hooks.get("before_agent_start")(), undefined);

    await h.commands.get("aies-design").handler("Improve onboarding", h.ctx);
    h.setIdle(false);
    await h.commands.get("aies-design").handler("exit", h.ctx);
    assert.equal(h.aborts, 2);
    assert.equal(h.hooks.get("before_agent_start")(), undefined);
    assert.equal(h.hooks.get("input")({ text: "cancel" }, h.ctx), undefined);
    assert.equal(h.hooks.get("input")({ text: "Can you cancel the appointment?" }, h.ctx), undefined);

    const messages = [
      ...h.messages.map(({ message }) => message),
      { role: "user", content: "ordinary conversation" },
    ];
    assert.deepEqual(h.hooks.get("context")({ messages }).messages, [messages[2]]);
  });

  it("resets ephemeral state on session replacement and shutdown", async () => {
    const h = harness();
    await h.commands.get("aies-design").handler("Redesign settings", h.ctx);
    h.hooks.get("session_start")();
    assert.equal(h.hooks.get("before_agent_start")(), undefined);
    await h.commands.get("aies-design").handler("another objective", h.ctx);
    h.hooks.get("session_shutdown")();
    assert.equal(h.hooks.get("before_agent_start")(), undefined);
  });

  it("never leaves a residual turn: a kickoff sent while busy is not a queued follow-up", async () => {
    // Mirrors AgentSession.sendCustomMessage routing (pi-coding-agent): while streaming,
    // triggerTurn !== false queues a follow-up that an extension cannot withdraw.
    const route = (options, streaming) => {
      if (options?.deliverAs === "nextTurn") return "next_turn";
      if (streaming && options?.triggerTurn !== false) return options?.deliverAs === "followUp" ? "queued_follow_up" : "steer";
      if (options?.triggerTurn) return "turn_now";
      return "append";
    };
    const idle = harness();
    await idle.commands.get("aies-design").handler("Redesign checkout", idle.ctx);
    assert.equal(route(idle.messages[0].options, false), "turn_now");

    const busy = harness();
    busy.setIdle(false);
    await busy.commands.get("aies-design").handler("Redesign checkout", busy.ctx);
    assert.equal(route(busy.messages[0].options, true), "next_turn", "no follow-up, no steer, no turn");
    assert.match(busy.notices.at(-1), /próximo mensaje/u);

    await busy.commands.get("aies-design").handler("cancel", busy.ctx);
    const context = busy.hooks.get("context")({ messages: [busy.messages[0].message, { role: "user", content: "hi" }] });
    assert.deepEqual(context.messages, [{ role: "user", content: "hi" }], "the pending kickoff is inert after cancel");
  });

  it("tells the model to inspect first, ask only what the project cannot answer, and use Explore only when context is missing", async () => {
    const h = harness();
    await h.commands.get("aies-design").handler("Improve checkout", h.ctx);
    const text = h.hooks.get("before_agent_start")().message.content;
    const order = ["inspect the real project", "Never ask the user something the project can answer", "role \"explore\"", "propose an appropriately scoped design"].map((part) => text.indexOf(part));
    assert.ok(order.every((index) => index >= 0), "all four steps are present");
    assert.deepEqual(order, [...order].sort((a, b) => a - b), "in the order inspect, do not ask, explore, propose");
    assert.match(text, /still missing or the project is too large[^.]*aies_delegate tool is available/u, "Explore is conditional");
    assert.doesNotMatch(text, /always (?:use|delegate|launch)/iu);
  });

  it("closes itself when the final message ends with the done marker, and only then", async () => {
    const h = harness();
    const end = (text, role = "assistant") => h.hooks.get("agent_end")({ messages: [{ role, content: [{ type: "text", text }] }] }, h.ctx);
    await h.commands.get("aies-design").handler("Improve checkout", h.ctx);

    end("I could propose X. What is your budget?");
    end("Mention of AIES_DESIGN_DONE in the middle.\nStill talking.");
    end("AIES_DESIGN_DONE", "user");
    assert.ok(h.hooks.get("before_agent_start")(), "still active");

    end("Here is the proposal.\n\nAIES_DESIGN_DONE\n");
    assert.equal(h.hooks.get("before_agent_start")(), undefined);
    assert.equal(h.hooks.get("context")({ messages: [h.messages[0].message, { role: "user", content: "hi" }] }).messages.length, 1);
    assert.match(h.notices.at(-1), /completado/u);

    end("AIES_DESIGN_DONE");
    assert.equal(h.notices.filter((text) => /completado/u.test(text)).length, 1, "inactive workflow ignores the marker");
  });
});
