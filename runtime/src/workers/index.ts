// src/workers/index.ts — ExecuteFn del bucle (MVP-v0-Scope §1, ADR-009 §2, ADR-002).
// Ejecuta la operación delegando a la capability por worker Host efímero (SessionManager.inMemory).
// Verifier SIN edit/write: si ver necesita modificar → OTRA unidad de Implementer (no edita él).
// Dominio+pi-binding(Host): sin tipos de pi (Host devuelve HostSession).
// E-01A: si AIES_NO_WORKERS=1 y deps.localSessionFactory presente, la delegación se sustituye
// por una sesión LOCAL efímera (nueva por llamada, dispose() en finally) con la misma persona/
// tools/modelo/prompt que el worker normal; su telemetría se marca atribución:"orquestador".

import type { Host } from "../pi-binding/index.js";
import type { HostSession } from "../host/types.js";
import type { CompactionObservation, WorkerTelemetry } from "../telemetry/types.js";
import type { Capability, Decision, OperationResult, RuntimeState, WorkUnit } from "../core/state.js";
import type { ExecuteFn } from "../core/loop.js";

const NO_TELEM: WorkerTelemetry = { usage: null, contextUsage: null, telemetryUnavailable: false };

const NO_WORKERS_ENV = "AIES_NO_WORKERS";

export interface ExecuteDeps {
	host: Host;
	out: (msg: string) => void; // canal de comunicación al desarrollador
	/** Observación de compactación del host (RNF-18/19): se reenvía al llamador (log.jsonl). */
	onCompaction?: (o: CompactionObservation) => void;
	/** E-01A experimental (opt-in por env AIES_NO_WORKERS=1): factory de sesión LOCAL efímera
	 * por capacidad. Si está presente, se usa en lugar de host.createWorker(cap). Sesión nueva
	 * por llamada (no reuse entre unidades), dispose() en finally, misma persona/tools/modelo
	 * que un worker normal. La salida lleva `atribución: "orquestador"` para que metrics.ts
	 * sume su telemetría al orquestador en lugar de a workers. */
	localSessionFactory?: ((cap: Capability) => Promise<HostSession>) | undefined;
}

function persona(cap: Capability): string {
	switch (cap) {
		case "explorer":
			return "Eres el EXPLORER de AIES. Reúne información DEL PROYECTO de sólo lectura (read/grep/find/ls). NO modificas nada Devuelve un resumen ESTRUCTURADO de lo encontrado (archivos, símbolos, convenciones relevantes al objetivo).";
		case "implementer":
			return "Eres el IMPLEMENTER de AIES. Realiza el cambio mínimo que satisface la unidad (puedes edit/write/bash/grep/find). Haz SOLO lo que la unidad pide; nada superfluo. Describe brevemente el cambio realizado.";
		case "verifier":
			return "Eres el VERIFIER de AIES (ADR-002). Verificas ejecutando comprobaciones (read/bash/grep/find/ls): typecheck, tests, build. NO editas ni escribes: si hace falta arreglar algo, NO lo haces (lo delega otra unidad). Termina SIEMPRE con una LÍNEA final `VEREDICTO: PASS` o `VEREDICTO: FAIL` seguida de la evidencia (qué ejecutaste, resultado, conteo).";
	}
}

function buildWorkerPrompt(cap: Capability, state: RuntimeState, unit: WorkUnit | null, motivo: string): string {
	const lines: string[] = [];
	lines.push(persona(cap));
	lines.push("# Tarea");
	lines.push(`- objetivo: ${state.task.objetivo}`);
	if (state.task.resultadoEsperado) lines.push(`- resultado esperado: ${state.task.resultadoEsperado}`);
	lines.push(`- condición de finalización: ${state.task.condicionFinalizacion}`);
	if (state.knownInfo.length) {
		lines.push("# Información conocida (resumida)");
		state.knownInfo.forEach((i) => lines.push(`- ${i}`));
	}
	if (unit) {
		lines.push("# Unidad a ejecutar");
		lines.push(`- id: ${unit.id}`);
		lines.push(`- objetivo: ${unit.objetivo}`);
		if (unit.alcance) lines.push(`- alcance: ${unit.alcance}`);
		if (unit.infoNecesaria) lines.push(`- información necesaria: ${unit.infoNecesaria}`);
		lines.push(`- resultado esperado: ${unit.resultadoEsperado}`);
		lines.push(`- condición de finalización: ${unit.condicionFinalizacion}`);
	} else {
		lines.push("# Información a obtener");
		lines.push(`- por qué se necesita: ${motivo}`);
	}
	if (cap === "verifier") lines.push("# Recuerda: termina con `VEREDICTO: PASS` o `VEREDICTO: FAIL` + evidencia.");
	return lines.join("\n");
}

/** Extrae el veredicto del Verifier. Acepta literal `VEREDICTO: PASS|FAIL` y, como fallback, una
 * línea con PASS/FAIL aislado precedido por `veredicto` (cualquier casing) sin dos puntos firmes.
 * Desconocido → FAIL (no verificado, P-12). No se acota a heurísticas ruidosas (e.g. `**PASS**` aislado). */
function parseVerdict(text: string): boolean {
	const m = text.match(/(?:VEREDICTO\s*:?\s*|veredicto\s+)(PASS|FAIL)\b/i);
	if (!m) return false;
	return m[1]!.toUpperCase() === "PASS";
}

/** E-01A: ejecuta la unidad en una sesión LOCAL efímera (misma fábrica que un worker normal,
 * con persona/tools/modelo/prompt del cap). Sesión nueva por llamada, dispose() en finally.
 * La salida lleva `atribución: "orquestador"` para que metrics.ts atribuya los tokens al
 * orquestador. Mantiene la forma de resultado de las ramas worker (mismo kind/passed). */
async function runLocal(
	deps: ExecuteDeps,
	cap: Capability,
	state: RuntimeState,
	unit: WorkUnit | null,
	motivo: string,
): Promise<{ result: OperationResult; telemetry: WorkerTelemetry; atribución: "orquestador" }> {
	if (!deps.localSessionFactory) {
		// Defensa en profundidad: el caller (createExecute) garantiza que localMode=true ⇒ factory presente.
		throw new Error("runLocal llamado sin localSessionFactory (bug interno de createExecute)");
	}
	const session = await deps.localSessionFactory(cap);
	try {
		const r = await session.runTurn(buildWorkerPrompt(cap, state, unit, motivo));
		if (cap === "explorer") {
			return {
				result: { kind: "info", text: r.text, unidadId: null, passed: null },
				telemetry: r.telemetry,
				atribución: "orquestador",
			};
		}
		const passed = cap === "verifier" ? parseVerdict(r.text) : true;
		return {
			result: { kind: "unidad", text: r.text, unidadId: unit?.id ?? null, passed },
			telemetry: r.telemetry,
			atribución: "orquestador",
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (cap === "explorer") {
			return {
				result: { kind: "fallo", text: `obtener información falló: ${msg}`, unidadId: null, passed: false },
				telemetry: NO_TELEM,
				atribución: "orquestador",
			};
		}
		return {
			result: { kind: "fallo", text: `unidad ${unit?.id ?? "(sin unidad)"} falló: ${msg}`, unidadId: unit?.id ?? null, passed: false },
			telemetry: NO_TELEM,
			atribución: "orquestador",
		};
	} finally {
		session.dispose();
	}
}

/** Construye el ExecuteFn que ejecuta la operación delegando a workers de pi (Host). */
export function createExecute(deps: ExecuteDeps): ExecuteFn {
	const localMode = process.env[NO_WORKERS_ENV] === "1" && deps.localSessionFactory !== undefined;
	return async (state: RuntimeState, decision: Decision): Promise<{ result: OperationResult; telemetry: WorkerTelemetry; atribución?: "orquestador" | null }> => {
		switch (decision.operación) {
			case "comunicar al desarrollador": {
				const text = decision.comunicación ?? "";
				deps.out(text);
				return { result: { kind: "comunicación", text, unidadId: null, passed: null }, telemetry: NO_TELEM };
			}
			case "terminar": {
				// La declara el orquestador (Runtime-Model §4). El worker devuelve un resultado NEUTRO
				// (passed=null): la decisión de Completada/Fallida la toma el bucle (loop.ts) en
				// función de outcomes {execution, verification, scope}. Mantenemos la detección de
				// "inviable" sólo para preservar la semántica: si la condición es inviable, devolvemos
				// passed=false; en cualquier otro caso passed=null (neutro).
				const cond = decision.condición ?? "";
				const inviable = /sin (continuación|v([íi])a viable)|no hay (continuación|v([íi])a)|^inviable|irrecuperable/i.test(cond);
				return {
					result: {
						kind: "terminación",
						text: inviable ? (cond || "sin continuación viable") : "finalización declarada",
						unidadId: null,
						passed: inviable ? false : null,
					},
					telemetry: NO_TELEM,
				};
			}
			case "obtener información": {
				if (localMode) return runLocal(deps, "explorer", state, null, decision.motivo);
				const session = await deps.host.createWorker("explorer", deps.onCompaction);
				try {
					const r = await session.runTurn(buildWorkerPrompt("explorer", state, null, decision.motivo));
					return { result: { kind: "info", text: r.text, unidadId: null, passed: null }, telemetry: r.telemetry };
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return { result: { kind: "fallo", text: `obtener información falló: ${msg}`, unidadId: null, passed: false }, telemetry: NO_TELEM };
				} finally {
					session.dispose();
				}
			}
			case "ejecutar una unidad": {
				const unitId = decision.unidad;
				const unit = unitId ? (state.units.find((u) => u.id === unitId) ?? null) : null;
				if (!unit) {
					return {
						result: { kind: "fallo", text: `unidad no encontrada en el estado: ${unitId ?? "(sin unidad)"}`, unidadId: unitId, passed: false },
						telemetry: NO_TELEM,
					};
				}
				const cap: Capability = decision.capacidad ?? unit.capacidad;
				if (localMode) return runLocal(deps, cap, state, unit, decision.motivo);
				const session = await deps.host.createWorker(cap, deps.onCompaction);
				try {
					const r = await session.runTurn(buildWorkerPrompt(cap, state, unit, decision.motivo));
					const passed = cap === "verifier" ? parseVerdict(r.text) : true;
					return {
						result: { kind: "unidad", text: r.text, unidadId: unit.id, passed },
						telemetry: r.telemetry,
					};
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return { result: { kind: "fallo", text: `unidad ${unit.id} falló: ${msg}`, unidadId: unit.id, passed: false }, telemetry: NO_TELEM };
				} finally {
					session.dispose();
				}
			}
		}
	};
}
