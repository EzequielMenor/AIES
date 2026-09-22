/**
 * AIES-010D / T2 profile-level fullscreen contract and T7 right-rail shim.
 *
 * The profile settings are Pi's documented public terminal primitives. AIES owns
 * only its isolated profile values; alternate-screen entry, resize and teardown
 * stay inside Pi.
 *
 * The right-rail shim is the single, version-guarded compatibility module for the
 * optional physical rail. These tests pin its guard, its fail-safe behavior and
 * the corrected projection it renders (project, branch and the active-run timer).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseDetachedHead,
  readDetachedShortSha,
  resolveGitDirPointer,
} from "../extensions/aies-runtime/index.ts";

import {
  applyAgents,
  applyContextUsage,
  applyDelegationEnd,
  applyDelegationStart,
  applyModel,
  applyRunStart,
  applyRunUsage,
  applyTicketObservationSync,
  applyVerificationReport,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import {
  LAYOUT_NODE,
  RIGHT_RAIL_MIN_WIDTH,
  branchLabel,
  installRightRail,
  isRecognizedStackLayoutNode,
  piVersionMayAttemptRail,
  projectBranch,
  projectLabel,
  renderRightRail,
} from "../extensions/aies-ui/right-rail.ts";
import { deriveTodos, renderTodos } from "../extensions/aies-ui/todos.ts";
import { formatTokens } from "../extensions/aies-ui/format.ts";

const SETTINGS = fileURLToPath(new URL("../profile/settings.json", import.meta.url));
const profile = JSON.parse(readFileSync(SETTINGS, "utf8"));

const THEME = fileURLToPath(new URL("../themes/aies.json", import.meta.url));
const theme = JSON.parse(readFileSync(THEME, "utf8"));

const T0 = 1_700_000_000_000;

function record(overrides = {}) {
  return {
    id: "worker-1",
    role: "worker",
    status: "running",
    startedAt: T0,
    finishedAt: null,
    modelId: "qwen3.8-flash",
    modelLabel: "Qwen 3.8 Flash",
    providerId: "openrouter",
    providerLabel: "openrouter",
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

function richState() {
  let state = createState(T0);
  state = applyTicketObservationSync(state, { active: true, identifier: "EZE-417", status: "In Progress" });
  state = applyContextUsage(state, { tokens: 42_000, contextWindow: 200_000 });
  state = applyModel(state, { id: "qwen3.8-flash", provider: "openrouter", name: "Qwen 3.8 Flash" });
  state = applyDelegationStart(state, "worker", T0);
  state = applyAgents(state, [record({ id: "worker-1", role: "worker" })]);
  state = applyRunStart(state, T0);
  return state;
}

function snapOf(state) {
  return { ...toSnapshot(state), agents: state.agents };
}

/** A ticket run with measured tokens and cost, mirroring the panel fixture. */
function usageState() {
  let state = richState();
  state = applyRunUsage(state, { totalTokens: 1_000, cost: 0.01 }, [], T0);
  state = applyRunUsage(
    state,
    { totalTokens: 13_000, cost: 0.05 },
    [record({ totalTokens: 4_000, cost: 0.02 })],
    T0 + 31_000,
  );
  return state;
}

/** A stable host layout node so delegation can be compared by reference. */
const HOST_NODE = { type: "vstack", entries: [{ component: { render: () => ["transcript"], invalidate() {} } }] };

/** A fake host exposing the private fullscreen layout node the way Pi does. */
function fakeHost(overrides = {}) {
  const original = () => HOST_NODE;
  const root = { [LAYOUT_NODE]: original };
  const host = {
    mode: "fullscreen",
    terminal: { columns: 160 },
    layoutRoot: root,
    renderCount: 0,
    requestRender() {
      this.renderCount += 1;
    },
    ...overrides,
  };
  return { host, root, original };
}

describe("fullscreen shell profile", () => {
  it("uses Pi's native fullscreen lifecycle and restores the previous screen", () => {
    assert.equal(profile.tuiMode, "fullscreen");
    assert.equal(profile.fullscreenExitOutput, "resume-hint");
    assert.equal(profile.fullscreenScrollbar, "auto");
  });

  it("keeps launch and thinking presentation quiet through public settings", () => {
    assert.equal(profile.quietStartup, true);
    assert.equal(profile.hideThinkingBlock, true);
  });

  it("loads the profile-local aies theme through Pi's supported mechanism", () => {
    assert.equal(profile.theme, "aies");
  });
});

/** Every color token Pi documents as required, plus the optional ones AIES sets. */
const REQUIRED_THEME_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  "selectedBg",
  "searchMatchBg",
  "searchMatchText",
  "userMessageBg",
  "userMessageText",
  "customMessageBg",
  "customMessageText",
  "customMessageLabel",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
];

describe("AIES theme", () => {
  it("defines the complete supported color schema", () => {
    assert.equal(theme.name, "aies");
    for (const token of REQUIRED_THEME_TOKENS) {
      assert.ok(Object.hasOwn(theme.colors, token), `missing theme color: ${token}`);
    }
    assert.ok(theme.vars && typeof theme.vars === "object", "vars must be present");
  });

  it("uses only supported color values and no hardcoded ANSI", () => {
    const raw = readFileSync(THEME, "utf8");
    assert.equal(raw.includes("\u001b"), false, "theme must not embed ANSI escapes");

    for (const [token, value] of Object.entries(theme.colors)) {
      const valid =
        value === "" ||
        (typeof value === "number" && value >= 0 && value <= 255) ||
        (typeof value === "string" && /^#[0-9a-fA-F]{6}$/u.test(value)) ||
        (typeof value === "string" && Object.hasOwn(theme.vars, value));
      assert.ok(valid, `unsupported color value for ${token}: ${JSON.stringify(value)}`);
    }
  });
});

describe("right rail guard", () => {
  it("admits the hand-audited minors through the floor and gates on the shape probe", () => {
    for (const version of ["0.85.1", "0.86.1", "0.87.0"]) {
      assert.equal(piVersionMayAttemptRail(version), true, `${version} is an audited minor`);
    }
    assert.equal(piVersionMayAttemptRail("0.88.0"), true, "a newer minor is attempted on the strength of the probe");
    assert.equal(piVersionMayAttemptRail("0.84.9"), false);
    assert.equal(piVersionMayAttemptRail(undefined), false);
    assert.equal(piVersionMayAttemptRail("nonsense"), false);
    assert.equal(isRecognizedStackLayoutNode(HOST_NODE), true, "shape recognition, not the version, admits the rail");
  });

  it("attempts the rail on any parseable minor at or above the audited 0.85 floor", () => {
    assert.equal(piVersionMayAttemptRail("0.84.9"), false);
    assert.equal(piVersionMayAttemptRail("0.84.0"), false);
    assert.equal(piVersionMayAttemptRail("0.85.0"), true);
    assert.equal(piVersionMayAttemptRail("0.86.1"), true);
    assert.equal(piVersionMayAttemptRail("0.87.0"), true);
    assert.equal(piVersionMayAttemptRail("0.88.0"), true);
    assert.equal(piVersionMayAttemptRail("1.0.0"), true);
    assert.equal(piVersionMayAttemptRail(undefined), false);
    assert.equal(piVersionMayAttemptRail("nonsense"), false);
  });

  it("recognizes only the audited StackLayoutNode vocabulary", () => {
    assert.equal(isRecognizedStackLayoutNode(HOST_NODE), true);
    assert.equal(isRecognizedStackLayoutNode({ type: "hstack", entries: [{ component: { render: () => [] } }] }), true);
    assert.equal(isRecognizedStackLayoutNode({ type: "vstack", entries: [] }), true, "an empty stack is still a valid stack");
    assert.equal(
      isRecognizedStackLayoutNode({ type: "vstack", entries: [{ component: { [LAYOUT_NODE]: () => ({}) } }] }),
      true,
    );
    assert.equal(isRecognizedStackLayoutNode({ type: "flex", entries: [{ component: { render: () => [] } }] }), false);
    assert.equal(isRecognizedStackLayoutNode({ type: "vstack", entries: [{ component: {} }] }), false);
    assert.equal(isRecognizedStackLayoutNode({ type: "vstack", entries: [{}] }), false);
    assert.equal(isRecognizedStackLayoutNode({ type: "vstack", entries: [null] }), false);
    assert.equal(isRecognizedStackLayoutNode({ type: "vstack", entries: "nope" }), false);
    assert.equal(isRecognizedStackLayoutNode({ type: 7, entries: [{ component: { render: () => [] } }] }), false);
    assert.equal(isRecognizedStackLayoutNode(null), false);
    assert.equal(isRecognizedStackLayoutNode(undefined), false);
    assert.equal(isRecognizedStackLayoutNode("vstack"), false);
  });

  it("uses the 120-column product breakpoint for the physical rail", () => {
    assert.equal(RIGHT_RAIL_MIN_WIDTH, 120, "the rail tier matches the >=120 product contract");
  });

  it("normalizes the project and branch labels without inventing them", () => {
    assert.equal(projectLabel("/Users/dev/Proyectos/Developer/AIES"), "AIES");
    assert.equal(projectLabel("/repo/"), "repo");
    assert.equal(projectLabel(""), undefined);
    assert.equal(projectLabel(undefined), undefined);
    assert.equal(branchLabel("feat/aies-010d-fullscreen-shell"), "feat/aies-010d-fullscreen-shell");
    assert.equal(branchLabel("  "), undefined);
    assert.equal(branchLabel("detached"), "detached");
    assert.equal(branchLabel(null), undefined);
  });
});

describe("right rail product composition", () => {
  it("renders vertical Status rows with ticket, stage, provider, run time and split usage", () => {
    const text = renderRightRail(snapOf(usageState()), T0 + 31_000, {
      width: 46,
      project: "/Users/dev/Proyectos/Developer/AIES",
      branch: "feat/aies-010d-fullscreen-shell",
    }).join("\n");

    assert.match(text, /Proyecto\s+AIES/u);
    assert.match(text, /Ticket\s+EZE-417/u);
    assert.match(text, /Etapa\s+◆ WORK/u);
    assert.match(text, /Modelo\s+Qwen 3\.8 Flash/u);
    assert.match(text, /Proveedor\s+openrouter/u);
    assert.match(text, /Contexto\s+42k/u);
    assert.match(text, /Tiempo\s+00:31/u);
    // Tokens and cost never collapse into a single truncated line.
    assert.match(text, /Tokens/u);
    assert.match(text, /Main\s+12k/u);
    assert.match(text, /Agents\s+4k/u);
    assert.match(text, /Total\s+16k/u);
    assert.match(text, /Coste/u);
    assert.match(text, /Main\s+\$0\.04/u);
    assert.match(text, /Total\s+\$0\.06/u);
    assert.ok(
      text.split("\n").every((line) => line.length <= 46),
      text,
    );
  });

  it("shows a dash for the run time at IDLE instead of a session clock", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });
    state = applyModel(state, { id: "qwen3.8-flash", provider: "openrouter", name: "Qwen 3.8 Flash" });
    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");

    assert.match(text, /Tiempo\s+—/u, text);
    assert.equal(text.includes("00:00"), false, text);
  });

  it("composes a run-local Todos section for the normal flow", () => {
    let state = applyTicketObservationSync(createState(T0), { active: true, identifier: "EZE-417", status: "In Progress" });
    state = applyDelegationStart(state, "worker", T0);
    state = applyDelegationEnd(state, "done", T0 + 1_000);
    state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });

    const text = renderRightRail(snapOf(state), T0 + 2_000, { width: 60, project: "/repo" }).join("\n");
    assert.match(text, /Todos/u, text);
    assert.match(text, /Cargar ticket/u, text);
    assert.match(text, /Implementar/u, text);
    assert.match(text, /Verificar/u, text);
    assert.match(text, /Sincronizar Linear/u, text);
    assert.match(text, /Finalizar/u, text);
    assert.equal(text.includes("Explorar"), false, text);
  });

  it("freezes the run time at the DONE moment instead of growing forever", () => {
    const state = applyRunStart(
      applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 }),
      T0,
    );
    const text = renderRightRail(snapOf(state), T0 + 120_000, { width: 60, runEndedAt: T0 + 60_000 }).join("\n");
    assert.match(text, /Tiempo\s+01:00/u, text);
    assert.equal(text.includes("02:00"), false, text);
  });

  it("never hides an active agent to show Todos under height pressure", () => {
    let state = applyTicketObservationSync(createState(T0), { active: true, identifier: "EZE-417", status: "In Progress" });
    state = applyDelegationStart(state, "worker", T0);
    state = applyAgents(state, [
      record({ id: "worker-1", role: "worker" }),
      record({ id: "worker-2", role: "worker" }),
      record({ id: "worker-3", role: "worker" }),
    ]);

    const text = renderRightRail(snapOf(state), T0, { width: 46, height: 12 }).join("\n");
    assert.match(text, /Worker activo/u, text);
    assert.match(text, /Todos · \d+\/\d+/u, text);
  });
});

describe("derived Todos", () => {
  it("projects the normal flow and omits Explore when it never ran", () => {
    let state = applyTicketObservationSync(createState(T0), { active: true, identifier: "EZE-417", status: "In Progress" });
    const todos = deriveTodos(snapOf(state));

    assert.deepEqual(
      todos.items.map((item) => item.label),
      ["Cargar ticket", "Implementar", "Verificar", "Sincronizar Linear", "Finalizar"],
    );
    assert.equal(todos.items[0].state, "done");
    assert.equal(todos.items[1].state, "pending");
    assert.equal(todos.total, 5);
    assert.equal(todos.done, 1);
  });

  it("includes Explore only when the real flow used it", () => {
    let state = applyTicketObservationSync(createState(T0), { active: true, identifier: "EZE-417" });
    state = applyDelegationStart(state, "explore", T0);
    state = applyDelegationEnd(state, "done", T0 + 500);

    const todos = deriveTodos(snapOf(state));
    assert.deepEqual(
      todos.items.map((item) => item.label),
      ["Cargar ticket", "Explorar", "Implementar", "Verificar", "Sincronizar Linear", "Finalizar"],
    );
    assert.equal(todos.items.find((item) => item.key === "explore").state, "done");
  });

  it("derives running and done states from the active child and verification", () => {
    let state = applyTicketObservationSync(createState(T0), { active: true, identifier: "EZE-417" });
    state = applyDelegationStart(state, "worker", T0);
    let todos = deriveTodos(snapOf(state));
    assert.equal(todos.items.find((item) => item.key === "work").state, "running");

    state = applyDelegationEnd(state, "done", T0 + 1_000);
    state = applyVerificationReport(state, { status: "pass", valid: true, attempts: 1, repairs: 0, maxRepairs: 2 });
    todos = deriveTodos(snapOf(state));
    assert.equal(todos.items.find((item) => item.key === "work").state, "done");
    assert.equal(todos.items.find((item) => item.key === "verify").state, "done");
    assert.equal(todos.items.find((item) => item.key === "linear").state, "running");
  });

  it("collapses to `Todos · n/m` when the height is insufficient", () => {
    let state = applyTicketObservationSync(createState(T0), { active: true, identifier: "EZE-417" });
    const todos = deriveTodos(snapOf(state));

    assert.match(renderTodos(todos).join("\n"), /Cargar ticket/u);
    assert.deepEqual(renderTodos(todos, { maxRows: 2 }), ["Todos · 1/5"]);
  });
});

describe("detached head reader", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("accepts only a full detached commit id from a HEAD file", () => {
    assert.equal(parseDetachedHead(`${SHA}\n`), SHA);
    assert.equal(parseDetachedHead(SHA), SHA);
    assert.equal(parseDetachedHead("ref: refs/heads/main"), undefined);
    assert.equal(parseDetachedHead("abc1234"), undefined);
    assert.equal(parseDetachedHead("not a sha"), undefined);
    assert.equal(parseDetachedHead(""), undefined);
    assert.equal(parseDetachedHead(undefined), undefined);
  });

  it("resolves a relative gitdir pointer against the directory holding the .git file", () => {
    assert.equal(resolveGitDirPointer("gitdir: ../gitdirs/wt", "/base/wt"), "/base/gitdirs/wt");
    assert.equal(resolveGitDirPointer("gitdir: /abs/gitdirs/wt", "/base/wt"), "/abs/gitdirs/wt");
    assert.equal(resolveGitDirPointer("not a pointer", "/base/wt"), undefined);
    assert.equal(resolveGitDirPointer("gitdir:", "/base/wt"), undefined);
    assert.equal(resolveGitDirPointer(undefined, "/base/wt"), undefined);
  });

  it("reads and shortens a normal repository's detached HEAD", () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-git-normal-"));
    try {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, ".git", "HEAD"), `${SHA}\n`);
      assert.equal(readDetachedShortSha(dir), SHA.slice(0, 7));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("follows a linked worktree's relative gitdir pointer to its HEAD", () => {
    const base = mkdtempSync(join(tmpdir(), "aies-git-worktree-"));
    try {
      const worktree = join(base, "wt");
      const gitdir = join(base, "gitdirs", "wt");
      mkdirSync(worktree);
      mkdirSync(gitdir, { recursive: true });
      // The `.git` file is a worktree pointer; git records it relative to the
      // worktree root, so the reader must resolve it before reading HEAD.
      writeFileSync(join(worktree, ".git"), `gitdir: ${join("..", "gitdirs", "wt")}\n`);
      writeFileSync(join(gitdir, "HEAD"), `${SHA}\n`);
      assert.equal(readDetachedShortSha(worktree), SHA.slice(0, 7));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("fails safely to undefined for a branch HEAD and for missing metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-git-branch-"));
    try {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      assert.equal(readDetachedShortSha(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(readDetachedShortSha(undefined), undefined);
    assert.equal(readDetachedShortSha(""), undefined);
  });
});

describe("branch projection", () => {
  it("prefers the ticket change branch, then the workspace branch, then a detached short sha", () => {
    assert.equal(
      projectBranch({ changeBranch: "aies/EZE-417", workspaceBranch: "main", shortSha: "abc1234def" }),
      "aies/EZE-417",
    );
    assert.equal(projectBranch({ workspaceBranch: "main", shortSha: "abc1234def" }), "main");
    assert.equal(projectBranch({ workspaceBranch: "detached", shortSha: "abc1234def" }), "detached @ abc1234");
    assert.equal(projectBranch({ workspaceBranch: "detached" }), undefined);
    assert.equal(projectBranch({}), undefined);
  });

  it("formats the new token vocabulary so 8747 becomes 8.7k", () => {
    assert.equal(formatTokens(8747), "8.7k");
    assert.equal(formatTokens(4200), "4.2k");
    assert.equal(formatTokens(999), "999");
  });
});

describe("right rail projection", () => {
  it("projects the project and branch beside the run status", () => {
    const text = renderRightRail(snapOf(richState()), T0, {
      width: 60,
      project: "/Users/dev/Proyectos/Developer/AIES",
      branch: "feat/aies-010d-fullscreen-shell",
    }).join("\n");

    assert.match(text, /Proyecto\s+AIES/u);
    assert.match(text, /Rama\s+feat\/aies-010d-fullscreen-shell/u);
    assert.match(text, /✧ AIES · EZE-417 · WORK/u);
    assert.ok(text.length > 0);
    assert.ok(text.split("\n").every((line) => line.length <= 60), text);
  });

  it("shows a Rama dash instead of dropping the row when no branch source exists", () => {
    const text = renderRightRail(snapOf(richState()), T0, { width: 60 }).join("\n");
    assert.match(text, /Rama\s+—/u, `the branch row must stay visible as a dash:\n${text}`);
  });

  it("renders coherent Status and Agents sections", () => {
    const text = renderRightRail(snapOf(richState()), T0, {
      width: 46,
      project: "/Users/dev/Proyectos/Developer/AIES",
      branch: "feat/aies-010d-fullscreen-shell",
    }).join("\n");

    assert.match(text, /Status/u);
    assert.match(text, /Agents/u);
    assert.match(text, /◆ Worker activo/u);
    assert.ok(text.split("\n").every((line) => line.length <= 46), text);
  });

  it("keeps an intentional, quiet Agents section at IDLE", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });
    state = applyModel(state, { id: "qwen3.8-flash", provider: "openrouter", name: "Qwen 3.8 Flash" });
    const text = renderRightRail(snapOf(state), T0, { width: 46 }).join("\n");

    assert.match(text, /Status/u);
    assert.match(text, /Agents/u);
    assert.match(text, /en espera/u, `the empty Agents section must stay explicit:\n${text}`);
    // IDLE has no run: the time row stays but reads as a dash, never a session clock.
    assert.match(text, /Tiempo\s+—/u, text);
    assert.equal(text.includes("00:00"), false, text);
  });

  it("bounds the Agents section during work", () => {
    let state = applyDelegationStart(createState(T0), "worker", T0);
    state = applyAgents(state, [
      record({ id: "worker-1", role: "worker" }),
      record({ id: "worker-2", role: "worker" }),
      record({ id: "worker-3", role: "worker" }),
      record({ id: "worker-4", role: "worker" }),
    ]);
    const lines = renderRightRail(snapOf(state), T0, { width: 46 });
    const text = lines.join("\n");

    assert.ok(text.split("\n").filter((line) => /Worker/u.test(line)).length <= 3, text);
    assert.match(text, /más/u, text);
    assert.ok(lines.every((line) => line.length <= 46), text);
  });

  it("renders nothing when there is no usable width", () => {
    assert.deepEqual(renderRightRail(snapOf(richState()), T0, { width: 10 }), []);
    assert.deepEqual(renderRightRail(snapOf(richState()), T0, { width: undefined }), []);
  });

  it("times the active run and never the session", () => {
    let state = applyContextUsage(createState(T0), { tokens: 31_000, contextWindow: 200_000 });

    const idle = renderRightRail(snapOf(state), T0 + 90_000, { width: 60 }).join("\n");
    assert.equal(idle.includes("01:30"), false, `the session elapsed leaked into the rail:\n${idle}`);
    assert.match(idle, /Tiempo\s+—/u, idle);

    state = applyRunStart(state, T0 + 60_000);
    const running = renderRightRail(snapOf(state), T0 + 90_000, { width: 60 }).join("\n");
    assert.match(running, /00:30/u);
  });
});

describe("right rail install", () => {
  it("attaches the rail to a supported fullscreen host and restores it on dispose", () => {
    const { host, root, original } = fakeHost();
    const descriptor = Object.getOwnPropertyDescriptor(root, LAYOUT_NODE);
    const handle = installRightRail(host, { version: "0.86.1", render: () => ["rail-line"] });

    assert.equal(handle.active, true);
    assert.notEqual(root[LAYOUT_NODE], original, "the layout node must be wrapped");

    const node = root[LAYOUT_NODE]();
    assert.equal(node.type, "hstack");
    assert.equal(handle.showing(), true, "a rendered rail reports itself as showing");
    const right = node.entries.at(-1);
    assert.deepEqual(right.component.render(46), ["rail-line"]);
    const left = node.entries[0];
    assert.deepEqual(left.component[LAYOUT_NODE](), original(), "the transcript side delegates to the host");

    handle.dispose();
    assert.equal(root[LAYOUT_NODE], original, "dispose restores the private hook");
    assert.equal(handle.active, false, "a disposed shim is no longer active");
    assert.equal(handle.showing(), false, "a disposed shim stops presenting");
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(root, LAYOUT_NODE),
      descriptor,
      "dispose restores the exact original descriptor",
    );
  });

  it("mounts the rail on a recognized fullscreen host at Pi 0.87.0", () => {
    const { host, root, original } = fakeHost();
    const handle = installRightRail(host, { version: "0.87.0", render: () => ["rail-line"] });

    assert.equal(handle.active, true, "0.87.0 is above the audited floor and must attempt the rail");
    assert.notEqual(root[LAYOUT_NODE], original, "the layout node must be wrapped");

    const node = root[LAYOUT_NODE]();
    assert.equal(node.type, "hstack");
    assert.equal(handle.showing(), true, "a rendered rail reports itself as showing");
    const right = node.entries.at(-1);
    assert.deepEqual(right.component.render(46), ["rail-line"]);
    const left = node.entries[0];
    assert.deepEqual(left.component[LAYOUT_NODE](), original(), "the transcript side delegates to the host");
    handle.dispose();
  });

  it("accepts a legitimately empty stack as the host layout node", () => {
    const original = () => ({ type: "vstack", entries: [] });
    const root = { [LAYOUT_NODE]: original };
    const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
    const handle = installRightRail(host, { version: "0.87.0", render: () => ["rail-line"] });

    assert.equal(root[LAYOUT_NODE]().type, "hstack", "an empty host stack is still recognized");
    assert.equal(handle.active, true);
    assert.equal(handle.showing(), true);
    handle.dispose();
  });

  it("forward-accepts a future minor when the host stack vocabulary is still recognized", () => {
    const { host, root } = fakeHost();
    const handle = installRightRail(host, { version: "0.88.0", render: () => ["rail-line"] });

    assert.equal(handle.active, true);
    assert.equal(root[LAYOUT_NODE]().type, "hstack", "a recognizable host shape self-heals on a newer Pi");
    assert.equal(handle.showing(), true);
    handle.dispose();
  });

  it("latches off permanently when the host layout node is not a recognized stack", () => {
    for (const bad of [
      { type: "flex", children: [] },
      { type: "vstack", entries: [{ somethingElse: 1 }] },
      { type: "vstack", entries: [null] },
    ]) {
      const original = () => bad;
      const root = { [LAYOUT_NODE]: original };
      const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
      const handle = installRightRail(host, { version: "0.88.0", render: () => ["rail-line"] });

      assert.equal(handle.active, true, "the gates pass before any layout pass runs the probe");
      assert.equal(root[LAYOUT_NODE](), bad, "an unrecognized host node is delegated unchanged");
      assert.equal(handle.active, false, "the structural probe latches the shim off");
      assert.equal(handle.showing(), false);
      assert.equal(root[LAYOUT_NODE](), bad, "later calls keep delegating permanently");
      handle.dispose();
    }
  });

  it("latches off and keeps delegating when the host layout node throws", () => {
    const original = () => {
      throw new Error("host boom");
    };
    const root = { [LAYOUT_NODE]: original };
    const host = { mode: "fullscreen", terminal: { columns: 160 }, layoutRoot: root, requestRender() {} };
    const handle = installRightRail(host, { version: "0.87.0", render: () => ["rail-line"] });

    assert.throws(() => root[LAYOUT_NODE](), /host boom/u);
    assert.equal(handle.active, false, "a throwing host node must never be wrapped");
    assert.equal(handle.showing(), false);
    assert.throws(() => root[LAYOUT_NODE](), /host boom/u, "delegation stays permanent");
    handle.dispose();
  });

  it("is a non-fatal no-op below the audited floor or without the private capability", () => {
    const belowFloor = fakeHost();
    const belowFloorHandle = installRightRail(belowFloor.host, { version: "0.84.9", render: () => ["x"] });
    assert.equal(belowFloorHandle.active, false);
    assert.equal(belowFloorHandle.showing(), false);
    assert.equal(belowFloor.root[LAYOUT_NODE], belowFloor.original);
    belowFloorHandle.dispose();

    const unparseable = fakeHost();
    const unparseableHandle = installRightRail(unparseable.host, { version: "nonsense", render: () => ["x"] });
    assert.equal(unparseableHandle.active, false);
    assert.equal(unparseable.root[LAYOUT_NODE], unparseable.original);

    const noRoot = { mode: "fullscreen", terminal: { columns: 160 }, requestRender() {} };
    const noRootHandle = installRightRail(noRoot, { version: "0.87.0", render: () => ["x"] });
    assert.equal(noRootHandle.active, false);

    const notFunction = fakeHost();
    notFunction.root[LAYOUT_NODE] = "nope";
    const notFunctionHandle = installRightRail(notFunction.host, { version: "0.87.0", render: () => ["x"] });
    assert.equal(notFunctionHandle.active, false);
    assert.equal(notFunction.root[LAYOUT_NODE], "nope", "the host hook is never replaced when it is not a function");

    const regular = fakeHost({ mode: "regular" });
    const regularHandle = installRightRail(regular.host, { version: "0.87.0", render: () => ["x"] });
    assert.equal(regularHandle.active, false);
    assert.equal(regular.root[LAYOUT_NODE], regular.original);
  });

  it("falls back to the host layout when the rail render throws", () => {
    const { host, root, original } = fakeHost();
    const handle = installRightRail(host, {
      version: "0.86.1",
      render: () => {
        throw new Error("rail boom");
      },
    });
    assert.equal(handle.active, true);
    assert.doesNotThrow(() => root[LAYOUT_NODE]());
    assert.deepEqual(root[LAYOUT_NODE](), original());
    assert.equal(handle.showing(), false, "a failed rail render must not hide the fallback");
    handle.dispose();
  });

  it("uses the live terminal width to decide whether the rail is showing", () => {
    const { host, root, original } = fakeHost();
    const handle = installRightRail(host, { version: "0.86.1", render: () => ["rail-line"] });

    host.terminal.columns = RIGHT_RAIL_MIN_WIDTH - 1;
    assert.deepEqual(root[LAYOUT_NODE](), original(), "below the breakpoint the rail yields to the host");
    assert.equal(handle.showing(), false);

    host.terminal.columns = RIGHT_RAIL_MIN_WIDTH;
    assert.notDeepEqual(root[LAYOUT_NODE](), original());
    assert.equal(handle.showing(), true);
    handle.dispose();
    assert.equal(handle.showing(), false, "dispose stops presenting");
  });
});
