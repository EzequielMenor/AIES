#!/usr/bin/env node
// AIES-core runtime CLI (v0). Entrypoint dueño del bucle; pi es el motor de workers (ADR-009).
// `aies run "<tarea>"` | `aies resume` | `aies --help` | `aies --stop` (v0: SIGINT durante run).

import * as path from "node:path";
import { parseArgs } from "node:util";

import { loadConfig } from "./config.js";
import { createHost } from "./pi-binding/index.js";
import { createStore } from "./persistence/file_store.js";
import { isResumable, recover } from "./persistence/recover.js";
import { ORCHESTRATOR_SYSTEM_PROMPT, createDecide } from "./orchestrator/index.js";
import { createExecute } from "./workers/index.js";
import { CAPABILITY_TOOLS } from "./workers/capabilities.js";
import { createStopSignal } from "./intervention.js";
import { limitsFromConfig } from "./limits.js";
import { initState, type RuntimeState, type Task } from "./core/state.js";
import type { CompactionObservation } from "./telemetry/types.js";
import { runLoop } from "./core/loop.js";
import { compactionEntry, syntheticDecision } from "./observability.js";

function printHelp(): void {
	console.log(`aies — AIES-core runtime (v0)

Uso:
  aies run "<tarea>"     Inicia o (si ya hay tarea En curso/Recibida) reanuda el bucle sobre la tarea
  aies resume            Reanuda la tarea no-terminal desde su "siguiente paso" (ADR-008 §4)
  aies --stop            v0: la intervención se hace con SIGINT (Ctrl-C) durante un run (Runtime §7)

Opciones:
  --cwd <dir>            Directorio del proyecto (defecto: process.cwd())
  -h, --help             Muestra esta ayuda

Persistencia (ADR-008):  <agentDir>/aies/<hash(cwd)>/{state.json, log.jsonl}
Config:                  runtime/aies.config.json (provider+modelos por rol; SIN claves)
Claves:                  por env (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, ...)

Intervención: SIGINT detiene ordenadamente (Tarea → Fallida por intervención). 2ª SIGINT fuerza salida.
`);
}

function deriveCompletion(tarea: string): string {
	return `objetivo cumplido y verificado: ${tarea}`;
}

async function runRuntime(command: "run" | "resume", tarea: string | undefined, cwd: string): Promise<void> {
	const config = loadConfig();
	const host = await createHost({
		cwd,
		provider: config.provider,
		models: config.models,
		thinking: { orchestrator: config.orchestratorThinkingLevel },
		workerTools: CAPABILITY_TOOLS,
		orchestratorSystemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
	});

	const store = createStore(host.agentDir, cwd);
	const rec = recover(host.agentDir, cwd, (m) => console.error(`[persistencia] ${m}`));

	let state: RuntimeState;
	if (command === "resume") {
		if (!isResumable(rec.state)) {
			console.error("No hay tarea reanudable (state.json ausente/corrupto o ya terminal). Usa `aies run \"<tarea>\"`.");
			process.exit(2);
		}
		state = rec.state!;
		console.log(`[resume] reanudando tarea (${state.taskState}, iter ${state.iterations})`);
	} else {
		// run: si hay tarea no-terminal previa → se reanuda (MVP-v0-Scope §3, aceptación §6).
		if (isResumable(rec.state)) {
			state = rec.state!;
			console.warn(`[run] existe una tarea ${state.taskState} (iter ${state.iterations}); reanudando. (Nueva tarea ignorada.)`);
		} else {
			if (!tarea) {
				console.error("Uso: aies run \"<tarea>\"");
				process.exit(2);
			}
			const task: Task = { objetivo: tarea, alcance: null, restricciones: null, resultadoEsperado: null, condicionFinalizacion: deriveCompletion(tarea) };
			state = initState(task, limitsFromConfig(config));
			if (rec.corrupt) store.appendLog(syntheticDecision(0, "comunicar al desarrollador", "sesión limpia (state.json corrupto); log previo conservado"));
			else if (rec.absent) store.appendLog(syntheticDecision(0, "comunicar al desarrollador", "sesión nueva (sin state.json previo)"));
			console.log(`[run] nueva tarea: ${tarea}`);
		}
	}

	// Observación del techo de contexto del host (RNF-18/19): cada compaction_start/end
	// deja huella en log.jsonl (06-research/H-01). No es una vuelta del bucle.
	const emitCompaction = (o: CompactionObservation) => store.appendLog({ ...compactionEntry(o), ts: new Date().toISOString() });

	const orchSession = await host.createOrchestrator(emitCompaction);
	const stop = createStopSignal();
	const out = (m: string) => console.log(`\n[orquestador → desarrollador] ${m}`);

	const finalState = await runLoop(state, {
		decide: createDecide({ session: orchSession }),
		execute: createExecute({
			host,
			out,
			onCompaction: emitCompaction,
			// E-01A experimental: con AIES_NO_WORKERS=1, las delegaciones usan una sesión local
			// efímera por unidad (misma persona/tools/modelo que un worker normal) en lugar de
			// host.createWorker. La telemetría resultante se atribuye al orquestador en metrics.ts.
			localSessionFactory: process.env.AIES_NO_WORKERS === "1"
				? (cap) => host.createLocalSession(cap, emitCompaction)
				: undefined,
		}),
		emit: (entry) => store.appendLog({ ...entry, ts: new Date().toISOString() }),
		onLimit: () => "intervenir",
		stopSignal: stop.stopSignal,
	});

	orchSession.dispose();
	stop.dispose();
	store.saveState(finalState);

	console.log("\n=== resumen ===");
	console.log(`tarea          : ${finalState.task.objetivo}`);
	console.log(`estado terminal: ${finalState.taskState}`);
	console.log(`iteraciones    : ${finalState.iterations} / ${finalState.limits.maxIterations}`);
	if (finalState.terminalCondition) console.log(`condición       : ${finalState.terminalCondition}`);
	if (finalState.taskState === "En curso" || finalState.taskState === "Recibida") {
		console.log(`siguiente paso  : ${finalState.nextStep}`);
		console.log("(tarea no terminal: `aies resume` para continuar tras intervención/clave.)");
	}
	console.log(`state.json     : ${store.stateFile}`);
	console.log(`log.jsonl      : ${store.logFile}  (${store.readLog().length} entradas)`);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			help: { type: "boolean", short: "h" },
			cwd: { type: "string" },
			stop: { type: "boolean" },
		},
	});

	if (values.help) {
		printHelp();
		process.exit(0);
	}
	if (values.stop) {
		console.log("aies --stop (v0): la intervención se realiza con SIGINT (Ctrl-C) durante `aies run`. No hay daemon en v0.");
		process.exit(0);
	}
	if (positionals.length === 0) {
		printHelp();
		process.exit(0);
	}

	const command = positionals[0];
	const tarea = positionals.slice(1).join(" ") || undefined;
	const cwd = path.resolve(values.cwd ?? process.cwd());

	if (command !== "run" && command !== "resume") {
		console.error(`aies: comando desconocido "${command}". Ver --help.`);
		process.exit(2);
	}

	try {
		await runRuntime(command, tarea, cwd);
	} catch (e) {
		console.error(`\n[fatal] ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}

main();