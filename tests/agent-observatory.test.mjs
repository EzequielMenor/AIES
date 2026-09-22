/**
 * AIES-010C Agent Observatory checks (T3).
 *
 * The registry and the usage aggregation are pure, session-local presentation
 * state: no Pi import, no filesystem, no transcript, no reasoning and no
 * authority. Both modules are driven directly with plain objects so every rule
 * has a direct assertion.
 *
 * The suite is deliberately deterministic: callers pass explicit timestamps, so
 * no wall-clock value decides a result.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { aggregateUsage } from "../extensions/aies-runtime/usage.ts";
import {
  AgentObservatory,
  MAX_ACTIVITIES,
  changedPathOf,
  describeActivity,
  firstCommandLine,
  observatory,
  shortPath,
} from "../extensions/aies-agents/observatory.ts";

const OBSERVATORY_SOURCE = new URL("../extensions/aies-agents/observatory.ts", import.meta.url);
const USAGE_SOURCE = new URL("../extensions/aies-runtime/usage.ts", import.meta.url);

/** A fresh registry per test: the module singleton is never shared across cases. */
function registry() {
  return new AgentObservatory();
}

function bucket(totalTokens, cost) {
  return { totalTokens, cost };
}

describe("AIES-010C pure module boundary", () => {
  it("imports nothing that could reach Pi, the filesystem or the network", () => {
    for (const source of [OBSERVATORY_SOURCE, USAGE_SOURCE]) {
      const text = readFileSync(source, "utf8");
      assert.equal(/@earendil-works/u.test(text), false, `${source.pathname} must not import Pi`);
      assert.equal(/from\s+["']node:/u.test(text), false, `${source.pathname} must not import node builtins`);
      assert.equal(/child_process|node:fs|require\(/u.test(text), false, source.pathname);
    }
  });
});

describe("AIES-010C usage aggregation", () => {
  it("keeps Main as the Parent bucket and Agents as the child sum", () => {
    const result = aggregateUsage(bucket(1000, 0.5), [bucket(200, 0.1), bucket(300, 0.2)]);

    assert.deepEqual(result.main, { totalTokens: 1000, cost: 0.5 });
    assert.deepEqual(result.agents, { totalTokens: 500, cost: 0.30000000000000004 });
  });

  it("makes Total exactly Main + Agents, counted once", () => {
    const result = aggregateUsage(bucket(1000, 1), [bucket(200, 0.25), bucket(300, 0.25)]);

    assert.equal(result.total.totalTokens, 1500);
    assert.equal(result.total.cost, 1.5);
    // No double counting: Total never equals Parent + every child twice.
    assert.notEqual(result.total.totalTokens, 1000 + 200 + 200 + 300 + 300);
  });

  it("preserves Main as the Parent usage with no child folded in", () => {
    const result = aggregateUsage(bucket(42, null), [bucket(7, 1)]);

    assert.equal(result.main.totalTokens, 42);
    assert.equal(result.agents.totalTokens, 7);
    assert.equal(result.total.totalTokens, 49);
  });

  it("returns a known zero Agents bucket when there are no children", () => {
    const result = aggregateUsage(bucket(10, 0.1), []);

    assert.deepEqual(result.agents, { totalTokens: 0, cost: 0 });
    assert.deepEqual(result.total, { totalTokens: 10, cost: 0.1 });
  });

  it("reports Total cost as unavailable when the Parent cost is unknown", () => {
    const result = aggregateUsage(bucket(10, null), [bucket(5, 0.5)]);

    assert.equal(result.main.cost, null);
    assert.equal(result.total.cost, null);
  });

  it("reports Total cost as unavailable when any included child cost is unknown", () => {
    const result = aggregateUsage(bucket(10, 1), [bucket(5, 0.5), bucket(2, null), bucket(3, 0.25)]);

    assert.equal(result.agents.cost, null);
    assert.equal(result.total.cost, null);
  });

  it("never estimates a missing aggregate cost", () => {
    const result = aggregateUsage(undefined, [bucket(5, 0.5)]);

    assert.equal(result.main.totalTokens, 0);
    assert.equal(result.main.cost, null);
    assert.equal(result.total.cost, null);
  });

  it("skips absent child slots instead of treating them as unknown usage", () => {
    const result = aggregateUsage(bucket(10, 1), [bucket(5, 0.5), null, undefined, bucket(5, 0.5)]);

    assert.equal(result.agents.totalTokens, 10);
    assert.equal(result.agents.cost, 1);
    assert.equal(result.total.cost, 2);
  });

  it("normalises negative and non-finite token counts to zero", () => {
    const result = aggregateUsage(bucket(-5, 1), [bucket(Number.NaN, 0.5)]);

    assert.equal(result.main.totalTokens, 0);
    assert.equal(result.agents.totalTokens, 0);
    assert.equal(result.total.totalTokens, 0);
  });
});

describe("AIES-010C mechanical activity wording", () => {
  it("shortens a path to its last two safe segments", () => {
    assert.equal(shortPath("/Users/someone/repo/extensions/aies-agents/observatory.ts"), "aies-agents/observatory.ts");
    assert.equal(shortPath("./docs/UX.md"), "docs/UX.md");
    assert.equal(shortPath("observatory.ts"), "observatory.ts");
    assert.equal(shortPath("  a\\b\\c.ts  "), "b/c.ts");
  });

  it("collapses whitespace and returns nothing for empty input", () => {
    assert.equal(shortPath("a/\n/b.ts"), "a/b.ts");
    assert.equal(shortPath("   "), "");
    assert.equal(shortPath(undefined), "");
  });

  it("keeps only the first command line, bounded", () => {
    assert.equal(firstCommandLine("git status\nrm -rf node_modules"), "git status");
    assert.equal(firstCommandLine("   \n  npm test  "), "npm test");
    assert.equal(firstCommandLine(""), "");

    const long = `node --test ${"x".repeat(200)}`;
    const short = firstCommandLine(long);
    assert.ok(short.length <= 60, short);
    assert.ok(short.startsWith("node --test"));
  });

  it("words read, grep, find and ls from the tool and its argument", () => {
    assert.equal(describeActivity("read", { path: "src/a/b.ts" }), "Leyendo a/b.ts");
    assert.equal(describeActivity("grep", { pattern: "observatory", path: "src/app.ts" }), "Buscando src/app.ts");
    assert.equal(describeActivity("grep", { pattern: "observatory" }), "Buscando observatory");
    assert.equal(describeActivity("find", { path: "tests/agent.test.mjs" }), "Buscando tests/agent.test.mjs");
    assert.equal(describeActivity("ls", { path: "extensions/aies-ui" }), "Listando extensions/aies-ui");
    assert.equal(describeActivity("ls", {}), "Consultando archivo");
  });

  it("words edit and write as an edit of the target file", () => {
    assert.equal(describeActivity("edit", { filePath: "extensions/x.ts" }), "Editando extensions/x.ts");
    assert.equal(describeActivity("write", { file_path: "tests/y.mjs" }), "Editando tests/y.mjs");
    assert.equal(describeActivity("edit", {}), "Modificando archivos");
  });

  it("words bash as human categories and verify as a verdict check", () => {
    assert.equal(describeActivity("bash", { command: "npm test\nnpm run build" }), "Ejecutando tests");
    assert.equal(describeActivity("bash", { command: "git status" }), "Comprobando estado Git");
    assert.equal(describeActivity("bash", { command: "sed -i 's/a/b/' file.txt" }), "Modificando archivos");
    assert.equal(describeActivity("bash", { command: "cat file.txt" }), "Leyendo archivos");
    assert.equal(describeActivity("bash", { command: "grep pattern file.txt" }), "Buscando referencias");
    assert.equal(describeActivity("bash", { command: "mkdir fixtures && touch fixtures/a.json" }), "Preparando fixture");
    assert.equal(describeActivity("aies_verify_complete", { status: "pass" }), "Comprobando el veredicto");
  });

  it("degrades an unknown tool to a mechanical line and an absent tool to nothing", () => {
    assert.equal(describeActivity("mcp__x__y", {}), "Ejecutando comando");
    assert.equal(describeActivity("", {}), null);
    assert.equal(describeActivity(undefined, {}), null);
  });

  it("never lets a raw multi-line command reach the wording", () => {
    const text = describeActivity("bash", { command: "line one\nline two\tstuff" });
    assert.equal(text, "Ejecutando comando");
    assert.equal(text.includes("\n"), false);
  });

  it("tracks a changed path only for edit and write", () => {
    assert.equal(changedPathOf("edit", { path: "./src/a.ts" }), "src/a.ts");
    assert.equal(changedPathOf("write", { filePath: "src/b.ts" }), "src/b.ts");
    assert.equal(changedPathOf("read", { path: "src/a.ts" }), null);
    assert.equal(changedPathOf("bash", { command: "rm x" }), null);
    assert.equal(changedPathOf("edit", {}), null);
  });
});

describe("AIES-010C registry lifecycle", () => {
  it("starts empty and clears everything on reset", () => {
    const obs = registry();
    assert.deepEqual(obs.snapshot(), []);

    obs.begin({ role: "worker", at: 1000 });
    assert.equal(obs.snapshot().length, 1);

    obs.reset();
    assert.deepEqual(obs.snapshot(), []);
  });

  it("creates a running record with a stable role ordinal id", () => {
    const obs = registry();
    const id = obs.begin({ role: "worker", at: 1000 });

    assert.equal(id, "worker-1");
    const [record] = obs.snapshot();
    assert.equal(record.id, "worker-1");
    assert.equal(record.role, "worker");
    assert.equal(record.status, "running");
    assert.equal(record.startedAt, 1000);
    assert.equal(record.finishedAt, null);
    assert.equal(record.currentActivity, null);
    assert.equal(record.totalTokens, 0);
    assert.equal(record.cost, null);
    assert.equal(record.toolCount, 0);
    assert.deepEqual(record.changedPaths, []);
    assert.deepEqual(record.activities, []);
    assert.equal(record.result, null);
  });

  it("numbers records per role so a role keeps a stable ordinal sequence", () => {
    const obs = registry();
    assert.equal(obs.begin({ role: "worker" }), "worker-1");
    assert.equal(obs.begin({ role: "explore" }), "explore-1");
    assert.equal(obs.begin({ role: "worker" }), "worker-2");
    assert.equal(obs.begin({ role: "verify" }), "verify-1");

    assert.deepEqual(
      obs.snapshot().map((record) => record.id),
      ["worker-1", "explore-1", "worker-2", "verify-1"],
    );
  });

  it("projects model and provider ids with labels", () => {
    const obs = registry();
    obs.begin({
      role: "verify",
      modelId: "claude-sonnet",
      modelLabel: "Claude Sonnet",
      providerId: "anthropic",
      providerLabel: "Anthropic",
    });

    const [record] = obs.snapshot();
    assert.equal(record.modelId, "claude-sonnet");
    assert.equal(record.modelLabel, "Claude Sonnet");
    assert.equal(record.providerId, "anthropic");
    assert.equal(record.providerLabel, "Anthropic");
  });

  it("falls back from a missing label to the id and to null", () => {
    const obs = registry();
    obs.begin({ role: "worker", modelId: "gpt-x", providerId: "openai" });
    obs.begin({ role: "explore" });

    const [first, second] = obs.snapshot();
    assert.equal(first.modelLabel, "gpt-x");
    assert.equal(first.providerLabel, "openai");
    assert.equal(second.modelId, null);
    assert.equal(second.modelLabel, null);
    assert.equal(second.providerLabel, null);
  });

  it("ignores observations and finishes for an unknown id", () => {
    const obs = registry();
    obs.begin({ role: "worker" });

    obs.observe("nope-1", "read", { path: "a.ts" });
    obs.updateUsage("nope-1", bucket(5, 1));
    obs.finish("nope-1");

    const [record] = obs.snapshot();
    assert.equal(record.toolCount, 0);
    assert.equal(record.totalTokens, 0);
    assert.equal(record.status, "running");
  });
});

describe("AIES-010C activity and usage observation", () => {
  it("counts tools, sets the current activity and records the entry", () => {
    const obs = registry();
    obs.begin({ role: "worker", at: 1000 });

    obs.observe("worker-1", "read", { path: "src/a/b.ts" }, 1100);
    obs.observe("worker-1", "bash", { command: "npm test" }, 1200);

    const [record] = obs.snapshot();
    assert.equal(record.toolCount, 2);
    assert.equal(record.currentActivity, "Ejecutando tests");
    assert.deepEqual(
      record.activities.map((entry) => entry.text),
      ["Ejecutando tests", "Leyendo a/b.ts"],
    );
    assert.deepEqual(
      record.activities.map((entry) => entry.at),
      [1200, 1100],
    );
  });

  it("keeps at most five recent activities, newest first", () => {
    const obs = registry();
    obs.begin({ role: "worker" });
    for (let index = 0; index < MAX_ACTIVITIES + 3; index += 1) {
      obs.observe("worker-1", "read", { path: `src/file-${index}.ts` }, 1000 + index);
    }

    const [record] = obs.snapshot();
    assert.equal(record.activities.length, MAX_ACTIVITIES);
    assert.equal(record.activities[0].text, "Leyendo src/file-7.ts");
    assert.equal(record.activities.at(-1).text, "Leyendo src/file-3.ts");
    assert.equal(record.toolCount, MAX_ACTIVITIES + 3);
  });

  it("collects changed paths from edits without duplicating them", () => {
    const obs = registry();
    obs.begin({ role: "worker" });

    obs.observe("worker-1", "edit", { path: "src/a.ts" });
    obs.observe("worker-1", "write", { path: "src/a.ts" });
    obs.observe("worker-1", "write", { path: "src/b.ts" });
    obs.observe("worker-1", "read", { path: "src/c.ts" });

    const [record] = obs.snapshot();
    assert.deepEqual(record.changedPaths, ["src/a.ts", "src/b.ts"]);
  });

  it("sets total tokens and a nullable cost, keeping the last sample", () => {
    const obs = registry();
    obs.begin({ role: "worker" });

    obs.updateUsage("worker-1", bucket(120, 0.02));
    obs.updateUsage("worker-1", bucket(340, 0.05));
    let [record] = obs.snapshot();
    assert.equal(record.totalTokens, 340);
    assert.equal(record.cost, 0.05);

    obs.updateUsage("worker-1", { totalTokens: 400, cost: null });
    [record] = obs.snapshot();
    assert.equal(record.totalTokens, 400);
    assert.equal(record.cost, null);
  });

  it("finishes a record with status, timestamp and a compact result", () => {
    const obs = registry();
    obs.begin({ role: "worker", at: 1000 });
    obs.observe("worker-1", "bash", { command: "npm test" });

    obs.finish("worker-1", { status: "completed", result: "listo\nsin pendientes", at: 5000 });

    const [record] = obs.snapshot();
    assert.equal(record.status, "completed");
    assert.equal(record.finishedAt, 5000);
    assert.equal(record.currentActivity, null);
    assert.equal(record.result, "listo sin pendientes");
  });

  it("defaults a finish without a status to completed", () => {
    const obs = registry();
    obs.begin({ role: "worker" });
    obs.finish("worker-1", { at: 2000 });

    const [record] = obs.snapshot();
    assert.equal(record.status, "completed");
    assert.equal(record.result, null);
  });

  it("carries failed and blocked outcomes", () => {
    const obs = registry();
    obs.begin({ role: "worker" });
    obs.begin({ role: "verify" });
    obs.finish("worker-1", { status: "blocked", result: "faltan permisos" });
    obs.finish("verify-1", { status: "failed", result: "un criterio falló" });

    const [worker, verify] = obs.snapshot();
    assert.equal(worker.status, "blocked");
    assert.equal(worker.result, "faltan permisos");
    assert.equal(verify.status, "failed");
    assert.equal(verify.result, "un criterio falló");
  });
});

describe("AIES-010C immutable snapshot and subscription", () => {
  it("returns a frozen snapshot detached from the live registry", () => {
    const obs = registry();
    obs.begin({ role: "worker" });
    obs.observe("worker-1", "edit", { path: "src/a.ts" });

    const first = obs.snapshot();
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first[0]), true);
    assert.equal(Object.isFrozen(first[0].activities), true);
    assert.equal(Object.isFrozen(first[0].activities[0]), true);
    assert.equal(Object.isFrozen(first[0].changedPaths), true);

    // Mutating the returned snapshot throws in strict mode and cannot corrupt the registry.
    assert.throws(() => first[0].changedPaths.push("src/evil.ts"));
    assert.throws(() => first[0].activities.push({ tool: "x", text: "x", at: 0 }));
    assert.throws(() => {
      first[0].status = "failed";
    });

    assert.deepEqual(obs.snapshot()[0].changedPaths, ["src/a.ts"]);
    assert.equal(obs.snapshot()[0].status, "running");
  });

  it("notifies subscribers on every mutation with a fresh snapshot", () => {
    const obs = registry();
    const seen = [];
    const unsubscribe = obs.subscribe((snapshot) => seen.push(snapshot));

    obs.begin({ role: "worker" });
    obs.observe("worker-1", "read", { path: "a.ts" });
    obs.finish("worker-1", { status: "completed" });

    assert.equal(seen.length, 3);
    assert.equal(seen.at(-1)[0].status, "completed");

    unsubscribe();
    obs.begin({ role: "verify" });
    assert.equal(seen.length, 3);
  });

  it("supports explicit unsubscribe and survives a throwing listener", () => {
    const obs = registry();
    let calls = 0;
    const listener = () => {
      calls += 1;
    };
    obs.subscribe(listener);
    obs.subscribe(() => {
      throw new Error("broken listener");
    });

    obs.begin({ role: "worker" });
    obs.begin({ role: "verify" });
    assert.equal(calls, 2);

    obs.unsubscribe(listener);
    obs.begin({ role: "explore" });
    assert.equal(calls, 2);
    assert.equal(obs.snapshot().length, 3);
  });

  it("resets records but keeps subscribers attached", () => {
    const obs = registry();
    let calls = 0;
    obs.subscribe(() => {
      calls += 1;
    });

    obs.begin({ role: "worker" });
    obs.reset();
    assert.equal(calls, 2);
    assert.deepEqual(obs.snapshot(), []);

    // Ordinals restart with the session: a new session is a new run.
    assert.equal(obs.begin({ role: "worker" }), "worker-1");
  });

  it("keeps the module singleton isolated from a fresh instance", () => {
    observatory.reset();
    observatory.begin({ role: "worker" });
    const obs = registry();
    obs.begin({ role: "worker" });

    assert.equal(observatory.snapshot().length, 1);
    assert.equal(obs.snapshot().length, 1);
    observatory.reset();
    assert.deepEqual(observatory.snapshot(), []);
  });
});
