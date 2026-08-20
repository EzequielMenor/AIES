// Test realista del bug del input en TUI.
// Arrancamos `aies` (sin --headless) con stdin crudo. Enviamos una tarea + Enter.
// Capturamos TODA la salida (stdout) y la comparamos con lo que debería pasar.
//
// El bug se manifiesta así: el usuario teclea y pulsa Enter, y la promesa inicial
// se resuelve sin que nadie la espere (el `while` aún no ha llegado al await).
// Síntomas: input se borra visualmente (porque `setInputValue("")` corre en App.tsx
// antes del callback), pero el log nunca recibe la tarea.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const child = spawn("node", [
	"-e",
	`
	Object.defineProperty(process.stdin, 'isTTY', { value: true });
	Object.defineProperty(process.stdout, 'isTTY', { value: true });
	process.stdin.setRawMode = () => process.stdin;
	process.stdin.ref = () => process.stdin;
	process.stdin.unref = () => process.stdin;
	require('./dist/cli.js');
	`,
], {
	cwd: path.resolve("."),
	stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (c) => { stdout += c.toString(); });
child.stderr.on("data", (c) => { stderr += c.toString(); });

// Limpiar sesión previa
const agentDir = `${process.env.HOME}/.pi/agent/aies`;
const before = existsSync(agentDir) ? new Set(readdirSync(agentDir)) : new Set();

// Esperar a Ink montar y enviar tarea cruda (Enter = \\r en raw mode)
setTimeout(() => {
	child.stdin.write("PROBE-TUI-INPUT-TASK\r");
}, 1200);

// Cerrar tras 3s
setTimeout(() => {
	child.kill("SIGKILL");
}, 3500);

child.on("exit", () => {
	if (!existsSync(agentDir)) {
		console.error("FAIL: no agent dir");
		process.exit(1);
	}
	const after = readdirSync(agentDir);
	const newSessions = after.filter((d) => !before.has(d));
	console.log("=== TUI input probe ===");
	console.log("new sessions:", newSessions);
	if (newSessions.length === 0) {
		console.log("FAIL: no new session created. La tarea nunca llegó al bucle.");
		console.log("stdout (last 500):", stdout.slice(-500));
		console.log("stderr (last 300):", stderr.slice(-300));
		process.exit(2);
	}
	const logPath = path.join(agentDir, newSessions[0], "log.jsonl");
	if (!existsSync(logPath)) {
		console.log("FAIL: no log.jsonl");
		process.exit(2);
	}
	const log = readFileSync(logPath, "utf-8");
	const hasTask = log.includes("PROBE-TUI-INPUT-TASK");
	const hasLoopStart = log.includes('"loop:start"');
	console.log("log entries:", log.split("\n").filter(Boolean).length);
	console.log("contains 'PROBE-TUI-INPUT-TASK':", hasTask);
	console.log("contains loop:start:", hasLoopStart);
	process.exit(hasTask ? 0 : 2);
});
