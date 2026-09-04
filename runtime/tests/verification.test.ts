// tests/verification.test.ts — motor de verificación determinista: descubrimiento de checks
// REALES + ejecución + captura de fallo, sin LLM (determinista por construcción).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import {
	detectPackageManager,
	discoverChecks,
	extractFailure,
	formatCheckCommand,
	runProjectChecks,
} from "../src/verification/engine.js";

let sandbox = "";

function project(options: {
	scripts?: Record<string, string>;
	files?: Record<string, string>;
	lockfiles?: string[];
	packageManager?: string;
	nodeModules?: boolean;
}): string {
	const dir = path.join(sandbox, `p-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	const pkg: Record<string, unknown> = { name: "fixture", version: "1.0.0" };
	if (options.scripts) pkg.scripts = options.scripts;
	if (options.packageManager) pkg.packageManager = options.packageManager;
	writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
	for (const lock of options.lockfiles ?? []) writeFileSync(path.join(dir, lock), "", "utf8");
	for (const [name, content] of Object.entries(options.files ?? {})) {
		const target = path.join(dir, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
	if (options.nodeModules !== false) mkdirSync(path.join(dir, "node_modules"), { recursive: true });
	return dir;
}

beforeAll(() => {
	sandbox = mkdtempSync(path.join(os.tmpdir(), "aies-verify-"));
});

afterAll(() => {
	try {
		rmSync(sandbox, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe("discoverChecks — sólo checks reales del proyecto", () => {
	it("descubre typecheck/test/lint desde scripts", () => {
		const dir = project({ scripts: { typecheck: "tsc --noEmit", test: "node -e 0", lint: "eslint ." } });
		const checks = discoverChecks(dir);
		assert.deepEqual(checks.map((c) => c.name), ["typecheck", "tests", "lint"]);
	});

	it("NO inventa flags genéricos: usa el script tal cual vía `<pm> run <script>`", () => {
		const dir = project({ scripts: { test: "vitest" }, packageManager: "pnpm@9" });
		const test = discoverChecks(dir).find((c) => c.name === "tests");
		assert.deepEqual(test?.argv, ["pnpm", "run", "test"]);
		assert.equal(formatCheckCommand(test!), "pnpm run test");
	});

	it("sin scripts, con tsconfig + typescript → typecheck tsc --noEmit con el envoltorio del pm", () => {
		const dir = project({ scripts: {} });
		// reescribir pkg con devDeps.typescript + tsconfig (helper no soporta deps, lo hacemos a mano)
		writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", devDependencies: { typescript: "^5" } }), "utf8");
		writeFileSync(path.join(dir, "tsconfig.json"), "{}", "utf8");
		const checks = discoverChecks(dir);
		assert.deepEqual(checks.map((c) => c.name), ["typecheck"]);
		assert.ok(checks[0]!.argv.includes("tsc"));
		assert.ok(checks[0]!.argv.includes("--noEmit"));
	});

	it("sin package.json → sin checks", () => {
		const dir = path.join(sandbox, `no-pkg-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(dir, { recursive: true });
		assert.deepEqual(discoverChecks(dir), []);
	});

	it("build NO se ejecuta por defecto (suficientes > todos)", () => {
		const dir = project({ scripts: { build: "tsc", test: "node -e 0" } });
		assert.deepEqual(discoverChecks(dir).map((c) => c.name), ["tests"]);
	});

	it("detecta el package manager por packageManager y lockfiles", () => {
		const byField = project({ scripts: {}, packageManager: "pnpm@9.0.0" });
		assert.equal(detectPackageManager(byField, { packageManager: "pnpm@9.0.0" }), "pnpm");
		const byLock = project({ scripts: {}, lockfiles: ["pnpm-lock.yaml"] });
		assert.equal(detectPackageManager(byLock, {}), "pnpm");
		assert.equal(detectPackageManager(project({ scripts: {} }), {}), "npm");
	});
});

describe("extractFailure", () => {
	it("filtra líneas de error relevantes", () => {
		const text = ["stdout noise", "AssertionError: expected 1 to be 2", "more noise", "1 test failed"].join("\n");
		const failure = extractFailure(text);
		assert.match(failure, /AssertionError/);
		assert.match(failure, /1 test failed/);
	});
});

describe("runProjectChecks — ejecución real determinista", () => {
	it("todos pasan → allPassed, y reporta cada línea", async () => {
		const dir = project({ scripts: { test: "node -e \"console.log('ok')\"" } });
		const started: string[] = [];
		const done: Array<{ name: string; status: string }> = [];
		const report = await runProjectChecks(dir, {
			onStart: (c) => started.push(c.name),
			onDone: (r) => done.push({ name: r.name, status: r.status }),
		});
		assert.equal(report.empty, false);
		assert.equal(report.blocked, null);
		assert.equal(report.allPassed, true, `esperado allPassed; fallos=${JSON.stringify(report.results.map((r) => [r.name, r.status, r.failure]))}`);
		assert.deepEqual(started, ["tests"]);
		assert.deepEqual(done, [{ name: "tests", status: "pass" }]);
	});

	it("fallo → allPassed=false con failureContext accionable", async () => {
		const failing = [
			"console.log('running 1 test');",
			"throw new Error('AssertionError: expected 2 to equal 1');",
		].join(" ");
		const dir = project({ scripts: { test: `node -e "${failing.replace(/"/g, '\\"')}"` } });
		const report = await runProjectChecks(dir);
		assert.equal(report.allPassed, false);
		assert.equal(report.results[0]?.status, "fail");
		assert.match(report.failureContext, /tests/);
		assert.match(report.failureContext, /AssertionError/);
	});

	it("timeout dura → status timeout sin flag en el comando", async () => {
		const dir = project({ scripts: { test: "node -e \"setTimeout(() => {}, 30000)\"" } });
		const report = await runProjectChecks(dir, { timeoutMs: 800 });
		assert.equal(report.allPassed, false);
		assert.equal(report.results[0]?.status, "timeout");
		assert.match(report.results[0]?.failure ?? "", /TIMEOUT/);
	});

	it("dependencias sin instalar → blocked (no lo llama fallo de código)", async () => {
		const dir = project({ scripts: { test: "vitest run" }, nodeModules: false });
		const report = await runProjectChecks(dir);
		assert.equal(report.blocked !== null, true);
		assert.match(report.blocked ?? "", /sin instalar/);
	});

	it("sin ningún check → empty=true (el caller delega al verifier LLM)", async () => {
		const dir = project({ scripts: {} });
		const report = await runProjectChecks(dir);
		assert.equal(report.empty, true);
	});
});
