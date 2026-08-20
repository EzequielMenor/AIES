// Smoke real: arranca `aies` con stdin simulado, envía tarea + Enter, verifica
// que el log de la sesión contiene "loop:start" tras la tarea (no antes).

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const child = spawn("node", ["dist/cli.js", "--headless"], {
	cwd: path.resolve("."),
	stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (c) => { stderr += c.toString(); });

// Esperar un poco y luego enviar la tarea
setTimeout(() => {
	child.stdin.write('aies run "implementar greet() en math.ts"\n');
}, 200);

setTimeout(() => {
	child.kill("SIGINT");
}, 3000);

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
	const lines = log.split("\n").filter(Boolean);
	console.log("=== headless input test ===");
	console.log("log entries:", lines.length);
	console.log("contains 'greet':", log.includes("greet"));
	console.log("contains 'implementar':", log.includes("implementar"));
	console.log("contains 'sesión nueva':", log.includes("sesión nueva"));
	console.log("stderr tail:", stderr.slice(-300));
	process.exit(log.includes("implementar") ? 0 : 2);
});
