import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	checkForUpdate,
	formatUpdateNotice,
	recordSuccessfulUpdate,
	type RunGit,
	type UpdateStatus,
} from "../src/update.js";

const NOW = 1_800_000_000_000;

function gitRunner(localHead: string, remoteHead: string): RunGit {
	return vi.fn<RunGit>(async (file, args) => {
		if (file !== "git") throw new Error(`comando inesperado: ${file}`);
		if (args[0] === "-C") return `${localHead}\n`;
		if (args[0] === "ls-remote") return `${remoteHead}\trefs/heads/main\n`;
		throw new Error(`argumentos inesperados: ${args.join(" ")}`);
	});
}

async function writeCache(cachePath: string, lastCheckMs: number, lastRemoteHead: string, lastLocalHead: string): Promise<void> {
	await mkdir(path.dirname(cachePath), { recursive: true });
	await writeFile(
		cachePath,
		JSON.stringify({ lastCheckMs, lastRemoteHead, lastLocalHead }),
		"utf8",
	);
}

describe("checkForUpdate", () => {
	let tempDir: string;
	let previousNoUpdateCheck: string | undefined;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "aies-update-"));
		previousNoUpdateCheck = process.env.AIES_NO_UPDATE_CHECK;
		delete process.env.AIES_NO_UPDATE_CHECK;
	});

	afterEach(async () => {
		if (previousNoUpdateCheck === undefined) delete process.env.AIES_NO_UPDATE_CHECK;
		else process.env.AIES_NO_UPDATE_CHECK = previousNoUpdateCheck;
		await rm(tempDir, { recursive: true, force: true });
	});

	it("confirma con ls-remote cuando el cache dice update-available", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		await writeCache(cachePath, NOW - 60_000, "remote-stale", "local-current");
		const git = gitRunner("local-current", "remote-fresh");

		const result = await checkForUpdate({ now: NOW, cachePath, installDir: "/installed", runGit: git });

		expect(git).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			kind: "update-available",
			localHead: "local-current",
			remoteHead: "remote-fresh",
		});
	});

	it("omite la red cuando el cache dice up-to-date y el HEAD local no cambió", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		await writeCache(cachePath, NOW - 60_000, "local-current", "local-current");
		const git = gitRunner("local-current", "remote-ignored");

		const result = await checkForUpdate({ now: NOW, cachePath, installDir: "/installed", runGit: git });

		expect(git).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ kind: "up-to-date" });
	});

	it("consulta la red cuando el HEAD local cambió desde el cache", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		await writeCache(cachePath, NOW - 60_000, "local-old", "local-old");
		const git = gitRunner("local-new", "remote-new");

		const result = await checkForUpdate({ now: NOW, cachePath, installDir: "/installed", runGit: git });

		expect(git).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			kind: "update-available",
			localHead: "local-new",
			remoteHead: "remote-new",
		});
	});

	it("corrige cache con remote stale (force-push / rewind) y reescribe", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		await writeCache(cachePath, NOW - 60_000, "remote-stale", "local-current");
		const git = gitRunner("local-current", "local-current");

		const result = await checkForUpdate({ now: NOW, cachePath, installDir: "/installed", runGit: git });

		expect(git).toHaveBeenCalledTimes(2);
		expect(result).toEqual({ kind: "up-to-date" });
		expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
			lastCheckMs: NOW,
			lastRemoteHead: "local-current",
			lastLocalHead: "local-current",
		});
	});

	it("comprueba ambos HEAD y persiste el resultado fuera de throttle", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		const git = gitRunner("local-old", "remote-new");

		const result = await checkForUpdate({ now: NOW, cachePath, installDir: "/installed", runGit: git });

		expect(result).toEqual({
			kind: "update-available",
			localHead: "local-old",
			remoteHead: "remote-new",
		});
		expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
			lastCheckMs: NOW,
			lastRemoteHead: "remote-new",
			lastLocalHead: "local-old",
		});
	});

	it("devuelve skipped si git no está disponible", async () => {
		const git: RunGit = vi.fn<RunGit>(async () => {
			throw Object.assign(new Error("git no encontrado"), { code: "ENOENT" });
		});

		const result = await checkForUpdate({ now: NOW, installDir: "/installed", runGit: git });

		expect(result).toEqual({ kind: "skipped" });
	});

	it("respeta AIES_NO_UPDATE_CHECK", async () => {
		process.env.AIES_NO_UPDATE_CHECK = "1";
		const git = gitRunner("local", "remote");

		const result = await checkForUpdate({ now: NOW, installDir: "/installed", runGit: git });

		expect(result).toEqual({ kind: "skipped" });
		expect(git).not.toHaveBeenCalled();
	});
});

describe("recordSuccessfulUpdate", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(path.join(tmpdir(), "aies-update-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("escribe la cache con el HEAD full del installDir", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		const git = gitRunner("abcdef1234567890abcdef1234567890abcdef12", "remote-ignored");

		await recordSuccessfulUpdate({ now: NOW, cachePath, installDir: "/installed", runGit: git });

		expect(git).toHaveBeenCalledTimes(1);
		expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({
			lastCheckMs: NOW,
			lastRemoteHead: "abcdef1234567890abcdef1234567890abcdef12",
			lastLocalHead: "abcdef1234567890abcdef1234567890abcdef12",
		});
	});

	it("no falla cuando git no está disponible (best-effort)", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		const git: RunGit = vi.fn<RunGit>(async () => {
			throw Object.assign(new Error("git no encontrado"), { code: "ENOENT" });
		});

		await expect(
			recordSuccessfulUpdate({ now: NOW, cachePath, installDir: "/installed", runGit: git }),
		).resolves.toBeUndefined();

		expect(git).toHaveBeenCalledTimes(1);
	});

	it("no hace nada cuando installDir es null", async () => {
		const cachePath = path.join(tempDir, "cache", "update-check.json");
		const git = gitRunner("head", "remote");

		await expect(
			recordSuccessfulUpdate({ now: NOW, cachePath, installDir: null, runGit: git }),
		).resolves.toBeUndefined();

		expect(git).not.toHaveBeenCalled();
	});
});

describe("formatUpdateNotice", () => {
	const upToDate: UpdateStatus = { kind: "up-to-date" };
	const skipped: UpdateStatus = { kind: "skipped" };
	const available: UpdateStatus = {
		kind: "update-available",
		localHead: "abcdef1234567890",
		remoteHead: "1234567890abcdef",
	};

	it("formatea únicamente el estado con actualización disponible", () => {
		expect(formatUpdateNotice(upToDate)).toBeNull();
		expect(formatUpdateNotice(skipped)).toBeNull();
		expect(formatUpdateNotice(available)).toBe(
			"Nueva versión de AIES disponible (local abcdef1 → remoto 1234567). Ejecutá: aies update",
		);
	});
});