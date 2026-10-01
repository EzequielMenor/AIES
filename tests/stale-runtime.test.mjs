/**
 * EZE-492: stale-runtime guard (D31).
 *
 * Pi loads every AIES extension module once at process start, and children run
 * in-process reusing those loaded modules. If the Parent edits an
 * `extensions/*.ts` file mid-session, a Verify spawned in the same process would
 * prove the OLD code, not the working tree. `runtime-freshness.ts` detects exactly
 * that: startup-loaded module files whose mtime is later than the process start.
 *
 * These tests pin the contract:
 * 1. A module file edited after the baseline is stale; a non-module file is not.
 * 2. A process that started after the last write is fresh.
 * 3. Only the `extensions/` tree counts: docs, tests, package.json and prompts
 *    never block a verification.
 * 4. Real-repo regression: an old process sees stale modules, a fresh one does not.
 * 5. The message tells the user the verification is blocked, names a stale path,
 *    and instructs to relaunch AIES, noting subprocess checks are unaffected.
 *
 * Everything runs against temporary trees; nothing touches `~/.pi` or the default
 * profile, and no child process is spawned.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  checkRuntimeFreshness,
  formatStaleRuntimeMessage,
  processStartedAt,
} from "../extensions/aies-agents/runtime-freshness.ts";

const tempRoots = [];

function makeTempRoot() {
  const root = mkdtempSync(join(tmpdir(), "aies-stale-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

/** Write a file, creating parent directories, and return its absolute path. */
function writeFile(path, content = "export const x = 1;\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Pin a file's mtime (and atime) to an absolute instant, in epoch milliseconds. */
function setMtime(path, epochMs) {
  const when = new Date(epochMs);
  utimesSync(path, when, when);
}

describe("runtime-freshness", () => {
  it("flags a module edited after the baseline as stale, ignores non-modules", () => {
    const root = makeTempRoot();
    const ext = join(root, "extensions", "a");
    const moduleFile = writeFile(join(ext, "b.ts"));
    const docFile = writeFile(join(ext, "ignored.md"), "# notes\n");
    const readme = writeFile(join(ext, "README.md"), "# readme\n");

    const baseline = Date.now();
    // All three "changed" after the process started, but only the .ts is loaded.
    setMtime(moduleFile, baseline + 5000);
    setMtime(docFile, baseline + 5000);
    setMtime(readme, baseline + 5000);

    const report = checkRuntimeFreshness({ startedAt: baseline, roots: [join(root, "extensions")] });
    assert.equal(report.fresh, false);
    assert.equal(report.stalePaths.length, 1);
    assert.ok(report.stalePaths[0].endsWith("b.ts"));
    assert.ok(report.scannedFiles >= 1);
  });

  it("flags the runtime-loaded non-module resource (models.json) as stale", () => {
    const root = makeTempRoot();
    // models.json is readFileSync'd at startup, so it is runtime-loaded even
    // though it is not a module file; an edit after the baseline must block.
    const resource = writeFile(
      join(root, "aies-provider-commandcode", "models.json"),
      JSON.stringify({ models: [] }) + "\n",
    );

    const baseline = Date.now();
    setMtime(resource, baseline + 5000);

    const report = checkRuntimeFreshness({ startedAt: baseline, roots: [root] });
    assert.equal(report.fresh, false);
    assert.ok(
      report.stalePaths.some((path) => path.endsWith("models.json")),
      "stalePaths includes the runtime-loaded models.json resource",
    );
    assert.ok(report.scannedFiles >= 1);
  });

  it("ignores a sibling non-allowlisted .json resource and a missing resource", () => {
    const root = makeTempRoot();
    // Only the exact allowlisted path counts; another .json in the same tree does
    // not, and a missing resource is simply omitted (never a throw).
    const otherJson = writeFile(join(root, "aies-provider-commandcode", "other.json"), "{}\n");
    const unrelated = writeFile(join(root, "aies-something", "models.json"), "{}\n");

    const baseline = Date.now();
    setMtime(otherJson, baseline + 5000);
    setMtime(unrelated, baseline + 5000);

    const report = checkRuntimeFreshness({ startedAt: baseline, roots: [root] });
    assert.equal(report.fresh, true);
    assert.deepEqual(report.stalePaths, []);
  });

  it("reports a process started after the last write as fresh", () => {
    const root = makeTempRoot();
    const ext = join(root, "extensions", "a");
    const moduleFile = writeFile(join(ext, "b.ts"));
    // Last write happened a minute ago; the baseline is now.
    setMtime(moduleFile, Date.now() - 60_000);

    const report = checkRuntimeFreshness({
      startedAt: Date.now(),
      roots: [join(root, "extensions")],
    });
    assert.equal(report.fresh, true);
    assert.deepEqual(report.stalePaths, []);
  });

  it("only the extensions/ tree blocks: docs, tests, package.json and prompts do not", () => {
    const root = makeTempRoot();
    const future = Date.now() + 60_000;
    // Runtime tree is present and clean.
    const runtimeModule = writeFile(join(root, "extensions", "tool.ts"));
    setMtime(runtimeModule, Date.now() - 10_000);

    // Non-runtime files change AFTER the baseline: none of them are loaded modules.
    setMtime(writeFile(join(root, "docs", "x.md"), "# doc\n"), future);
    setMtime(writeFile(join(root, "tests", "y.test.mjs"), "test('y', () => {});\n"), future);
    setMtime(writeFile(join(root, "package.json"), "{}\n"), future);
    setMtime(writeFile(join(root, "agents", "worker.md"), "# prompt\n"), future);

    const report = checkRuntimeFreshness({
      startedAt: Date.now(),
      roots: [join(root, "extensions")],
    });
    assert.equal(report.fresh, true);
    assert.deepEqual(report.stalePaths, []);
  });

  it("real repo regression: an old process sees stale modules, a fresh one does not", () => {
    // Default roots resolve to the real AIES extensions tree via this module path.
    const staleProcess = checkRuntimeFreshness({ startedAt: 0 });
    assert.equal(staleProcess.fresh, false);
    assert.ok(staleProcess.stalePaths.length > 0);

    const freshProcess = checkRuntimeFreshness({ startedAt: Date.now() + 1000 });
    assert.equal(freshProcess.fresh, true);
    assert.deepEqual(freshProcess.stalePaths, []);
  });

  it("message blocks the verification, names a path, and points at the relaunch", () => {
    const root = makeTempRoot();
    const moduleFile = writeFile(join(root, "extensions", "a", "tool.ts"));
    const baseline = Date.now();
    setMtime(moduleFile, baseline + 5000);

    const report = checkRuntimeFreshness({ startedAt: baseline, roots: [join(root, "extensions")] });
    assert.equal(report.fresh, false);

    const message = formatStaleRuntimeMessage(report);
    assert.match(message, /bloqueada/i);
    assert.ok(message.includes("tool.ts"), "names at least one stale path");
    assert.match(message, /`aies`/);
    assert.match(message, /subproceso/i);
    assert.ok(message.includes("npm test"), "notes subprocess checks are unaffected");
  });

  it("processStartedAt is at or before now and after the epoch", () => {
    const startedAt = processStartedAt();
    assert.ok(Number.isFinite(startedAt));
    assert.ok(startedAt <= Date.now());
    assert.ok(startedAt > 0);
  });
});
