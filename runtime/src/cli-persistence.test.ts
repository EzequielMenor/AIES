// src/cli-persistence.test.ts — T4.1: historial del REPL (.aies/history) en LocalStore.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "vitest";

import { LocalStore, persistPaths, REPL_HISTORY_LIMIT } from "./cli-persistence.js";

function tmpCwd(): string {
	return mkdtempSync(path.join(tmpdir(), "aies-history-"));
}

describe("T4.1 LocalStore.loadHistory", () => {
	it("fichero ausente → []", () => {
		const store = new LocalStore(tmpCwd());
		assert.deepEqual(store.loadHistory(), []);
	});

	it("lee líneas más reciente primero (fichero en disco es cronológico)", () => {
		const cwd = tmpCwd();
		const store = new LocalStore(cwd);
		store.saveHistory([]); // crea .aies/
		writeFileSync(persistPaths(cwd).historyFile, "primero\nsegundo\ntercero\n", "utf8");
		assert.deepEqual(store.loadHistory(), ["tercero", "segundo", "primero"]);
	});

	it("descarta líneas vacías", () => {
		const cwd = tmpCwd();
		const store = new LocalStore(cwd);
		store.saveHistory([]);
		writeFileSync(persistPaths(cwd).historyFile, "a\n\n\nb\n", "utf8");
		assert.deepEqual(store.loadHistory(), ["b", "a"]);
	});

	it("fichero con más de REPL_HISTORY_LIMIT líneas → sólo las últimas, orden preservado", () => {
		const cwd = tmpCwd();
		const lines = Array.from({ length: REPL_HISTORY_LIMIT + 10 }, (_, i) => `linea-${i}`);
		const store = new LocalStore(cwd);
		store.saveHistory([]);
		writeFileSync(persistPaths(cwd).historyFile, `${lines.join("\n")}\n`, "utf8");
		const loaded = store.loadHistory();
		assert.equal(loaded.length, REPL_HISTORY_LIMIT);
		assert.equal(loaded[0], `linea-${REPL_HISTORY_LIMIT + 9}`); // más reciente primero
		assert.equal(loaded[loaded.length - 1], "linea-10"); // las 10 más antiguas se descartaron
	});
});

describe("T4.1 LocalStore.saveHistory", () => {
	it("round-trip: guarda (newest-first) y recarga igual", () => {
		const store = new LocalStore(tmpCwd());
		const newestFirst = ["tercero", "segundo", "primero"];
		store.saveHistory(newestFirst);
		assert.deepEqual(store.loadHistory(), newestFirst);
	});

	it("escribe el fichero en orden cronológico (más antiguo primero)", () => {
		const cwd = tmpCwd();
		const store = new LocalStore(cwd);
		store.saveHistory(["b", "a"]); // newest-first: b es más reciente
		const onDisk = readFileSync(persistPaths(cwd).historyFile, "utf8").trim().split("\n");
		assert.deepEqual(onDisk, ["a", "b"]);
	});

	it("filtra entradas vacías antes de escribir", () => {
		const store = new LocalStore(tmpCwd());
		store.saveHistory(["", "x", ""]);
		assert.deepEqual(store.loadHistory(), ["x"]);
	});

	it("historial vacío → fichero vacío, loadHistory sigue devolviendo []", () => {
		const cwd = tmpCwd();
		const store = new LocalStore(cwd);
		store.saveHistory([]);
		assert.equal(readFileSync(persistPaths(cwd).historyFile, "utf8"), "");
		assert.deepEqual(store.loadHistory(), []);
	});

	it("recorta a REPL_HISTORY_LIMIT conservando las más recientes", () => {
		const store = new LocalStore(tmpCwd());
		const newestFirst = Array.from({ length: REPL_HISTORY_LIMIT + 5 }, (_, i) => `x${i}`);
		store.saveHistory(newestFirst);
		const loaded = store.loadHistory();
		assert.equal(loaded.length, REPL_HISTORY_LIMIT);
		assert.deepEqual(loaded, newestFirst.slice(0, REPL_HISTORY_LIMIT));
	});
});
