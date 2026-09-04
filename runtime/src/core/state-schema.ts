// src/core/state-schema.ts — catálogos compartidos y migración de snapshots v1→v2.
//
// Plan "Fiabilidad estructural del runtime":
//   - Catálogo único (OPERATIONS, PLAN_ADJUSTMENT_TYPES, CAPABILITIES, UNIT_STATES, TASK_STATES,
//     HUMAN_WAIT_REASONS, NO_PROGRESS_REASONS): tipos, Zod y prompt los importan desde aquí.
//     No hay aliases silenciosos (rechazo estricto con feedback en el parser).
//   - Versión de estado y migración v1→v2 explícita: snapshots sin `version`/`runStatus` se
//     migran; los que no se pueden, se rechazan como `corrupt` (no se reanuda un estado a medias).
//
// Este archivo no toca el loop ni la persistencia: define el contrato compartido.

import { z } from "zod";

// ─── Catálogos ──────────────────────────────────────────────────────────────

export const TASK_STATES = ["Recibida", "En curso", "Completada", "Fallida"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const UNIT_STATES = ["Pendiente", "En curso", "Terminada", "Fallida", "Sustituida"] as const;
export type UnitState = (typeof UNIT_STATES)[number];

/** Operaciones del catálogo. Mantenemos la grafía castellana en runtime (consistente con `Task`/
 *  `Unit`/`Decision`) y nombres máquina solo dentro del discriminante Zod/prompt — el modelo los ve
 *  en español canónico (ADR-007). */
export const OPERATIONS = [
	"obtener información",
	"ejecutar una unidad",
	"comunicar al desarrollador",
	"terminar",
] as const;
export type Operation = (typeof OPERATIONS)[number];

export const PLAN_ADJUSTMENT_TYPES = [
	"descomponer",
	"re-descomponer",
	"cambiar de estrategia",
	"determinar el proceso",
] as const;
export type AjustePlanTipo = (typeof PLAN_ADJUSTMENT_TYPES)[number];

export const CAPABILITIES = ["explorer", "implementer", "verifier"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Razones válidas de espera humana (no se permite "comunicar" sin una razón cerrada de esta lista). */
export const HUMAN_WAIT_REASONS = [
	"product_ambiguity",
	"destructive_or_irreversible",
	"credential_or_secret",
	"architectural_conflict",
	"subjective_choice",
	"external_information",
	"limit_extension",
	"orchestrator_contract_failure",
] as const;
export type HumanWaitReason = (typeof HUMAN_WAIT_REASONS)[number];

export const TERMINAL_OUTCOMES = ["completed", "failed"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

export const RUN_STATUS_TIPOS = ["ready", "paused_by_user", "waiting_for_user", "terminal"] as const;
export type RunStatusTipo = (typeof RUN_STATUS_TIPOS)[number];

// ─── Schemas Zod del trust boundary ──────────────────────────────────────────

export const TaskStateSchema = z.enum(TASK_STATES);
export const UnitStateSchema = z.enum(UNIT_STATES);
export const OperationSchema = z.enum(OPERATIONS);
export const AjustePlanTipoSchema = z.enum(PLAN_ADJUSTMENT_TYPES);
export const CapabilitySchema = z.enum(CAPABILITIES);
export const HumanWaitReasonSchema = z.enum(HUMAN_WAIT_REASONS);
export const TerminalOutcomeSchema = z.enum(TERMINAL_OUTCOMES);

export const TEXT = (max: number) => z.string().min(1).max(max);

/** Definición de unidad (Task-Model §2) — extiende con requisitos y criterios de aceptación
 *  explícitos (plan §3, invariante 5). */
export const UnitDefinitionSchema = z
	.object({
		objetivo: z.string().min(1).max(2000),
		alcance: z.union([z.string().max(2000), z.null()]).optional(),
		infoNecesaria: z.union([z.string().max(2000), z.null()]).optional(),
		resultadoEsperado: z.string().min(1).max(2000),
		condicionFinalizacion: z.string().min(1).max(2000),
		capacidad: CapabilitySchema,
		requisitos: z.array(z.string().min(1).max(2000)).optional(),
		criteriosAceptacion: z.array(z.string().min(1).max(2000)).optional(),
	})
	.strict();

/** Referencia a una unidad — discriminada. La planificada solo es válida dentro de un
 *  ajustePlan (índice dentro de `unidades[]`); la existente requiere ID canónico `^u\d+$`. */
export const UnitRefSchema = z.union([
	z.object({ tipo: z.literal("existente"), id: z.string().regex(/^u\d+$/) }).strict(),
	z.object({ tipo: z.literal("planificada"), indice: z.number().int().nonnegative() }).strict(),
]);
export type UnitRefSchemaType = z.infer<typeof UnitRefSchema>;

/** `ajustePlan` con reemplazo dirigido (plan §3 — invariante 13). Las operaciones
 *  `determinar el proceso`/`descomponer` deben llevar `reemplaza: []`; las de re-planificación
 *  deben llevar los IDs existentes a sustituir. */
export const AjustePlanSchema = z
	.object({
		tipo: AjustePlanTipoSchema,
		reemplaza: z.array(z.string().regex(/^u\d+$/)).optional(),
		unidades: z.array(UnitDefinitionSchema).min(1),
	})
	.strict();

/** Decisión discriminada por operación (plan §3 — invariante 11). */
export const DecisionSchema = z
	.object({
		operación: OperationSchema,
		motivo: z.string().min(1).max(2000),
		// Discriminantes por variante:
		ajustePlan: z.union([AjustePlanSchema, z.null()]).optional(),
		unidad: z.union([UnitRefSchema, z.null()]).optional(),
		feedbackCorrectivo: z.union([z.string().max(2000), z.null()]).optional(),
		// `null` explícito ≡ ausente: el prompt del orquestador pide las claves SIEMPRE con
		// null en las variantes que no las usan; sin `z.null()` en el union, modelos fieles
		// al contrato (p. ej. MiniMax M2.7) fallaban el parseo en cada turno (dogfooding
		// 2026-09-04). La validez por variante la sigue garantizando `semanticCheck` (parse.ts).
		comunicación: z
			.object({
				pregunta: z.string().min(1).max(2000),
				razón: HumanWaitReasonSchema,
				informaciónFaltante: z.string().min(1).max(2000),
			})
			.strict()
			.nullable()
			.optional(),
		condición: z
			.object({
				desenlace: TerminalOutcomeSchema,
				detalle: z.string().min(1).max(2000),
			})
			.strict()
			.nullable()
			.optional(),
	})
	.strict();

// ─── Versión de estado y migración v1→v2 ─────────────────────────────────────

export const STATE_VERSION = 2;

/** Estado v1 (lo que se escribió hasta ahora). Lo aceptamos para migrar; lo escribimos
 *  siempre como v2. */
export const LegacyStateV1Schema = z
	.object({
		taskState: z.string(),
		task: z.object({
			objetivo: z.string(),
			alcance: z.union([z.string(), z.null()]).optional(),
			restricciones: z.union([z.array(z.string()), z.null()]).optional(),
			resultadoEsperado: z.union([z.string(), z.null()]).optional(),
			condicionFinalizacion: z.string(),
		}),
		knownInfo: z.array(z.string()).optional(),
		units: z.array(z.unknown()).optional(),
		results: z.array(z.unknown()).optional(),
		iterations: z.number().optional(),
		unitSeq: z.number().optional(),
		nextStep: z.string().optional(),
		limits: z.object({ maxIterations: z.number() }).optional(),
		consecutiveParseFailures: z.number().optional(),
		terminalCondition: z.union([z.string(), z.null()]).optional(),
		outcomes: z
			.object({
				execution: z.string(),
				verification: z.string(),
				scope: z.string(),
			})
			.optional(),
	})
	.passthrough();

/** Estado v2 — runtime actual. Mantenemos los nombres de campo v1 que el código ya consume;
 *  añadimos `version`, `runStatus` y campos derivados de los nuevos contratos. */
export const RuntimeStateSchema = z
	.object({
		version: z.literal(STATE_VERSION),
		taskState: TaskStateSchema,
		task: z.object({
			objetivo: z.string(),
			alcance: z.union([z.string(), z.null()]),
			restricciones: z.union([z.array(z.string()), z.null()]),
			resultadoEsperado: z.union([z.string(), z.null()]),
			condicionFinalizacion: z.string(),
		}),
		knownInfo: z.array(z.string()),
		units: z.array(z.unknown()),
		results: z.array(z.unknown()),
		iterations: z.number(),
		unitSeq: z.number(),
		nextStep: z.string(),
		limits: z.object({ maxIterations: z.number().int().positive() }),
		consecutiveParseFailures: z.number().int().nonnegative(),
		consecutiveNoProgress: z.number().int().nonnegative().default(0),
		terminalCondition: z.union([z.string(), z.null()]),
		outcomes: z.object({
			execution: z.enum(["success", "fail"]),
			verification: z.enum(["pass", "fail", "unknown"]),
			scope: z.enum(["pass", "fail", "unknown"]),
		}),
		runStatus: z.unknown(),
		humanWait: z.unknown().nullable().optional(),
	})
	.passthrough();

/** Resultado de cargar un snapshot de disco: ok (v2 canónico), migrated (v1→v2), o reject. */
export type LoadSnapshotResult =
	| { kind: "ok"; state: unknown }
	| { kind: "migrated"; state: unknown; from: 1 }
	| { kind: "reject"; reason: "corrupt" | "unsupported_version"; detail: string };