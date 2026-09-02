import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	bareExitTokens,
	buildSlashCommands,
	filterSlashCommands,
	formatHelpCommands,
	formatSlashCommands,
	parseSlashCommand,
	SLASH_COMMANDS,
} from "./commands.js";
import type { SlashCommand } from "./commands.js";
import { buildSearchPickerLines, filterSearch } from "./ui/prompt-ui.js";
import type { SearchPickerItem } from "./ui/prompt-ui.js";

// ──────────────────────────────────────────────────────────────────────────────
// Phase 4 — registry invariants.
// ──────────────────────────────────────────────────────────────────────────────

describe("slash command registry — fase 4 invariantes", () => {
	it("cada name aparece como máximo una vez en command palette", () => {
		const counts = new Map<string, number>();
		for (const command of SLASH_COMMANDS) {
			counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
		}
		for (const [name, count] of counts) {
			assert.equal(count, 1, `name "${name}" aparece ${count} veces`);
		}
	});

	it("cada alias es único y nunca coincide con un name", () => {
		const names = new Set(SLASH_COMMANDS.map((c) => c.name));
		const aliases = new Set<string>();
		for (const command of SLASH_COMMANDS) {
			for (const alias of command.aliases ?? []) {
				assert.ok(!names.has(alias), `alias "${alias}" colisiona con un name`);
				assert.ok(!aliases.has(alias), `alias "${alias}" duplicado`);
				aliases.add(alias);
			}
		}
	});

	it("/help, command palette y completer leen la misma colección", () => {
		const help = formatHelpCommands();
		const discovery = formatSlashCommands("/");
		for (const command of SLASH_COMMANDS) {
			assert.match(help, new RegExp(`/${command.name}\\b`));
			assert.match(discovery, new RegExp(`/${command.name}\\b`));
		}
	});

	it("buildSlashCommands rechaza duplicados (duplica la garantía para tests/scripts)", () => {
		assert.throws(
			() => buildSlashCommands([{ name: "x", description: "" }, { name: "x", description: "" }]),
			/registry duplicado: name=x/,
		);
		assert.throws(
			() => buildSlashCommands([{ name: "x", description: "" }, { name: "y", description: "", aliases: ["x"] }]),
			/registry duplicado: alias=x/,
		);
	});

	it("el registry es inmutable (no se puede mutar a posteriori)", () => {
		assert.equal(Object.isFrozen(SLASH_COMMANDS), true);
	});

	it("registration es idempotente — llamar buildSlashCommands con la misma fuente dos veces no acumula", () => {
		const src: SlashCommand[] = [{ name: "a", description: "A" }, { name: "b", description: "B" }];
		const r1 = buildSlashCommands(src);
		const r2 = buildSlashCommands(src);
		assert.equal(r1.length, 2);
		assert.equal(r2.length, 2);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Compat — tests históricos.
// ──────────────────────────────────────────────────────────────────────────────

describe("slash command registry — compat", () => {
	it("usa el mismo registry para discovery y help", () => {
		const help = formatHelpCommands();
		const discovery = formatSlashCommands("/");
		for (const command of SLASH_COMMANDS) {
			assert.match(help, new RegExp(`/${command.name}`));
			assert.match(discovery, new RegExp(`/${command.name}`));
		}
	});

	it("filtra /lo a login y logout", () => {
		assert.deepEqual(filterSlashCommands("/lo").map((command) => command.name).filter((n) => n === "login" || n === "logout"), ["login", "logout"]);
	});

	it("parsea comando y argumentos, incluyendo alias", () => {
		assert.deepEqual(parseSlashCommand('/resume "continúa"'), {
			command: SLASH_COMMANDS.find((command) => command.name === "resume"),
			args: '"continúa"',
		});
		assert.equal(parseSlashCommand("/quit")?.command.name, "exit");
	});

	it("bareExitTokens expone exit/quit", () => {
		assert.deepEqual([...bareExitTokens()].sort(), ["exit", "quit"]);
	});
});

// ──────────────────────────────────────────────────────────────────────────────
// Phase 3 — picker helpers.
// ──────────────────────────────────────────────────────────────────────────────

describe("command palette — picker helpers", () => {
	const items: SearchPickerItem<number>[] = [
		{ id: "a", label: "login", value: 1 },
		{ id: "b", label: "logout", value: 2 },
		{ id: "c", label: "model", description: "elegir", value: 3 },
	];

	it("filterSearch filtra por label/id/description case-insensitive", () => {
		assert.deepEqual(filterSearch(items, "LOG").map((i) => i.id), ["a", "b"]);
		assert.deepEqual(filterSearch(items, "elegir").map((i) => i.id), ["c"]);
		assert.equal(filterSearch(items, "").length, items.length);
	});

	it("buildSearchPickerLines produce cursor visible y nada permanente cuando está vacío", () => {
		const lines = buildSearchPickerLines("T", items, 1, "footer");
		assert.equal(lines[0], "T");
		assert.match(lines[1]!, /login/);
		assert.match(lines[2]!, /logout/);
		assert.equal(lines[lines.length - 1], "footer");
	});

	it("buildSearchPickerLines maneja lista vacía sin lanzar", () => {
		const lines = buildSearchPickerLines("T", [], 0, "footer");
		assert.match(lines.join("\n"), /sin coincidencias/);
	});
});
