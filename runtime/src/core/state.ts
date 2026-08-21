// src/core/state.ts — estado del runtime (Runtime-Model.md §3.1 + perfil de límites ADR-005).
// Dominio puro: sin pi. Tipos + helpers de transición de estado (sin ejecución).
// La serialización concreta (state.json) la elige el implementador dentro de estos conceptos (plan C1).

// --- Catálogos (exactos de Runtime-Model §4 / Decision-Model §4.2 / MVP-v0-Scope §1) ---

export type TaskState = "Recibida" | "En curso" | "Completada" | "Fallida";
export type UnitState = "Pendiente" | "En curso" | "Terminada" | "Fallida";
export type Operation = "obtener información" | "ejecutar una unidad" | "comunicar al desarrollador" | "terminar";
export type AjustePlanTipo = "descomponer" | "re-descomponer" | "cambiar de estrategia" | "determinar el proceso";
export type Capability = "explorer" | "implementer" | "verifier";

// --- Outcomes (instrumentación Fix 3): execution / verification / scope explícitos en el estado.
// execution: la ruta de terminación del bucle tuvo éxito (orquestador declaró terminar y no fue
//   declarada inviable). NO incluye verificación de unidades ni alcance.
// verification: agregación de resultados de unidades previas con passed≠null. pass=todas passed=true,
//   fail=alguna passed=false, unknown=sin unidades evaluables. NO se infiere de IDs/disco.
// scope: criterio de alcance del objetivo. SIEMPRE "unknown" hasta que se defina un criterio
//   explícito (sin expected_artifacts por ahora). NO se infiere de units[].estado ni de disco.
export type ExecutionOutcome = "success" | "fail";
export type VerificationOutcome = "pass" | "fail" | "unknown";
export type ScopeOutcome = "pass" | "fail" | "unknown";

export interface Outcomes {
	execution: ExecutionOutcome;
	verification: VerificationOutcome;
	scope: ScopeOutcome;
}

// --- Tarea y unidad (Task-Model.md §1/§2) ---

export interface Task {
	objetivo: string;
	alcance: string | null;
	restricciones: string[] | null;
	resultadoEsperado: string | null;
	condicionFinalizacion: string;
}

export interface WorkUnit {
	id: string;
	objetivo: string;
	alcance: string | null;
	infoNecesaria: string | null;
	resultadoEsperado: string;
	condicionFinalizacion: string;
	capacidad: Capability;
	estado: UnitState;
}

/** Definición de unidad dentro de ajustePlan.unidades (Task-Model §2). Sin contenido ejecutable (plan C3). */
export interface UnitDefinition {
	objetivo: string;
	alcance: string | null;
	infoNecesaria: string | null;
	resultadoEsperado: string;
	condicionFinalizacion: string;
	capacidad: Capability;
}

/** Faceta de plan de la decisión (Decision-Model §4.2). Hermana de operación, no anidada. Sólo {tipo, unidades[]}. */
export interface AjustePlan {
	tipo: AjustePlanTipo;
	unidades: UnitDefinition[];
}

/** Decisión del orquestador (Decision-Model §2/§4). Salida JSON validada por Zod en step 5. */
export interface Decision {
	operación: Operation;
	ajustePlan: AjustePlan | null;
	unidad: string | null; // id de unidad existente a ejecutar (operación delega)
	capacidad: Capability | null; // capability del objetivo
	comunicación: string | null; // operación=comunicar al desarrollador
	motivo: string;
	condición: string | null; // sólo cuando operación=terminar
}

// --- Resultado de una operación (Runtime-Model §5; tipos de Decision-Model §6) ---

export type ResultKind =
	| "info"
	| "unidad"
	| "comunicación"
	| "terminación"
	| "fallo"
	| "límite"
	| "parse_error"
	| "intervención";

export interface OperationResult {
	kind: ResultKind;
	text: string;
	unidadId: string | null;
	passed: boolean | null; // relevante en verificación (pass/fail)
}

// --- Perfil de límites (ADR-005) y estado (Runtime-Model §3.1) ---

export interface Limits {
	maxIterations: number;
}

export interface RuntimeState {
	taskState: TaskState;
	task: Task;
	knownInfo: string[];
	units: WorkUnit[];
	results: OperationResult[];
	iterations: number;
	unitSeq: number;
	nextStep: string;
	limits: Limits;
	consecutiveParseFailures: number;
	terminalCondition: string | null;
	/** Outcomes instrumentados (Fix 3). Se rellenan al pasar a estado terminal. Inicial: execution=fail, verification=unknown, scope=unknown. */
	outcomes: Outcomes;
}

export const DEFAULT_LIMITS: Limits = { maxIterations: 12 };

export function initState(task: Task, limits: Limits = DEFAULT_LIMITS): RuntimeState {
	return {
		taskState: "Recibida",
		task,
		knownInfo: [],
		units: [],
		results: [],
		iterations: 0,
		unitSeq: 0,
		nextStep: "determinar el proceso",
		limits,
		consecutiveParseFailures: 0,
		terminalCondition: null,
		outcomes: { execution: "fail", verification: "unknown", scope: "unknown" },
	};
}

function defineUnit(d: UnitDefinition, id: string): WorkUnit {
	return {
		id,
		objetivo: d.objetivo,
		alcance: d.alcance,
		infoNecesaria: d.infoNecesaria,
		resultadoEsperado: d.resultadoEsperado,
		condicionFinalizacion: d.condicionFinalizacion,
		capacidad: d.capacidad,
		estado: "Pendiente",
	};
}

function freshUnits(seq: number, defs: UnitDefinition[]): { units: WorkUnit[]; seq: number } {
	// IDs 0-based (u0, u1, …) para coincidir con la traza §9; seq apunta al siguiente id libre.
	const units = defs.map((d, idx) => defineUnit(d, `u${seq + idx}`));
	return { units, seq: seq + defs.length };
}

/**
 * Aplica la faceta de plan de la decisión al estado (C3: ANTES de la operación del mismo turno).
 * descomponer/determinar: añade unidades Pendiente (determinar el proceso arranca el bucle: Recibida→En curso).
 * re-descomponer/cambiar de estrategia: conserva el trabajo aceptado (Terminada + resultados), reemite el pendiente (ADR-006).
 */
export function applyAjustePlan(state: RuntimeState, ajuste: AjustePlan | null): RuntimeState {
	if (!ajuste || ajuste.unidades.length === 0) return state;
	const { units, seq } = freshUnits(state.unitSeq, ajuste.unidades);
	if (ajuste.tipo === "descomponer" || ajuste.tipo === "determinar el proceso") {
		const taskState: TaskState = state.taskState === "Recibida" ? "En curso" : state.taskState;
		return { ...state, unitSeq: seq, taskState, units: [...state.units, ...units] };
	}
	const kept = state.units.filter((u) => u.estado === "Terminada");
	return { ...state, unitSeq: seq, units: [...kept, ...units] };
}

export function markUnitState(state: RuntimeState, unitId: string, estado: UnitState): RuntimeState {
	return {
		...state,
		units: state.units.map((u) => (u.id === unitId ? { ...u, estado } : u)),
	};
}

export function appendResult(state: RuntimeState, result: OperationResult): RuntimeState {
	return { ...state, results: [...state.results, result] };
}

export function addKnownInfo(state: RuntimeState, info: string): RuntimeState {
	if (!info.trim()) return state;
	return { ...state, knownInfo: [...state.knownInfo, info] };
}

/** Terminación: fija el estado terminal con su condición.
 * Regla (Fix 3, B.1 laxa): taskState=Completada iff outcomes.execution="success" AND
 * outcomes.verification≠"fail". outcomes.scope NO bloquea (queda "unknown" hasta que se defina un
 * criterio de alcance explícito). El llamador es responsable de construir el Outcomes correcto:
 * el bucle (loop.ts) lo calcula desde result y state.results; las salidas de intervención/límite
 * pasan outcomes={execution: "fail", verification: "unknown", scope: "unknown"}. */
export function setTerminal(state: RuntimeState, outcomes: Outcomes, condición: string): RuntimeState {
	const completada = outcomes.execution === "success" && outcomes.verification !== "fail";
	return {
		...state,
		outcomes,
		taskState: completada ? "Completada" : "Fallida",
		terminalCondition: condición,
		nextStep: completada ? "tarea completada" : "tarea fallida",
	};
}

/** Siguiente unidad Pendiente (para que el orquestador la considere). */
export function nextPendingUnit(state: RuntimeState): WorkUnit | null {
	return state.units.find((u) => u.estado === "Pendiente") ?? null;
}