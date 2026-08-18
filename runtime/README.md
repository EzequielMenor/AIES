# AIES-core runtime (v0)

Paquete TypeScript/Node que realiza el runtime v0 de `MVP-v0-Scope` sobre **pi** (`@earendil-works/pi-coding-agent@~0.84`).
**AIES-core es el dueño del bucle** (`estado → decisión → operación → resultado`); pi es el motor de workers y el `ModelRuntime` multi-provider (ADR-009). No hay `HostAdapter` en v0 (P-17).

La spec está cerrada: este paquete la hace valer en código. Trazabilidad: `MVP-v0-Scope` + `ADR-005/006/007/008/009` + `Runtime-Model` + `Decision-Model` + `Lifecycle` + `NFR`.

---

## Estado de la implementación (pasos del plan)

- [x] **1 — Init paquete**: `package.json`/`tsconfig`/bin; `aies --help`; `tsc` limpio.
- [x] **2 — Spike pi-binding (GATE)**: verificado contra pi 0.84.2 real (ver §Gate). `npm run spike`.
- [x] **3 — Domain core sin pi**: `RuntimeState`, shapes de `log.jsonl`, esqueleto del loop (interfaces). Self-check: `npm run test:loop` (3 caminos sin pi).
- [x] **4 — Persistence**: `file_store` (state.json+log.jsonl keyed-by-cwd) + `recover` (corrupt→limpio, log conservado). Self-check: `npm run test:persist`.
- [x] **5 — Orquestador**: `noTools:"all"` + prompt decision-schema + parser Zod robusto + reentry + tope 3→intervención (C3). Self-check: `npm run test:orch`.
- [x] **6 — Workers**: explorer/implementer/verifier con allowlists exactas; verifier **sin** edit/write. `ExecuteFn` vía fachada `Host`.
- [x] **7 — Límites + intervención**: iter 12, coste off, contexto observado con backstop; SIGINT (`intervention.ts`); config loading (`config.ts`).
- [x] **8 — Conocimiento al arranque**: `DefaultResourceLoader` (AGENTS.md) por sesión (wired en `pi-binding`); fixture `fixtures/smoke-repo/`.
- [x] **9 — CLI + smoke**: `aies run "<tarea>"` / `aies resume` cableados. Sin clave degrada con gracia (3 auth-fails→intervención, no crash). Resanuda tarea En curso y corrupto→limpio verificados. **La traza §9 en vivo requiere `ANTHROPIC_API_KEY`** (la reproducción determinista usa modelo real; el harness ya está verificado).
- [x] **10 — Handoff `06-research`**: `npm run research:metrics -- <log.jsonl>` emite métricas por dimensión NFR §3, mapeadas a H-01…H-06 **sin aseverarlas** (P-19).
- [x] **11 — Compactación observable (RNF-18/19)**: `compaction_start/end` de pi registrados en `log.jsonl` (`type:"compaction"`, con razón, `tokensBefore`/`estimatedTokensAfter`, `willRetry`); el techo de contexto deja huella sin reimplementarlo. Self-check: `npm run test:compaction`.

Verificación: `npm run typecheck` (tsc strict) + `npm test` (loop/persistencia/orquestador/compaction sin pi) + `npm run spike` (pi real, sin clave = degradación).

---

## Gate (step 2) — hallazgos verificados de pi 0.84.2

Leído de `dist/*.d.ts` y **ejercitado en runtime** (`npm run spike`). Sin `ANTHROPIC_API_KEY`, el spike construye la sesión y reporta telemetría estructurada; con clave, ejecuta un eco real con usage/contextUsage en vivo.

**API confirmada (igual a la spec salvo una corrección):**

| Superficie spec | Real en pi 0.84.2 | Nota |
|---|---|---|
| `createAgentSession({cwd, sessionManager, model, thinkingLevel, tools, noTools, resourceLoader, modelRuntime})` | ✓ `dist/core/sdk.d.ts` | opciones exactas; devuelve `{session, extensionsResult, modelFallbackMessage?}` |
| `noTools: "all"` (orquestador, P-01 por ausencia) | ✓ `noTools: "all" \| "builtin"` | deshabilita **todas** las tools incl. extensiones |
| `tools: string[]` (allowlist por capacidad, MVP-v0 §1) | ✓ | nombres built-in: `read bash edit write grep find ls` — coinciden con las allowlists |
| `SessionManager.inMemory(cwd)` / `.create(cwd)` | ✓ `inMemory(cwd?)` / `create(cwd, sessionDir?)` | workers efímeros; replay fino opcional |
| `ModelRuntime.create()` (multi-provider, auth por env) | ✓ `ModelRuntime.create(options?)` | `ANTHROPIC_API_KEY`→provider `anthropic`; `OPENAI_API_KEY`→`openai`; etc. |
| `session.prompt(text)` → resolve al fin de vuelta | ✓ `prompt(text, PromptOptions?): Promise<void>` | devuelve void; resultado vía eventos/`getLastAssistantText` |
| `session.subscribe(cb)` / `session.abort()` | ✓ | cancelación = un resultado más (Runtime §5) |
| `setModel(model)` (swap por worker) | ✓ | lanza si no hay auth (esperado) |
| `usage`/`contextUsage` por vuelta (C2/RNF-07/18) | ✓ `getSessionStats()` (tokens+cost, acumulado) + `getContextUsage()` | ver C2 abajo |
| `autoCompaction` nativo | ✓ `autoCompactionEnabled` + eventos `compaction_start/end` | AIES observa, no reimplementa el techo |
| `DefaultResourceLoader` (carga AGENTS.md, ADR-008 §6) | ✓ `getAgentsFiles()` + `loadProjectContextFiles` | conocimiento durable del repo al arranque |
| `thinkingLevel: "low"` orquestador (ADR-007) | ✓ `off\|low\|medium\|high` (clamped por modelo) | provisional, recalibrable en `06-research` |
| `systemPromptOverride` en `createAgentSession` | ⚠ **NO existe esa opción en createAgentSession** | **corrección de la spec**: se realiza vía `DefaultResourceLoader({ systemPromptOverride: (base)=>…, appendSystemPromptOverride: ()=>[] })`. Es lo que usa `pi-binding/createOrchestratorSession`. |

**C2 — telemetría fiable y desacoplada (verificado):**

- `ContextUsage = { tokens: number \| null, contextWindow: number, percent: number \| null }`. **`tokens:null` es un estado REAL y normal** (post-`autoCompaction`, pre-respuesta), no un bug. AIES lo mapea a `telemetry_unavailable` + warning y **sigue con el backstop de iteraciones (12)** — nunca continuación silenciosa (RNF-19). AIES **nunca** asume no-overflow.
- `getSessionStats()` es **acumulativo** (session-wide). El binding calcula `usage` por vuelta como **delta** (after−before). `cost` idem. Usuario clave: una vuelta **completada sin telemetría** → `usage:null` + warning; la decisión procede sobre el texto, no sobre la telemetría.
- La interfaz de dominio es `WorkerTelemetry` (`src/telemetry/types.ts`); `pi-binding` es el **único** módulo que importa `@earendil-works/pi-coding-agent`. Si pi 0.x rompe, sólo `pi-binding/` cambia. **No se importa `@earendil-works/pi-ai` directamente** (transitivo): los modelos se resuelven vía `modelRuntime.getModel(provider,id)`.

**Ejecutar el gate en vivo:** `ANTHROPIC_API_KEY=sk-ant-... npm run spike` (o `OPENAI_API_KEY`/`GEMINI_API_KEY` con `AIES_SPIKE_MODEL` ajustado y provider en `aies.config.json`). Sin clave, el gate pasa documentando el gap + backstop.

---

## auth y config

- `runtime/aies.config.json` — `provider` + `models.{orchestrator,explorer,implementer,verifier}` (versionado, **sin claves**), `orchestratorThinkingLevel: "low"`, `limits.maxIterations: 12`. Modelos provisionales (calibrar en `06-research`).
- Claves **sólo por env**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, … (leídas por `ModelRuntime.create()`).

## dependencias (justificadas, plan §4)

`@earendil-works/pi-coding-agent@~0.84` (host), `zod` (schema del JSON del orquestador = **trust boundary** → validación de entrada no negociable, carve-out ponytail C3), `typescript`/`@types/node` (dev). **Ninguna otra** sin pedir.

## scripts

- `npm run build` / `npm run typecheck` — `tsc` strict (ESM, Node ≥20).
- `npm run spike` — gate de verificación de pi real (step 2, no clave = degradación con gracia).
- `npm test` / `npm run test:loop` / `test:persist` / `test:orch` / `test:compaction` — verificaciones sin pi (bucle/persistencia/parser/compactación).
- `npm run smoke` — `aies run` sobre `fixtures/smoke-repo/` (step 9).
- `npm run research:metrics -- <log.jsonl>` — métricas NFR §3 + mapa H-01…H-06 (step 10).
- `npm run help` — `aies --help`.

## Smoke de aceptación (en vivo, plan §9)

La traza §9 (`determinar el proceso → explorar → implementar → verificar → terminar Completada`) requiere
un modelo real ejecutando `AgentSession`s de pi. Sin clave, `npm run smoke` degrada con gracia
(3 auth-fails → intervención, tarea `Recibida`, sin crash) — el harness queda verificado.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run smoke
# log.jsonl en ~/.pi/agent/aies/<hash(cwd)>/log.jsonl
npm run research:metrics -- ~/.pi/agent/aies/<hash(cwd)>/log.jsonl

# reanudar una tarea En curso; o tras corromper state.json (→ sesión limpia, log conservado):
node dist/cli.js resume --cwd fixtures/smoke-repo
```

Para forzar una trazada limpia entre ejecuciones, borra `~/.pi/agent/aies/<hash(cwd)>/`.

## open questions (no bloquean; anotadas aquí, plan §8)

- `thinkingLevel` orquestador `low` — calibrar en `06-research`.
- UX intervención v0 = `--stop` + stdin; REPL/TUI = Tier 3.
- Campos exactos de `state.json` — implementador dentro de `Runtime-Model.md §3.1`.
- Afirmación de capability — defer a `06-research`.
- Telemetría en vivo pendiente de clave de proveedor; la forma ya está verificada (C2).