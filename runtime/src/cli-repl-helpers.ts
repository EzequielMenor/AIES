// src/cli-repl-helpers.ts — flujos `/login`, `/logout`, `/model` y command palette.
//
// Cada función recibe sus dependencias inyectadas y devuelve un resultado determinista.
// La Phase 12 (tests) los cubre directamente sin tocar cli.ts.

import type { Config } from "./config.js";
import { SLASH_COMMANDS } from "./commands.js";
import {
	loginProvider,
	logoutProvider,
	supportedLoginProviders,
} from "./auth.js";
import { canonicalLoginProvider } from "./cli.js";
import type { PromptUI } from "./ui/prompt-ui.js";
import { findModelAcrossProviders, type ResolvedModel } from "./model-runtime.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { quietStdout } from "./ui/quiet.js";
import type { LocalStore } from "./cli-persistence.js";

// ──────────────────────────────────────────────────────────────────────────────
// Quieteado de stdout alrededor de pi para encapsular su UI nativa.
// ──────────────────────────────────────────────────────────────────────────────

/** Auth flow wrapper. En OAuth se silencia el stdout propio de pi y se sustituye por
 *  los mensajes compactos de AIES. En api_key se pide la key con PromptUI. */
export type LoginFlowResult =
	| { kind: "activated"; providerId: string; activeModel: ResolvedModel | undefined }
	| { kind: "cancelled" }
	| { kind: "error"; message: string }
	| null;

export async function runLoginFlow(
	ctx: { runtime: ModelRuntime; cfg: Config; cwd: string },
	prompt: PromptUI,
	input0: string,
): Promise<LoginFlowResult> {
	if (!prompt.isTTY) {
		prompt.info("aies: /login requiere un TTY; usa `aies login <provider>` o la variable de entorno del provider.");
		return null;
	}
	const arg = input0.slice("/login".length).trim();
	let providerId = arg ? canonicalLoginProvider(arg) : "";
	if (!providerId) {
		const items = supportedLoginProviders(ctx.runtime).map((p) => ({
			id: p.providerId,
			label: p.label,
			description: p.method,
			value: p.providerId,
		}));
		if (items.length === 0) {
			prompt.info("aies: ningún proveedor soporta /login en este entorno.");
			return { kind: "error", message: "no providers" };
		}
		const pick = await prompt.searchSelect("Conectar proveedor", items);
		if (pick.kind !== "selected" || !pick.value) return { kind: "cancelled" };
		providerId = pick.value as string;
	}
	const option = supportedLoginProviders(ctx.runtime).find((p) => p.providerId === providerId);
	if (!option) {
		prompt.info(`aies: provider "${providerId}" no soportado.`);
		return { kind: "error", message: `provider "${providerId}" no soportado` };
	}
	if (option.authType === "api_key") {
		prompt.info(`${option.label}\n\nPega tu API key (Enter confirma, Esc cancela):`);
		const key = (await prompt.secret("API key")).trim();
		if (!key) return { kind: "cancelled" };
		if (option.keyPrefix && !key.startsWith(option.keyPrefix)) {
			prompt.info(`aies: la clave no empieza por "${option.keyPrefix}" — ¿es del proveedor correcto?`);
		}
		// pi espera el secret por su interaction; le pasamos uno que ya entrega la key sin eco.
		const result = await loginProvider(
			ctx.runtime,
			providerId,
			prompt.streams().output,
			undefined,
			"api_key",
			option.keyPrefix,
			buildStreamsWithPrefilledKey(prompt, key),
		);
		if (!result.ok) {
			prompt.info(`aies: ${result.error}`);
			return { kind: "error", message: result.error };
		}
	} else {
		// OAuth: suppress pi's native "Select … login method:" y abrir navegador.
		prompt.info(`${option.label}\n\nAbriendo navegador…\nCompleta el inicio de sesión para continuar.\n(Esc aquí no cancela el flujo del navegador — cierra la pestaña si quieres)`);
		const restore = quietStdout();
		try {
			const result = await loginProvider(
				ctx.runtime,
				providerId,
				prompt.streams().output,
				undefined,
				"oauth",
				undefined,
				prompt.streams(),
			);
			if (!result.ok) {
				prompt.info(`aies: ${result.error}`);
				return { kind: "error", message: result.error };
			}
		} finally {
			restore();
		}
	}
	prompt.info(`✓ ${option.label} conectado`);
	const active = ctx.runtime.getModels(providerId)[0];
	return { kind: "activated", providerId, activeModel: active };
}

function buildStreamsWithPrefilledKey(prompt: PromptUI, key: string): {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
} {
	const { Readable } = require("node:stream") as typeof import("node:stream");
	const fakeInput = Readable.from([key, "\n"]);
	return { input: fakeInput, output: prompt.streams().output };
}

// ──────────────────────────────────────────────────────────────────────────────
// Logout
// ──────────────────────────────────────────────────────────────────────────────

export type LogoutFlowResult =
	| { kind: "deactivated"; providerId: string }
	| { kind: "cancelled" }
	| { kind: "error"; message: string }
	| null;

export async function runLogoutFlow(
	ctx: { runtime: ModelRuntime; cfg: Config },
	prompt: PromptUI,
	input0: string,
): Promise<LogoutFlowResult> {
	const arg = input0.slice("/logout".length).trim();
	if (!arg && prompt.isTTY) {
		const items = [
			...supportedLoginProviders(ctx.runtime).map((p) => ({
				id: p.providerId,
				label: p.label,
				value: p.providerId,
			})),
			{ id: "__all__", label: "Todos", value: "__all__" },
		];
		const pick = await prompt.searchSelect("Cerrar sesión de:", items);
		if (pick.kind !== "selected" || !pick.value) return { kind: "cancelled" };
		return await runLogoutTarget(ctx, prompt, pick.value as string);
	}
	const providerId = canonicalLoginProvider(arg || ctx.cfg.provider);
	return await runLogoutTarget(ctx, prompt, providerId);
}

async function runLogoutTarget(
	ctx: { runtime: ModelRuntime },
	prompt: PromptUI,
	target: string,
): Promise<LogoutFlowResult> {
	if (target === "__all__") {
		for (const provider of supportedLoginProviders(ctx.runtime)) {
			await logoutProvider(ctx.runtime, provider.providerId);
		}
		prompt.info("✓ Todas las sesiones cerradas.");
		return { kind: "deactivated", providerId: "todos" };
	}
	const result = await logoutProvider(ctx.runtime, target);
	if (!result.ok) {
		prompt.info(`aies: ${result.error}`);
		return { kind: "error", message: result.error };
	}
	prompt.info(`✓ ${result.providerId}: sesión cerrada.`);
	return { kind: "deactivated", providerId: result.providerId };
}

// ──────────────────────────────────────────────────────────────────────────────
// Model flow
// ──────────────────────────────────────────────────────────────────────────────

export type ModelFlowResult = { kind: "selected"; model: ResolvedModel } | { kind: "cancelled" } | null;

export async function runModelFlow(
	ctx: { runtime: ModelRuntime; cfg: Config },
	prompt: PromptUI,
	input0: string,
	activeModel: ResolvedModel | undefined,
): Promise<ModelFlowResult> {
	const arg = input0.slice("/model".length).trim();
	if (!arg) return await runModelPicker(ctx, prompt, activeModel);
	const found = findModelAcrossProviders(ctx.runtime, arg);
	if (!found) {
		prompt.info(`aies: ningún modelo utilizable coincide con "${arg}".`);
		return { kind: "cancelled" };
	}
	prompt.info(`✓ ${found.provider} · ${found.id}`);
	return { kind: "selected", model: found };
}

async function runModelPicker(
	ctx: { runtime: ModelRuntime; cfg: Config },
	prompt: PromptUI,
	activeModel: ResolvedModel | undefined,
): Promise<ModelFlowResult> {
	const items: Array<{ id: string; label: string; description?: string; hint?: string; value: ResolvedModel }> = [];
	const providers = [...ctx.runtime.getProviders()].sort((a, b) => a.id.localeCompare(b.id));
	for (const p of providers) {
		if (!ctx.runtime.hasConfiguredAuth(p.id)) continue;
		const models = ctx.runtime.getModels(p.id);
		for (const m of models) {
			const item: {
				id: string;
				label: string;
				description?: string;
				hint?: string;
				value: ResolvedModel;
			} = {
				id: m.id,
				label: `${p.id}/${m.id}`,
				description: "",
				value: m,
			};
			if (activeModel?.provider === m.provider && activeModel?.id === m.id) item.hint = "activo";
			items.push(item);
		}
	}
	if (items.length === 0) {
		prompt.info("ningún proveedor con auth configurada — /login primero.");
		return { kind: "cancelled" };
	}
	const pick = await prompt.searchSelect("Modelo · escribe para filtrar", items, {
		renderHint: (item) =>
			item.value.provider === activeModel?.provider && item.value.id === activeModel?.id ? "activo" : "",
	});
	if (pick.kind !== "selected" || !pick.value) return { kind: "cancelled" };
	return { kind: "selected", model: pick.value };
}

// ──────────────────────────────────────────────────────────────────────────────
// Command palette (`/` solo o parcial)
// ──────────────────────────────────────────────────────────────────────────────

export type PaletteDispatchResult = { kind: "ran"; next: string | null } | { kind: "exit" };

/** Dispatcher con el catálogo. Selección → ejecuta el comando inmediatamente. */
export async function runSlashPaletteDispatch(args: {
	ctx: { runtime: ModelRuntime; cfg: Config; cwd: string };
	prompt: PromptUI;
	store: LocalStore;
	input0: string;
	setActiveModel: (m: ResolvedModel | undefined) => void;
	onExit: () => void;
}): Promise<PaletteDispatchResult> {
	const items: Array<{ id: string; label: string; description?: string; value: string }> = SLASH_COMMANDS.map(
		(c) => ({
			id: c.name,
			label: `/${c.name}`,
			description: c.description,
			value: `/${c.name}`,
		}),
	);
	const initial = args.input0.replace(/^\//, "").trim();
	const pick = await args.prompt.searchSelect("Comandos · escribe para filtrar", items, {
		initialQuery: initial,
	});
	if (pick.kind !== "selected" || !pick.value) return { kind: "ran", next: null };
	const chosen = pick.value as string;
	if (chosen === "/exit" || chosen === "/quit") {
		args.onExit();
		return { kind: "exit" };
	}
	return { kind: "ran", next: chosen };
}
