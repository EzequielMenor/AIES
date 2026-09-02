// src/ui/stream-renderer.ts — renderizado nativo de terminal (ANSI) de la ejecución AIES.
//
// Implementa `AiesEventHandlers` (contrato canónico de src/core/events.ts): consume los eventos
// tipados del bucle y los pinta en la terminal con un estilo limpio, vertical y secuencial
// (Claude Code / Cargo / Aider). Scroll nativo de Unix; sin split-panes ni dashboards.
//
// Mecánicas clave:
//  1. Spinner en UNA línea (ANSI `\r` + `\x1b[2K`), sobrescrita durante la ejecución de un
//     tool/verificación y reemplazada por un `✓`/`✗` fijo al terminar (persistencia de línea).
//  2. Los outputs con salto de línea no rompen el stream: al volcar texto se limpia el overlay
//     activo, se escriben las líneas estáticas y se reanuda el spinner en una línea nueva.
//  3. En TTY se reescribe la línea del spinner; en no-TTY (pipe) cada pintado es una línea
//     completa para no corromper la salida canalizada.
//
// Contraste alto para terminales oscuras (REGLAS DE UX):
//  - Cyan (#38bdf8): nombres de tools y estados de ejecución.
//  - Verde  (#3fb950): PASS, verificación OK, completado.
//  - Rojo   (#f85149): FAIL, errores, fallos de verificación.
//  - Ámbar  (#d29922): warnings, límites, re-descomposición.
//  - Blanco brillante: texto principal y explicaciones.
//
// Nota: `decide`/`execute` son miembros obligatorios del contrato, pero no son responsabilidad del
// renderer (es puramente un consumidor/presentador). Si se pasara el renderer a `runLoop` tal cual
// lanzarían un error claro; úsese `StreamRenderer.merge` para componer decide/execute reales.

import pc from "picocolors";
import type {
	AiesEventHandlers,
	DecideOutcome,
	ExecuteOutcome,
	TaskTelemetry,
	UnitResult,
	WorkerEventSink,
	WorkerInfo,
} from "../core/events.js";
import type { LoopObservation } from "../core/observation.js";
import type { Decision, RuntimeState, WorkUnit } from "../core/state.js";
import type { LogEntry } from "../observability.js";

// ── Paleta ANSI truecolor (hex exactos de las reglas de UX) ─────────────────
function truecolor(hex: string, s: string): string {
	const h = hex.replace(/^#/, "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}
export const cyan = (s: string) => truecolor("#38bdf8", s);
export const green = (s: string) => truecolor("#3fb950", s);
export const red = (s: string) => truecolor("#f85149", s);
export const amber = (s: string) => truecolor("#d29922", s);
/** Violeta del prototipo TUI (`#a371f7`): ajuste en caliente / intervención. */
export const violet = (s: string) => truecolor("#a371f7", s);
/** Alias exportado para reutilizar la paleta ámbar (preflight, avisos) sin duplicarla. */
export const amberText = amber;
const bright = pc.bold; // énfasis (picocolors)

/** Formato compartido `cost` (T3.1 + `/status`): null → `n/d`; <1 → `$0.000`; ≥1 → `$0.00`. */
export function formatCost(cost: number | null): string {
	if (cost === null) return "n/d";
	return cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

/** Formato compartido de tokens (T3.1 + `/status`): <1000 → número; ≥1000 → `1.2k`. */
export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 10 ? k.toFixed(1) : k.toFixed(2)}k`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

const CAP_LABELS: Record<string, string> = {
	explorer: "Explorer",
	implementer: "Implementer",
	verifier: "Verifier",
};

/** Estado vivo de la línea de spinner en curso. */
interface ActiveSpinner {
	prefix: string;
	animated: string;
	frame: number;
	ticker: ReturnType<typeof setInterval> | null;
}

/** Cabecera del bloque de worker abierto. */
interface OpenWorker {
	id: string;
	esVerificacion: boolean;
}

export class StreamRenderer implements AiesEventHandlers {
	private readonly stream: NodeJS.WritableStream;
	private readonly tty: boolean;
	private spinner: ActiveSpinner | null = null;
	private worker: OpenWorker | null = null;
	/** Re-cuento de re-descomposiciones (para compactar avisos ámbar). */
	private recomposes = 0;
	/** Último comando de verificación activo (para pintar su `✓` al cerrar). */
	private verificationCommand: string | null = null;
	/** Último tool invocado (para conservar el target en el `✓` de cierre). */
	private lastTool: { tool: string; target: string | null } | null = null;
	/** T3.1 — acumulador de telemetría del renderer (independiente del del bucle). Se suma
	 *  en cada `decision:resolved` / `execution:resolved` con `usage` fiable; `null` se conserva
	 *  como "no conocido". RNF-07/17: nunca inventar números. */
	private tokenTotal: number = 0;
	private costTotal: number = 0;
	private telemKnown: boolean = false;
	/** T3.1 — último `contextUsage.percent` observado (int 0..100). `null` = nunca conocido. */
	private lastContextPct: number | null = null;
	/** Unidades que fallaron (unitId → reason). */
	private failedUnits: Map<string, string> = new Map();
	/** Verificaciones que fallaron. */
	private failedVerifications: string[] = [];
	/** Flag: el último fallo es retry-safe (se puede reintentar). */
	private isRetrySafe = false;
	/** Línea de estado de telemetría pendiente de emisión tras cerrar el worker. */
	private pendingStatusLine: string | null = null;

	constructor(stream: NodeJS.WritableStream = process.stdout) {
		this.stream = stream;
		this.tty = Boolean("isTTY" in stream && stream.isTTY);
	}

	// ------------------------------------------------------------------ utilidades

	private termWidth(): number {
		const cols = "columns" in this.stream && typeof this.stream.columns === "number" ? this.stream.columns : 0;
		return this.tty && cols ? Math.max(20, cols) : 80;
	}

	private raw(s: string): void {
		this.stream.write(s);
	}

	/** Escribe una línea terminada en \n (traduciendo \r y saltos CR). */
	private line(s: string): void {
		const clean = s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		this.raw(clean.endsWith("\n") ? clean : clean + "\n");
	}

	/** Limpia el overlay del spinner (TTY) o es no-op en pipe. */
	private clearOverlay(): void {
		if (this.tty) this.raw("\r\x1b[2K");
	}

	private frameChar(): string {
		return SPINNER_FRAMES[(this.spinner?.frame ?? 0) % SPINNER_FRAMES.length]!;
	}

	private paintSpinner(): void {
		if (!this.spinner) return;
		const { prefix, animated } = this.spinner;
		if (this.tty) {
			this.clearOverlay();
			this.raw(`${prefix}${this.frameChar()} ${animated}`);
		} else {
			this.raw(`${prefix}• ${animated}\n`);
		}
	}

	/** Separa el spinner en curso: limpia overlay y detiene el timer. */
	private detachSpinner(): void {
		if (!this.spinner) return;
		if (this.spinner.ticker) clearInterval(this.spinner.ticker);
		this.clearOverlay();
		this.spinner = null;
	}

	/** Fija la línea de spinner (una única línea vivrecite). */
	private spin(prefix: string, animated: string): void {
		this.detachSpinner();
		this.spinner = { prefix, animated, frame: 0, ticker: null };
		if (this.tty) {
			this.paintSpinner();
			this.spinner.ticker = setInterval(() => {
				if (this.spinner) {
					this.spinner.frame += 1;
					this.paintSpinner();
				}
			}, 80);
		} else {
			this.paintSpinner();
		}
	}

	/** Cierra la línea viva reemplazándola por su versión estática final. */
	private settle(finalLine: string): void {
		this.detachSpinner();
		this.raw(finalLine.endsWith("\n") ? finalLine : finalLine + "\n");
	}

	/** Vuelca texto posiblemente multilínea sin romper el spinner: limpia, escribe, reanuda. */
	private flush(text: string): void {
		if (!text) return;
		const hadSpinner = this.spinner !== null;
		this.detachSpinner();
		this.line(text);
		if (hadSpinner) this.paintSpinner();
	}

	private renderBar(middle: string): string {
		const width = this.termWidth();
		const head = `── ${middle} `;
		const rest = Math.max(1, width - head.length - 1);
		return `${head}${"─".repeat(rest)}`;
	}

	/** Escribe un ramal del árbol con salto de línea seguro. */
	private branch(prefix: string, body: string): void {
		const lines = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
		lines.forEach((ln, i) => this.line(i === 0 ? `${prefix}${ln}` : `│     ${ln}`));
	}

	private formatElapsed(startTs: number, endTs: number): string {
		const total = Math.max(0, Math.floor((endTs - startTs) / 1000));
		const mins = Math.floor(total / 60);
		const secs = total % 60;
		return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	}

	private formatCost(cost: number | null): string {
		return formatCost(cost);
	}

	/** T3.1 — formato compacto de tokens: <1000 → número, ≥1000 → `1.2k` (estilo prototipo). */
	private formatTokens(n: number): string {
		return formatTokens(n);
	}

	/** T3.1 — porcentaje de contexto: el binding dice 0..100 entero, pero en la práctica emite
	 *  float con precisión sobrante. Redondeamos a entero para no hacer ruido visual. */
	private formatContextPct(pct: number | null): string {
		if (pct === null) return "ctx n/d";
		return `ctx ${Math.round(pct)}%`;
	}

	/** Deriva el target (path/cmd/pattern) de los args de un tool. */
	private deriveTarget(args: Record<string, unknown>): string | null {
		const candidates = [args.path, args.file_path, args.cmd, args.command, args.pattern];
		for (const c of candidates) {
			if (typeof c === "string" && c.length > 0) return c;
		}
		return null;
	}

	private describeDecision(d: Decision): string {
		const plan = d.ajustePlan && d.ajustePlan.unidades.length > 0 ? ` · plan: ${d.ajustePlan.unidades.length} unidades` : "";
		switch (d.operación) {
			case "ejecutar una unidad":
				return `Ejecutar unidad${d.unidad ? ` (${d.unidad.tipo === "existente" ? d.unidad.id : `planificada[${d.unidad.indice}]`})` : ""}${plan}`;
			case "obtener información":
				return "Obtener información";
			case "comunicar al desarrollador":
				return "Comunicar al desarrollador";
			case "terminar":
				return "Terminar";
			default:
				return d.motivo;
		}
	}

	private closeWorker(): void {
		if (!this.worker) return;
		this.worker = null;
	}

	// ------------------------------------------------------------------ handlers

	/**
	 * `decide`/`execute` no son responsabilidad del renderer (presentador puro): son stubs que
	 * lanzan un error claro y se sustituyen al componer el bucle con `StreamRenderer.merge`.
	 */
	decide: (state: RuntimeState) => Promise<DecideOutcome> = () => {
		throw new Error("StreamRenderer no implementa decide: compón decide/execute con StreamRenderer.merge");
	};
	execute: (state: RuntimeState, decision: Decision, events: WorkerEventSink) => Promise<ExecuteOutcome> = () => {
		throw new Error("StreamRenderer no implementa execute: compón decide/execute con StreamRenderer.merge");
	};

	onTaskStart(state: RuntimeState): void {
		this.line("");
		this.line(this.renderBar("AIES Orchestrator"));
		this.line(`${bright("▶")} Objetivo : ${cyan(state.task.objetivo)}`);
	}

	onDecideStart(_iteration: number): void {
		this.spin("", `${cyan("◆")} Orquestador decidiendo…`);
	}

	onDecideSuccess(decision: Decision): void {
		this.detachSpinner();
		const esRedescomposicion =
			decision.ajustePlan?.tipo === "re-descomponer" || decision.ajustePlan?.tipo === "cambiar de estrategia";
		if (esRedescomposicion) {
			this.recomposes += 1;
			this.line(`${amber("▲")} ${amber(`Re-descomponiendo (re-descomposición #${this.recomposes})`)}: ${decision.motivo}`);
		}
		if (decision.ajustePlan && decision.ajustePlan.unidades.length > 1) {
			this.line(`${bright("Plan:")}`);
			decision.ajustePlan.unidades.forEach((u, idx) => {
				const branch = idx === decision.ajustePlan!.unidades.length - 1 ? "└─" : "├─";
				this.line(`  ${cyan(branch)} ${u.objetivo}`);
			});
		}
		this.line(`${green("✓")} Decisión : ${this.describeDecision(decision)}`);
		this.line(`${"  "}Motivo   : ${decision.motivo}`);
		this.line("");
	}

	onWorkerStart(unit: WorkUnit, workerInfo: WorkerInfo): void {
		if (this.worker) this.closeWorker();
		this.worker = {
			id: unit.id,
			esVerificacion: unit.capacidad === "verifier",
		};
		const label = CAP_LABELS[unit.capacidad] ?? unit.capacidad;
		const model = workerInfo.model && workerInfo.model !== "unknown" ? ` · ${workerInfo.model}` : "";
		this.line(`┌─ ${cyan("●")} ${bright(label)} (${cyan(unit.id)}: ${unit.objetivo})${model}`);
	}

	onWorkerToolCall(unitId: string, tool: string, args: Record<string, unknown>): void {
		const target = this.deriveTarget(args);
		this.lastTool = { tool, target };
		this.spin("│  ", `${cyan(tool)}${target ? `  ${target}` : ""}`);
	}

	onWorkerToolResult(unitId: string, tool: string, result: string, isError: boolean): void {
		const cur = this.lastTool && this.lastTool.tool === tool ? this.lastTool : null;
		const mark = isError ? red("✗") : green("✓");
		const target = cur?.target ? `  ${cur.target}` : "";
		this.settle(`│  ${mark}  ${cyan(tool)}${target}`);
	}

	onVerificationStart(unitId: string, command: string): void {
		this.verificationCommand = command;
		this.spin("│  ", cyan(command));
	}

	onVerificationResult(unitId: string, verdict: "PASS" | "FAIL", output: string): void {
		if (!this.worker) return;
		if (this.verificationCommand) {
			const mark = verdict === "PASS" ? green("✓") : red("✗");
			this.settle(`│  ${mark}  ${cyan(this.verificationCommand)}`);
			this.verificationCommand = null;
		} else {
			this.detachSpinner();
		}
		if (verdict === "FAIL") {
			this.failedVerifications.push(output.slice(0, 80));
		}
		this.branch("│  ", `${cyan("└─")} Salida: ${output}`);
		const color = verdict === "PASS" ? green : red;
		this.line(`└─ ${color(`VEREDICTO: ${verdict}`)}`);
		this.closeWorker();
		this.line("");
	}

	onWorkerFinish(unitId: string, result: UnitResult): void {
		if (!this.worker) return;
		this.detachSpinner();
		if (result.passed === false) {
			this.failedUnits.set(unitId, result.text);
		}
		if (this.worker.esVerificacion) {
			this.branch("│  ", `${cyan("└─")} Salida: ${result.text}`);
			const color = result.passed === true ? green : result.passed === false ? red : cyan;
			this.line(result.passed === null ? `└─ Resultado: ${result.text}` : `└─ ${color(`VEREDICTO: ${result.passed ? "PASS" : "FAIL"}`)}`);
		} else {
			this.line(`└─ Resultado: ${result.text}`);
		}
		this.closeWorker();
		if (this.pendingStatusLine) {
			this.line(this.pendingStatusLine);
			this.pendingStatusLine = null;
		}
		this.line("");
	}

	onTaskCompleted(summary: string, telemetry: TaskTelemetry): void {
		this.detachSpinner();
		const costStr = telemetry.totalCost === null ? "cost n/d" : formatCost(telemetry.totalCost);
		const meta = `${this.formatElapsed(telemetry.startTs, telemetry.endTs)} · ${telemetry.iterations} · ${costStr}`;
		this.line("");
		this.line(this.renderBar(`${green("✓ TASK COMPLETED")} ${bright(`(${meta})`)}`));
		this.line("Resumen: " + (summary || "tarea completada"));
	}

	onTaskFailed(reason: string): void {
		this.detachSpinner();
		this.line("");
		// Marca retry-safe si aplica
		const retryMark = this.isRetrySafe ? ` ${green("[retry-safe]")}` : "";
		this.line(this.renderBar(`${red("✗ TASK FAILED")}${retryMark} ${bright(`(${reason})`)}`));
		// Resumen compacto: unidades / verificaciones fallidas
		const failSummary = this.buildFailureSummary();
		if (failSummary) {
			this.line(failSummary);
		}
		// Detalles expandidos (compactos, en una línea por fallo)
		this.line("");
		if (this.failedUnits.size > 0) {
			this.line(`${red("✗")} Unidades fallidas:`);
			for (const [id, text] of this.failedUnits) {
				this.line(`     ${red("•")} ${cyan(id)}: ${text}`);
			}
		}
		if (this.failedVerifications.length > 0) {
			this.line(`${red("✗")} Verificaciones fallidas:`);
			for (const cmd of this.failedVerifications) {
				this.line(`     ${red("•")} ${cmd}`);
			}
		}
	}

	/** Construye línea de resumen compacto de fallos. */
	private buildFailureSummary(): string | null {
		const parts: string[] = [];
		if (this.failedUnits.size > 0) {
			parts.push(`${red(String(this.failedUnits.size))} unidad${this.failedUnits.size > 1 ? "es" : ""} fallida${this.failedUnits.size > 1 ? "s" : ""}`);
		}
		if (this.failedVerifications.length > 0) {
			parts.push(`${red(String(this.failedVerifications.length))} verific${this.failedVerifications.length > 1 ? "aciones" : "ación"} fallida${this.failedVerifications.length > 1 ? "s" : ""}`);
		}
		if (parts.length === 0) return null;
		return `${bright("Fallos:")} ${parts.join(" · ")}`;
	}

	/**
	 * Observaciones del bucle (T0): parse-fail, límites, unidad inexistente, intervención
	 * y comunicación del orquestador. El resto de fases es no-op (P-02: presentación pura).
	 *
	 * Parse-fail: `loop.ts` incrementa `consecutiveParseFailures` *antes* de `safeObserve`,
	 * así que el contador humano es 1/3…3/3 (nunca 0/3 en el primer fallo).
	 */
	onLoopObservation(obs: LoopObservation): void {
		switch (obs.phase) {
			case "decision:resolved": {
				// T3.1 — acumular telemetría del orquestador (incluidos parse-fails).
				if (obs.telemetry?.usage) {
					this.tokenTotal += obs.telemetry.usage.tokens.total;
					this.costTotal += obs.telemetry.usage.cost;
					this.telemKnown = true;
				}
				if (obs.telemetry?.contextUsage?.percent !== null && obs.telemetry?.contextUsage?.percent !== undefined) {
					this.lastContextPct = obs.telemetry.contextUsage.percent;
				}
				if (!obs.parseFail) return;
				this.detachSpinner();
				const n = obs.state.consecutiveParseFailures;
				const err = obs.parseError ? `: ${obs.parseError}` : "";
				this.line(`${amber("▲")} Fallo de parseo del orquestador (${n}/3)${err}`);
				return;
			}
			case "limit:reached": {
				this.detachSpinner();
				const mode = obs.action === "terminar" ? "terminando" : "requiere intervención";
				this.line(`${amber("▲")} límite alcanzado — ${mode}: ${obs.reason}`);
				return;
			}
			case "error:unidad-inexistente": {
				this.detachSpinner();
				const id = obs.decision.unidad ?? "";
				this.line(
					`${amber("▲")} Unidad inexistente: el orquestador referenció "${id}". No se ejecuta ninguna unidad distinta.`,
				);
				return;
			}
			case "intervention:paused": {
				this.detachSpinner();
				this.line(`${amber("▲")} Tarea pausada por el desarrollador — usa /resume para continuarla.`);
				return;
			}
			case "intervention:adjustment": {
				this.detachSpinner();
				this.line(`${violet("⚑")} Intervención del desarrollador incorporada — se tendrá en cuenta en la decisión.`);
				return;
			}
			case "execution:resolved": {
				// T3.1 — acumular telemetría del worker y emitir la línea de estado.
				if (obs.telemetry?.usage) {
					this.tokenTotal += obs.telemetry.usage.tokens.total;
					this.costTotal += obs.telemetry.usage.cost;
					this.telemKnown = true;
				}
				if (obs.telemetry?.contextUsage?.percent !== null && obs.telemetry?.contextUsage?.percent !== undefined) {
					this.lastContextPct = obs.telemetry.contextUsage.percent;
				}
				// Marcar retry-safe según tipo de resultado.
				if (obs.result.kind === "fallo" || obs.result.kind === "parse_error") {
					this.isRetrySafe = true;
				} else if (obs.result.kind === "límite") {
					this.isRetrySafe = false;
				}
				const verifyP = obs.state.results.filter((r) => r.kind === "unidad" && r.passed === true).length;
				const verifyQ = obs.state.results.filter((r) => r.kind === "unidad" && r.passed !== null).length;
				const iterN = obs.state.iterations;
				const iterMax = obs.state.limits.maxIterations;
				const tok = this.telemKnown ? this.formatTokens(this.tokenTotal) : "n/d";
				const cost = this.telemKnown ? formatCost(this.costTotal) : "cost n/d";
				const ctx = this.formatContextPct(this.lastContextPct);
				this.detachSpinner();
				const statusLine = pc.dim(`· iter ${iterN}/${iterMax} · ${tok} tok · ${cost} · ${ctx} · verify ${verifyP}/${verifyQ}`);
				if (this.worker) {
					this.pendingStatusLine = statusLine;
				} else {
					this.line(statusLine);
				}
				if (obs.decision.operación !== "comunicar al desarrollador" || obs.result.kind !== "comunicación") {
					return;
				}
				const texto = obs.result.text || obs.decision.comunicación || "";
				this.line("");
				this.line(`${cyan("💬")} ${bright("Orquestador:")} ${texto}`);
				this.line("");
				return;
			}
			default:
				return;
		}
	}

	onLogEntry(entry: LogEntry): void {
		if (entry.type !== "compaction") return;
		this.detachSpinner();
		if (entry.fase === "start") {
			this.line(`${amber("▲")} compactando contexto`);
		} else {
			this.line(`${amber("▲")} contexto compactado`);
		}
	}

	// ------------------------------------------------------------------ utilidad pública

	/** Finaliza el renderer: detiene cualquier spinner vivo y deja la terminal limpia. */
	finalize(): void {
		this.detachSpinner();
		if (this.pendingStatusLine) {
			this.line(this.pendingStatusLine);
			this.pendingStatusLine = null;
		}
		this.worker = null;
		this.failedUnits.clear();
		this.failedVerifications = [];
		this.isRetrySafe = false;
	}

	/**
	 * Compone un `AiesEventHandlers` ejecutable a partir de un renderer (presentación) y de
	 * decide/execute reales. Los métodos viven en el prototipo, así que se fijan como propiedades
	 * propias de la instancia (sombrean los stubs lanzadores):
	 *   `StreamRenderer.merge(renderer, { decide, execute })`
	 */
	static merge(
		renderer: StreamRenderer,
		impl: Pick<AiesEventHandlers, "decide" | "execute">,
	): AiesEventHandlers {
		renderer.decide = impl.decide;
		renderer.execute = impl.execute;
		return renderer;
	}
}