// tests/parse.test.ts — tests unitarios del parser de decisiones del orquestador.
//
// El parser Zod es la trust boundary entre el LLM y el bucle (plan C3): cualquier salida del
// orquestador pasa por él. Si el id de unidad es malformado, debe rechazarse aquí — no más
// adelante en el lookup del estado (eso permitía el bug "U-1 → u0" con iteración desperdiciada).
//
// Sin framework externo: `node:assert/strict`. Compila con `tsc -p tsconfig.test.json` y se
// ejecuta con `node dist-test/tests/parse.test.js`.

import assert from "node:assert/strict";
import { parseDecision } from "../src/orchestrator/parse.js";

function decision(unidad: unknown): string {
	return JSON.stringify({
		operación: "ejecutar una unidad",
		ajustePlan: null,
		unidad,
		capacidad: "implementer",
		comunicación: null,
		motivo: "test",
		condición: null,
	});
}

async function testUnidadMalformedIsRejected(): Promise<void> {
	const malformedCases = ["U-1", "U1", "u_0", "0", "unit-0", "u01a", "U0", "u-1", "", "u"];

	for (const malformed of malformedCases) {
		const out = parseDecision(decision(malformed));
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
		const out = parseDecision(decision(id));
		assert.equal(out.parseFail, false, `id válido ${JSON.stringify(id)}: debe aceptarse`);
		assert.equal(out.decision.unidad, id, `id válido ${JSON.stringify(id)}: se preserva`);
	}

	console.log(`OK unidad-wellformed: ${wellFormed.length} ids aceptados`);
}

async function testUnidadNullIsAccepted(): Promise<void> {
	// operación ≠ "ejecutar una unidad" admite unidad:null (semanticCheck lo permite).
	const json = JSON.stringify({
		operación: "terminar",
		ajustePlan: null,
		unidad: null,
		capacidad: null,
		comunicación: null,
		motivo: "test",
		condición: "cumplida",
	});
	const out = parseDecision(json);
	assert.equal(out.parseFail, false, `terminar admite unidad:null (parseError=${out.parseError ?? ""})`);
	assert.equal(out.decision.unidad, null);
	console.log("OK unidad-null: aceptado en operación que no requiere unidad");
}

async function main(): Promise<void> {
	await testUnidadMalformedIsRejected();
	await testUnidadWellFormedIsAccepted();
	await testUnidadNullIsAccepted();
	console.log("\nparse.test OK: contrato de id de unidad (^u\\d+$) verificado");
}

main().catch((e) => {
	console.error("parse.test FAIL:", e);
	process.exit(1);
});
