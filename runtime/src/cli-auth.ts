// src/cli-auth.ts — `/login`, `/logout` (REPL) y `aies login|logout` (oneshot).
//
// Implementa `AuthInteraction` (pi-ai) sobre readline. Para api_key, pide el valor por prompt.
// Para oauth, delega en `runtime.login(providerId, "oauth", interaction)`. Imprime notificaciones
// (info/auth_url/device_code/progress) en la salida estándar.

import type { AuthEvent, AuthInteraction, AuthPrompt } from "./auth-types.js";
import * as readline from "node:readline/promises";
import { stdout as output } from "node:process";

import type { AiesModelRuntimeLike } from "./model-runtime.js";
import { getAiesAuthPath } from "./model-runtime.js";

type Runtime = AiesModelRuntimeLike & {
	login: (providerId: string, type: "api_key" | "oauth", interaction: AuthInteraction) => Promise<unknown>;
	logout: (providerId: string) => Promise<void>;
	setRuntimeApiKey: (providerId: string, apiKey: string) => Promise<void>;
	listCredentials?: () => Promise<readonly { providerId: string }[]>;
};

/** Lee del usuario según el tipo de prompt de pi. select → opción por número. */
async function askPrompt(rl: readline.Interface, p: AuthPrompt): Promise<string> {
	if (p.type === "select") {
		const options = p.options;
		output.write(`${p.message}\n`);
		for (let i = 0; i < options.length; i += 1) {
			const opt = options[i]!;
			output.write(`  ${String(i + 1).padStart(3)}) ${opt.label}${opt.description ? ` — ${opt.description}` : ""}\n`);
		}
		const ans = await rl.question(`número (Enter cancela): `);
		const trimmed = ans.trim();
		if (!trimmed) throw new Error("cancelado");
		const n = Number(trimmed);
		if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!.id;
		// aceptar id directo
		const match = options.find((o) => o.id === trimmed);
		if (match) return match.id;
		throw new Error(`selección inválida: ${trimmed}`);
	}
	if (p.type === "secret") {
		// readline.promises no soporta mute; lo pedimos normal y advertimos.
		output.write(`${p.message} (entrada visible — pégala con cuidado)\n`);
		return (await rl.question(`secret: `)).trim();
	}
	if (p.type === "manual_code") {
		output.write(`${p.message}\n`);
		return (await rl.question(`código: `)).trim();
	}
	// text
	output.write(`${p.message}\n`);
	return (await rl.question(`${p.placeholder ?? ""}: `)).trim();
}

/** Render de `AuthEvent` en la salida (info, auth_url, device_code, progress). */
function notify(ev: AuthEvent): void {
	switch (ev.type) {
		case "info":
			output.write(`ℹ ${ev.message}${ev.links?.length ? ` — ${ev.links.map((l) => l.url).join(", ")}` : ""}\n`);
			return;
		case "auth_url":
			output.write(`abrir: ${ev.url}${ev.instructions ? `\n${ev.instructions}` : ""}\n`);
			return;
		case "device_code":
			output.write(`código: ${ev.userCode} — ${ev.verificationUri}${ev.expiresInSeconds ? ` (expira en ${ev.expiresInSeconds}s)` : ""}\n`);
			return;
		case "progress":
			output.write(`… ${ev.message}\n`);
			return;
	}
}

function buildInteraction(rl: readline.Interface): AuthInteraction {
	return {
		async prompt(p) {
			try {
				return await askPrompt(rl, p);
			} catch (e) {
				throw e instanceof Error ? e : new Error(String(e));
			}
		},
		notify,
	};
}

/** Selector numerado de proveedor (cuando el usuario no pasó el nombre en argv). */
async function selectProvider(rl: readline.Interface, runtime: Runtime): Promise<string> {
	const providers = [...runtime.getProviders()].sort((a, b) => a.id.localeCompare(b.id));
	if (providers.length === 0) {
		output.write("aies: catálogo de proveedores vacío.\n");
		throw new Error("sin proveedores");
	}
	output.write("proveedores disponibles:\n");
	providers.forEach((p, i) => {
		const auth = runtime.hasConfiguredAuth(p.id) ? " (✓)" : "";
		output.write(`  ${String(i + 1).padStart(3)}) ${p.id}${p.displayName ? ` — ${p.displayName}` : ""}${auth}\n`);
	});
	const ans = await rl.question(`número o id (Enter cancela): `);
	const trimmed = ans.trim();
	if (!trimmed) throw new Error("cancelado");
	const n = Number(trimmed);
	if (Number.isInteger(n) && n >= 1 && n <= providers.length) return providers[n - 1]!.id;
	const match = providers.find((p) => p.id === trimmed);
	if (match) return match.id;
	throw new Error(`proveedor inválido: ${trimmed}`);
}

/** Login interactivo: api_key u oauth (delegando). */
async function runLogin(rl: readline.Interface, runtime: Runtime, providerArg: string | undefined): Promise<void> {
	let providerId = providerArg?.trim();
	if (!providerId) {
		providerId = await selectProvider(rl, runtime);
	}
	const known = runtime.getProviders().some((p) => p.id === providerId);
	if (!known) {
		output.write(`aies: proveedor desconocido: ${providerId}\n`);
		return;
	}
	output.write("tipo de auth:\n");
	output.write("  1) api_key\n");
	output.write("  2) oauth\n");
	const tAns = await rl.question(`número (Enter cancela): `);
	const t = tAns.trim();
	if (!t) return;
	if (t !== "1" && t !== "2") {
		output.write("aies: tipo inválido.\n");
		return;
	}
	try {
		if (t === "1") {
			const key = await askPrompt(rl, {
				type: "secret",
				message: `API key para ${providerId}`,
			});
			if (!key) {
				output.write("aies: clave vacía — cancelado.\n");
				return;
			}
			await runtime.setRuntimeApiKey(providerId, key);
			output.write(`aies: ✓ credencial api_key guardada para ${providerId} en ${getAiesAuthPath()}.\n`);
		} else {
			await runtime.login(providerId, "oauth", buildInteraction(rl));
			output.write(`aies: ✓ oauth completado para ${providerId}. Credenciales en ${getAiesAuthPath()}.\n`);
		}
		// Estado resultante
		const auth = runtime.hasConfiguredAuth(providerId) ? "✓" : "✗";
		output.write(`aies: estado final ${providerId}: ${auth}\n`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		output.write(`aies: ${msg.includes("cancelado") ? "cancelado" : `error — ${msg}`}\n`);
	}
}

/** Logout simple: borra credencial del proveedor seleccionado. */
async function runLogout(rl: readline.Interface, runtime: Runtime, providerArg: string | undefined): Promise<void> {
	let providerId = providerArg?.trim();
	if (!providerId) {
		const creds = await runtime.listCredentials?.();
		if (!creds || creds.length === 0) {
			output.write("aies: no hay credenciales configuradas.\n");
			return;
		}
		output.write("proveedores con credencial:\n");
		creds.forEach((c, i) => {
			output.write(`  ${String(i + 1).padStart(3)}) ${c.providerId}\n`);
		});
		const ans = await rl.question(`número o id (Enter cancela): `);
		const trimmed = ans.trim();
		if (!trimmed) return;
		const n = Number(trimmed);
		if (Number.isInteger(n) && n >= 1 && n <= creds.length) providerId = creds[n - 1]!.providerId;
		else providerId = trimmed;
	}
	if (!providerId) return;
	const known = runtime.getProviders().some((p) => p.id === providerId);
	if (!known) {
		output.write(`aies: proveedor desconocido: ${providerId}\n`);
		return;
	}
	const confirm = await rl.question(`borrar credencial de ${providerId}? [s/N] `);
	if (confirm.trim().toLowerCase() !== "s") {
		output.write("aies: cancelado.\n");
		return;
	}
	await runtime.logout(providerId);
	output.write(`aies: ✓ credencial de ${providerId} borrada.\n`);
}

/** Dispatcher único REPL/oneshot. `command` ∈ {"login","logout"}. */
export async function runAuthCommand(
	command: "login" | "logout",
	rl: readline.Interface,
	runtime: Runtime,
	arg: string,
): Promise<void> {
	if (command === "login") await runLogin(rl, runtime, arg || undefined);
	else await runLogout(rl, runtime, arg || undefined);
}