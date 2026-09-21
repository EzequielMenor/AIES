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
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyAgents,
  applyContextUsage,
  applyDelegationStart,
  applyModel,
  applyRunStart,
  applyTicketObservationSync,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import {
  LAYOUT_NODE,
  RIGHT_RAIL_MIN_WIDTH,
  branchLabel,
  installRightRail,
  isSupportedPiVersion,
  projectLabel,
  renderRightRail,
} from "../extensions/aies-ui/right-rail.ts";

const SETTINGS = fileURLToPath(new URL("../profile/settings.json", import.meta.url));
const profile = JSON.parse(readFileSync(SETTINGS, "utf8"));

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
});

describe("right rail guard", () => {
  it("accepts only the audited Pi minor families", () => {
    assert.equal(isSupportedPiVersion("0.86.1"), true);
    assert.equal(isSupportedPiVersion("0.85.1"), true);
    assert.equal(isSupportedPiVersion("0.87.0"), false);
    assert.equal(isSupportedPiVersion("0.84.9"), false);
    assert.equal(isSupportedPiVersion(undefined), false);
    assert.equal(isSupportedPiVersion("nonsense"), false);
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
    assert.equal(text.includes("Tiempo"), false, text);
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
    assert.equal(idle.includes("Tiempo"), false, idle);

    state = applyRunStart(state, T0 + 60_000);
    const running = renderRightRail(snapOf(state), T0 + 90_000, { width: 60 }).join("\n");
    assert.match(running, /00:30/u);
  });
});

describe("right rail install", () => {
  it("attaches the rail to a supported fullscreen host and restores it on dispose", () => {
    const { host, root, original } = fakeHost();
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
  });

  it("is a non-fatal no-op on an unsupported version or host", () => {
    const unsupported = fakeHost();
    const unsupportedHandle = installRightRail(unsupported.host, { version: "0.87.0", render: () => ["x"] });
    assert.equal(unsupportedHandle.active, false);
    assert.equal(unsupportedHandle.showing(), false);
    assert.equal(unsupported.root[LAYOUT_NODE], unsupported.original);
    unsupportedHandle.dispose();

    const noRoot = { mode: "fullscreen", terminal: { columns: 160 }, requestRender() {} };
    const noRootHandle = installRightRail(noRoot, { version: "0.86.1", render: () => ["x"] });
    assert.equal(noRootHandle.active, false);

    const regular = fakeHost({ mode: "regular" });
    const regularHandle = installRightRail(regular.host, { version: "0.86.1", render: () => ["x"] });
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
