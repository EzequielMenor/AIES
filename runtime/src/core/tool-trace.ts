// src/core/tool-trace.ts — trazabilidad de tools de los workers (v0.5 Caja de cristal).
//
// Registro y proyección de la actividad de tools de cada worker: tool invocada, argumentos
// relevantes, resultado resumido, error si existe y archivos/comandos afectados. El detalle
// completo queda en `log.jsonl` (entrada `type: "tool"`); la vista principal sólo muestra el
// resumen (Restricción: no saturar el stream con eventos internos).
//
// Módulo puro: no importa UI ni pi. Se prueba sin inicializar sesiones.

const WRITE_TOOLS = new Set(["write", "edit", "str_replace", "multiedit", "multi_edit"]);
const READ_TOOLS = new Set(["read", "ls", "grep", "find", "glob", "code_explore"]);

/** Args textuales pesados: se resumen (líneas/caracteres), nunca se vuelcan al registro. */
const BULK_KEYS = new Set(["content", "new_text", "newText", "old_text", "oldText", "replacement", "replacements", "text"]);

/** Truncado genérico con elipsis para valores de arg y resúmenes. */
export function truncate(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Cuenta líneas de un texto ("" → 0 líneas). */
function lineCount(s: string): number {
	if (!s) return 0;
	return s.split("\n").length;
}

/** Proyecta los argumentos de un tool a su forma RELEVANTE para inspección humana:
 *  escalares y paths/cmd completos; los payloads textuales voluminosos se resumen como
 *  `"<N líneas>"`; funciones/objetos anidados complejos se descartan. */
export function relevantArgs(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args)) {
		if (typeof v === "string") {
			out[k] = BULK_KEYS.has(k) ? `<${lineCount(v)} líneas>` : truncate(v, 200);
		} else if (typeof v === "number" || typeof v === "boolean" || v === null) {
			out[k] = v;
		} else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
			out[k] = (v as string[]).slice(0, 10).map((x) => truncate(x, 120));
		}
		// objetos anidados / funciones: fuera del registro (pertenecen al detalle del host).
	}
	return out;
}

/** Target observable del tool (path / comando / patrón), o null si no declarable. */
export function toolTarget(args: Record<string, unknown>): string | null {
	const candidates = [args.path, args.file_path, args.filePath, args.cmd, args.command, args.pattern, args.query];
	for (const c of candidates) {
		if (typeof c === "string" && c.length > 0) return truncate(c, 200);
	}
	return null;
}

/** Archivos afectados por la invocación (relación tool ↔ artifact, criterio de verificación).
 *  write/edit declaran `path`; read y compañía declaran el archivo leído (archivo ALCANZADO, no
 *  modificado — el registro distingue con `modificado`). */
export function affectedFiles(tool: string, args: Record<string, unknown>): { leidos: string[]; modificados: string[] } {
	const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : null;
	if (!path) return { leidos: [], modificados: [] };
	if (WRITE_TOOLS.has(tool)) return { leidos: [], modificados: [path] };
	if (READ_TOOLS.has(tool)) return { leidos: [path], modificados: [] };
	return { leidos: [], modificados: [] };
}

/** Resume el resultado de un tool a UNA línea legible (vista principal y registro).
 *  Errores: el mensaje exacto truncado. Éxito: métrica del payload (líneas, coincidencias,
 *  salida del comando), nunca el contenido crudo completo. */
export function summarizeToolResult(tool: string, result: string, isError: boolean): string {
	const flat = result.replace(/\r\n/g, "\n").trim();
	if (isError) return truncate(flat || `${tool}: error`, 160);
	if (!flat) return "(vacío)";
	switch (tool) {
		case "read":
			return `${lineCount(flat)} líneas`;
		case "grep":
		case "find":
		case "glob":
		case "code_explore": {
			const n = flat.split("\n").filter((l) => l.trim()).length;
			return `${n} coincidencias`;
		}
		case "ls":
			return `${flat.split("\n").filter((l) => l.trim()).length} entradas`;
		case "edit":
		case "write":
			return "aplicado";
		case "bash": {
			// stdout/stderr del comando: primera línea con contenido + nº de líneas.
			const n = flat.split("\n").filter((l) => l.trim()).length;
			const first = flat.split("\n").find((l) => l.trim()) ?? "";
			return `${truncate(first, 120)}${n > 1 ? ` (${n} líneas)` : ""}`;
		}
		case "mem_log":
		case "mem_read":
			return `${lineCount(flat)} líneas`;
		default:
			return truncate(flat, 120);
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Recorder: empareja call↔result por unidad y produce registros completos
// ──────────────────────────────────────────────────────────────────────────────

/** Registro de UNA tool-execution completada (call + result emparejados). */
export interface ToolTraceRecord {
	unidadId: string;
	capacidad: string | null;
	iter: number;
	herramienta: string;
	args: Record<string, unknown>;
	target: string | null;
	leidos: string[];
	modificados: string[];
	resumen: string;
	/** Resultado crudo acotado (evidencia para inspección profunda; la vista principal no lo pinta). */
	detalle: string;
	error: boolean;
	ts: string;
}

/** Máximo de caracteres del resultado crudo conservado como evidencia en el registro. */
export const DETALLE_MAX = 2000;

/** Recorta el resultado crudo conservando cabecera y cola (lo más informativo de volúmenes largos). */
export function capDetalle(s: string, max = DETALLE_MAX): string {
	const t = s.replace(/\r\n/g, "\n");
	if (t.length <= max) return t;
	const half = Math.floor((max - 12) / 2);
	return `${t.slice(0, half)}\n… [${t.length - 2 * half} chars]\n${t.slice(-half)}`;
}

interface PendingCall {
	tool: string;
	args: Record<string, unknown>;
	target: string | null;
	ts: number;
}

export interface ToolTraceRecorder {
	/** Capacidad del worker que arranca una unidad (para atribuir la traza). */
	noteUnit(unitId: string, capacidad: string): void;
	/** Iteración corriente del bucle (para correlacionar con decision/resultado en el log). */
	noteIteration(iter: number): void;
	onToolCall(unitId: string, tool: string, args: Record<string, unknown>): void;
	onToolResult(unitId: string, tool: string, result: string, isError: boolean): void;
}

/** Crea un recorder que empareja cada `onToolCall` con su `onToolResult` (FIFO por unidad+tool,
 *  como los eventos del host) y pasa el registro completo a `emit`. Nunca lanza: un fallo de
 *  instrumentación no debe romper la ejecución del worker (P-02, bus fire-and-forget). */
export function createToolTraceRecorder(emit: (r: ToolTraceRecord) => void): ToolTraceRecorder {
	const capacities = new Map<string, string>();
	let iter = 0;
	const pending = new Map<string, PendingCall[]>();
	const key = (unitId: string, tool: string) => `${unitId}\u0000${tool}`;
	return {
		noteUnit(unitId, capacidad) {
			capacities.set(unitId, capacidad);
		},
		noteIteration(n) {
			iter = n;
		},
		onToolCall(unitId, tool, args) {
			try {
				const k = key(unitId, tool);
				const queue = pending.get(k) ?? [];
				queue.push({ tool, args, target: toolTarget(args), ts: Date.now() });
				pending.set(k, queue);
			} catch {
				/* instrumentación best-effort */
			}
		},
		onToolResult(unitId, tool, result, isError) {
			try {
				const k = key(unitId, tool);
				const queue = pending.get(k);
				const call = queue && queue.length > 0 ? queue.shift() : undefined;
				if (queue && queue.length === 0) pending.delete(k);
				const args = call?.args ?? {};
				const { leidos, modificados } = affectedFiles(tool, args);
				emit({
					unidadId: unitId,
					capacidad: capacities.get(unitId) ?? null,
					iter,
					herramienta: tool,
					args: relevantArgs(args),
					target: call?.target ?? null,
					leidos,
					modificados,
					resumen: summarizeToolResult(tool, result, isError),
					detalle: capDetalle(result),
					error: isError,
					ts: new Date().toISOString(),
				});
			} catch {
				/* instrumentación best-effort */
			}
		},
	};
}
