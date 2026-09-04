// src/verification/engine.ts — verificación determinista ANTES de gastar tokens del verifier LLM.
//
// Reglas (autoridad superior al plan):
//   - Sólo ejecuta checks REALES del proyecto (scripts de package.json detectados, o `tsc
//     --noEmit` cuando hay tsconfig + typescript como dependencia). NUNCA se añaden flags
//     genéricos (`--watch=false`, `--ci`) a comandos arbitrarios suponiendo que el runner los
//     soporta.
//   - No es obligatorio correr typecheck+test+lint+build siempre: se ejecutan los detectados,
//     priorizando los suficientes para demostrar la corrección (build queda fuera por defecto).
//   - Cada check tiene timeout duro (default 30 s) porque no podemos confiar en que un runner
//     scriptado no se quede colgado (watch mode, prompts interactivos). El kill por timeout NO
//     añade flags al comando: es del proceso padre (SIGKILL al grupo).
//   - `CI=1` se pone en el ENTORNO del hijo (no es un flag): los runners estándar
//     (vitest/jest) corren una vez y salen bajo CI / no-TTY.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface ProjectCheck {
	/** Nombre legible: typecheck | tests | lint. */
	name: string;
	/** argv completo a ejecutar (sin shell): ["pnpm","run","test"] etc. */
	argv: string[];
}

export type CheckStatus = "pass" | "fail" | "timeout" | "error";

export interface CheckResult {
	name: string;
	command: string;
	status: CheckStatus;
	/** stdout+stderr combinado (recortado para contexto de reparación). */
	output: string;
	/** Salida relevante para el fix: líneas de fallo extraídas. */
	failure: string;
}

export interface ProjectChecksReport {
	results: CheckResult[];
	allPassed: boolean;
	/** true cuando NO hay ningún check determinista disponible (⇒ fallback legítimo al verifier LLM). */
	empty: boolean;
	/** El entorno impide verificar (p. ej. dependencias sin instalar): NO es fallo de código. */
	blocked: string | null;
	/** Salida concatenada de los checks fallidos, para el contexto de reparación. */
	failureContext: string;
}

export const DEFAULT_CHECK_TIMEOUT_MS = 30_000;

/** Tail máximo del output de un check que se conserva (evita volcar megas al prompt/terminal). */
const OUTPUT_TAIL_CHARS = 4_000;

// ──────────────────────────────────────────────────────────────────────────────
// Descubrimiento
// ──────────────────────────────────────────────────────────────────────────────

interface PackageJson {
	name?: unknown;
	scripts?: Record<string, unknown>;
	packageManager?: unknown;
	dependencies?: Record<string, unknown>;
	devDependencies?: Record<string, unknown>;
}

function readPackageJson(cwd: string): PackageJson | null {
	const file = path.join(cwd, "package.json");
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
	} catch {
		return null;
	}
}

export type PackageManager = "npm" | "pnpm" | "yarn";

/** `packageManager:` de package.json manda; si no, lockfiles; si no, npm. */
export function detectPackageManager(cwd: string, pkg: PackageJson | null): PackageManager {
	const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
	if (declared.startsWith("pnpm")) return "pnpm";
	if (declared.startsWith("yarn")) return "yarn";
	if (declared.startsWith("npm")) return "npm";
	if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(path.join(cwd, "yarn.lock"))) return "yarn";
	return "npm";
}

function execArgs(pm: PackageManager, binary: string, args: string[]): string[] {
	if (pm === "pnpm") return ["pnpm", "exec", binary, ...args];
	if (pm === "yarn") return ["yarn", binary, ...args];
	return ["npx", binary, ...args];
}

function hasScript(pkg: PackageJson | null, name: string): string | null {
	const value = pkg?.scripts?.[name];
	return typeof value === "string" && value.trim().length > 0 ? name : null;
}

function hasTypeScript(pkg: PackageJson | null): boolean {
	return Boolean(pkg?.devDependencies?.typescript ?? pkg?.dependencies?.typescript);
}

/**
 * Descubre los checks reales del proyecto en `cwd`. Orden intencional: typecheck (rápido y
 * barato) antes que tests; lint al final (suele ser el menos demostrativo de corrección).
 * `build` NO se incluye: es lento y rara vez aporta más señal que typecheck+tests
 * (corrección: suficientes > todos).
 */
export function discoverChecks(cwd: string): ProjectCheck[] {
	const pkg = readPackageJson(cwd);
	if (!pkg) return [];
	const pm = detectPackageManager(cwd, pkg);
	const checks: ProjectCheck[] = [];

	const typecheckScript = hasScript(pkg, "typecheck") ?? hasScript(pkg, "type-check") ?? hasScript(pkg, "check-types");
	if (typecheckScript) {
		checks.push({ name: "typecheck", argv: [pm, "run", typecheckScript] });
	} else if (existsSync(path.join(cwd, "tsconfig.json")) && hasTypeScript(pkg)) {
		checks.push({ name: "typecheck", argv: execArgs(pm, "tsc", ["--noEmit"]) });
	}

	if (hasScript(pkg, "test")) {
		checks.push({ name: "tests", argv: [pm, "run", "test"] });
	}

	if (hasScript(pkg, "lint")) {
		checks.push({ name: "lint", argv: [pm, "run", "lint"] });
	}

	return checks;
}

// ──────────────────────────────────────────────────────────────────────────────
// Ejecución
// ──────────────────────────────────────────────────────────────────────────────

export function formatCheckCommand(check: ProjectCheck): string {
	return check.argv.join(" ");
}

/** Recorta conservando cabecera + cola si el texto es largo. */
function trimOutput(text: string, max = OUTPUT_TAIL_CHARS): string {
	if (text.length <= max) return text;
	const head = text.slice(0, Math.floor(max / 3));
	const tail = text.slice(-Math.floor((max * 2) / 3));
	return `${head}\n… (${text.length - max} chars omitidos) …\n${tail}`;
}

/** Extrae las líneas de error relevantes (assertions, ✗/FAIL, error TS, "failed") para el fix. */
export function extractFailure(text: string): string {
	const lines = text.split("\n");
	const noisy = lines.filter((l) => /(assert|expected|error TS|\bFAIL(?:ED|ING)?\b|✗|failed|Error\b|cannot find|is not defined|SyntaxError|TypeError)/i.test(l));
	const picked = noisy.length > 0 ? noisy : lines.slice(-15);
	return trimOutput(picked.join("\n").trim(), 2_500);
}

async function runCheck(check: ProjectCheck, cwd: string, timeoutMs: number): Promise<CheckResult> {
	const command = formatCheckCommand(check);
	return new Promise<CheckResult>((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let killedByTimeout = false;
		let lastCode: number | null = null;
		let spawnError: Error | null = null;
		let child: ReturnType<typeof spawn>;
		try {
			// detached: grupo de procesos propio → el timeout mata al wrapper del pm Y a sus hijos.
			child = spawn(check.argv[0]!, check.argv.slice(1), {
				cwd,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, CI: "1" },
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			resolve({ name: check.name, command, status: "error", output: msg, failure: msg });
			return;
		}
		let timer: ReturnType<typeof setTimeout>;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const combined = trimOutput([stdout.trim(), stderr.trim()].filter(Boolean).join("\n"));
			if (killedByTimeout) {
				resolve({
					name: check.name,
					command,
					status: "timeout",
					output: combined,
					failure: `TIMEOUT tras ${timeoutMs}ms — el comando no finalizó:\n${extractFailure(combined) || command}`,
				});
				return;
			}
			if (spawnError) {
				const detail = combined || spawnError.message;
				resolve({ name: check.name, command, status: "error", output: detail, failure: extractFailure(detail) });
				return;
			}
			resolve({
				name: check.name,
				command,
				status: lastCode === 0 ? "pass" : "fail",
				output: combined,
				failure: lastCode === 0 ? "" : extractFailure(combined || `${command} terminó con código ${lastCode ?? "?"}`),
			});
		};
		const killTree = (): void => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* ya muerta */
				}
			}
		};
		timer = setTimeout(() => {
			killedByTimeout = true;
			killTree();
			// El SIGKILL debería cerrar los pipes y disparar `close`; si algún nieto huérfano los
			// retiene, resolver tras un grace corto para no colgar la verificación.
			setTimeout(finish, 500).unref();
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (e: Error) => {
			spawnError = e;
			finish();
		});
		child.on("close", (code) => {
			lastCode = code;
			finish();
		});
	});
}

/**
 * Ejecuta los checks detectados en orden (todos aportan señal), invocando
 * `onStart`/`onDone` para que el renderer pinte la línea viva y su ✓/✗.
 */
export async function runProjectChecks(
	cwd: string,
	opts: {
		timeoutMs?: number;
		onStart?: (check: ProjectCheck) => void;
		onDone?: (result: CheckResult) => void;
	} = {},
): Promise<ProjectChecksReport> {
	const checks = discoverChecks(cwd);
	if (checks.length === 0) {
		return { results: [], allPassed: false, empty: true, blocked: null, failureContext: "" };
	}

	const pkg = readPackageJson(cwd);
	const pm = detectPackageManager(cwd, pkg);
	// Dependencias sin instalar → los checks fallarían por entorno, no por el cambio.
	if (pkg && !existsSync(path.join(cwd, "node_modules"))) {
		const reason = `dependencias sin instalar en ${cwd} — ejecuta "${pm} install" antes de verificar`;
		return { results: [], allPassed: false, empty: false, blocked: reason, failureContext: reason };
	}

	const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
	const results: CheckResult[] = [];
	for (const check of checks) {
		opts.onStart?.(check);
		const result = await runCheck(check, cwd, timeoutMs);
		opts.onDone?.(result);
		results.push(result);
	}
	const failed = results.filter((r) => r.status !== "pass");
	const failureContext = failed.map((r) => `# ${r.name} (${r.command}) — ${r.status}\n${r.failure}`).join("\n\n");
	return { results, allPassed: failed.length === 0, empty: false, blocked: null, failureContext };
}
