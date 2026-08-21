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

	it("spinner decidiendo → decisión sin \\r residual en las líneas fijas", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onDecideStart(0);
		renderer.onDecideSuccess(infoDecision());
		const plain = stream.plain();
		// En TTY el spinner se borra con \\r; lo que queda visible es lo posterior al último CR.
		const visual = plain.replace(/[^\n]*\r/g, "");
		assert.match(plain, /Orquestador decidiendo/);
		assert.match(visual, /Decisión : Obtener información/);
		assert.doesNotMatch(visual, /Orquestador decidiendo/);
		assert.equal(visual.includes("\r"), false);
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

	it("intervention:stopped pinta aviso ámbar", () => {
		const stream = captureStream(true);
		renderer = new StreamRenderer(stream);
		renderer.onLoopObservation({ phase: "intervention:stopped", state: sampleState() });
		assert.match(stream.plain(), /Intervención del usuario: ejecución detenida/);
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

	it("no emite secuencias \\r de spinner", () => {
		const stream = captureStream(false);
		renderer = new StreamRenderer(stream);
		renderer.onDecideStart(0);
		renderer.onDecideSuccess(infoDecision());
		renderer.finalize();
		assert.equal(stream.text().includes("\r"), false);
		assert.match(stream.plain(), /Orquestador decidiendo/);
		assert.match(stream.plain(), /Decisión/);
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
});
