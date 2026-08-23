// src/cli-models.test.ts — tests de formatModels / parsePickArgs / runPick (con fake runtime).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";

import { formatModels, parsePickArgs, runPickCommand } from "./cli-models.js";
import type { Config } from "./config.js";
import type { AiesModelRuntimeLike, ResolvedModel } from "./model-runtime.js";

const dirs: string[] = [];
function mkTmp(): string {
	const d = mkdtempSync(path.join(tmpdir(), "aies-pick-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

function fakeModel(provider: string, id: string): ResolvedModel {
	return { provider, id } as never;
}

function fakeRuntime(opts: {
	providers?: { id: string }[];
	modelsByProvider?: Record<string, string[]>;
	auth?: string[];
}): AiesModelRuntimeLike {
	const providers = opts.providers ?? [];
	const modelsByProvider = opts.modelsByProvider ?? {};
	const auth = new Set(opts.auth ?? []);
	return {
		getProviders: () => providers.map((p) => ({ id: p.id })),
		getModels: (providerId?: string) => {
			if (!providerId) return [];
			return (modelsByProvider[providerId] ?? []).map((id) => fakeModel(providerId, id));
		},
		getModel: (providerId, modelId) =>
			(modelsByProvider[providerId] ?? []).includes(modelId) ? fakeModel(providerId, modelId) : undefined,
		hasConfiguredAuth: (providerId) => auth.has(providerId),
	};
}

const baseCfg: Config = {
	provider: "minimax",
	models: {},
	orchestratorThinkingLevel: "low",
};

describe("formatModels", () => {
	it("lista proveedores con marcas de auth y modelos", () => {
		const runtime = fakeRuntime({
			providers: [{ id: "minimax" }, { id: "anthropic" }],
			modelsByProvider: {
				minimax: ["M2.7", "M2.7-fast"],
				anthropic: ["claude-opus-4-5"],
			},
			auth: ["minimax"],
		});
		const out = formatModels(runtime, { ...baseCfg, models: { orchestrator: "M2.7" } });
		assert.match(out, /✓ minimax/);
		assert.match(out, /✗ anthropic/);
		assert.match(out, /- M2\.7 ◆/); // orchestrator asignado
		assert.match(out, /- M2\.7-fast(?!\s*◆)/); // no asignado
	});

	it("sin auth en ningún proveedor → línea de ayuda a /login", () => {
		const runtime = fakeRuntime({
			providers: [{ id: "minimax" }],
			modelsByProvider: { minimax: ["M2.7"] },
			auth: [],
		});
		const out = formatModels(runtime, baseCfg);
		assert.match(out, /✗ minimax/);
		assert.match(out, /\/login/);
	});
});

describe("parsePickArgs", () => {
	it("vacío → show", () => {
		assert.deepEqual(parsePickArgs(""), { kind: "show" });
		assert.deepEqual(parsePickArgs("   "), { kind: "show" });
	});
	it("rol solo → pick-role", () => {
		assert.deepEqual(parsePickArgs("verifier"), { kind: "pick-role", role: "verifier" });
	});
	it("rol + ref → assign", () => {
		assert.deepEqual(parsePickArgs("verifier claude-opus-4-5"), { kind: "assign", role: "verifier", ref: "claude-opus-4-5" });
	});
	it("rol desconocido → error", () => {
		assert.throws(() => parsePickArgs("narrator"), /rol desconocido: narrator/);
	});
});

function writeInitialCfg(dir: string, cfg: Config): string {
	const p = path.join(dir, "aies.config.json");
	writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
	return p;
}

describe("runPickCommand (non-interactive)", () => {
	it("rol + ref válido: actualiza config atómicamente, .bak creado, JSON re-valida", async () => {
		const dir = mkTmp();
		const cfg: Config = { ...baseCfg, models: { orchestrator: "M2.7" } };
		const configPath = writeInitialCfg(dir, cfg);
		const runtime = fakeRuntime({
			providers: [{ id: "minimax" }, { id: "anthropic" }],
			modelsByProvider: {
				minimax: ["M2.7", "M2.7-fast"],
				anthropic: ["claude-opus-4-5"],
			},
			auth: ["minimax", "anthropic"],
		});

		await runPickCommand(null, runtime, cfg, configPath, "verifier anthropic/claude-opus-4-5");

		const updated = JSON.parse(readFileSync(configPath, "utf8"));
		assert.equal(updated.models.verifier, "anthropic/claude-opus-4-5");
		// .bak previo
		const bak = readFileSync(`${configPath}.bak`, "utf8");
		assert.match(bak, /"orchestrator":\s*"M2\.7"/);
	});

	it("rol + ref inválido → no escribe nada", async () => {
		const dir = mkTmp();
		const cfg: Config = { ...baseCfg, models: { orchestrator: "M2.7" } };
		const configPath = writeInitialCfg(dir, cfg);
		const before = readFileSync(configPath, "utf8");
		const runtime = fakeRuntime({
			providers: [{ id: "minimax" }],
			modelsByProvider: { minimax: ["M2.7"] },
		});

		await runPickCommand(null, runtime, cfg, configPath, "verifier no-existe");

		const after = readFileSync(configPath, "utf8");
		assert.equal(after, before);
		assert.equal(existsSync_(`${configPath}.bak`), false); // no se tocó
	});
});

function existsSync_(p: string): boolean {
	try {
		return readFileSync(p).length >= 0;
	} catch {
		return false;
	}
}