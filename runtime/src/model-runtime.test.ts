import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { findModelAcrossProviders, type AiesModelRuntimeLike } from "./model-runtime.js";

function mockRuntime(providers: Array<{ id: string; models: Array<{ id: string }> }>, authed: string[]): AiesModelRuntimeLike {
	return {
		getProviders: () => providers.map((p) => ({ id: p.id })),
		getModels: (id?: string) => {
			if (id) {
				const p = providers.find((pp) => pp.id === id);
				if (!p) return [];
				return p.models.map((m) => ({ provider: p.id, id: m.id, name: m.id, contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0 }, reasoning: false }) as never);
			}
			return providers.flatMap((p) => p.models.map((m) => ({ provider: p.id, id: m.id, name: m.id, contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0 }, reasoning: false }) as never));
		},
		getModel: (id, mid) => {
			const p = providers.find((pp) => pp.id === id);
			const m = p?.models.find((mm) => mm.id === mid);
			if (!p || !m) return undefined;
			return { provider: p.id, id: m.id, name: m.id, contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0 }, reasoning: false } as never;
		},
		hasConfiguredAuth: (id) => authed.includes(id),
	};
}

describe("findModelAcrossProviders — fase 7", () => {
	it("encuentra modelo por id exacto, cross-provider", () => {
		const rt = mockRuntime(
			[
				{ id: "minimax", models: [{ id: "MiniMax-M2.7" }] },
				{ id: "openai-codex", models: [{ id: "gpt-5.4-mini" }, { id: "gpt-5.4" }] },
			],
			["minimax", "openai-codex"],
		);
		const m = findModelAcrossProviders(rt, "gpt-5.4-mini");
		assert.ok(m);
		assert.equal(m!.provider, "openai-codex");
		assert.equal(m!.id, "gpt-5.4-mini");
	});

	it("ignora providers sin auth", () => {
		const rt = mockRuntime(
			[
				{ id: "minimax", models: [{ id: "MiniMax-M2.7" }] },
				{ id: "openai-codex", models: [{ id: "gpt-5.4-mini" }] },
			],
			["minimax"], // openai-codex NO autenticado
		);
		const m = findModelAcrossProviders(rt, "gpt-5.4-mini");
		assert.equal(m, null);
	});

	it("matchea por substring cuando no hay exacto", () => {
		const rt = mockRuntime(
			[
				{ id: "anthropic", models: [{ id: "claude-4-5-sonnet" }] },
				{ id: "openai-codex", models: [{ id: "gpt-5.4-mini" }] },
			],
			["anthropic", "openai-codex"],
		);
		const m = findModelAcrossProviders(rt, "sonnet");
		assert.ok(m);
		assert.equal(m!.id, "claude-4-5-sonnet");
	});

	it("si existen varias coincidencias, devuelve la primera por orden alfabético de provider", () => {
		const rt = mockRuntime(
			[
				{ id: "alpha", models: [{ id: "x" }] },
				{ id: "beta", models: [{ id: "x" }] },
				{ id: "gamma", models: [{ id: "x" }] },
			],
			["alpha", "beta", "gamma"],
		);
		const m = findModelAcrossProviders(rt, "x");
		assert.ok(m);
		assert.equal(m!.provider, "alpha");
	});

	it("devuelve null cuando nada coincide", () => {
		const rt = mockRuntime([{ id: "minimax", models: [{ id: "MiniMax-M2.7" }] }], ["minimax"]);
		assert.equal(findModelAcrossProviders(rt, "nope"), null);
	});

	it("exact match tiene prioridad sobre substring", () => {
		const rt = mockRuntime(
			[
				{ id: "a", models: [{ id: "foo-bar" }] },
				{ id: "b", models: [{ id: "foo" }] },
			],
			["a", "b"],
		);
		const m = findModelAcrossProviders(rt, "foo");
		assert.ok(m);
		assert.equal(m!.provider, "b");
		assert.equal(m!.id, "foo");
	});
});
