// src/workers/session-factory.ts — fábrica de AgentSession efímeras para workers (ADR-009, Fase 1).
//
// Workers de AIES = sesiones efímeras de pi. Cada unidad (explore/implement/verify) crea una
// sesión, lanza un prompt, y dispone la sesión al terminar. Sin estado entre unidades.
//
// La fábrica comparte patrón con el antiguo pi-binding: SessionManager.inMemory(cwd) + tool
// allowlist + systemPromptOverride. Ahora vive dentro de la extensión (no como fachada Host),
// pero la forma del contrato es la misma.
//
// Diferencia frente al orquestador (decide.ts): aquí SÍ se conceden tools — filtradas por
// capability (capabilities.ts). El orquestador usa `noTools: "all"` y vive en su propia sesión
// sin tools de modificación (P-01).

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type AgentSession,
	type AgentSessionEvent,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CAPABILITY_PROMPT } from "./prompts.js";
import type { WorkerEventSink } from "../core/events.js";
import type { Capability } from "../core/state.js";
import { CAPABILITY_TOOLS } from "./capabilities.js";
import type { WorkerTelemetry } from "../telemetry/types.js";

export type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface WorkerSessionDeps {
	cwd: string;
	model: ResolvedModel | undefined;
	capability: Capability;
	thinkingLevel?: "off" | "low" | "medium" | "high" | undefined;
}

export interface WorkerSession {
	session: AgentSession;
	capability: Capability;
	/** Desuscriptor del listener de eventos — se llama en `disposeWorkerSession`. */
	unsubscribe: () => void;
}

/** Resultado de error de un worker cuando el modelo o las tools fallan limpiamente (ADR-006).
 *  El bucle AIES lo mapea a `OperationResult { kind: "fallo" }` para que pueda re-descomponer
 *  o re-delegar la unidad. NO es lo mismo que `UnitResult` (el payload del bus `events.ts`):
 *  este es el shape de retorno interno del runner. */
export interface WorkerRunError {
	status: "failed";
	error: string;
	/** Telemetría (tokens/coste) de la sesión del worker, leída tras el turno (RNF-07/17). */
	telemetry: WorkerTelemetry;
}

/** Resultado de éxito de un worker. */
export interface WorkerRunOk {
	status: "ok";
	text: string;
	/** Sólo presente para verifier: PASS/FAIL. null = explorer/implementer. */
	verdict: "PASS" | "FAIL" | null;
	/** Telemetría (tokens/coste) de la sesión del worker, leída tras el turno (RNF-07/17). */
	telemetry: WorkerTelemetry;
}

export type WorkerRunOutcome = WorkerRunOk | WorkerRunError;

/** Serializa `result` de un `tool_execution_end` a string. La forma de `result` depende del tool
 *  (read devuelve texto, bash devuelve stdout/stderr, etc.); lo mejor que podemos hacer en el
 *  bus es una proyección razonable. */
function projectToolResult(result: unknown): string {
	if (result === null || result === undefined) return "";
	if (typeof result === "string") return result;
	try {
		const json = JSON.stringify(result);
		return typeof json === "string" ? json : String(result);
	} catch {
		return String(result);
	}
}

/** Normaliza `args` (cualquier) a un objeto plano para el bus. Si no es objeto, devuelve {}.
 *  Esto evita que un tool mal-formado rompa el contrato del bus (P-02: tipos estrictos). */
function normalizeArgs(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		out[k] = v;
	}
	return out;
}

/** Crea una AgentSession efímera con las tools de la capability y, si se le pasa un sink, conecta
 *  un listener que emite `onWorkerToolCall` / `onWorkerToolResult` al bus de AIES.
 *
 *  El listener se desuscribe automáticamente en `disposeWorkerSession` (vía el `unsubscribe`
 *  que la fábrica devuelve en `WorkerSession`). */
export async function createWorkerSession(deps: WorkerSessionDeps, sink?: WorkerEventSink): Promise<WorkerSession> {
	const loader = new DefaultResourceLoader({
		cwd: deps.cwd,
		agentDir: getAgentDir(),
		systemPromptOverride: () => CAPABILITY_PROMPT[deps.capability],
		appendSystemPromptOverride: () => [],
		noExtensions: true,
	});
	await loader.reload();
	const opts: Parameters<typeof createAgentSession>[0] = {
		cwd: deps.cwd,
		sessionManager: SessionManager.inMemory(deps.cwd),
		resourceLoader: loader,
		tools: CAPABILITY_TOOLS[deps.capability],
	};
	if (deps.model) opts.model = deps.model;
	if (deps.thinkingLevel) opts.thinkingLevel = deps.thinkingLevel;
	const { session } = await createAgentSession(opts);

	// Listener de actividad — sólo se conecta si el sink implementa los callbacks (P-02: el bus
	// es opcional; los consumers pueden implementar sólo los eventos que necesitan).
	let unsubscribe: () => void = () => undefined;
	const wantsToolCall = typeof sink?.onWorkerToolCall === "function";
	const wantsToolResult = typeof sink?.onWorkerToolResult === "function";
	if (sink && (wantsToolCall || wantsToolResult)) {
		unsubscribe = session.subscribe((e: AgentSessionEvent) => {
			if (!e || typeof e !== "object") return;
			if (e.type === "tool_execution_start" && wantsToolCall) {
				const args = normalizeArgs((e as { args?: unknown }).args);
				try {
					sink.onWorkerToolCall?.((e as { toolName: string }).toolName, args);
				} catch {
					/* el consumer no debe romper al worker (P-02: bus fire-and-forget) */
				}
			} else if (e.type === "tool_execution_end" && wantsToolResult) {
				const ev = e as { toolName: string; result: unknown; isError: boolean };
				const text = projectToolResult(ev.result);
				try {
					sink.onWorkerToolResult?.(ev.toolName, text, ev.isError);
				} catch {
					/* consumer-side error: el worker sigue */
				}
			}
		});
	}

	return { session, capability: deps.capability, unsubscribe };
}

/** Dispone una sesión de forma segura (idempotente). Desuscribe el listener y libera la sesión. */
export function disposeWorkerSession(s: WorkerSession | AgentSession | undefined): void {
	if (!s) return;
	const ws = "session" in s ? (s as WorkerSession) : undefined;
	const session: AgentSession | undefined = ws ? ws.session : (s as AgentSession);
	if (ws) {
		try {
			ws.unsubscribe();
		} catch {
			/* unsubscribe best-effort */
		}
	}
	if (!session) return;
	try {
		session.dispose();
	} catch {
		/* dispose best-effort */
	}
}
