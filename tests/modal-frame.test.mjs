/**
 * Shared AIES modal frame (AIES UI final observational polish / T1).
 *
 * Regression-first coverage for the pure, Pi-free frame primitive every AIES
 * overlay surface reuses:
 * 1. It draws a bounded border with an integrated title, padded content and a
 *    help row.
 * 2. Colors come only from the injected `Paint`; no raw ANSI ever leaks.
 * 3. Width is content-adapted and clamped, so it stays valid on narrow
 *    terminals and no rendered line exceeds its width.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MODAL_FRAME_CHROME,
  MODAL_MAX_WIDTH,
  MODAL_MIN_WIDTH,
  modalContentWidth,
  modalWidth,
  renderModalFrame,
} from "../extensions/aies-ui/modal.ts";

const content = {
  title: "Modelo AIES · elegí el rol",
  lines: [
    { text: "› Parent", color: "accent" },
    { text: "  Explore" },
    { text: "  Worker" },
    { text: "  Verify" },
  ],
  help: "↑↓ j/k elegir · Enter elegir · Esc atrás · q salir · Ctrl+S guardar",
};

describe("modal frame shape", () => {
  it("draws a bounded frame with an integrated title and a help row", () => {
    const lines = renderModalFrame({ ...content, width: 72 });

    assert.equal(lines[0].startsWith("╭"), true, `top border: ${lines[0]}`);
    assert.equal(lines[0].endsWith("╮"), true, `top border: ${lines[0]}`);
    assert.ok(lines[0].includes("Modelo AIES"), "the title is integrated into the border");
    assert.equal(lines.at(-1).startsWith("╰"), true, `bottom border: ${lines.at(-1)}`);
    assert.equal(lines.at(-1).endsWith("╯"), true, `bottom border: ${lines.at(-1)}`);
    assert.ok(lines.some((line) => line.includes("› Parent")), "content rows are framed");
    assert.ok(lines.some((line) => line.includes("Esc atrás")), "the help row is framed");

    for (const line of lines) assert.ok(line.length <= 72, `overflow: ${line}`);
  });

  it("is generic enough for a future /agents surface", () => {
    const lines = renderModalFrame({
      title: "Agentes · sesión",
      lines: [{ text: "  explore  activo", color: "success" }],
      help: "↑↓ elegir · Esc cerrar",
      width: 64,
    });

    assert.ok(lines[0].includes("Agentes · sesión"));
    assert.ok(lines.some((line) => line.includes("explore  activo")));
  });
});

describe("injected paint", () => {
  it("paints through the injected Paint and never emits raw ANSI", () => {
    const seen = [];
    const paint = {
      fg(color, text) {
        seen.push(color);
        return `{${color}}${text}{/${color}}`;
      },
    };

    const joined = renderModalFrame({ ...content, width: 60, paint }).join("\n");

    assert.equal(joined.includes("\u001b"), false, "no raw escape sequences");
    assert.ok(joined.includes("{accent}"), "borders keep the accent tone");
    assert.ok(seen.includes("accent"));
    assert.ok(seen.includes("dim"), "the help row is dimmed");
  });
});

describe("bounded, content-adapted width", () => {
  it("measures the widest visible content line", () => {
    assert.equal(modalContentWidth({ title: "ab", lines: [{ text: "abcd" }], help: "abc" }), 4);
    assert.equal(modalContentWidth({ title: "longer title", lines: [] }), 12);
  });

  it("clamps to the content, the preferred floor and the available width", () => {
    const tiny = { title: "AIES", lines: [{ text: "x" }], help: "" };
    // Wanted is smaller than the minimum, so the frame keeps its readable floor.
    assert.equal(modalWidth(tiny, 80), MODAL_MIN_WIDTH);
    // A huge content line is capped by the maximum frame width.
    const huge = { title: "T", lines: [{ text: "y".repeat(400) }] };
    assert.equal(modalWidth(huge, 400), MODAL_MAX_WIDTH);
    // The available width always wins when it is the smallest.
    assert.equal(modalWidth(content, 30), 30);
    // The explicit preferred width is respected when it fits.
    assert.equal(modalWidth(tiny, 80, 40), 40);
  });

  it("honors a preferred width and centers within wider space", () => {
    const narrow = { title: "AIES", lines: [{ text: "› Parent" }], help: "q salir" };
    const lines = renderModalFrame({ ...narrow, width: 80, preferredWidth: 40 });

    for (const line of lines) {
      assert.ok(line.length <= 80, `overflow: ${line}`);
      assert.equal(line.slice(0, 20), " ".repeat(20), "centered offset");
      assert.ok(line.slice(20).length <= 40, `frame wider than preferred: ${line}`);
    }
  });

  it("keeps every rendered line inside the available width", () => {
    for (let width = 1; width <= 100; width += 1) {
      const lines = renderModalFrame({ ...content, width, preferredWidth: 50 });
      for (const line of lines) {
        assert.ok(line.length <= width, `width=${width} overflow=${JSON.stringify(line)}`);
      }
    }
  });

  it("degrades to clipped plain rows when a border cannot fit", () => {
    const lines = renderModalFrame({ ...content, width: 3 });

    for (const line of lines) assert.ok(line.length <= 3, `overflow: ${line}`);
    assert.equal(lines.join("").includes("╭"), false, "no border on a terminal this narrow");
    assert.ok(lines.some((line) => line.includes("Parent") || line.includes("…")));
  });

  it("reserves the frame chrome on a just-wide-enough terminal", () => {
    const width = MODAL_MIN_WIDTH;
    const lines = renderModalFrame({ ...content, width });
    const body = lines.find((line) => line.includes("Parent"));

    assert.ok(body, "content row present");
    assert.equal(body.length, width, "the frame fills the available width");
    assert.ok(body.startsWith("│ "), `chrome on the left: ${body}`);
    assert.ok(body.endsWith(" │"), `chrome on the right: ${body}`);
    assert.equal(modalWidth(content, width), width, "the wanted frame is clamped to the terminal");
  });
});
