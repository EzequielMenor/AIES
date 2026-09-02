// src/core/state.ts — estado del runtime v2 (Runtime-Model §3.1 + perfil de límites ADR-005).
//
// Cambios v1 → v2 (plan "Fiabilidad estructural del runtime"):
//   - `Decision` ahora es una unión discriminada por `operación`: cada variante declara los
//     campos que le son propios (plan §3, invariante 11). `unidad` pasa a `UnitRef` (existente
//     por ID canónico o planificada por índice del ajuste); `capacidad` desaparece como campo
//     de la decisión (procede exclusivamente de la unidad canónica — invariante 4).
//   - `UnitDefinition` y `WorkUnit` añaden `requisitos` (literales explícitos vinculantes) y
//     `criteriosAceptacion` (comprobaciones observables) — invariantes 5 y 6.
//   - `UnitState` añade `Sustituida`: las unidades re-planificadas pasan a `Sustituida` y
//     permanecen observables en el log/estado, pero no cuentan en el plan activo (invariante 8).
//   - `RuntimeState` añade `version` (STATE_VERSION), `consecutiveNoProgress` (presupuesto
//     configurable, default 3) y `runStatus` (RunStatus ortogonal al `taskState`, §3).
//   - `applyAjustePlan` ahora devuelve `{ state, createdUnitIds }` y soporta `reemplaza`:
//     los IDs listados pasan a `Sustituida` (invariante 13).

import {
	type Capability,
	type HumanWaitReason,
	type Operation,
	type AjustePlanTipo,
	type TaskState,
	type UnitState,
	type RunStatusTipo,
	type TerminalOutcome,
	STATE_VERSION,
} from "./state-schema.js";

// Re-export catalogos para que el código que ya importa desde aquí no se rompa.
export type {
	Capability,
	HumanWaitReason,
	Operation,
	AjustePlanTipo,
	TaskState,
	UnitState,
	RunStatusTipo,
	TerminalOutcome,
};

// ─── Outcomes (Fix 3, sin cambios de semántica) ─────────────────────────────

export type ExecutionOutcome = "success" | "fail";
export type VerificationOutcome = "pass" | "fail" | "unknown";
export type ScopeOutcome = "pass" | "fail" | "unknown";

export interface Outcomes {
	execution: ExecutionOutcome;
	verification: VerificationOutcome;
	scope: ScopeOutcome;
}

// ─── Task y WorkUnit (Task-Model §1/§2) ─────────────────────────────────────

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
	/** Requisitos literales explícitos que el Orchestrator copia del Task original — invariante 5. */
	requisitos?: string[];
	/** Comprobaciones observables que cierran la unidad (sin código/diffs) — invariante 6. */
	criteriosAceptacion?: string[];
	/** Una unidad canónica se ejecuta una sola vez; las correcciones crean una nueva. */
	intentos: number;
}

/** Definición de unidad dentro de ajustePlan.unidades (Task-Model §2). Sin contenido ejecutable. */
export interface UnitDefinition {
	objetivo: string;
	alcance: string | null;
	infoNecesaria: string | null;
	resultadoEsperado: string;
	condicionFinalizacion: string;
	capacidad: Capability;
	requisitos?: string[];
	criteriosAceptacion?: string[];
}

// ─── Plan y referencias ────────────────────────────────────────────────────

/** Referencia a una unidad dentro de una decisión del Orchestrator. */
export type UnitRef =
	| { tipo: "existente"; id: string }
	| { tipo: "planificada"; indice: number };

/** Faceta de plan de la decisión (Decision-Model §4.2). Hermana de operación, no anidada. */
export interface AjustePlan {
	tipo: AjustePlanTipo;
	/** IDs existentes que pasan a `Sustituida` tras el ajuste. Vacío en `descomponer` /
	 *  `determinar el proceso`. Requerido (no vacío) en `re-descomponer`/`cambiar de estrategia`. */
	reemplaza?: string[];
	unidades: UnitDefinition[];
}

// ─── Comunicación bloqueante y terminación (nuevas variantes discriminadas) ─

/** Bloqueante: `comunicar al desarrollador` exige razón cerrada, pregunta y dato faltante. */
export interface CommunicationRequest {
	pregunta: string;
	razón: HumanWaitReason;
	informaciónFaltante: string;
}

/** Terminación estricta: `terminar` exige desenlace y detalle. */
export interface TerminationCondition {
	desenlace: TerminalOutcome;
	detalle: string;
}

// ─── WorkerReport ──────────────────────────────────────────────────────────

/** Estado de satisfacción reportado por un worker tras ejecutar su unidad. */
export type WorkerReportStatus = "satisfied" | "unsatisfied" | "blocked";

export interface WorkerCriterionResult {
	criterion: string;
	status: "pass" | "fail";
	evidence: string;
}

/** Reporte estructurado del worker. Lo emite al final del turno en una única respuesta;
 *  el parser es tolerante con fence/wrapper pero NUNCA inventa éxito (reporte ausente o
 *  inválido = `unsatisfied` con error de contrato). */
export interface WorkerReport {
	status: WorkerReportStatus;
	summary: string;
	criteria: WorkerCriterionResult[];
	unmetCriteria: string[];
}

// ─── Decision: unión discriminada ──────────────────────────────────────────

/** Decisión del Orchestrator (Decision-Model §2/§4). Salida JSON validada por Zod en step 5. */
export interface Decision {
	operación: Operation;
	motivo: string;
	/** `obtener información` puede ajustar el plan; `ejecutar una unidad` puede ajustar el plan
	 *  y aportar `feedbackCorrectivo` para la nueva unidad. `comunicar`/`terminar` no llevan
	 *  ajuste. */
	ajustePlan?: AjustePlan | null | undefined;
	/** `ejecutar una unidad`: referencia discriminada. `null` en el resto. */
	unidad?: UnitRef | null | undefined;
	/** Feedback correctivo opcional que el Orchestrator inyecta al worker como contexto. */
	feedbackCorrectivo?: string | null | undefined;
	/** `comunicar al desarrollador` exige este bloque. `null` en el resto. */
	comunicación?: CommunicationRequest | null | undefined;
	/** `terminar` exige este bloque. `null` en el resto. */
	condición?: TerminationCondition | null | undefined;
}

// ─── Resultado de una operación (Runtime-Model §5) ─────────────────────────

export type ResultKind =
	| "info"
	| "unidad"
	| "comunicación"
	| "terminación"
	| "fallo"
	| "límite"
	| "parse_error"
	| "intervención"
	| "human_response"
	| "no_progress";

export interface OperationResult {
	kind: ResultKind;
	text: string;
	unidadId: string | null;
	passed: boolean | null;
}

// ─── RunStatus (estado operacional ortogonal) ──────────────────────────────

/** Estado operacional ortogonal al `taskState`. `paused_by_user` sólo lo crea una señal
 *  externa real; `waiting_for_user` lo crea una decisión `comunicar al desarrollador` válida
 *  (o el tope de parse failures, o el límite si pide intervención); `terminal` se mantiene
 *  mientras `taskState` es terminal. */
export type RunStatus =
	| { tipo: "ready" }
	| { tipo: "paused_by_user"; causa: "escape" | "sigint" | "external"; mensaje: string }
	| { tipo: "waiting_for_user"; request: CommunicationRequest; mensaje: string }
	| { tipo: "terminal" };

/** Petición de input humano pendiente (lo que la UI debe mostrar). Persistido como parte de
 *  `RunStatus.waiting_for_user`. */
export interface HumanInputRequest {
	pregunta: string;
	razón: HumanWaitReason;
	informaciónFaltante: string;
}

// ─── Perfil de límites (ADR-005) ───────────────────────────────────────────

export interface Limits {
	maxIterations: number;
	/** Presupuesto consecutivo de no-progreso antes de terminación controlada como `Fallida`.
	 *  Default conservador 3. */
	maxConsecutiveNoProgress: number;
}

// ─── RuntimeState v2 ──────────────────────────────────────────────────────

export interface RuntimeState {
	/** Versión de esquema (STATE_VERSION=2). Snapshots sin `version` se migran desde v1. */
	version: number;
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
	/** Cuenta de turnos consecutivos SIN progreso (criterios en `recordProgress` de loop.ts). */
	consecutiveNoProgress: number;
	terminalCondition: string | null;
	outcomes: Outcomes;
	/** Estado operacional ortogonal al `taskState`. */
	runStatus: RunStatus;
	/** Si `RunStatus.waiting_for_user`, snapshot del bloque persistido por separado. */
	humanWait: CommunicationRequest | null;
}

export const DEFAULT_LIMITS: Limits = {
	maxIterations: 12,
	maxConsecutiveNoProgress: 3,
};

export function initState(task: Task, limits: Limits = DEFAULT_LIMITS): RuntimeState {
	return {
		version: STATE_VERSION,
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
		consecutiveNoProgress: 0,
		terminalCondition: null,
		outcomes: { execution: "fail", verification: "unknown", scope: "unknown" },
		runStatus: { tipo: "ready" },
		humanWait: null,
	};
}

// ─── Helpers ───────────────────────────────────────────────────────────────

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
		intentos: 0,
		...(d.requisitos ? { requisitos: [...d.requisitos] } : {}),
		...(d.criteriosAceptacion ? { criteriosAceptacion: [...d.criteriosAceptacion] } : {}),
	};
}

function freshUnits(seq: number, defs: UnitDefinition[]): { units: WorkUnit[]; seq: number; createdIds: string[] } {
	const units: WorkUnit[] = [];
	const createdIds: string[] = [];
	for (let i = 0; i < defs.length; i++) {
		const id = `u${seq + i}`;
		units.push(defineUnit(defs[i]!, id));
		createdIds.push(id);
	}
	return { units, seq: seq + defs.length, createdIds };
}

export interface AjustePlanOutcome {
	state: RuntimeState;
	createdUnitIds: string[];
	/** IDs que pasaron a `Sustituida` durante el ajuste (intersección de `reemplaza` con
	 *  unidades `Pendiente`/`En curso`/`Fallida` que existían en el estado). */
	substitutedIds: string[];
}

/** Aplica la faceta de plan de la decisión al estado (C3: ANTES de la operación del mismo turno).
 *  - `descomponer`/`determinar el proceso`: `reemplaza` debe estar vacío.
 *  - `re-descomponer`/`cambiar de estrategia`: `reemplaza` debe contener únicamente IDs
 *    existentes pendientes, en curso o fallidos; si no, se rechaza el ajuste completo.
 *    observables en estado/log pero NO en el plan activo (invariante 8).
 *  Devuelve el estado resultante, los IDs creados y los IDs sustituidos. */
export function applyAjustePlan(state: RuntimeState, ajuste: AjustePlan | null): AjustePlanOutcome {
	if (!ajuste || ajuste.unidades.length === 0) {
		return { state, createdUnitIds: [], substitutedIds: [] };
	}
	const reemplaza = ajuste.reemplaza ?? [];
	const isReplan = ajuste.tipo === "re-descomponer" || ajuste.tipo === "cambiar de estrategia";

	if (!isReplan && reemplaza.length > 0) {
		// Política: descomponer/determinar rechaza reemplaza no vacío. El parser lo bloquea antes,
		// pero defendemos aquí también para no corromper estado si se llama directamente.
		return { state, createdUnitIds: [], substitutedIds: [] };
	}
	if (isReplan) {
		const replaceableIds = new Set(
			state.units
				.filter((u) => u.estado === "Pendiente" || u.estado === "En curso" || u.estado === "Fallida")
				.map((u) => u.id),
		);
		if (reemplaza.length === 0 || reemplaza.some((id) => !replaceableIds.has(id))) {
			// No crear unidades si la mutación no puede sustituir exactamente su objetivo.
			return { state, createdUnitIds: [], substitutedIds: [] };
		}
	}

	const { units, seq, createdIds } = freshUnits(state.unitSeq, ajuste.unidades);

	let substitutedIds: string[] = [];
	let workingUnits = state.units;
	if (isReplan) {
		const reemplazaSet = new Set(reemplaza);
		substitutedIds = workingUnits
			.filter((u) => reemplazaSet.has(u.id) && (u.estado === "Pendiente" || u.estado === "En curso" || u.estado === "Fallida"))
			.map((u) => u.id);
		const replacedSet = new Set(substitutedIds);
		// Conservamos Terminada y las no-listadas en `reemplaza`; las listadas pasan a Sustituida.
		workingUnits = workingUnits.map((u) => (replacedSet.has(u.id) ? { ...u, estado: "Sustituida" as UnitState } : u));
	}

	const taskState: TaskState = state.taskState === "Recibida" ? "En curso" : state.taskState;
	const newState: RuntimeState = {
		...state,
		unitSeq: seq,
		taskState,
		units: [...workingUnits, ...units],
	};
	return { state: newState, createdUnitIds: createdIds, substitutedIds };
}

export function markUnitState(state: RuntimeState, unitId: string, estado: UnitState): RuntimeState {
	return {
		...state,
		units: state.units.map((u) => (u.id === unitId ? { ...u, estado } : u)),
	};
}

export function markUnitEnCurso(state: RuntimeState, unitId: string): RuntimeState {
	return {
		...state,
		units: state.units.map((u) => (u.id === unitId ? { ...u, estado: "En curso" as UnitState, intentos: u.intentos + 1 } : u)),
	};
}

export function appendResult(state: RuntimeState, result: OperationResult): RuntimeState {
	return { ...state, results: [...state.results, result] };
}

export function addKnownInfo(state: RuntimeState, info: string): RuntimeState {
	if (!info.trim()) return state;
	return { ...state, knownInfo: [...state.knownInfo, info] };
}

/** Resuelve un `UnitRef` a un ID canónico (post-aplicación del ajuste). `planificada` requiere
 *  los IDs creados por `applyAjustePlan`. */
export function resolveUnitRef(ref: UnitRef, createdUnitIds: string[]): string | null {
	if (ref.tipo === "existente") return ref.id;
	if (ref.indice < 0 || ref.indice >= createdUnitIds.length) return null;
	return createdUnitIds[ref.indice] ?? null;
}

/** True si la unidad existe en el estado y está `Pendiente` (único caso válido para
 *  `UnitRef.existente`). */
export function isUnitPending(state: RuntimeState, unitId: string): boolean {
	const u = state.units.find((x) => x.id === unitId);
	return !!u && u.estado === "Pendiente";
}

/** True si la unidad está `Terminada` con criterios de aceptación cumplidos (reporte del worker
 *  o evidencia determinista). Aquí consultamos sólo el estado canónico — el reporte se cruza
 *  fuera. */
export function isUnitSatisfied(state: RuntimeState, unitId: string): boolean {
	const u = state.units.find((x) => x.id === unitId);
	return !!u && u.estado === "Terminada";
}

/** Siguiente unidad Pendiente (para que el Orchestrator la considere). */
export function nextPendingUnit(state: RuntimeState): WorkUnit | null {
	return state.units.find((u) => u.estado === "Pendiente") ?? null;
}

/** Unidades activas: `Pendiente`, `En curso` o `Fallida` — las que bloquean la terminación. */
export function activeUnits(state: RuntimeState): WorkUnit[] {
	return state.units.filter((u) => u.estado === "Pendiente" || u.estado === "En curso" || u.estado === "Fallida");
}

/** Unidades reemplazadas: `Sustituida` — observables pero no bloquean. */
export function substitutedUnits(state: RuntimeState): WorkUnit[] {
	return state.units.filter((u) => u.estado === "Sustituida");
}

/** Terminación: fija el estado terminal con su condición. La regla laxa (Fix 3, B.1) se conserva
 *  para `execution` y `verification`; `scope` siempre `unknown`. El llamador es responsable de
 *  construir los Outcomes correctos desde el plan activo (ver `computeOutcomes` abajo). */
export function setTerminal(state: RuntimeState, outcomes: Outcomes, condición: string): RuntimeState {
	const completada = outcomes.execution === "success" && outcomes.verification !== "fail";
	const next: RuntimeState = {
		...state,
		outcomes,
		taskState: completada ? "Completada" : "Fallida",
		terminalCondition: condición,
		nextStep: completada ? "tarea completada" : "tarea fallida",
		runStatus: { tipo: "terminal" },
	};
	return next;
}

/** Computa Outcomes desde el plan activo + últimos resultados por unidad canónica. Las unidades
 *  `Sustituida` no contaminan la verificación final (invariante 8). Se proyecta la verificación
 *  sobre unidades activas/terminadas con `WorkerReport` verificable. */
export function computeOutcomes(
	state: RuntimeState,
	execution: ExecutionOutcome,
	unitReports: Map<string, "pass" | "fail"> | null,
): Outcomes {
	const active = activeUnits(state);
	// Si hay unidades activas sin satisfacer, la verificación no puede ser pass.
	const anyActiveUnsatisfied = active.some((u) => u.estado !== "Terminada");
	if (unitReports) {
		let failed = false;
		let anyReported = false;
		for (const u of state.units) {
			if (u.estado !== "Terminada") continue;
			const r = unitReports.get(u.id);
			if (!r) continue;
			anyReported = true;
			if (r === "fail") failed = true;
		}
		const verification: VerificationOutcome = failed
			? "fail"
			: anyReported
				? "pass"
				: anyActiveUnsatisfied
					? "unknown"
					: "unknown";
		return { execution, verification, scope: "unknown" };
	}
	// Sin reportes: outCome.verification queda unknown si no hay unidades terminadas con reporte,
	// o pass si todas las terminadas tienen reports pass (comportamiento legado).
	const terminadas = state.units.filter((u) => u.estado === "Terminada");
	const verification: VerificationOutcome = terminadas.length === 0
		? "unknown"
		: terminadas.every((u) => {
				const r = state.results.find((x) => x.unidadId === u.id);
				return r?.passed === true;
			})
			? "pass"
			: terminadas.some((u) => {
						const r = state.results.find((x) => x.unidadId === u.id);
						return r?.passed === false;
					})
				? "fail"
				: "unknown";
	return { execution, verification, scope: "unknown" };
}
