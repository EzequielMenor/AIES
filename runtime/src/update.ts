import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

export const INSTALL_URL = "https://raw.githubusercontent.com/EzequielMenor/AIES/main/install.sh";
export const REPO_URL = "https://github.com/EzequielMenor/AIES.git";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 3000;
const UPDATE_CHECK_PATH = path.join(homedir(), ".cache", "aies", "update-check.json");

export interface GitCommandOptions {
	timeout: number;
}

export type RunGit = (file: string, args: string[], options: GitCommandOptions) => Promise<string>;

export type UpdateStatus =
	| { kind: "up-to-date" }
	| { kind: "update-available"; localHead: string; remoteHead: string }
	| { kind: "skipped" };

export interface CheckForUpdateOptions {
	now?: number;
	cachePath?: string;
	installDir?: string | null;
	runGit?: RunGit;
}

interface UpdateCache {
	lastCheckMs: number;
	lastRemoteHead: string;
	lastLocalHead: string;
}

function execGit(file: string, args: string[], options: GitCommandOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { ...options, encoding: "utf8" }, (error, output) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(output);
		});
	});
}

async function readLocalHead(installDir: string, runGit: RunGit): Promise<string> {
	const output = await runGit("git", ["-C", installDir, "rev-parse", "HEAD"], { timeout: GIT_TIMEOUT_MS });
	const localHead = output.trim().split(/\s+/, 1)[0];
	if (!localHead) throw new Error("git no devolvió un HEAD local");
	return localHead;
}

async function readRemoteHead(runGit: RunGit): Promise<string> {
	const output = await runGit("git", ["ls-remote", REPO_URL, "main"], { timeout: GIT_TIMEOUT_MS });
	const line = output.trim().split(/\r?\n/, 1)[0];
	const remoteHead = line?.split(/\s+/, 1)[0];
	if (!remoteHead) throw new Error("git no devolvió un HEAD remoto");
	return remoteHead;
}

function isUpdateCache(value: unknown): value is UpdateCache {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.lastCheckMs === "number" &&
		Number.isFinite(candidate.lastCheckMs) &&
		typeof candidate.lastRemoteHead === "string" &&
		candidate.lastRemoteHead.length > 0 &&
		typeof candidate.lastLocalHead === "string" &&
		candidate.lastLocalHead.length > 0
	);
}

async function readUpdateCache(cachePath: string): Promise<UpdateCache | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(cachePath, "utf8"));
		return isUpdateCache(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function writeUpdateCache(cachePath: string, cache: UpdateCache): Promise<void> {
	await mkdir(path.dirname(cachePath), { recursive: true });
	await writeFile(cachePath, JSON.stringify(cache), "utf8");
}

function statusForHeads(localHead: string, remoteHead: string): UpdateStatus {
	if (localHead === remoteHead) return { kind: "up-to-date" };
	return { kind: "update-available", localHead, remoteHead };
}

export function resolveInstallDir(): string | null {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const installDir = path.resolve(here, "..", "..");
	return existsSync(path.join(installDir, ".git")) ? installDir : null;
}

export async function checkForUpdate(opts: CheckForUpdateOptions = {}): Promise<UpdateStatus> {
	if (process.env.AIES_NO_UPDATE_CHECK !== undefined) return { kind: "skipped" };

	const installDir = opts.installDir === undefined ? resolveInstallDir() : opts.installDir;
	if (!installDir) return { kind: "skipped" };

	const now = opts.now ?? Date.now();
	const cachePath = opts.cachePath ?? UPDATE_CHECK_PATH;
	const runGit = opts.runGit ?? execGit;

	let localHead: string;
	try {
		localHead = await readLocalHead(installDir, runGit);
	} catch {
		return { kind: "skipped" };
	}

	const cached = await readUpdateCache(cachePath);
	if (cached && now - cached.lastCheckMs < CHECK_INTERVAL_MS) {
		return statusForHeads(localHead, cached.lastRemoteHead);
	}

	let remoteHead: string;
	try {
		remoteHead = await readRemoteHead(runGit);
	} catch {
		return { kind: "skipped" };
	}

	const status = statusForHeads(localHead, remoteHead);
	try {
		await writeUpdateCache(cachePath, {
			lastCheckMs: now,
			lastRemoteHead: remoteHead,
			lastLocalHead: localHead,
		});
	} catch {
	}
	return status;
}

export function formatUpdateNotice(status: UpdateStatus): string | null {
	if (status.kind !== "update-available") return null;
	const local = status.localHead.slice(0, 7);
	const remote = status.remoteHead.slice(0, 7);
	return `Nueva versión de AIES disponible (local ${local} → remoto ${remote}). Ejecutá: aies update`;
}

export async function runUpdate(): Promise<number> {
	const exitCode = await new Promise<number>((resolve) => {
		const child = spawn("bash", ["-c", `curl -fsSL ${INSTALL_URL} | bash`], { stdio: "inherit" });
		child.once("error", () => resolve(1));
		child.once("close", (code) => resolve(code ?? 1));
	});

	if (exitCode !== 0) return exitCode;

	const installDir = path.join(homedir(), ".aies");
	try {
		const newHead = (await execGit("git", ["-C", installDir, "rev-parse", "--short", "HEAD"], { timeout: GIT_TIMEOUT_MS })).trim();
		stdout.write(`AIES actualizado (${newHead || "sin HEAD disponible"}).\n`);
	} catch {
		stdout.write("AIES actualizado.\n");
	}
	return 0;
}
