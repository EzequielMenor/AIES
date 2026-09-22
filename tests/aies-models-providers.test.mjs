/**
 * EZE-453 / T2 + T10: `/aies-models` provider sections, scoping and the
 * provider step.
 *
 * Everything here is offline and profile-free: the Pi registry is a fake
 * object, credential health is plain data and no command, model call or network
 * request ever runs. The point of the suite is the policy split — a provider is
 * selectable only when it is connected **and** its credential was not rejected —
 * plus the bounded rendering of everything that is not selectable, and the
 * Pi-style `all`/`scoped` restriction added by T10.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { credentialFingerprint } from "../extensions/aies-providers/health.ts";
import { projectModelOption } from "../extensions/aies-models/capabilities.ts";
import { projectProviders } from "../extensions/aies-models/providers.ts";
import {
  createOverlayState,
  reduceOverlayKey,
  renderOverlayState,
} from "../extensions/aies-models/overlay.ts";
import { renderHeadlessModels } from "../extensions/aies-models/headless.ts";
import { overlayPreferredWidth } from "../extensions/aies-models/index.ts";

/** A short, obviously fake secret used only to build fingerprints. */
const SECRET = "sk-ant-super-secret-value";

/** One raw registry model. */
function model(provider, id, extra = {}) {
  return { provider, id, name: extra.name ?? id, reasoning: extra.reasoning ?? false, ...extra };
}

/** `count` models for one provider, named after their index. */
function modelsFor(provider, count, prefix = "m") {
  return Array.from({ length: count }, (_value, index) =>
    model(provider, `${prefix}${index}`, { name: `${provider} ${index}` }),
  );
}

/** A fake registry with every public method the projection reads. */
function registry({ all = [], available = [], registered = [], auth = {}, names = {} } = {}) {
  return {
    getAll: () => all,
    getAvailable: () => available,
    getProviderAuthStatus: (id) => auth[id] ?? { configured: false },
    getRegisteredProviderIds: () => registered,
    getProviderDisplayName: (id) => names[id] ?? id,
  };
}

/** One applying rejection record for a provider. */
function record(provider, secret = SECRET, extra = {}) {
  return {
    provider,
    fingerprint: credentialFingerprint(secret),
    status: 401,
    reason: "authentication_error",
    observedAt: 1_700_000_000_000,
    ...extra,
  };
}

/** Project a single raw model into a `ModelOption` for overlay fixtures. */
function option(provider, id, extra = {}) {
  const projected = projectModelOption(model(provider, id, extra));
  assert.ok(projected, "projectModelOption must project a valid model");
  return projected;
}

/** A hand-built usable section for the overlay fixtures. */
function section(id, models, overrides = {}) {
  return {
    id,
    name: overrides.name ?? id,
    state: "usable",
    models,
    totalModels: models.length,
    ...overrides,
  };
}

/** A hand-built `OverlayContext` in the T10 shape. */
function contextFor({ usable = [], scopedUsable, hasScoped = false, notUsable, assignments = [] } = {}) {
  return {
    usable,
    scopedUsable: scopedUsable ?? usable,
    hasScoped,
    notUsable: notUsable ?? { count: 0, names: [], extra: 0 },
    assignments,
  };
}

/** The full, empty projection the guarded registry paths must produce. */
function emptyProjection() {
  return {
    usable: [],
    scopedUsable: [],
    hasScoped: false,
    models: [],
    attention: [],
    hiddenDisconnected: 0,
    notUsable: { count: 0, names: [], extra: 0 },
  };
}

describe("provider projection", () => {
  it("shows a registered but unconfigured provider as disconnected, never selectable", () => {
    const all = modelsFor("commandcode", 76);
    const projection = projectProviders({
      registry: registry({ all, registered: ["commandcode"] }),
      health: {},
      fingerprints: {},
    });

    assert.deepEqual(projection.usable, []);
    assert.deepEqual(projection.models, []);
    assert.equal(projection.attention.length, 1);
    assert.equal(projection.attention[0].id, "commandcode");
    assert.equal(projection.attention[0].stateLabel, "no conectado");
    assert.equal(projection.attention[0].detail, "0/76");
    assert.equal(projection.attention[0].hint, "/login commandcode");
    assert.equal(projection.hiddenDisconnected, 0);
  });

  it("shows a configured registered provider as usable with all its models", () => {
    const all = modelsFor("commandcode", 76);
    const projection = projectProviders({
      registry: registry({
        all,
        available: all,
        registered: ["commandcode"],
        auth: { commandcode: { configured: true, source: "stored" } },
        names: { commandcode: "CommandCode" },
      }),
      health: {},
      fingerprints: {},
    });

    assert.equal(projection.usable.length, 1);
    assert.equal(projection.usable[0].id, "commandcode");
    assert.equal(projection.usable[0].name, "CommandCode");
    assert.equal(projection.usable[0].state, "usable");
    assert.equal(projection.usable[0].models.length, 76);
    assert.equal(projection.usable[0].totalModels, 76);
    assert.equal(projection.models.length, 76);
    assert.deepEqual(projection.attention, []);
    assert.equal(projection.hiddenDisconnected, 0);
  });

  it("suppresses a provider whose stored rejection matches the current credential", () => {
    const all = modelsFor("anthropic", 14);
    const projection = projectProviders({
      registry: registry({ all, available: all, names: { anthropic: "Anthropic" } }),
      health: { anthropic: record("anthropic") },
      fingerprints: { anthropic: credentialFingerprint(SECRET) },
    });

    assert.deepEqual(projection.usable, []);
    assert.deepEqual(projection.models, [], "a rejected provider contributes zero selectable models");
    assert.equal(projection.attention.length, 1);
    assert.equal(projection.attention[0].id, "anthropic");
    assert.equal(projection.attention[0].stateLabel, "credencial rechazada");
    assert.equal(projection.attention[0].detail, "HTTP 401 · authentication_error");
    assert.equal(projection.attention[0].hint, "/login anthropic");
  });

  it("fails open and self-heals when the credential changed", () => {
    const all = modelsFor("anthropic", 14);
    const projection = projectProviders({
      registry: registry({ all, available: all }),
      health: { anthropic: record("anthropic") },
      fingerprints: { anthropic: credentialFingerprint("a-new-and-different-secret") },
    });

    assert.equal(projection.usable.length, 1);
    assert.equal(projection.usable[0].id, "anthropic");
    assert.equal(projection.models.length, 14);
    assert.deepEqual(projection.attention, []);
  });

  it("fails open when no fingerprint could be resolved", () => {
    const all = modelsFor("anthropic", 14);
    const projection = projectProviders({
      registry: registry({ all, available: all }),
      health: { anthropic: record("anthropic") },
      fingerprints: {},
    });

    assert.equal(projection.usable.length, 1);
    assert.equal(projection.models.length, 14);
    assert.deepEqual(projection.attention, []);
  });

  it("enumerates only the extension-registered disconnected providers", () => {
    const all = Array.from({ length: 41 }, (_value, index) => model(`vendor${index}`, "only"));
    const projection = projectProviders({
      registry: registry({ all, registered: ["vendor7"] }),
      health: {},
      fingerprints: {},
    });

    assert.equal(projection.hiddenDisconnected, 40, "every other disconnected vendor is only counted");
    assert.equal(projection.attention.length, 1);
    assert.equal(projection.attention[0].id, "vendor7");
  });

  it("honours the maxAttention cap", () => {
    const all = [model("a", "m"), model("b", "m"), model("c", "m")];
    const projection = projectProviders({
      registry: registry({ all }),
      health: { a: record("a", "s1"), b: record("b", "s2"), c: record("c", "s3") },
      fingerprints: {
        a: credentialFingerprint("s1"),
        b: credentialFingerprint("s2"),
        c: credentialFingerprint("s3"),
      },
      maxAttention: 2,
    });

    assert.equal(projection.attention.length, 2);
    assert.deepEqual(projection.attention.map((row) => row.id), ["a", "b"]);
  });

  it("reports a configured provider with zero available models as empty", () => {
    const all = [model("empty", "m0")];
    const projection = projectProviders({
      registry: registry({ all, registered: ["empty"], auth: { empty: { configured: true } } }),
      health: {},
      fingerprints: {},
    });

    assert.deepEqual(projection.usable, []);
    assert.equal(projection.attention.length, 1);
    assert.equal(projection.attention[0].stateLabel, "sin modelos disponibles");
    assert.equal(projection.attention[0].hint, undefined);
    assert.equal(projection.attention[0].detail, undefined);
  });

  it("keeps a provider that only appears in getAvailable usable", () => {
    const projection = projectProviders({
      registry: registry({ available: [model("solo", "only", { name: "Solo" })] }),
      health: {},
      fingerprints: {},
    });

    assert.equal(projection.usable.length, 1);
    assert.equal(projection.usable[0].id, "solo");
    assert.equal(projection.models.length, 1);
  });

  it("sorts usable providers by display name then id, and the flat list follows that order", () => {
    const all = [model("b", "m"), model("a", "m"), model("c", "m")];
    const projection = projectProviders({
      registry: registry({
        all,
        available: all,
        names: { a: "Zeta", b: "Alpha", c: "Alpha" },
      }),
      health: {},
      fingerprints: {},
    });

    assert.deepEqual(projection.usable.map((entry) => entry.id), ["b", "c", "a"]);
    assert.deepEqual(projection.models.map((entry) => entry.provider), ["b", "c", "a"]);
  });

  it("degrades to an empty projection for a registry that throws on every method", () => {
    const hostile = {
      getAll() {
        throw new Error("boom");
      },
      getAvailable() {
        throw new Error("boom");
      },
      getProviderAuthStatus() {
        throw new Error("boom");
      },
      getRegisteredProviderIds() {
        throw new Error("boom");
      },
      getProviderDisplayName() {
        throw new Error("boom");
      },
    };

    assert.deepEqual(projectProviders({ registry: hostile, health: {}, fingerprints: {} }), emptyProjection());
  });

  it("degrades to an empty projection for a registry missing its methods", () => {
    assert.deepEqual(projectProviders({ registry: {}, health: {}, fingerprints: {} }), emptyProjection());
    assert.deepEqual(projectProviders({ registry: undefined, health: {}, fingerprints: {} }), emptyProjection());
    assert.deepEqual(
      projectProviders({
        registry: { getAll: () => "not an array", getAvailable: () => 42, getRegisteredProviderIds: () => null },
        health: {},
        fingerprints: {},
      }),
      emptyProjection(),
    );
  });

  it("dedupes duplicate models by provider/id", () => {
    const duplicate = model("faux", "m0", { name: "Faux" });
    const projection = projectProviders({
      registry: registry({
        all: [duplicate, { ...duplicate }, model("faux", "m1")],
        available: [duplicate, { ...duplicate }, model("faux", "m1")],
      }),
      health: {},
      fingerprints: {},
    });

    assert.equal(projection.usable[0].totalModels, 2);
    assert.equal(projection.usable[0].models.length, 2);
    assert.equal(projection.models.length, 2);
  });

  it("bounds every rendered detail, hint and state label", () => {
    const long = "x".repeat(300);
    const rejected = projectProviders({
      registry: registry({ all: [model("long", "m")] }),
      health: { long: record("long", SECRET, { reason: long }) },
      fingerprints: { long: credentialFingerprint(SECRET) },
    });
    const longId = "p".repeat(120);
    const disconnected = projectProviders({
      registry: registry({ all: [model(longId, "m")], registered: [longId] }),
      health: {},
      fingerprints: {},
    });

    for (const projection of [rejected, disconnected]) {
      for (const row of projection.attention) {
        assert.ok(row.stateLabel.length <= 32, `stateLabel too long: ${row.stateLabel.length}`);
        if (row.detail !== undefined) assert.ok(row.detail.length <= 48, `detail too long: ${row.detail.length}`);
        if (row.hint !== undefined) assert.ok(row.hint.length <= 40, `hint too long: ${row.hint.length}`);
      }
    }
    assert.equal(rejected.attention[0].detail.length <= 48, true);
    assert.equal(disconnected.attention[0].id, longId);
    assert.equal(disconnected.attention[0].detail, "0/1");
  });
});

describe("scoped projection", () => {
  const available = [
    model("alpha", "a1", { name: "A1" }),
    model("alpha", "a2", { name: "A2" }),
    model("beta", "b1", { name: "B1" }),
  ];

  /** A projection over two usable providers with an optional scoped set. */
  function project(scopedModels) {
    return projectProviders({
      registry: registry({ all: available, available }),
      health: {},
      fingerprints: {},
      scopedModels,
    });
  }

  it("reports hasScoped false and scoped equal to all when there is no scoping", () => {
    const projection = project(undefined);
    assert.equal(projection.hasScoped, false);
    assert.deepEqual(projection.scopedUsable, projection.usable);
    assert.notEqual(projection.scopedUsable, projection.usable, "a caller must never read the same array reference");
    assert.notEqual(projection.scopedUsable[0], projection.usable[0], "sections are copied, not aliased");
  });

  it("reports hasScoped true and restricts every section to the scoped models", () => {
    const projection = project([{ model: { provider: "alpha", id: "a1" } }]);
    assert.equal(projection.hasScoped, true);
    assert.deepEqual(projection.scopedUsable.map((entry) => entry.id), ["alpha"]);
    assert.deepEqual(projection.scopedUsable[0].models.map((entry) => entry.id), ["a1"]);
    assert.equal(projection.scopedUsable[0].totalModels, 2, "scoping is a view filter, not a catalogue change");
  });

  it("preserves the all-scope order and drops a section left with zero models", () => {
    const projection = project([{ model: { provider: "beta", id: "b1" } }]);
    assert.deepEqual(projection.usable.map((entry) => entry.id), ["alpha", "beta"]);
    assert.deepEqual(projection.scopedUsable.map((entry) => entry.id), ["beta"]);
  });

  it("keeps a scoped model that belongs to a section with more models", () => {
    const projection = project([{ model: { provider: "alpha", id: "a2" } }]);
    assert.deepEqual(projection.scopedUsable.map((entry) => entry.id), ["alpha"]);
    assert.deepEqual(projection.scopedUsable[0].models.map((entry) => entry.id), ["a2"]);
  });

  it("ignores a scoped model that is not available", () => {
    const projection = project([{ model: { provider: "alpha", id: "missing" } }]);
    assert.deepEqual(projection.scopedUsable, []);
    assert.equal(projection.hasScoped, true, "a non-empty but unusable scoped set still scopes");
  });

  it("degrades malformed scopedModels to no scoping", () => {
    const malformed = [
      "not an array",
      null,
      [],
      [null, 42, {}, "x"],
      [{ model: null }],
      [{ model: { provider: 1, id: "a1" } }],
      [{ model: { provider: "alpha" } }],
      [{ model: { id: "a1" } }],
      [{ notAModel: true }],
    ];
    for (const scopedModels of malformed) {
      const projection = project(scopedModels);
      assert.equal(projection.hasScoped, false, `hasScoped for ${JSON.stringify(scopedModels)}`);
      assert.deepEqual(projection.scopedUsable, projection.usable, `scoped for ${JSON.stringify(scopedModels)}`);
    }
  });
});

describe("not-usable summary", () => {
  it("counts rejected providers plus registered-but-unusable providers only", () => {
    const all = [
      ...modelsFor("anthropic", 3),
      ...modelsFor("mistral", 2),
      ...modelsFor("ghost", 1),
      model("commandcode", "m0"),
    ];
    const projection = projectProviders({
      registry: registry({ all, registered: ["commandcode"] }),
      health: {
        anthropic: record("anthropic"),
        mistral: record("mistral", "s2"),
      },
      fingerprints: {
        anthropic: credentialFingerprint(SECRET),
        mistral: credentialFingerprint("s2"),
      },
    });

    assert.equal(projection.notUsable.count, 3, "two rejected plus one registered disconnected");
    assert.deepEqual(projection.notUsable.names, ["anthropic (401)", "mistral (401)"]);
    assert.equal(projection.notUsable.extra, 1);
    assert.equal(projection.hiddenDisconnected, 1, "the unregistered ghost vendor is only hidden");
  });

  it("never counts the ~36 disconnected vendors that hiddenDisconnected covers", () => {
    const all = Array.from({ length: 41 }, (_value, index) => model(`vendor${index}`, "only"));
    const projection = projectProviders({
      registry: registry({ all, registered: ["vendor7"] }),
      health: {},
      fingerprints: {},
    });

    assert.equal(projection.hiddenDisconnected, 40);
    assert.equal(projection.notUsable.count, 1, "only the registered provider is counted");
    assert.deepEqual(projection.notUsable.names, ["vendor7"]);
    assert.equal(projection.notUsable.extra, 0);
  });

  it("orders rejected providers before disconnected ones and caps the names at two", () => {
    const all = [model("zeta", "m"), model("alpha", "m"), model("beta", "m"), model("gamma", "m")];
    const projection = projectProviders({
      registry: registry({ all, registered: ["gamma"] }),
      health: {
        zeta: record("zeta"),
        alpha: record("alpha", "s-alpha"),
        beta: record("beta", "s-beta"),
      },
      fingerprints: {
        zeta: credentialFingerprint(SECRET),
        alpha: credentialFingerprint("s-alpha"),
        beta: credentialFingerprint("s-beta"),
      },
    });

    assert.equal(projection.notUsable.count, 4);
    assert.deepEqual(projection.notUsable.names, ["alpha (401)", "beta (401)"]);
    assert.equal(projection.notUsable.extra, 2);
  });

  it("renders a rejected provider without a status as its bare id", () => {
    const projection = projectProviders({
      registry: registry({ all: [model("nostatus", "m")] }),
      health: { nostatus: record("nostatus", SECRET, { status: undefined }) },
      fingerprints: { nostatus: credentialFingerprint(SECRET) },
    });

    assert.deepEqual(projection.notUsable.names, ["nostatus"]);
    assert.equal(projection.notUsable.count, 1);
  });

  it("counts the untruncated set even when maxAttention hides rows", () => {
    const all = [model("a", "m"), model("b", "m"), model("c", "m")];
    const projection = projectProviders({
      registry: registry({ all }),
      health: { a: record("a", "s1"), b: record("b", "s2"), c: record("c", "s3") },
      fingerprints: {
        a: credentialFingerprint("s1"),
        b: credentialFingerprint("s2"),
        c: credentialFingerprint("s3"),
      },
      maxAttention: 1,
    });

    assert.equal(projection.attention.length, 1);
    assert.equal(projection.notUsable.count, 3);
    assert.deepEqual(projection.notUsable.names, ["a (401)", "b (401)"]);
    assert.equal(projection.notUsable.extra, 1);
  });
});

describe("overlay provider step", () => {
  const reasoningModels = [
    option("faux", "m1", { reasoning: true }),
    option("faux", "m2", { reasoning: true }),
  ];
  const twoProviders = contextFor({
    usable: [section("faux", reasoningModels), section("other", [option("other", "o1", { reasoning: true })])],
  });

  it("walks role -> provider -> model -> thinking -> done", () => {
    let state = createOverlayState();
    assert.equal(state.step, "role");

    state = reduceOverlayKey(state, "confirm", twoProviders);
    assert.equal(state.step, "provider");
    assert.equal(state.role, "parent");
    assert.equal(state.providerIndex, 0);

    state = reduceOverlayKey(state, "confirm", twoProviders);
    assert.equal(state.step, "model");
    assert.equal(state.modelIndex, 0);

    state = reduceOverlayKey(state, "down", twoProviders);
    assert.equal(state.modelIndex, 1);
    state = reduceOverlayKey(state, "confirm", twoProviders);
    assert.equal(state.step, "thinking");
    assert.equal(state.model.id, "m2");

    state = reduceOverlayKey(state, "confirm", twoProviders);
    assert.equal(state.step, "done");
    assert.equal(state.thinking, "off");
  });

  it("skips the thinking step only for a model that supports a single level", () => {
    const single = contextFor({ usable: [section("faux", [option("faux", "plain")])] });
    let state = reduceOverlayKey(createOverlayState(), "confirm", single);
    state = reduceOverlayKey(state, "confirm", single);
    state = reduceOverlayKey(state, "confirm", single);
    assert.equal(state.step, "done");
    assert.equal(state.model.id, "plain");
    assert.equal(state.thinking, "off");
  });

  it("unwinds one step at a time on escape and cancels from the role step", () => {
    let state = createOverlayState();
    for (let step = 0; step < 3; step += 1) state = reduceOverlayKey(state, "confirm", twoProviders);
    assert.equal(state.step, "thinking");

    state = reduceOverlayKey(state, "escape", twoProviders);
    assert.equal(state.step, "model");
    state = reduceOverlayKey(state, "escape", twoProviders);
    assert.equal(state.step, "provider");
    state = reduceOverlayKey(state, "escape", twoProviders);
    assert.equal(state.step, "role");
    state = reduceOverlayKey(state, "escape", twoProviders);
    assert.equal(state.cancelled, true);
  });

  it("leaves the state unchanged when confirming the provider step with no providers", () => {
    const empty = contextFor({ usable: [] });
    const providerState = reduceOverlayKey(createOverlayState(), "confirm", empty);
    assert.equal(providerState.step, "provider");

    const same = reduceOverlayKey(providerState, "confirm", empty);
    assert.equal(same, providerState, "no section at the index means the state is returned unchanged");
    assert.equal(same.step, "provider");
    assert.equal(same.cancelled, false);

    const backToRole = reduceOverlayKey(same, "escape", empty);
    assert.equal(backToRole.step, "role", "escape still leaves the empty provider step");
    assert.equal(reduceOverlayKey(backToRole, "escape", empty).cancelled, true);
    assert.equal(reduceOverlayKey(same, "q", empty).cancelled, true, "q still exits the empty provider step");
  });

  it("clamps the provider index at both ends", () => {
    let state = reduceOverlayKey(createOverlayState(), "confirm", twoProviders);
    state = reduceOverlayKey(state, "up", twoProviders);
    assert.equal(state.providerIndex, 0);
    state = reduceOverlayKey(state, "down", twoProviders);
    assert.equal(state.providerIndex, 1);
    state = reduceOverlayKey(state, "down", twoProviders);
    assert.equal(state.providerIndex, 1);
  });

  it("does nothing on left/right outside the thinking step", () => {
    const roleState = reduceOverlayKey(createOverlayState(), "right", twoProviders);
    assert.equal(roleState.step, "role");
    assert.equal(roleState.roleIndex, 0);

    const providerState = reduceOverlayKey(
      reduceOverlayKey(createOverlayState(), "confirm", twoProviders),
      "left",
      twoProviders,
    );
    assert.equal(providerState.step, "provider");
    assert.equal(providerState.providerIndex, 0);

    const modelState = reduceOverlayKey(
      reduceOverlayKey(providerState, "confirm", twoProviders),
      "right",
      twoProviders,
    );
    assert.equal(modelState.step, "model");
    assert.equal(modelState.modelIndex, 0);
  });
});

describe("overlay rendering with scoping and the summary line", () => {
  const oneModel = [option("faux", "m1", { reasoning: true })];
  const base = contextFor({
    usable: [section("faux", oneModel), section("other", [])],
    notUsable: { count: 2, names: ["anthropic (401)", "commandcode"], extra: 0 },
  });

  /** Reach a step by confirming from the role step. */
  function stateAt(step, context = base) {
    let state = createOverlayState({ hasScoped: context.hasScoped });
    if (step === "provider") return reduceOverlayKey(state, "confirm", context);
    if (step === "model") return reduceOverlayKey(reduceOverlayKey(state, "confirm", context), "confirm", context);
    if (step === "thinking") {
      state = reduceOverlayKey(state, "confirm", context);
      state = reduceOverlayKey(state, "confirm", context);
      return reduceOverlayKey(state, "confirm", context);
    }
    return state;
  }

  it("renders the provider step with the role in the title and one row per usable provider", () => {
    const view = renderOverlayState(stateAt("provider"), base);
    assert.equal(view.title, "Provider · Parent");
    assert.ok(view.lines.includes("› faux (1)"), view.lines.join("|"));
    assert.ok(view.lines.includes("  other (0)"), view.lines.join("|"));
  });

  it("renders the single not-usable summary only on the provider step", () => {
    const providerLines = renderOverlayState(stateAt("provider"), base).lines.join("\n");
    assert.ok(providerLines.includes("2 providers no utilizables · anthropic (401), commandcode"));
    assert.equal(providerLines.includes("✗"), false, "the overlay must not carry the detailed block");

    for (const step of ["role", "model", "thinking"]) {
      const lines = renderOverlayState(stateAt(step), base).lines.join("\n");
      assert.equal(lines.includes("no utilizables"), false, `${step} must not show the summary`);
      assert.equal(lines.includes("anthropic"), false, `${step} must not show provider names`);
    }
  });

  it("omits the summary line when nothing is unusable and uses the singular form at one", () => {
    const none = contextFor({ usable: [section("faux", oneModel)] });
    assert.equal(renderOverlayState(stateAt("provider", none), none).lines.join("\n").includes("no utilizabl"), false);

    const single = contextFor({
      usable: [section("faux", oneModel)],
      notUsable: { count: 1, names: ["llama.cpp"], extra: 0 },
    });
    const line = renderOverlayState(stateAt("provider", single), single).lines.find((entry) =>
      entry.includes("no utilizabl"),
    );
    assert.equal(line, "  1 provider no utilizable · llama.cpp");
  });

  it("appends +N when more providers are unusable than can be named", () => {
    const many = contextFor({
      usable: [section("faux", oneModel)],
      notUsable: { count: 4, names: ["anthropic (401)", "llama.cpp"], extra: 2 },
    });
    const line = renderOverlayState(stateAt("provider", many), many).lines.find((entry) =>
      entry.includes("no utilizabl"),
    );
    assert.equal(line, "  4 providers no utilizables · anthropic (401), llama.cpp +2");
  });

  it("renders the scope line only when there is a scoped set, with brackets on the active scope", () => {
    const withoutScope = contextFor({ usable: [section("faux", oneModel)] });
    assert.equal(renderOverlayState(stateAt("provider", withoutScope), withoutScope).lines.join("\n").includes("Scope:"), false);

    const scoped = contextFor({ usable: [section("faux", oneModel)], hasScoped: true });
    const initial = renderOverlayState(stateAt("provider", scoped), scoped);
    assert.ok(initial.lines.includes("  Scope: all [scoped]"), initial.lines.join("|"));

    const toggled = reduceOverlayKey(stateAt("provider", scoped), "scope", scoped);
    assert.ok(renderOverlayState(toggled, scoped).lines.includes("  Scope: [all] scoped"));
  });

  it("never marks a non-selectable line as selectable", () => {
    const context = contextFor({
      usable: [section("faux", oneModel), section("other", [])],
      hasScoped: true,
      notUsable: { count: 2, names: ["anthropic (401)", "commandcode"], extra: 0 },
    });
    const lines = renderOverlayState(stateAt("provider", context), context).lines;
    const selectable = new Set(lines.filter((line) => line.includes("faux (1)") || line.includes("other (0)")));
    for (const line of lines) {
      if (selectable.has(line)) continue;
      assert.equal(line.startsWith("›"), false, `non-selectable line must not carry the marker: ${line}`);
    }
    assert.ok([...selectable].some((line) => line.startsWith("›")), "the selected provider keeps the marker");
  });

  it("says there are no selectable models when a section is empty", () => {
    const emptySection = contextFor({ usable: [section("empty", [])] });
    let state = reduceOverlayKey(createOverlayState(), "confirm", emptySection);
    state = reduceOverlayKey(state, "confirm", emptySection);
    assert.equal(state.step, "model");
    const view = renderOverlayState(state, emptySection);
    assert.ok(view.lines.some((line) => line.includes("sin modelos seleccionables")));
  });

  it("says there are no usable providers when the active list is empty", () => {
    const none = contextFor({ usable: [] });
    const view = renderOverlayState(stateAt("provider", none), none);
    assert.ok(view.lines.some((line) => line.includes("sin providers utilizables")));
  });

  it("measures the provider step including the summary line", () => {
    const longNames = { count: 2, names: ["anthropic (401)", "l".repeat(60)], extra: 0 };
    const compact = contextFor({ usable: [section("faux", oneModel)] });
    const detailed = contextFor({ usable: [section("faux", oneModel)], notUsable: longNames });

    assert.ok(
      overlayPreferredWidth(detailed) > overlayPreferredWidth(compact),
      "a longer summary line must widen the provider frame",
    );
  });

  it("bounds every rendered line to 88 characters", () => {
    const longName = "P".repeat(300);
    const longModel = option("p", "m1", { name: "M".repeat(300) });
    const long = contextFor({
      usable: [section("p", [longModel], { name: longName })],
      notUsable: { count: 3, names: [longName, longName], extra: 1 },
    });

    for (const step of ["role", "provider", "model"]) {
      let state = createOverlayState({ hasScoped: long.hasScoped });
      if (step === "provider") state = reduceOverlayKey(state, "confirm", long);
      if (step === "model") state = reduceOverlayKey(reduceOverlayKey(state, "confirm", long), "confirm", long);
      for (const line of renderOverlayState(state, long).lines) {
        assert.ok(line.length <= 88, `line over 88 chars (${line.length}): ${line}`);
      }
    }
  });
});

describe("headless provider projection", () => {
  const commandcode = modelsFor("commandcode", 76);
  const minimax = [model("minimax", "m0", { name: "MiniMax" })];
  const projection = {
    usable: [
      { id: "commandcode", name: "CommandCode", state: "usable", models: commandcode, totalModels: 76 },
      { id: "minimax", name: "MiniMax", state: "usable", models: minimax, totalModels: 1 },
    ],
    models: [...commandcode, ...minimax],
    attention: [
      {
        id: "anthropic",
        stateLabel: "credencial rechazada",
        detail: "HTTP 401 · authentication_error",
        hint: "/login anthropic",
      },
      { id: "acme", stateLabel: "no conectado", detail: "0/12", hint: "/login acme" },
    ],
    hiddenDisconnected: 40,
  };

  it("prints the header, the role preferences and the usable providers", () => {
    const text = renderHeadlessModels({
      projection,
      preferences: { parent: { model: "minimax/m0", thinkingLevel: "high" } },
      maxLines: 40,
    });

    assert.match(text, /^Modelos AIES utilizables \(77\)/u);
    assert.match(text, /Parent · minimax\/m0 · high/u);
    assert.match(text, /Utilizables:/u);
    assert.match(text, /CommandCode \(76\)/u);
    assert.match(text, /MiniMax \(1\)/u);
  });

  it("prints the unusable block with markers, details, hints and the hidden count", () => {
    const text = renderHeadlessModels({ projection, preferences: {}, maxLines: 40 });
    assert.match(text, /No seleccionables:/u);
    assert.match(text, /✗ anthropic · credencial rechazada · HTTP 401 · authentication_error/u);
    assert.match(text, /○ acme · no conectado · 0\/12 → \/login acme/u);
    assert.match(text, /40 providers más sin conectar/u);
  });

  it("omits empty sections and says so when nothing is usable", () => {
    const empty = { usable: [], models: [], attention: [], hiddenDisconnected: 0 };
    const text = renderHeadlessModels({ projection: empty, preferences: {} });
    assert.match(text, /^Modelos AIES utilizables \(0\)/u);
    assert.match(text, /sin modelos utilizables/u);
    assert.match(text, /\/login/u);
    assert.equal(text.includes("Utilizables:"), false);
    assert.equal(text.includes("No seleccionables:"), false);
  });

  it("stays bounded by maxLines and maxChars", () => {
    const text = renderHeadlessModels({ projection, preferences: {}, maxLines: 10, maxChars: 400 });
    assert.ok(text.split("\n").length <= 10, `too many lines: ${text.split("\n").length}`);
    assert.ok(text.length <= 400, `too many chars: ${text.length}`);
  });
});

describe("headless bounding", () => {
  /** One usable provider section as the projection renders it. */
  function usableSection(index, modelCount = 1) {
    return {
      id: `p${index}`,
      name: `Provider ${String(index).padStart(2, "0")}`,
      state: "usable",
      models: modelsFor(`p${index}`, modelCount),
      totalModels: modelCount,
    };
  }

  /** One rejected attention row. */
  function rejected(id) {
    return {
      id,
      stateLabel: "credencial rechazada",
      detail: "HTTP 401 · authentication_error",
      hint: `/login ${id}`,
    };
  }

  /** One disconnected attention row. */
  function disconnected(id, total) {
    return { id, stateLabel: "no conectado", detail: `0/${total}`, hint: `/login ${id}` };
  }

  it("keeps the non-selectable block under the default bounds", () => {
    const regression = {
      usable: [usableSection(0, 10), usableSection(1, 20), usableSection(2, 30), usableSection(3, 38)],
      models: [],
      attention: [rejected("anthropic"), disconnected("commandcode", 76)],
      hiddenDisconnected: 36,
    };

    const text = renderHeadlessModels({ projection: regression, preferences: {} });

    assert.ok(text.includes("No seleccionables:"), `the block is missing:\n${text}`);
    assert.ok(text.includes("✗ anthropic · credencial rechazada · HTTP 401 · authentication_error"));
    assert.ok(text.includes("… 36 providers más sin conectar"), `the hidden summary is missing:\n${text}`);
    assert.ok(text.includes("Utilizables:"));
  });

  it("caps the usable rows at eight and still shows the whole non-selectable block", () => {
    const projection = {
      usable: Array.from({ length: 20 }, (_value, index) => usableSection(index)),
      models: [],
      attention: [
        rejected("a"),
        rejected("b"),
        disconnected("c", 1),
        disconnected("d", 2),
        disconnected("e", 3),
        disconnected("f", 4),
      ],
      hiddenDisconnected: 40,
    };

    const text = renderHeadlessModels({ projection, preferences: {} });
    const lines = text.split("\n");

    assert.ok(lines.length <= 32, `too many lines: ${lines.length}`);
    const usableRows = lines.filter((line) => /^ {2}Provider \d\d \(\d+\)$/u.test(line));
    assert.equal(usableRows.length, 8, `unexpected usable rows:\n${text}`);
    assert.equal(text.split("… y 12 providers utilizables más").length - 1, 1, "exactly one tail row");
    assert.ok(text.includes("No seleccionables:"));
    assert.ok(text.includes("… 40 providers más sin conectar"));
  });

  it("clips at the default maxChars and still truncates a small maxLines with an ellipsis", () => {
    const long = "x".repeat(400);
    const projection = {
      usable: Array.from({ length: 20 }, (_value, index) => ({
        id: `p${index}`,
        name: `${long}${index}`,
        state: "usable",
        models: modelsFor(`p${index}`, 1),
        totalModels: 1,
      })),
      models: [],
      attention: Array.from({ length: 6 }, (_value, index) => ({
        id: `${long}${index}`,
        stateLabel: "no conectado",
        detail: long,
        hint: `/login ${long}`,
      })),
      hiddenDisconnected: 40,
    };
    const preferences = {
      parent: { model: long },
      explore: { model: long },
      worker: { model: long },
      verify: { model: long },
    };

    const clipped = renderHeadlessModels({ projection, preferences });
    assert.equal(clipped.length, 3000, "the default maxChars must clip at 3000");
    assert.ok(clipped.endsWith("…"));

    const small = renderHeadlessModels({ projection, preferences, maxLines: 4 });
    assert.equal(small.split("\n").length, 4);
    assert.ok(small.endsWith("…"));
  });

  it("omits the non-selectable heading when there is nothing to report", () => {
    const projection = {
      usable: [usableSection(0, 5)],
      models: modelsFor("p0", 5),
      attention: [],
      hiddenDisconnected: 0,
    };

    const text = renderHeadlessModels({ projection, preferences: {} });
    assert.equal(text.includes("No seleccionables:"), false);
    assert.ok(text.includes("Utilizables:"));
  });

  it("keeps the no-usable message and the non-selectable block with zero usable providers", () => {
    const projection = {
      usable: [],
      models: [],
      attention: [rejected("anthropic")],
      hiddenDisconnected: 3,
    };

    const text = renderHeadlessModels({ projection, preferences: {} });
    assert.ok(text.includes("sin modelos utilizables"));
    assert.ok(text.includes("/login <provider>"));
    assert.ok(text.includes("No seleccionables:"));
    assert.ok(text.includes("✗ anthropic · credencial rechazada · HTTP 401 · authentication_error"));
    assert.ok(text.includes("… 3 providers más sin conectar"));
  });
});
