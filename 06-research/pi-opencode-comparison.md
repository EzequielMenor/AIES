# AIES — Comparativa Pi ↔ OpenCode y reaprovechamiento para el harness

- **Fecha:** 2026-08-14
- **Estado:** Investigación (sin decisión; las propuestas requerirán ADR)
- **Objeto:** determinar qué partes de **Pi** y **OpenCode** merece la pena reutilizar, integrar o tomar como referencia para AIES, sin convertir AIES en una configuración de ninguno de los dos.
- **Fuente principal de AIES:** spec completa en `01-Concept/`…`05-Decisions/` + runtime en `runtime/` (v0 sobre pi 0.84.2, `ADR-009`).
- **Fuentes de Pi:** `pi.dev/` (2026-08-14), docs locales en `runtime/node_modules/@earendil-works/pi-coding-agent/docs/` (snapshot `latest` 0.84.2, la versión que AIES ya usa), `docs/sdk.md`, `docs/sessions.md`, `docs/rpc.md`, `docs/json.md`, `docs/compaction.md`, `docs/extensions.md`, `docs/usage.md`, `docs/models.md`.
- **Fuentes de OpenCode:** `github.com/anomalyco/opencode` (README, branch `dev`), `opencode.ai/docs/es/` — `cli`, `agents`, `permissions`, `mcp-servers`, `server`, `sdk`, `plugins`, `config`, `providers`, `skills`, `models` (2026-08-14).

## Convenciones

- **[Hecho]** — Comportamiento observado en la fuente oficial citada.
- **[Inferencia]** — Conclusión derivada de hechos observados, no verificada directamente.
- **[Propuesta AIES]** — Recomendación para AIES derivada de la comparación.

Cada entrada del tipo `PI / OPENCODE → problema → ¿AIES lo necesita? → veredicto` responde a la cadena de decisión pedida: qué problema resuelve, si AIES lo necesita, y si debe **integrarse**, **inspirarse** o **mantener implementación propia**.

---

## 0. Veredicto ejecutivo

1. **Pi y OpenCode son entornos de ejecución (hosts), no orquestadores.** Ninguno de los dos resuelve el problema central de AIES — dividir trabajo, mantener contexto intencional por agente, estado explícito, verificación como capacidad, proceso proporcional. Esa capa sigue siendo responsabilidad exclusiva de AIES (`Non-Goals §13`: *AIES organiza; los agentes ejecutan*).
2. **La decisión de `ADR-009` (pi v0, SDK embebido, AIES-core dueño del bucle) queda validada por este análisis.** No hay nada en OpenCode que justifique migrar el v0; hay cosas que **inspiran** mejoras y una vía clara para que OpenCode sea un **segundo host** cuando surja necesidad (`P-17`).
3. **Nada de lo observado obliga a cambiar la arquitectura actual.** La única adopción del v0 (registrar `compaction_start/end` en `log.jsonl`) ya está implementada; el resto (backstop anti-bucle inspirado en OpenCode, canal de intervención `steer/follow-up` de pi) queda para v1, incremental y sin reescrituras.
4. **La regla en cinco casos: integrar ≈ 0; inspirarse ≈ 6; implementar propio ≈ lo que AIES ya tiene.** El resto del valor de ambos hosts queda donde debe: **en el host** (MCP, permisos finos, TUI, stats, modelos, skills, sessions).

---

## 1. Qué hace Pi especialmente bien

**[Hecho]** — Pi es un *minimal terminal coding harness* diseñado deliberadamente en torno a **"primitivas, no features"** ([pi.dev](https://pi.dev/) "*Primitives, not features*"): no incluye MCP, subagentes, popups de permiso, plan mode ni to-dos; esas cosas se construyen con **extensiones, skills, prompt templates, themes y paquetes** (["What we didn't build"](https://pi.dev/)). Es la filosofía estructuralmente más cercana a AIES: *un núcleo pequeño + mecanismos de extensión*.

- **[Hecho]** — **Cuatro modos programáticos**: interactivo, `-p`/print, `--mode json` (event stream JSONL), `--mode rpc` (protocolo JSON sobre stdin/stdout) y **SDK embebido** en Node (`docs/usage.md`/`docs/sdk.md`). Es el único de los dos con SDK in-process.
- **[Hecho]** — **Sesiones en árbol** en un solo fichero JSONL (`~/.pi/agent/sessions/`), con `/tree`, `/fork`, `/clone` y **branch summaries** que conservan contexto de la rama abandonada (`docs/sessions.md`).
- **[Hecho]** — **Context/compaction de calidad**: *auto-compaction* con umbral (`reserveTokens=16384`, `keepRecentTokens=20000`), *split turns*, retry en overflow, y **compactación y resumen de rama personalizables vía extensión** (`session_before_compact`, `session_before_tree`) con formato estructurado de resumen (`docs/compaction.md`).
- **[Hecho]** — **Contexto "engineerable"**: system prompt mínimo, `AGENTS.md`/`CLAUDE.md` recorridos hacia arriba, `SYSTEM.md`/`APPEND_SYSTEM.md`, **skills con progressive disclosure** (solo nombre+descripción en el contexto; contenido bajo demanda — y sin romper el prompt cache) y hooks `context` (filtrar/inyectar mensajes) y `before_agent_start` (inyectar mensaje / modificar system prompt) ([pi.dev](https://pi.dev/) "Context engineering").
- **[Hecho]** — **Modelos/proveedores sólidos**: `ModelRuntime` multi-provider (15+ built-in), catálogos locales persistentes, `models.json` para proveedores y modelos custom (con costes, thinking levels, `compat` por API), autenticación por `auth.json`/env, y **telemetría completa por vuelta** (`get_session_stats`, `getContextUsage`, `usage` por mensaje, incl. cache) (`docs/sdk.md`, `docs/models.md`).
- **[Hecho]** — **Extensiones TypeScript ricas**: `registerTool`, `registerCommand`, `registerShortcut`, `registerProvider`, y un bus de eventos amplio (`input`, `context`, `tool_call` bloqueable, `tool_result` modificable, `session_before_switch/compact/tree`, `agent_settled`, etc.) con UI extensible (`ctx.ui.select/confirm/input/notify`) que en modo RPC se traduce en un sub-protocolo JSONL (`docs/extensions.md`).
- **[Hecho]** — **Interacción con agente en marcha**: cola `steer()` (entrega tras el *tool call* actual) y `followUp()` (entrega cuando el agente termina), más cancelación `abort()` (docs/sdk.md).
- **[Hecho]** — **Retries automáticos** en errores transitorios (overloaded/rate-limit/5xx) con eventos `auto_retry_*`.

**Qué problema resuelve (para AIES):** ser un motor de sesiones por agente fiable, telemetría por vuelta, control de contexto por sesión y limites observables — todo lo que AIES ya consume en `ADR-009`.

## 2. Qué hace OpenCode especialmente bien

**[Hecho]** — OpenCode es el **agente de codificación open-source** con arquitectura **servidor/cliente HTTP**: `opencode` lanza TUI **y** un servidor con especificación **OpenAPI 3.1**; el SDK `@opencode-ai/sdk` es un cliente tipado de ese servidor (`docs/server`/`docs/sdk`). Es el único de los dos con una superficie de integración **independiente del proceso y del lenguaje**.

- **[Hecho]** — **Modelos**: **75+ proveedores** vía AI SDK + `Models.dev`/`proveedores`, proveedores custom con paquetes `@ai-sdk/*` (p. ej. `openai-compatible` para Ollama/llama.cpp/LM Studio), `opencode models`, caché refreshable, `small_model` para tareas ligeras (títulos/sumarios), y **salida estructurada** `json_schema` con `retryCount` (`docs/sdk`).
- **[Hecho]** — **Permisos: el sistema más maduro de los dos comparados**: matriz `allow/ask/deny` por herramienta, sintaxis granular con **globs** sobre argumentos (`bash: {"*": "ask", "git *": "allow"}`), `external_directory`, y anti-bucle **`doom_loop`** (3 llamadas idénticas a una herramienta → recovery) (`docs/permissions`).
- **[Hecho]** — **MCP de primera clase**: servidores locales (command) y remotos (url), **OAuth automático** (RFC 7591) y gestión global/por-agente (`docs/mcp-servers`).
- **[Hecho]** — **Modelo de agentes explícito**: agentes **primary** (build/plan) y **subagentes** (general/explore/scout), agentes de sistema ocultos (compaction/title/summary), configuración JSON **o** markdown con frontmatter, `permission.task` para restringir qué subagentes puede invocar un agente, `steps` (máx. iteraciones), `hidden`, y **child sessions** con navegación padre↔hijo (`docs/agents`).
- **[Hecho]** — **Headless completo**: `run --format json` (eventos JSON), `serve` (servidor HTTP sin cabeza), `attach` (TUI contra un servidor remoto), `web`, `acp` (Agent Client Protocol por stdin/stdout) (`docs/cli`).
- **[Hecho]** — **Estadísticas**: `opencode stats` (uso de tokens y coste por sesión/proyecto/modelo) y `session list/export/import` (`docs/cli`).
- **[Hecho]** — **Plugins TS** con hooks (`event`, `tool.execute.before/after`, `shell.env`, `session.*`, `experimental.session.compacting` para compactación custom) cargables por archivo, por directorio y por npm (`docs/plugins`).
- **[Hecho]** — **Skills igual que agente: `SKILL.md`** con frontmatter `name`+`description`, listadas en la herramienta `skill` y cargadas bajo demanda con permisos (`skill: allow/deny/ask`) (`docs/skills`).
- **[Hecho]** — **AGENTS.md compatible** (leer `.claude`, `.agents`, instrucciones vía glob en `instructions`), LSP, formateadores (`docs/config`).

**Qué problema resuelve (para AIES):** un host con servidor independiente, permisos finos y MCP — la alternativa más completa para que AIES delegue *ejecución con límites finos* sin implementarlos él mismo.

## 3. Qué hace peor o añade complejidad innecesaria (para AIES)

> Facilitando el sesgo: esto juzga *para el propósito de AIES* (harness orquestador), no a los productos en general.

- **[Hecho → Inferencia]** — **OpenCode no tiene un concepto de "orquestador que no ejecuta"**: su agente *build* tiene todas las herramientas; su *plan* es de solo lectura clásico. El patrón "coordinador sin tools + decisión JSON" (que AIES diseña en `ADR-007`) **no existe como primitiva**; habría que construir su equivalente (otro agente custom sin tools + salida estructurada), lo cual AIES **ya hace sobre pi sin coste** (`runtime/src/orchestrator`).
- **[Hecho → Inferencia]** — **OpenCode acopla sesión y conversación**: su persistencia es de *mensajes* con revert/diff; no expone un **estado de tarea estructurado** (unidades, iteraciones, límites) como `state.json` de AIES. Adoptarlo como host implicaría mantener ese estado en AIES-core igualmente — el estado no vendría gratis del host.
- **[Hecho → Inferencia]** — **OpenCode como host obliga a una frontera de proceso (HTTP)**. `ADR-009` **rechazó** esa opción para v0 (latencia, ciclo de vida del subproceso, nada que la exigiera). No es "peor" en absoluto, pero es **más caro de integrar** que el SDK in-process de pi — el coste se paga solo cuando exista un 2.º host justificado.
- **[Hecho → Inferencia]** — **Pi carece deliberadamente de subagentes, MCP y permisos finos built-in**. Para AIES eso es *irrelevante* mientras AIES los provea por su cuenta (workers efímeros ya hechos; permit gates vía extensiones si se necesitan). Pero **no hay que dejarse llevar por las features**: el que pi "no tenga X" no es un hueco de AIES.
- **[Inferencia]** — **Ambos hosts son inestables a propósito**: pi es 0.x con `dist/*.d.ts` volátil; OpenCode mueve 15k+ commits en `dev`. AIES ya mitigó pi con el binding aislado en `src/pi-binding` (`runtime/README.md` §C2); si se suma OpenCode habrá que **fijar versiones y aislar igualmente**.
- **[Hecho → Inferencia]** — **El sistema de "agentes" de OpenCode puede confundirse con el modelo de AIES.** Sus roles (build/plan) son *formas de trabajo de un agente conversacional*; los roles de AIES (orquestador/trabajador) son *responsabilidades estructurales*. Adoptar la nomenclatura/semántica de OpenCode en la spec de AIES sería mezclar capas.

## 4. Qué debería adoptar AIES (inspiración, no componente)

Aplicando la cadena de decisión `problema → ¿AIES lo necesita? → veredicto` por área.

### 4.1 Ejecución del agente

| Pregunta | Respuesta |
|---|---|
| Problema | Ejecutar una vuelta de agente con observabilidad, cancelación y sin bloqueos. |
| ¿AIES lo necesita? | **Sí** — es `R-3/R-4` y la operación *ejecutar una unidad*. |
| Veredicto | **Mantener propia (ya implementada) sobre el host.** El bucle `estado→decisión→operación→resultado` (`Runtime-Model`/`runtime/src/core/loop.ts`) es la identidad de AIES; pi aporta la vuelta (`session.prompt`+eventos+`abort`), OpenCode la aportaría como `session.prompt` HTTP. No integrar la ejecución del host en el núcleo. |

**Adopción concreta (Propuesta AIES):** en v1, el **canal de intervención** del desarrollador (`Runtime-Model §7`, hoy SIGINT→`stopSignal` en `intervention.ts`) puede enriquecerse con la semántica de pi `steer()/followUp()`: *intervenir en la próxima vuelta* (steer) vs *entregar cuando el agente termine* (followUp). Es una evolución del canal, no del bucle.

### 4.2 Contexto

| Pregunta | Respuesta |
|---|---|
| Problema | Contexto limitado, compactación, recuperación entre sesiones, tokens. |
| ¿AIES lo necesita? | **Sí** — `OBJ-01`, `P-07`, `RNF-07`. |
| Veredicto | **Propio para lo intencional; delegado al host para lo mecánico.** AIES ya hace lo único que ni pi ni OpenCode hacen: **compone el contexto por agente de forma intencional** (`README` `Contexto`). Pi/OpenCode compactan *la conversación de un agente*; AIES además **no comparte conversaciones**. |

**Adopción concreta — COMPLETADA (2026-08-14, en `runtime`):**
- **[Hecho]** Observar los eventos `compaction_start`/`compaction_end` de pi (suscripción en `PiHostSession`, `pi-binding/index.ts`) y **registrarlos en `log.jsonl`** como entrada `type:"compaction"` con razón, `tokensBefore`/`estimatedTokensAfter`, `willRetry` (`observability.ts`); `research:metrics` los cuenta en `observabilidad.compactions`. Refuerza `RNF-18/19` (el techo de contexto deja huella) sin reimplementar nada. Verificado por `npm run test:compaction` (self-check sin pi) + spike.
- **[Propuesta]** Adoptar la idea de **progressive disclosure** de pi/OpenCode para el *conocimiento del repo*: en v1 los workers podrían recibir *nombres+descripciones* de skills/conocimiento y cargarlos bajo demanda (patrón `skills` de pi/OpenCode). En v0 no hace falta (`ADR-008` ya carga docs al arranque).

### 4.3 Herramientas y permisos

| Pregunta | Respuesta |
|---|---|
| Problema | Qué puede hacer cada agente; aprobaciones. |
| ¿AIES lo necesita? | **Sí** — `RNF-03/RNF-05` (autonomía limitada por capacidad), Tier 2 diferido en `MVP-v0`. |
| Veredicto | **Inspirarse en OpenCode; implementar como capa propia, pequeña.** AIES ya tiene **allowlists por capacidad** (el verifier sin `edit`/`write` es el `permission.edit: deny` de OpenCode, `MVP-v0 §1`). El sistema de globs `allow/ask/deny` de OpenCode es la referencia correcta para el **Tier 2** (permisos por worker), pero como **config de AIES** que se materializa en la allowlist del worker del host, no como motor de permisos del runtime. |

### 4.4 Agentes y delegación

| Pregunta | Respuesta |
|---|---|
| Problema | Subagentes, roles, qué puede invocar cada uno. |
| ¿AIES lo necesita? | **Sí** — `P-01/P-14/P-16`. |
| Veredicto | **Propio (ya implementado), con un aprendizaje.** El modelo de AIES (capacidad como contrato, trabajador como variable) es *más delgado* que los "subagentes" de OpenCode. **No adoptar** el catálogo build/plan. [:Hecho — OpenCode] `permission.task` (globs de qué subagente puede invocar un agente) es conceptualmente reemplazado por la **selección por capacidad** de AIES (`ADR-004`). |

**Adopción (Propuesta AIES):** la señal **"iteraciones sin progreso"** de `ADR-006` (una de las cuatro señales de re-descomposición) puede concretarse con el *backstop* de OpenCode `doom_loop` (3 llamadas idénticas → recovery): en v1, contar vuelta sin cambio de estado como indicio de no-progreso. Es una mejora de decisión, no un componente nuevo.

### 4.5 CLI / UX

| Pregunta | Respuesta |
|---|---|
| Problema | Sesiones, run headless, logs, stats, JSON/events. |
| ¿AIES lo necesita? | **Parcialmente** — `REQ-F-09` (visibilidad), `RNF-11`. |
| Veredicto | **Inspirarse en ambos para la UX viva; mantener el `aies` operativo propio.** El CLI v0 (`aies run/resume`, smoke) es suficiente para medir (`P-19`). OpenCode aporta el mejor modelo de **stats** (`opencode stats`) y de **session list** — útiles para el dashboard de `log.jsonl`/`research:metrics` de AIES. |

**Adopción (Propuesta AIES):** comando v1 `aies sessions` (listar/continuar por `state.json`) y presentación de métricas al terminar (`opencode stats` como referencia visual). Sin TUI propia en v0/v1 (diferida, `MVP-v0` Tier 3).

### 4.6 Modelos

| Pregunta | Respuesta |
|---|---|
| Problema | Proveedores, modelos, selección, streaming, usage, coste. |
| ¿AIES lo necesita? | **Sí** — `OBJ-07/08`, `REQ-F-21/22`. |
| Veredicto | **Mantener en el host.** Pi (ModelRuntime) y OpenCode (AI SDK+Models.dev) abstraen esto mejor de lo que AIES debería hacerlo jamás (`Non-Goals §2`). La asignación **modelo por capacidad** (`aies.config.json` `models.{orchestrator,explorer,implementer,verifier}`) **ya equivale** al `model` por agente de OpenCode y al rol por rol de pi. `small_model` de OpenCode equivale a usar modelo barato en el orquestador/verificador: ya configurable. |

### 4.7 Extensibilidad

| Pregunta | Respuesta |
|---|---|
| Problema | Añadir capacidades, workers, herramientas, hooks. |
| ¿AIES lo necesita? | **Sí** — `RNF-13/RNF-14` (añadir capabilities/workers sin rediseño). |
| Veredicto | **Fuera del núcleo: extensiones del host.** AIES no implementa su propio sistema de plugins/eventos/hooks. Añadir un worker = nueva entrada de config + sesión de host (`MVP-v0 §1`). Las extensiones/skills/packages de pi y los plugins de OpenCode son **mecanismos del host** que AIES puede consumir (p. ej. skills del proyecto vía `DefaultResourceLoader`), no algo que deba replicar. |

---

## 5. Tabla resumen por área

| Área | Pi | OpenCode | AIES debería… |
|---|---|---|---|
| Ejecución del agente (turno/vuelta) | SDK in-process; `prompt`+eventos+`abort` | Servidor HTTP; `message`+SSE+`abort`; revert | **Propia** (bucle `loop.ts`); ejecución delegada al host ([Hecho] verificado en runtime y ambos docs). |
| Interrupciones / steering | `steer()`/`followUp()` con cola ([Hecho]) | `abort`, mensajes async | **Inspirarse** para el canal de intervención v1 ([Propuesta AIES]). |
| Errores / retries | `auto_retry_*` transitorios ([Hecho]) | configuración de retry | **No adoptar** (AIES: vuelta al bucle, `P-13`; el host ya reintenta). |
| Ejecución no interactiva | `-p`, `--mode json`, `--mode rpc` ([Hecho]) | `run --format json`, `serve`, `acp` ([Hecho]) | **Mantener** `aies run/resume`; eventos JSON al host; headless vía host. |
| Contexto intencional por agente | No (una sesión = un agente) | No (una sesión = un agente) | **Propia** — diferenciador de AIES (`P-07`): ni pi ni OpenCode hacen context partitioning. |
| Compactación | Auto+custom vía extensión ([Hecho]) | Auto+prune+hook (`[Hecho]` `session.compacted`/compacting) | **Delegada y observada** — `compaction_start/end` ya quedan en `log.jsonl` ([Hecho, 2026-08-14]); no reimplementarla. |
| Memoria entre sesiones | Sessions en árbol + branch summaries ([Hecho]) | Sessions con `summary`, `fork`, diff ([Hecho]) | **Propia** — `state.json`+`log.jsonl` (ADR-008); el conocimiento del proyecto ya vive en el repo. |
| Herramientas built-in | `read bash edit write grep find ls` + allowlist + `noTools` ([Hecho]) | mismo conjunto + `glob/list/websearch/lsp/task/skill…` | **Propia vía allowlists por capacidad** (`MVP-v0 §1`); no adoptar herramientas del host en el core. |
| Permisos finos | Permissions vía extensión (no built-in) ([Hecho]) | `allow/ask/deny` + globs + `external_directory` + `[Hecho]` `doom_loop` (3 idénticas) | **Inspirarse** para Tier 2 (globals por worker) y para el *backstop* anti-bucle de `ADR-006` ([Propuesta AIES]) — implementando config, no motor propio. |
| MCP | No built-in ([Hecho]) | Primera clase, local/remoto/OAuth ([Hecho]) | **Fuera de AIES (integración del host)**; en pi vía extensión si se necesita; en OpenCode nativo. |
| Subagentes / roles | No built-in ([Hecho]) | primary+subagent+task permissions ([Hecho]) | **Propio** — capacidad como contrato (cap. como contrato) ya cubre la delegación; no adoptar catálogo build/plan. |
| CLI / UX | TUI rica, sessions tree, `/share`, temas ([Hecho]) | TUI, `serve/attach/web`, `run --format json`, `stats`, `session list/export` ([Hecho]) | **Inspirarse**: `stats` y `session list` para UX viva de `research:metrics`/`log.jsonl` ([Propuesta AIES]); sin TUI propia en v0. |
| Estadísticas / coste | `get_session_stats`/`getContextUsage` por vuelta ([Hecho]) | `opencode stats` global ([Hecho]) | **Mantener medición propia** (`research:metrics`, `RNF-07/17`): es agnóstica del host; los hosts proveen los datos crudos. |
| Modelos / proveedores | ModelRuntime 15+, `models.json`, thinking levels ([Hecho]) | AI SDK + Models.dev 75+, proveedores custom, `variant` ([Hecho]) | **Mantener en el host** (`Non-Goals §2`); AIES solo configura por rol/think level (ya hecho). |
| Config | `settings.json` global+proyecto | `opencode.json` con precedencia y merge ([Hecho]) | **Propia** (`aies.config.json`); inspirarse en precedencia/merge en v1. |
| Extensibilidad | Extensions TS + skills + packages + hooks ([Hecho]) | Plugins + hooks + npm ([Hecho]) | **Fuera del núcleo**: extensiones del host; AIES se extiende con nuevos workers/config. |
| Verificación | — | — | **Propia** — capacidad de verificación con worker sin `edit`/`write` ([ADR-002], ya implementado). |

---

## 6. Qué debería implementar AIES por sí mismo (nada nuevo; confirmación)

Lo siguiente **pertenece a AIES y ningún host lo aporta**; el análisis refuerza mantenerlo en el núcleo exáctamente como está:

- **Bucle de decisión** `estado → decisión → operación → resultado` ([Runtime-Model §2], `loop.ts`).
- **Estado explícito de la tarea** (unidades, acumulación selectiva de `knownInfo`, iteraciones, límites) — `state.ts`.
- **Contrato de decisión JSON** del orquestador y **parseo robusto** con reentrada ([ADR-007], `orchestrator/parse.ts`, tope 3 intents).
- **Modelo de capacidades como contrato** y **trabajadores sustituibles** ([Capability-Model], `ADR-004`).
- **Persistencia selectiva** `state.json`+`log.jsonl` bajo `agentDir` keyed-by-cwd ([ADR-008], `file_store.ts`).
- **Límites por tarea con repertorio** (por defecto *pedir intervención*) ([ADR-005], `loop.ts` + `limits.ts`).
- **Verificación como capacidad** (no agente fijo) con worker no-editor ([ADR-002], `workers/*`).
- **Descomposición/re-descomposición** (facetas de plan) ([ADR-006], `applyAjustePlan`).
- **Canal de intervención del desarrollador** (entrada externa al bucle) ([Runtime-Model §7], `intervention.ts`).
- **Observabilidad reconstructible** (`log.jsonl`, `research:metrics`) — servida por el host solo en datos crudos de `usage`/`contextUsage`.

## 7. Qué debería quedar como integración del host

- **Motor de sesiones por agente** (pi `AgentSession`; en OpenCode equivaldría a sesiones con agente/permission/`model` por rol).
- **Motor de modelos multi-proveedor** (`ModelRuntime` de pi; AI SDK de OpenCode) — auth, catálogos, costes, thinking.
- **Herramientas del proyecto** (`read/bash/edit/…`) y **allowlists/materialización de permisos** del host.
- **Compaction nativa** (pi autoCompaction / OpenCode auto/prune) — AIES observa, no la implementa.
- **MCP** — cliente en el host (extensión pi o nativa OpenCode).
- **Skills / progressive disclosure** — mecanismo del host (`DefaultResourceLoader` de pi; herramienta `skill` de OpenCode); AIES puede *interesarse* por ellas como conocimiento bajo demanda.
- **RPC/JSON/HTTP/ACP** — superficies de integración del host para *otros* clientes; AIES usa el SDK.
- **auth/credenciales** — del host (`auth.json`/env en pi; `auth.json` local en OpenCode).
- **Retries transitorios** — del host; AIES observa el resultado.

## 8. Qué debería permanecer fuera de AIES

- Clientes MCP propios; sistema de **plugins/extensiones propios**; TUI/editor propios ([MVP-v0] Tier 3).
- Abstracción `HostAdapter` antes de un 2.º host real ([ADR-009]: se extrae al aparecer; pi-binding sigue siendo el único módulo que importa pi — verificado).
- Compartición/exportación de sesiones (HTML/gist en pi; share/zen en OpenCode).
- Agentes GitHub/GitLab, web/desktop, policies/enterprise de OpenCode.
- Sistema de memoria general (`Non-Goals §7`) y gestión de proyectos (reforzado por OpenCode al tenerlos como features del producto, no del harness).
- *Thought-block/thinking* y detalles de streaming por proveedor (del host).

## 9. Arquitectura propuesta — `AIES Core ↔ Host`

**[Hecho]** — La frontera ya existe y está bien trazada: `ADR-001` (AIES = harness+runtime; host externo) → `ADR-009` (pi embebido, `pi-binding` como único módulo pi) → `src/host/types.ts` (`HostSession.runTurn`, `TurnResult`, `TurnError`) y `src/pi-binding`. **[Propuesta AIES]** — Esta comparación recomienda **no moverla** y añadir solo dos precisiones:

```text
AIES Core (proceso dueño del bucle)
   │  estado → decisión → operación → resultado   (loop.ts)
   │  estado explícito / ajustePlan / límites / intervención  (core, orchestrator, limits, intervention)
   │  persistencia y observabilidad (file_store, observability, research:metrics)
   ▼
Host facade — contrato mínimo de hosting (host/types.ts):
   · runTurn(prompt, signal) → { text, telemetry }   [Hecho en v0]
   · worker = sesión con tools/materialización de permisos por capacidad   [Hecho]
   · telemetría por vuelta: usage, contextUsage   [Hecho; compaction events → v1]
   ▼
Host concreto de v0: pi  (ModelRuntime + AgentSession + DefaultResourceLoader + autoCompaction)
Posible Host 2.º (v1+): OpenCode — vía servidor HTTP/SDK; exigirá refactor del binding
   hacia un adaptador de red (opción B de ADR-009 diferida por P-17)
```

Puntos de la propuesta:

1. **El contrato mínimo de hosting es el que ya existe** (`HostSession.runTurn` + telemetría). Si aparece un 2.º host, ese contrato se formaliza como interfaz/repositorio de adaptadores — **no antes** (`P-17`, ponytail).
2. **OpenCode encaja como host 2.º de forma natural**: su servidor HTTP + SDK tipado es, estructuralmente, la *opción B* de `ADR-009` (frontera de proceso) que en su día se rechazó por adelantada. Como 2.º host, la necesidad **ya existe** y el coste (latencia HTTP, monitor de proceso `serve`) es el precio de la independencia de lenguaje/plataforma. El bucle de AIES-core **no cambia**: lo que cambia es el adaptador `opencode-binding` (crear sesión con agente + `permission` por worker + `model` por rol + leer `usage` de cada `Message`).
3. **Nada del mapa de capacidades cambia con el host** ([Capability-Model §7]): la capacidad es el contrato estable; el trabajador-vía-pi y el trabajador-vía-opencode son, ambos, *la variable* (P-16).

## 10. Recomendación final para v0/v1

### v0 (actual, sin cambios de arquitectura)
- **[Hecho]** **No tocar el runtime** de v0 salvo lo ya adoptado. `ADR-009` queda validado: pi como host SDK embebido, orquestador `noTools:"all"`, workers por capacidad, `log.jsonl` como dataset. No hay nada en OpenCode que justifique migrar.
- **[Hecho]** Adoptada (2026-08-14): observación de la **compactación** de pi → `log.jsonl` (entrada `type:"compaction"` + `research:metrics.observabilidad.compactions`). Es la única mejora del v0; no cambia arquitectura.

### v1 (candidatos ordenados por valor/esfuerzo, todos requieren ADR antes de código)
1. **Backstop anti-bucle** inspirado en `doom_loop` de OpenCode: concretar la señal *iteraciones sin progreso* de `ADR-006` (vuelta sin cambio de estado/plan) con un tope configurable.
2. **UX viva de sesiones**: `aies sessions` (listar/continuar) + resumen de stats al terminar (referencia: `opencode stats`), apoyado en `log.jsonl`.
3. **Canal de intervención enriquecido**: semántica *steer/follow-up* de pi sobre el canal SIGINT actual.
4. **Tier 2 de permisos**: matriz `allow/ask/deny` por worker, inspirada en OpenCode, materializada en allowlists del host — solo si aparece necesidad real.
5. **OpenCode como host 2.º (experimento)**: prototipo de `opencode-binding` aislado (misma `HostSession`) para comparar coste/latencia/telemetría frente a pi; **no** se integra en producto hasta medir y hasta que la necesidad lo justifique (`P-17`).

### No hacer
- No integrar el estado de sesión de OpenCode (mensajes+revert) en `state.json` — son naturalezas distintas y `ADR-008` ya decidió qué persiste AIES.
- No trasladar el modelo de agentes (build/plan) ni los permisos de OpenCode *al núcleo* — solo inspiración config.
- No crear `HostAdapter` anticipado ni un "aies.json" opcode-agnostic general.
- No implementar MCP, plugins, skills, TUI o stats propios en el núcleo.

## 11. Riesgos y trade-offs

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Abstraer el host antes de un 2.º host real (over-engineering) | Media | `P-17`/ponytail: el contrato `HostSession` ya está; se formaliza como adaptadores solo cuando haya 2 implementaciones. |
| Host volátil (pi 0.x; OpenCode `dev` 15k+ commits) | Alta | Pines de versión (ya: `~0.84.2`); aislar cada host en su propio `*-binding`; tests sin host (`self-check/`). |
| Obsolescencia de conocimiento del repo (¿AGENTS.md solo?) | Media | Ya mitigado por `ADR-008` (docs curadas); skills del host como mejora v1 (progressive disclosure). |
| Confusión de capas: features del host (agentes de OpenCode) con modelo de AIES (rol/trabajador) | Media | `Glossary`/spec usa términos propios; este doc deja constancia de que no se importa la nomenclatura. |
| Doble fuente de telemetría (host vs `log.jsonl`) | Baja | `research:metrics` normaliza; `usage` puede venir `null` (ya manejado: `telemetry_unavailable` con backstop, [runtime/README] §C2). |
| Dependencia de la calidad de compactación del host para decisiones de límites | Media | AIES **observa**, no delega la decisión: `RNF-19` (límite → bucle o terminación) se mantiene en AIES-core. |
| OpenCode como host: ciclo de vida + latencia HTTP por vuelta | Media (solo si se adopta) | Mismo criterio de `ADR-009` opción B: medir antes de decidir; bucle no cambia. |
| Integrar hooks intrusivos del host en el bucle (p. ej. intervención) | Baja | Intervención es *entrada externa* ([Runtime-Model §7]); no añade acoplamiento al ciclo. |

## 12. Conclusiones de la investigación

1. **AIES es estructuralmente más parecido a la filosofía de pi** (núcleo mínimo + mecanismos) y **funcionalmente más parecido a OpenCode** (que sí construye subagentes/permisos/MCP como producto). Ninguna de las dos similitudes obliga a moverse: reflejan que AIES es *un harness*, no *un agente*.
2. **El único gap real que ambos hosts no cubren y que AIES ya cubre es el contexto intencional por agente** — el renglón que más vale preservar (`OBJ-01`, `P-07`, `H-01`).
3. **Lo aprovechable de pi**: SDK embebido y telemetría (ya en uso), compactación observable, y la semántica `steer/follow-up` para el canal de intervención.
4. **Lo aprovechable de OpenCode**: modelo de permisos fino y `doom_loop` (inspiración para Tier 2 y el anti-bucle), `stats`/`session list` (referencia UX), proveedores/multi-modelo (si se elige como host), y su frontiera HTTP/SDK como plantilla del futuro 2.º host.
5. **Nada exige cambiar la arquitectura actual.** AIES-core mantiene su identidad; pi sigue siendo el host v0; OpenCode queda como candidato a host futuro con un `opencode-binding` aislado, medible, y **no antes de que haya necesidad demostrada** (`P-17`/`P-19`).

## 13. Referencias usadas

### AIES (spec y runtime)
`01-Concept/` (Non-Goals §2, §5, §7, §11, §13; Principles P-01, P-05, P-07, P-13, P-14, P-16, P-17, P-19, P-20); `02-Requirements/` (REQ-F-21/22/26/27; RNF-03/05/07/11/13/14/18/19/20); `03-Architecture/` (MVP-v0-Scope §1/§4/§5/§6, Runtime-Model §2/§4/§7, Decision-Model §4.2/§6, Capability-Model §7, Agent-Model §7); `05-Decisions/` (ADR-002, ADR-004, ADR-005, ADR-006, ADR-007, ADR-008, ADR-009); `runtime/README.md`, `runtime/src/{core,orchestrator,workers,pi-binding,host,persistence,intervention,limits}.ts`, `runtime/aies.config.json`.

### Pi
`https://pi.dev/` (2026-08-14); docs locales `node_modules/@earendil-works/pi-coding-agent/docs/` (versión 0.84.2, la que usa el runtime): `index.md`, `sdk.md`, `sessions.md`, `rpc.md`, `json.md`, `compaction.md`, `extensions.md`, `usage.md`, `models.md`.

### OpenCode
`https://github.com/anomalyco/opencode` (README, branch `dev`, 2026-08-14); `https://opencode.ai/docs/es/` (misma fecha): `cli`, `agents`, `permissions`, `mcp-servers`, `server`, `sdk`, `plugins`, `config`, `providers`, `skills`.