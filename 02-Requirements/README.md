# AIES — 02-Requirements

Índice de los cinco documentos de esta fase. Los requisitos se derivan de `01-Concept/` y son trazables a objetivos (`OBJ-xx`), principios (`P-xx`) y, cuando corresponde, problemas (`Problem.md §x`). Este README solo organiza la lectura y el paso a las fases posteriores.

## Documentos, en orden

1. **`README.md`** — Mapa de la fase, dependencias, trazabilidad y cuestiones pendientes.
2. **`Glossary.md`** — Vocabulario del dominio de AIES y grado de fijación de cada término ([Hecho] / [Abierto] / [Propuesta]). No quedan cuestiones abiertas de vocabulario de las identificadas inicialmente.
3. **`Functional-Requirements.md`** — Capacidades y restricciones observables de AIES: `REQ-F-01`…`REQ-F-27`, agrupados por objetivo. No define cómo se implementan.
4. **`Task-Model.md`** — Modelo conceptual aprobado de `Task` y `Work Unit`: información mínima, relación, criterios de finalización y estados conceptuales. No define almacenamiento, comunicación ni la ejecución concreta.
5. **`Non-Functional-Requirements.md`** — Propiedades de calidad y dimensiones que deben poder observarse y medirse: `RNF-01`…`RNF-20`, criterios de medición e hipótesis `H-01`…`H-06`. No fija umbrales ni metodología.

El `Task-Model.md` se lee después de los requisitos funcionales porque concreta la unidad de trabajo de `REQ-F-12` y `REQ-F-13`, y antes de los requisitos no funcionales porque estos usan la condición de finalización y el resultado de la tarea.

## Cadena de trazabilidad

```text
01-Concept/
  Vision.md, Problem.md, Goals.md (OBJ-xx), Principles.md (P-xx), Non-Goals.md
    → 02-Requirements/Glossary.md (vocabulario)
        → 02-Requirements/Functional-Requirements.md (REQ-F-xx)
        → 02-Requirements/Task-Model.md (Task / Work Unit)
        → 02-Requirements/Non-Functional-Requirements.md (RNF-xx, H-xx)
            → 03-Architecture/System-Context.md, Component-Model.md,
              Runtime-Model.md, Capability-Model.md, Agent-Model.md,
              Decision-Model.md, MVP-v0-Scope.md
                → 04-Behavior/Lifecycle.md
                    ↔ 05-Decisions/ADR-001…ADR-009
                        → implementación (v0 sobre pi)
                            → 06-research/ (validación y medición: criterios, RNF-xx, H-xx)
```

La arquitectura y el comportamiento pueden generar decisiones explícitas en `05-Decisions/`; una ADR no sustituye al requisito que motiva la decisión. La medición/investigación tiene ahora su carpeta, `06-research/`, scaffolding para experimentos, baselines y métricas (no fija umbrales). `MVP-v0-Scope.md` sintetiza `ADR-007/008/009` en una referencia *implementation-ready* del runtime v0.

## Alcances resueltos

| Alcance | Referencia | Resolución |
|---|---|---|
| Relación `harness` / `runtime` y papel del entorno de ejecución concreto | `Glossary.md §2` | `05-Decisions/ADR-001-harness-runtime-entorno-ejecucion.md` |
| Rol de la capacidad de verificación | `Task-Model.md §4` | `05-Decisions/ADR-002-rol-de-verificacion.md` |
| Límites conceptuales de una sesión y su relación con una tarea | `Glossary.md §4` | `05-Decisions/ADR-003-limites-de-sesion.md` |
| Modelo conceptual de `Task` y `Work Unit` | `Glossary.md §4`, `Functional-Requirements.md §2 y §4` | `Task-Model.md` aprobado |
| Criterios para evaluar la complejidad, el alcance, la incertidumbre y el riesgo de una tarea | `Functional-Requirements.md §4` | `05-Decisions/ADR-004-criterios-de-decision.md` |
| Criterios para seleccionar capacidades, agentes y modelos | `Functional-Requirements.md §4` | `05-Decisions/ADR-004-criterios-de-decision.md` |
| Límite de iteraciones, política al alcanzar límites y criterio de tarea irrecuperable | `Lifecycle.md §7`, `Non-Functional-Requirements.md §6` | `05-Decisions/ADR-005-limites-e-irrecuperabilidad.md` |
| Reglas y señales para re-descomponer una `Work Unit` durante la ejecución | `Task-Model.md §7`, `Lifecycle.md §4` | `05-Decisions/ADR-006-re-descomposicion.md` |
| Orquestador: ¿agente único o rol intercambiable? | `Component-Model.md §5`, `Agent-Model.md §10` | `05-Decisions/ADR-007-orquestador-unico-o-rol.md` |
| Mecanismo para conservar y recuperar estado o conocimiento entre sesiones | `Functional-Requirements.md §2`, `ADR-003 §Fuera del alcance` | `05-Decisions/ADR-008-persistencia-entre-sesiones.md` |
| Integración con el host y ubicación física del harness en el host concreto | `System-Context.md §4`, `ADR-001 §Fuera del alcance` | `05-Decisions/ADR-009-integracion-con-pi.md` |
| Alcance MVP-v0 *implementation-ready* (síntesis spec → implementación) | `ADR-007`, `ADR-008`, `ADR-009` | `03-Architecture/MVP-v0-Scope.md` |
| Scaffolding de medición y validación (experimentos, baselines, métricas) | `Non-Functional-Requirements.md §3, §4, §6` | `06-research/README.md` |

## Cuestiones abiertas pendientes

| Cuestión | Documento de referencia | Destino pendiente |
|---|---|---|
| Catálogo formal de capacidades | `Functional-Requirements.md §4`, `Capability-Model.md §9-10` | cuando exista necesidad demostrada (`P-17`)
| Condiciones concretas de verificación por tipo de resultado y tarea | `Task-Model.md §7` | `04-Behavior/` y ADR si fija una política |
| Granularidad óptima de las unidades | `Task-Model.md §7` | `06-research/` |
| Validación de las hipótesis `H-01`…`H-06` | `Non-Functional-Requirements.md §4` | `06-research/` |
| Umbrales, presupuestos, metodología, baselines y cobertura del coste | `Non-Functional-Requirements.md §6` | `06-research/`; ADR para políticas y valores operativos |
| Priorización cuando entren en conflicto velocidad, calidad, coste y seguridad | `Non-Functional-Requirements.md §6` | ADR |
