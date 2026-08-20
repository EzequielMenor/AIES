// Smoke real TUI: arranca `aies` SIN --headless. Simula una TTY (stdin.isTTY=true
// + setRawMode). Envía una tarea + Enter. Verifica que el log de la sesión contiene
// "implementar greet()" en algún log de decisión o en el task objetivo.
//
// Si el bug está presente, log NO contendrá la tarea porque la promesa inicial
// se resuelve y se descarta antes de que el while la espere.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

// Forzar que el hijo piense que está en una TTY. Usamos un script envoltorio
// que invoca `node dist/cli.js` con stdin/stdout en modo TTY simulado.
const child = spawn("node", [
	"-e",
	`
	// Forzar TTY antes de cargar nada
	const realStdin = process.stdin;
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

let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString(); });

// Esperar a que Ink monte, luego enviar la tarea cruda
setTimeout(() => {
	child.stdin.write("implementar greet() en math.ts\r");
}, 1500);

// Cerrar después de un tiempo
setTimeout(() => {
	child.kill("SIGINT");
}, 4000);

child.on("exit", () => {
	const agentDir = `${process.env.HOME}/.pi/agent/aies`;
	if (!existsSync(agentDir)) {
		console.error("FAIL: no agent dir");
		process.exit(1);
	}
	const sessions = readdirSync(agentDir)
		.map((d) => ({ d, mtime: statSync(path.join(agentDir, d)).mtime.getTime() }))
		.sort((a, b) => b.mtime - a.mtime);
	const latest = sessions[0];
	if (!latest) {
		console.error("FAIL: no sessions");
		process.exit(1);
	}
	const logPath = path.join(agentDir, latest.d, "log.jsonl");
	if (!existsSync(logPath)) {
		console.error("FAIL: no log.jsonl at", logPath);
		console.error("stderr:", stderr);
		process.exit(1);
	}
	const log = readFileSync(logPath, "utf-8");
	console.log("=== TUI input test ===");
	console.log("log entries:", log.split("\n").filter(Boolean).length);
	console.log("contains 'implementar greet':", log.includes("implementar greet"));
	console.log("contains loop:start event:", log.includes('"loop:start"') || /"type":"loop:start"/.test(log));
	console.log("stderr tail:", stderr.slice(-500));
	process.exit(log.includes("implementar greet") ? 0 : 2);
});
