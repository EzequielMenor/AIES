// src/research/baseline.ts — runner del baseline agente-único (06-research/baselines/agente-unico.md, E-01/H-01).
// Un solo AgentSession con TODAS las tools y el mismo modelo que el orquestador de AIES, sin orquestador
// ni división del trabajo. Una sola prompt; el agente trabaja solo, con sus tools, hasta decidir terminar.
// NO toca el bucle AIES (aies vs baseline se comparan a paridad de tarea en copias frescas del corpus).
// Salida: un objeto JSON por corrida (el dataset de E-01). Sin log.jsonl: el baseline no es el bucle.
// Uso: node dist/research/baseline.js --cwd <dir> [--provider <id>] [--model <id>] [--verify "<cmd>"] "<tarea>"

import { exec } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";

import { loadConfig } from "../config.js";
import { createBaselineSession } from "../pi-binding/index.js";
import { CAPABILITY_TOOLS } from "../workers/capabilities.js";
import { TurnError, type TurnResult } from "../host/types.js";

const ALL_TOOLS = [...new Set(Object.values(CAPABILITY_TOOLS).flat())].sort();
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
	const session = await createBaselineSession({
		cwd,
		provider,
		model: model as string,
		tools: ALL_TOOLS,
		id: "baseline",
	});

	try {
		const start = performance.now();
		let result: TurnResult;
		try {
			result = await session.runTurn(tarea);
			report.telemetry = result.telemetry;
			report.assistantText = summarize(result.text);
		} catch (e) {
			if (e instanceof TurnError) {
				report.telemetry = e.telemetry;
				report.error = e.message;
			} else {
				report.error = e instanceof Error ? e.message : String(e);
			}
		}
		report.tiempo_ms = Math.round(performance.now() - start);

		if (!report.error && values.verify) report.verificacion = await runVerify(cwd, values.verify);
	} finally {
		session.dispose();
	}

	console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
	console.error("baseline FAIL:", e);
	process.exit(1);
});