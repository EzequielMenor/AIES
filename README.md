# AIES

> **Harness para desarrollo asistido por agentes de IA.** No es un agente, no es un workflow fijo, no es una herramienta más — es el **runtime que organiza el trabajo** entre agentes especializados para que cada tarea reciba el mínimo proceso necesario y el desarrollador mantenga el control.

[![Spec](https://img.shields.io/badge/spec-6_fases-blueviolet)](#-estructura-de-la-spec)
[![Runtime](https://img.shields.io/badge/runtime-v0-green)](#-runtime-v0)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License](https://img.shields.io/badge/license-propietario-lightgrey)](#-licencia)

---

## Tabla de contenidos

- [¿Qué es AIES?](#-qué-es-aies)
- [¿Qué problema resuelve?](#-qué-problema-resuelve)
- [Filosofía en una línea](#-filosofía-en-una-línea)
- [Arquitectura conceptual](#-arquitectura-conceptual)
- [Estructura de la spec](#-estructura-de-la-spec)
- [Runtime v0](#-runtime-v0)
- [Quick start](#-quick-start)
- [Cómo se usa](#-cómo-se-usa)
- [Configuración](#-configuración)
- [ADRs (decisiones arquitectónicas)](#-adrs-decisiones-arquitectónicas)
- [Investigación y métricas](#-investigación-y-métricas)
- [Lo que AIES NO es](#-lo-que-aies-no-es)
- [Estado del proyecto](#-estado-del-proyecto)
- [Convenciones de contribución](#-convenciones-de-contribución)
- [Licencia](#-licencia)

---

## ¿Qué es AIES?

**AIES** (AI Engineering System) es un **harness** — un runtime y un conjunto de principios — para organizar el trabajo de agentes de IA durante tareas de desarrollo de software.

Su idea central es directa:

> **AIES organiza el trabajo; los agentes realizan el trabajo.**

AIES no compite con tu modelo, no sustituye a tu agente ni te obliga a usar un workflow rígido. AIES es la **capa de coordinación** que:

- divide una tarea grande en unidades pequeñas y verificables,
- elige la capacidad necesaria en cada paso,
- aísla el contexto de cada agente (sólo recibe lo que necesita),
- adapta el proceso a la complejidad real del trabajo,
- mantiene al desarrollador informado sin obligarle a supervisar cada acción,
- conserva entre sesiones el conocimiento importante del proyecto.

Es, en la práctica, **un orquestador con contexto limpio** que delega a **trabajadores especializados** (Explorer, Implementer, Verifier) y aprende del resultado de cada paso antes de decidir el siguiente.

---

## ¿Qué problema resuelve?

Cuando un único agente hace todo —investigar, razonar, planificar, escribir, ejecutar, verificar—, aparecen fricciones que AIES ataca directamente:

| Problema | Qué hace AIES al respecto |
|---|---|
| **Sobrecarga de contexto** | Cada agente recibe sólo el contexto intencional que necesita para su unidad. El orquestador no acumula el proyecto entero. |
| **Proceso desproporcionado** | No hay workflow fijo. Una tarea trivial puede ir directa a implementar + verificar; una compleja pasa por explorar → planificar → revisar → implementar → verificar. |
| **Pérdida de visibilidad** | Cada decisión (operación, motivo, condición, ajuste de plan) queda registrada y es inspeccionable. |
| **Memoria frágil entre sesiones** | `state.json` + `log.jsonl` persistentes + `AGENTS.md` cargado al arranque. Una sesión nueva reentra al bucle sin reiniciar. |
| **Capacidades desiguales de modelos** | Modelos más capaces para razonar/planificar, modelos más rápidos y baratos para trabajo mecánico. Configurable. |
| **Tareas grandes e incontrolables** | Re-descomposición explícita cuando una unidad resulta más compleja de lo previsto; nunca se acumula trabajo sin control. |

Detalle completo en [`01-Concept/Problem.md`](01-Concept/Problem.md).

---

## Filosofía en una línea

> **Coordinar, no hacer. Dividir el trabajo, no acumularlo. Mínimo proceso necesario. Contexto bajo control. Delegar sin perder visibilidad.**

Esta idea se concreta en 20 principios arquitectónicos documentados en [`01-Concept/Principles.md`](01-Concept/Principles.md), entre los que destacan:

- **P-01** — *El orquestador no realiza el trabajo.* Coordina; los subagentes ejecutan.
- **P-04** — *El trabajo debe dividirse en tareas pequeñas* con objetivo, alcance y criterio de finalización.
- **P-06** — *El mínimo proceso necesario.* Más pasos no significan mejor resultado.
- **P-07** — *El contexto debe estar aislado y ser intencional.* Nunca "todo lo ocurrido anteriormente".
- **P-13** — *Los fallos conducen a nuevas decisiones.* Un fallo no implica reiniciar; el runtime observa y decide.
- **P-15** — *El modelo depende del trabajo.* No hay un modelo óptimo universal.
- **P-19** — *Evidencia frente a intuición.* Las decisiones se validan con experimentos.
- **P-20** — *El desarrollador mantiene el control.* Automatizar no es perder el control.

---

## Arquitectura conceptual

```text
                        Desarrollador
                              │
                              ▼
                       ┌──────────────┐
                       │ Orquestador  │   ← decide, delega, comunica
                       │  (noTools)   │   ← no lee ni escribe el proyecto
                       └──────┬───────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
       ┌─────────�      ┌────────────┐    ┌──────────┐
       │ Explorer │     │ Implementer│    │ Verifier │
       │ (read)   │     │  (r/w/!e)  │    │ (r/!w)   │
       └─────────┘      └────────────┘    └──────────┘
        información      cambios          pass/fail
                                          + evidencia
```

**Capacidades v0** (MVP, [`03-Architecture/MVP-v0-Scope.md`](03-Architecture/MVP-v0-Scope.md)):

| Capacidad | Rol | Tools permitidas |
|---|---|---|
| **Orquestador** | Decidir qué hacer, delegar, comunicar | **Ninguna** (`noTools: "all"` — por ausencia, `P-01`) |
| **Explorer** | Obtener información | `read`, `grep`, `find`, `ls` |
| **Implementer** | Ejecutar cambios | `read`, `edit`, `write`, `bash`, `grep`, `find` |
| **Verifier** | Verificar resultados | `read`, `bash`, `grep`, `find`, `ls` — **sin** `edit`/`write` |

El **bucle de decisión** es:

```text
estado  →  decisión  →  operación  →  resultado  →  estado  →  …
```

El orquestador observa el estado, emite una decisión JSON validada (Zod = trust boundary), delega una unidad al trabajador correspondiente, observa el resultado y vuelve a decidir. Un fallo no es un crash: es un resultado más que alimenta la siguiente decisión.

---

## Estructura de la spec

La especificación sigue un modelo por fases, cada una con propósito claro y trazabilidad hacia las demás:

```text
01-Concept/        ← problema, visión, objetivos, principios, fuera-de-alcance
02-Requirements/   ← requisitos funcionales, no funcionales, glosario, modelo de tarea
03-Architecture/   ← modelos: agente, capacidad, componente, decisión, runtime, sistema
04-Behavior/       ← ciclo de vida observable
05-Decisions/      ← ADRs (Architecture Decision Records)
06-research/       ← hipótesis, baselines, experimentos, métricas NFR
```

Más dos directorios operativos:

- **`runtime/`** — paquete TypeScript/Node con el runtime v0 (`@aies/core`).
- **`openwiki/`** — extractos navegables de la spec en español (quickstart, arquitectura, runtime, convenciones, research).

La spec es **canónica**; el wiki resume y apunta a los documentos originales.

---

## Runtime v0

El runtime v0 es el paquete `runtime/` (TypeScript estricto, ESM, Node ≥20). Implementa la spec sobre **[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** (`@earendil-works/pi-coding-agent@~0.84`), que actúa como motor de workers y `ModelRuntime` multi-provider. AIES-core es el dueño del bucle; pi es el motor (`ADR-009`).

### Capacidades implementadas

| Módulo | Responsabilidad |
|---|---|
| `src/core/` | Bucle de decisión, `RuntimeState`, tipos de log |
| `src/orchestrator/` | Sesión orquestador con `noTools:"all"` y parser Zod robusto |
| `src/workers/` | Explorer / Implementer / Verifier con allowlists exactas |
| `src/pi-binding/` | Fachada `Host` sobre pi (única zona que importa el SDK) |
| `src/persistence/` | `state.json` + `log.jsonl` keyed-by-cwd + `recover` |
| `src/intervention.ts` | SIGINT y repertorio de intervención al alcanzar límites |
| `src/limits.ts` | Límites (iteraciones, coste, contexto observado) |
| `src/observability.ts` | Eventos de compactación, telemetría, métricas |
| `src/research/` | Métricas NFR §3, mapa de hipótesis H-01…H-06 |
| `src/cli.ts` | `aies run "<tarea>"`, `aies resume`, `aies --help` |

### Garantías de diseño

- **Trust boundary** — la decisión JSON del orquestador se valida con Zod. Sin validación, no hay ejecución.
- **Backstop sin telemetría** — `tokens:null` en `contextUsage` es un estado real (post-compactación). AIES lo trata como `telemetry_unavailable` + warning y **nunca asume no-overflow**; el tope de iteraciones es el último recurso (`RNF-19`).
- **Recuperación ante corrupción** — `state.json` corrupto → sesión limpia, log conservado. Tarea `En curso` se reentra al bucle, no se reinicia (`P-13`).
- **Auth degrada con gracia** — sin API key, 3 auth-fails → intervención, no crash.
- **Verificador no edita** — si verificar requiere modificar, eso es otra unidad que vuelve al bucle.
- **Compactación observable** — eventos `compaction_start/end` de pi se registran en `log.jsonl` con razón, `tokensBefore`/`estimatedTokensAfter`, `willRetry`. AIES observa el techo, no lo reimplementa.

---

## Quick start

```bash
# 1. Instalar dependencias del runtime
cd runtime
npm install

# 2. Verificar types y compilar
npm run typecheck
npm run build

# 3. Probar el harness sin modelo (loop, persistencia, parser, compactación)
npm test

# 4. Verificar la integración real con pi (sin clave degrada con gracia)
npm run spike

# 5. Ejecutar contra un modelo (requiere API key)
export ANTHROPIC_API_KEY=sk-ant-...
npm run smoke   # aies run sobre fixtures/smoke-repo
```

El smoke ejecuta la traza completa: **determinar el proceso → explorar → implementar → verificar → Completada**. El log resultante vive en `~/.pi/agent/aies/<hash(cwd)>/log.jsonl`.

---

## Cómo se usa

```bash
# Ejecutar una tarea nueva
aies run --cwd /ruta/al/proyecto "añade una función greet() que devuelva 'hello'"

# Reanudar una tarea En curso (o tras corrupción → sesión limpia)
aies resume --cwd /ruta/al/proyecto

# Métricas NFR §3 de una ejecución (mapeadas a hipótesis H-01…H-06)
npm run research:metrics -- ~/.pi/agent/aies/<hash(cwd)>/log.jsonl

# Ayuda
aies --help
```

Durante la ejecución puedes **intervenir** (`Ctrl+C` → repertorio de `ADR-005`). Por defecto el sistema pide intervención al alcanzar un límite; nunca continúa silenciosamente.

---

## Configuración

`runtime/aies.config.json` — versionado, **sin claves**:

```json
{
  "provider": "anthropic",
  "models": {
    "orchestrator": "claude-sonnet-4-5",
    "explorer":      "claude-haiku-4-5",
    "implementer":   "claude-sonnet-4-5",
    "verifier":      "claude-haiku-4-5"
  },
  "orchestratorThinkingLevel": "low",
  "limits": { "maxIterations": 12 }
}
```

**Claves sólo por variable de entorno** — `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, … (las lee `ModelRuntime.create()`).

**Límites v0** (provisionalmente conservadores a propósito — `ADR-005`):

| Dimensión | Valor v0 |
|---|---|
| Iteraciones | máx **12** |
| Coste | **off** por defecto |
| Contexto/tokens | delegado a `autoCompaction` de pi; **observado** |
| Duración | sin tope duro |

Cuando se alcance un límite, AIES pregunta al desarrollador. La medición en `06-research/` decidirá cuándo activar el límite de coste.

---

## ADRs (decisiones arquitectónicas)

Nueve ADRs cerrados en `05-Decisions/`:

| # | Título | Resumen |
|---|---|---|
| [ADR-001](05-Decisions/ADR-001-harness-runtime-entorno-ejecucion.md) | Harness ≠ runtime ≠ entorno | Tres capas separadas; pi es entorno, AIES-core es runtime. |
| [ADR-002](05-Decisions/ADR-002-rol-de-verificacion.md) | Verificar es una capability | El Verifier es un agente separado, no una fase del Implementer. |
| [ADR-003](05-Decisions/ADR-003-limites-de-sesion.md) | Límites de sesión | Iter, coste, contexto, duración; backstop por intervención. |
| [ADR-004](05-Decisions/ADR-004-criterios-de-decision.md) | Selección por contrato | Una capacidad → un trabajador por defecto hasta necesidad demostrada. |
| [ADR-005](05-Decisions/ADR-005-limites-e-irrecuperabilidad.md) | Límites + irrecuperabilidad | Repertorio al alcanzar un límite; nunca continuación silenciosa. |
| [ADR-006](05-Decisions/ADR-006-re-descomposicion.md) | Re-descomposición | Una unidad puede re-descomponerse en el bucle si resulta mayor de lo esperado. |
| [ADR-007](05-Decisions/ADR-007-orquestador-unico-o-rol.md) | Un orquestador | Una sola sesión dueña del bucle; `noTools:"all"`. |
| [ADR-008](05-Decisions/ADR-008-persistencia-entre-sesiones.md) | Persistencia entre sesiones | `state.json` + `log.jsonl` keyed-by-cwd + `AGENTS.md` al arranque. |
| [ADR-009](05-Decisions/ADR-009-integracion-con-pi.md) | Integración con pi | SDK embebido; AIES-core dueño del bucle, pi motor de workers. |

---

## Investigación y métricas

`06-research/` es el andamio de validación. Las hipótesis **H-01…H-06** mapean a las dimensiones NFR §3 (contexto, coste, tiempo, calidad, errores, pasos). `npm run research:metrics -- <log.jsonl>` emite métricas por dimensión **sin afirmar las hipótesis** (`P-19` — evidencia frente a intuición).

Incluye:

- **baselines/** — ejecuciones de referencia (agente único, etc.).
- **experiments/** — baterías de pruebas.
- **pi-opencode-comparison.md** — comparación entre hosts.

---

## Lo que AIES NO es

AIES tiene un perímetro intencionalmente estrecho. Documentado formalmente en [`01-Concept/Non-Goals.md`](01-Concept/Non-Goals.md):

- ❌ **No es un agente** — es el harness que organiza a los agentes.
- ❌ **No es un modelo de IA** — los modelos son un recurso intercambiable.
- ❌ **No es un workflow fijo** — el proceso se adapta a la tarea.
- ❌ **No es un sistema SDD obligatorio** — puede usar specs y planes cuando aporten valor.
- ❌ **No usa múltiples agentes por deporte** — `más agentes ≠ mejor sistema`.
- ❌ **No intenta automatizarlo todo** — el desarrollador mantiene el control.
- ❌ **No es un sistema de memoria general** — la persistencia es selectiva y al servicio del trabajo.
- ❌ **No es documentación automática exhaustiva** — sólo lo necesario para entender decisiones y estado.
- ❌ **No es un sistema de gestión de proyectos** ni de **control de versiones**.
- ❌ **No depende del host concreto** — pi es la implementación v0; la arquitectura permite cambiarlo.
- ❌ **No pretende resolver AGI, alineamiento, evaluación universal de modelos**, etc.

> **Límite fundamental:** AIES organiza el trabajo; los agentes realizan el trabajo.

---

## Estado del proyecto

- ✅ **Spec 6 fases** cerrada y trazable (concept → requirements → architecture → behavior → decisions → research).
- ✅ **9 ADRs** cerrados.
- ✅ **Runtime v0** implementado y verificado con self-checks (`loop`, `persistence`, `orchestrator`, `compaction`, `workers`).
- ✅ **Gate con pi 0.84.2** ejercitado — superficies, allowlists, compactación, telemetría, `DefaultResourceLoader`.
- ✅ **CLI y smoke** cableados (`aies run`, `aies resume`).
- ✅ **Métricas NFR** + mapa de hipótesis sin afirmaciones (`P-19`).
- ⏳ **Telemetría en vivo** pendiente de API key de proveedor — la forma ya está verificada.
- ⏳ **Calibración** de `thinkingLevel`, `maxIterations`, modelos por capacidad — deferida a `06-research/`.

---

## Convenciones de contribución

- **Tareas acotadas.** Cambios de 1-3 archivos por commit; si es más grande, dividir.
- **Conventional commits** con scope por carpeta: `feat(checkout): …`, `fix(runtime): …`, `docs(adr): …`.
- **No `--no-verify` ni `--force` a `main`.**
- **No instalar dependencias sin pedir.**
- **No sincronizar nada a la nube** — `.engram/`, `.codegraph/`, memorias y artefactos privados se quedan locales.
- **No hardcodear secretos** — siempre variables de entorno.
- **No inventar APIs** — ante la duda, leer el código fuente o preguntar.
- **No refactorizar sin pedirlo** — cambios mínimos, alcances respetados.
- **Spec primero** — si la tarea cambia arquitectura, abrir ADR; si cambia objetivos, abrir issue en `01-Concept/`.
- **Evidencia frente a intuición** — las decisiones arquitectónicas se validan con `06-research/`.

---

## Mapa de lectura recomendado

Si entras al proyecto por primera vez, este orden evita que te pierdas:

1. [`01-Concept/Vision.md`](01-Concept/Vision.md) — qué es y qué no es.
2. [`01-Concept/Problem.md`](01-Concept/Problem.md) — los seis problemas que ataca.
3. [`01-Concept/Principles.md`](01-Concept/Principles.md) — los 20 principios.
4. [`03-Architecture/MVP-v0-Scope.md`](03-Architecture/MVP-v0-Scope.md) — el puente spec → código.
5. [`runtime/README.md`](runtime/README.md) — el runtime v0 en detalle.
6. [`05-Decisions/ADR-009-…`](05-Decisions/ADR-009-integracion-con-pi.md) — por qué pi.
7. [`openwiki/quickstart.md`](openwiki/quickstart.md) — vista resumida navegable.

---

## Licencia

Código propietario. Uso interno.
