import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { findModelAcrossProviders, resolveRoleModels, roleModelLabel, type AiesModelRuntimeLike } from "./model-runtime.js";

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

describe("resolveRoleModels — model-per-role estricto", () => {
	const rt = () =>
		mockRuntime(
			[
				{ id: "minimax", models: [{ id: "MiniMax-M2.7" }] },
				{ id: "qwen-token-plan-cn", models: [{ id: "qwen3.8-flash" }, { id: "qwen3-max" }] },
				{ id: "anthropic", models: [{ id: "claude-opus-4-5" }] },
			],
			["minimax", "qwen-token-plan-cn"], // anthropic NO autenticado
		);

	it("resuelve cada rol con su propio modelo cross-provider", () => {
		const r = resolveRoleModels(
			rt(),
			{
				provider: "minimax",
				models: {
					orchestrator: "qwen-token-plan-cn/qwen3-max",
					implementer: "minimax/MiniMax-M2.7",
					explorer: "qwen-token-plan-cn/qwen3.8-flash",
					verifier: "qwen-token-plan-cn/qwen3.8-flash",
				},
			},
			{},
		);
		assert.equal(r.failures.length, 0);
		assert.equal(r.models.orchestrator?.provider, "qwen-token-plan-cn");
		assert.equal(r.models.implementer?.provider, "minimax");
		assert.equal(r.models.explorer?.id, "qwen3.8-flash");
	});

	it("NO hace fallback silencioso: modelo inexistente de rol explícito es un fallo accionable", () => {
		const r = resolveRoleModels(rt(), { provider: "minimax", models: { implementer: "minimax/no-existe" } }, {});
		// orchestrator no tiene default → hereda undefined; implementer falla de forma explícita.
		const f = r.failures.find((x) => x.role === "implementer");
		assert.ok(f);
		assert.equal(f!.reason, "model_not_found");
		assert.match(f!.message, /implementer/);
		assert.match(f!.message, /minimax/);
		assert.match(f!.message, /no-existe/);
	});

	it("sin auth en el provider de un rol explícito es un fallo no_auth con login sugerido", () => {
		const r = resolveRoleModels(rt(), { provider: "minimax", models: { verifier: "anthropic/claude-opus-4-5" } }, { envHint: () => "ANTHROPIC_API_KEY" });
		const f = r.failures.find((x) => x.role === "verifier");
		assert.ok(f);
		assert.equal(f!.reason, "no_auth");
		assert.match(f!.message, /aies login anthropic/);
		assert.match(f!.message, /ANTHROPIC_API_KEY/);
	});

	it("provider desconocido es un fallo unknown_provider", () => {
		const r = resolveRoleModels(rt(), { provider: "minimax", models: { explorer: "bogus/modelo" } }, {});
		assert.equal(r.failures[0]?.reason, "unknown_provider");
	});

	it("roles SIN elección explícita heredan el default del orchestrator", () => {
		const r = resolveRoleModels(rt(), { provider: "minimax", models: { orchestrator: "minimax/MiniMax-M2.7" } }, {});
		assert.equal(r.failures.length, 0);
		assert.equal(r.models.implementer?.id, "MiniMax-M2.7");
		assert.equal(r.models.explorer?.id, "MiniMax-M2.7");
		assert.equal(r.models.verifier?.id, "MiniMax-M2.7");
	});

	it("AIES_MODEL (overrideRef) fuerza todos los roles como elección explícita", () => {
		const r = resolveRoleModels(rt(), { provider: "minimax", models: { orchestrator: "minimax/MiniMax-M2.7" } }, { overrideRef: "qwen-token-plan-cn/qwen3.8-flash" });
		assert.equal(r.failures.length, 0);
		for (const role of ["orchestrator", "explorer", "implementer", "verifier"] as const) {
			assert.equal(r.models[role]?.id, "qwen3.8-flash");
		}
	});

	it("roleModelLabel devuelve provider/model o undefined", () => {
		assert.equal(roleModelLabel({ provider: "minimax", id: "x" } as never), "minimax/x");
		assert.equal(roleModelLabel(undefined), undefined);
	});
});
