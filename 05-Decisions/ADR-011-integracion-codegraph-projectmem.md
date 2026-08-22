# ADR-011 — Integración de codegraph + projectmem como herramientas externas del harness

- **Estado:** Aceptada
- **Fecha:** 2026-08-22
- **Resuelve:** Forma concreta de servir `OBJ-06` y `REQ-F-19`/`REQ-F-20` (continuidad entre sesiones, recuperación de conocimiento sin reconstruir) y de aliviar el problema motivador nº 1 de `Problem.md` (sobrecarga de contexto). No introduce requisitos nuevos: cierra *cómo* AIES recupera conocimiento operativo que ya tiene delante, sin convertirse en un sistema de memoria.

---

## Contexto

`ADR-008` fija dos tiers de persistencia AIES:

1. Estado del runtime AIES (`state.json` + `log.jsonl`), bajo `.aies/`.
2. Conocimiento del proyecto, **que ya vive en el repo** como docs (`AGENTS.md`, ADRs, openwiki) y se carga vía `DefaultResourceLoader` de pi (`ADR-009 §6`).

Ese diseño satisface `RNF-16` para conocimiento canónico curado, pero deja dos necesidades operativas sin cubrir:

- **Exploración estructural repetitiva.** Cada sesión de explorer re-pasa por `grep`/`find`/`read` sobre el código para descubrir símbolos y call paths. Coste de tokens y latencia crecientes al crecer el repo (problema nº 1 de `Problem.md`).
- **Conocimiento operativo de proceso.** Decisiones menores, gotchas entre sesiones, lecciones "no hardcodear X en Y" — no son docs del repo (no merece ADR) pero se olvidan entre sesiones (problema nº 4 de `Problem.md`). AIES las descubre en cada vuelta y las pierde al cerrar.

La solución no debe contradecir `Non-Goals §7` (AIES no es un sistema de memoria), `§10` (usa VCS, no lo reemplaza) ni `ADR-008 §3` (conocimiento durable vive en docs del repo, curados).

Restricciones de la frontera con pi:

- pi no soporta MCP (sólo `customTools?: ToolDefinition[]` en `createAgentSession`, ADR-009 §2).
- Worker sessions usan `noExtensions: true` + `DefaultResourceLoader` (`session-factory.ts:99`) — `customTools` es la única vía para añadir tools a un worker.
- El bucle (`core/loop.ts`) es 100% puro (P-02): toda integración nueva vive fuera de él.

---

## Opciones consideradas

### Opción A — Sólo bash (workers shell-outean a `codegraph`/`pjm` directamente)

Inyecciones cero. Implementer/verifier conservan bash y pueden invocar los CLIs.

Inconvenientes: rompe `P-10`/`REQ-F-18` (Explorer read-only): o se le da bash (y deja de ser read-only), o no tiene acceso a `codegraph` (lo que más lo alivia). El briefing al orquestador no tiene mecanismo (P-09: estado serializado). Y fuerza a los workers a conocer la sintaxis exacta de cada CLI en cada turno → más tokens, más fragilidad.

### Opción B — `customTools` AIES-side con TypeBox + execute (decidida)

Tres tools AIES-side registradas en `customTools` de `createAgentSession`:

| Tool       | Función                                                                                 | Allowlist (capabilities)              |
| ---------- | --------------------------------------------------------------------------------------- | ------------------------------------- |
| `code_explore` | shell-out `codegraph explore <query>` en `cwd`; contexto estructural en una llamada  | explorer, implementer, verifier       |
| `mem_read`     | lectura directa de `.projectmem/summary.md` (determinista, sin runtime dep)         | explorer, implementer, verifier       |
| `mem_log`      | shell-out a `pjm log\|attempt\|fix\|decision\|note` con shape validado             | **implementer** (escritura)            |

Disponibilidad:

- CLI ausente → tool no registrada o devuelve mensaje claro "no instalado: ejecutar `…`". Nada crashea (mismo patrón que la degradación sin API key).
- `.codegraph/` ausente pero CLI presente → `ensureCodegraphIndex(cwd)` ejecuta `codegraph init` una vez (idempotente, aviso al desarrollador).
- `.projectmem/` ausente → las tools de memoria responden "memoria no inicializada"; el orquestador puede sugerir `pjm init`. **No** se auto-inicializa: instalaría git hooks + watcher en el repo del usuario, contraviniendo `Non-Goals §6` (control del desarrollador) y `§10`.

El briefing al orquestador se inyecta al estado (`addKnownInfo`) en la capa CLI al recibir la tarea — no en `decide.ts`, porque `P-09` exige estado serializado como única entrada y `P-01` prohíbe tools en el orquestador. Truncado si excede ~4k chars.

Los prompts de workers se componen dinámicamente en `session-factory.ts`, añadiendo 1-2 líneas sólo cuando la tool está activa.

Ventajas: respeta la frontera ADR-009 (todo el código pi-specific vive en session-factory + 2 módulos nuevos); respeta P-10/REQ-F-18 (Explorer no gana bash ni escritura); cero acoplamiento profundo a las herramientas externas (sólo CLI + ficheros planos — si `codegraph` o `pjm` desaparecen, las tools degradan a "no disponible").

Inconvenientes: dependencia ligera de dos CLIs externos. Mitigación: ambas son 100% locales; instalación tolerante; degradación limpia.

### Opción C — Servicios externos de memoria (mem0, etc.)

Descartada: mem0 está orientado a apps en producción (LLM + embeddings + vector DB, cloud-first). `ADR-008 Opción C` fue explícitamente rechazada por contradecir `Non-Goals §7`. Reaparece aquí con el mismo argumento.

---

## Decisión

**Opción B.** AIES integra `codegraph` y `projectmem` como herramientas externas vía `customTools` de pi, con detección tolerante, auto-init opcional de codegraph (no de projectmem), y degradación limpia.

### 1. Fronteras

- Nuevo módulo `runtime/src/integrations/` (dominio AIES, **no** importa pi). Exporta: `detect(cwd)`, `ensureCodegraphIndex(cwd)`, `readMemoryBriefing(cwd)`, `buildCustomTools(availability)`, `runStartup(cwd) → StartupReport`.
- `workers/capabilities.ts` añade los nombres de tools nuevas a las allowlists (`code_explore`, `mem_read` en las tres; `mem_log` sólo en `implementer`).
- `workers/session-factory.ts` invoca `buildCustomTools` y pasa `customTools` a `createAgentSession`. Compone dinámicamente los prompts (`CAPABILITY_PROMPT` con anexo opcional).
- Briefing al estado: `cli.ts::runCycle` y `cli.ts::runResumeCycle` llaman a `runStartup` antes de entrar al bucle y añaden el resultado como `knownInfo` antes de la primera decisión.
- `install.sh`: tras instalar aies, instala `codegraph` (npm) y `projectmem` (uv → pipx → pip). Cada paso tolerante.

### 2. Qué NO cambia

- `ADR-008`: estado AIES sigue en `.aies/`; conocimiento canónico sigue en docs del repo. La memoria operativa (projectmem) es **un espejo adicional** de bajo coste para gotchas/lecciones, no un sustituto de los docs curados.
- `ADR-009`: la frontera con pi sigue siendo `session-factory.ts` (workers) + `decide.ts` (orquestador) + `parse.ts` (mapping). Las tools nuevas son AIES-side.
- `Non-Goals §7`: AIES no es un sistema de memoria; integra herramientas externas igual que usa Git (`§10`).
- Bucle (`core/loop.ts`) puro: no se toca.

### 3. Degradación

| Estado                                  | Comportamiento                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------- |
| codegraph CLI ausente                   | `code_explore` no registrada                                                    |
| codegraph CLI presente, sin `.codegraph/` | una vez por `cwd`: `ensureCodegraphIndex` ejecuta `codegraph init`, avisa    |
| codegraph CLI presente, `.codegraph/` ok | `code_explore` registrada                                                       |
| projectmem CLI ausente                  | `mem_read`/`mem_log` no registradas                                             |
| projectmem CLI presente, sin `.projectmem/` | tools registradas; responden "memoria no inicializada, ejecutar `pjm init`"   |
| Ambas presentes                         | tools registradas normalmente                                                  |

### 4. Briefing al estado (orquestador)

Al recibir tarea (oneshot nueva, REPL nueva, `/resume`):

- Si hay `.projectmem/summary.md`, se trunca a 4k chars con nota y se añade a `knownInfo` como `MEMORIA DEL PROYECTO (resumen): …`.
- Se añade una línea breve de disponibilidad: `HERRAMIENTAS: codegraph=ok|init|autoskip, projectmem=ok|uninit|missing`.

Esto entra al estado en `runCycle` (antes del `runLoop`) — no en `decide.ts` — preservando P-09 y P-01.

---

## Consecuencias

- `OBJ-06`, `REQ-F-19`/`REQ-F-20` se sirven también con conocimiento **operativo** (no sólo canónico), sin duplicar la fuente de verdad.
- Exploración estructural: una llamada `code_explore` reemplaza N `grep`/`find`/`read` — alivia el problema nº 1 de `Problem.md`.
- Memoria operativa: implementer registra decisiones/lecciones/gotchas con `mem_log`; el explorer y el implementer los leen con `mem_read` al inicio de cada unidad → cierre del problema nº 4.
- Trade-off: dependencia opcional de dos CLIs externos locales. Mitigación: instalación tolerante + degradación limpia + tests E2E con/sin herramientas.
- Trade-off deliberado: projectmem **no** se auto-inicializa (instalaría hooks en repo ajeno). El orquestador puede sugerir `pjm init` al desarrollador vía una unidad de tipo `comunicar al desarrollador`.
- Documentos afectados: este ADR. NO se tocan openwiki, requisitos ni modelos de arquitectura — el cambio es de *cómo* se materializa lo ya especificado, no de *qué*.
- **Fuera del alcance de este ADR**: escritura automática de memoria por el bucle o el orquestador (P-01: el orquestador no tiene tools; automatización futura); flags de configuración para desactivar integraciones (YAGNI: la degradación ya cubre ausencia); formato de exportación/importación de memoria entre máquinas (futuro, no requerido); reevaluación de mem0/graphify (descartadas con razón documentada).

---

## Referencias

- `Goals.md OBJ-06` — continuidad entre sesiones.
- `Functional-Requirements.md REQ-F-19, REQ-F-20` — recuperar conocimiento esencial; persistencia selectiva.
- `Non-Functional-Requirements.md RNF-05, RNF-16` — autonomía limitada del worker; recuperación de bajo coste.
- `Principles.md P-01, P-02, P-08, P-09, P-10` — orquestador decide; bucle puro; selectividad; estado como entrada; read-only del explorer.
- `01-Concept/Non-Goals.md §6, §7, §10` — control del desarrollador; AIES no es sistema de memoria; usa VCS.
- `ADR-008-persistencia-entre-sesiones.md` — tiers de persistencia; conocimiento del proyecto en docs curados del repo.
- `ADR-009-integracion-con-pi.md` — `customTools` como vía para añadir tools a workers; `DefaultResourceLoader` para docs del repo.
- `Problem.md` — problemas motivadores nº 1 (sobrecarga de exploración) y nº 4 (continuidad operativa).
- codegraph: `https://github.com/ColbyMcHenry/codegraph` (CLI local, telemetría off por defecto).
- projectmem: `https://github.com/lessresting/projectmem` (CLI local, sin red).
