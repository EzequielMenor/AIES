// src/self-check/persistence.ts — verificación de persistencia sin pi (plan step 4).
// Round-trip state.json/log.jsonl; corrupt→clean (log conservado, ADR-008 §5); ausente→clean.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createStore } from "../persistence/file_store.js";
import { recover, isResumable } from "../persistence/recover.js";
import { initState, type RuntimeState } from "../core/state.js";
import { decisionEntry } from "../observability.js";
import type { Decision } from "../core/state.js";

function mkTmpAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "aies-persist-"));
}

const DEC: Decision = {
	operación: "obtener información",
	ajustePlan: { tipo: "determinar el proceso", unidades: [
		{ objetivo: "explore", alcance: null, infoNecesaria: null, resultadoEsperado: "info", condicionFinalizacion: "ok", capacidad: "explorer" },
	] },
	unidad: null,
	motivo: "tarea Recibida",
	condición: null,
};

function sampleState(): RuntimeState {
	const s = initState(
		{ objetivo: "test tarea", alcance: null, restricciones: ["no-touch"], resultadoEsperado: "x", condicionFinalizacion: "x ok" },
		{ maxIterations: 7, maxConsecutiveNoProgress: 3 },
	);
	return { ...s, iterations: 3, consecutiveParseFailures: 0 };
}

async function main(): Promise<void> {
	// 1) Round-trip state + log
	{
		const agentDir = mkTmpAgentDir();
		const cwd = "/fake/project";
		const store = createStore(agentDir, cwd);
		assert.equal(store.loadState().kind, "absent", "sin state.json → absent");
		assert.deepEqual(store.readLog(), [], "sin log → []");

		const state = sampleState();
		store.saveState(state);
		const loaded = store.loadState();
		assert.equal(loaded.kind, "ok", "tras save → ok");
		if (loaded.kind !== "ok") throw new Error("unreachable");
		assert.deepEqual(loaded.state, state, "round-trip state idéntico");

		store.appendLog(decisionEntry(0, DEC, false));
		store.appendLog(decisionEntry(1, DEC, false));
		const log = store.readLog();
		assert.equal(log.length, 2, "2 entradas log");
		assert.equal(log[0]?.type, "decision");
		console.log("OK round-trip: state.json + log.jsonl idénticos");
	}

	// 2) Corrupt state → clean session; log legible conservado
	{
		const agentDir = mkTmpAgentDir();
		const cwd = "/fake/corrupt";
		const store = createStore(agentDir, cwd);
		store.saveState(sampleState());
		store.appendLog(decisionEntry(0, DEC, false));
		store.appendLog(decisionEntry(1, DEC, false));
		// corrompe state.json deliberadamente (no el log)
		fs.mkdirSync(store.dir, { recursive: true });
		fs.writeFileSync(store.stateFile, "{not json", "utf8");

		let warned = "";
		const rec = recover(agentDir, cwd, (m) => (warned = m));
		assert.equal(rec.corrupt, true, "flag corrupt");
		assert.equal(rec.state, null, "corrupto → state null (sesión limpia)");
		assert.equal(rec.log.length, 2, "log.jsonl preservado pese a state corrupto");
		assert.match(warned, /corrupto → sesión limpia/);

		// isResumable: null → false; Recibida/En curso → true; Completada → false
		assert.equal(isResumable(null), false);
		assert.equal(isResumable({ ...sampleState(), taskState: "Recibida" } as RuntimeState), true);
		assert.equal(isResumable({ ...sampleState(), taskState: "En curso" } as RuntimeState), true);
		assert.equal(isResumable({ ...sampleState(), taskState: "Completada" } as RuntimeState), false);
		console.log("OK corrupt→clean: state descartado, log conservado, isResumable correcto");
	}

	// 3) Ausente → clean, log vacío
	{
		const agentDir = mkTmpAgentDir();
		const cwd = "/fake/absent";
		const rec = recover(agentDir, cwd);
		assert.equal(rec.absent, true);
		assert.equal(rec.state, null);
		assert.equal(rec.log.length, 0);
		console.log("OK absent→clean: state null, log vacío");
	}

	console.log("\nself-check persistence OK: persistencia funciona sin pi. Round-trip + corrupt + ausente verificados.");
}

main().catch((e) => {
	console.error("self-check persistence FAIL:", e);
	process.exit(1);
});