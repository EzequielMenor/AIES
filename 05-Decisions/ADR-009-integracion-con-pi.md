# ADR-009 — Integración con el host (pi) y realización material del runtime

- **Estado:** Aceptada
- **Fecha:** 2026-08-14
- **Resuelve:** "Fuera del alcance: ubicación física del harness dentro del host concreto" de `ADR-001-harness-runtime-entorno-ejecucion.md`; cuestión nº 1 de `System-Context.md §4`; cuestión nº 5 de `Component-Model.md §5` (ubicación física de las relaciones); nota abierta de `Glossary.md §2` (entorno de ejecución concreto). Es prerequisito de `ADR-007` y `ADR-008`.

---

## Contexto

`ADR-001` trazó la frontera conceptual —AIES y el entorno de ejecución concreto son sistemas separados, este último intercambiable— pero dejó explícitamente abierta la **ubicación física del harness dentro del host**: proceso, mecanismo de enlace, quién posee el bucle. Esa apertura es el último hueco que impide que la spec sea *implementation-ready*.

En paralelo, los principios imponen restricciones que el enlace material debe respetar:

- `P-01`/`REQ-F-03` — el orquestador no realiza el trabajo delegable; el enlace debe **hacer valer esa restricción en código**, no en disciplina del prompt.
- `P-13`/`RNF-19` — AIES observa resultados y límites; el enlace debe dejar observable el `usage` (tokens/coste) de cada vuelta.
- `P-15`/`RNF-14` — el modelo es un recurso sustituible; el enlace no debe fijar un único proveedor.
- `RNF-07`/`RNF-08`/`RNF-17` — contexto/tiempo/coste deben poder medirse por agente, unidad y tarea.
- `Non-Goals §11` — el host no forma parte de la identidad conceptual de AIES; el enlace debe ser reemplazable en el futuro sin contaminar el modelo conceptual.

Decisión de GUI previa (no reabrir): el host v0 es **pi** (`https://pi.dev/docs/latest`, snapshot "latest" a 2026-08-14).

---

## Opciones consideradas

### Opción A — pi vía SDK embebido en proceso; AIES-core dueño del bucle

AIES-core es el entrypoint del proceso y posee el bucle `estado → decisión → operación → resultado`. pi se aloja **en el mismo proceso** vía su SDK (`@earendil-works/pi-coding-agent`); cada trabajador es una `AgentSession` efímera; el orquestador es también una `AgentSession`. pi aporta el motor de ejecución de workers y el `ModelRuntime` multi-provider.

Ventajas: AIES controla el bucle y los límites en código (`P-01`/`P-20`); acceso directo a `usage`/`contextUsage` por vuelta (`RNF-07`/`RNF-17`); sin capa de IPC ni proceso extra (`P-17`); `SessionManager.inMemory` para workers efímeros y `setModel` para sustituir modelos sin rediseño (`P-15`/`RNF-14`); `autoCompaction` nativo libera a AIES de reimplementar gestión de contexto.

Inconvenientes: acoplamiento directo a la API de pi v0; un cambio de host exige refactor. Mitigación: aislar el enlace en un único módulo de binding (no una abstracción), extraíble cuando aparezca un 2.º host.

### Opción B — pi vía subproceso/RPC separado

AIES-core se comunica con un proceso pi por un canal RPC/JSON, delegando la creación de sesiones y la captura de eventos.

Ventajas: frontera de proceso explícita; AIES-core agnóstico al lenguaje del host.

Inconvenientes: añade un proceso, latencia de IPC y gestión del ciclo de vida del subproceso sin que ningún requisito lo exija; el SDK embebido ya resuelve multi-provider, sesiones y compaction; contradice `P-17` (complejidad anticipada sin necesidad).

### Opción C — Abstracción `HostAdapter` desde v0

Definir una interfaz `HostAgent` con un adaptador pi y previsión de futuros hosts, antes de que exista un segundo host.

Ventajas: portabilidad teórica desde el día uno.

Inconvenientes: sin un 2.º host, la interfaz es especulativa (`P-17`); ninguna de las dos implementaciones conocidas la justifica hoy, así que la interfaz se diseñaría a ciegas y probablemente mal (el reprote llama a esto YAGNI honesto); contradice `Non-Goals §5` (no construir alrededor). Se extraerá **cuando** aparezca el segundo host.

---

## Decisión

**Opción A.**

### 1. Quién posee qué

- **AIES-core** es el dueño del bucle de decisión (`Runtime-Model.md §2`): mantiene el estado, toma/promueve la decisión, ejecuta la operación, observa el resultado (`P-01`/`P-13`).
- **pi** es el **motor de ejecución de workers** y el proveedor del `ModelRuntime` multi-provider (`ModelRuntime.create()`). pi no decide el proceso de la tarea; ejecuta las unidades que AIES-core le delega.

### 2. Binding del trabajador (worker)

Cada unidad delegada se ejecuta en una `AgentSession` por capacidad:

```text
createAgentSession({
  cwd: <project>,
  sessionManager: SessionManager.inMemory(<project>),   // efímera por defecto
  model,                                                // asignado por capacidad (config v0)
  thinkingLevel,
  tools: [ <allowlist por capacidad> ],                 // p. ej. Explorer: read,grep,find,ls
  customTools?,                                         // sólo si la capacidad lo requiere
  resourceLoader                                        // AGENTS.md + skills del worker
})
```

- `session.prompt(workUnit)` resuelve al terminar la vuelta; AIES-core se suscribe a eventos (`session.subscribe`) para observarla y la puede cancelar con `session.abort()`.
- El **resultado** del worker = último texto asistente + `usage` (tokens/coste) reportado en el evento de fin de turno — entrada para `RNF-07`/`RNF-17` y para la siguiente decisión (`P-13`).
- **Tool allowlists por capacidad** materializan los límites del trabajador (`Agent-Model.md §7`, `RNF-05`): la capacidad no concedida no existe en su sesión. Los catálogos concretos se fijan en `MVP-v0-Scope.md §1`.

### 3. Binding del orquestador (detallado en `ADR-007`)

El orquestador es una `AgentSession` con `noTools: "all"` — **sin herramientas de proyecto** — y un system prompt que exige **salida estructurada** `{ operación, ajustePlan?, motivo }` (mapea `Decision-Model.md §2/§4`). `P-01` se garantiza por **ausencia** de herramientas en su sesión, reforzada en código, no por disciplina del prompt.

### 4. Persistencia del worker

Efímera (`SessionManager.inMemory`) por defecto: la trazabilidad de worker vive en el `log.jsonl` de AIES (`ADR-008`), no en pi. Si `RNF-11` exige replay fino de una sesión de worker, se permite **opcionalmente** `SessionManager.create(<project>)` (flag de replay); fuera del recorrido por defecto de v0.

### 5. Contexto / tokens

AIES **no** reimplementa gestión de contexto: delega el techo de contexto al `autoCompaction` nativo de pi. AIES-core **observa** `contextUsage` (vía `get_session_stats`: tokens usados, ventana, porcentaje) como una dimensión de límite más (`RNF-18`), y reacciona con el repertorio de `ADR-005` — nunca continuación silenciosa (`RNF-19`).

### 6. Conocimiento del proyecto al arranque

AIES no construye su propio cargador de conocimiento: usa `DefaultResourceLoader` de pi, que recorre `AGENTS.md` desde `cwd` hacia arriba. Así, la arquitectura/decisiones/convenciones que **ya viven en el repo** como docs se cargan al inicio de cada sesión — satisface `RNF-16`/`OBJ-06` sin código de persistencia aparte (ver `ADR-008` para qué persiste y dónde).

---

## Consecuencias

- La realización material del runtime queda fijada: AIES-core es el proceso dueño del bucle; pi es el motor embebido. Cierra la "ubicación física" dejada abierta por `ADR-001`.
- `P-01`/`REQ-F-03` se hacen valer **en código** (orquestador sin tools; workers con allowlist por capacidad), no en prompts.
- `RNF-07`/`RNF-08`/`RNF-17` quedan medibles por vuelta: cada worker y el orquestador emiten `usage`; `contextUsage` alimenta la observación de límites.
- **Sin `HostAdapter`** en v0 (`P-17`/ponytail): cambiar de host exige refactor del módulo de binding. Trade-off deliberado: extraer la interfaz **al aparecer un 2.º host**, no antes.
- Documentos afectados, actualizados en consecuencia: `ADR-001` (fuera del alcance resuelto), `System-Context.md §1`/`§4` (frontera física resuelta), `Component-Model.md §3`/`§5` (ubicación de relaciones resuelta), `Glossary.md §2` (entorno de ejecución concreto + nota resuelta).
- **Fuera del alcance de este ADR**: la abstracción `HostAdapter`/`HostAgent` (`P-17`, se extrae con el 2.º host); el catálogo concreto de capacidades y allowlists (`MVP-v0-Scope.md §1`); el mecanismo y ubicación de persistencia de estado (`ADR-008`); el criterio único-vs-rol del orquestador (`ADR-007`); la calibración de `thinkingLevel` del orquestador (medición, `06-research/`).

---

## Referencias

- `ADR-001-harness-runtime-entorno-ejecucion.md` — entorno de ejecución externo e intercambiable; "fuera del alcance: ubicación física".
- `01-Concept/Non-Goals.md §11, §5, §13` — host intercambiable y no parte de la identidad; no añadir complejidad artificial; qué proporciona AIES.
- `Principles.md P-01, P-13, P-15, P-17, P-20` — orquestador no ejecuta; resultados alimentan la decisión; modelo como recurso; crecimiento; control.
- `Runtime-Model.md §2, §4` — el ciclo; catálogo de operaciones (AIES-core las decide, pi ejecuta las delegables).
- `Capability-Model.md §6` — proporcionar una capacidad (el contrato que el worker de pi materializa).
- `Agent-Model.md §7` — límites conceptuales del trabajador (materializados como allowlist de tools).
- `Non-Functional-Requirements.md RNF-05, RNF-07, RNF-14, RNF-17, RNF-18, RNF-19` — autonomía limitada; medida de contexto; sustituibilidad de modelo; coste; límites; no continuación silenciosa.
- pi docs latest (2026-08-14) — `createAgentSession`, `SessionManager.inMemory`/`create`, `noTools`, `setModel`, `subscribe`, `abort`, `usage`, `get_session_stats`, `autoCompaction`, `DefaultResourceLoader`.