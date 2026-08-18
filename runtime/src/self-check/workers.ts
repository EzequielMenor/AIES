// src/self-check/workers.ts — verificación del modo experimental E-01A (AIES_NO_WORKERS=1).
// Garantiza: (a) con el env activo, createWorker NUNCA se llama y cada delegación crea una
// sesión LOCAL efímera; (b) sin el env, createWorker sigue siendo el camino por defecto.
// Sin framework: `node:assert`. Cubre la frontera de delegación del execute() del bucle.

import assert from "node:assert/strict";
import { createExecute } from "../workers/index.js";
import type { Host } from "../pi-binding/index.js";
import type { HostSession } from "../host/types.js";
import type { Capability, Decision, RuntimeState, WorkUnit } from "../core/state.js";

const TELEM = {
	usage: { tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.001 },
	contextUsage: { tokens: 1500, contextWindow: 200000, percent: 0.75 },
	telemetryUnavailable: false,
};

function mockSession(text: string): HostSession {
	return {
		id: "mock",
		runTurn: async () => ({ text, telemetry: TELEM }),
		abort: async () => {},
		dispose: () => {},
	};
}

function makeUnit(id: string, capacidad: Capability): WorkUnit {
	return {
		id,
		objetivo: `objetivo-${id}`,
		alcance: null,
		infoNecesaria: null,
		resultadoEsperado: `res-${id}`,
		condicionFinalizacion: `cond-${id}`,
		capacidad,
		estado: "Pendiente",
	};
}

function dec(op: Decision["operación"], rest: Partial<Decision>): Decision {
	return {
		operación: op,
		ajustePlan: rest.ajustePlan ?? null,
		unidad: rest.unidad ?? null,
		capacidad: rest.capacidad ?? null,
		comunicación: rest.comunicación ?? null,
		motivo: rest.motivo ?? "motivo",
		condición: rest.condición ?? null,
	};
}

async function runNoDelegation(): Promise<void> {
	const prev = process.env.AIES_NO_WORKERS;
	process.env.AIES_NO_WORKERS = "1";
	try {
		let workerCalls = 0;
		let localCalls = 0;
		let orchestratorCalls = 0;
		const fakeHost: Host = {
			agentDir: "/tmp",
			createOrchestrator: async () => {
				orchestratorCalls++;
				throw new Error("createOrchestrator must NOT be called from execute()");
			},
			createWorker: async () => {
				workerCalls++;
				throw new Error("createWorker must NOT be called when AIES_NO_WORKERS=1");
			},
			createLocalSession: async (cap: Capability) => {
				localCalls++;
				return mockSession(cap === "verifier" ? "VEREDICTO: PASS — local exec" : `local-${cap}-output`);
			},
		};

		const exec = createExecute({
			host: fakeHost,
			out: () => {},
			localSessionFactory: (cap) => fakeHost.createLocalSession(cap),
		});

		const state = {
			task: {
				objetivo: "x",
				alcance: null,
				restricciones: null,
				resultadoEsperado: null,
				condicionFinalizacion: "x",
			},
			knownInfo: [],
			units: [makeUnit("u0", "implementer"), makeUnit("u1", "verifier")],
		} as unknown as RuntimeState;

		const decisions: Decision[] = [
			dec("obtener información", { motivo: "necesito contexto" }),
			dec("ejecutar una unidad", { unidad: "u0", capacidad: "implementer", motivo: "implementar" }),
			dec("ejecutar una unidad", { unidad: "u1", capacidad: "verifier", motivo: "verificar" }),
			dec("terminar", { condición: "cumplida" }),
		];

		const outs = [];
		for (const d of decisions) outs.push(await exec(state, d));

		assert.equal(orchestratorCalls, 0, "createOrchestrator no se llama desde execute()");
		assert.equal(workerCalls, 0, "createWorker MUST NEVER be called when AIES_NO_WORKERS=1");
		assert.equal(localCalls, 3, "localSessionFactory llamado una vez por delegación (3)");
		assert.equal(outs.length, 4);

		// Las 3 delegaciones llevan atribución=orquestador y telemetría real (no NO_TELEM).
		for (let i = 0; i < 3; i++) {
			assert.equal(outs[i]!.atribución, "orquestador", `delegación ${i}: atribución=orquestador`);
			assert.ok(outs[i]!.telemetry.usage, `delegación ${i}: telemetría real (no NO_TELEM)`);
		}
		// explorer → kind=info
		assert.equal(outs[0]!.result.kind, "info", "explorer → info");
		assert.equal(outs[0]!.result.unidadId, null);
		// implementer → kind=unidad, passed=true (no es verifier)
		assert.equal(outs[1]!.result.kind, "unidad", "implementer → unidad");
		assert.equal((outs[1]!.result as { passed: boolean | null }).passed, true);
		assert.equal(outs[1]!.result.unidadId, "u0");
		// verifier → kind=unidad, passed=true (parseVerdict encontró VEREDICTO: PASS)
		assert.equal(outs[2]!.result.kind, "unidad", "verifier → unidad");
		assert.equal((outs[2]!.result as { passed: boolean | null }).passed, true, "verifier PASS → passed=true");
		assert.equal(outs[2]!.result.unidadId, "u1");
		// terminar → no lleva atribución (es sintético local de execute, no delegación)
		assert.equal(outs[3]!.atribución ?? null, null, "terminar: sin atribución (no es delegación)");

		console.log("OK no-workers: AIES_NO_WORKERS=1 → 0 createWorker, 3 sesiones locales nuevas, atribución=orquestador en delegaciones");
	} finally {
		if (prev === undefined) delete process.env.AIES_NO_WORKERS;
		else process.env.AIES_NO_WORKERS = prev;
	}
}

async function runNormalStillDelegates(): Promise<void> {
	const prev = process.env.AIES_NO_WORKERS;
	delete process.env.AIES_NO_WORKERS;
	try {
		let workerCalls = 0;
		let localCalls = 0;
		const fakeHost: Host = {
			agentDir: "/tmp",
			createOrchestrator: async () => { throw new Error("nope"); },
			createWorker: async () => { workerCalls++; return mockSession("worker output"); },
			createLocalSession: async () => { localCalls++; return mockSession("nope"); },
		};
		const exec = createExecute({
			host: fakeHost,
			out: () => {},
			localSessionFactory: (cap) => fakeHost.createLocalSession(cap),
		});
		const state = { units: [] } as unknown as RuntimeState;
		const r = await exec(state, dec("obtener información", { motivo: "info" }));
		assert.equal(workerCalls, 1, "sin env: createWorker es el camino por defecto");
		assert.equal(localCalls, 0, "sin env: localSessionFactory NO se llama");
		assert.equal(r.atribución ?? null, null, "sin env: resultado sin atribución experimental");
		console.log("OK default (sin env): createWorker sigue siendo el camino por defecto");
	} finally {
		if (prev !== undefined) process.env.AIES_NO_WORKERS = prev;
	}
}

async function main(): Promise<void> {
	await runNoDelegation();
	await runNormalStillDelegates();
	console.log("\nself-check OK: frontera de delegación respeta AIES_NO_WORKERS=1.");
}

main().catch((e) => {
	console.error("self-check FAIL:", e);
	process.exit(1);
});
