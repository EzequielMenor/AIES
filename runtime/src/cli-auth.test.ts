// src/cli-auth.test.ts — tests de runLogin (api_key) + runLogout con fake runtime.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { runAuthCommand } from "./cli-auth.js";
import type { AuthEvent, AuthInteraction } from "./auth-types.js";
import type { AiesModelRuntimeLike, ResolvedModel } from "./model-runtime.js";

type Runtime = AiesModelRuntimeLike & {
	login: (providerId: string, type: "api_key" | "oauth", interaction: AuthInteraction) => Promise<unknown>;
	logout: (providerId: string) => Promise<void>;
	setRuntimeApiKey: (providerId: string, apiKey: string) => Promise<void>;
	listCredentials?: () => Promise<readonly { providerId: string }[]>;
};

function fakeModel(provider: string, id: string): ResolvedModel {
	return { provider, id } as never;
}

function makeRuntime(opts: {
	providers: { id: string }[];
	modelsByProvider?: Record<string, string[]>;
	auth?: string[];
}): Runtime & { _setCalls: Array<{ providerId: string; key: string }>; _logouts: string[]; _logins: Array<{ providerId: string; type: string; notifyCount: number }> } {
	const auth = new Set(opts.auth ?? []);
	const setCalls: Array<{ providerId: string; key: string }> = [];
	const logouts: string[] = [];
	const logins: Array<{ providerId: string; type: string; notifyCount: number }> = [];
	const runtime: Runtime = {
		getProviders: () => opts.providers.map((p) => ({ id: p.id })),
		getModels: (providerId?: string) => {
			if (!providerId) return [];
			return (opts.modelsByProvider?.[providerId] ?? []).map((id) => fakeModel(providerId, id));
		},
		getModel: (providerId, modelId) =>
			(opts.modelsByProvider?.[providerId] ?? []).includes(modelId) ? fakeModel(providerId, modelId) : undefined,
		hasConfiguredAuth: (providerId) => auth.has(providerId),
		setRuntimeApiKey: async (providerId, key) => {
			setCalls.push({ providerId, key });
			auth.add(providerId);
		},
		login: async (providerId, type, interaction) => {
			let notifyCount = 0;
			const fakeNotify = (ev: AuthEvent) => {
				notifyCount += 1;
				// ev is unused in test, but we verify it accepts AuthEvent shape
				void ev;
			};
			const wrapped: AuthInteraction = {
				prompt: interaction.prompt,
				notify: fakeNotify,
			};
			await wrapped.notify({ type: "info", message: "test" });
			auth.add(providerId);
			logins.push({ providerId, type, notifyCount });
		},
		logout: async (providerId) => {
			logouts.push(providerId);
			auth.delete(providerId);
		},
		listCredentials: async () => [...auth].map((id) => ({ providerId: id })),
	};
	return Object.assign(runtime, { _setCalls: setCalls, _logouts: logouts, _logins: logins });
}

function capture(): { stream: NodeJS.WritableStream; text: () => string } {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
	} as NodeJS.WritableStream;
	return { stream, text: () => chunks.join("") };
}

function makeFakeRl(answers: string[]): readline.Interface {
	let i = 0;
	return {
		async question(_prompt: string): Promise<string> {
			return answers[i++] ?? "";
		},
	} as unknown as readline.Interface;
}

afterEach(() => {
	/* no-op */
});

describe("runAuthCommand /login (api_key)", () => {
	it("con providerArg → llama setRuntimeApiKey y reporta estado", async () => {
		const out = capture();
		const original = output.write.bind(output);
		(output as { write: typeof output.write }).write = ((chunk: string | Uint8Array): boolean => out.stream.write(chunk)) as typeof output.write;
		try {
			const runtime = makeRuntime({ providers: [{ id: "anthropic" }] });
			// 1ª pregunta: tipo api_key; 2ª: la key.
			const rl = makeFakeRl(["1", "sk-fake-key-1234"]);
			await runAuthCommand("login", rl, runtime, "anthropic");
			assert.equal(runtime._setCalls.length, 1);
			assert.equal(runtime._setCalls[0]?.providerId, "anthropic");
			assert.equal(runtime._setCalls[0]?.key, "sk-fake-key-1234");
			assert.match(out.text(), /credencial api_key guardada para anthropic/);
		} finally {
			(output as { write: typeof output.write }).write = original;
		}
	});
});

describe("runAuthCommand /logout", () => {
	it("con providerArg → llama logout", async () => {
		const out = capture();
		const original = output.write.bind(output);
		(output as { write: typeof output.write }).write = ((chunk: string | Uint8Array): boolean => out.stream.write(chunk)) as typeof output.write;
		try {
			const runtime = makeRuntime({ providers: [{ id: "anthropic" }], auth: ["anthropic"] });
			// Sin rl.question de confirmación, forzamos la rama con providerArg.
			// Pero runLogout pide confirmación incluso con providerArg → usamos un rl que conteste "s".
			const confirmRl = {
				async question(_p: string) {
					return "s";
				},
			} as unknown as readline.Interface;
			await runAuthCommand("logout", confirmRl, runtime, "anthropic");
			assert.equal(runtime._logouts.length, 1);
			assert.equal(runtime._logouts[0], "anthropic");
		} finally {
			(output as { write: typeof output.write }).write = original;
		}
	});
});

// Evita warning de "input unused" si vitest no lo usa
void input;