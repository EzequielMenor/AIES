// src/model-runtime.test.ts — tests de parseModelRef + resolveRoleModels (sin red).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import {
	getAiesAuthPath,
	isRole,
	parseModelRef,
	resolveRoleModels,
	resetAiesModelRuntimeCache,
	ROLES,
	type AiesModelRuntimeLike,
} from "./model-runtime.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	resetAiesModelRuntimeCache();
});

describe("getAiesAuthPath", () => {
	it("default: ~/.config/aies/auth.json", () => {
		delete process.env.AIES_AUTH;
		assert.match(getAiesAuthPath(), /\.config\/aies\/auth\.json$/);
	});

	it("override: AIES_AUTH gana", () => {
		process.env.AIES_AUTH = "/tmp/aies-test-auth.json";
		assert.equal(getAiesAuthPath(), "/tmp/aies-test-auth.json");
	});
});

describe("parseModelRef", () => {
	it("sin slash → provider por defecto", () => {
		const r = parseModelRef("MiniMax-M2.7", "minimax");
		assert.deepEqual(r, { provider: "minimax", modelId: "MiniMax-M2.7" });
	});

	it("con slash → split por el primer slash", () => {
		const r = parseModelRef("anthropic/claude-opus-4-5", "minimax");
		assert.deepEqual(r, { provider: "anthropic", modelId: "claude-opus-4-5" });
	});

	it("múltiples slashes → sólo el primero separa (model-id conserva el resto)", () => {
		const r = parseModelRef("openrouter/foo/bar", "minimax");
		assert.deepEqual(r, { provider: "openrouter", modelId: "foo/bar" });
	});

	it("provider vacío tras split → error", () => {
		assert.throws(() => parseModelRef("/claude", "minimax"), /provider vacío/);
	});

	it("model-id vacío tras split → error", () => {
		assert.throws(() => parseModelRef("anthropic/", "minimax"), /model-id vacío/);
	});

	it("ref vacío → error", () => {
		assert.throws(() => parseModelRef("   ", "minimax"), /vacía/);
	});

	it("trim de espacios y lowercase del provider", () => {
		const r = parseModelRef("  Anthropic/Claude-3 ", "minimax");
		assert.deepEqual(r, { provider: "anthropic", modelId: "Claude-3" });
	});
});

describe("isRole + ROLES", () => {
	it("lista canónica", () => {
		assert.deepEqual([...ROLES], ["orchestrator", "explorer", "implementer", "verifier"]);
	});

	it("acepta roles conocidos", () => {
		assert.ok(isRole("orchestrator"));
		assert.ok(isRole("verifier"));
	});

	it("rechaza desconocidos", () => {
		assert.equal(isRole("narrator"), false);
		assert.equal(isRole(""), false);
	});
});

function fakeModel(provider: string, modelId: string): { provider: string; id: string } {
	return { provider, id: modelId };
}

function fakeRuntime(catalog: Record<string, { id: string }[]>, auth: string[] = []): AiesModelRuntimeLike {
	return {
		getProviders: () => Object.keys(catalog).map((id) => ({ id })),
		getModels: (providerId?: string) =>
			(providerId ? catalog[providerId] ?? [] : Object.values(catalog).flat()).map((m) => fakeModel(m.provider ?? providerId ?? "?", m.id) as never),
		getModel: (providerId, modelId) => {
			const found = (catalog[providerId] ?? []).find((m) => m.id === modelId);
			return (found ? fakeModel(providerId, found.id) : undefined) as never;
		},
		hasConfiguredAuth: (providerId) => auth.includes(providerId),
	};
}

describe("resolveRoleModels", () => {
	it("refs sin prefijo usan provider global", () => {
		const runtime = fakeRuntime({ minimax: [{ id: "M2.7" }] });
		const out = resolveRoleModels({ provider: "minimax", models: { orchestrator: "M2.7" } }, runtime);
		assert.equal(out.orchestrator?.id, "M2.7");
		assert.equal(out.warnings.length, 0);
	});

	it("refs con provider/model-id explícito", () => {
		const runtime = fakeRuntime({
			anthropic: [{ id: "claude-opus-4-5" }],
			minimax: [{ id: "M2.7" }],
		});
		const out = resolveRoleModels(
			{ provider: "minimax", models: { orchestrator: "anthropic/claude-opus-4-5", verifier: "minimax/M2.7" } },
			runtime,
		);
		assert.equal(out.orchestrator?.id, "claude-opus-4-5");
		assert.equal(out.verifier?.id, "M2.7");
	});

	it("modelo inexistente → warning + undefined (no crash)", () => {
		const runtime = fakeRuntime({ minimax: [{ id: "M2.7" }] });
		const out = resolveRoleModels({ provider: "minimax", models: { orchestrator: "no-existe" } }, runtime);
		assert.equal(out.orchestrator, undefined);
		assert.equal(out.warnings.length, 1);
		assert.match(out.warnings[0]!, /orchestrator: modelo "no-existe" no encontrado/);
	});

	it("rol no definido en config → undefined silencioso", () => {
		const runtime = fakeRuntime({ minimax: [{ id: "M2.7" }] });
		const out = resolveRoleModels({ provider: "minimax", models: {} }, runtime);
		assert.equal(out.orchestrator, undefined);
		assert.equal(out.warnings.length, 0);
	});
});