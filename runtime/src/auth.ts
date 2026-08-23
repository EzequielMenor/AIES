// src/auth.ts — login/logout/estado de autenticación.
//
// AIES no implementa su propio almacén de claves: reusa el de pi-coding-agent
// (ModelRuntime.login()/logout()/getProviderAuthStatus()), persistido por defecto en
// ~/.pi/agent/auth.json — un fichero fuera del repo, compartido por cualquier herramienta
// construida sobre pi en esta máquina, no exclusivo de AIES.
//
// aies.config.json sigue siendo SOLO provider + modelos por rol (config.ts) — nunca claves.
// La clave puede venir de env (ANTHROPIC_API_KEY, etc. — PROVIDER_ENV_KEY) o de aquí
// (/login persistente). Si ambas están presentes, pi-ai da prioridad a la credencial
// guardada sobre la env var (auth/helpers.ts::envApiKeyAuth.resolve).
//
// login() NO valida la clave contra la API — sólo la guarda. Un typo no se detecta hasta
// la primera llamada real al modelo.

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Derivados estructuralmente de ModelRuntime (mismo patrón que ResolvedModel en
// orchestrator/decide.ts) para no depender directamente de @earendil-works/pi-ai.
export type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
export type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
export type AuthEvent = Parameters<AuthInteraction["notify"]>[0];
export type ModelInfo = ReturnType<ModelRuntime["getModels"]>[number];

/** Subconjunto mínimo de ModelRuntime que necesita este módulo — permite stubs en tests. */
export interface AuthRuntime {
	getProviders(): ReturnType<ModelRuntime["getProviders"]>;
	getProvider(id: string): ReturnType<ModelRuntime["getProvider"]>;
	getProviderAuthStatus(id: string): ReturnType<ModelRuntime["getProviderAuthStatus"]>;
	getModels(providerId?: string): ReturnType<ModelRuntime["getModels"]>;
	login: ModelRuntime["login"];
	logout: ModelRuntime["logout"];
}

/** Env var de API key por provider conocido — pista si el usuario prefiere no persistir con /login. */
export const PROVIDER_ENV_KEY: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	gemini: "GEMINI_API_KEY",
	minimax: "MINIMAX_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	groq: "GROQ_API_KEY",
	xai: "XAI_API_KEY",
	mistral: "MISTRAL_API_KEY",
};

let runtimeSingleton: Promise<ModelRuntime> | null = null;

/** ModelRuntime compartido para todo el proceso CLI — una sola carga de catálogo/credenciales. */
export function getModelRuntime(): Promise<ModelRuntime> {
	runtimeSingleton ??= ModelRuntime.create();
	return runtimeSingleton;
}

/** Sólo para tests: fuerza una nueva instancia en la siguiente llamada a getModelRuntime(). */
export function resetModelRuntimeForTests(): void {
	runtimeSingleton = null;
}

/**
 * Lee un secreto de stdin sin eco. En TTY usa raw mode y no imprime nada, ni asteriscos
 * (mismo patrón que `npm login`/`git credential`). Fuera de TTY (tests, pipes) cae a una
 * lectura de línea normal — no hay eco de terminal que suprimir.
 */
export function promptSecret(
	message: string,
	streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
		input: process.stdin,
		output: process.stdout,
	},
): Promise<string> {
	const { input, output } = streams;
	output.write(`${message}: `);
	const stdin = input as NodeJS.ReadStream;
	const canRaw = Boolean(stdin.isTTY) && typeof stdin.setRawMode === "function";

	if (!canRaw) {
		return new Promise((resolve) => {
			let buf = "";
			const onData = (chunk: Buffer) => {
				buf += chunk.toString("utf8");
				const nl = buf.indexOf("\n");
				if (nl !== -1) {
					input.removeListener("data", onData);
					if (typeof (input as NodeJS.ReadStream).pause === "function") (input as NodeJS.ReadStream).pause();
					resolve(buf.slice(0, nl).replace(/\r$/, ""));
				}
			};
			if (typeof (input as NodeJS.ReadStream).resume === "function") (input as NodeJS.ReadStream).resume();
			input.on("data", onData);
		});
	}

	return new Promise((resolve, reject) => {
		const wasRaw = stdin.isRaw ?? false;
		let buf = "";
		const cleanup = () => {
			stdin.removeListener("data", onData);
			stdin.setRawMode(wasRaw);
			stdin.pause();
		};
		const onData = (chunk: Buffer) => {
			for (const ch of chunk.toString("utf8")) {
				if (ch === "\r" || ch === "\n") {
					cleanup();
					output.write("\n");
					resolve(buf);
					return;
				}
				if (ch === "\u0003") {
					// Ctrl+C
					cleanup();
					output.write("\n");
					reject(new Error("cancelado (Ctrl+C)"));
					return;
				}
				if (ch === "\u007f" || ch === "\b") {
					// Backspace / Delete
					buf = buf.slice(0, -1);
					continue;
				}
				buf += ch;
			}
		};
		stdin.setRawMode(true);
		stdin.resume();
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
	});
}

/** Interacción de login para terminal: pide el texto/secreto por stdin, notifica eventos por stdout. */
export function terminalAuthInteraction(out: NodeJS.WritableStream, signal?: AbortSignal): AuthInteraction {
	return {
		signal,
		prompt: async (p: AuthPrompt) => {
			if (p.type === "select") {
				out.write(`${p.message}\n`);
				for (const opt of p.options) {
					out.write(`  ${opt.id} — ${opt.label}${opt.description ? ` (${opt.description})` : ""}\n`);
				}
				return promptSecret("elige");
			}
			// "secret" | "text" | "manual_code" — todas se leen igual desde una terminal simple.
			return promptSecret(p.message);
		},
		notify: (event: AuthEvent) => {
			if (event.type === "info") out.write(`${event.message}\n`);
			else if (event.type === "auth_url") out.write(`Abre esta URL para autenticarte: ${event.url}\n`);
			else if (event.type === "device_code") out.write(`Código: ${event.userCode} — ${event.verificationUri}\n`);
			else if (event.type === "progress") out.write(`${event.message}\n`);
		},
	} as AuthInteraction;
}

export type AuthActionResult = { ok: true; providerId: string } | { ok: false; providerId: string; error: string };

export async function loginProvider(
	runtime: AuthRuntime,
	providerId: string,
	out: NodeJS.WritableStream,
	signal?: AbortSignal,
): Promise<AuthActionResult> {
	const provider = runtime.getProvider(providerId);
	if (!provider) {
		return { ok: false, providerId, error: `provider "${providerId}" no reconocido. Usa /auth para ver los disponibles.` };
	}
	try {
		await runtime.login(providerId, "api_key", terminalAuthInteraction(out, signal));
		return { ok: true, providerId };
	} catch (e) {
		return { ok: false, providerId, error: e instanceof Error ? e.message : String(e) };
	}
}

export async function logoutProvider(runtime: AuthRuntime, providerId: string): Promise<AuthActionResult> {
	try {
		await runtime.logout(providerId);
		return { ok: true, providerId };
	} catch (e) {
		return { ok: false, providerId, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Una línea de estado por provider: marca + fuente de la credencial + pista de env.
 *
 * pi trae ~40 providers integrados (amazon-bedrock, xiaomi-token-plan-*, ...); listarlos
 * todos ahoga los pocos que a un usuario de AIES le importan. Se muestran los de
 * PROVIDER_ENV_KEY (los documentados en /login y en el .env de referencia) más cualquier
 * otro que YA esté configurado — para no esconder una credencial real si alguien configuró
 * algo fuera de esa lista corta.
 */
export function formatAuthStatusLines(runtime: AuthRuntime): string[] {
	const configuredElsewhere = runtime
		.getProviders()
		.map((p) => p.id)
		.filter((id) => !(id in PROVIDER_ENV_KEY) && runtime.getProviderAuthStatus(id).configured);
	const known = Array.from(new Set([...Object.keys(PROVIDER_ENV_KEY), ...configuredElsewhere]));
	return known.sort().map((id) => {
		const status = runtime.getProviderAuthStatus(id);
		const mark = status.configured ? "✓" : "○";
		const src = status.configured ? ` (${status.source ?? "?"})` : "";
		const hint = !status.configured && PROVIDER_ENV_KEY[id] ? ` — o exporta ${PROVIDER_ENV_KEY[id]}` : "";
		return `  ${mark} ${id}${src}${hint}`;
	});
}
