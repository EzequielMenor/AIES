/**
 * Subagent monitor V1 (D43): the rail's agent cards, the `/agents` expanded card,
 * the passive child sampling and the redaction before storing.
 *
 * Pure renderers with `PLAIN_PAINT`; no Pi runtime, no terminal, no timers and no
 * profile. Widths are measured with `.length`: every glyph the monitor draws
 * (`◆ ◇ ✓ ✗ ! █ ░ ↓ ↑ Σ ▸ ↳`) is one UTF-16 unit and one cell, and PLAIN_PAINT
 * emits no ANSI.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentObservatory, redactSensitive } from "../extensions/aies-agents/observatory.ts";
import * as sessionModule from "../extensions/aies-agents/session.ts";
import { applyAgents, createState, toSnapshot } from "../extensions/aies-runtime/state.ts";
import { agentTotals, totalCostText } from "../extensions/aies-ui/agent-monitor.ts";
import { displayWidth } from "../extensions/aies-ui/format.ts";
import { statusBox } from "../extensions/aies-ui/panel.ts";
import { renderAgentsView } from "../extensions/aies-ui/agents.ts";
import {
  MAX_RAIL_AGENTS,
  RIGHT_RAIL_CONTENT_WIDTH,
  RIGHT_RAIL_WIDE_CONTENT_WIDTH,
  railContentWidth,
  renderRightRail,
} from "../extensions/aies-ui/right-rail.ts";

const T0 = 1_700_000_000_000;

function record(overrides = {}) {
  return {
    id: "worker-1",
    role: "worker",
    status: "running",
    startedAt: T0,
    finishedAt: null,
    modelId: "m1",
    modelLabel: "Qwen 3.8 Flash",
    providerId: "openrouter",
    providerLabel: "openrouter",
    currentActivity: "Editando ui/agents.ts",
    currentTool: "edit",
    totalTokens: 21_300,
    inputTokens: 18_200,
    outputTokens: 3_100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 76_000,
    contextWindow: 200_000,
    contextPercent: 38,
    cost: 0.042,
    toolCount: 3,
    changedPaths: ["ui/agents.ts"],
    activities: [{ tool: "edit", text: "Editando ui/agents.ts", at: T0 + 1_000 }],
    result: null,
    ...overrides,
  };
}

const sub = (o = {}) => record({ billing: "subscription", cost: 0.018, ...o });

function rail(agents, width = 46, extra = {}) {
  const state = applyAgents(createState(T0), agents);
  return renderRightRail({ ...toSnapshot(state), agents }, T0 + 134_000, { width, ...extra });
}

describe("rail agent states", () => {
  it("shows the five states with glyph, label and the redacted reason for error and blocked", () => {
    const cases = [
      [record(), /◆ Worker #1\s+trabajando\s+02:14/u],
      [record({ currentActivity: null, currentTool: null, toolCount: 0, totalTokens: 0, changedPaths: [] }), /◇ Worker #1\s+esperando/u],
      [record({ status: "completed", finishedAt: T0 + 60_000 }), /✓ Worker #1\s+terminado\s+01:00/u],
      [record({ status: "failed", finishedAt: T0 + 5_000, result: "Worker session failed: boom" }), /✗ Worker #1\s+error/u],
      [record({ status: "blocked", finishedAt: T0 + 5_000, result: "needs approval" }), /! Worker #1\s+bloqueado/u],
    ];
    for (const [rec, pattern] of cases) {
      const text = rail([rec]).join("\n");
      assert.match(text, pattern, text);
    }
    assert.match(rail([record({ status: "failed", result: "Worker session failed: boom" })]).join("\n"), /↳ Worker session failed: boom/u);
    assert.match(rail([record({ status: "blocked", result: "needs approval" })]).join("\n"), /↳ needs approval/u);
  });

  it("freezes a finished agent's time", () => {
    const rec = record({ status: "completed", finishedAt: T0 + 15_000 });
    assert.match(rail([rec]).join("\n"), /terminado\s+00:15/u);
  });
});

describe("rail metrics", () => {
  it("shows model, cost, token breakdown, the current tool and the real context bar", () => {
    const text = rail([record()]).join("\n");
    assert.match(text, /Qwen 3\.8 Flash · \$0\.042 · 18\.2k↓ 3\.1k↑/u, text);
    assert.match(text, /ctx ████░░░░░░ 38% de 200k/u, text);
    assert.match(text, /▸ edit\s+ui\/agents\.ts/u, text);
  });

  it("never invents a context bar: unknown and post-compaction read ctx desconocido", () => {
    for (const overrides of [
      { contextPercent: null, contextTokens: null, contextWindow: null },
      { contextPercent: null, contextTokens: null, contextWindow: 200_000, totalTokens: 180_000 },
    ]) {
      const text = rail([record(overrides)]).join("\n");
      assert.match(text, /ctx desconocido/u, text);
      assert.equal(/█|░/u.test(text), false, text);
    }
  });

  it("shows coste n/d per agent and never a partial total as complete", () => {
    // Fixtures carry no `billing` (unknown): since D43's unclassified qualifier, a known cost
    // with unknown billing is never presented as billed, so the totals say `sin clasificar`.
    const text = rail([
      record({ id: "worker-1", cost: 0.12 }),
      record({ id: "explore-1", role: "explore", status: "completed", cost: null, startedAt: T0 - 1 }),
    ]).join("\n");
    assert.match(text, /coste n\/d/u, text);
    assert.match(text, /Σ \$0\.120\+ sin clasificar parcial/u, text);

    assert.match(rail([record({ cost: null })]).join("\n"), /Σ coste n\/d/u);
    const complete = rail([record({ cost: 0.5, billing: "api" })]).join("\n");
    assert.match(complete, /Σ \$0\.500 /u, complete);
    assert.equal(/parcial|sin clasificar/u.test(complete), false);

    const total = (list, compact) => totalCostText(agentTotals(list, T0), compact);
    assert.equal(total([record({ cost: 1, billing: "api" }), record({ cost: null })]), "$1.00+ parcial");
    assert.equal(total([record({ cost: 0.5 }), record({ cost: 0.25 })]), "$0.750 sin clasificar");
    assert.equal(total([record({ cost: 0.5 }), record({ cost: 1, billing: "api" })]), "$1.00 API + $0.500 sin clas.");
    assert.equal(total([record({ cost: 0.5 }), sub({ cost: 0.02 })]), "≈$0.020 est. + $0.500 sin clas.");
    assert.equal(total([record({ cost: 0.5 }), record({ cost: null })]), "$0.500+ sin clasificar parcial");
    // Narrower wordings: compact keeps `sin clas.`, only the last resort says `s/c`.
    const mixed = [record({ cost: 0.5 }), record({ cost: 1, billing: "api" })];
    assert.equal(total(mixed, true), "$1.00 API+$0.50 sin clas.");
    assert.equal(total(mixed, "min"), "$1.00 API+$0.50 s/c");
    assert.equal(total([record({ cost: 0.5 })], true), "$0.50 sin clas.");
  });
});

describe("rail sizing", () => {
  it("never draws a line wider than its assigned width, from 18 to 200 columns", () => {
    const agents = [record(), record({ id: "verify-1", role: "verify", status: "failed", result: "x".repeat(200) })];
    for (const width of [18, 40, 46, 58, 80, 200]) {
      for (const height of [undefined, 14, 24, 60]) {
        const lines = rail(agents, width, { height });
        const limit = Math.min(width, railContentWidth(width));
        assert.ok(lines.every((line) => line.length <= limit), `width ${width} height ${height}:\n${lines.join("\n")}`);
      }
    }
    assert.deepEqual(rail(agents, 18), []);
  });

  it("uses 46 content columns below 160 and 58 from 160", () => {
    assert.equal(railContentWidth(120), RIGHT_RAIL_CONTENT_WIDTH);
    assert.equal(railContentWidth(159), 46);
    assert.equal(railContentWidth(160), RIGHT_RAIL_WIDE_CONTENT_WIDTH);
    assert.equal(rail([record()], 200)[0].length, 58);
    assert.equal(rail([record()], 80)[0].length, 46);
  });

  it("falls back to one line per agent when the width or the height is small", () => {
    const text = (lines) => lines.join("\n");
    assert.match(text(rail([record()], 46)), /ctx /u);
    assert.equal(/ctx /u.test(text(rail([record()], 36))), false, "narrow width is compact");
    assert.equal(/ctx /u.test(text(rail([record()], 46, { height: 14 }))), false, "short height is compact");
    assert.match(text(rail([record()], 46, { height: 14 })), /◆ Worker #1\s+trabajando/u);
    assert.match(text(rail([record()], 46, { height: 40 })), /ctx /u, "ample height draws the card");
    // The Todos budget convention leaves the two frame rows outside `height`; no more than that.
    for (const height of [16, 20, 30]) {
      const lines = rail([record(), record({ id: "explore-1", role: "explore", status: "completed" })], 46, { height });
      assert.ok(lines.length <= height + 2, `height ${height} got ${lines.length} rows:\n${lines.join("\n")}`);
    }
  });

  it("caps the rail at three agents with a +N más line while /agents lists all", () => {
    const agents = Array.from({ length: 5 }, (_, i) =>
      record({ id: `worker-${i + 1}`, startedAt: T0 + i, status: "completed", finishedAt: T0 + 10_000 }),
    );
    const text = rail(agents).join("\n");
    assert.equal(MAX_RAIL_AGENTS, 3);
    assert.equal((text.match(/Worker #\d/gu) ?? []).length, 3, text);
    assert.match(text, /\+2 más/u, text);
    assert.match(text, /Σ .*\$0\.210/u, "the footer totals cover every agent");

    const view = renderAgentsView(agents, 0, T0 + 20_000, { width: 100 }).join("\n");
    for (let n = 1; n <= 5; n += 1) assert.match(view, new RegExp(`Worker #${n}`, "u"));
  });
});

describe("statusBox with painted string rows", () => {
  const ansi = { fg: (color, text) => `\u001b[38;5;${color.length + 30}m${text}\u001b[0m` };
  const visible = (line) => displayWidth(line.replace(/\u001b\[[0-9;]*m/gu, ""));

  it("aligns the right border at the visible width, at 46 and 72 columns", () => {
    for (const width of [46, 72]) {
      const rows = [ansi.fg("muted", "Todos · 4/4"), ansi.fg("accent", "x".repeat(200)), "plain row", { text: "row", painted: ansi.fg("text", "row") }];
      const lines = statusBox("title", rows, width, ansi);
      for (const line of lines) assert.equal(visible(line), width, `width ${width}: ${JSON.stringify(line)}`);
      assert.ok(lines[1].includes("\u001b["), "a painted row that fits keeps its colors");
    }
  });
});

describe("wide characters", () => {
  it("never exceeds 46 or 58 columns with CJK or emoji model labels", () => {
    for (const label of ["模型名称非常长的测试模型模型名称非常长", "🚀🚀🚀 rocket model 🚀🚀🚀🚀🚀🚀🚀🚀🚀", "ｆｕｌｌｗｉｄｔｈ ｍｏｄｅｌ ｎａｍｅ ｌｏｎｇ"]) {
      for (const width of [46, 58 + 102]) {
        const lines = rail([record({ modelLabel: label, status: "failed", result: `失败 ${label}` })], width);
        const limit = railContentWidth(width);
        assert.ok(lines.every((line) => displayWidth(line) === displayWidth(lines[0]) && displayWidth(line) <= limit), `${label} @${width}:\n${lines.join("\n")}`);
      }
    }
  });
});

describe("/agents expanded card", () => {
  const rec = record({
    cacheReadTokens: 1_200,
    cacheWriteTokens: 300,
    activities: Array.from({ length: 12 }, (_, i) => ({ tool: "read", text: `Leyendo src/f${i}.ts`, at: T0 + 100_000 + i })),
    changedPaths: ["a/b/c.ts", "d.ts"],
  });

  it("shows tool, history with relative times, paths, tokens, context and cost", () => {
    const text = renderAgentsView([rec], 0, T0 + 130_000, { width: 100, expanded: true }).join("\n");
    assert.match(text, /herramienta\s+edit/u, text);
    assert.match(text, /entrada\/salida\s+18\.2k↓ 3\.1k↑/u, text);
    assert.match(text, /caché\s+lectura 1\.2k · escritura 300/u, text);
    assert.match(text, /contexto\s+ctx ████░░░░░░ 38% de 200k/u, text);
    assert.match(text, /coste\s+\$0\.042/u, text);
    assert.match(text, /c\.ts/u);
    assert.match(text, /hace 30s\s+Leyendo src\/f0\.ts/u, text);
    assert.equal((text.match(/Leyendo src\/f\d+\.ts/gu) ?? []).length, 12);
  });

  it("shows the reason on error and stays inside every width", () => {
    const failed = record({ status: "failed", result: "token=abc123 leaked" });
    const text = renderAgentsView([failed], 0, T0, { width: 100, expanded: true }).join("\n");
    assert.match(text, /motivo/u);
    for (const width of [18, 40, 80, 200]) {
      for (const expanded of [false, true]) {
        const lines = renderAgentsView([rec, failed], 1, T0 + 130_000, { width, expanded });
        assert.ok(lines.every((line) => line.length <= width), `width ${width}:\n${lines.join("\n")}`);
      }
    }
  });

  it("replaces the dead context row with the real reading, em dash when unknown", () => {
    const known = renderAgentsView([record()], 0, T0, { width: 100 }).join("\n");
    assert.match(known, /contexto\s+████░░░░░░ 38% de 200k/u);
    const unknown = renderAgentsView([record({ contextPercent: null })], 0, T0, { width: 100 }).join("\n");
    assert.match(unknown, /contexto\s+—/u);
  });
});

function fakeChild(stats, context) {
  const listeners = [];
  return {
    session: {
      subscribe(listener) {
        listeners.push(listener);
        return () => {};
      },
      getSessionStats: stats,
      getContextUsage: context,
    },
    emit: (event) => listeners.forEach((listener) => listener(event)),
  };
}

describe("passive child sampling", () => {
  it("records the token breakdown, the context reading and the current tool from events", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "worker", at: T0 });
    const child = fakeChild(
      () => ({ tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, total: 18 }, cost: 0.01 }),
      () => ({ tokens: 4_000, contextWindow: 100_000, percent: 4 }),
    );
    sessionModule.attachChildObservatory(child.session, obs, id, { id: "m", provider: "openrouter" });
    child.emit({ type: "tool_execution_start", toolName: "edit", args: { path: "/home/u/src/a.ts" } });
    child.emit({ type: "turn_end" });
    const [snap] = obs.snapshot();
    assert.deepEqual(
      [snap.inputTokens, snap.outputTokens, snap.cacheReadTokens, snap.cacheWriteTokens, snap.totalTokens],
      [10, 5, 2, 1, 18],
    );
    assert.deepEqual([snap.contextTokens, snap.contextWindow, snap.contextPercent], [4_000, 100_000, 4]);
    assert.equal(snap.currentTool, "edit");
    assert.equal(Object.isFrozen(snap), true);

    obs.finish(id, { status: "completed", at: T0 + 1 });
    assert.equal(obs.snapshot()[0].currentTool, null);
  });

  it("keeps a null context after a compaction instead of deriving one", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "worker", at: T0 });
    const child = fakeChild(
      () => ({ tokens: { total: 900_000 }, cost: 0 }),
      () => ({ tokens: null, contextWindow: 200_000, percent: null }),
    );
    sessionModule.attachChildObservatory(child.session, obs, id);
    child.emit({ type: "turn_end" });
    const [snap] = obs.snapshot();
    assert.equal(snap.contextPercent, null);
    assert.equal(snap.contextTokens, null);
    assert.equal(snap.totalTokens, 900_000);
  });

  it("survives a throwing getContextUsage or getSessionStats without losing the other reading", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "worker", at: T0 });
    const boom = () => {
      throw new Error("metric exploded");
    };
    const noContext = fakeChild(() => ({ tokens: { total: 7 }, cost: 0.5 }), boom);
    sessionModule.attachChildObservatory(noContext.session, obs, id, { id: "m", provider: "openrouter" });
    assert.doesNotThrow(() => noContext.emit({ type: "turn_end" }));
    assert.equal(obs.snapshot()[0].totalTokens, 7);
    assert.equal(obs.snapshot()[0].contextPercent, null);

    const noStats = fakeChild(boom, () => ({ tokens: 1, contextWindow: 10, percent: 10 }));
    sessionModule.attachChildObservatory(noStats.session, obs, id);
    assert.doesNotThrow(() => noStats.emit({ type: "agent_end" }));
    assert.equal(obs.snapshot()[0].totalTokens, 7, "the last stats sample stays");
    assert.equal(obs.snapshot()[0].contextPercent, 10);

    const neither = fakeChild(boom, boom);
    sessionModule.attachChildObservatory(neither.session, obs, id);
    assert.doesNotThrow(() => neither.emit({ type: "agent_settled" }));
  });

  it("turns a failed or non-object context read into unknown while stats keep updating", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "worker", at: T0 });
    let step = 0;
    const child = fakeChild(
      () => ({ tokens: { total: 100 * (step + 1) }, cost: 0.1 * (step + 1) }),
      () => {
        if (step === 0) return { tokens: 4_000, contextWindow: 100_000, percent: 4 };
        if (step === 1) throw new Error("context exploded");
        return "not an object";
      },
    );
    sessionModule.attachChildObservatory(child.session, obs, id, { id: "m", provider: "openrouter" });
    child.emit({ type: "turn_end" });
    assert.equal(obs.snapshot()[0].contextPercent, 4);
    for (step = 1; step <= 2; step += 1) {
      child.emit({ type: "turn_end" });
      const [snap] = obs.snapshot();
      assert.deepEqual([snap.contextTokens, snap.contextWindow, snap.contextPercent], [null, null, null]);
      assert.equal(snap.totalTokens, 100 * (step + 1));
      assert.match(renderRightRail({ ...toSnapshot(createState(T0)), agents: [snap] }, T0, { width: 46 }).join("\n"), /ctx desconocido/u);
    }
  });

  it("updateUsage and observe produce the new snapshot fields", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "verify", at: T0 });
    obs.observe(id, "grep", { pattern: "x", path: "a/b/c.ts" }, T0 + 1);
    obs.updateUsage(id, { inputTokens: 3, outputTokens: 4, contextPercent: 50, contextWindow: 10, contextTokens: 5 });
    const [snap] = obs.snapshot();
    assert.equal(snap.currentTool, "grep");
    assert.deepEqual([snap.inputTokens, snap.outputTokens, snap.contextPercent], [3, 4, 50]);
  });
});

describe("redaction before storing", () => {
  const SECRETS = [
    "sk-proj-abcdefghijklmnop1234",
    "ghp_abcdefghijklmnopqrstuvwx1234",
    "Bearer abc.def-123456",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sgnature123",
    "hunter2pass",
    "s3cr3tvalue",
    "pa55word",
  ];
  const text =
    "failed with sk-proj-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwx1234, " +
    "Authorization: Bearer abc.def-123456, jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sgnature123, " +
    "password=hunter2pass secret=s3cr3tvalue API_KEY=zzz https://user:pa55word@host.example/x";

  it("removes secrets from the text helper", () => {
    const out = redactSensitive(text);
    for (const secret of SECRETS) assert.equal(out.includes(secret), false, `${secret} leaked: ${out}`);
    assert.equal(out.includes("API_KEY=zzz"), false);
    assert.match(out, /host\.example/u);
  });

  it("covers Authorization schemes, flag values and PEM blocks", () => {
    const out = redactSensitive(
      "Authorization: Basic dXNlcjpwYXNz Authorization: Digest abc123xyz run --token tok123 --password=pw456 --api-key key789 " +
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY----- done",
    );
    for (const leaked of ["dXNlcjpwYXNz", "abc123xyz", "tok123", "pw456", "key789", "MIIEowIBAAKCAQEA"]) {
      assert.equal(out.includes(leaked), false, `${leaked} leaked: ${out}`);
    }
    assert.match(out, /done/u);
  });

  it("stays fast on pathological and oversized input", () => {
    const start = performance.now();
    const out = redactSensitive("a.a.a.".repeat(20_000) + " token=zzz");
    redactSensitive(`${"password".repeat(10_000)}=x`);
    assert.ok(performance.now() - start < 200, `redaction took ${performance.now() - start}ms`);
    assert.ok(out.length <= 4096 + 64);
  });

  it("redacts the activity, grep pattern, error, result and labels in the stored record", () => {
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "worker", modelLabel: "model sk-proj-abcdefghijklmnop1234", providerLabel: "p password=hunter2pass", at: T0 });
    obs.observe(id, "grep", { pattern: "ghp_abcdefghijklmnopqrstuvwx1234" }, T0);
    obs.observe(id, "bash", { command: "curl -H 'Authorization: Bearer abc.def-123456' https://user:pa55word@h/x" }, T0);
    obs.finish(id, { status: "failed", result: text });
    const stored = JSON.stringify(obs.snapshot());
    for (const secret of SECRETS) assert.equal(stored.includes(secret), false, `${secret} leaked: ${stored}`);
    // Bash commands are still never shown raw.
    assert.equal(stored.includes("curl"), false);
  });
});

describe("billing, <1% context and cache note", () => {
  const text = (agents, width = 46, extra = {}) => rail(agents, width, extra).join("\n");

  it("marks subscription cost with ≈ in the card, the compact line and /agents; api has none", () => {
    assert.match(text([sub()]), /≈\$0\.018/u);
    assert.match(text([sub()], 46, { height: 14 }), /trabajando.*≈\$0\.018/u, "compact line");
    assert.match(text([record({ billing: "api", cost: 0.018 })]), / \$0\.018/u);
    assert.equal(/≈/u.test(text([record({ billing: "api", cost: 0.018 })])), false);
    assert.equal(/≈/u.test(text([record({ billing: null, cost: 0.018 })])), false);
    const view = renderAgentsView([sub()], 0, T0, { width: 120, expanded: true }).join("\n");
    assert.match(view, /coste\s+≈\$0\.018/u);
    assert.match(view, /estimación equivalente a API; con suscripción no es gasto facturado/u);
    const unknown = renderAgentsView([record({ billing: null })], 0, T0, { width: 120, expanded: true }).join("\n");
    assert.match(unknown, /facturación desconocida/u);
    assert.match(renderAgentsView([sub()], 0, T0, { width: 120 }).join("\n"), /≈ estimación/u);
  });

  it("separates estimated and billed totals and keeps the partial rule", () => {
    const only = (list) => totalCostText(agentTotals(list, T0));
    assert.equal(only([sub({ cost: 0.01 }), sub({ cost: 0.01 })]), "≈$0.020 est.");
    assert.equal(only([record({ billing: "api", cost: 0.01 }), sub({ cost: 0.02 })]), "$0.010 API + ≈$0.020 est.");
    assert.equal(only([sub({ cost: 0.02 }), record({ cost: null })]), "≈$0.020+ est. parcial");
    assert.equal(only([record({ billing: "api", cost: 0.01 }), sub({ cost: 0.02 }), record({ cost: null })]), "$0.010 API + ≈$0.020+ est. parcial");
    assert.match(text([sub({ cost: 0.01 }), sub({ id: "explore-1", role: "explore", cost: 0.01, startedAt: T0 - 1 })]), /Σ .*≈\$0\.020 est\./u);
  });

  it("keeps the qualifiers alive at 46 columns (42 inner cells)", () => {
    const footer = (agents) => rail(agents, 46).find((line) => line.includes("Σ"));
    const base = { totalTokens: 21_300 };
    const worst = [
      record({ ...base, id: "a-1", billing: "api", cost: 0.01 }),
      sub({ ...base, id: "b-1", cost: 0.02 }),
      record({ ...base, id: "c-1", cost: 0.03 }),
      record({ ...base, id: "d-1", cost: null }),
    ];
    // Three kinds plus a partial total must still read: API, est., s/c and parcial.
    const mixed = footer(worst.slice(0, 3).concat(worst[3]));
    assert.ok(mixed, "footer present");
    assert.match(mixed, /API\+?.*est\..*s\/c.*parcial/u, mixed);
    const partialMix = footer([worst[0], worst[1], worst[3]]);
    assert.match(partialMix, /API \+ ≈\$0\.020\+ est\. parcial/u, partialMix);
    assert.match(footer([record({ cost: 0.5 }), record({ id: "x-1", cost: 0.25 })]), /sin clasificar/u);
    assert.match(footer([record({ cost: 0.5 }), record({ id: "x-1", cost: null })]), /sin clasificar parcial/u);
    assert.match(footer([sub({ cost: 0.01 }), sub({ id: "x-1", cost: null })]), /est\. parcial/u);
  });

  it("shows <1% for a tiny real reading, 0% for zero and unknown for null", () => {
    assert.match(text([record({ contextPercent: 0.4, contextWindow: 272_000 })]), /ctx ░{10} <1% de 272k/u);
    assert.match(text([record({ contextPercent: 0 })]), /ctx ░{10} 0% de 200k/u);
    assert.match(text([record({ contextPercent: null })]), /ctx desconocido/u);
    assert.match(renderAgentsView([record({ contextPercent: 0.2 })], 0, T0, { width: 100 }).join("\n"), /<1% de 200k/u);
  });

  it("flags cache in the rail and explains it in /agents", () => {
    assert.match(text([record({ cacheReadTokens: 900 })]), /18\.2k↓ 3\.1k↑ \+caché/u);
    assert.equal(/\+caché/u.test(text([record()])), false);
    const view = renderAgentsView([record({ cacheReadTokens: 900 })], 0, T0, { width: 100, expanded: true }).join("\n");
    assert.match(view, /el total puede incluir caché/u);
  });

  it("keeps the new texts inside 46 and 58 columns", () => {
    const agents = [sub({ modelLabel: "模型名称非常长🚀 model", cacheReadTokens: 5, contextPercent: 0.3, contextWindow: 272_000 }), record({ id: "verify-1", role: "verify", billing: "api", cost: 12.5 })];
    for (const width of [46, 160]) {
      for (const height of [undefined, 14]) {
        const lines = rail(agents, width, { height });
        assert.ok(lines.every((line) => displayWidth(line) <= railContentWidth(width)), lines.join("\n"));
      }
    }
  });

  it("probes a real in-memory ModelRuntime without credentials", async () => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const real = await ModelRuntime.create();
    // No stored credential: not OAuth, not a subscription, so a plain API provider.
    assert.equal(real.isUsingSubscription("openai-codex"), false);
    assert.equal(sessionModule.probeChildBilling(real, { provider: "openai-codex" }), "api");
    assert.equal(sessionModule.probeChildBilling(real, { provider: "openrouter" }), "api");
  });

  it("probes billing passively: OAuth, api, plan provider, missing and throwing probes", () => {
    const probe = sessionModule.probeChildBilling;
    // A fake with the exact ModelRuntime shape: isUsingSubscription = oauth && declared subscription.
    const runtime = (oauth, declared) => ({ isUsingOAuth: () => oauth, isUsingSubscription: () => oauth && declared });
    assert.equal(probe(runtime(true, true), { provider: "openai-codex" }), "subscription");
    assert.equal(probe(runtime(true, false), { provider: "some-free-tier" }), null, "OAuth that is not a declared subscription is unclassified");
    assert.equal(probe(runtime(false, false), { provider: "openrouter" }), "api");
    assert.equal(probe({}, { provider: "openrouter" }), null);
    assert.equal(probe({ isUsingOAuth: () => true }, { provider: "openrouter" }), null, "isUsingSubscription is required");
    assert.equal(probe({ isUsingSubscription: () => { throw new Error("boom"); } }, { provider: "openrouter" }), null);
    assert.equal(probe({ isUsingSubscription: () => "yes" }, { provider: "openrouter" }), null);
    assert.equal(probe({ isUsingSubscription: () => false, isUsingOAuth: () => "?" }, { provider: "openrouter" }), null);
    assert.equal(probe(undefined, { provider: "kimi-coding" }), "subscription", "plan provider id heuristic");
    assert.equal(probe(runtime(true, true), {}), null, "no model id inference without a provider");
    const obs = new AgentObservatory();
    const id = obs.begin({ role: "worker", at: T0 });
    obs.updateUsage(id, { billing: "subscription" });
    assert.equal(obs.snapshot()[0].billing, "subscription");
    obs.updateUsage(id, { billing: "bogus" });
    assert.equal(obs.snapshot()[0].billing, null);
  });
});
