// src/ui/stream-renderer.test.ts — T0: StreamRenderer sobre stream capturado (TTY y pipe).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";

import type { LoopObservation } from "../core/observation.js";
import { initState, type Decision, type RuntimeState } from "../core/state.js";
import type { LogEntry } from "../observability.js";
import type { WorkerTelemetry } from "../telemetry/types.js";
import { StreamRenderer } from "./stream-renderer.js";

const TELEM: WorkerTelemetry = {
	usage: null,
	contextUsage: null,
	telemetryUnavailable: false,
};

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

interface CaptureStream extends NodeJS.WritableStream {
	isTTY: boolean;
	chunks: string[];
	text(): string;
	plain(): string;
}

function captureStream(isTTY: boolean): CaptureStream {
	const chunks: string[] = [];
	const stream = {
		isTTY,
		chunks,
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
		text: () => chunks.join(""),
		plain: () => stripAnsi(chunks.join("")),
	};
	return stream as unknown as CaptureStream;
}

function sampleState(over: Partial<RuntimeState> = {}): RuntimeState {
	return {
		...initState(
			{
				objetivo: "probar TUI",
				alcance: null,
				restricciones: null,
				resultadoEsperado: null,
				condicionFinalizacion: "ok",
			},
			{ maxIterations: 12 },
		),
		...over,
	};
}

function infoDecision(): Decision {
	return {
		operación: "obtener información",
		ajustePlan: null,
		unidad: null,
		capacidad: null,
		comunicación: null,
		motivo: "explorar",
		condición: null,
	};
}

function comunicarDecision(texto: string): Decision {
	return {
		operación: "comunicar al desarrollador",
		ajustePlan: null,
		unidad: null,
		capacidad: null,
		comunicación: texto,
		motivo: "aviso",
		condición: null,
	};
}

const compaction = (fase: "start" | "end"): LogEntry => ({
	type: "compaction",
	fase,
	reason: "threshold",
	summary: null,
	firstKeptEntryId: null,
	tokensBefore: null,
	estimatedTokensAfter: null,
	aborted: false,
	willRetry: false,
	errorMessage: null,
});

describe("StreamRenderer TTY", () => {
	let renderer: StreamRenderer | undefined;

	afterEach(() => {
		renderer?.finalize();
	});

	// ── Tests de renderizado de errores (u2) ─────────────────────────────────

	it("onTaskFailed muestra barra con marca retry-safe cuando isRetrySafe=true", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		// Simular que execution:resolved fijó isRetrySafe=true (tipo fallo/parse_error)
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state: sampleState(),
			decision: infoDecision(),
			result: { kind: "fallo", text: "test", unidadId: "u0", passed: false },
			telemetry: TELEM,
			atribución: null,
		});
		renderer.onTaskFailed("límite de iteraciones");
		const plain = stream.plain();
		assert.match(plain, /✗ TASK FAILED/);
		assert.match(plain, /\[retry-safe\]/);
		assert.match(plain, /límite de iteraciones/);
	});

	it("onTaskFailed sin retry-safe (tipo límite) no muestra marca retry-safe", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		// Simular límite → no retry-safe
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state: sampleState(),
			decision: infoDecision(),
			result: { kind: "límite", text: "max", unidadId: null, passed: null },
			telemetry: TELEM,
			atribución: null,
		});
		renderer.onTaskFailed("límite de iteraciones");
		const plain = stream.plain();
		assert.match(plain, /✗ TASK FAILED/);
		assert.doesNotMatch(plain, /\[retry-safe\]/);
	});

	it("onWorkerFinish populate failedUnits cuando passed=false", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		// Necesita un worker abierto
		renderer.onWorkerStart({ id: "u1", objetivo: "test", capacidad: "implementer", estado: "En curso" }, { model: "test" });
		renderer.onWorkerFinish("u1", { kind: "unidad", text: "archivo no encontrado", unidadId: "u1", passed: false });
		renderer.onTaskFailed("error");
		const plain = stream.plain();
		assert.match(plain, /Unidades fallidas:/);
		assert.match(plain, /• u1: archivo no encontrado/);
	});

	it("T4.4: onVerificationResult resume la salida larga a una línea sin --verbose", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream); // verbose por defecto (sin AIES_VERBOSE)
		renderer.onWorkerStart({ id: "v0", objetivo: "verify", capacidad: "verifier", estado: "En curso" }, { model: "test" });
		renderer.onVerificationStart("v0", "npm test");
		const long = Array.from({ length: 30 }, (_, i) => `linea de salida ${i}`).join("\n");
		renderer.onVerificationResult("v0", "FAIL", long);
		const plain = stream.plain();
		// Resumida a UNA línea "Salida: ..." (multilínea colapsada + recortada a 140 chars).
		assert.doesNotMatch(plain, /linea de salida 29/);
		assert.match(plain, /Salida: linea de salida 0 linea de salida 1/);
	});

	it("T4.4: onVerificationResult con verbose:true no trunca la salida", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream, { verbose: true });
		renderer.onWorkerStart({ id: "v0", objetivo: "verify", capacidad: "verifier", estado: "En curso" }, { model: "test" });
		renderer.onVerificationStart("v0", "npm test");
		const long = Array.from({ length: 10 }, (_, i) => `linea ${i}`).join("\n");
		renderer.onVerificationResult("v0", "FAIL", long);
		const plain = stream.plain();
		assert.match(plain, /linea 0/);
		assert.match(plain, /linea 9/);
	});

	it("onVerificationResult populate failedVerifications cuando verdict=FAIL", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onWorkerStart({ id: "v0", objetivo: "verify", capacidad: "verifier", estado: "En curso" }, { model: "test" });
		renderer.onVerificationStart("v0", "npm test");
		renderer.onVerificationResult("v0", "FAIL", "Expected 2, got 1");
		renderer.onTaskFailed("error");
		const plain = stream.plain();
		assert.match(plain, /Verificaciones fallidas:/);
		assert.match(plain, /• Expected 2, got 1/);
	});

	it("buildFailureSummary genera línea compacta correcta para fallos mixtos", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onWorkerStart({ id: "u1", objetivo: "test", capacidad: "implementer", estado: "En curso" }, { model: "test" });
		renderer.onWorkerFinish("u1", { kind: "unidad", text: "fail", unidadId: "u1", passed: false });
		renderer.onWorkerStart({ id: "u2", objetivo: "test2", capacidad: "implementer", estado: "En curso" }, { model: "test" });
		renderer.onWorkerFinish("u2", { kind: "unidad", text: "fail2", unidadId: "u2", passed: false });
		renderer.onWorkerStart({ id: "v0", objetivo: "verify", capacidad: "verifier", estado: "En curso" }, { model: "test" });
		renderer.onVerificationStart("v0", "npm test");
		renderer.onVerificationResult("v0", "FAIL", "error");
		renderer.onTaskFailed("error");
		const plain = stream.plain();
		assert.match(plain, /Fallos:.*2 unidades fallidas.*1 verificación fallida/);
	});

	it("buildFailureSummary singular/plural correcto", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		// Una unidad fallida
		renderer.onWorkerStart({ id: "u1", objetivo: "test", capacidad: "implementer", estado: "En curso" }, { model: "test" });
		renderer.onWorkerFinish("u1", { kind: "unidad", text: "fail", unidadId: "u1", passed: false });
		renderer.onTaskFailed("error");
		let plain = stream.plain();
		assert.match(plain, /1 unidad fallida/);
		assert.doesNotMatch(plain, /1 unidades fallidas/);

		// Reset y probar 2+ unidades
		const stream2 = captureStream(true);
		renderer = new StreamRenderer(stream2);
		renderer.onWorkerStart({ id: "u1", objetivo: "test", capacidad: "implementer", estado: "En curso" }, { model: "test" });
		renderer.onWorkerFinish("u1", { kind: "unidad", text: "fail", unidadId: "u1", passed: false });
		renderer.onWorkerStart({ id: "u2", objetivo: "test2", capacidad: "implementer", estado: "En curso" }, { model: "test" });
		renderer.onWorkerFinish("u2", { kind: "unidad", text: "fail2", unidadId: "u2", passed: false });
		renderer.onTaskFailed("error");
		plain = stream2.plain();
		assert.match(plain, /2 unidades fallidas/);
		assert.doesNotMatch(plain, /2 unidad fallidas/);
	});

	it("onTaskFailed sin fallos pendientes solo muestra barra y razón", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onTaskFailed("causa desconocida");
		const plain = stream.plain();
		assert.match(plain, /✗ TASK FAILED.*causa desconocida/);
		assert.doesNotMatch(plain, /Unidades fallidas:/);
		assert.doesNotMatch(plain, /Verificaciones fallidas:/);
	});

	it("finalize() limpia failedUnits, failedVerifications e isRetrySafe", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		// Poblar estado de fallo
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state: sampleState(),
			decision: infoDecision(),
			result: { kind: "fallo", text: "test", unidadId: "u0", passed: false },
			telemetry: TELEM,
			atribución: null,
		});
		renderer.onWorkerStart({ id: "u1", objetivo: "test", capacidad: "implementer", estado: "En curso" }, { model: "test" });
		renderer.onWorkerFinish("u1", { kind: "unidad", text: "fail", unidadId: "u1", passed: false });
		renderer.finalize();
		// Llamar onTaskFailed después de finalize → sin fallos pendientes
		renderer.onTaskFailed("después de finalize");
		const plain = stream.plain();
		assert.doesNotMatch(plain, /Unidades fallidas:/);
		assert.doesNotMatch(plain, /\[retry-safe\]/);
	});

	it("parse_error en execution:resolved también fija isRetrySafe=true", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state: sampleState(),
			decision: infoDecision(),
			result: { kind: "parse_error", text: "json inválido", unidadId: null, passed: null },
			telemetry: TELEM,
			atribución: null,
		});
		renderer.onTaskFailed("parse error");
		const plain = stream.plain();
		assert.match(plain, /\[retry-safe\]/);
	});

	// ── Tests existentes ──────────────────────────────────────────────────────

	it("parse-fail muestra el contador ya incrementado (1/3), no 0/3", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		const obs: LoopObservation = {
			phase: "decision:resolved",
			state: sampleState({ consecutiveParseFailures: 1 }),
			decision: null,
			parseFail: true,
			parseError: "JSON malformado",
			raw: "{",
			telemetry: TELEM,
		};
		renderer.onLoopObservation(obs);
		const plain = stream.plain();
		assert.match(plain, /Fallo de parseo del orquestador \(1\/3\): JSON malformado/);
		assert.doesNotMatch(plain, /\(0\/3\)/);
	});

	it("limit:reached distingue terminar vs intervenir", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({
			phase: "limit:reached",
			state: sampleState({ iterations: 12 }),
			action: "intervenir",
			reason: "límite de iteraciones alcanzado (12)",
		});
		assert.match(stream.plain(), /límite alcanzado — requiere intervención: límite de iteraciones alcanzado \(12\)/);

		const stream2 = captureStream(true);
		renderer = new StreamRenderer(stream2);
		renderer.onLoopObservation({
			phase: "limit:reached",
			state: sampleState(),
			action: "terminar",
			reason: "límite de iteraciones alcanzado (12)",
		});
		assert.match(stream2.plain(), /límite alcanzado — terminando: límite de iteraciones alcanzado \(12\)/);
	});

	it("unidad inexistente cita el id referenciado", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({
			phase: "error:unidad-inexistente",
			state: sampleState(),
			decision: {
				operación: "ejecutar una unidad",
				ajustePlan: null,
				unidad: "u99",
				capacidad: "implementer",
				comunicación: null,
				motivo: "ejecutar",
				condición: null,
			},
		});
		assert.match(stream.plain(), /Unidad inexistente: el orquestador referenció "u99"/);
	});

	it("comunicación del orquestador es bloque cyan, no ámbar de alerta", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state: sampleState(),
			decision: comunicarDecision("hace falta un archivo de config"),
			result: { kind: "comunicación", text: "hace falta un archivo de config", unidadId: null, passed: null },
			telemetry: TELEM,
			atribución: null,
		});
		const plain = stream.plain();
		assert.match(plain, /💬 Orquestador: hace falta un archivo de config/);
		assert.doesNotMatch(plain, /▲ Orquestador/);
	});

	it("compaction start/end y no-op en LogEntry que no es compaction", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLogEntry(compaction("start"));
		renderer.onLogEntry(compaction("end"));
		renderer.onLogEntry({
			type: "decision",
			iter: 0,
			operación: "obtener información",
			ajustePlan: null,
			motivo: "x",
			unidad: null,
			capacidad: null,
			condición: null,
			parseFail: false,
		});
		const plain = stream.plain();
		assert.match(plain, /compactando contexto/);
		assert.match(plain, /contexto compactado/);
		assert.doesNotMatch(plain, /obtener información/);
	});

	it("spinner decidiendo → sin \\r residual y SIN volcar la deliberación por defecto", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onDecideStart(0);
		renderer.onDecideSuccess(infoDecision());
		const plain = stream.plain();
		// En TTY el spinner se borra con \\r; lo que queda visible es lo posterior al último CR.
		const visual = plain.replace(/[^\n]*\r/g, "");
		assert.match(plain, /Orquestador decidiendo/);
		// Corrección UX: la deliberación del orquestador ya NO ensucia el scrollback.
		assert.doesNotMatch(visual, /Decisión :/);
		assert.doesNotMatch(visual, /Motivo   :/);
		assert.doesNotMatch(visual, /Orquestador decidiendo/);
		assert.equal(visual.includes("\r"), false);
	});

	it("con verbose, la decisión sí se muestra como antes", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream, { verbose: true });
		renderer.onDecideStart(0);
		renderer.onDecideSuccess(infoDecision());
		const plain = stream.plain();
		const visual = plain.replace(/[^\n]*\r/g, "");
		assert.match(visual, /Decisión : Obtener información/);
	});

	it("finalize() con spinner activo limpia el overlay y no deja el timer vivo", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onDecideStart(0);
		renderer.finalize();
		const raw = stream.text();
		assert.match(raw, /\r\x1b\[2K/);
	});

	it("otras fases de observación son no-op", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({ phase: "decision:start", state: sampleState() });
		renderer.onLoopObservation({
			phase: "decision:resolved",
			state: sampleState(),
			decision: infoDecision(),
			parseFail: false,
			parseError: null,
			raw: "{}",
			telemetry: TELEM,
		});
		assert.equal(stream.text(), "");
	});

	it("intervention:paused pinta aviso ámbar (ADR-012)", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({ phase: "intervention:paused", state: sampleState() });
		assert.match(stream.plain(), /Tarea pausada por el desarrollador — usa \/resume para continuarla\./);
	});

	it("intervention:adjustment pinta línea violeta (T2.1)", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({
			phase: "intervention:adjustment",
			state: sampleState(),
			text: "verifica también el caso de borde",
		});
		const plain = stream.plain();
		assert.match(plain, /Intervención del desarrollador incorporada/);
		assert.match(plain, /se tendrá en cuenta en la decisión/);
	});

	it("execution:resolved pinta línea de estado T3.1 con telemetría acumulada y verify", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		const telem: WorkerTelemetry = {
			usage: { tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.0023 },
			contextUsage: { tokens: 5000, contextWindow: 100000, percent: 5 },
			telemetryUnavailable: false,
		};
		const state = sampleState({
			iterations: 2,
			results: [
				{ kind: "unidad", text: "ok", unidadId: "u0", passed: true },
				{ kind: "unidad", text: "fail", unidadId: "u1", passed: false },
			],
		});
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state,
			decision: infoDecision(),
			result: { kind: "info", text: "info", unidadId: null, passed: null },
			telemetry: telem,
			atribución: null,
		});
		const plain = stream.plain();
		assert.match(plain, /iter 2\/12/);
		assert.match(plain, /150 tok/);
		assert.match(plain, /\$0\.002/);
		assert.match(plain, /ctx 5%/);
		assert.match(plain, /verify 1\/2/);
	});

	it("T3.1: usage null → n/d explícito (RNF-07/17)", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state: sampleState({ iterations: 1 }),
			decision: infoDecision(),
			result: { kind: "info", text: "", unidadId: null, passed: null },
			telemetry: TELEM,
			atribución: null,
		});
		const plain = stream.plain();
		assert.match(plain, /n\/d tok/);
		assert.match(plain, /cost n\/d/);
		assert.match(plain, /ctx n\/d/);
	});

	it("T3.1: acumulación persiste con parse-fail (telemetría del orquestador también cuenta)", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		const telem: WorkerTelemetry = {
			usage: { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0.001 },
			contextUsage: null,
			telemetryUnavailable: false,
		};
		renderer.onLoopObservation({
			phase: "decision:resolved",
			state: sampleState({ consecutiveParseFailures: 1 }),
			decision: null,
			parseFail: true,
			parseError: "x",
			raw: "",
			telemetry: telem,
		});
		renderer.onLoopObservation({
			phase: "execution:resolved",
			state: sampleState({ iterations: 1 }),
			decision: infoDecision(),
			result: { kind: "info", text: "", unidadId: null, passed: null },
			telemetry: telem,
			atribución: null,
		});
		// El acumulado del parse-fail debe sobrevivir; ambos vueltas comparten el renderer.
		const plain = stream.plain();
		assert.match(plain, /\$0\.002/);
	});
});

describe("StreamRenderer pipe (no-TTY)", () => {
	let renderer: StreamRenderer | undefined;
	afterEach(() => renderer?.finalize());

	it("no emite secuencias \\r de spinner y omite la deliberación por defecto", () => {
		const stream = captureStream(false);
		renderer = new StreamRenderer(stream);
		renderer.onDecideStart(0);
		renderer.onDecideSuccess(infoDecision());
		renderer.finalize();
		assert.equal(stream.text().includes("\r"), false);
		assert.match(stream.plain(), /Orquestador decidiendo/);
		// Por defecto NO se vuelca "Decisión :" en pipe; queda sólo para verbose.
		assert.doesNotMatch(stream.plain(), /Decisión :/);
	});

	it("parse-fail y límite siguen siendo líneas completas", () => {
		const stream = captureStream(false);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({
			phase: "decision:resolved",
			state: sampleState({ consecutiveParseFailures: 2 }),
			decision: null,
			parseFail: true,
			parseError: null,
			raw: "",
			telemetry: TELEM,
		});
		renderer.onLoopObservation({
			phase: "limit:reached",
			state: sampleState(),
			action: "intervenir",
			reason: "cap",
		});
		const plain = stream.plain();
		assert.match(plain, /Fallo de parseo del orquestador \(2\/3\)/);
		assert.match(plain, /límite alcanzado — requiere intervención: cap/);
		assert.equal(plain.includes("\r"), false);
	});

	it("renderiza plan multi-unidad con ramas de árbol ├─ y └─", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		const multiPlanDecision: Decision = {
			operación: "ejecutar una unidad",
			ajustePlan: {
				tipo: "descomponer",
				unidades: [
					{ objetivo: "explorar endpoints", alcance: null, infoNecesaria: null, resultadoEsperado: "mapa", condicionFinalizacion: "ok", capacidad: "explorer" },
					{ objetivo: "implementar auth middleware", alcance: null, infoNecesaria: null, resultadoEsperado: "código", condicionFinalizacion: "ok", capacidad: "implementer" },
					{ objetivo: "verificar suite completa", alcance: null, infoNecesaria: null, resultadoEsperado: "pass", condicionFinalizacion: "ok", capacidad: "verifier" },
				],
			},
			unidad: "u0",
			capacidad: "explorer",
			comunicación: null,
			motivo: "descomposición en 3 fases",
			condición: null,
		};
		renderer.onDecideSuccess(multiPlanDecision);
		const plain = stream.plain();
		assert.match(plain, /Plan:/);
		assert.match(plain, /├─ explorar endpoints/);
		assert.match(plain, /├─ implementar auth middleware/);
		assert.match(plain, /└─ verificar suite completa/);
	});
});

