// src/pi-binding/index.ts — ÚNICO módulo que importa `@earendil-works/pi-coding-agent` (ADR-009, plan C2).
// Expone sólo la fachada `Host` y `HostSession` (host/types): NINGÚN tipo de pi cruza la frontera
// (Resolución de modelo interna). El dominio/orquestador/workers/CLI hablan `Host`, no pi.
// Cambiar de host → refactor aquí solo. ponytail: extraer HostFactory si aparece un 2.º host.

import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	type PromptOptions,
	SessionManager,
	type SessionStats,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { ContextUsage as PiContextUsage } from "@earendil-works/pi-coding-agent";
import { computeTelemetry, mapCompaction } from "./events.js";
import { TurnError, type HostSession, type ThinkingLevel, type TurnResult } from "../host/types.js";
import type { Capability } from "../core/state.js";
import type { CompactionObservation } from "../telemetry/types.js";

/** Modelo resuelto del catálogo pi (Model<Api>), nunca exportado (permanece dentro del binding). */
type ResolvedModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

function resolveAgentDir(): string {
	return getAgentDir();
}

async function createModelRuntime(): Promise<ModelRuntime> {
	return ModelRuntime.create();
}

function resolveModel(rt: ModelRuntime, providerId: string, modelId: string): ResolvedModel | undefined {
	const m = rt.getModel(providerId, modelId);
	if (m) return m;
	const models = rt.getModels(providerId);
	return models[0];
}

interface BaseSessionOpts {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	model?: ResolvedModel | undefined;
	thinkingLevel?: ThinkingLevel | undefined;
	id: string;
}

function piOptions(
	base: BaseSessionOpts,
	rest: Partial<Parameters<typeof createAgentSession>[0]>,
): Parameters<typeof createAgentSession>[0] {
	const opts: Parameters<typeof createAgentSession>[0] = {
		cwd: base.cwd,
		modelRuntime: base.modelRuntime,
		sessionManager: SessionManager.inMemory(base.cwd),
		...rest,
	};
	if (base.model) opts.model = base.model;
	if (base.thinkingLevel) opts.thinkingLevel = base.thinkingLevel;
	return opts;
}

async function createOrchestratorSession(opts: BaseSessionOpts & { systemPrompt: string; onCompaction?: ObservabilityCallback | undefined }): Promise<HostSession> {
	const loader = new DefaultResourceLoader({
		cwd: opts.cwd,
		agentDir: opts.agentDir,
		noExtensions: true,
		systemPromptOverride: () => opts.systemPrompt,
		appendSystemPromptOverride: () => [],
	});
	await loader.reload();
	const { session } = await createAgentSession(piOptions(opts, { noTools: "all", resourceLoader: loader }));
	return new PiHostSession(session, opts.id, opts.onCompaction);
}

export async function createWorkerSession(opts: BaseSessionOpts & { tools: string[]; onCompaction?: ObservabilityCallback | undefined }): Promise<HostSession> {
	const loader = new DefaultResourceLoader({ cwd: opts.cwd, agentDir: opts.agentDir });
	await loader.reload();
	const { session } = await createAgentSession(piOptions(opts, { tools: opts.tools, resourceLoader: loader }));
	return new PiHostSession(session, opts.id, opts.onCompaction);
}

/** Sesión de investigación (baseline agente-único, 06-research/E-01): misma fábrica que un worker,
 *  un solo AgentSession con el set de tools completo y el modelo indicado, sin orquestador ni división. */
export async function createBaselineSession(config: {
	cwd: string;
	provider: string;
	model: string;
	tools: string[];
	thinkingLevel?: ThinkingLevel;
	id?: string;
}): Promise<HostSession> {
	const agentDir = resolveAgentDir();
	const rt = await createModelRuntime();
	const model = resolveModel(rt, config.provider, config.model);
	return createWorkerSession({
		cwd: config.cwd,
		agentDir,
		modelRuntime: rt,
		model,
		thinkingLevel: config.thinkingLevel,
		tools: config.tools,
		id: config.id ?? "baseline",
	});
}

type ObservabilityCallback = (o: CompactionObservation) => void;

class PiHostSession implements HostSession {
	readonly id: string;
	private readonly session: AgentSession;
	private readonly onCompaction: ObservabilityCallback | undefined;
	private readonly unsubscribe: (() => void) | undefined;

	constructor(session: AgentSession, id: string, onCompaction?: ObservabilityCallback) {
		this.session = session;
		this.id = id;
		this.onCompaction = onCompaction;
		// El techo de contexto es un límite más (RNF-18/19): se suscribe al bus del host y
		// reenvía compaction_start/end al dominio (log.jsonl). Unsubscribe en dispose.
		if (onCompaction) {
			this.unsubscribe = session.subscribe((e) => {
				if (e.type === "compaction_start" || e.type === "compaction_end") onCompaction(mapCompaction(e));
			});
		}
	}

	private snapshotStats(): SessionStats | null {
		try {
			return this.session.getSessionStats();
		} catch {
			return null;
		}
	}

	async runTurn(promptText: string, opts?: { signal?: AbortSignal }): Promise<TurnResult> {
		const signal = opts?.signal;
		if (signal) {
			if (signal.aborted) await this.session.abort();
			else signal.addEventListener("abort", () => void this.session.abort(), { once: true });
		}

		const before = this.snapshotStats();
		const promptOpts: PromptOptions = {};
		let promptError: unknown;
		try {
			await this.session.prompt(promptText, promptOpts);
		} catch (e) {
			promptError = e;
		}

		const after = this.snapshotStats();
		let ctx: PiContextUsage | undefined;
		try {
			ctx = this.session.getContextUsage() ?? undefined;
		} catch {
			ctx = undefined;
		}
		const telemetry = computeTelemetry(before, after, ctx);

		if (promptError) {
			throw new TurnError(this.describeError(promptError), telemetry);
		}
		const text = this.session.getLastAssistantText() ?? "";
		return { text, telemetry };
	}

	async abort(): Promise<void> {
		try {
			await this.session.abort();
		} catch {
			/* abort best-effort */
		}
	}

	dispose(): void {
		try {
			this.unsubscribe?.();
		} catch {
			/* unsubscribe best-effort */
		}
		try {
			this.session.dispose();
		} catch {
			/* dispose best-effort */
		}
	}

	private describeError(e: unknown): string {
		const msg = e instanceof Error ? e.message : String(e);
		if (/api key|auth|credential|unauthor/i.test(msg)) {
			return `autenticación de proveedor ausente (¿clave en env? p. ej. ANTHROPIC_API_KEY): ${msg}`;
		}
		return msg;
	}
}

// --- Fachada Host (frontera C2: sólo HostSession sale; resolución de modelo interna) ---

export interface HostConfig {
	cwd: string;
	provider: string;
	/** id de modelo por rol (string del catálogo; sin claves). */
	models: Partial<Record<Capability | "orchestrator", string>>;
	/** thinkingLevel por rol (orquestador por defecto "low", ADR-007). */
	thinking?: Partial<Record<Capability | "orchestrator", ThinkingLevel>>;
	/** allowlist de tools por capacidad (MVP-v0-Scope §1). */
	workerTools: Record<Capability, string[]>;
	/** system prompt del orquestador (decisión estructurada, Decision-Model §2/§4). */
	orchestratorSystemPrompt: string;
}

export interface Host {
	readonly agentDir: string;
	/** Sesión del orquestador (noTools:"all"); el llamador la reutiliza entre iteraciones. */
	createOrchestrator(onCompaction?: ObservabilityCallback): Promise<HostSession>;
	/** Sesión de worker efímera por capacidad (SessionManager.inMemory, ADR-009 §4). */
	createWorker(capability: Capability, onCompaction?: ObservabilityCallback): Promise<HostSession>;
	/** E-01A experimental: idéntica a createWorker (misma persona/tools/modelo/prompt), pero
	 * las métricas atribuyen su telemetría al orquestador. Sesión nueva por llamada, dispose()
	 * en finally. Activada por env AIES_NO_WORKERS=1 en cli.ts; sin uso en modo normal. */
	createLocalSession(capability: Capability, onCompaction?: ObservabilityCallback): Promise<HostSession>;
}

export async function createHost(config: HostConfig): Promise<Host> {
	const agentDir = resolveAgentDir();
	const rt = await createModelRuntime();
	const resolveRole = (role: Capability | "orchestrator"): ResolvedModel | undefined => {
		const id = config.models[role];
		return id ? resolveModel(rt, config.provider, id) : undefined;
	};
	return {
		agentDir,
		createOrchestrator: (onCompaction?: ObservabilityCallback) =>
			createOrchestratorSession({
				cwd: config.cwd,
				agentDir,
				modelRuntime: rt,
				model: resolveRole("orchestrator"),
				thinkingLevel: config.thinking?.orchestrator ?? "low",
				systemPrompt: config.orchestratorSystemPrompt,
				id: "orchestrator",
				onCompaction,
			}),
		createWorker: (capability: Capability, onCompaction?: ObservabilityCallback) =>
			createWorkerSession({
				cwd: config.cwd,
				agentDir,
				modelRuntime: rt,
				model: resolveRole(capability),
				thinkingLevel: config.thinking?.[capability],
				tools: config.workerTools[capability],
				id: capability,
				onCompaction,
			}),
		createLocalSession: (capability: Capability, onCompaction?: ObservabilityCallback) =>
			createWorkerSession({
				cwd: config.cwd,
				agentDir,
				modelRuntime: rt,
				model: resolveRole(capability),
				thinkingLevel: config.thinking?.[capability],
				tools: config.workerTools[capability],
				id: `local-${capability}`,
				onCompaction,
			}),
	};
}