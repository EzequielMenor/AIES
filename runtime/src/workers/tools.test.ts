// src/workers/tools.test.ts — prueba del cableado model-per-role REAL: cada capability debe
// llegar a `createWorkerSession` con el modelo asignado a su rol (y fallback al del
// orquestador cuando no hay asignación explícita). La fábrica de sesiones se mockea: lo que
// se verifica aquí es la SELECCIÓN de modelo, no la sesión de pi.

import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	calls: [] as Array<{ capability: string; model: { provider: string; id: string } | undefined; modelRuntime: unknown }>,
}));

vi.mock("./session-factory.js", () => ({
	createWorkerSession: async (deps: { capability: string; model: unknown; modelRuntime?: unknown }) => {
		h.calls.push({ capability: deps.capability, model: deps.model as never, modelRuntime: deps.modelRuntime });
		const report = JSON.stringify({ status: "satisfied", summary: "ok", criteria: [], unmetCriteria: [] });
		let listener: ((e: unknown) => void) | null = null;
		const session = {
			subscribe: (cb: (e: unknown) => void) => {
				listener = cb;
				return () => {
					listener = null;
				};
			},
			prompt: async () => {
				listener?.({ type: "agent_end" });
			},
			getLastAssistantText: () => report,
			dispose: () => undefined,
		};
		return { session, capability: deps.capability, unsubscribe: () => undefined };
	},
	disposeWorkerSession: () => undefined,
}));

const { runWorker, toWorkerRunParams } = await import("./tools.js");

function modelFor(capability: "explorer" | "implementer" | "verifier") {
	const last = h.calls[h.calls.length - 1];
	assert.ok(last, "createWorkerSession debió ser invocada");
	assert.equal(last!.capability, capability);
	return last!.model;
}

describe("runWorker — selección de modelo por capability", () => {
	const params = toWorkerRunParams("explorer", { objetivo: "probar" });

	it("usa el modelo del rol cuando `models` trae asignación para la capability", async () => {
		const orchestrator = { provider: "qwen", id: "orq" };
		const ctx = {
			cwd: process.cwd(),
			model: orchestrator as never,
			models: {
				explorer: { provider: "qwen", id: "flash" } as never,
				implementer: { provider: "minimax", id: "m2.7" } as never,
				verifier: { provider: "qwen", id: "flash" } as never,
			},
		};
		await runWorker("explorer", params, ctx);
		assert.equal(modelFor("explorer")?.id, "flash");
		await runWorker("implementer", params, ctx);
		assert.equal(modelFor("implementer")?.id, "m2.7");
		assert.equal(modelFor("implementer")?.provider, "minimax");
		await runWorker("verifier", params, ctx);
		assert.equal(modelFor("verifier")?.id, "flash");
	});

	it("fallback explícito al modelo del orquestador SOLO sin asignación de rol", async () => {
		const ctx = {
			cwd: process.cwd(),
			model: { provider: "qwen", id: "orq" } as never,
			models: { explorer: undefined },
		};
		await runWorker("explorer", params, ctx);
		assert.equal(modelFor("explorer")?.id, "orq");
	});

	it("sin mapa `models` (callers legacy/tests) mantiene el comportamiento de modelo único", async () => {
		const ctx = { cwd: process.cwd(), model: { provider: "solo", id: "uno" } as never };
		await runWorker("implementer", params, ctx);
		assert.equal(modelFor("implementer")?.id, "uno");
	});
});
