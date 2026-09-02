import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "vitest";

import type { AuthRuntime } from "./auth.js";
import {
	formatAuthStatusLines,
	loginInteractively,
	loginProvider,
	logoutProvider,
	promptSecret,
	PROVIDER_ENV_KEY,
	selectOption,
	supportedLoginProviders,
} from "./auth.js";

type StubProvider = { id: string; name: string };

function stubRuntime(opts: {
	providers?: StubProvider[];
	status?: Record<string, { configured: boolean; source?: string }>;
	loginImpl?: AuthRuntime["login"];
	logoutImpl?: AuthRuntime["logout"];
}): AuthRuntime {
	const providers = opts.providers ?? [];
	const status = opts.status ?? {};
	return {
		getProviders: () => providers as unknown as ReturnType<AuthRuntime["getProviders"]>,
		getProvider: (id: string) => providers.find((p) => p.id === id) as unknown as ReturnType<AuthRuntime["getProvider"]>,
		getProviderAuthStatus: (id: string) =>
			(status[id] ?? { configured: false }) as unknown as ReturnType<AuthRuntime["getProviderAuthStatus"]>,
		getModels: () => [] as unknown as ReturnType<AuthRuntime["getModels"]>,
		login: opts.loginImpl ?? ((async () => {
			throw new Error("login no stubbed");
		}) as unknown as AuthRuntime["login"]),
		logout: opts.logoutImpl ?? ((async () => {
			throw new Error("logout no stubbed");
		}) as unknown as AuthRuntime["logout"]),
	};
}

describe("formatAuthStatusLines", () => {
	it("marca ✓ los configurados, con fuente, y ○ el resto con pista de env var", () => {
		const runtime = stubRuntime({
			providers: [{ id: "anthropic", name: "Anthropic" }, { id: "openai", name: "OpenAI" }],
			status: { anthropic: { configured: true, source: "stored" } },
		});
		const lines = formatAuthStatusLines(runtime);
		const anthropicLine = lines.find((l) => l.includes("anthropic"))!;
		const openaiLine = lines.find((l) => l.includes("openai"))!;
		assert.match(anthropicLine, /✓ anthropic \(stored\)/);
		assert.doesNotMatch(anthropicLine, /ANTHROPIC_API_KEY/);
		assert.match(openaiLine, /○ openai/);
		assert.match(openaiLine, new RegExp(PROVIDER_ENV_KEY.openai));
	});

	it("incluye providers conocidos por env aunque no estén registrados en el runtime", () => {
		const runtime = stubRuntime({ providers: [] });
		const lines = formatAuthStatusLines(runtime);
		assert.ok(lines.some((l) => l.includes("minimax")));
	});

	it("no duplica un provider que está tanto en PROVIDER_ENV_KEY como registrado", () => {
		const runtime = stubRuntime({ providers: [{ id: "openai", name: "OpenAI" }] });
		const lines = formatAuthStatusLines(runtime);
		const count = lines.filter((l) => l.includes(" openai")).length;
		assert.equal(count, 1);
	});
});

describe("loginProvider", () => {
	it("provider desconocido falla sin llamar a login()", async () => {
		let called = false;
		const runtime = stubRuntime({
			providers: [],
			loginImpl: (async () => {
				called = true;
				return {} as never;
			}) as unknown as AuthRuntime["login"],
		});
		const result = await loginProvider(runtime, "nope", new PassThrough());
		assert.equal(result.ok, false);
		assert.equal(called, false);
		if (!result.ok) assert.match(result.error, /no reconocido/);
	});

	it("provider conocido: éxito delega en runtime.login()", async () => {
		const runtime = stubRuntime({
			providers: [{ id: "openai", name: "OpenAI" }],
			loginImpl: (async () => ({ type: "api_key", key: "sk-x" })) as unknown as AuthRuntime["login"],
		});
		const result = await loginProvider(runtime, "openai", new PassThrough());
		assert.deepEqual(result, { ok: true, providerId: "openai" });
	});

	it("runtime.login() rechaza → resultado ok:false con el mensaje", async () => {
		const runtime = stubRuntime({
			providers: [{ id: "openai", name: "OpenAI" }],
			loginImpl: (async () => {
				throw new Error("boom");
			}) as unknown as AuthRuntime["login"],
		});
		const result = await loginProvider(runtime, "openai", new PassThrough());
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /No se pudo autenticar con OpenAI/);
	});

	it("valida el prefijo del Token Plan y no filtra el secreto en el error", async () => {
		const secret = "SECRET_SHOULD_NEVER_APPEAR_123";
		const input = new PassThrough();
		const output = new PassThrough();
		let text = "";
		output.on("data", (chunk) => {
			text += chunk.toString();
		});
		const runtime = stubRuntime({
			providers: [{ id: "minimax", name: "MiniMax" }],
			loginImpl: (async (_provider, _type, interaction) => {
				await interaction.prompt({ type: "secret", message: "Token" });
				throw new Error(`401 ${secret}`);
			}) as unknown as AuthRuntime["login"],
		});
		const resultPromise = loginProvider(runtime, "minimax", output, undefined, "api_key", "sk-cp-", { input, output });
		input.write(`${secret}\n`);
		const result = await resultPromise;
		assert.equal(result.ok, false);
		assert.doesNotMatch(text, new RegExp(secret));
		if (!result.ok) assert.doesNotMatch(result.error, new RegExp(secret));
	});
});

describe("supportedLoginProviders", () => {
	it("expone sólo MiniMax Token Plan, Alibaba Token Plan y OpenAI Codex", () => {
		const runtime = stubRuntime({
			providers: [
				{ id: "minimax", name: "MiniMax" },
				{ id: "qwen-token-plan-cn", name: "Qwen Token Plan CN" },
				{ id: "openai-codex", name: "OpenAI Codex" },
			],
		});
		const options = supportedLoginProviders(runtime);
		assert.deepEqual(options.map((option) => option.providerId), ["minimax", "qwen-token-plan-cn", "openai-codex"]);
		assert.equal(options.some((option) => option.providerId.includes("oauth") || option.method.includes("OAuth")), false);
	});

	it("el chooser delega MiniMax como api_key y OpenAI como oauth", async () => {
		let authType: string | undefined;
		const input = new PassThrough();
		const output = new PassThrough();
		const runtime = stubRuntime({
			providers: [
				{ id: "minimax", name: "MiniMax" },
				{ id: "qwen-token-plan-cn", name: "Qwen Token Plan CN" },
				{ id: "openai-codex", name: "OpenAI Codex" },
			],
			loginImpl: (async (_provider, type) => {
				authType = type;
				return { type: "api_key", key: "redacted" } as never;
			}) as unknown as AuthRuntime["login"],
		});
		const loginPromise = loginInteractively(runtime, output, { input, output });
		input.write("3\n");
		const result = await loginPromise;
		assert.equal(result.ok, true);
		assert.equal(authType, "oauth");
	});

	it("cancelar el chooser no llama al runtime", async () => {
		let called = false;
		const input = new PassThrough();
		const output = new PassThrough();
		const runtime = stubRuntime({
			providers: [{ id: "minimax", name: "MiniMax" }],
			loginImpl: (async () => {
				called = true;
				return {} as never;
			}) as unknown as AuthRuntime["login"],
		});
		const loginPromise = loginInteractively(runtime, output, { input, output });
		input.write("0\n");
		const result = await loginPromise;
		assert.deepEqual(result, { ok: false, cancelled: true });
		assert.equal(called, false);
	});
});

describe("selectOption (non-TTY)", () => {
	it("lee una selección determinista sin ANSI", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let text = "";
		output.on("data", (chunk) => {
			text += chunk.toString();
		});
		const selection = selectOption("Proveedor", [{ id: "a", label: "A" }, { id: "b", label: "B" }], { input, output });
		input.write("2\n");
		assert.equal(await selection, "b");
		assert.doesNotMatch(text, /\x1b/);
	});
});

describe("logoutProvider", () => {
	it("éxito", async () => {
		const runtime = stubRuntime({ logoutImpl: (async () => {}) as unknown as AuthRuntime["logout"] });
		const result = await logoutProvider(runtime, "openai");
		assert.deepEqual(result, { ok: true, providerId: "openai" });
	});

	it("fallo se reporta, no lanza", async () => {
		const runtime = stubRuntime({
			logoutImpl: (async () => {
				throw new Error("no credential");
			}) as unknown as AuthRuntime["logout"],
		});
		const result = await logoutProvider(runtime, "openai");
		assert.equal(result.ok, false);
	});
});

describe("promptSecret (no-TTY)", () => {
	it("lee una línea de input y no la repite en output", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		let written = "";
		output.on("data", (c) => {
			written += c.toString();
		});
		const promise = promptSecret("API key", { input, output });
		input.write("sk-test-123\n");
		const value = await promise;
		assert.equal(value, "sk-test-123");
		assert.doesNotMatch(written, /sk-test-123/);
		assert.match(written, /API key: $/);
	});
});
