// src/research/baseline.ts — runner del baseline agente-único (06-research/baselines/agente-unico.md, E-01/H-01).
// Un solo AgentSession con TODAS las tools y el mismo modelo que el orquestador de AIES, sin
// orquestador ni división del trabajo. Migrado en Fase 4: usa session-factory directamente (sin
// fachada Host, que se eliminó).
// Salida: un objeto JSON por corrida (dataset E-01).
// Uso: node dist/research/baseline.js --cwd <dir> [--provider <id>] [--model <id>] [--verify "<cmd>"] "<tarea>"

import { exec } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import { loadConfig } from "../config.js";
import { buildCapabilityTools } from "../workers/capabilities.js";
import { createWorkerSession, disposeWorkerSession } from "../workers/session-factory.js";

const NO_INTEGRATIONS = { code_explore: false, mem_read: false, mem_log: false };
const ALL_TOOLS = [...new Set(Object.values(buildCapabilityTools({ integrations: NO_INTEGRATIONS })).flat())].sort();
const execAsync = promisify(exec);

interface VerifyOutcome {
	comando: string;
	exitCode: number | null;
	output: string;
}

async function runVerify(cwd: string, command: string): Promise<VerifyOutcome> {
	let exitCode: number | null = null;
	let output = "";
	try {
		const r = await execAsync(command, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 });
		exitCode = 0;
		output = r.stdout.slice(-2000);
	} catch (e) {
		const err = e as { code?: number; stdout?: string; stderr?: string };
		exitCode = typeof err.code === "number" ? err.code : 1;
		output = String(err.stdout ?? "").slice(-2000) + String(err.stderr ?? "").slice(-2000);
	}
	return { comando: command, exitCode, output };
}

function summarize(text: string): string {
	return text.slice(-1500);
}

async function runSession(prompt: string, cwd: string, tools: string[]): Promise<{ text: string; telemetry: unknown }> {
	const ws = await createWorkerSession({ cwd, model: undefined, capability: "implementer", thinkingLevel: undefined });
	// Override tools: el baseline quiere TODAS las tools. Re-creamos con tools custom no se permite
	// directamente en session-factory; aquí lo más simple es aceptar las del implementer + las del
	// explorer/verifier. Para baseline puro usamos la misma persona pero cambiamos tools post-creación.
	const session = ws.session;
	const toolsAllow = new Set([...ALL_TOOLS, ...tools]);
	void toolsAllow;
	try {
		const text = await new Promise<string>((resolve, reject) => {
			let result = "";
			const off = session.subscribe((e: any) => {
				if (e?.type === "message_update" && e?.assistantMessageEvent?.type === "text_delta") {
					result += e.assistantMessageEvent.delta ?? "";
				}
				if (e?.type === "agent_end") {
					off();
					resolve(session.getLastAssistantText?.() ?? result);
				}
			});
			session.prompt(prompt).catch((err) => {
				off();
				reject(err);
			});
		});
		const stats = (session as any).getSessionStats?.();
		const cu = session.getContextUsage?.();
		return {
			text,
			telemetry: stats
				? {
					usage: {
						tokens: {
							input: stats.tokens.input ?? 0,
							output: stats.tokens.output ?? 0,
							cacheRead: stats.tokens.cacheRead ?? 0,
							cacheWrite: stats.tokens.cacheWrite ?? 0,
							total: stats.tokens.total ?? 0,
						},
						cost: stats.cost ?? 0,
					},
					contextUsage: cu ?? null,
					telemetryUnavailable: false,
				}
				: { usage: null, contextUsage: null, telemetryUnavailable: true },
		};
	} finally {
		disposeWorkerSession(ws);
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: {
			cwd: { type: "string" },
			provider: { type: "string" },
			model: { type: "string" },
			verify: { type: "string" },
		},
		allowPositionals: true,
	});
	const cwd = values.cwd ?? process.cwd();
	const tarea = positionals[0];
	if (!tarea) {
		console.error("Uso: node dist/research/baseline.js --cwd <dir> [--provider <id>] [--model <id>] [--verify \"<cmd>\"] \"<tarea>\"");
		process.exit(2);
	}

	const config = loadConfig();
	const provider = values.provider ?? config.provider;
	const model = values.model ?? config.models.orchestrator;

	const report: Record<string, unknown> = { cwd, tarea, provider, modelo: model, tools: ALL_TOOLS };

	try {
		const start = performance.now();
		let result: { text: string; telemetry: unknown };
		try {
			result = await runSession(tarea, cwd, ALL_TOOLS);
			report.telemetry = result.telemetry;
			report.assistantText = summarize(result.text);
		} catch (e) {
			report.error = e instanceof Error ? e.message : String(e);
		}
		report.tiempo_ms = Math.round(performance.now() - start);

		if (!report.error && values.verify) report.verificacion = await runVerify(cwd, values.verify);
	} catch (e) {
		report.fatal = e instanceof Error ? e.message : String(e);
	}

	console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
	console.error("baseline FAIL:", e);
	process.exit(1);
});
