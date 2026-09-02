// src/commands.ts — fuente única de verdad para los comandos del REPL.
//
// Invariantes (ver `commands.test.ts`):
//   1. Cada `name` aparece como máximo una vez en el registry.
//   2. Cada alias aparece como máximo una vez y nunca coincide con un `name`.
//   3. /help, command palette y completer leen de la misma colección.
//   4. La primera vez que se ejecuta el registry expone un snapshot — las llamadas
//      siguientes no lo duplican (idempotencia cross-session).

export type SlashCommand = {
	readonly name: string;
	readonly description: string;
	readonly aliases?: readonly string[];
};

type Registry = ReadonlyArray<SlashCommand>;

const RAW: readonly SlashCommand[] = [
	{ name: "help", description: "Ver ayuda" },
	{ name: "login", description: "Conectar un proveedor" },
	{ name: "logout", description: "Cerrar sesión" },
	{ name: "model", description: "Elegir modelo (selector interactivo)" },
	{ name: "models", description: "Atajo de /model (alias histórico)" },
	{ name: "pick", description: "Asignar modelos por rol (persiste en aies.config.json)" },
	{ name: "status", description: "Ver estado de AIES" },
	{ name: "state", description: "Ver el estado de la tarea" },
	{ name: "log", description: "Ver el historial de ejecución" },
	{ name: "auth", description: "Ver estado de autenticación" },
	{ name: "resume", description: "Continuar una tarea pausada" },
	{ name: "clear", description: "Limpiar la pantalla" },
	{
		name: "exit",
		description: "Cerrar la sesión",
		aliases: ["quit"],
	},
];

function buildRegistry(source: readonly SlashCommand[]): Registry {
	const seenNames = new Set<string>();
	const seenAliases = new Set<string>();
	const out: SlashCommand[] = [];
	for (const command of source) {
		if (seenNames.has(command.name)) throw new Error(`registry duplicado: name=${command.name}`);
		seenNames.add(command.name);
		for (const alias of command.aliases ?? []) {
			if (seenNames.has(alias) || seenAliases.has(alias)) {
				throw new Error(`registry duplicado: alias=${alias}`);
			}
			seenAliases.add(alias);
		}
		out.push(command);
	}
	return Object.freeze([...out]);
}

/** Snapshot inmutable — el `Object.freeze` evita mutaciones accidentales en runtime. */
export const SLASH_COMMANDS: Registry = buildRegistry(RAW);

/** Construye un registry ad-hoc (tests, scripts). `Object.freeze` idéntico al de producción. */
export function buildSlashCommands(source: readonly SlashCommand[]): Registry {
	return buildRegistry(source);
}

export type ParsedSlashCommand = { command: SlashCommand; args: string };

export function findSlashCommand(name: string): SlashCommand | undefined {
	const normalized = name.toLowerCase();
	return SLASH_COMMANDS.find(
		(command) => command.name === normalized || (command.aliases?.includes(normalized) ?? false),
	);
}

export function parseSlashCommand(input: string): ParsedSlashCommand | undefined {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) return undefined;
	const match = /^\/([^\s]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match || !match[1]) return undefined;
	const command = findSlashCommand(match[1]);
	return command ? { command, args: (match[2] ?? "").trim() } : undefined;
}

/** Filtra comandos cuyo `name` o cualquier alias empieza por el prefijo dado (sin `/`). */
export function filterSlashCommands(prefix: string): SlashCommand[] {
	const normalized = prefix.replace(/^\//, "").toLowerCase();
	if (!normalized) return [...SLASH_COMMANDS];
	return SLASH_COMMANDS.filter(
		(command) =>
			command.name.startsWith(normalized) ||
			(command.aliases?.some((alias) => alias.startsWith(normalized)) ?? false),
	);
}

export type PaletteEntry = { label: string; description: string; token: string };

/**
 * Entradas de la palette. Una por comando — los aliases deliberadamente NO aparecen como
 * entradas separadas (la fase 4 lo garantiza). `token` es lo que se inserta/ejecuta.
 */
export function paletteEntries(): PaletteEntry[] {
	return SLASH_COMMANDS.map((command) => ({
		label: `/${command.name}`,
		description: command.description,
		token: `/${command.name}`,
	}));
}

export function formatSlashCommands(prefix = "/"): string {
	const commands = filterSlashCommands(prefix);
	if (commands.length === 0) return "  (ningún comando coincide)";
	return commands.map((command) => `  /${command.name.padEnd(10)} ${command.description}`).join("\n");
}

export function formatHelpCommands(): string {
	return SLASH_COMMANDS.map((command) => {
		const aliases = command.aliases?.length ? ` (/${command.aliases.join(", /")})` : "";
		return `  /${command.name.padEnd(10)} — ${command.description}${aliases}`;
	}).join("\n");
}

/**
 * Nombres que cierran la sesión sin prefijo `/`. Coherente con las aliases de `exit`.
 * El REPL consulta ESTA lista ANTES de construir un Task — si está vacío, ningún control
 * command se convierte en objetivo de tarea (fase 9).
 */
export function bareExitTokens(): readonly string[] {
	return ["exit", "quit"];
}
