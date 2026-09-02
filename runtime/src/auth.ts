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

import { execFile } from "node:child_process";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PromptUI } from "./ui/prompt-ui.js";

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
	"qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
	"qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
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
export function terminalAuthInteraction(
	out: NodeJS.WritableStream,
	signal?: AbortSignal,
	streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
	keyPrefix?: string,
	secrets: string[] = [],
): AuthInteraction {
	return {
		signal,
		prompt: async (p: AuthPrompt) => {
			if (p.type === "select") {
				const selected = await selectOption(p.message, p.options, streams);
				if (!selected) throw new Error("login cancelado");
				return selected;
			}
			// "secret" | "text" | "manual_code" — todas se leen igual desde una terminal simple.
			const value = await promptSecret(p.message, streams);
			if (p.type === "secret") {
				secrets.push(value);
				if (keyPrefix && !value.startsWith(keyPrefix)) {
					throw new Error(`la credencial no tiene el formato esperado para este proveedor (${keyPrefix})`);
				}
			}
			return value;
		},
		notify: (event: AuthEvent) => {
			if (event.type === "info") out.write(`${event.message}\n`);
			else if (event.type === "auth_url") {
				out.write(`Abriendo navegador para iniciar sesión...\n${event.instructions ?? "Completa el inicio de sesión en el navegador."}\n`);
				openAuthUrl(event.url);
			}
			else if (event.type === "device_code") out.write(`Código: ${event.userCode} — ${event.verificationUri}\n`);
			else if (event.type === "progress") out.write(`${event.message}\n`);
		},
	} as AuthInteraction;
}

export type AuthActionResult = { ok: true; providerId: string } | { ok: false; providerId: string; error: string };

export type LoginProviderOption = {
	providerId: string;
	label: string;
	method: "Token Plan" | "ChatGPT/Codex" | "API key";
	authType: "api_key" | "oauth";
	keyPrefix?: string;
};

/**
 * Opciones de login soportadas por la combinación AIES + pi instalada.
 * No se muestra el antiguo Qwen OAuth ni se inventa un proveedor para Coding Plan:
 * el runtime ya trae el protocolo oficial de Token Plan y no trae un catálogo/end-point
 * específico de Coding Plan.
 */
export function supportedLoginProviders(runtime: AuthRuntime): LoginProviderOption[] {
	const options: LoginProviderOption[] = [];
	if (runtime.getProvider("minimax")) {
		options.push({ providerId: "minimax", label: "MiniMax", method: "Token Plan", authType: "api_key", keyPrefix: "sk-cp-" });
	}
	const qwenProvider = runtime.getProvider("qwen-token-plan-cn") ?? runtime.getProvider("qwen-token-plan");
	if (qwenProvider) {
		options.push({
			providerId: qwenProvider.id,
			label: "Qwen / Alibaba ModelStudio",
			method: "Token Plan",
			authType: "api_key",
			keyPrefix: "sk-sp-",
		});
	}
	if (runtime.getProvider("openai-codex")) {
		options.push({ providerId: "openai-codex", label: "OpenAI / ChatGPT", method: "ChatGPT/Codex", authType: "oauth" });
	}
	return options;
}

function loginProviderOptions(runtime: AuthRuntime): Array<LoginProviderOption & { id: string }> {
	return supportedLoginProviders(runtime).map((option) => ({ ...option, id: option.providerId }));
}

export async function loginInteractively(
	runtime: AuthRuntime,
	out: NodeJS.WritableStream,
	streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<AuthActionResult | { ok: false; cancelled: true }> {
	const selected = await selectOption("Selecciona un proveedor:", loginProviderOptions(runtime), streams);
	if (!selected) return { ok: false, cancelled: true };
	const option = supportedLoginProviders(runtime).find((candidate) => candidate.providerId === selected);
	if (!option) return { ok: false, cancelled: true };
	out.write(`\n${option.label}\n\nMétodo: ${option.method}\n`);
	const result = await loginProvider(runtime, option.providerId, out, undefined, option.authType, option.keyPrefix, streams);
	if (result.ok) out.write(`\n✓ ${option.label} conectado\n`);
	return result;
}

export async function logoutInteractively(
	runtime: AuthRuntime,
	out: NodeJS.WritableStream,
	streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<AuthActionResult | { ok: false; cancelled: true }> {
	const options = [...loginProviderOptions(runtime), { id: "__all__", label: "Todos", method: "API key" as const, authType: "api_key" as const }];
	const selected = await selectOption("Cerrar sesión de:", options, streams);
	if (!selected) return { ok: false, cancelled: true };
	if (selected === "__all__") {
		for (const option of supportedLoginProviders(runtime)) {
			const result = await logoutProvider(runtime, option.providerId);
			if (!result.ok) return result;
		}
		return { ok: true, providerId: "todos" };
	}
	return logoutProvider(runtime, selected);
}

function providerLabel(runtime: AuthRuntime, providerId: string): string {
	return runtime.getProvider(providerId)?.name ?? providerId;
}

function isInteractiveTerminal(streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): boolean {
	return Boolean((streams.input as NodeJS.ReadStream).isTTY && (streams.output as NodeJS.WriteStream).isTTY);
}

/** Wrapper de compatibilidad: selectOption legacy usado por loginInteractively. */
export function selectOption(
	title: string,
	options: readonly { id: string; label: string; description?: string }[],
	streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<string | null> {
	const items = options.map((o) => {
		const base: { id: string; label: string; value: string; description?: string } = {
			id: o.id,
			label: o.label,
			value: o.id,
		};
		if (o.description !== undefined) base.description = o.description;
		return base;
	});
	const ui = new PromptUI({ streams, prompt: "" });
	return ui.select(title, items).then((r) => r.value);
}

function openAuthUrl(url: string): void {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
		const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const args = process.platform === "win32" ? ["/c", "start", "", parsed.href] : [parsed.href];
		execFile(command, args, () => undefined);
	} catch {
		/* La URL sigue mostrándose; no se bloquea el login si no hay navegador. */
	}
}

export async function loginProvider(
	runtime: AuthRuntime,
	providerId: string,
	out: NodeJS.WritableStream,
	signal?: AbortSignal,
	authType: "api_key" | "oauth" = "api_key",
	keyPrefix?: string,
	streams: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout },
): Promise<AuthActionResult> {
	const provider = runtime.getProvider(providerId);
	if (!provider) {
		return { ok: false, providerId, error: `provider "${providerId}" no reconocido. Usa /auth para ver los disponibles.` };
	}
	const secrets: string[] = [];
	try {
		await runtime.login(providerId, authType, terminalAuthInteraction(out, signal, streams, keyPrefix, secrets));
		return { ok: true, providerId };
	} catch (e) {
		const detail = redactSecret(e instanceof Error ? e.message : String(e), secrets);
		return { ok: false, providerId, error: humanAuthError(providerLabel(runtime, providerId), detail) };
	}
}

function redactSecret(message: string, secrets: readonly string[]): string {
	let safe = message;
	for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redactado]");
	return safe.replace(/(sk-(?:cp|sp|proj|live|test)-)[A-Za-z0-9._-]+/g, "$1[redactado]");
}

function humanAuthError(provider: string, detail: string): string {
	const lower = detail.toLowerCase();
	if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid") || lower.includes("rejected")) {
		return `No se pudo autenticar con ${provider}. La credencial fue rechazada. Revisa que esté activa y corresponda al método elegido.`;
	}
	if (lower.includes("cancel")) return "login cancelado";
	return `No se pudo autenticar con ${provider}${detail ? `: ${detail}` : "."}`;
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
