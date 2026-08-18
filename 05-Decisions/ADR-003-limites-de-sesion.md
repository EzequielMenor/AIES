# ADR-003 — Límites de sesión

- **Estado:** Aceptada
- **Fecha:** 2026-08-13
- **Resuelve:** qué es una sesión, cuándo empieza y termina, y cómo se relaciona con una tarea

---

## Contexto

`01-Concept/` exige continuidad entre sesiones (`Problem.md §5`, `OBJ-06`, `P-08`), pero no define qué delimita una sesión ni si coincide con una tarea o con el entorno de ejecución.

La definición debe mantener separadas tres cosas:

- el periodo de trabajo del desarrollador con AIES;
- la tarea que AIES está resolviendo;
- el entorno de ejecución concreto (`ADR-001`).

Esta ADR no decide cómo se persiste, recupera o selecciona el conocimiento entre sesiones.

---

## Opciones consideradas

### Opción A — Una sesión equivale a una tarea

Cada sesión comienza y termina con una única tarea.

Se rechaza porque acopla dos conceptos distintos, impone una frontera innecesaria y dificulta continuar una tarea que no haya terminado durante el periodo de trabajo actual (`P-05`, `P-06`).

### Opción B — Una sesión es un periodo de trabajo con AIES

Una sesión delimita un periodo de trabajo del desarrollador con AIES para un proyecto. Puede contener varias tareas. Una tarea puede terminar dentro de una sesión o continuar en una sesión posterior.

Ventajas:

- separa la frontera temporal de la unidad de trabajo;
- permite que una sesión pequeña contenga una tarea pequeña y que una tarea compleja continúe posteriormente;
- es coherente con la continuidad entre sesiones (`OBJ-06`).

### Opción C — Una sesión equivale a la vida del entorno de ejecución

La sesión comienza al iniciar el host concreto y termina al detenerlo.

Se rechaza porque acopla un concepto de AIES a la implementación del entorno externo y contradice la separación fijada en `ADR-001`.

---

## Decisión

**Opción B.** Una sesión es un **periodo delimitado de trabajo del desarrollador con AIES para un proyecto**.

### Inicio

Una sesión comienza cuando el desarrollador inicia un nuevo periodo de trabajo con AIES para ese proyecto.

El inicio puede incluir la continuación de tareas pendientes de periodos anteriores, pero no convierte esas tareas en tareas nuevas.

### Final

Una sesión termina cuando:

- el desarrollador cierra el periodo de trabajo; o
- el periodo de trabajo se interrumpe o termina y no continúa bajo la misma sesión.

Una continuación posterior constituye una nueva sesión.

### Relación con las tareas

- Una sesión puede contener ninguna, una o varias tareas.
- Una tarea puede completarse o fallar dentro de una sola sesión.
- Una tarea incompleta puede continuar en una sesión posterior.
- El final de una sesión **no** implica que la tarea pase a `Completada` ni a `Fallida`.
- Al comenzar una nueva sesión, una tarea pendiente debe ser evaluada antes de continuar mediante el bucle de decisión (`Lifecycle.md`).

La sesión es una frontera temporal y de trabajo; la tarea mantiene su propia identidad y ciclo de vida.

---

## Consecuencias

- Sesión y tarea son conceptos distintos: una sesión agrupa trabajo realizado durante un periodo; una tarea representa trabajo que debe resolverse.
- Una interrupción de sesión no se interpreta automáticamente como un fallo de tarea.
- La continuidad de una tarea entre sesiones requiere que el estado relevante pueda estar disponible posteriormente, pero esta ADR no decide el mecanismo para conseguirlo.
- El entorno de ejecución concreto puede terminar o reiniciarse sin que eso defina por sí mismo la semántica de una sesión; la sesión se delimita según el periodo de trabajo de AIES y del desarrollador.

---

## Fuera del alcance

Esta ADR no decide:

- ~~el sistema de memoria o persistencia~~ → **resuelto en `ADR-008`** (`state.json` + `log.jsonl` bajo `agentDir` de pi, keyed-by-cwd);
- ~~qué información se conserva entre sesiones~~ → **resuelto en `ADR-008`** (estado del runtime fuera del repo; conocimiento del proyecto como docs del repo leídas al arranque);
- ~~cómo se recupera una tarea pendiente~~ → **resuelto en `ADR-008`** (restauración de `state.json` + reentrada al bucle desde el "siguiente paso", `Lifecycle.md §3`);
- la representación de una sesión;
- límites de concurrencia entre tareas o sesiones.

---

## Referencias

- `Problem.md §5`.
- `Goals.md OBJ-06`.
- `Principles.md P-08, P-09, P-17`.
- `Glossary.md §4`.
- `Lifecycle.md §3, §5`.
- `ADR-001-harness-runtime-entorno-ejecucion.md`.
