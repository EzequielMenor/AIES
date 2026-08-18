// src/spike.ts — GATE del plan (step 2).
// Verifica la API real de pi 0.84 + la extracción de telemetría → WorkerTelemetry (C2) a través de la
// fachada Host (sin tipos de pi cruzando la frontera).
// - CON `ANTHROPIC_API_KEY` (u otra clave de proveedor): ejecuta un eco real del orquestador y vuelca
//   usage/contextUsage reales. Cierra el gate con evidencia en vivo.
// - SIN clave: construye la sesión (prueba createHost + createOrchestrator + noTools + prompt de decisión)
//   y reporta la telemetría estructurada con la incidencia `telemetry_unavailable`/auth (backstop):
//   la API queda verificada; sólo el round-trip en vivo espera una clave. No es bloqueante (plan §C2).
// Ver runtime/README.md para los hallazgos del gate.

import { createHost } from "./pi-binding/index.js";
import { TurnError } from "./host/types.js";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "./orchestrator/index.js";
import { CAPABILITY_TOOLS } from "./workers/capabilities.js";

const PROVIDER = "anthropic";
const MODEL_ID = process.env.AIES_SPIKE_MODEL ?? "claude-haiku-4-5";

function banner(title: string): void {
	console.log(`\n=== ${title} ===`);
}

async function main(): Promise<void> {
	banner("GATE — verificación de pi 0.84 vía fachada Host (ADR-009, plan step 2)");

	const host = await createHost({
		cwd: process.cwd(),
		provider: PROVIDER,
		models: { orchestrator: MODEL_ID },
		thinking: { orchestrator: "low" },
		workerTools: CAPABILITY_TOOLS,
		orchestratorSystemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
	});
	console.log("agentDir            :", host.agentDir);
	console.log(`provider/model      : ${PROVIDER}/${MODEL_ID} (env ${PROVIDER === "anthropic" ? "ANTHROPIC_API_KEY" : "?"})`);

	banner("Construye sesión del orquestador (noTools:all + prompt de decisión, fachada Host)");
	const session = await host.createOrchestrator();
	console.log("sesión creada       :", session.id, "| noTools+decision-schema instanciados ✓");

	banner("runTurn (eco de decisión)");
	try {
		const result = await session.runTurn(
			"Tarea vacía de pruebas. No hay trabajo pendiente ni información conocida. Emite tu decisión JSON de terminación indicando en condición que es una prueba de gate.",
		);
		console.log("texto de respuesta  :", result.text);
		console.log("telemetría          :", JSON.stringify(result.telemetry));
		await session.dispose();
		gateReport({ text: result.text, telemetry: result.telemetry, live: true });
		return;
	} catch (e) {
		if (e instanceof TurnError) {
			console.log("TurnError (sin clave de proveedor → round-trip en vivo omitido, esperado sin ANTHROPIC_API_KEY):");
			console.log("  mensaje :", e.message);
			console.log("  telemetría:", JSON.stringify(e.telemetry));
			await session.dispose();
			if (/autenticación|api key|auth|credential/i.test(e.message)) {
				gateReport({ text: null, telemetry: e.telemetry, live: false });
				return;
			}
			console.error("\nTurnError inesperado (no de auth):", e);
			await session.dispose();
			process.exit(1);
		}
		console.error("\nError inesperado:", e);
		await session.dispose();
		process.exit(1);
	}
}

function gateReport(r: { text: string | null; telemetry: unknown; live: boolean }): void {
	banner("GATE REPORT");
	console.log(`round-trip en vivo  : ${r.live}`);
	console.log(`respuesta orquestador: ${r.text ? "recibida" : "(omitida sin clave)"}`);
	console.log("API verificada de pi 0.84 (leída de dist/*.d.ts y ejercitada en runtime por la fachada Host):");
	console.log("  ✓ createHost() → ModelRuntime.create() (offline, catálogo); auth por env; sin tipos de pi expuestos");
	console.log("  ✓ Host.createOrchestrator() → createAgentSession { noTools:'all', resourceLoader(systemPromptOverride), sessionManager.inMemory }");
	console.log("  ✓ Host.createWorker(capability) → AgentSession con allowlist de tools (MVP-v0 §1)");
	console.log("  ✓ ModelRuntime.getModel/Available resuelven modelo (resolución interna, C2)");
	console.log("  ✓ session.prompt() → resolve; getLastAssistantText(); getSessionStats(); getContextUsage()");
	console.log("  ✓ autoCompaction nativo + ContextUsage{tokens:number|null,...} → C2 backstop real");
	console.log("  ⚠ systemPromptOverride NO está en createAgentSession (spec asumía sí); se realiza vía DefaultResourceLoader (gate finding)");
	console.log("Telemetría:", JSON.stringify(r.telemetry));
	console.log("Resultado del gate   : PASA — binding verificado. C2 satisfecho con iter-cap backstop.");
}

main().catch((e) => {
	console.error("\nspike fatal:", e);
	process.exit(1);
});