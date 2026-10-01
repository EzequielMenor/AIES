/**
 * AIES T3 Agent Observatory renderer checks.
 *
 * `renderAgentsView` is the `/agents` modal screen and `selectAgent` is the pure
 * navigation helper the runtime binds keys to. Both are pure: records in, lines
 * out, no state, no Pi, `PLAIN_PAINT`.
 *
 * Assertions are structural (selection, which facts appear, clipping, responsive
 * composition) so copy can evolve without giant snapshot tests.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AGENTS_MODAL_WIDTH,
  AGENTS_SPLIT_MIN_WIDTH,
  AGENTS_VISIBLE_ROWS,
  renderAgentsView,
  selectAgent,
} from "../extensions/aies-ui/agents.ts";

const T0 = 1_700_000_000_000;

/** A minimal `AgentRecord` the observatory would produce. */
function record(overrides = {}) {
  return {
    id: "worker-1",
    role: "worker",
    status: "running",
    startedAt: T0,
    finishedAt: null,
    modelId: null,
    modelLabel: null,
    providerId: null,
    providerLabel: null,
    currentActivity: null,
    totalTokens: 0,
    cost: null,
    toolCount: 0,
    changedPaths: [],
    activities: [],
    result: null,
    ...overrides,
  };
}

/** One line per record, so a bounded list is easy to count. */
function listRowCount(lines) {
  return lines.filter((line) => /#\d+/u.test(line)).length;
}

/** A paint that records every (tone, text) pair the shared frame asks for. */
function capturingPaint() {
  const calls = [];
  return {
    calls,
    fg(color, text) {
      calls.push({ color, text });
      return text;
    },
  };
}

/** The tone the frame painted the line that contains `needle`, or undefined. */
function toneOf(paint, needle) {
  const call = paint.calls.find((entry) => entry.text.includes(needle));
  return call ? call.color : undefined;
}

describe("selectAgent", () => {
  const list = [record({ id: "a" }), record({ id: "b" }), record({ id: "c" })];

  it("wraps around left and right with up and down as aliases", () => {
    assert.equal(selectAgent(list, 0, "left"), 2);
    assert.equal(selectAgent(list, 2, "right"), 0);
    assert.equal(selectAgent(list, 1, "up"), 0);
    assert.equal(selectAgent(list, 0, "down"), 1);
    assert.equal(selectAgent(list, 1, "left"), 0);
    assert.equal(selectAgent(list, 1, "right"), 2);
  });

  it("clamps an out-of-range index and survives an empty list", () => {
    assert.equal(selectAgent(list, 9, "right"), 1);
    assert.equal(selectAgent([], 0, "right"), 0);
    assert.equal(selectAgent([], 4, "left"), 0);
  });
});

describe("renderAgentsView", () => {
  it("frames the list, detail and key hint as one bounded AIES modal", () => {
    const list = [
      record({
        id: "worker-1",
        role: "worker",
        status: "running",
        changedPaths: ["src/calculator.js"],
        modelLabel: "Qwen 3.8 Flash",
        providerLabel: "openrouter",
        totalTokens: 34_000,
        cost: 0.03,
        toolCount: 4,
        activities: [{ tool: "edit", text: "Editando calculator.js", at: T0 }],
      }),
      record({ id: "verify-1", role: "verify", status: "completed", startedAt: T0, finishedAt: T0 + 18_000, result: "PASS" }),
    ];

    const lines = renderAgentsView(list, 0, T0 + 31_000, { width: 100 });
    const text = lines.join("\n");

    assert.match(text, /AIES Agents/u);
    assert.match(text, /Worker #1/u);
    assert.match(text, /Verify #1/u);
    assert.match(text, /Qwen 3\.8 Flash/u);
    assert.match(text, /openrouter/u);
    assert.match(text, /34k/u);
    assert.match(text, /\$0\.03/u);
    assert.match(text, /calculator\.js/u);
    assert.match(text, /actividad reciente/u);
    assert.match(text, /Editando calculator\.js/u);
    assert.match(text, /esc\/q cerrar/u);
    // The frame is bounded by the shared modal width and stays centered.
    assert.ok(lines[0].startsWith(" "), lines[0]);
    assert.ok(lines[0].includes("╭"), lines[0]);
    assert.ok(modalWidthOf(lines) <= AGENTS_MODAL_WIDTH, `frame too wide: ${modalWidthOf(lines)}`);
    for (const line of lines) assert.ok(line.length <= 100, line);
  });

  it("renders the empty state inside the modal without inventing facts", () => {
    const lines = renderAgentsView([], 0, T0, { width: 100 });
    const text = lines.join("\n");
    assert.match(text, /AIES Agents/u);
    assert.match(text, /sin agentes en esta sesión/u);
    assert.match(text, /esc\/q cerrar/u);
    for (const line of lines) assert.ok(line.length <= 100, line);
  });

  it("shows real telemetry and an em dash for every unavailable field", () => {
    const rich = renderAgentsView(
      [
        record({
          id: "worker-1",
          role: "worker",
          status: "completed",
          startedAt: T0,
          finishedAt: T0 + 31_000,
          modelLabel: "Qwen 3.8 Flash",
          providerLabel: "openrouter",
          totalTokens: 34_000,
          cost: 0.03,
          toolCount: 4,
          changedPaths: ["src/calculator.js"],
          result: "1 archivo modificado",
        }),
      ],
      0,
      T0 + 31_000,
      { width: 100 },
    ).join("\n");

    assert.match(rich, /modelo\s+Qwen 3\.8 Flash/u);
    assert.match(rich, /proveedor\s+openrouter/u);
    assert.match(rich, /tiempo\s+00:31/u);
    assert.match(rich, /tokens\s+34k/u);
    assert.match(rich, /coste\s+\$0\.03/u);
    assert.match(rich, /contexto\s+—/u);
    assert.match(rich, /herramientas\s+4/u);
    assert.match(rich, /archivos\s+src\/calculator\.js/u);
    assert.match(rich, /resultado final\s+1 archivo modificado/u);

    const bare = renderAgentsView([record({ id: "worker-1", role: "worker", status: "running" })], 0, T0, {
      width: 100,
    }).join("\n");
    for (const label of ["modelo", "proveedor", "tokens", "coste", "contexto", "herramientas", "archivos", "resultado"]) {
      const row = bare.split("\n").find((line) => line.includes(label));
      assert.ok(row, `missing ${label} row:\n${bare}`);
      assert.match(row, /—/u, `${label} must be — when unavailable: ${row}`);
    }
  });

  it("keeps the completed agent's retained activity and result", () => {
    const lines = renderAgentsView(
      [
        record({
          id: "worker-1",
          role: "worker",
          status: "completed",
          startedAt: T0,
          finishedAt: T0 + 2_000,
          activities: [{ tool: "edit", text: "Editando src/app.ts", at: T0 + 1 }],
          result: "hecho",
        }),
      ],
      0,
      T0 + 3_000,
      { width: 100 },
    ).join("\n");

    assert.match(lines, /Editando src\/app\.ts/u);
    assert.match(lines, /resultado final\s+hecho/u);
  });

  it("always shows a contexto row as em dash because a child has no context sample", () => {
    const text = renderAgentsView(
      [
        record({
          id: "worker-1",
          role: "worker",
          status: "running",
          modelLabel: "Qwen 3.8 Flash",
          providerLabel: "openrouter",
          totalTokens: 34_000,
          cost: 0.03,
          toolCount: 4,
        }),
      ],
      0,
      T0 + 1_000,
      { width: 100 },
    ).join("\n");
    const row = text.split("\n").find((line) => line.includes("contexto"));
    assert.ok(row, text);
    assert.match(row, /contexto\s+—/u, row);
  });

  it("labels each agent state chip with the shared Spanish vocabulary", () => {
    const list = [
      record({ id: "worker-1", role: "worker", status: "running" }),
      record({ id: "worker-2", role: "worker", status: "completed", startedAt: T0, finishedAt: T0 + 1_000 }),
      record({ id: "worker-3", role: "worker", status: "blocked" }),
      record({ id: "worker-4", role: "worker", status: "failed" }),
    ];
    const text = renderAgentsView(list, 0, T0 + 5_000, { width: 100 }).join("\n");

    assert.match(text, /Worker #1\s+◇ activo/u);
    assert.match(text, /Worker #2\s+✓ completado/u);
    assert.match(text, /Worker #3\s+! bloqueado/u);
    assert.match(text, /Worker #4\s+✗ falló/u);
  });

  it("paints each stacked list row with the selection or lifecycle tone", () => {
    const paint = capturingPaint();
    const list = [
      record({ id: "worker-1", role: "worker", status: "running" }),
      record({ id: "worker-2", role: "worker", status: "completed", startedAt: T0, finishedAt: T0 + 1_000 }),
      record({ id: "worker-3", role: "worker", status: "blocked" }),
      record({ id: "worker-4", role: "worker", status: "failed" }),
    ];

    renderAgentsView(list, 0, T0 + 5_000, { width: 50, paint });

    assert.equal(toneOf(paint, "Worker #1"), "selection");
    assert.equal(toneOf(paint, "Worker #2"), "success");
    assert.equal(toneOf(paint, "Worker #3"), "warning");
    assert.equal(toneOf(paint, "Worker #4"), "error");
  });

  it("keeps the lifecycle tone mapping in the side-by-side layout", () => {
    const paint = capturingPaint();
    const list = [
      record({ id: "worker-1", role: "worker", status: "running" }),
      record({ id: "worker-2", role: "worker", status: "completed", startedAt: T0, finishedAt: T0 + 1_000 }),
      record({ id: "worker-3", role: "worker", status: "blocked" }),
      record({ id: "worker-4", role: "worker", status: "failed" }),
    ];

    renderAgentsView(list, 2, T0 + 5_000, { width: 100, paint });

    assert.equal(toneOf(paint, "Worker #1"), "running");
    assert.equal(toneOf(paint, "Worker #2"), "success");
    assert.equal(toneOf(paint, "Worker #3"), "selection");
    assert.equal(toneOf(paint, "Worker #4"), "error");
  });

  it("composes list and detail side by side on a wide terminal", () => {
    const list = [
      record({ id: "worker-1", role: "worker", status: "running", modelLabel: "Qwen 3.8 Flash" }),
      record({ id: "verify-1", role: "verify", status: "completed", startedAt: T0, finishedAt: T0 + 1_000, modelLabel: "Claude 4" }),
    ];
    const lines = renderAgentsView(list, 0, T0 + 5_000, { width: 100 });
    const text = lines.join("\n");

    // One row carries both the selected list entry and the detail label.
    assert.ok(
      lines.some((line) => line.includes("Worker #1") && line.includes("modelo")),
      `expected a side-by-side row:\n${text}`,
    );
    assert.ok(AGENTS_SPLIT_MIN_WIDTH <= 100 - 4, "the wide fixture must clear the split threshold");
  });

  it("stacks a bounded list above the detail on a narrow terminal", () => {
    const list = [
      record({ id: "worker-1", role: "worker", status: "running", modelLabel: "Qwen 3.8 Flash" }),
      record({ id: "verify-1", role: "verify", status: "completed", startedAt: T0, finishedAt: T0 + 1_000, modelLabel: "Claude 4" }),
    ];
    const lines = renderAgentsView(list, 1, T0 + 5_000, { width: 50 });
    const text = lines.join("\n");

    assert.ok(lines.some((line) => line.includes("Verify #1")), text);
    assert.ok(lines.some((line) => line.includes("modelo")), text);
    assert.equal(
      lines.some((line) => line.includes("Verify #1") && line.includes("modelo")),
      false,
      `narrow layout must not be side by side:\n${text}`,
    );
    assert.match(text, /Claude 4/u);
  });

  it("bounds the narrow list to a window that still contains the selection", () => {
    const list = Array.from({ length: 14 }, (_, index) =>
      record({ id: `worker-${index + 1}`, role: "worker", status: "running" }),
    );
    const lines = renderAgentsView(list, 13, T0, { width: 50 });
    assert.ok(listRowCount(lines) <= AGENTS_VISIBLE_ROWS, `list not bounded: ${listRowCount(lines)}`);
    assert.match(lines.join("\n"), /Worker #14/u, "the selected record must still be visible");
  });

  it("moves the detail block with the selection", () => {
    const list = [
      record({ id: "worker-1", role: "worker", status: "running", modelLabel: "Qwen 3.8 Flash" }),
      record({ id: "verify-1", role: "verify", status: "completed", startedAt: T0, finishedAt: T0 + 1_000, modelLabel: "Claude 4" }),
    ];

    const first = renderAgentsView(list, 0, T0 + 5_000, { width: 100 }).join("\n");
    const second = renderAgentsView(list, 1, T0 + 5_000, { width: 100 }).join("\n");
    assert.match(first, /Qwen 3\.8 Flash/u);
    assert.equal(first.includes("Claude 4"), false, first);
    assert.match(second, /Claude 4/u);
  });

  it("clips every line and never renders a transcript or reasoning", () => {
    const list = [record({ id: "worker-1", role: "worker", status: "running", currentActivity: "Ejecutando pnpm test" })];
    for (const width of [18, 40, 80, 200]) {
      for (const line of renderAgentsView(list, 0, T0, { width })) {
        assert.ok(line.length <= width, `width ${width}: ${line}`);
      }
    }

    const text = renderAgentsView(list, 0, T0, { width: 120 }).join("\n").toLowerCase();
    for (const forbidden of ["reasoning", "transcript", "chain-of-thought", "prompt del hijo"]) {
      assert.equal(text.includes(forbidden), false, text);
    }
  });

  it("bounds the archivos row to short paths with a remainder count", () => {
    const list = [
      record({
        id: "worker-1",
        role: "worker",
        status: "completed",
        startedAt: T0,
        finishedAt: T0 + 5_000,
        changedPaths: [
          "/Users/someone/Proyectos/Developer/aies-smoke/src/round.js",
          "/Users/someone/Proyectos/Developer/aies-smoke/src/app.ts",
          "/Users/someone/Proyectos/Developer/aies-smoke/src/lib/util.ts",
          "/Users/someone/Proyectos/Developer/aies-smoke/tests/a.test.ts",
          "/Users/someone/Proyectos/Developer/aies-smoke/tests/b.test.ts",
        ],
      }),
    ];

    const text = renderAgentsView(list, 0, T0 + 6_000, { width: 70 }).join("\n");
    const row = text.split("\n").find((line) => line.includes("archivos"));
    assert.ok(row, text);

    assert.equal(row.includes("/Users/"), false, row);
    assert.equal(row.includes("/home/"), false, row);
    assert.match(row, /src\/round\.js/u);
    assert.match(row, /src\/app\.ts/u);
    assert.match(row, /… 2 más/u);
    for (const line of renderAgentsView(list, 0, T0 + 6_000, { width: 60 })) {
      assert.ok(line.length <= 60, line);
    }
  });
});

/** The visible width of the framed box: everything between the first `╭` and `╮`. */
function modalWidthOf(lines) {
  const top = lines.find((line) => line.includes("╭"));
  if (!top) return 0;
  const start = top.indexOf("╭");
  const end = top.lastIndexOf("╮");
  return end > start ? end - start + 1 : 0;
}
