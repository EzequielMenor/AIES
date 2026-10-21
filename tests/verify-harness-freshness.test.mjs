/**
 * Stale-runtime guard scoped to what the Verify child loads (D44, refines D31).
 *
 * Verify blocks on a stale runtime only when a module the Verify child itself
 * executes changed after the process started. Edits to modules it never loads
 * (UI, design, memory) leave the in-process Verify valid, which breaks the
 * self-hosting loop without running any Worker-edited code outside the sandbox.
 *
 * 1. The closure follows static value imports, ignores `import type`, and
 *    gives up (`undefined`) on anything it cannot resolve.
 * 2. Freshness counts only closure modules; an unknown closure falls back to the
 *    whole `extensions/` tree.
 * 3. Cycle: Verify FAIL -> Worker edits an unrelated extension -> Verify runs
 *    again in-process with no relaunch -> PASS -> Done Gate. Editing a harness
 *    module instead blocks, spends no model call, and never registers a PASS.
 *
 * Everything runs on temporary trees and a faux provider.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";
import { checkDoneGate } from "../extensions/aies-agents/linear/policy.ts";
import { checkVerifyHarnessFreshness, verifyHarnessModules } from "../extensions/aies-agents/runtime-freshness.ts";
import { createVerificationState } from "../extensions/aies-agents/verification.ts";
import { VERIFY_COMPLETE_TOOL } from "../extensions/aies-agents/verify.ts";

const STARTED = 1_000_000;
const CHANGED_PATHS = ["extensions/aies-design/index.ts"];
const VERIFY_REQUEST = { role: "verify", task: "Verify design", criteria: ["design works"], changedPaths: CHANGED_PATHS };

function write(path, content = "export const x = 1;\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}
function touch(path, ms) {
  utimesSync(path, new Date(ms), new Date(ms));
}

/** A tree shaped like the repo: verify.ts -> helper.ts, session.ts, plus unrelated extensions. */
function makeTree() {
  const root = mkdtempSync(join(tmpdir(), "aies-harness-"));
  const ext = join(root, "extensions");
  const files = {
    verify: write(
      join(ext, "aies-agents/verify.ts"),
      'import type { Observatory } from "./observatory.ts";\nimport { helper } from "./helper.ts";\nexport const v = helper;\n',
    ),
    session: write(join(ext, "aies-agents/session.ts"), 'export * from "./session-extra.ts";\n'),
    extra: write(join(ext, "aies-agents/session-extra.ts")),
    helper: write(join(ext, "aies-agents/helper.ts"), 'export const helper = () => import("../aies-ui/lazy.ts");\n'),
    lazy: write(join(ext, "aies-ui/lazy.ts")),
    typeOnly: write(join(ext, "aies-agents/observatory.ts")),
    design: write(join(ext, "aies-design/index.ts")),
    ui: write(join(ext, "aies-ui/right-rail.ts")),
  };
  for (const file of Object.values(files)) touch(file, STARTED - 10_000);
  return { root, ext, files };
}

const fresh = (ext) => checkVerifyHarnessFreshness({ startedAt: STARTED, roots: [ext] });

describe("verifyHarnessModules", () => {
  it("follows value imports (static and dynamic) and skips import type", () => {
    const { root, ext, files } = makeTree();
    try {
      const closure = verifyHarnessModules(ext);
      assert.deepEqual(
        closure,
        [files.extra, files.helper, files.lazy, files.session, files.verify].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns undefined when an import cannot be read", () => {
    const { root, ext } = makeTree();
    try {
      write(join(ext, "aies-agents/helper.ts"), 'import "./missing.ts";\n');
      assert.equal(verifyHarnessModules(ext), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gives up on loading forms it cannot follow", () => {
    for (const body of ['const r = require("./x.ts");\n', 'await import(name);\n', 'import.meta.resolve("./x.ts");\n']) {
      const { root, ext } = makeTree();
      try {
        write(join(ext, "aies-agents/helper.ts"), body);
        assert.equal(verifyHarnessModules(ext), undefined, body);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("on the real repository covers the Verify child and excludes UI panels and design", () => {
    const closure = verifyHarnessModules() ?? [];
    const names = closure.map((path) => path.split("/extensions/")[1]);
    for (const required of ["aies-agents/verify.ts", "aies-agents/verify-guard.ts", "aies-agents/sandbox.ts", "aies-agents/handoff.ts"]) {
      assert.ok(names.includes(required), `${required} must be in the closure`);
    }
    assert.ok(!names.some((name) => name.startsWith("aies-design/") || name === "aies-ui/right-rail.ts"));
  });
});

describe("checkVerifyHarnessFreshness", () => {
  it("ignores edits to modules the Verify child never loads", () => {
    const { root, ext, files } = makeTree();
    try {
      touch(files.design, STARTED + 5_000);
      touch(files.ui, STARTED + 5_000);
      touch(files.typeOnly, STARTED + 5_000);
      assert.equal(fresh(ext).fresh, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is stale when a module the child loads changed, directly or transitively", () => {
    const { root, ext, files } = makeTree();
    try {
      touch(files.lazy, STARTED + 5_000);
      const report = fresh(ext);
      assert.equal(report.fresh, false);
      assert.deepEqual(report.stalePaths, [files.lazy]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps watching provider extensions, whose transport runs inside the child", () => {
    const { root, ext } = makeTree();
    try {
      const provider = write(join(ext, "aies-provider-commandcode/index.ts"));
      touch(provider, STARTED + 5_000);
      assert.deepEqual(fresh(ext).stalePaths, [provider]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the whole tree when the closure is unknown", () => {
    const { root, ext, files } = makeTree();
    try {
      write(join(ext, "aies-agents/helper.ts"), 'import "./missing.ts";\n');
      touch(join(ext, "aies-agents/helper.ts"), STARTED - 10_000);
      touch(files.design, STARTED + 5_000);
      assert.equal(fresh(ext).fresh, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Verify -> Worker -> Verify without relaunching", () => {
  async function setup(editedFile) {
    const faux = fauxProvider();
    const runtime = await ModelRuntime.create();
    runtime.registerNativeProvider(faux.provider);
    const tree = makeTree();
    let state = createVerificationState();
    const verdict = (status, id) =>
      fauxAssistantMessage([
        fauxToolCall(
          VERIFY_COMPLETE_TOOL,
          {
            status,
            summary: status,
            criteria: [{ index: 1, criterion: "design works", status, evidence: "ran" }],
            checks: [{ check: "npm test", result: status }],
            defects: status === "fail" ? [{ severity: "blocking", file: "extensions/aies-design/index.ts", description: "bug" }] : [],
            next: [],
          },
          id,
        ),
      ]);
    const tool = createDelegateTool({
      verification: { get: () => state, set: (next) => (state = next) },
      isSandboxActive: () => true,
      freshness: () => fresh(tree.ext),
      runners: {
        worker: async () => {
          touch(tree.files[editedFile], STARTED + 5_000); // the Worker's edit
          return { status: "done", summary: "fixed", changes: [{ file: CHANGED_PATHS[0], description: "x" }], checks: [], issues: [], next: [] };
        },
      },
    });
    const ctx = { cwd: tree.root, model: faux.models[0], modelRegistry: runtime };
    return { tool, ctx, faux, tree, verdict, read: () => state };
  }

  it("re-verifies in-process after a Worker edits an unrelated extension, and the Done Gate follows the real PASS", async () => {
    const { tool, ctx, faux, tree, verdict, read } = await setup("design");
    try {
      faux.setResponses([verdict("fail", "c1")]);
      const first = await tool.execute("a", VERIFY_REQUEST, undefined, undefined, ctx);
      assert.equal(first.details.status, "fail", JSON.stringify(first.content).slice(0, 600));
      await tool.execute("b", { role: "worker", task: "fix", context: "" }, undefined, undefined, ctx);
      assert.equal(checkDoneGate(read(), CHANGED_PATHS).allowed, false, "a FAIL never opens the gate");

      faux.setResponses([verdict("pass", "c2")]);
      const second = await tool.execute("c", VERIFY_REQUEST, undefined, undefined, ctx);
      assert.notEqual(second.isError, true);
      assert.equal(second.details.status, "pass");
      assert.equal(read().verifiedRevision, read().revision);
      assert.equal(checkDoneGate(read(), CHANGED_PATHS).allowed, true);
      assert.ok(faux.state.callCount > 0);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  it("blocks, without a model call or a PASS, when the Worker edits a module the child loads", async () => {
    const { tool, ctx, faux, tree, verdict, read } = await setup("helper");
    try {
      faux.setResponses([verdict("fail", "c1")]);
      await tool.execute("a", VERIFY_REQUEST, undefined, undefined, ctx);
      const callsBefore = faux.state.callCount;
      await tool.execute("b", { role: "worker", task: "fix", context: "" }, undefined, undefined, ctx);

      const second = await tool.execute("c", VERIFY_REQUEST, undefined, undefined, ctx);
      assert.equal(second.isError, true);
      assert.equal(second.details.error, "stale_runtime");
      assert.equal(faux.state.callCount, callsBefore);
      assert.notEqual(read().status, "pass");
      assert.equal(checkDoneGate(read(), CHANGED_PATHS).allowed, false);
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});
