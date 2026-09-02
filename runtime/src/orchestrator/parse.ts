// src/orchestrator/parse.ts — parser robusto del JSON del orquestador.
//
// Trust boundary (plan §3, invariante 11). El JSON del orquestador es salida de un LLM → entrada
// NO confiable: validación estricta, sin aliases (rechazo explícito con feedback exacto en el
// siguiente turno — plan §3, invariante 12). Dominio puro (no pi).
//
// Catálogo compartido con `state-schema.ts` y el prompt del orquestador: una sola fuente de verdad.

import { z } from "zod";
import {
	AjustePlanSchema,
	CapabilitySchema,
	DecisionSchema,
	HumanWaitReasonSchema,
	OperationSchema,
	TEXT,
	UnitDefinitionSchema,
} from "../core/state-schema.js";
import type { AjustePlan, Decision } from "../core/state.js";

// ─── WorkerReport parsing ──────────────────────────────────────────────────

export const WorkerCriterionResultSchema = z
	.object({
		criterion: z.string().min(1).max(2000),
		status: z.enum(["pass", "fail"]),
		evidence: z.string().max(4000),
	})
	.strict();

export const WorkerReportSchema = z
	.object({
		status: z.enum(["satisfied", "unsatisfied", "blocked"]),
		summary: z.string().min(1).max(4000),
		criteria: z.array(WorkerCriterionResultSchema),
		unmetCriteria: z.array(z.string().min(1).max(2000)),
	})
	.strict();

export type WorkerReportParseResult =
	| { ok: true; report: z.infer<typeof WorkerReportSchema> }
	| { ok: false; error: string };

function reportExtractJson(s: string): string {
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fence && fence[1]) return fence[1]!.trim();
	return s.trim();
}

/** Parsea el reporte estructurado del worker. Fences/wrapper se toleran; un reporte ausente o
 *  inválido es `unsatisfied` con error de contrato (plan §3 — invariante 6, §3 worker contract). */
export function parseWorkerReport(text: string): WorkerReportParseResult {
	const trimmed = text.trim();
	if (!trimmed) return { ok: false, error: "reporte del worker ausente" };
	const candidate = reportExtractJson(trimmed);
	let obj: unknown;
	try {
		obj = JSON.parse(candidate);
	} catch (e1) {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end <= start) return { ok: false, error: `JSON malformado: ${errMsg(e1)}` };
		try {
			obj = JSON.parse(candidate.slice(start, end + 1));
		} catch (e2) {
			return { ok: false, error: `JSON malformado: ${errMsg(e2)}` };
		}
	}
	const parsed = WorkerReportSchema.safeParse(obj);
	if (!parsed.success) return { ok: false, error: `schema: ${summarizeZod(parsed.error)}` };
	return { ok: true, report: parsed.data };
}

// ─── Decision parsing ──────────────────────────────────────────────────────

export interface ParseOutcome {
	decision: Decision;
	parseFail: boolean;
	parseError?: string;
}

export function emptyDecision(): Decision {
	return {
		operación: "obtener información",
		motivo: "salida del orquestador no parseable",
		ajustePlan: null,
		unidad: null,
		feedbackCorrectivo: null,
		comunicación: null,
		condición: null,
	};
}

function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function summarizeZod(err: z.ZodError): string {
	return err.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/** Extrae el JSON de la salida del modelo: tolera fences ```json y envoltorios de texto. */
function extractJson(s: string): string {
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
	if (fence && fence[1]) return fence[1]!.trim();
	return s.trim();
}

/** Si el objeto es un wrapper de una sola clave { "decision": {...} } o { "result": {...} }, desenvuelve. */
function unwrapIfWrapper(obj: unknown): unknown {
	if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return obj;
	const keys = Object.keys(obj as Record<string, unknown>);
	if (keys.length === 1) {
		const inner = (obj as Record<string, unknown>)[keys[0]!];
		if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) return inner;
	}
	return obj;
}

function executableContamination(ajuste: AjustePlan | null): string | null {
	if (!ajuste) return null;
	const fields = ["objetivo", "alcance", "infoNecesaria", "resultadoEsperado", "condicionFinalizacion"];
	for (const u of ajuste.unidades) {
		for (const f of fields) {
			const v = (u as unknown as Record<string, string | null>)[f];
			if (typeof v !== "string") continue;
			if (v.includes("```") || v.includes("diff --git") || /(^|\n)@@ /.test(v) || /(^|\n)\+\+\+ /.test(v) || /(^|\n)--- /.test(v)) {
				return `ajustePlan con contenido ejecutable (código/diff) en unidad.${f}`;
			}
		}
	}
	return null;
}

function semanticCheck(d: Decision): string | null {
	// Discriminada por operación: cada variante exige sus campos propios.
	switch (d.operación) {
		case "terminar":
			if (!d.condición) return "falta condición al terminar";
			if (d.unidad !== null && d.unidad !== undefined) return "terminar no admite unidad";
			if (d.comunicación !== null && d.comunicación !== undefined) return "terminar no admite comunicación";
			break;
		case "comunicar al desarrollador":
			if (!d.comunicación) return "falta bloque comunicación al comunicar al desarrollador";
			if (d.unidad !== null && d.unidad !== undefined) return "comunicar al desarrollador no admite unidad";
			if (d.ajustePlan) return "comunicar al desarrollador no admite ajustePlan";
			break;
		case "ejecutar una unidad":
			if (!d.unidad) return "falta unidad al ejecutar una unidad";
			break;
		case "obtener información":
			if (d.unidad !== null && d.unidad !== undefined) return "obtener información no admite unidad";
			break;
	}
	return null;
}

function mapAjuste(a: NonNullable<z.infer<typeof AjustePlanSchema>>): AjustePlan {
	return {
		tipo: a.tipo,
		reemplaza: a.reemplaza ? [...a.reemplaza] : [],
		unidades: a.unidades.map((u) => ({
			objetivo: u.objetivo,
			alcance: u.alcance ?? null,
			infoNecesaria: u.infoNecesaria ?? null,
			resultadoEsperado: u.resultadoEsperado,
			condicionFinalizacion: u.condicionFinalizacion,
			capacidad: u.capacidad,
			...(u.requisitos ? { requisitos: [...u.requisitos] } : {}),
			...(u.criteriosAceptacion ? { criteriosAceptacion: [...u.criteriosAceptacion] } : {}),
		})),
	};
}

function mapDecision(d: z.infer<typeof DecisionSchema>): Decision {
	return {
		operación: d.operación as Decision["operación"],
		motivo: d.motivo,
		ajustePlan: d.ajustePlan ? mapAjuste(d.ajustePlan) : null,
		unidad: (d.unidad ?? null) as Decision["unidad"],
		feedbackCorrectivo: d.feedbackCorrectivo ?? null,
		comunicación: (d.comunicación ?? null) as Decision["comunicación"],
		condición: (d.condición ?? null) as Decision["condición"],
	} as Decision;
}

/** Sin aliases silenciosos (plan §3, invariante 11): si llegan keys traducidas o en desuso,
 *  se reportan como error de schema (Zod los rechaza al usar .strict()). Esta función sólo
 *  desenvuelve wrappers de una sola clave y conserva el árbol tal cual. */
function normalizeKeys(obj: unknown): unknown {
	if (typeof obj !== "object" || obj === null) return obj;
	if (Array.isArray(obj)) return obj.map(normalizeKeys);
	const res: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		res[k] = typeof v === "object" && v !== null ? normalizeKeys(v) : v;
	}
	return res;
}

/**
 * Parsea la salida del orquestador a una Decisión.
 * Fallos (vacío / JSON malformado / schema reject / semántica / contenido ejecutable) → parseFail:true
 * con parseError; el bucle los trata como info-insuficiente y reentra (C3); el feedback exacto
 * alimenta el siguiente turno (plan §3, invariante 12).
 */
export function parseDecision(text: string): ParseOutcome {
	const empty = emptyDecision();
	const trimmed = text.trim();
	if (!trimmed) return { decision: empty, parseFail: true, parseError: "salida del orquestador vacía" };

	const candidate = extractJson(trimmed);
	let obj: unknown;
	try {
		obj = JSON.parse(candidate);
	} catch (e1) {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");
		if (start < 0 || end <= start) return { decision: empty, parseFail: true, parseError: `JSON malformado: ${errMsg(e1)}` };
		try {
			obj = JSON.parse(candidate.slice(start, end + 1));
		} catch (e2) {
			return { decision: empty, parseFail: true, parseError: `JSON malformado: ${errMsg(e2)}` };
		}
	}

	const unwrapped = normalizeKeys(unwrapIfWrapper(obj));
	const parsed = DecisionSchema.safeParse(unwrapped);
	if (!parsed.success) return { decision: empty, parseFail: true, parseError: `schema: ${summarizeZod(parsed.error)}` };

	const decision = mapDecision(parsed.data);
	const sem = semanticCheck(decision);
	if (sem) return { decision: empty, parseFail: true, parseError: sem };
	const exec = executableContamination(decision.ajustePlan ?? null);
	if (exec) return { decision: empty, parseFail: true, parseError: exec };

	return { decision, parseFail: false };
}

// Re-export schema para tests de paridad catálogo↔prompt↔schema.
export {
	OperationSchema,
	CapabilitySchema,
	HumanWaitReasonSchema,
	UnitDefinitionSchema as UnitDefSchema,
	TEXT,
};