// src/self-check/extension.ts — smoke test de la extensión AIES (sin LLM, sin TUI).
//
// Verifica que el módulo de extensión es cargable, exporta una factoría por defecto y que al
// invocarla registra /run y explore. No hace llamadas a un modelo real — sólo valida la
// superficie de la API pública de la extensión.

import assert from "node:assert/strict";
import aiesExtension from "../extension/index.js";

const registeredTools: Array<{ name: string; label: string; description: string }> = [];
const registeredCommands: Array<{ name: string; description?: string | undefined }> = [];

const fakePi = {
	registerTool(tool: { name: string; label: string; description: string }) {
		registeredTools.push({ name: tool.name, label: tool.label, description: tool.description });
	},
	registerCommand(name: string, options: { description?: string | undefined; handler: unknown }) {
		registeredCommands.push({ name, description: options.description });
		assert.equal(typeof options.handler, "function", `command /${name} debe tener handler`);
	},
	on() {
		/* no-op for smoke */
	},
};

const factory = aiesExtension as unknown;
assert.equal(typeof factory, "function", "la extensión debe exportar una factoría por defecto");

(factory as (pi: typeof fakePi) => void)(fakePi);

assert.equal(registeredTools.length, 3, "debe registrar 3 tools (explore, implement, verify) en Fase 2");
const toolNames = registeredTools.map((t) => t.name).sort();
assert.deepEqual(toolNames, ["explore", "implement", "verify"], "tools esperados: explore, implement, verify");
for (const t of registeredTools) assert.match(t.description, /deleg/i, `${t.name} debe describir delegación a worker`);

assert.equal(registeredCommands.length, 3, "debe registrar 3 comandos (/run, /resume, /status) en Fase 3");
const cmdNames = registeredCommands.map((c) => c.name).sort();
assert.deepEqual(cmdNames, ["resume", "run", "status"], "comandos esperados: resume, run, status");
assert.match(registeredCommands.find((c) => c.name === "run")?.description ?? "", /bucle AIES/, "/run debe mencionar el bucle AIES");
assert.match(registeredCommands.find((c) => c.name === "resume")?.description ?? "", /reanuda/i, "/resume debe mencionar reanuda");
assert.match(registeredCommands.find((c) => c.name === "status")?.description ?? "", /estado/i, "/status debe mencionar estado");

console.log("OK extension: factoría cargable, /run + /resume + /status + explore/implement/verify registrados (Fase 3).");
