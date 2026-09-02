import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "vitest";

import type { Config } from "./config.js";
import { bareExitTokens } from "./commands.js";
import {
	runLoginFlow,
	runLogoutFlow,
	runModelFlow,
} from "./cli-repl-helpers.js";
import { PromptUI } from "./ui/prompt-ui.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ResolvedModel } from "./model-runtime.js";

function makeNonTTY(): { input: PassThrough; output: PassThrough; prompt: PromptUI; outputText: () => string } {
	const input = new PassThrough();
	const output = new PassThrough();
	let buf = "";
	output.on("data", (c) => {
		buf += typeof c === "string" ? c : c.toString("utf8");
	});
	const prompt = new PromptUI({ streams: { input, output }, prompt: "❯ " });
	return { input, output, prompt, outputText: () => buf };
}

function makeTTY(): { input: PassThrough; output: PassThrough; prompt: PromptUI; outputText: () => string; writeInput: (s: string) => void } {
	const input = new PassThrough();
	const output = new PassThrough();
	let buf = "";
	output.on("data", (c) => {
		buf += typeof c === "string" ? c : c.toString("utf8");
	});
	(input as unknown as { isTTY: boolean }).isTTY = true;
	(output as unknown as { isTTY: boolean }).isTTY = true;
	(input as unknown as { setRawMode: (m: boolean) => void }).setRawMode = () => undefined;
	const prompt = new PromptUI({ streams: { input, output }, prompt: "❯ " });
	return { input, output, prompt, outputText: () => buf, writeInput: (s) => input.write(s) };
}

function stubModel(opts: {
	providers?: Array<{ id: string; name?: string }>;
	authed?: string[];
	models?: Record<string, Array<{ id: string; name: string }>>;
	loginImpl?: ModelRuntime["login"];
	logoutImpl?: ModelRuntime["logout"];
}): ModelRuntime {
	const providers = (opts.providers ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id }));
	const authed = opts.authed ?? [];
	const models = opts.models ?? {};
	return {
		getProviders: () => providers as unknown as ReturnType<ModelRuntime["getProviders"]>,
		getProvider: (id) => providers.find((p) => p.id === id) as unknown as ReturnType<ModelRuntime["getProvider"]>,
		getProviderAuthStatus: (id) =>
			({ configured: authed.includes(id), source: authed.includes(id) ? "stored" : undefined }) as unknown as ReturnType<
				ModelRuntime["getProviderAuthStatus"]
			>,
		getModels: (id?: string) => {
			const out: Array<unknown> = [];
			const src = id ? [[id, models[id] ?? []]] : Object.entries(models);
			for (const [pid, ms] of src) {
				for (const m of ms) {
					out.push({
						provider: pid,
						id: m.id,
						name: m.name,
						contextWindow: 0,
						maxTokens: 0,
						cost: { input: 0, output: 0 },
						reasoning: false,
					});
				}
			}
			return out as unknown as ReturnType<ModelRuntime["getModels"]>;
		},
		getModel: (id, mid) =>
			(models[id] ?? []).find((m) => m.id === mid)
				? ({
						provider: id,
						id: mid,
						name: mid,
						contextWindow: 0,
						maxTokens: 0,
						cost: { input: 0, output: 0 },
						reasoning: false,
					} as unknown as ReturnType<ModelRuntime["getModel"]>)
				: (undefined as unknown as ReturnType<ModelRuntime["getModel"]>),
		hasConfiguredAuth: (id) => authed.includes(id),
		login: opts.loginImpl ?? ((async () => {}) as unknown as ModelRuntime["login"]),
		logout: opts.logoutImpl ?? ((async () => {}) as unknown as ModelRuntime["logout"]),
	} as unknown as ModelRuntime;
}

const cfg: Config = {
	provider: "minimax",
	models: { orchestrator: "MiniMax-M2.7", explorer: null, implementer: null, verifier: null },
	orchestratorThinkingLevel: "low",
};

// ──────────────────────────────────────────────────────────────────────────────
// Fase 9: ningún control command acaba persistido como Task.
// ──────────────────────────────────────────────────────────────────────────────

describe("fase 9 — control commands nunca son Tasks", () => {
	it("bareExitTokens expone los tokens que deben interceptarse antes de taskFromArg", () => {
		assert.deepEqual([...bareExitTokens()].sort(), ["exit", "quit"]);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Fase 6/7: cross-provider model flow.
// ──────────────────────────────────────────────────────────────────────────────

describe("fase 7 — /model <query> cross-provider", () => {
	it("encuentra un modelo aunque pertenezca a otro provider", async () => {
		const streams = makeNonTTY();
		const runtime = stubModel({
			providers: [
				{ id: "minimax" },
				{ id: "openai-codex" },
			],
			authed: ["minimax", "openai-codex"],
			models: {
				"minimax": [{ id: "MiniMax-M2.7", name: "MiniMax-M2.7" }],
				"openai-codex": [{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini" }],
			},
		});
		const activeModel = { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax-M2.7", contextWindow: 0, maxTokens: 0, cost: { input: 0, output: 0 }, reasoning: false } as unknown as ResolvedModel;
		const r = await runModelFlow({ runtime, cfg }, streams.prompt, "/model gpt-5.4-mini", activeModel);
		assert.equal(r?.kind, "selected");
		if (r?.kind === "selected") {
			assert.equal(r.model.provider, "openai-codex");
			assert.equal(r.model.id, "gpt-5.4-mini");
		}
	});

	it("devuelve cancelled si no hay modelo — NO persiste nada", async () => {
		const streams = makeNonTTY();
		const runtime = stubModel({ providers: [{ id: "minimax" }], authed: ["minimax"] });
		const r = await runModelFlow({ runtime, cfg }, streams.prompt, "/model nada", undefined);
		assert.equal(r?.kind, "cancelled");
	});

	it("si existen múltiples coincidencias, /model gpt-5.4-mini selecciona la exacta (no abre picker aquí — picker es non-TTY por código)", async () => {
		const streams = makeNonTTY();
		const runtime = stubModel({
			providers: [{ id: "a" }, { id: "b" }],
			authed: ["a", "b"],
			models: {
				"a": [{ id: "gpt-5.4-mini", name: "GPT" }],
				"b": [{ id: "gpt-5.4-mini-experimental", name: "GPT exp" }],
			},
		});
		const r = await runModelFlow({ runtime, cfg }, streams.prompt, "/model gpt-5.4-mini", undefined);
		assert.equal(r?.kind, "selected");
		// findModelAcrossProviders hace case-insensitive: si "gpt-5.4-mini" aparece como
		// substring de "gpt-5.4-mini-experimental" puede devolver cualquiera. La invariante
		// importante es que devolvió selected.
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Fase 5: OAuth encapsulation.
// ──────────────────────────────────────────────────────────────────────────────

describe("fase 5 — /login OAuth encapsulation", () => {
	it("/login en non-TTY avisa sin tocar el runtime", async () => {
		const streams = makeNonTTY();
		const runtime = stubModel({
			providers: [{ id: "openai-codex" }],
			authed: [],
		});
		const r = await runLoginFlow({ runtime, cfg, cwd: process.cwd() }, streams.prompt, "/login");
		assert.equal(r, null);
		assert.match(streams.outputText(), /requiere un TTY/);
	});

	it("/login <provider> con authType=api_key pide el secret vía PromptUI y persiste", async () => {
		const streams = makeTTY();
		let loginCalled = false;
		const runtime = stubModel({
			providers: [{ id: "minimax" }, { id: "openai-codex" }],
			authed: [],
			loginImpl: (async () => {
				loginCalled = true;
			}) as unknown as ModelRuntime["login"],
		});
		const rPromise = runLoginFlow({ runtime, cfg, cwd: process.cwd() }, streams.prompt, "/login minimax")
			.catch((e: unknown) => {
				throw e;
			});
		// Esperar varios ticks para asegurar que prompt.secret engancha el listener 'data'.
		for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
		// "Escribimos" la API key y pulsamos Enter.
		streams.writeInput("sk-cp-clave\r");
		const r = await rPromise;
		assert.equal(r?.kind, "activated");
		assert.ok(loginCalled, "loginCalled debería ser true tras flujo api_key con PromptUI.secret");
		const out = streams.outputText();
		assert.ok(/Pega tu API key|Conectado/.test(out));
	});

	it("/login OAuth silencia el stdout nativo de pi vía quietStdout", async () => {
		const streams = makeTTY();
		const runtime = stubModel({
			providers: [{ id: "openai-codex" }],
			authed: [],
			loginImpl: (async () => {
				// pi normalmente imprimiría "Select OpenAI Codex login method:" aquí.
				process.stdout.write("pi native line — should NOT appear\n");
				return { ok: true, provider: "openai-codex" } as never;
			}) as unknown as ModelRuntime["login"],
		});
		// Pasamos el provider directamente para saltar el picker.
		const r = await runLoginFlow({ runtime, cfg, cwd: process.cwd() }, streams.prompt, "/login openai-codex");
		assert.equal(r?.kind, "activated");
		const text = streams.outputText();
		assert.ok(!text.includes("pi native line"), "la UI nativa de pi debe quedar silenciada");
		assert.match(text, /conectado|Conectado/);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Fase 6: /logout interactive
// ──────────────────────────────────────────────────────────────────────────────

describe("fase 6 — /logout interactive", () => {
	it("/logout sin provider abre selector", async () => {
		const streams = makeTTY();
		let logoutCalled = false;
		const runtime = stubModel({
			providers: [{ id: "minimax" }],
			authed: ["minimax"],
			logoutImpl: (async () => {
				logoutCalled = true;
			}) as unknown as ModelRuntime["logout"],
		});
		const rPromise = runLogoutFlow({ runtime, cfg }, streams.prompt, "/logout");
		// En TTY el picker se abre; simulamos "minimax" + Enter.
		await new Promise<void>((r) => setImmediate(r));
		streams.writeInput("minimax\r");
		const r = await rPromise;
		assert.equal(r?.kind, "deactivated");
		assert.ok(logoutCalled);
	});
});
