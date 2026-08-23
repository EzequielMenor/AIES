import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { AuthRuntime, ModelInfo } from "./auth.js";
import {
	formatModelsTable,
	parseModelsQuery,
	resolveModelsForListing,
	searchModels,
} from "./models-list.js";

function mkModel(over: Partial<ModelInfo>): ModelInfo {
	return {
		id: "m-1",
		name: "Model One",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		// $/1M tokens — el formato nativo de pi (verificado contra el catálogo real: gpt-4 trae
		// exactamente {input:30, output:60}, la tabla de precios pública de OpenAI sin escalar).
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_000,
		...over,
	} as ModelInfo;
}

describe("searchModels", () => {
	const models = [mkModel({ id: "gpt-5.5", name: "GPT 5.5" }), mkModel({ id: "claude-sonnet-5", name: "Sonnet 5" })];

	it("sin query devuelve todos", () => {
		assert.equal(searchModels(models, undefined).length, 2);
		assert.equal(searchModels(models, "").length, 2);
	});

	it("filtra por id o name, insensible a mayúsculas", () => {
		assert.deepEqual(searchModels(models, "GPT").map((m) => m.id), ["gpt-5.5"]);
		assert.deepEqual(searchModels(models, "sonnet").map((m) => m.id), ["claude-sonnet-5"]);
	});

	it("sin coincidencias devuelve vacío", () => {
		assert.equal(searchModels(models, "no-existe").length, 0);
	});
});

describe("formatModelsTable", () => {
	it("vacío imprime aviso, no una tabla vacía", () => {
		assert.match(formatModelsTable([]), /sin resultados/);
	});

	it("una fila por modelo, con ctx/out en K o M y coste en $/1M tok (sin reescalar)", () => {
		const table = formatModelsTable([
			mkModel({ id: "big-model", contextWindow: 1_000_000, maxTokens: 64_000, cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 } }),
		]);
		assert.match(table, /big-model/);
		assert.match(table, /ctx 1M/);
		assert.match(table, /out 64K/);
		assert.match(table, /\$3\.00 in/);
		assert.match(table, /\$15\.00 out/);
	});

	it("marca modelos con thinking", () => {
		const table = formatModelsTable([mkModel({ id: "thinker", reasoning: true })]);
		assert.match(table, /thinking/);
	});

	it("coste 0 se muestra como gratis, no $0.00", () => {
		const table = formatModelsTable([mkModel({ id: "free-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })]);
		assert.match(table, /gratis in \/ gratis out/);
	});
});

describe("parseModelsQuery", () => {
	it("vacío usa el provider por defecto, sin query", () => {
		assert.deepEqual(parseModelsQuery("", "anthropic"), { providerId: "anthropic", query: undefined });
	});

	it("sin @ es una búsqueda dentro del provider por defecto", () => {
		assert.deepEqual(parseModelsQuery("gpt", "anthropic"), { providerId: "anthropic", query: "gpt" });
	});

	it("@provider solo cambia de provider, sin filtro", () => {
		assert.deepEqual(parseModelsQuery("@openai", "anthropic"), { providerId: "openai", query: undefined });
	});

	it("@provider seguido de texto filtra dentro de ese provider", () => {
		assert.deepEqual(parseModelsQuery("@openai gpt-5", "anthropic"), { providerId: "openai", query: "gpt-5" });
	});

	it("espacios extra no dejan query vacía como string", () => {
		assert.deepEqual(parseModelsQuery("@openai   ", "anthropic"), { providerId: "openai", query: undefined });
	});
});

describe("resolveModelsForListing", () => {
	function stubRuntime(byProvider: Record<string, ModelInfo[]>): AuthRuntime {
		return {
			getModels: (id?: string) => (id ? (byProvider[id] ?? []) : Object.values(byProvider).flat()),
			getProviders: () => [],
			getProvider: () => undefined,
			getProviderAuthStatus: () => ({ configured: false }),
			login: (() => {
				throw new Error("not used in this test");
			}) as unknown as AuthRuntime["login"],
			logout: (() => {
				throw new Error("not used in this test");
			}) as unknown as AuthRuntime["logout"],
		};
	}

	it("con providerId, sólo su catálogo", () => {
		const runtime = stubRuntime({ openai: [mkModel({ id: "gpt-5.5" })], anthropic: [mkModel({ id: "claude-sonnet-5" })] });
		const result = resolveModelsForListing(runtime, "openai");
		assert.deepEqual(result.map((m) => m.id), ["gpt-5.5"]);
	});

	it("sin providerId, todos los registrados", () => {
		const runtime = stubRuntime({ openai: [mkModel({ id: "gpt-5.5" })], anthropic: [mkModel({ id: "claude-sonnet-5" })] });
		const result = resolveModelsForListing(runtime, undefined);
		assert.equal(result.length, 2);
	});
});
