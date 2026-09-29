/**
 * Test suite for AIES-005: Independent verification.
 *
 * Verifies:
 * 1. Verify has no mutation primitive: no `edit`, no `write`, and a bash policy
 *    that refuses git mutations, file mutation, in-place editing, dependency
 *    installation and file redirection.
 * 2. Verify can inspect: read-only git, repository checks and scoped search.
 * 3. Fresh context: parent/Worker sentinels never reach the Verify child, and the
 *    role refuses free-form context, so a Worker narrative has no path in.
 * 4. Verify reads the real artifact and reports PASS, FAIL or BLOCKED from it.
 * 5. A Worker claim that contradicts the repository produces FAIL, never PASS.
 * 6. Verify never repairs: the fixture is byte-identical before and after.
 * 7. Verification state: PASS invalidation by revision, bounded repair, early stop
 *    on a repeated failure signature, and the requirement rule.
 * 8. Metrics isolation: Verify's internal tools never touch parent counters.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { createDelegateTool, resolveBaseRef } from "../extensions/aies-agents/delegate.ts";
import {
  MAX_HANDOFF_CHARS,
  cleanCriterion,
  formatRepairBrief,
  formatVerifyHandoff,
  isProtocolError,
  normalizeCriteriaList,
  normalizedCriterion,
  parseVerifyHandoff,
  validateVerifyCompletion,
  verifyFailureSignature,
} from "../extensions/aies-agents/handoff.ts";
import { resolveVerifyModel } from "../extensions/aies-agents/model.ts";
import { createTgrepToolDefinition } from "../extensions/aies-agents/tgrep.ts";
import {
  applyToolCall,
  applyToolResult,
  createState,
} from "../extensions/aies-runtime/state.ts";
import {
  MAX_REPAIR_CYCLES,
  applyVerifyResult,
  applyVerifyStart,
  applyWorkerRepairStart,
  applyWorkerResult,
  applyWorkUnitChange,
  buildRepairContext,
  buildVerifyTaskInput,
  createVerificationState,
  isVerificationValid,
  planVerification,
  requiresVerification,
  toVerificationReport,
} from "../extensions/aies-agents/verification.ts";
import {
  createVerifyBashToolDefinition,
  isCommandPermittedInVerify,
} from "../extensions/aies-agents/verify-guard.ts";
import {
  MAX_VERIFY_RECOVERY_ATTEMPTS,
  VERIFY_COMPLETE_TOOL,
  VERIFY_TOOLS,
  createVerifyCompleteTool,
  createVerifyCompletionCollector,
  runVerifyAgent,
} from "../extensions/aies-agents/verify.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

/** The sentinel the parent session carries; Verify must never see it. */
const PARENT_SECRET = "WORKER_SECRET_SENTINEL_987";

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), "aies-verify-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return dir;
}

/** sha256 of every file in the tree, so "Verify did not touch it" is provable. */
function treeHash(root) {
  const digest = createHash("sha256");
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else digest.update(`${relative(root, full)}:${readFileSync(full, "utf8")}\n`);
    }
  };
  walk(root);
  return digest.digest("hex");
}

async function fauxRuntime() {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create();
  runtime.registerNativeProvider(faux.provider);
  return { faux, runtime, model: faux.models[0] };
}

function transcriptOf(sessionManager) {
  return JSON.stringify(sessionManager.getEntries());
}

function verifyHandoffJson(overrides = {}) {
  return `\`\`\`json
${JSON.stringify(
  {
    status: "pass",
    summary: "Inspected the artifact.",
    criteria: [{ criterion: "c", status: "pass", evidence: "file.js:1 shows 2000" }],
    checks: [],
    defects: [],
    next: [],
    ...overrides,
  },
  null,
  2,
)}
\`\`\``;
}

/** The same defaults as verifyHandoffJson, as the object the completion tool accepts. */
function verifyCompletion(overrides = {}) {
  return {
    status: "pass",
    summary: "Inspected the artifact.",
    criteria: [{ criterion: "c", status: "pass", evidence: "file.js:1 shows 2000" }],
    checks: [],
    defects: [],
    next: [],
    ...overrides,
  };
}

describe("AIES-005 Verify command policy (read-only shell)", () => {
  const allowed = [
    "npm test",
    "pnpm test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
    "pytest",
    "cargo test",
    "go test ./...",
    "node --test tests/x.test.mjs",
    "git status --porcelain",
    "git diff",
    "git diff --stat",
    "git show HEAD~1",
    "git log -n 5 --oneline",
    "git blame src/a.ts",
    "git ls-files",
    "grep -rn timeout src/",
    "sed -n '1,40p' src/a.ts",
    "cat config.json",
    "ls -la src/",
    "npm test 2>&1",
  ];

  const substitutionBypasses = [
    "echo $(rm -rf build)",
    "echo `git checkout -- .`",
    "cat <(rm x)",
  ];

  const blocked = [
    "git clean -fd",
    "git reset --hard HEAD~1",
    "git checkout -- .",
    "git checkout main",
    "git switch main",
    "git restore .",
    "git commit -m x",
    "git add -A",
    "git stash",
    "git apply patch.diff",
    "git push origin main",
    "git merge feature",
    "git rebase main",
    "git branch -D old",
    "git tag v1",
    "git fetch origin",
    "git pull",
    "git mv a.ts b.ts",
    "git rm a.ts",
    "rm -rf build",
    "rm build/x.js",
    "mv a.ts b.ts",
    "cp a.ts b.ts",
    "touch new.ts",
    "mkdir new-dir",
    "tee out.txt",
    "truncate -s 0 a.ts",
    "chmod 777 a.ts",
    "dd if=/dev/zero of=x bs=1 count=1",
    "sed -i 's/1000/2000/' config.js",
    "perl -pi -e 's/1000/2000/' config.js",
    "npm install",
    "npm ci",
    "pnpm add left-pad",
    "yarn install",
    "bun install",
    "echo done > out.txt",
    "npm test >> log.txt",
    "sudo rm -rf /var/log",
    "cat /etc/shadow",
    "npm publish",
    "vercel deploy",
    "cd ../..",
    "find . -name '*.ts' -delete",
    "find . -name '*.ts' -exec rm {} \\;",
    "find . -name '*.log' | xargs rm",
  ];

  it("permits the checks and the read-only git inspection a verifier needs", () => {
    for (const command of allowed) {
      const result = isCommandPermittedInVerify(command, REPO_ROOT);
      assert.equal(result.allowed, true, `${command} must be permitted: ${result.reason}`);
    }
  });

  it("refuses every mutation vector a verifier must not have", () => {
    for (const command of blocked) {
      const result = isCommandPermittedInVerify(command, REPO_ROOT);
      assert.equal(result.allowed, false, `${command} must be blocked`);
      assert.ok(result.reason && result.reason.length > 0, `${command} must explain itself`);
      assert.match(result.reason, /Verify/u, `${command} must name the policy that refused it`);
    }
  });

  it("refuses command substitution, which would hide a command from the guard", () => {
    for (const command of substitutionBypasses) {
      const result = isCommandPermittedInVerify(command, REPO_ROOT);
      assert.equal(result.allowed, false, command);
      assert.match(result.reason ?? "", /command substitution/u);
    }

    // The inner command is fine when the guard can see it.
    assert.equal(isCommandPermittedInVerify("git status", REPO_ROOT).allowed, true);
  });

  it("is not identical to the Worker policy: Verify is stricter about writes", () => {
    for (const command of ["rm build/x.js", "cp a.ts b.ts", "git commit -m x", "npm install", "echo x > f"]) {
      assert.equal(isCommandPermittedInVerify(command, REPO_ROOT).allowed, false, command);
    }
  });

  it("blocks a mutation at the tool boundary, not only in the helper", async () => {
    const tool = createVerifyBashToolDefinition(REPO_ROOT);
    const result = await tool.execute(
      "call-1",
      { command: "git commit -m x" },
      undefined,
      undefined,
      { cwd: REPO_ROOT },
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Command blocked by Verify safety guard/u);
  });
});

describe("AIES-005 Verify tool surface", () => {
  it("exposes no mutation tool at all", () => {
    assert.ok(VERIFY_TOOLS.includes("read"));
    assert.ok(VERIFY_TOOLS.includes("grep"));
    assert.ok(VERIFY_TOOLS.includes("find"));
    assert.ok(VERIFY_TOOLS.includes("ls"));
    assert.ok(VERIFY_TOOLS.includes("tgrep"));
    assert.ok(VERIFY_TOOLS.includes("bash"));
    assert.equal(VERIFY_TOOLS.includes("edit"), false);
    assert.equal(VERIFY_TOOLS.includes("write"), false);
  });

  it("builds a session whose active tools exclude edit and write", async () => {
    const { runtime, model } = await fauxRuntime();

    const loader = new DefaultResourceLoader({
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: "Verify",
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      model,
      modelRuntime: runtime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(REPO_ROOT),
      customTools: [
        createTgrepToolDefinition(REPO_ROOT),
        createVerifyBashToolDefinition(REPO_ROOT),
      ],
      tools: [...VERIFY_TOOLS],
    });

    try {
      const active = session.getActiveToolNames();
      assert.equal(active.includes("edit"), false, "Verify must not have 'edit'");
      assert.equal(active.includes("write"), false, "Verify must not have 'write'");
      assert.ok(active.includes("read"));
      assert.ok(active.includes("bash"));
      assert.ok(active.includes("tgrep"));
    } finally {
      session.dispose();
    }
  });
});

describe("AIES-005 Verify independence", () => {
  it("never receives the parent or Worker sentinel unless it is an explicit fact", async () => {
    const { faux, runtime, model } = await fauxRuntime();
    const sessionManager = SessionManager.inMemory(REPO_ROOT);
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall(
          VERIFY_COMPLETE_TOOL,
          verifyCompletion({
            criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1 shows 2000" }],
          }),
          "c1",
        ),
      ]),
      fauxAssistantMessage([{ type: "text", text: "done" }]),
      fauxAssistantMessage([
        fauxToolCall(
          VERIFY_COMPLETE_TOOL,
          verifyCompletion({
            criteria: [
              { criterion: `Report the sentinel ${PARENT_SECRET}`, status: "pass", evidence: PARENT_SECRET },
            ],
          }),
          "c2",
        ),
      ]),
      fauxAssistantMessage([{ type: "text", text: "done" }]),
    ]);

    // The parent session carries the sentinel; it is not part of Verify's input.
    const parentScratchpad = `parent notes: ${PARENT_SECRET} is the Worker sentinel`;
    assert.match(parentScratchpad, /987/u);

    const untouched = await runVerifyAgent({
      task: "Verify the timeout change",
      criteria: ["TIMEOUT_MS is 2000"],
      changedPaths: ["config.js"],
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      sessionManager,
    });

    assert.equal(untouched.status, "pass");
    assert.equal(transcriptOf(sessionManager).includes(PARENT_SECRET), false, "sentinel leaked");

    // The same assertion is not vacuous: a sentinel inside the criteria does appear.
    const secondManager = SessionManager.inMemory(REPO_ROOT);
    await runVerifyAgent({
      task: "Verify the timeout change",
      criteria: [`Report the sentinel ${PARENT_SECRET}`],
      cwd: REPO_ROOT,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      sessionManager: secondManager,
    });

    assert.equal(transcriptOf(secondManager).includes(PARENT_SECRET), true);
  });

  it("refuses free-form context, so a Worker narrative has no path into Verify", async () => {
    const tool = createDelegateTool();

    const result = await tool.execute(
      "call-1",
      {
        role: "verify",
        task: "Verify the timeout change",
        criteria: ["TIMEOUT_MS is 2000"],
        context: `Worker says: timeout updated to 2000. ${PARENT_SECRET}`,
      },
      undefined,
      undefined,
      { cwd: REPO_ROOT },
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /does not accept free-form context/u);
    assert.doesNotMatch(result.content[0].text, /WORKER_SECRET_SENTINEL_987|Worker says/u);
  });

  it("requires acceptance criteria instead of accepting a bare task", async () => {
    const tool = createDelegateTool();
    const result = await tool.execute(
      "call-1",
      { role: "verify", task: "Verify the timeout change" },
      undefined,
      undefined,
      { cwd: REPO_ROOT },
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires 'criteria'/u);
  });

  it("builds the child prompt from facts only", () => {
    const workerClaim = "Worker says the timeout was updated to 2000 and everything passes";
    const prompt = buildVerifyTaskInput({
      task: "Update the request timeout to 2000ms",
      criteria: ["TIMEOUT_MS is 2000", "npm test passes"],
      changedPaths: ["config.js"],
      baseRef: "HEAD~1",
      checks: ["npm test"],
    });

    assert.match(prompt, /WORK UNIT: Update the request timeout to 2000ms/u);
    assert.match(prompt, /1\. TIMEOUT_MS is 2000/u);
    assert.match(prompt, /CHANGED PATHS:\n- config\.js/u);
    assert.match(prompt, /BASE REF: HEAD~1/u);
    assert.match(prompt, /SUGGESTED CHECKS/u);
    assert.equal(prompt.includes(workerClaim), false);
    assert.doesNotMatch(prompt, /Worker says|everything passes/u);
  });

  it("resolves baseRef automatically from git HEAD when omitted, and prefers explicit value", () => {
    const explicit = resolveBaseRef(REPO_ROOT, "v1.0.0");
    assert.equal(explicit, "v1.0.0");

    const autoHead = resolveBaseRef(REPO_ROOT, undefined);
    assert.match(autoHead ?? "", /^[0-9a-f]{40}$/u, "git HEAD must resolve to 40-char hash");

    const fallback = resolveBaseRef(tmpdir(), undefined);
    assert.equal(fallback, undefined, "non-git dir must resolve to undefined");
  });

  it("instructs Parent to delegate directly to Worker when target is scoped, and not run git rev-parse", () => {
    const tool = createDelegateTool();
    const guidelines = (tool.promptGuidelines ?? []).join("\n");
    assert.match(guidelines, /bypassing 'explore'/i);
    assert.match(guidelines, /git rev-parse HEAD/i);
    assert.match(tool.parameters.properties.role.description, /Fast-Path/i);
  });
});

describe("AIES-005 Verify execution against a real fixture", () => {
  it("runs the repository checks and reads the real file", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const sessionManager = SessionManager.inMemory(dir);

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "call-read")]),
        fauxAssistantMessage([fauxToolCall("bash", { command: "npm test" }, "call-test")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            verifyCompletion({
              criteria: [
                { criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1 shows 2000" },
                { criterion: "npm test passes", status: "pass", evidence: "npm test exit 0" },
              ],
              checks: [{ check: "npm test", result: "exit 0" }],
            }),
            "call-complete",
          ),
        ]),
      ]);

      const handoff = await runVerifyAgent({
        task: "Update the request timeout to 2000ms",
        criteria: ["TIMEOUT_MS is 2000", "npm test passes"],
        changedPaths: ["config.js"],
        checks: ["npm test"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
        bashRunner: async () => ({ stdout: "3 checks passed\n", exitCode: 0 }),
      });

      assert.equal(handoff.status, "pass");

      const transcript = transcriptOf(sessionManager);
      assert.match(transcript, /TIMEOUT_MS = 2000/u, "Verify must have read the real file");
      assert.match(transcript, /3 checks passed/u, "Verify must have run the real check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns FAIL when the artifact does not satisfy the criteria", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 1000;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const sessionManager = SessionManager.inMemory(dir);

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "call-read")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            verifyCompletion({
              status: "fail",
              summary: "The timeout is still 1000.",
              criteria: [
                {
                  criterion: "TIMEOUT_MS is 2000",
                  status: "fail",
                  evidence: "config.js:1 shows TIMEOUT_MS = 1000",
                },
              ],
              defects: [
                {
                  severity: "blocking",
                  file: "config.js",
                  description: "TIMEOUT_MS is 1000, expected 2000",
                  evidence: "read config.js:1",
                },
              ],
            }),
            "call-complete",
          ),
        ]),
      ]);

      const handoff = await runVerifyAgent({
        task: "Update the request timeout to 2000ms",
        criteria: ["TIMEOUT_MS is 2000"],
        changedPaths: ["config.js"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
      });

      assert.equal(handoff.status, "fail");
      assert.equal(handoff.defects.length, 1);
      assert.equal(handoff.defects[0].severity, "blocking");
      assert.equal(handoff.defects[0].file, "config.js");
      assert.match(transcriptOf(sessionManager), /TIMEOUT_MS = 1000/u, "the real value was observed");
      assert.match(formatVerifyHandoff(handoff), /Blocking defects/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAILs when a Worker claim contradicts the repository", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 1000;\n" });
    try {
      // The Worker's handoff for this very change.
      const workerHandoff = {
        status: "done",
        summary: "Updated TIMEOUT_MS to 2000. All checks pass.",
        changes: [{ file: "config.js", description: "timeout updated to 2000" }],
        checks: [{ check: "npm test", result: "passed" }],
        issues: [],
        next: [],
      };

      const { faux, runtime, model } = await fauxRuntime();
      const sessionManager = SessionManager.inMemory(dir);

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "call-read")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            verifyCompletion({
              status: "fail",
              summary: `The Worker claimed the timeout is 2000 but the file says 1000.`,
              criteria: [
                {
                  criterion: "TIMEOUT_MS is 2000",
                  status: "fail",
                  evidence: "config.js:1 shows 1000",
                },
              ],
              defects: [
                {
                  severity: "blocking",
                  file: "config.js",
                  description: "TIMEOUT_MS is 1000, expected 2000",
                  evidence: "read config.js:1",
                },
              ],
            }),
            "call-complete",
          ),
        ]),
      ]);

      // The Verify child is built only from the work unit and the criteria.
      const prompt = buildVerifyTaskInput({
        task: "Update the request timeout to 2000ms",
        criteria: ["TIMEOUT_MS is 2000"],
        changedPaths: workerHandoff.changes.map((change) => change.file),
      });
      assert.equal(prompt.includes(workerHandoff.summary), false, "the claim never reaches Verify");

      const handoff = await runVerifyAgent({
        task: "Update the request timeout to 2000ms",
        criteria: ["TIMEOUT_MS is 2000"],
        changedPaths: ["config.js"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
      });

      assert.equal(handoff.status, "fail", "the repository, not the claim, decides");
      assert.match(transcriptOf(sessionManager), /TIMEOUT_MS = 1000/u);
      assert.equal(readFileSync(join(dir, "config.js"), "utf8"), "export const TIMEOUT_MS = 1000;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns BLOCKED, not FAIL, when the check cannot run", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const sessionManager = SessionManager.inMemory(dir);

      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("bash", { command: "pytest" }, "call-test")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            verifyCompletion({
              status: "blocked",
              summary: "pytest is not installed, so the acceptance criterion cannot be exercised.",
              criteria: [{ criterion: "pytest passes", status: "blocked", evidence: "command not found" }],
              checks: [{ check: "pytest", result: "exit 127: command not found" }],
              defects: [],
            }),
            "call-complete",
          ),
        ]),
      ]);

      const handoff = await runVerifyAgent({
        task: "Update the request timeout to 2000ms",
        criteria: ["pytest passes"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
        bashRunner: async () => ({ stdout: "sh: pytest: command not found\n", exitCode: 127 }),
      });

      assert.equal(handoff.status, "blocked");
      assert.notEqual(handoff.status, "fail");
      assert.equal(planVerification(applyVerifyResult(createVerificationState(), handoff, 0)).action, "stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never repairs: the fixture is byte-identical after a FAIL, even when the child tries", async () => {
    const dir = fixtureDir({
      "config.js": "export const TIMEOUT_MS = 1000;\n",
      "src/service.js": "export const t = 1000;\n",
    });
    try {
      const before = treeHash(dir);

      const { faux, runtime, model } = await fauxRuntime();
      const sessionManager = SessionManager.inMemory(dir);
      const executed = [];

      faux.setResponses([
        // The child tries to repair the defect through the shell.
        fauxAssistantMessage([fauxToolCall("bash", { command: "sed -i 's/1000/2000/' config.js" }, "call-1")]),
        fauxAssistantMessage([fauxToolCall("bash", { command: "git commit -am fix" }, "call-2")]),
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "call-3")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            verifyCompletion({
              status: "fail",
              criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "fail", evidence: "config.js:1 shows 1000" }],
              defects: [
                {
                  severity: "blocking",
                  file: "config.js",
                  description: "TIMEOUT_MS is 1000, expected 2000",
                },
              ],
            }),
            "call-complete",
          ),
        ]),
      ]);

      const handoff = await runVerifyAgent({
        task: "Update the request timeout to 2000ms",
        criteria: ["TIMEOUT_MS is 2000"],
        changedPaths: ["config.js"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
        bashRunner: async (command) => {
          executed.push(command);
          return { stdout: "unexpected", exitCode: 0 };
        },
      });

      assert.equal(handoff.status, "fail");
      assert.deepEqual(executed, [], "a blocked command must never reach the shell");
      assert.equal(treeHash(dir), before, "Verify modified the workspace");
      assert.equal(readFileSync(join(dir, "config.js"), "utf8"), "export const TIMEOUT_MS = 1000;\n");

      const transcript = transcriptOf(sessionManager);
      assert.match(transcript, /Command blocked by Verify safety guard/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AIES-005 Verify handoff", () => {
  it("parses the three verdicts", () => {
    for (const status of ["pass", "fail", "blocked"]) {
      const handoff = parseVerifyHandoff(verifyHandoffJson({ status }));
      assert.equal(handoff.status, status);
    }
  });

  it("rejects a PASS without evidence as a protocol error, never a domain verdict", () => {
    const result = parseVerifyHandoff(
      verifyHandoffJson({
        status: "pass",
        criteria: [{ criterion: "Timeout is 2000", status: "pass" }],
        checks: [],
      }),
    );

    assert.equal(isProtocolError(result), true);
    assert.equal(result.code, "invalid_completion");
    assert.equal(result.status, undefined, "a protocol error must not fake a domain status");
  });

  it("never fabricates BLOCKED for unreadable or malformed output", () => {
    for (const raw of [undefined, "   ", "no structured block here", verifyHandoffJson({ status: "maybe" })]) {
      const result = parseVerifyHandoff(raw);
      assert.equal(isProtocolError(result), true, `unreadable input produced a verdict: ${String(raw)}`);
      assert.equal(result.status, undefined, "a protocol error must not carry a domain status");
    }
  });

  it("caps the formatted verdict and keeps the repair brief to defects", () => {
    const handoff = parseVerifyHandoff(
      verifyHandoffJson({
        status: "fail",
        summary: "F".repeat(10_000),
        defects: [
          {
            severity: "blocking",
            file: "src/a.ts",
            description: "d".repeat(500),
            evidence: "e",
          },
        ],
      }),
    );

    assert.ok(formatVerifyHandoff(handoff).length <= MAX_HANDOFF_CHARS + 100);
    const brief = formatRepairBrief(handoff);
    assert.match(brief, /src\/a\.ts/u);
    assert.equal(brief.includes("F".repeat(50)), false, "the brief carries defects, not the summary");
  });

  it("derives a stable failure signature from the blocking defects", () => {
    const one = parseVerifyHandoff(
      verifyHandoffJson({
        status: "fail",
        defects: [{ severity: "blocking", file: "config.js", description: "TIMEOUT_MS is 1000, expected 2000" }],
      }),
    );
    const same = parseVerifyHandoff(
      verifyHandoffJson({
        status: "fail",
        summary: "Different wording entirely.",
        defects: [{ severity: "blocking", file: "./config.js", description: "timeout_ms  is   1000, expected 2000" }],
      }),
    );
    const other = parseVerifyHandoff(
      verifyHandoffJson({
        status: "fail",
        defects: [{ severity: "blocking", file: "src/a.ts", description: "Type mismatch" }],
      }),
    );

    assert.equal(verifyFailureSignature(one), verifyFailureSignature(same));
    assert.notEqual(verifyFailureSignature(one), verifyFailureSignature(other));
  });
});

describe("AIES-005 verification state and policy", () => {
  const failedOnce = () =>
    applyVerifyResult(
      applyVerifyStart(createVerificationState(), 0),
      parseVerifyHandoff(
        verifyHandoffJson({
          status: "fail",
          defects: [{ severity: "blocking", file: "config.js", description: "TIMEOUT_MS is 1000" }],
        }),
      ),
      1000,
    );

  it("requires verification for behaviour-bearing changes only", () => {
    assert.equal(requiresVerification(["src/a.ts"]).required, true);
    assert.equal(requiresVerification(["tests/a.test.mjs"]).required, true);
    assert.equal(requiresVerification(["package.json"]).required, true);
    assert.equal(requiresVerification(["README.md"]).required, false);
    assert.equal(requiresVerification(["docs/ARCHITECTURE.md", "CHANGELOG.md"]).required, false);
    assert.match(requiresVerification(["docs/x.md"]).reason, /documentation-only/u);
    assert.equal(requiresVerification(["docs/x.md", "src/a.ts"]).required, true);
    assert.deepEqual(requiresVerification([]).required, false);
  });

  it("invalidates a PASS as soon as the work unit changes", () => {
    const handoff = parseVerifyHandoff(verifyHandoffJson());
    const verified = applyVerifyResult(applyVerifyStart(createVerificationState(), 0), handoff, 500);

    assert.equal(verified.status, "pass");
    assert.equal(isVerificationValid(verified), true);
    assert.equal(planVerification(verified).action, "done");

    const edited = applyWorkUnitChange(verified, ["config.js"], "parent edit on config.js");
    assert.equal(edited.status, "none");
    assert.equal(isVerificationValid(edited), false);
    assert.equal(edited.verifiedRevision, undefined);
    assert.equal(planVerification(edited).action, "verify");
    assert.match(planVerification(edited).reason, /no longer matches the current revision/u);

    // A documentation-only edit is not a behaviour change: the PASS survives.
    const docsEdit = applyWorkUnitChange(verified, ["README.md"], "parent edit on README.md");
    assert.equal(docsEdit.status, "pass");
    assert.equal(isVerificationValid(docsEdit), true);
    assert.equal(planVerification(docsEdit).action, "done");
  });

  it("invalidates a PASS when a Worker run changes the artifact", () => {
    const verified = applyVerifyResult(
      applyVerifyStart(createVerificationState(), 0),
      parseVerifyHandoff(verifyHandoffJson()),
      10,
    );

    const afterWorker = applyWorkerResult(verified, ["config.js"]);
    assert.equal(isVerificationValid(afterWorker), false);
    assert.equal(afterWorker.awaitingVerification, true);
    assert.equal(planVerification(afterWorker).action, "verify");

    const docsOnly = applyWorkerResult(verified, ["README.md"]);
    assert.equal(docsOnly.awaitingVerification, false);
    assert.equal(isVerificationValid(docsOnly), true, "a documentation run does not expire a PASS");
  });

  it("allows a FAIL to be repaired, then verified again", () => {
    let state = failedOnce();
    assert.equal(state.status, "fail");
    assert.equal(planVerification(state).action, "repair");

    state = applyWorkerRepairStart(state);
    assert.equal(state.repairs, 1);
    state = applyWorkerResult(state, ["config.js"]);
    assert.equal(state.status, "none");
    assert.equal(planVerification(state).action, "verify");

    state = applyVerifyResult(applyVerifyStart(state, 2000), parseVerifyHandoff(verifyHandoffJson()), 2100);
    assert.equal(state.status, "pass");
    assert.equal(state.attempts, 2);
    assert.equal(planVerification(state).action, "done");
  });

  it("stops after the repair budget instead of looping", () => {
    let state = failedOnce();

    for (let cycle = 1; cycle <= MAX_REPAIR_CYCLES; cycle++) {
      assert.equal(planVerification(state).action, "repair", `cycle ${cycle} must be allowed`);
      state = applyWorkerRepairStart(state);
      state = applyWorkerResult(state, ["config.js"]);
      state = applyVerifyResult(
        applyVerifyStart(state, 0),
        parseVerifyHandoff(
          verifyHandoffJson({
            status: "fail",
            defects: [
              {
                severity: "blocking",
                file: "config.js",
                description: `Defect number ${cycle}`,
              },
            ],
          }),
        ),
        0,
      );
    }

    assert.equal(state.repairs, MAX_REPAIR_CYCLES);
    const decision = planVerification(state);
    assert.equal(decision.action, "stop");
    assert.match(decision.reason, /repair budget exhausted/u);
    assert.equal(state.attempts, 3);
  });

  it("stops early when the same failure repeats without progress", () => {
    let state = failedOnce();
    state = applyWorkerRepairStart(state);
    state = applyWorkerResult(state, ["config.js"]);
    state = applyVerifyResult(
      applyVerifyStart(state, 0),
      parseVerifyHandoff(
        verifyHandoffJson({
          status: "fail",
          summary: "Still failing, and the wording changed.",
          defects: [{ severity: "blocking", file: "config.js", description: "TIMEOUT_MS is 1000" }],
        }),
      ),
      0,
    );

    assert.equal(state.repeatedFailures, 2);
    const decision = planVerification(state);
    assert.equal(decision.action, "stop");
    assert.match(decision.reason, /same failure signature repeated/u);
    assert.ok(state.repairs < MAX_REPAIR_CYCLES, "the early stop happens before the budget is spent");
  });

  it("reports the policy state compactly for the parent and the observer", () => {
    const report = toVerificationReport(failedOnce());

    assert.equal(report.status, "fail");
    assert.equal(report.attempts, 1);
    assert.equal(report.repairs, 0);
    assert.equal(report.maxRepairs, MAX_REPAIR_CYCLES);
    assert.equal(report.valid, false);
    assert.equal(report.decision, "repair");
  });

  it("builds the repair context from the original work unit and the defects only", () => {
    const handoff = parseVerifyHandoff(
      verifyHandoffJson({
        status: "fail",
        defects: [
          { severity: "blocking", file: "config.js", description: "TIMEOUT_MS is 1000", evidence: "read config.js:1" },
          { severity: "non_blocking", file: "style.css", description: "unrelated nit" },
        ],
      }),
    );

    const context = buildRepairContext({
      task: "Update the request timeout to 2000ms",
      criteria: ["TIMEOUT_MS is 2000"],
      changedPaths: ["config.js"],
      brief: formatRepairBrief(handoff),
    });

    assert.match(context, /WORK UNIT: Update the request timeout to 2000ms/u);
    assert.match(context, /TIMEOUT_MS is 1000/u);
    assert.match(context, /RELEVANT PATHS:\n- config\.js/u);
    assert.equal(context.includes("unrelated nit"), false, "only blocking defects drive a repair");
    assert.doesNotMatch(context, /Verify Result|Summary/u);
  });
});

describe("AIES-005 Verify model resolution", () => {
  it("prefers AIES_VERIFY_MODEL", async () => {
    const { runtime } = await fauxRuntime();
    const resolved = await resolveVerifyModel(runtime, { id: "parent" }, "/dummy", {
      AIES_VERIFY_MODEL: "faux/faux-1",
    });

    assert.equal(resolved?.id, "faux-1");
  });

  it("reads aies.json agents.verify.model, then falls back to the parent model", async () => {
    const { runtime } = await fauxRuntime();
    const tempDir = mkdtempSync(join(tmpdir(), "aies-verify-model-"));
    try {
      writeFileSync(
        join(tempDir, "aies.json"),
        JSON.stringify({ agents: { verify: { model: "faux/faux-1" } } }),
      );

      assert.equal((await resolveVerifyModel(runtime, { id: "parent" }, tempDir, {})).id, "faux-1");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const parentModel = { id: "parent-model", provider: "mock" };
    assert.equal(await resolveVerifyModel(null, parentModel, "/dummy", {}), parentModel);
  });

  it("fails explicitly when a configured verify model cannot resolve, never a parent fallback or a verdict", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aies-verify-invalid-"));
    const previous = process.env.AIES_VERIFY_MODEL;
    delete process.env.AIES_VERIFY_MODEL;
    try {
      writeFileSync(
        join(dir, "aies.json"),
        JSON.stringify({ agents: { verify: { model: "ghost/missing-model" } } }),
      );
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: null,
      });
      const registry = new ModelRegistry(runtime);
      const parentModel = { provider: "mock", id: "parent-model" };

      await assert.rejects(
        () => resolveVerifyModel(registry, parentModel, dir, {}),
        /ghost\/missing-model/,
        "an explicit but unresolvable verify model must not resolve to the parent model",
      );

      const result = await runVerifyAgent({
        task: "This must not run on the parent model",
        criteria: ["the configured model resolves"],
        cwd: REPO_ROOT,
        agentDir: dir,
        modelRuntime: registry,
        parentModel,
      });

      assert.equal(
        isProtocolError(result),
        true,
        "an unresolvable model is a protocol fault, never a pass/fail/blocked verdict",
      );
      assert.equal(result.code, "session_failure");
      assert.match(result.message, /ghost\/missing-model/);
    } finally {
      if (previous === undefined) delete process.env.AIES_VERIFY_MODEL;
      else process.env.AIES_VERIFY_MODEL = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AIES-005 metrics isolation", () => {
  it("counts one parent call for a delegation, whatever Verify does inside", () => {
    let parent = createState(1_000_000);
    const root = "/repo";

    parent = applyToolCall(
      parent,
      { toolName: "aies_delegate", input: { role: "verify", task: "verify" } },
      1_000_100,
      root,
    );
    parent = applyToolResult(parent, { content: "### Verify Result: FAIL", isError: false }, 1_000_900);

    assert.equal(parent.tools.calls, 1);
    assert.equal(parent.tools.callsByName.aies_delegate, 1);
    assert.equal(parent.exploration.sourceReads, 0);
    assert.equal(parent.exploration.searches, 0);
    assert.equal(parent.exploration.shellInspections, 0);
    assert.equal(parent.exploration.filesInspected.length, 0);
  });
});

describe("AIES-010B Verify protocol hardening: completion semantics", () => {
  const CRITERIA = ["TIMEOUT_MS is 2000", "npm test passes"];

  function completion(overrides = {}) {
    return {
      status: "pass",
      summary: "Inspected config.js and ran the checks.",
      criteria: [
        { criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1 shows 2000" },
        { criterion: "npm test passes", status: "pass", evidence: "npm test exit 0" },
      ],
      checks: [{ check: "npm test", result: "exit 0" }],
      defects: [],
      next: [],
      ...overrides,
    };
  }

  it("accepts a complete, evidenced PASS and the FAIL/BLOCKED shapes", () => {
    assert.equal(validateVerifyCompletion(completion(), CRITERIA).ok, true);
    assert.equal(
      validateVerifyCompletion(
        { status: "fail", summary: "still 1000", criteria: [], checks: [], defects: [{ severity: "blocking", description: "wrong value" }], next: [] },
        CRITERIA,
      ).ok,
      true,
    );
    assert.equal(
      validateVerifyCompletion(
        { status: "blocked", summary: "pytest is not installed", criteria: [], checks: [], defects: [], next: [] },
        CRITERIA,
      ).ok,
      true,
    );
  });

  it("rejects a PASS that has no evidence anywhere", () => {
    const result = validateVerifyCompletion(
      completion({ criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }], checks: [] }),
      [],
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /evidence/u);
  });

  it("rejects a PASS that also carries a blocking defect", () => {
    const result = validateVerifyCompletion(
      completion({ defects: [{ severity: "blocking", description: "contradiction" }] }),
      CRITERIA,
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /blocking/u);
  });

  it("rejects a PASS that does not represent and pass every supplied criterion", () => {
    const missing = validateVerifyCompletion(
      completion({ criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1" }] }),
      CRITERIA,
    );
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /npm test passes/u);

    const failing = validateVerifyCompletion(
      completion({
        criteria: [
          { criterion: "TIMEOUT_MS is 2000", status: "fail", evidence: "config.js:1 shows 1500" },
          { criterion: "npm test passes", status: "pass", evidence: "exit 0" },
        ],
      }),
      CRITERIA,
    );
    assert.equal(failing.ok, false);
    assert.match(failing.reason, /not passing/u);
  });

  it("rejects an unknown status rather than coercing it", () => {
    assert.equal(validateVerifyCompletion(completion({ status: "maybe" }), CRITERIA).ok, false);
    assert.equal(validateVerifyCompletion(completion({ summary: "  " }), CRITERIA).ok, false);
  });

  it("never lets one broad or narrow criterion cover two required criteria", () => {
    const result = validateVerifyCompletion(
      completion({ criteria: [{ criterion: "login works", status: "pass", evidence: "auth.ts:10" }] }),
      ["login works", "admin login works"],
    );
    assert.equal(result.ok, false, "a single entry must not satisfy two required criteria");
    assert.match(result.reason, /admin login works/u);
  });

  it("consumes each completion criterion at most once", () => {
    const result = validateVerifyCompletion(
      completion({
        criteria: [
          { criterion: "login works", status: "pass", evidence: "run 1" },
          { criterion: "admin login works", status: "pass" },
        ],
      }),
      ["login works", "login works"],
    );
    assert.equal(result.ok, false, "the same entry cannot satisfy a repeated criterion twice");
  });

  it("rejects a PASS where a required criterion has no evidence of its own", () => {
    const result = validateVerifyCompletion(
      completion({
        criteria: [
          { criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1 shows 2000" },
          { criterion: "npm test passes", status: "pass" },
        ],
        checks: [{ check: "npm test", result: "exit 0" }],
      }),
      CRITERIA,
    );
    assert.equal(result.ok, false, "evidence elsewhere must not cover an unevidenced criterion");
    assert.match(result.reason, /evidence/u);
  });
});

describe("AIES-010B Verify protocol hardening: completion capture", () => {
  const CRITERIA = ["TIMEOUT_MS is 2000", "npm test passes"];

  function completion(overrides = {}) {
    return {
      status: "pass",
      summary: "Inspected config.js and ran the checks.",
      criteria: [
        { criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1 shows 2000" },
        { criterion: "npm test passes", status: "pass", evidence: "npm test exit 0" },
      ],
      checks: [{ check: "npm test", result: "exit 0" }],
      defects: [],
      next: [],
      ...overrides,
    };
  }

  async function runScenario(dir, responses) {
    const { faux, runtime, model } = await fauxRuntime();
    const sessionManager = SessionManager.inMemory(dir);
    faux.setResponses(responses);
    const result = await runVerifyAgent({
      task: "Bring the timeout to 2000",
      criteria: CRITERIA,
      changedPaths: ["config.js"],
      cwd: dir,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      sessionManager,
    });
    return { result, sessionManager };
  }

  it("captures a valid PASS even when the final prose is malformed", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, completion(), "c2")]),
        fauxAssistantMessage([{ type: "text", text: "done!! not json { broken" }]),
      ]);

      assert.equal(isProtocolError(result), false);
      assert.equal(result.kind, "verdict");
      assert.equal(result.status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a captured FAIL even when later prose claims PASS", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 1500;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            completion({
              status: "fail",
              summary: "The artifact is still 1500.",
              criteria: [
                { criterion: "TIMEOUT_MS is 2000", status: "fail", evidence: "config.js:1 shows 1500" },
                { criterion: "npm test passes", status: "pass", evidence: "exit 0" },
              ],
              defects: [{ severity: "blocking", file: "config.js", description: "TIMEOUT_MS is 1500, expected 2000" }],
            }),
            "c2",
          ),
        ]),
        fauxAssistantMessage([{ type: "text", text: JSON.stringify(completion()) }]),
      ]);

      assert.equal(result.status, "fail", "a later prose PASS must never promote a captured FAIL");
      assert.equal(result.defects[0].file, "config.js");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on a duplicate valid completion", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, completion(), "c2")]),
        fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, completion({ status: "fail", defects: [{ severity: "blocking", description: "second opinion" }] }), "c3")]),
      ]);

      assert.equal(isProtocolError(result), true);
      assert.equal(result.code, "duplicate_completion");
      assert.equal(result.status, undefined, "a duplicate must never promote a verdict");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets one latter valid call correct an earlier invalid attempt in the same turn", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        // Invalid: PASS without evidence.
        fauxAssistantMessage([
          fauxToolCall(VERIFY_COMPLETE_TOOL, completion({ criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }], checks: [] }), "c2"),
        ]),
        fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, completion(), "c3")]),
      ]);

      assert.equal(isProtocolError(result), false);
      assert.equal(result.status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns invalid_completion when only an invalid attempt arrives", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        fauxAssistantMessage([
          fauxToolCall(VERIFY_COMPLETE_TOOL, completion({ criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }], checks: [] }), "c2"),
        ]),
        fauxAssistantMessage([{ type: "text", text: "that should have worked" }]),
      ]);

      assert.equal(isProtocolError(result), true);
      assert.equal(result.code, "invalid_completion");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps the exact EZE-422 pattern to protocol_error, not PASS/FAIL/BLOCKED", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        // Substantive free-form PASS claim with no valid structured completion.
        fauxAssistantMessage([
          {
            type: "text",
            text: "I inspected config.js and ran npm test. Everything passes; the criteria are satisfied. PASS.",
          },
        ]),
      ]);

      assert.equal(isProtocolError(result), true, "free-form prose must never be a verdict");
      assert.equal(result.code, "missing_completion");
      assert.equal(result.status, undefined);

      const state = applyVerifyResult(applyVerifyStart(createVerificationState(), 0), result, 1000);
      assert.equal(state.status, "protocol_error");
      assert.equal(state.attempts, 1, "start counted exactly one attempt");
      assert.equal(state.repairs, 0, "a protocol error spends zero repair budget");
      assert.equal(state.verifiedRevision, undefined);
      assert.equal(state.awaitingVerification, true);
      assert.equal(isVerificationValid(state), false);

      const decision = planVerification(state);
      assert.equal(decision.action, "stop", "a protocol error never triggers a Worker repair or a rerun");
      assert.equal(decision.repair, 0);
      assert.match(decision.reason, /protocol/iu);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a fully valid legacy JSON handoff when the completion tool was never called", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        // A perfectly valid old-style handoff in the final prose: still not a verdict,
        // because the completion tool is the only runtime authority.
        fauxAssistantMessage([
          {
            type: "text",
            text: verifyHandoffJson({
              criteria: [
                { criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1 shows 2000" },
                { criterion: "npm test passes", status: "pass", evidence: "npm test exit 0" },
              ],
            }),
          },
        ]),
      ]);

      assert.equal(isProtocolError(result), true, "final prose JSON is never a verdict");
      assert.equal(result.code, "missing_completion");
      assert.equal(result.status, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("maps a session failure to protocol_error, never a domain BLOCKED", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([fauxAssistantMessage([{ type: "text", text: "never reached" }])]);
      const controller = new AbortController();
      controller.abort();

      const result = await runVerifyAgent({
        task: "Bring the timeout to 2000",
        criteria: CRITERIA,
        changedPaths: ["config.js"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        signal: controller.signal,
      });

      assert.equal(isProtocolError(result), true);
      assert.equal(result.code, "session_failure");
      assert.equal(result.status, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a captured PASS when the provider continuation fails afterwards", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      const sessionManager = SessionManager.inMemory(dir);
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, completion(), "c2")]),
        () => {
          throw new Error("provider continuation failed");
        },
      ]);

      const result = await runVerifyAgent({
        task: "Bring the timeout to 2000",
        criteria: CRITERIA,
        changedPaths: ["config.js"],
        cwd: dir,
        agentDir: REPO_ROOT,
        modelRuntime: runtime,
        model,
        sessionManager,
      });

      assert.equal(isProtocolError(result), false, "a captured verdict survives a failing continuation");
      assert.equal(result.kind, "verdict");
      assert.equal(result.status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a valid domain BLOCKED a domain BLOCKED", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("bash", { command: "pytest" }, "c1")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            completion({
              status: "blocked",
              summary: "pytest is not installed, so the criterion cannot be exercised.",
              criteria: [{ criterion: "npm test passes", status: "blocked", evidence: "command not found" }],
              checks: [{ check: "pytest", result: "exit 127" }],
            }),
            "c2",
          ),
        ]),
      ]);

      assert.equal(isProtocolError(result), false);
      assert.equal(result.status, "blocked");
      assert.equal(planVerification(applyVerifyResult(applyVerifyStart(createVerificationState(), 0), result, 0)).action, "stop");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never exposes an edit or write tool to the completion child", async () => {
    assert.equal(VERIFY_COMPLETE_TOOL, "aies_verify_complete");
    assert.equal(VERIFY_TOOLS.includes("edit"), false);
    assert.equal(VERIFY_TOOLS.includes("write"), false);
  });

  it("surfaces an EZE-422 protocol fault through aies_delegate as a visible error", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "d1")]),
        fauxAssistantMessage([{ type: "text", text: "Everything passes. The criteria are satisfied. PASS." }]),
      ]);

      const tool = createDelegateTool();
      const result = await tool.execute(
        "call-1",
        { role: "verify", task: "Verify the timeout", criteria: ["TIMEOUT_MS is 2000"] },
        undefined,
        undefined,
        { cwd: dir, model, modelRuntime: runtime },
      );

      assert.equal(result.isError, true, "a protocol fault must be visible as an error");
      assert.equal(result.details.kind, "protocol_error");
      // The unit harness has no child model runtime, so the child session fails; the
      // fault is still a protocol error and never a domain status.
      assert.ok(
        ["missing_completion", "session_failure"].includes(result.details.code),
        `unexpected protocol code: ${result.details.code}`,
      );
      assert.equal(result.details.status, undefined, "a protocol error must not fake a domain status");
      assert.equal(result.details.verification.status, "protocol_error");
      assert.equal(result.details.verification.repairs, 0, "a protocol fault spends no repair budget");
      const text = result.content.map((block) => block.text ?? "").join("\n");
      assert.match(text, /error de protocolo/u);
      assert.equal(text.includes("Verify Result: BLOCKED"), false, text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EZE-438 Verify protocol hardening: eliminate completion loops and distinguish protocol failure", () => {
  const CRITERIA = ["TIMEOUT_MS is 2000", "npm test passes"];

  function validPassCompletion(overrides = {}) {
    return {
      status: "pass",
      summary: "Inspected config.js and ran npm test successfully.",
      criteria: [
        { criterion: "TIMEOUT_MS is 2000", status: "pass", evidence: "config.js:1 shows 2000" },
        { criterion: "npm test passes", status: "pass", evidence: "npm test exit 0" },
      ],
      checks: [{ check: "npm test", result: "exit 0" }],
      defects: [],
      next: [],
      ...overrides,
    };
  }

  async function runScenario(dir, responses, criteria = CRITERIA) {
    const { faux, runtime, model } = await fauxRuntime();
    const sessionManager = SessionManager.inMemory(dir);
    faux.setResponses(responses);
    const result = await runVerifyAgent({
      task: "Bring the timeout to 2000",
      criteria,
      changedPaths: ["config.js"],
      cwd: dir,
      agentDir: REPO_ROOT,
      modelRuntime: runtime,
      model,
      sessionManager,
    });
    return { result, sessionManager };
  }

  it("completes a valid PASS exactly once", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, validPassCompletion(), "c2")]),
      ]);

      assert.equal(isProtocolError(result), false);
      assert.equal(result.kind, "verdict");
      assert.equal(result.status, "pass");
      assert.equal(result.criteria.length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes a genuine semantic BLOCKED from a protocol error", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("bash", { command: "pytest" }, "c1")]),
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            {
              status: "blocked",
              summary: "pytest is not installed on the system, preventing verification.",
              criteria: [{ criterion: "npm test passes", status: "blocked", evidence: "pytest exit 127" }],
              checks: [{ check: "pytest", result: "exit 127: command not found" }],
              defects: [],
              next: ["Install pytest in the test environment"],
            },
            "c2",
          ),
        ]),
      ]);

      assert.equal(isProtocolError(result), false, "a genuine external blocker must remain a verdict");
      assert.equal(result.kind, "verdict");
      assert.equal(result.status, "blocked");
      assert.equal(result.summary.includes("pytest"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("notifies single recovery budget on malformed completion", async () => {
    const collector = createVerifyCompletionCollector();
    const tool = createVerifyCompleteTool({ criteria: CRITERIA, collector });

    const malformed = validPassCompletion({
      criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }],
      checks: [],
    });

    const execution = await tool.execute("call-1", malformed);
    assert.equal(execution.isError, true);
    assert.equal(collector.invalidAttempts, 1);
    assert.match(execution.content[0].text, /1 recovery attempt/u);
    assert.equal(execution.details.remainingRecoveries, 0);
  });

  it("allows exactly one controlled recovery from a malformed completion", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        // Attempt 1: malformed (PASS without evidence)
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            validPassCompletion({
              criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }],
              checks: [],
            }),
            "c2",
          ),
        ]),
        // Attempt 2: corrected valid PASS
        fauxAssistantMessage([fauxToolCall(VERIFY_COMPLETE_TOOL, validPassCompletion(), "c3")]),
      ]);

      assert.equal(isProtocolError(result), false, "single recovery must succeed with a valid PASS");
      assert.equal(result.kind, "verdict");
      assert.equal(result.status, "pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails explicitly without loop on second malformed/protocol failure", async () => {
    const dir = fixtureDir({ "config.js": "export const TIMEOUT_MS = 2000;\n" });
    try {
      const { result } = await runScenario(dir, [
        fauxAssistantMessage([fauxToolCall("read", { path: "config.js" }, "c1")]),
        // Attempt 1: malformed (PASS without evidence)
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            validPassCompletion({
              criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }],
              checks: [],
            }),
            "c2",
          ),
        ]),
        // Attempt 2: second malformed (PASS carrying a blocking defect)
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            validPassCompletion({
              defects: [{ severity: "blocking", description: "broken" }],
            }),
            "c3",
          ),
        ]),
      ]);

      assert.equal(isProtocolError(result), true, "second malformed must be a protocol failure");
      assert.equal(result.code, "invalid_completion");
      assert.equal(result.status, undefined, "must never be coerced to BLOCKED");
      assert.match(result.message, /blocking/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("immediately rejects third attempt after exhausted recovery budget", async () => {
    const collector = createVerifyCompletionCollector();
    const tool = createVerifyCompleteTool({ criteria: CRITERIA, collector });

    const malformed = validPassCompletion({
      criteria: [{ criterion: "TIMEOUT_MS is 2000", status: "pass" }],
      checks: [],
    });

    // Attempt 1
    const res1 = await tool.execute("call-1", malformed);
    assert.equal(res1.isError, true);
    assert.equal(collector.invalidAttempts, 1);
    assert.match(res1.content[0].text, /1 recovery attempt/u);

    // Attempt 2 (exhausts recovery budget)
    const res2 = await tool.execute("call-2", malformed);
    assert.equal(res2.isError, true);
    assert.equal(collector.invalidAttempts, 2);
    assert.match(res2.content[0].text, /Recovery budget exhausted/u);

    // Attempt 3: immediately rejected as exhausted without checking validity
    const res3 = await tool.execute("call-3", validPassCompletion());
    assert.equal(res3.isError, true);
    assert.equal(res3.details.reason, "exhausted_recovery_attempts");
    assert.match(res3.content[0].text, /already failed after exhausted recovery/u);
    assert.equal(collector.verdict, undefined, "verdict must not be recorded after budget exhaustion");
  });

  it("refuses to convert a validator or completion rejection into semantic BLOCKED", async () => {
    const validation = validateVerifyCompletion(
      {
        status: "blocked",
        summary: "The aies_verify_complete validator rejected every attempt at PASS.",
        criteria: [{ criterion: "npm test passes", status: "blocked" }],
        checks: [],
        defects: [{ severity: "blocking", description: "(validator-side, not a repo defect) The validator rejected PASS" }],
        next: [],
      },
      CRITERIA,
    );

    assert.equal(validation.ok, false, "validator blame must not be accepted as semantic BLOCKED");
    assert.match(validation.reason, /protocol error, not a semantic BLOCKED/u);
  });

  it("reproduces and resolves the EZE-426 real-smoke case without rejection or loop", async () => {
    const dir = fixtureDir({ "src/truncate.js": 'export function truncate(t, m) { return t.length > m ? t.slice(0, m) + "…" : t; }\n' });
    try {
      const smokeCriteria =
        '1. `src/truncate.js` contiene lógica de truncado real. 2. `truncate("abcdef", 3)` === "abc…". 3. `truncate("ab", 5)` === "ab". 4. `npm test` exit 0 y ambos tests pasan. 5. Sólo `src/truncate.js` modificado. 6. Implementación minimal.';

      const { result } = await runScenario(
        dir,
        [
          fauxAssistantMessage([fauxToolCall("read", { path: "src/truncate.js" }, "c1")]),
          fauxAssistantMessage([
            fauxToolCall(
              VERIFY_COMPLETE_TOOL,
              {
                status: "pass",
                summary: "All 6 criteria verified on working tree.",
                criteria: [
                  { criterion: "1. `src/truncate.js` contiene lógica de truncado real.", status: "pass", evidence: "body has real logic" },
                  { criterion: '2. `truncate("abcdef", 3)` === "abc…"', status: "pass", evidence: "returns abc…" },
                  { criterion: '3. `truncate("ab", 5)` === "ab"', status: "pass", evidence: "returns ab" },
                  { criterion: "4. `npm test` exit 0 y ambos tests pasan.", status: "pass", evidence: "tests passed" },
                  { criterion: "5. Sólo `src/truncate.js` modificado.", status: "pass", evidence: "git diff confirms 1 file" },
                  { criterion: "6. Implementación minimal.", status: "pass", evidence: "2 lines of logic" },
                ],
                checks: [{ check: "npm test", result: "exit 0" }],
                defects: [],
                next: [],
              },
              "c2",
            ),
          ]),
        ],
        smokeCriteria,
      );

      assert.equal(isProtocolError(result), false, "smoke criteria must be parsed and matched cleanly");
      assert.equal(result.kind, "verdict");
      assert.equal(result.status, "pass");
      assert.equal(result.criteria.length, 6, "all 6 criteria must be represented");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("EZE-471: does not launch another identical Verify after an infrastructure BLOCKED without changed conditions", async () => {
    const dir = fixtureDir({ "src/app.js": "export const app = 1;\n" });
    try {
      const { faux, runtime, model } = await fauxRuntime();
      let vState = createVerificationState();
      const store = {
        get: () => vState,
        set: (next) => {
          vState = next;
        },
      };

      const tool = createDelegateTool({ verification: store });

      // 1. Initial Verify ends in BLOCKED due to an infrastructure cause (e.g. EPERM on generated path)
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            {
              status: "blocked",
              summary: "EPERM al acceder/escribir .astro/content.d.ts",
              criteria: [{ criterion: "npm run check passes", status: "blocked", evidence: "EPERM sandbox denial" }],
              checks: [{ check: "npm run check", result: "EPERM: operation not permitted" }],
              defects: [{ severity: "blocking", description: "infrastructure blocked by EPERM" }],
              next: [],
            },
            "c1",
          ),
        ]),
      ]);

      const res1 = await tool.execute(
        "call-1",
        { role: "verify", task: "Verify app", criteria: ["npm run check passes"] },
        undefined,
        undefined,
        { cwd: dir, model, modelRegistry: runtime },
      );

      assert.equal(vState.status, "blocked");
      assert.equal(vState.blockedRevision, 0);
      assert.match(vState.blockedReason ?? "", /EPERM/);

      // 2. Parent attempts to run Verify again at the same revision without changed conditions
      let secondAgentRan = false;
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("read", { path: "src/app.js" }, "unexpected-call"),
        ]),
      ]);

      const res2 = await tool.execute(
        "call-2",
        { role: "verify", task: "Verify app", criteria: ["npm run check passes"] },
        undefined,
        undefined,
        { cwd: dir, model, modelRegistry: runtime },
      );

      assert.equal(res2.isError, true, "Second identical verify must be rejected");
      assert.equal(res2.details.error, "verification_blocked_conditions_unchanged");
      assert.match(res2.content[0].text, /Verify request rejected:/);
      assert.match(res2.content[0].text, /already ended in BLOCKED at revision 0/);
      assert.match(res2.content[0].text, /Conditions have not changed/);

      // 3. Worker makes a code change, advancing revision and resetting status
      store.set(applyWorkerResult(vState, ["src/app.js"]));
      assert.equal(vState.status, "none");
      assert.equal(vState.revision, 1);
      assert.equal(vState.blockedRevision, undefined);

      // 4. Verify is now allowed to run on the new revision
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall(
            VERIFY_COMPLETE_TOOL,
            {
              status: "pass",
              summary: "All checks passed on revision 1",
              criteria: [{ criterion: "npm run check passes", status: "pass", evidence: "exit 0" }],
              checks: [{ check: "npm run check", result: "passed" }],
              defects: [],
              next: [],
            },
            "c2",
          ),
        ]),
      ]);

      const res3 = await tool.execute(
        "call-3",
        { role: "verify", task: "Verify app", criteria: ["npm run check passes"] },
        undefined,
        undefined,
        { cwd: dir, model, modelRegistry: runtime },
      );

      assert.equal(res3.isError, undefined, "Verify must run cleanly after conditions change");
      assert.equal(vState.status, "pass");
      assert.equal(vState.verifiedRevision, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
