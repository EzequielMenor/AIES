/**
 * EZE-487 child provider label regression.
 *
 * The defect: with Verify configured as `qwen-token-plan/qwen3.8-max` and the
 * Parent running on `commandcode` — two distinct providers exposing the SAME
 * model id (`qwen3.8-max`) and the SAME display (`Qwen3.8 Max`) — the delegation
 * routed correctly (child ran on `qwen-token-plan`) but `/agents` showed the
 * Parent's provider display label. Root cause: `delegate.ts` resolved the
 * provider display label from `ctx.model` (the PARENT model) and the runners
 * forwarded it into the observatory, where a caller-supplied label wins over the
 * child's real `providerId`.
 *
 * These tests pin the real runtime surface end-to-end:
 * 1. `resolveVerifyModel` returns the child provider/model pair (routing intact).
 * 2. The child session receives `model.provider` / `model.id` of the child.
 * 3. The observatory record carries the child pair, id AND display label
 *    together, while the parent runs on a different provider.
 * 4. Switching Verify between the two providers changes providerId and
 *    providerLabel together.
 * 5. `/agents` and the right rail render the child's labels; the rail keeps the
 *    parent's snapshot model when no delegation is active.
 * 6. A new/resumed session with an empty registry never resurrects the previous
 *    child's provider metadata.
 * 7. `providerDisplayLabel(modelRuntime, providerId)` derives the label from the
 *    child provider id and degrades to `null` (never a parent label).
 *
 * No credentials, no real profile: `PI_CODING_AGENT_DIR` is redirected to a
 * temporary directory for the delegate end-to-end run.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

import * as modelModule from "../extensions/aies-agents/model.ts";
import { createDelegateTool } from "../extensions/aies-agents/delegate.ts";
import { runExploreAgent } from "../extensions/aies-agents/explore.ts";
import { resolveVerifyModel } from "../extensions/aies-agents/model.ts";
import { AgentObservatory, observatory } from "../extensions/aies-agents/observatory.ts";
import { runVerifyAgent, VERIFY_COMPLETE_TOOL } from "../extensions/aies-agents/verify.ts";
import { runWorkerAgent } from "../extensions/aies-agents/worker.ts";
import {
  applyAgents,
  applyDelegationStart,
  applyModel,
  createState,
  toSnapshot,
} from "../extensions/aies-runtime/state.ts";
import { renderAgentsView } from "../extensions/aies-ui/agents.ts";
import { PLAIN_PAINT } from "../extensions/aies-ui/paint.ts";
import { renderRightRail } from "../extensions/aies-ui/right-rail.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const T0 = 1_700_000_000_000;

/** The two providers of the defect: same model id, same display, different ids. */
const CHILD_PROVIDER = "qwen-token-plan";
const CHILD_DISPLAY = "Qwen Token Plan";
const PARENT_PROVIDER = "commandcode";
const PARENT_DISPLAY = "Command Code";
const SHARED_MODEL_ID = "qwen3.8-max";
const SHARED_MODEL_LABEL = "Qwen3.8 Max";

const DISPLAY_NAMES = { [CHILD_PROVIDER]: CHILD_DISPLAY, [PARENT_PROVIDER]: PARENT_DISPLAY };

/** One faux provider exposing the shared `qwen3.8-max` model under `providerId`. */
function sharedModelFaux(providerId) {
  return fauxProvider({ provider: providerId, models: [{ id: SHARED_MODEL_ID, name: SHARED_MODEL_LABEL }] });
}

/**
 * A fake extension `ModelRegistry` facade: both providers expose the SAME model
 * id and display, resolution goes through `find(provider, modelId)` exactly like
 * Pi's facade, and the child-session seam (getRegisteredNativeProvider) hands
 * the real faux provider to the isolated child runtime.
 */
function fauxRegistryFacade(fauxes) {
  const models = fauxes.flatMap((faux) => [...faux.models]);
  return {
    find(provider, modelId) {
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    getAll() {
      return models;
    },
    getAvailable() {
      return models;
    },
    getProviderDisplayName(provider) {
      return DISPLAY_NAMES[provider] ?? provider;
    },
    getRegisteredProviderConfig() {
      return undefined;
    },
    getRegisteredNativeProvider(provider) {
      return fauxes.find((faux) => faux.provider.id === provider)?.provider;
    },
  };
}

function tempAgentDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "aies-eze487-"));
  writeFileSync(join(dir, "aies.json"), JSON.stringify(config));
  return dir;
}

function verifyPassSteps(onModel) {
  return [
    (context, options, state, model) => {
      onModel?.(model);
      return fauxAssistantMessage([
        fauxToolCall(
          VERIFY_COMPLETE_TOOL,
          {
            status: "pass",
            summary: "Inspected the artifact.",
            criteria: [{ index: 1, criterion: "c", status: "pass", evidence: "file.js:1 shows 2000" }],
            checks: [],
            defects: [],
            next: [],
          },
          "c1",
        ),
      ]);
    },
    fauxAssistantMessage([{ type: "text", text: "done" }]),
  ];
}

function exploreHandoffStep(onModel) {
  return (context, options, state, model) => {
    onModel?.(model);
    return fauxAssistantMessage([
      {
        type: "text",
        text: `\`\`\`json
${JSON.stringify(
  {
    status: "done",
    summary: "Investigated the artifact.",
    evidence: [{ file: "extensions/aies-agents/session.ts" }],
    issues: [],
    next: [],
  },
  null,
  2,
)}
\`\`\``,
      },
    ]);
  };
}

function workerHandoffStep() {
  return fauxAssistantMessage([
    {
      type: "text",
      text: `\`\`\`json
${JSON.stringify(
  {
    status: "done",
    summary: "Implemented the work unit.",
    changes: [{ file: "a.ts" }],
    checks: [{ check: "npm test", result: "ok" }],
    issues: [],
    next: [],
  },
  null,
  2,
)}
\`\`\``,
    },
  ]);
}

/** A full `AgentRecord` as the observatory would freeze it. */
function agentRecord(overrides = {}) {
  return {
    id: "verify-1",
    role: "verify",
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

function railSnapshotOf(state) {
  return { ...toSnapshot(state), agents: state.agents };
}

describe("EZE-487 child provider pair resolution", () => {
  it("resolves qwen-token-plan/qwen3.8-max to the qwen-token-plan provider", async () => {
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);
    const dir = tempAgentDir({ agents: { verify: { model: `${CHILD_PROVIDER}/${SHARED_MODEL_ID}` } } });

    try {
      const model = await resolveVerifyModel(registry, parentFaux.models[0], dir);
      assert.equal(model.provider, CHILD_PROVIDER);
      assert.equal(model.id, SHARED_MODEL_ID);
      assert.equal(model.name, SHARED_MODEL_LABEL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves commandcode/qwen3.8-max to the commandcode provider", async () => {
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);
    const dir = tempAgentDir({ agents: { verify: { model: `${PARENT_PROVIDER}/${SHARED_MODEL_ID}` } } });

    try {
      const model = await resolveVerifyModel(registry, parentFaux.models[0], dir);
      assert.equal(model.provider, PARENT_PROVIDER);
      assert.equal(model.id, SHARED_MODEL_ID);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the child session receives the resolved child model (provider and id)", async () => {
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);
    let seenChildModel;
    childFaux.setResponses(verifyPassSteps((model) => {
      seenChildModel = model;
    }));

    const dir = tempAgentDir({ agents: { verify: { model: `${CHILD_PROVIDER}/${SHARED_MODEL_ID}` } } });
    const obs = new AgentObservatory();
    try {
      const result = await runVerifyAgent({
        task: "Verify the timeout change",
        criteria: ["c"],
        cwd: REPO_ROOT,
        agentDir: dir,
        modelRuntime: registry,
        parentModel: parentFaux.models[0],
        observatory: obs,
      });

      assert.equal(result.status, "pass");
      assert.ok(seenChildModel, "the child session streamed through the resolved model");
      assert.equal(seenChildModel.provider, CHILD_PROVIDER);
      assert.equal(seenChildModel.id, SHARED_MODEL_ID);

      const [record] = obs.snapshot();
      assert.equal(record.providerId, CHILD_PROVIDER);
      assert.equal(record.modelId, SHARED_MODEL_ID);
      assert.equal(record.modelLabel, SHARED_MODEL_LABEL);
      // EZE-487: the display label must derive from the CHILD provider id.
      assert.equal(record.providerLabel, CHILD_DISPLAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("delegate verify pairs the child provider id with the child display label while the parent runs on commandcode", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);
    let seenChildModel;
    childFaux.setResponses(verifyPassSteps((model) => {
      seenChildModel = model;
    }));

    const dir = tempAgentDir({ agents: { verify: { model: `${CHILD_PROVIDER}/${SHARED_MODEL_ID}` } } });
    process.env.PI_CODING_AGENT_DIR = dir;
    observatory.reset();

    try {
      const tool = createDelegateTool();
      const result = await tool.execute(
        "call-1",
        { role: "verify", task: "Verify the timeout change", criteria: ["c"] },
        undefined,
        undefined,
        { cwd: REPO_ROOT, model: parentFaux.models[0], modelRegistry: registry },
      );

      assert.equal(result.details.status, "pass");

      // The child really ran on qwen-token-plan/qwen3.8-max.
      assert.equal(seenChildModel.provider, CHILD_PROVIDER);
      assert.equal(seenChildModel.id, SHARED_MODEL_ID);

      const [record] = observatory.snapshot();
      assert.equal(record.role, "verify");
      assert.equal(record.providerId, CHILD_PROVIDER, "child provider id");
      assert.equal(record.modelId, SHARED_MODEL_ID, "child model id");
      assert.equal(record.modelLabel, SHARED_MODEL_LABEL, "child model label");
      // RED today: delegate.ts resolves the label from ctx.model (the PARENT)
      // and the observatory lets the caller label win over the child providerId,
      // so this reads "Command Code" while providerId stays "qwen-token-plan".
      assert.equal(record.providerLabel, CHILD_DISPLAY, "child provider label");
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      observatory.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a caller-passed parent label and derives the pair from the child provider", async () => {
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);
    childFaux.setResponses(verifyPassSteps());

    const dir = tempAgentDir({ agents: { verify: { model: `${CHILD_PROVIDER}/${SHARED_MODEL_ID}` } } });
    const obs = new AgentObservatory();
    try {
      // A legacy caller still forwarding the parent's label must not pollute the
      // record: after EZE-487 the option does not exist and the label derives
      // from the child provider id.
      await runVerifyAgent({
        task: "Verify the timeout change",
        criteria: ["c"],
        cwd: REPO_ROOT,
        agentDir: dir,
        modelRuntime: registry,
        parentModel: parentFaux.models[0],
        observatory: obs,
        providerLabel: PARENT_DISPLAY,
      });

      const [record] = obs.snapshot();
      assert.equal(record.providerId, CHILD_PROVIDER);
      assert.equal(record.providerLabel, CHILD_DISPLAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the explore runner labels the child provider, not the parent", async () => {
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);
    childFaux.setResponses([exploreHandoffStep()]);

    const dir = tempAgentDir({ agents: { explore: { model: `${CHILD_PROVIDER}/${SHARED_MODEL_ID}` } } });
    const obs = new AgentObservatory();
    try {
      const handoff = await runExploreAgent({
        task: "Map the provider label path",
        cwd: REPO_ROOT,
        agentDir: dir,
        modelRuntime: registry,
        parentModel: parentFaux.models[0],
        observatory: obs,
      });

      assert.equal(handoff.status, "done");
      const [record] = obs.snapshot();
      assert.equal(record.providerId, CHILD_PROVIDER);
      assert.equal(record.modelId, SHARED_MODEL_ID);
      assert.equal(record.modelLabel, SHARED_MODEL_LABEL);
      assert.equal(record.providerLabel, CHILD_DISPLAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the worker runner labels the child provider, not the parent", async () => {
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);
    childFaux.setResponses([workerHandoffStep()]);

    const dir = tempAgentDir({ agents: { worker: { model: `${CHILD_PROVIDER}/${SHARED_MODEL_ID}` } } });
    const obs = new AgentObservatory();
    try {
      const handoff = await runWorkerAgent({
        task: "Implement the provider label fix",
        cwd: REPO_ROOT,
        agentDir: dir,
        modelRuntime: registry,
        parentModel: parentFaux.models[0],
        observatory: obs,
      });

      assert.equal(handoff.status, "done");
      const [record] = obs.snapshot();
      assert.equal(record.providerId, CHILD_PROVIDER);
      assert.equal(record.providerLabel, CHILD_DISPLAY);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("switching Verify between providers with the same model id moves providerId and providerLabel together", async () => {
    const childFaux = sharedModelFaux(CHILD_PROVIDER);
    const parentFaux = sharedModelFaux(PARENT_PROVIDER);
    const registry = fauxRegistryFacade([childFaux, parentFaux]);

    const dirA = tempAgentDir({ agents: { verify: { model: `${CHILD_PROVIDER}/${SHARED_MODEL_ID}` } } });
    const dirB = tempAgentDir({ agents: { verify: { model: `${PARENT_PROVIDER}/${SHARED_MODEL_ID}` } } });
    try {
      childFaux.setResponses(verifyPassSteps());
      const obsA = new AgentObservatory();
      await runVerifyAgent({
        task: "Verify with qwen-token-plan",
        criteria: ["c"],
        cwd: REPO_ROOT,
        agentDir: dirA,
        modelRuntime: registry,
        parentModel: parentFaux.models[0],
        observatory: obsA,
      });
      const recordA = obsA.snapshot()[0];

      parentFaux.setResponses(verifyPassSteps());
      const obsB = new AgentObservatory();
      await runVerifyAgent({
        task: "Verify with commandcode",
        criteria: ["c"],
        cwd: REPO_ROOT,
        agentDir: dirB,
        modelRuntime: registry,
        parentModel: parentFaux.models[0],
        observatory: obsB,
      });
      const recordB = obsB.snapshot()[0];

      // Same model id and same model display on both runs; the provider pair
      // must change together (EZE-487: id and label never disagree).
      assert.equal(recordA.modelId, recordB.modelId);
      assert.equal(recordA.modelLabel, recordB.modelLabel);
      assert.equal(recordA.providerId, CHILD_PROVIDER);
      assert.equal(recordA.providerLabel, CHILD_DISPLAY);
      assert.equal(recordB.providerId, PARENT_PROVIDER);
      assert.equal(recordB.providerLabel, PARENT_DISPLAY);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("providerDisplayLabel derives the label from the given provider id and degrades to null", () => {
    const { providerDisplayLabel } = modelModule;
    assert.equal(typeof providerDisplayLabel, "function", "model.ts exports providerDisplayLabel");

    const registry = { getProviderDisplayName: (provider) => DISPLAY_NAMES[provider] ?? provider };
    assert.equal(providerDisplayLabel(registry, CHILD_PROVIDER), CHILD_DISPLAY);
    assert.equal(providerDisplayLabel(registry, PARENT_PROVIDER), PARENT_DISPLAY);

    // Padded labels are trimmed; empties degrade to null.
    assert.equal(providerDisplayLabel({ getProviderDisplayName: () => `  ${CHILD_DISPLAY}  ` }, CHILD_PROVIDER), CHILD_DISPLAY);
    assert.equal(providerDisplayLabel({ getProviderDisplayName: () => "   " }, CHILD_PROVIDER), null);

    // Absent runtime, absent provider id or a throwing runtime never throw: null.
    assert.equal(providerDisplayLabel(undefined, CHILD_PROVIDER), null);
    assert.equal(providerDisplayLabel(registry, null), null);
    assert.equal(
      providerDisplayLabel(
        {
          getProviderDisplayName() {
            throw new Error("registry exploded");
          },
        },
        CHILD_PROVIDER,
      ),
      null,
    );
  });
});

describe("EZE-487 UI renders the child pair", () => {
  it("/agents shows the child provider label and never the parent's", () => {
    const record = agentRecord({
      id: "verify-1",
      role: "verify",
      modelId: SHARED_MODEL_ID,
      modelLabel: SHARED_MODEL_LABEL,
      providerId: CHILD_PROVIDER,
      providerLabel: CHILD_DISPLAY,
    });

    const text = renderAgentsView([record], 0, T0 + 5_000, { width: 100 }).join("\n");
    assert.match(text, /modelo\s+Qwen3\.8 Max/u);
    assert.match(text, /proveedor\s+Qwen Token Plan/u);
    assert.equal(text.includes(PARENT_DISPLAY), false);
  });

  it("the right rail reports the child metadata while a verify delegation is active", () => {
    let state = createState(T0);
    state = applyModel(state, { id: SHARED_MODEL_ID, provider: PARENT_PROVIDER, name: SHARED_MODEL_LABEL });
    state = applyDelegationStart(state, "verify", T0);
    state = applyAgents(state, [
      agentRecord({
        modelId: SHARED_MODEL_ID,
        modelLabel: SHARED_MODEL_LABEL,
        providerId: CHILD_PROVIDER,
        providerLabel: CHILD_DISPLAY,
      }),
    ]);

    const text = renderRightRail(railSnapshotOf(state), T0 + 5_000, {
      width: 46,
      paint: PLAIN_PAINT,
    }).join("\n");

    // EZE-487: during an active delegation the rail must show the CHILD's real
    // metadata. Today it reads snapshot.model (the parent), so this is RED.
    assert.match(text, /Proveedor\s+Qwen Token Plan/u, text);
    assert.match(text, /Modelo\s+Qwen3\.8 Max/u, text);
  });

  it("the right rail keeps the parent snapshot model with no active delegation", () => {
    let state = createState(T0);
    state = applyModel(state, { id: "other-model", provider: PARENT_PROVIDER, name: "Parent Model" });

    const text = renderRightRail(railSnapshotOf(state), T0 + 1_000, { width: 46, paint: PLAIN_PAINT }).join("\n");
    assert.match(text, /Modelo\s+Parent Model/u, text);
    assert.match(text, /Proveedor\s+commandcode/u, text);
  });

  it("a new session with an empty registry never resurrects the previous child provider", () => {
    let state = createState(T0);
    state = applyModel(state, { id: SHARED_MODEL_ID, provider: PARENT_PROVIDER, name: SHARED_MODEL_LABEL });
    state = applyDelegationStart(state, "verify", T0);
    state = applyAgents(state, [
      agentRecord({ providerId: CHILD_PROVIDER, providerLabel: CHILD_DISPLAY, modelLabel: SHARED_MODEL_LABEL }),
    ]);

    // Session boundary: an empty registry is applied on resume/new.
    state = applyAgents(state, []);
    state = { ...state, delegations: { ...state.delegations, activeRole: undefined } };

    const snapshot = railSnapshotOf(state);
    assert.deepEqual(snapshot.agents, [], "the finished child is not resurrected");

    const text = renderRightRail(snapshot, T0 + 60_000, { width: 46, paint: PLAIN_PAINT }).join("\n");
    assert.equal(text.includes(CHILD_DISPLAY), false, text);
    assert.match(text, /Proveedor\s+commandcode/u, text);
  });
});
