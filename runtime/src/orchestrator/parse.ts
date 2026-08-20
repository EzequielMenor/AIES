// src/orchestrator/parse.ts — parser robusto del JSON del orquestador (plan C3, trust boundary).
// El JSON del orquestador es salida de un LLM → entrada NO confiable: validación de entrada es
// no-negociable (carve-out ponytail). Zod es el único lugar con esta responsabilidad.
// Dominio puro (no pi). Parse fail → NO crash, NO reinicio: se trata como info-insuficiente (plan C3/REQ-F-18).

import { z } from "zod";
import type { AjustePlan, Capability, Decision, Operation, UnitDefinition } from "../core/state.js";

const OperationSchema = z.enum(["obtener información", "ejecutar una unidad", "comunicar al desarrollador", "terminar"]);
const AjusteTipoSchema = z.enum(["descomponer", "re-descomponer", "cambiar de estrategia", "determinar el proceso"]);
const CapabilitySchema = z.enum(["explorer", "implementer", "verifier"]);

const TEXT = (max: number) => z.string().max(max);

const UnitDefSchema = z
	.object({
		objetivo: z.string().min(1).max(2000),
		alcance: z.union([TEXT(2000), z.null()]).optional(),
		infoNecesaria: z.union([TEXT(2000), z.null()]).optional(),
		resultadoEsperado: z.string().min(1).max(2000),
		condicionFinalizacion: z.string().min(1).max(2000),
		capacidad: CapabilitySchema,
	})
	.strict();

// strict(): rechaza claves extra (code/diff/commands) — refuerza "ajustePlan sólo {tipo, unidades[]}" (C3).
const AjustePlanSchema = z
	.object({
		tipo: AjusteTipoSchema,
		unidades: z.array(UnitDefSchema).min(1),
	})
	.strict();

const DecisionSchema = z
	.object({
		operación: OperationSchema,
		ajustePlan: z.union([AjustePlanSchema, z.null()]).optional(),
		unidad: z.union([z.string().regex(/^u\d+$/), z.null()]).optional(),
		capacidad: z.union([CapabilitySchema, z.null()]).optional(),
		comunicación: z.union([TEXT(4000), z.null()]).optional(),
		motivo: z.string().min(1).max(2000),
		condición: z.union([TEXT(2000), z.null()]).optional(),
	})
	.strict();

export interface ParseOutcome {
	decision: Decision;
	parseFail: boolean;
	parseError?: string;
}

export function emptyDecision(): Decision {
	return {
		operación: "obtener información",
		ajustePlan: null,
		unidad: null,
		capacidad: null,
		comunicación: null,
		motivo: "salida del orquestador no parseable",
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
	if (fence && fence[1]) return fence[1].trim();
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
			// ponytail: heurístico v0 (cercas de código, diffs git). Calibrar en 06-research.
			if (v.includes("```") || v.includes("diff --git") || /(^|\n)@@ /.test(v) || /(^|\n)\+\+\+ /.test(v) || /(^|\n)--- /.test(v)) {
				return `ajustePlan con contenido ejecutable (código/diff) en unidad.${f}`;
			}
		}
	}
	return null;
}

function semanticCheck(d: Decision): string | null {
	if (d.operación === "terminar" && !d.condición) return "falta condición al terminar";
	if (d.operación === "ejecutar una unidad" && !d.unidad) return "falta unidad al ejecutar una unidad";
	if (d.operación === "comunicar al desarrollador" && !d.comunicación) return "falta comunicación al comunicar al desarrollador";
	return null;
}

function mapAjuste(a: NonNullable<z.infer<typeof AjustePlanSchema>>): AjustePlan {
	return {
		tipo: a.tipo,
		unidades: a.unidades.map<UnitDefinition>((u) => ({
			objetivo: u.objetivo,
			alcance: u.alcance ?? null,
			infoNecesaria: u.infoNecesaria ?? null,
			resultadoEsperado: u.resultadoEsperado,
			condicionFinalizacion: u.condicionFinalizacion,
			capacidad: u.capacidad as Capability,
		})),
	};
}

function mapDecision(d: z.infer<typeof DecisionSchema>): Decision {
	return {
		operación: d.operación as Operation,
		ajustePlan: d.ajustePlan ? mapAjuste(d.ajustePlan) : null,
		unidad: d.unidad ?? null,
		capacidad: d.capacidad as Capability | null,
		comunicación: d.comunicación ?? null,
		motivo: d.motivo,
		condición: d.condición ?? null,
	};
}

function normalizeKeys(obj: unknown): unknown {
	if (typeof obj !== "object" || obj === null) return obj;
	if (Array.isArray(obj)) return obj.map(normalizeKeys);
	const res: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
		let key = k;
		if (k === "infoNecesada" || k === "info_necesaria" || k === "infonecesaria") key = "infoNecesaria";
		if (k === "resultado_esperado" || k === "resultadoesperado") key = "resultadoEsperado";
		if (k === "condicion_finalizacion" || k === "condicionfinalizacion") key = "condicionFinalizacion";
		if (k === "ajuste_plan" || k === "ajusteplan") key = "ajustePlan";
		if (k === "operacion") key = "operación";
		if (k === "comunicacion") key = "comunicación";
		if (k === "condicion") key = "condición";
		res[key] = typeof v === "object" && v !== null ? normalizeKeys(v) : v;
	}
	return res;
}

/**
 * Parsea la salida del orquestador a una Decisión.
 * Fallos (vacío / JSON malformado / schema reject / semántica / contenido ejecutable) → parseFail:true
 * con parseError; el bucle los trata como info-insuficiente y reentra (C3); tope 3 → intervención.
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
		// reintento: substring del primer '{' al último '}' (envoltorio de prosa).
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
	const exec = executableContamination(decision.ajustePlan);
	if (exec) return { decision: empty, parseFail: true, parseError: exec };

	return { decision, parseFail: false };
}