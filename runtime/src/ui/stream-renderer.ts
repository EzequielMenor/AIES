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
import type { Decision, RuntimeState, WorkUnit } from "../core/state.js";

// ── Paleta ANSI truecolor (hex exactos de las reglas de UX) ─────────────────
function truecolor(hex: string, s: string): string {
	const h = hex.replace(/^#/, "");
	const r = parseInt(h.slice(0, 2), 16);
	const g = parseInt(h.slice(2, 4), 16);
	const b = parseInt(h.slice(4, 6), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}
const cyan = (s: string) => truecolor("#38bdf8", s);
const green = (s: string) => truecolor("#3fb950", s);
const red = (s: string) => truecolor("#f85149", s);
const amber = (s: string) => truecolor("#d29922", s);
const bright = pc.bold; // énfasis (picocolors)

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
	private readonly tty: boolean;
	private spinner: ActiveSpinner | null = null;
	private worker: OpenWorker | null = null;
	/** Re-cuento de re-descomposiciones (para compactar avisos ámbar). */
	private recomposes = 0;
	/** Último comando de verificación activo (para pintar su `✓` al cerrar). */
	private verificationCommand: string | null = null;
	/** Último tool invocado (para conservar el target en el `✓` de cierre). */
	private lastTool: { tool: string; target: string | null } | null = null;

	constructor(stream: NodeJS.WriteStream = process.stdout) {
		this.tty = Boolean(stream.isTTY);
	}

	// ------------------------------------------------------------------ utilidades

	private termWidth(): number {
		return this.tty && process.stdout.columns ? Math.max(20, process.stdout.columns) : 80;
	}

	private raw(s: string): void {
		process.stdout.write(s);
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
		// null = telemetría no disponible en ninguna vuelta → representar explícitamente, NO inventar $0.
		if (cost === null) return "cost n/d";
		return cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
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
				return `Ejecutar ${d.capacidad ?? "unidad"}${d.unidad ? ` (${d.unidad})` : ""}${plan}`;
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

	onDecideSuccess(decision: Decision): void {
		const esRedescomposicion =
			decision.ajustePlan?.tipo === "re-descomponer" || decision.ajustePlan?.tipo === "cambiar de estrategia";
		if (esRedescomposicion) {
			this.recomposes += 1;
			this.line(`${amber("▲")} ${amber(`Re-descomponiendo (re-descomposición #${this.recomposes})`)}: ${decision.motivo}`);
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
		this.branch("│  ", `${cyan("└─")} Salida: ${output}`);
		const color = verdict === "PASS" ? green : red;
		this.line(`└─ ${color(`VEREDICTO: ${verdict}`)}`);
		this.closeWorker();
		this.line("");
	}

	onWorkerFinish(unitId: string, result: UnitResult): void {
		if (!this.worker) return;
		this.detachSpinner();
		if (this.worker.esVerificacion) {
			this.branch("│  ", `${cyan("└─")} Salida: ${result.text}`);
			const color = result.passed === true ? green : result.passed === false ? red : cyan;
			this.line(result.passed === null ? `└─ Resultado: ${result.text}` : `└─ ${color(`VEREDICTO: ${result.passed ? "PASS" : "FAIL"}`)}`);
		} else {
			this.line(`└─ Resultado: ${result.text}`);
		}
		this.closeWorker();
		this.line("");
	}

	onTaskCompleted(summary: string, telemetry: TaskTelemetry): void {
		this.detachSpinner();
		const meta = `${this.formatElapsed(telemetry.startTs, telemetry.endTs)} · ${telemetry.iterations} · ${this.formatCost(telemetry.totalCost)}`;
		this.line("");
		this.line(this.renderBar(`${green("✓ TASK COMPLETED")} ${bright(`(${meta})`)}`));
		this.line("Resumen: " + (summary || "tarea completada"));
	}

	onTaskFailed(reason: string): void {
		this.detachSpinner();
		this.line("");
		this.line(this.renderBar(`${red("✗ TASK FAILED")} ${bright(`(${reason})`)}`));
	}

	// ------------------------------------------------------------------ utilidad pública

	/** Finaliza el renderer: detiene cualquier spinner vivo y deja la terminal limpia. */
	finalize(): void {
		this.detachSpinner();
		this.worker = null;
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