/**
 * Child session cancellation, total timeout and turn limit (session.ts).
 *
 * An isolated child (Explore, Worker, Verify) must never outlive its budget:
 * (a) the parent's abort signal calls session.abort() and fails the child as
 *     "cancelled", even when the child never settles;
 * (b) a total timeout (explicit option, AIES_CHILD_TIMEOUT_MS or aies.json) fails
 *     the child as "timeout" and aborts it;
 * (c) exceeding the turn limit fails the child as "max_turns" and aborts it, on a
 *     scripted session and on a real Pi session;
 * (d) an already-aborted signal never starts the prompt;
 * (e) the happy path is unchanged;
 * (f) the signal listener is retired and dispose() runs on every path.
 * Also: role resolution (env > aies.json > default) and structured failed handoffs
 * reaching the parent from the Explore and Verify runners.
 *
 * No network and no credentials: real sessions use the faux provider, scripted
 * sessions are injected through `sessionFactory`. Every wait is bounded in ms.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import { executeChildSession } from "../extensions/aies-agents/session.ts";
import * as childSession from "../extensions/aies-agents/session.ts";
import { runVerifyAgent } from "../extensions/aies-agents/verify.ts";

const ROOT = mkdtempSync(join(tmpdir(), "aies-child-limits-"));
after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const LONG_LIMITS = { timeoutMs: 60_000, maxTurns: 1_000 };
const RUN_TIMEOUT_MS = 10_000;

/**
 * Bound a promise so a child that never settles fails its test instead of stalling
 * the run. The timer keeps the event loop alive while the child is still pending.
 */
function settle(promise, label, ms = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

let agentDirCounter = 0;
/** A fresh agentDir per test so no aies.json or agents/<role>.md leaks between tests. */
function freshAgentDir() {
  agentDirCounter += 1;
  const dir = join(ROOT, `agent-${agentDirCounter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * A scripted child session with the AgentSession surface the runner uses.
 * `prompt` emits `turns` turn_start events (stopping early once aborted). It then
 * resolves with `answer` when given, or never settles, like a hung child.
 * `abort()` records the call and never settles, like Pi's abort() waiting for an
 * idle agent that a hung child never reaches: the runner must not await it.
 */
function fakeChild({ turns = 0, answer, promptError } = {}) {
  const listeners = new Set();
  const calls = { factory: 0, prompt: [], abort: 0, dispose: 0, subscribe: 0, unsubscribe: 0 };
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const emit = (event) => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = {
    subscribe(listener) {
      calls.subscribe += 1;
      listeners.add(listener);
      return () => {
        calls.unsubscribe += 1;
        listeners.delete(listener);
      };
    },
    async prompt(text) {
      calls.prompt.push(text);
      markStarted();
      if (promptError) throw promptError;
      for (let index = 0; index < turns; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        if (calls.abort > 0) break;
        emit({ type: "turn_start" });
      }
      if (answer !== undefined) return;
      await new Promise(() => {});
    },
    abort() {
      calls.abort += 1;
      return new Promise(() => {});
    },
    getLastAssistantText() {
      return answer ?? "";
    },
    dispose() {
      calls.dispose += 1;
    },
  };
  const sessionFactory = async () => {
    calls.factory += 1;
    return { session };
  };
  return { calls, started, sessionFactory };
}

function scriptedOptions(agentDir, child, overrides = {}) {
  return {
    task: "scripted task",
    cwd: agentDir,
    agentDir,
    systemPrompt: "You are a test child.",
    model: { id: "fake-model", provider: "fake" },
    tools: [],
    sessionFactory: child.sessionFactory,
    limits: LONG_LIMITS,
    ...overrides,
  };
}

/** Run `fn` with the given environment variables set, restoring them afterwards. */
async function withEnv(vars, fn) {
  const previous = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    process.env[key] = vars[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

/** A real faux-backed runtime and model, as the existing suites build them. */
async function fauxRuntime(responses) {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create();
  runtime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  return { faux, runtime, model: faux.models[0] };
}

describe("Child session cancellation, timeout and turn limit", () => {
  describe("(a) parent abort signal", () => {
    it("calls session.abort() and fails the child as cancelled without hanging", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild();
      const controller = new AbortController();
      const run = executeChildSession(
        scriptedOptions(freshAgentDir(), child, { signal: controller.signal }),
      );
      run.catch(() => {});

      await settle(child.started, "child prompt");
      controller.abort();

      await assert.rejects(settle(run, "cancelled run"), (error) => {
        assert.equal(error.reason, "cancelled");
        assert.match(error.message, /cancelled by the user/u);
        return true;
      });
      assert.equal(child.calls.abort, 1, "the hung child must be aborted exactly once");
      assert.equal(child.calls.dispose, 1, "dispose runs after a cancellation");
    });

    it("fails a real Pi child that never settles as cancelled", { timeout: RUN_TIMEOUT_MS }, async () => {
      const { runtime, model } = await fauxRuntime([() => new Promise(() => {})]);
      const controller = new AbortController();
      const agentDir = freshAgentDir();
      const run = executeChildSession({
        task: "hang",
        cwd: agentDir,
        agentDir,
        systemPrompt: "You are a test child.",
        model,
        modelRuntime: runtime,
        tools: ["ls"],
        signal: controller.signal,
        limits: LONG_LIMITS,
      });

      run.catch(() => {});
      setTimeout(() => controller.abort(), 100);

      await assert.rejects(settle(run, "real cancelled run"), (error) => error.reason === "cancelled");
    });
  });

  describe("(b) total timeout", () => {
    it("fails the child as timeout and aborts it when the budget elapses", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild();
      const controller = new AbortController();
      const run = executeChildSession(
        scriptedOptions(freshAgentDir(), child, {
          signal: controller.signal,
          limits: { timeoutMs: 50, maxTurns: 1_000 },
        }),
      );
      run.catch(() => {});

      await assert.rejects(settle(run, "timed-out run"), (error) => {
        assert.equal(error.reason, "timeout");
        assert.match(error.message, /timed out after 50 ms/u);
        return true;
      });
      assert.equal(child.calls.abort, 1);
      assert.equal(child.calls.dispose, 1);
    });

    it("bounds a real hung Explore child through AIES_CHILD_TIMEOUT_MS and returns a failed handoff", { timeout: RUN_TIMEOUT_MS }, async () => {
      const { runtime, model } = await fauxRuntime([() => new Promise(() => {})]);
      const handoff = await withEnv({ AIES_CHILD_TIMEOUT_MS: "200" }, () =>
        settle(runExploreAgent({
          task: "hang",
          cwd: freshAgentDir(),
          agentDir: freshAgentDir(),
          model,
          modelRuntime: runtime,
        }), "explore run"),
      );

      assert.equal(handoff.status, "failed");
      assert.match(handoff.summary, /timed out after 200 ms/u);
    });

    it("applies agents.explore.timeoutMs from aies.json to the Explore child", { timeout: RUN_TIMEOUT_MS }, async () => {
      const { runtime, model } = await fauxRuntime([() => new Promise(() => {})]);
      const agentDir = freshAgentDir();
      writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ agents: { explore: { timeoutMs: 200 } } }));

      const handoff = await settle(runExploreAgent({
        task: "hang",
        cwd: freshAgentDir(),
        agentDir,
        model,
        modelRuntime: runtime,
      }), "configured explore run");

      assert.equal(handoff.status, "failed");
      assert.match(handoff.summary, /timed out after 200 ms/u);
    });

    it("turns a Verify child timeout into a session_failure protocol error", { timeout: RUN_TIMEOUT_MS }, async () => {
      const { runtime, model } = await fauxRuntime([() => new Promise(() => {})]);
      const result = await withEnv({ AIES_CHILD_TIMEOUT_MS: "200" }, () =>
        settle(runVerifyAgent({
          task: "verify a hung child",
          criteria: ["the thing works"],
          cwd: freshAgentDir(),
          agentDir: freshAgentDir(),
          model,
          modelRuntime: runtime,
        }), "verify run"),
      );

      assert.equal(result.kind, "protocol_error");
      assert.equal(result.code, "session_failure");
      assert.match(result.message, /timed out after 200 ms/u);
    });
  });

  describe("(c) turn limit", () => {
    it("fails the child as max_turns and aborts it when the next turn would exceed the limit", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild({ turns: 5 });
      await assert.rejects(
        settle(executeChildSession(scriptedOptions(freshAgentDir(), child, { limits: { timeoutMs: 60_000, maxTurns: 2 } })), "max-turns run"),
        (error) => {
          assert.equal(error.reason, "max_turns");
          assert.match(error.message, /turn limit of 2 turns/u);
          return true;
        },
      );
      assert.equal(child.calls.abort, 1);
      assert.equal(child.calls.dispose, 1);
    });

    it("stops a real Pi child at the second turn when maxTurns is 1", { timeout: RUN_TIMEOUT_MS }, async () => {
      const { runtime, model } = await fauxRuntime([
        fauxAssistantMessage([fauxToolCall("ls", { path: "." }, "call-ls-1")]),
        fauxAssistantMessage("done"),
      ]);
      const agentDir = freshAgentDir();

      await assert.rejects(
        settle(executeChildSession({
          task: "list then answer",
          cwd: agentDir,
          agentDir,
          systemPrompt: "You are a test child.",
          model,
          modelRuntime: runtime,
          tools: ["ls"],
          limits: { timeoutMs: 60_000, maxTurns: 1 },
        }), "real max-turns run"),
        (error) => error.reason === "max_turns",
      );
    });
  });

  describe("(d) already-aborted signal", () => {
    it("never starts the prompt and still disposes the session", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild({ answer: "should not run" });
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        settle(executeChildSession(scriptedOptions(freshAgentDir(), child, { signal: controller.signal })), "aborted run"),
        (error) => {
          assert.equal(error.reason, "cancelled");
          return true;
        },
      );
      assert.equal(child.calls.prompt.length, 0, "no prompt may be sent to an aborted child");
      assert.equal(child.calls.abort, 0);
      assert.equal(child.calls.dispose, 1);
    });
  });

  describe("(e) happy path is unchanged", () => {
    it("returns the final assistant text of a real Pi child within the limits", { timeout: RUN_TIMEOUT_MS }, async () => {
      const { runtime, model } = await fauxRuntime([fauxAssistantMessage("ALL DONE")]);
      const text = await settle(executeChildSession({
        task: "answer",
        cwd: freshAgentDir(),
        agentDir: freshAgentDir(),
        systemPrompt: "You are a test child.",
        model,
        modelRuntime: runtime,
        tools: [],
        limits: LONG_LIMITS,
      }), "real happy run");

      assert.equal(text, "ALL DONE");
    });

    it("returns the answer of a scripted child that completes within the limits", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild({ turns: 2, answer: "scripted answer" });
      const text = await settle(executeChildSession(scriptedOptions(freshAgentDir(), child)), "scripted happy run");

      assert.equal(text, "scripted answer");
      assert.equal(child.calls.abort, 0, "a completed child is never aborted");
      assert.equal(child.calls.dispose, 1);
    });
  });

  describe("(f) listener retirement and disposal", () => {
    it("retires the signal listener and the event subscription on success", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild({ answer: "ok" });
      const controller = new AbortController();
      await settle(executeChildSession(scriptedOptions(freshAgentDir(), child, { signal: controller.signal })), "success run");

      controller.abort();
      assert.equal(child.calls.abort, 0, "a finished child must not react to a later abort");
      assert.equal(child.calls.subscribe, child.calls.unsubscribe, "every subscription is released");
      assert.equal(child.calls.dispose, 1);
    });

    it("retires the signal listener after a timeout", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild();
      const controller = new AbortController();
      await assert.rejects(
        settle(
          executeChildSession(
            scriptedOptions(freshAgentDir(), child, {
              signal: controller.signal,
              limits: { timeoutMs: 50, maxTurns: 1_000 },
            }),
          ),
          "timed-out run",
        ),
      );

      controller.abort();
      assert.equal(child.calls.abort, 1, "only the timeout aborted the child");
      assert.equal(child.calls.subscribe, child.calls.unsubscribe);
    });

    it("disposes the session when the prompt itself throws", { timeout: RUN_TIMEOUT_MS }, async () => {
      const child = fakeChild({ promptError: new Error("provider exploded") });
      await assert.rejects(
        settle(executeChildSession(scriptedOptions(freshAgentDir(), child)), "throwing run"),
        /provider exploded/u,
      );
      assert.equal(child.calls.dispose, 1);
      assert.equal(child.calls.unsubscribe, child.calls.subscribe);
    });
  });

  describe("limit resolution (env > aies.json > default)", () => {
    it("exposes the calibrated defaults", () => {
      assert.equal(childSession.DEFAULT_CHILD_TIMEOUT_MS, 100 * 60 * 1000);
      assert.equal(childSession.DEFAULT_CHILD_MAX_TURNS, 100);
    });

    it("falls back to the defaults when nothing is configured", () => {
      const limits = childSession.resolveChildLimits("worker", freshAgentDir(), {});
      assert.deepEqual(limits, {
        timeoutMs: childSession.DEFAULT_CHILD_TIMEOUT_MS,
        maxTurns: childSession.DEFAULT_CHILD_MAX_TURNS,
      });
    });

    it("reads agents.<role> from aies.json when the environment is silent", () => {
      const agentDir = freshAgentDir();
      writeFileSync(
        join(agentDir, "aies.json"),
        JSON.stringify({ agents: { worker: { timeoutMs: 1_000, maxTurns: 7 }, explore: { maxTurns: 3 } } }),
      );
      assert.deepEqual(childSession.resolveChildLimits("worker", agentDir, {}), { timeoutMs: 1_000, maxTurns: 7 });
      assert.equal(childSession.resolveChildLimits("explore", agentDir, {}).maxTurns, 3);
      assert.equal(
        childSession.resolveChildLimits("explore", agentDir, {}).timeoutMs,
        childSession.DEFAULT_CHILD_TIMEOUT_MS,
        "a role's limits never leak into another role",
      );
    });

    it("lets the environment beat aies.json", () => {
      const agentDir = freshAgentDir();
      writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ agents: { worker: { timeoutMs: 1_000, maxTurns: 7 } } }));
      assert.deepEqual(
        childSession.resolveChildLimits("worker", agentDir, { AIES_CHILD_TIMEOUT_MS: "500", AIES_CHILD_MAX_TURNS: "9" }),
        { timeoutMs: 500, maxTurns: 9 },
      );
    });

    it("ignores invalid environment values and keeps the lower layers", () => {
      const agentDir = freshAgentDir();
      writeFileSync(join(agentDir, "aies.json"), JSON.stringify({ agents: { worker: { timeoutMs: 1_000 } } }));
      for (const bad of ["abc", "0", "-5", "1.5", ""]) {
        assert.deepEqual(
          childSession.resolveChildLimits("worker", agentDir, { AIES_CHILD_TIMEOUT_MS: bad, AIES_CHILD_MAX_TURNS: bad }),
          { timeoutMs: 1_000, maxTurns: childSession.DEFAULT_CHILD_MAX_TURNS },
          `invalid value ${JSON.stringify(bad)} must be ignored`,
        );
      }
    });
  });
});
