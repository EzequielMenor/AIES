// tests/parse.test.ts — tests unitarios del parser de decisiones del orquestador.
//
// El parser Zod es la trust boundary entre el LLM y el bucle (plan C3): cualquier salida del
// orquestador pasa por él. Si el id de unidad es malformado, debe rechazarse aquí — no más
// adelante en el lookup del estado (eso permitía el bug "U-1 → u0" con iteración desperdiciada).
//
// Plan §3 — invariante 11: el parser rechaza aliases (`ajustarPlan`, `operacion`, etc.) y claves
// extra. La forma canónica es `{tipo:"existente",id:"u<n>"}` o `{tipo:"planificada",indice}`.

import assert from "node:assert/strict";
import { parseDecision } from "../src/orchestrator/parse.js";

function decisionWithExisting(id: string): string {
	return JSON.stringify({
		operación: "ejecutar una unidad",
		ajustePlan: null,
		unidad: { tipo: "existente", id },
		motivo: "test",
	});
}

function decisionWithPlanificada(indice: number): string {
	return JSON.stringify({
		operación: "ejecutar una unidad",
		ajustePlan: null,
		unidad: { tipo: "planificada", indice },
		motivo: "test",
	});
}

async function testUnidadMalformedIsRejected(): Promise<void> {
	// IDs no canónicos dentro de UnitRef.existente.
	const malformedCases = ["U-1", "U1", "u_0", "0", "unit-0", "u01a", "U0", "u-1", "", "u"];

	for (const malformed of malformedCases) {
		const out = parseDecision(decisionWithExisting(malformed));
		assert.equal(
			out.parseFail,
			true,
			`id malformado ${JSON.stringify(malformed)}: debe rechazarse (parseFail=true)`,
		);
		assert.ok(out.parseError, `id malformado ${JSON.stringify(malformed)}: debe incluir parseError`);
		assert.match(
			out.parseError!,
			/unidad/,
			`id malformado ${JSON.stringify(malformed)}: parseError debe mencionar "unidad" (got: ${out.parseError})`,
		);
	}

	console.log(`OK unidad-malformed: ${malformedCases.length} ids rechazados con parseFail=true`);
}

async function testUnidadWellFormedIsAccepted(): Promise<void> {
	const wellFormed = ["u0", "u1", "u2", "u42", "u123"];

	for (const id of wellFormed) {
		const out = parseDecision(decisionWithExisting(id));
		assert.equal(out.parseFail, false, `id válido ${JSON.stringify(id)}: debe aceptarse`);
		assert.deepEqual(out.decision.unidad, { tipo: "existente", id }, `id válido ${JSON.stringify(id)}: se preserva como UnitRef`);
	}

	console.log(`OK unidad-wellformed: ${wellFormed.length} ids aceptados`);
}

async function testUnidadNullIsAccepted(): Promise<void> {
	// operación ≠ "ejecutar una unidad" admite unidad:null (semanticCheck lo permite).
	const json = JSON.stringify({
		operación: "terminar",
		ajustePlan: null,
		unidad: null,
		condición: { desenlace: "completed", detalle: "cumplida" },
		motivo: "test",
	});
	const out = parseDecision(json);
	assert.equal(out.parseFail, false, `terminar admite unidad:null (parseError=${out.parseError ?? ""})`);
	assert.equal(out.decision.unidad, null);
	console.log("OK unidad-null: aceptado en operación que no requiere unidad");
}

async function testExplicitNullsAccepted(): Promise<void> {
	// Dogfooding 2026-09-04: M2.7 emits the full field set with null for the variants it
	// doesn't use. `comunicación/condición: null` must parse (≡ absent); semantics still
	// enforced per-variant by semanticCheck.
	const json = JSON.stringify({
		operación: "obtener información",
		ajustePlan: null,
		unidad: null,
		feedbackCorrectivo: null,
		comunicación: null,
		condición: null,
		motivo: "inspeccionar repo",
	});
	const out = parseDecision(json);
	assert.equal(out.parseFail, false, `nulls explícitos deben parsear (parseError=${out.parseError ?? ""})`);
	assert.equal(out.decision.comunicación, null);
	assert.equal(out.decision.condición, null);

	// Pero comunicar SIN comunicación (null aquí ya vale ausente... ) — la variante requiere objeto:
	const comunicarNull = JSON.stringify({
		operación: "comunicar al desarrollador",
		ajustePlan: null,
		unidad: null,
		comunicación: null,
		condición: null,
		motivo: "pregunta",
	});
	const out2 = parseDecision(comunicarNull);
	assert.equal(out2.parseFail, true, "comunicar con comunicación:null debe fallar semántica");
	assert.match(out2.parseError ?? "", /comunicación/);
	console.log("OK nulls-explícitos: aceptados donde ≡ ausente, rechazados cuando la variante exige objeto");
}

async function testPlanificadaIsAccepted(): Promise<void> {
	const out = parseDecision(decisionWithPlanificada(0));
	assert.equal(out.parseFail, false);
	assert.deepEqual(out.decision.unidad, { tipo: "planificada", indice: 0 });
	console.log("OK planificada: referencia por índice aceptada");
}

async function testAliasRejection(): Promise<void> {
	// Plan §3 — invariante 11: aliases como "operacion", "ajuste_plan", etc. se rechazan.
	const json = JSON.stringify({
		operacion: "terminar",
		motivo: "test",
		condición: { desenlace: "completed", detalle: "x" },
	});
	const out = parseDecision(json);
	assert.equal(out.parseFail, true, "alias 'operacion' debe rechazarse");
	assert.match(out.parseError!, /schema/);
	console.log("OK alias: operacion rechazado");
}

async function testReemplazaValidation(): Promise<void> {
	// descomponer/determinar rechaza reemplaza no vacío.
	const json = JSON.stringify({
		operación: "ejecutar una unidad",
		ajustePlan: {
			tipo: "descomponer",
			reemplaza: ["u0"],
			unidades: [{ objetivo: "x", resultadoEsperado: "y", condicionFinalizacion: "ok", capacidad: "implementer" }],
		},
		unidad: { tipo: "planificada", indice: 0 },
		motivo: "test",
	});
	const out = parseDecision(json);
	// El ajustePlan.strict() no rechaza reemplaza por sí solo — eso se valida en runtime al aplicar.
	// El parser sí acepta el schema, pero applyAjustePlan lo defenderá.
	assert.equal(out.parseFail, false, "schema acepta reemplaza no vacío (runtime lo defenderá)");
	console.log("OK reemplaza: schema lo acepta; runtime defenderá en applyAjustePlan");
}

async function main(): Promise<void> {
	await testUnidadMalformedIsRejected();
	await testUnidadWellFormedIsAccepted();
	await testUnidadNullIsAccepted();
	await testExplicitNullsAccepted();
	await testPlanificadaIsAccepted();
	await testAliasRejection();
	await testReemplazaValidation();
	console.log("\nparse.test OK: contrato de UnitRef (^u\\d+$) y aliases verificados");
}

main().catch((e) => {
	console.error("parse.test FAIL:", e);
	process.exit(1);
});