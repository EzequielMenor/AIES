import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "vitest";

import type { AuthRuntime } from "./auth.js";
import { formatAuthStatusLines, loginProvider, logoutProvider, promptSecret, PROVIDER_ENV_KEY } from "./auth.js";

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
		if (!result.ok) assert.equal(result.error, "boom");
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
