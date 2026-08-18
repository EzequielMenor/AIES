# AIES — Modelo del runtime

Este documento define la **estructura conceptual del runtime**: qué estado mantiene, qué operaciones puede producir una decisión y cómo los resultados alimentan la siguiente decisión.

Deriva de `P-09`, `P-10`, `P-13`, `P-17`, `REQ-F-14`…`REQ-F-18`, `RNF-18`…`RNF-20` y de `ADR-001`, `ADR-002`, `ADR-003`. Usa el vocabulario de `Glossary.md`.

No define la máquina de estados de la tarea ni de la unidad de trabajo (eso pertenece a `04-Behavior/Lifecycle.md`), ni implementación, tecnologías, modelos, agentes concretos, prompts ni configuración.

---

## 1. Convenciones

- **[Hecho]** — Impuesto por `01-Concept/`, requisitos validados o ADRs.
- **[Propuesta]** — Modelo propuesto que requiere validación.
- **[Pendiente]** — Aspecto que requiere una decisión posterior (ADR) o un documento posterior.

---

## 2. Qué es el runtime

**[Hecho — ADR-001]** — Harness y runtime son el mismo sistema: AIES. *Harness* nombra la identidad y el diseño; *runtime*, el sistema **en operación**: ejecutando, observando resultados y tomando decisiones.

**[Propuesta]** — Estructuralmente, el runtime en operación es un ciclo con tres piezas:

```text
        ┌─────────────────────────────────────┐
        │                                     │
        ▼                                     │
   ┌─────────┐      ┌───────────┐      ┌────────────┐
   │ Estado  │ ───▶ │ Decisión  │ ───▶ │ Operación  │
   └─────────┘      └───────────┘      └────────────┘
        ▲                                     │
        │              ┌───────────┐          │
        └───────────── │ Resultado │ ◀────────┘
                       └───────────┘
```

- El **estado** es la entrada de cada decisión (`P-09`, `REQ-F-14`).
- La **decisión** la toma el orquestador, que coordina y no ejecuta (`P-01`, `P-02`).
- La **operación** es lo que la decisión pone en marcha; la ejecutan trabajadores, no el orquestador.
- El **resultado** de toda operación actualiza el estado y produce una nueva decisión (`P-13`, `REQ-F-17`).

Este documento define esas piezas. Las transiciones que provocan en la tarea y en las unidades están definidas en `Lifecycle.md` y no se repiten aquí.

---

## 3. Estado del runtime

### 3.1 Estado de una tarea (núcleo)

**[Hecho]** — El estado de una tarea es explícito y no depende de información implícita en una conversación (`P-09`, `REQ-F-14`, `RNF-12`).

**[Propuesta]** — Conceptualmente, el estado de una tarea contiene:

| Información | Significado | Fuente |
|---|---|---|
| **La tarea** | La `Task` que se está resolviendo, con su objetivo y condición de finalización | `Task-Model.md §1` |
| **Información conocida** | Lo que se sabe y es relevante para decidir; puede ampliarse durante la ejecución | `Task-Model.md §1`, `REQ-F-18` |
| **Unidades de trabajo** | Las `Work Units` existentes y su estado | `Task-Model.md §2, §5` |
| **Resultados** | Los resultados obtenidos de las operaciones realizadas | `P-13`, `REQ-F-17` |
| **Iteraciones** | Cuántas iteraciones del ciclo se han realizado | `P-09`, `Lifecycle.md §5` |
| **Siguiente paso** | Qué debe hacerse a continuación | `P-09` |

Con esto se cierra, a nivel conceptual, la cuestión del `Glossary.md §5` ("los campos concretos del estado se definirán en arquitectura"). La representación física del estado queda fuera de este documento.

### 3.2 Estado global del runtime

**[Propuesta]** — El estado del runtime es el **contenedor** de los estados de tarea existentes durante una sesión:

```text
Estado del runtime
   │
   ├── sesión activa (ADR-003)
   └── estados de tarea (0..n)
            │
            └── el ciclo opera sobre una tarea cada vez
```

Límites de este modelo:

- Una sesión puede contener varias tareas y una tarea puede continuar en una sesión posterior (`ADR-003`); por eso el estado del runtime puede contener varios estados de tarea.
- **El runtime no es un gestor de múltiples tareas**: este modelo no introduce planificación entre tareas, prioridades ni concurrencia. El ciclo de §2 opera sobre una tarea; la existencia de otras tareas pendientes no cambia la estructura del ciclo.

**[Pendiente]** — Concurrencia entre tareas o sesiones: fuera de alcance (quedó excluida de `ADR-003`); se decidirá solo si aparece necesidad (`P-17`).

---

## 4. Operaciones

**[Propuesta]** — Una decisión produce exactamente una de estas operaciones:

| Operación | Qué hace | Fuente |
|---|---|---|
| **Obtener información** | El estado no contiene información suficiente; se obtiene antes de ejecutar ningún cambio | `P-10`, `REQ-F-18` |
| **Ejecutar una unidad** | Se selecciona la capacidad necesaria y se delega una unidad de trabajo a un trabajador | `P-01`, `P-14`, `Lifecycle.md §2` |
| **Comunicar al desarrollador** | Se informa de progreso, decisiones relevantes o resultado | `OBJ-04`, `P-11`, `Component-Model.md R-2` |
| **Terminar** | Se declara la tarea **Completada** (condiciones cumplidas y verificadas) o **Fallida** (sin continuación viable o detenida) | `P-12`, `P-13`, `Task-Model.md §4` |

Reglas:

- **Verificar no es una operación propia.** La verificación es una capacidad que ejecuta un trabajador (`ADR-002`); desde el punto de vista del runtime, verificar es un caso de *ejecutar una unidad*. No existe una rama estructural de verificación en el ciclo.
- *Obtener información* y *ejecutar una unidad* son operaciones distintas aunque ambas se deleguen: la primera no modifica el proyecto, la segunda sí puede hacerlo (`P-10`).
- *Comunicar al desarrollador* no sustituye al término de la tarea: es una operación intermedia que devuelve el control al ciclo.
- El catálogo anterior es la **operación** que produce la decisión. La misma decisión puede además **ajustar el plan** —descomponer, re-descomponer, cambiar de estrategia— sin alterar este catálogo: esa faceta actúa sobre el estado, no sobre el proyecto, y se define en `Decision-Model.md §4.2`.

**[Hecho — ADR-004]** — Los criterios concretos para elegir operación, capacidad, agente y modelo se definen en `ADR-004-criterios-de-decision.md` (selección por contrato; sin umbrales numéricos).

---

## 5. Resultado como entrada

**[Hecho]** — Toda operación produce un resultado que se incorpora al estado y alimenta la siguiente decisión (`P-13`, `REQ-F-17`).

- Un resultado puede ser: información obtenida, una unidad terminada, un fallo, o una verificación insatisfactoria.
- Un fallo de unidad **no** implica fallo de tarea: es una entrada más del ciclo, que puede conducir a corregir, obtener información, re-delegar o re-descomponer (`REQ-F-16`, `Lifecycle.md §4`).
- Ningún resultado se pierde: los resultados intermedios son información para decidir, no ruido descartable (`P-13`).

---

## 6. Iteraciones y límites

**[Hecho]** — Cada pasada por el ciclo es una iteración, y su número forma parte del estado explícito (`P-09`).

**[Hecho]** — Toda ejecución está sujeta a límites de duración, iteraciones, coste y consumo de contexto (`RNF-18`), distintos según las características de la tarea (`RNF-20`).

**[Hecho]** — Alcanzar un límite es observable y nunca silencioso: el límite alcanzado se incorpora al estado como un resultado más, y produce o una nueva decisión o una terminación controlada (`RNF-19`).

**[Hecho — ADR-005]** — La política al alcanzar límites (terminar controladamente, pedir intervención, cambiar de estrategia, ampliación preautorizada) y el criterio de tarea irrecuperable se definen en `ADR-005-limites-e-irrecuperabilidad.md`. **[Pendiente]** — Los valores numéricos y perfiles por defecto quedan en medición (`NFR §6`).

---

## 7. Intervención del desarrollador

**[Hecho]** — El desarrollador puede intervenir, detener o restringir el trabajo en curso (`REQ-F-11`, `RNF-04`).

**[Propuesta]** — Estructuralmente, la intervención es una **entrada externa al ciclo**: se incorpora al estado como un resultado más y se procesa en la siguiente decisión.

```text
Desarrollador
     │ intervención (ajuste, restricción, detención)
     ▼
  Estado ──▶ Decisión ──▶ …
```

- Si la intervención ajusta la tarea, esta continúa **En curso** con la nueva información (`Lifecycle.md §3`).
- Si la detiene, la tarea pasa a **Fallida** con ese motivo (`Lifecycle.md §3`).

La intervención no es una operación del ciclo (no la decide el orquestador); es un acontecimiento externo que el runtime debe poder recibir en cualquier iteración.

---

## 8. Qué NO define este documento

- Los estados y transiciones de la tarea y de la unidad de trabajo → `04-Behavior/Lifecycle.md`.
- La composición interna de AIES (orquestador, subagentes, capacidades, relaciones) → `Component-Model.md`.
- Criterios para evaluar la complejidad de una tarea y elegir el proceso → `ADR-004` (la evaluación es del orquestador; la calibración, de medición).
- Criterios para seleccionar capacidad, agente y modelo → `ADR-004`; catálogo formal de capacidades → pendiente (`P-17`).
- La representación física del estado y el mecanismo de continuidad entre sesiones → implementación y ADR.
- pi (v0), MCP, modelos concretos, prompts y configuración → fuera del alcance conceptual (`Non-Goals §11`, `ADR-001`); el binding material concreto se define en `ADR-009`.

---

## 9. Cuestiones abiertas

1. ~~**Valores y política de límites de ejecución**~~ — Política resuelta en `ADR-005`; los valores numéricos siguen en medición (`NFR §6`).
2. ~~**Criterios de decisión**~~ — Resuelto en `ADR-004-criterios-de-decision.md`.
3. **Concurrencia entre tareas o sesiones** → solo si aparece necesidad (`P-17`); excluida por ahora.
4. ~~**Mecanismo de persistencia del estado y del conocimiento entre sesiones**~~ — **Resuelto en `ADR-008-persistencia-entre-sesiones.md`** (pendiente también en `ADR-003 §Fuera del alcance`): `state.json` + `log.jsonl` bajo `agentDir` keyed-by-cwd; conocimiento del repo leído al arranque.
