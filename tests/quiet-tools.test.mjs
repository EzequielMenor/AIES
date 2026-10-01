/**
 * AIES-010C T5: quiet rendering for the six generic Pi tools.
 *
 * The pure projections in `extensions/aies-ui/tools.ts` are driven directly,
 * with a fake paint and details objects taken from Pi's public tool types. The
 * Pi boundary in `extensions/aies-runtime/quiet-tools.ts` is exercised through a
 * fake `registerTool`, so this suite proves the projection contract and the
 * execution delegation without a Pi runtime, a model or a terminal.
 *
 * Nothing here writes to the filesystem: the real factory delegation test only
 * reads an existing repository file.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createQuietProjection, QUIET_TOOL_NAMES } from "../extensions/aies-ui/tools.ts";
import { registerQuietTools } from "../extensions/aies-runtime/quiet-tools.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** Identity paint: every renderer stays plain text, so ANSI leakage is provable. */
const plainPaint = { fg: (_color, text) => text };

/** Records the semantic colors a row asked for, so "not an error" is provable. */
function recordingPaint() {
  const colors = [];
  return {
    colors,
    fg(color, text) {
      colors.push(color);
      return text;
    },
  };
}

const collapsed = { expanded: false, isPartial: false, isError: false };
const pending = { expanded: false, isPartial: true, isError: false };
const expanded = { expanded: true, isPartial: false, isError: false };
const failed = { expanded: false, isPartial: false, isError: true };

/** A realistic result per tool, shaped by Pi's public `*ToolDetails` types. */
function resultFor(name, overrides = {}) {
  const base = SUCCESS[name];
  return { ...base, ...overrides };
}

/** An edit diff with exactly `+12 / -3` real statistics. */
function editDiff() {
  const adds = Array.from({ length: 12 }, (_v, i) => `+line ${i + 1}`);
  const dels = Array.from({ length: 3 }, (_v, i) => `-old ${i + 1}`);
  return [
    "--- a/src/calculator.js",
    "+++ b/src/calculator.js",
    "@@ -1,3 +1,12 @@",
    ...dels,
    ...adds,
  ].join("\n");
}

const GREP_MATCHES = Array.from({ length: 8 }, (_v, i) => `src/a.js:${i + 1}:const value = ${i};`).join("\n");
const FIND_FILES = Array.from({ length: 12 }, (_v, i) => `src/file-${i + 1}.js`).join("\n");

/** The same result objects the projections must never rewrite. */
const SUCCESS = {
  read: {
    content: [{ type: "text", text: "     1→const first = 1;\n     2→const second = 2;" }],
    details: {},
  },
  bash: {
    content: [{ type: "text", text: "3 passing\n" }],
    details: {},
  },
  grep: {
    content: [{ type: "text", text: GREP_MATCHES }],
    details: {},
  },
  find: {
    content: [{ type: "text", text: FIND_FILES }],
    details: {},
  },
  edit: {
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/calculator.js." }],
    details: { diff: editDiff(), patch: "diff --git a/src/calculator.js b/src/calculator.js" },
  },
  write: {
    content: [{ type: "text", text: "Successfully wrote to src/new.js" }],
    details: undefined,
  },
};

/** The call arguments each tool names in its collapsed row. */
const ARGS = {
  read: { path: "src/calculator.js" },
  bash: { command: "npm test" },
  grep: { pattern: "pattern" },
  find: { pattern: "*.js", path: "src" },
  edit: { path: "src/calculator.js", edits: [] },
  write: { path: "src/new.js", content: "x" },
};

/** The collapsed success row for each tool, exactly as the requirement names it. */
const COLLAPSED = {
  read: ["› read  src/calculator.js ✓"],
  bash: ["› bash  npm test ✓", "3 passing"],
  grep: ["› grep  pattern · 8 coincidencias"],
  find: ["› find  src · 12 archivos"],
  edit: ["› edit  src/calculator.js ✓ +12 / -3"],
  write: ["› write src/new.js ✓"],
};

/** The pending row while the call is in flight. */
const PENDING = {
  read: ["› read  src/calculator.js …"],
  bash: ["› bash  npm test …"],
  grep: ["› grep  pattern …"],
  find: ["› find  src …"],
  edit: ["› edit  src/calculator.js …"],
  write: ["› write src/new.js …"],
};

const ERROR_CONTENT = {
  read: "ENOENT: no such file or directory, open 'src/missing.js'\n    at Object.openSync (node:fs:560:3)",
  bash: "AssertionError: expected 1 to equal 2\n    at Context.<anonymous> (test/a.js:10:5)\n    at processImmediate (node:internal/timers:480:21)",
  grep: "ripgrep failed: permission denied\n    at run (grep.js:1:1)",
  find: "fd failed: permission denied\n    at walk (find.js:2:2)",
  edit: "Could not edit file: src/calculator.js. oldText not found.",
  write: "EACCES: permission denied, open 'src/new.js'",
};

describe("quiet collapsed success rows", () => {
  for (const name of QUIET_TOOL_NAMES) {
    it(`${name}: compact, single-line, from real details only`, () => {
      const lines = createQuietProjection(name, ARGS[name]).result(resultFor(name), collapsed, plainPaint);
      assert.deepEqual(lines, COLLAPSED[name], `${name} collapsed row`);
      assert.equal(lines.join("\n").includes("\u001b"), false, `${name} emitted ANSI`);
    });
  }

  it("omits the bash duration the public details never carry", () => {
    const lines = createQuietProjection("bash", { command: "npm test" }).result(SUCCESS.bash, collapsed, plainPaint);
    assert.match(lines[0], /✓$/u);
    assert.equal(/\d+(\.\d+)?s\b/u.test(lines[0]), false, `a measured duration leaked: ${lines[0]}`);
  });

  it("keeps a routine long bash output collapsed to its row", () => {
    const long = { content: [{ type: "text", text: "line one\nline two\nline three" }], details: {} };
    const lines = createQuietProjection("bash", { command: "npm test" }).result(long, collapsed, plainPaint);
    assert.deepEqual(lines, ["› bash  npm test ✓"]);
  });

  it("keeps a routine long read collapsed to its row", () => {
    const long = { content: [{ type: "text", text: Array.from({ length: 40 }, (_v, i) => `line ${i}`).join("\n") }], details: {} };
    const lines = createQuietProjection("read", { path: "src/big.js" }).result(long, collapsed, plainPaint);
    assert.deepEqual(lines, ["› read  src/big.js ✓"]);
  });
});

describe("quiet pending rows", () => {
  for (const name of QUIET_TOOL_NAMES) {
    it(`${name}: isPartial renders a pending row, never a fake result`, () => {
      const lines = createQuietProjection(name, ARGS[name]).result(resultFor(name), pending, plainPaint);
      assert.deepEqual(lines, PENDING[name], `${name} pending row`);
      assert.equal(lines.join("").includes("✓"), false, `${name} faked a result`);
      assert.equal(lines.join("").includes("✗"), false, `${name} faked a failure`);
    });
  }

  it("call slot: pending row while the call is in flight, raw args only", () => {
    const lines = createQuietProjection("bash", ARGS.bash).call(pending, plainPaint);
    assert.deepEqual(lines, ["› bash  npm test …"]);
  });
});

describe("quiet error visibility while collapsed", () => {
  for (const name of QUIET_TOOL_NAMES) {
    it(`${name}: shows ✗, the target and the real first lines`, () => {
      const result = { content: [{ type: "text", text: ERROR_CONTENT[name] }], details: SUCCESS[name].details };
      const lines = createQuietProjection(name, ARGS[name]).result(result, failed, plainPaint);
      assert.equal(lines[0], `✗ ${name.padEnd(5)} ${targetOf(name)}`, `${name} error header`);
      assert.equal(lines[1], ERROR_CONTENT[name].split("\n")[0], `${name} first error line`);
    });
  }

  it("bounds the error body to three lines and never swallows the truncation hint", () => {
    const content = Array.from({ length: 8 }, (_v, i) => `error line ${i + 1}`).join("\n");
    const result = {
      content: [{ type: "text", text: content }],
      details: { truncation: { truncated: true, outputLines: 40, totalLines: 900 } },
    };
    const lines = createQuietProjection("read", { path: "src/missing.js" }).result(result, failed, plainPaint);
    assert.equal(lines[0], "✗ read  src/missing.js");
    assert.deepEqual(lines.slice(1, 4), ["error line 1", "error line 2", "error line 3"]);
    assert.equal(lines.length, 5, "the truncation hint must stay attached");
    assert.equal(lines[4], "[truncated]");
  });

  it("paints the error row with the error color, never success", () => {
    const paint = recordingPaint();
    const result = { content: [{ type: "text", text: "AssertionError: boom" }], details: {} };
    createQuietProjection("bash", ARGS.bash).result(result, failed, paint);
    assert.ok(paint.colors.includes("error"), `no error color: ${paint.colors.join(",")}`);
    assert.equal(paint.colors.includes("success"), false, "an error row asked for success");
  });

  it("every tool keeps its real failure visible from result.isError alone", () => {
    for (const name of QUIET_TOOL_NAMES) {
      const result = { content: [{ type: "text", text: ERROR_CONTENT[name] }], details: {}, isError: true };
      const lines = createQuietProjection(name, ARGS[name]).result(result, collapsed, plainPaint);
      assert.match(lines[0], /^✗ /u, `${name} hid a real failure`);
    }
  });
});

describe("quiet expanded rows show the raw truth", () => {
  for (const name of QUIET_TOOL_NAMES) {
    it(`${name}: expanded text equals result.content byte for byte`, () => {
      const result = resultFor(name);
      const raw = result.content[0].text;
      const lines = createQuietProjection(name, ARGS[name]).result(result, expanded, plainPaint);
      const rawCount = raw.split("\n").length;
      assert.equal(lines.slice(0, rawCount).join("\n"), raw, `${name} rewrote the model content`);
    });
  }

  it("edit: exposes the real diff as a detail fact after the raw text", () => {
    const raw = SUCCESS.edit.content[0].text;
    const lines = createQuietProjection("edit", ARGS.edit).result(SUCCESS.edit, expanded, plainPaint);
    assert.equal(lines.slice(0, raw.split("\n").length).join("\n"), raw);
    assert.ok(lines.join("\n").includes("-old 1"), "the diff must be reachable when expanded");
  });

  it("grep: exposes truncation totals as a detail fact", () => {
    const result = {
      content: [{ type: "text", text: GREP_MATCHES }],
      details: { truncation: { truncated: true, outputLines: 8, totalLines: 120 } },
    };
    const lines = createQuietProjection("grep", ARGS.grep).result(result, expanded, plainPaint);
    assert.ok(lines.join("\n").includes("120"), "the truncation total must be reachable when expanded");
  });
});

describe("quiet projections never mutate the result", () => {
  for (const name of QUIET_TOOL_NAMES) {
    it(`${name}: collapsed, pending, error and expanded leave the result untouched`, () => {
      const result = resultFor(name);
      const snapshot = JSON.stringify(result);
      const projection = createQuietProjection(name, ARGS[name]);
      projection.result(result, collapsed, plainPaint);
      projection.result(result, pending, plainPaint);
      projection.call(pending, plainPaint);
      projection.result(result, expanded, plainPaint);
      projection.result({ content: [{ type: "text", text: ERROR_CONTENT[name] }], details: result.details }, failed, plainPaint);
      assert.equal(JSON.stringify(result), snapshot, `${name} mutated the result`);
    });
  }
});

describe("truncation hints survive every collapsed success", () => {
  for (const name of ["read", "grep", "find"]) {
    it(`${name}: keeps [truncated] from real details`, () => {
      const result = resultFor(name, { details: { truncation: { truncated: true, outputLines: 10, totalLines: 900 } } });
      const lines = createQuietProjection(name, ARGS[name]).result(result, collapsed, plainPaint);
      assert.ok(lines.join("\n").includes("[truncated]"), `${name} swallowed the truncation hint`);
    });
  }
});

describe("quiet tool registration", () => {
  function fakeHost() {
    const tools = [];
    return {
      tools,
      pi: {
        registerTool(tool) {
          tools.push(tool);
        },
      },
    };
  }

  function stubFactories() {
    const calls = [];
    const sentinel = { content: [{ type: "text", text: "sentinel" }], details: { marker: "x" } };
    const factories = {};
    for (const name of QUIET_TOOL_NAMES) {
      factories[name] = (cwd) => ({
        description: `${name} from ${cwd}`,
        parameters: { name },
        execute: async (...args) => {
          calls.push({ name, args });
          return sentinel;
        },
      });
    }
    return { factories, calls, sentinel };
  }

  it("registers exactly the six documented names", () => {
    const { pi, tools } = fakeHost();
    registerQuietTools(pi, "/repo", stubFactories().factories);
    assert.deepEqual(tools.map((tool) => tool.name), [...QUIET_TOOL_NAMES]);
  });

  it("delegates execute to the original factory instance and returns its result object", async () => {
    const { pi, tools } = fakeHost();
    const { factories, calls, sentinel } = stubFactories();
    registerQuietTools(pi, "/repo", factories);

    const bash = tools.find((tool) => tool.name === "bash");
    const params = { command: "echo hi" };
    const returned = await bash.execute("call-1", params, undefined, undefined, { cwd: "/repo", mode: "print" });

    assert.equal(returned, sentinel, "the result object must be returned untouched");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "bash");
    assert.equal(calls[0].args[0], "call-1");
    assert.deepEqual(calls[0].args[1], params);
  });

  it("is idempotent: a reload/resume with the same cwd leaks no instance", () => {
    const { pi, tools } = fakeHost();
    const { factories, calls } = stubFactories();
    registerQuietTools(pi, "/repo", factories);
    registerQuietTools(pi, "/repo", factories);
    registerQuietTools(pi, "/repo", factories);

    assert.equal(tools.length, QUIET_TOOL_NAMES.length, "duplicate registrations leaked");
    assert.equal(calls.length, 0, "no tool was executed");
    assert.deepEqual(tools.map((tool) => tool.name), [...QUIET_TOOL_NAMES]);
  });

  it("re-registers when the working directory changes", () => {
    const { pi, tools } = fakeHost();
    const { factories } = stubFactories();
    registerQuietTools(pi, "/repo", factories);
    registerQuietTools(pi, "/other", factories);
    assert.equal(tools.length, QUIET_TOOL_NAMES.length * 2);
    assert.equal(tools[0].description, "read from /repo");
    assert.equal(tools[QUIET_TOOL_NAMES.length].description, "read from /other");
  });

  it("delegates to the real built-in factory instance", async () => {
    const { pi, tools } = fakeHost();
    registerQuietTools(pi, REPO);
    const read = tools.find((tool) => tool.name === "read");
    const result = await read.execute("call-1", { path: "package.json" }, undefined, undefined, { cwd: REPO, mode: "print" });
    assert.match(result.content[0].text, /"name": "aies"/u);
  });

  it("owns the compact shell so successful tools have no native color block", () => {
    const { pi, tools } = fakeHost();
    registerQuietTools(pi, "/repo", stubFactories().factories);
    for (const tool of tools) {
      assert.equal(tool.renderShell, "self", `${tool.name} must render only its compact projection`);
      assert.equal(typeof tool.renderCall, "function");
      assert.equal(typeof tool.renderResult, "function");
    }
  });

  it("render call/result delegate to the pure projections and never send a message", () => {
    const { pi, tools } = fakeHost();
    const sent = [];
    pi.sendMessage = (...args) => sent.push(args);
    registerQuietTools(pi, "/repo", stubFactories().factories);

    const bash = tools.find((tool) => tool.name === "bash");
    const theme = { fg: (_color, text) => text, bold: (text) => text };
    const context = { args: { command: "npm test" }, executionStarted: false, isPartial: true, expanded: false, isError: false };

    const lines = bash.renderCall({ command: "npm test" }, theme, context).render(120);
    assert.deepEqual(lines, ["› bash  npm test …"]);

    const results = bash
      .renderResult({ content: [{ type: "text", text: "3 passing\n" }], details: {} }, { expanded: false, isPartial: false }, theme, context)
      .render(120);
    assert.deepEqual(results, ["› bash  npm test ✓", "3 passing"]);
    assert.deepEqual(sent, [], "a renderer must never reach the conversation");
  });

  it("hides the call slot once execution started so the result owns the row", () => {
    const { pi, tools } = fakeHost();
    registerQuietTools(pi, "/repo", stubFactories().factories);
    const bash = tools.find((tool) => tool.name === "bash");
    const theme = { fg: (_color, text) => text, bold: (text) => text };
    const context = { args: { command: "npm test" }, executionStarted: true, isPartial: true, expanded: false, isError: false };
    assert.deepEqual(bash.renderCall({ command: "npm test" }, theme, context).render(120), []);
  });
});

function targetOf(name) {
  switch (name) {
    case "read":
    case "edit":
    case "write":
      return ARGS[name].path;
    case "bash":
      return ARGS[name].command;
    case "grep":
      return ARGS[name].pattern;
    case "find":
      return ARGS[name].path;
    default:
      return "";
  }
}
