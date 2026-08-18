# ADR-004 — Criterios de decisión: proceso, capacidad, trabajador y modelo

- **Estado:** Aceptada
- **Fecha:** 2026-08-14
- **Resuelve:** cuestiones abiertas nº 1 y 2 de `Functional-Requirements.md §4`; cuestión nº 2 de `Runtime-Model.md §9`; cuestión nº 1 de `Decision-Model.md §13`; cuestión nº 3 de `Agent-Model.md §12`; cuestión nº 2 de `Capability-Model.md §10`

---

## Contexto

`REQ-F-06` exige que AIES determine el proceso necesario a partir de características de la tarea (complejidad, alcance, incertidumbre, riesgo, necesidad de información, impacto del cambio), y `REQ-F-21`/`REQ-F-22` exigen asignar tipos de trabajo a modelos según la naturaleza del trabajo. Pero quién evalúa y con qué criterios queda abierto:

- `Functional-Requirements.md §4.1` — la evaluación de complejidad es "un punto de decisión, no un requisito resuelto".
- `Functional-Requirements.md §4.2` — los criterios que deciden cuántos y qué agentes o modelos se usan están por definir.
- `Runtime-Model.md §9.2` y `Decision-Model.md §13.1` — los criterios de decisión son materia de ADR.
- `Capability-Model.md §10.2` y `Agent-Model.md §12.3` — la selección de capacidad, trabajador y modelo está pendiente.

Restricciones que condicionan la decisión:

- **Proceso mínimo** — AIES debe intentar resolver cada tarea con el mínimo proceso que permita un resultado suficientemente correcto y confiable (`REQ-F-07`, `P-06`), y completar tareas de baja complejidad sin pasos innecesarios (`REQ-F-08`, `RNF-06`).
- **Capacidad como contrato** — La decisión selecciona la capacidad (qué debe hacerse), no al trabajador (`P-14`, `Capability-Model.md §4`); el trabajador es sustituible sin cambiar el proceso (`P-16`, `REQ-F-26`).
- **Crecimiento progresivo** — No introducir complejidad antes de una necesidad demostrada (`P-17`, `REQ-F-27`); no añadir agentes artificialmente (`REQ-F-25`).
- **Observabilidad** — Las decisiones relevantes deben poder entenderse y explicarse (`P-11`, `REQ-F-10`, `RNF-01`): criterios no declarados hacen imposible esa explicación.
- **Evidencia, no calibración inventada** — Los umbrales, presupuestos y baselines están pendientes de medición (`Non-Functional-Requirements.md §6`, hipótesis `H-01`…`H-06`); no hay todavía datos que justifiquen valores numéricos.

---

## Opciones consideradas

### Opción A — Criterios numéricos: matriz proceso ↔ tarea y reglas de puntuación

Fijar ahora umbrales (p. ej. niveles de complejidad que determinan número de pasos) y un mecanismo de puntuación para seleccionar capacidad, trabajador y modelo.

Ventajas: determinista; medible desde ya.

Inconvenientes: no existe catálogo de capacidades ni baselines con los que calibrar umbrales (todo ello pendiente de `P-17` y de medición, `NFR §6`); fijar números sin evidencia contradice `P-17` y `REQ-F-27`; un mecanismo rígido de puntuación es frágil y difícil de justificar (`P-18`); anticipa complejidad que los requisitos no exigen todavía.

### Opción B — Sin criterios documentados; el orquestador decide con heurísticas internas

No declarar los criterios; cada decisión se toma libremente.

Ventajas: máxima flexibilidad; cero documentación.

Inconvenientes: viola `P-11`/`REQ-F-10`/`RNF-01` (sin criterios declarados no es posible explicar por qué se eligió un proceso, una capacidad o un modelo); contradice `P-18` (toda decisión debe poder justificarse); impide la medición de `H-02` y `RNF-06`; hace la selección incomprensible para el desarrollador (`REQ-F-09`).

### Opción C — Criterios estructurales en tres capas, sin umbrales

1. **Dimensiones fijas** que toda decisión de proceso evalúa: las seis de `REQ-F-06`.
2. **Política de progresión**: proceso mínimo por defecto; se amplía solo ante señales demostradas de insuficiencia.
3. **Selección por contrato**: la decisión nombra la capacidad; el trabajador/modelo se elige entre los que la proporcionan, según la naturaleza del trabajo.

Ventajas: declara los criterios sin inventar umbrales ni catálogos; coherente con el modelo aprobado (`Decision-Model.md §4.2` — determinar el proceso es la faceta de plan; `Capability-Model.md §7` — la capacidad es el contrato estable); habilita la observabilidad (`P-11`) y deja la calibración numérica donde corresponde (medición, `NFR §6`); respeta `P-17` y `REQ-F-27`.

Inconvenientes: no produce valores numéricos todavía; la calibración queda explícitamente diferida a medición.

---

## Decisión

**Opción C.**

1. **Quién evalúa.** La evaluación de las características de la tarea la realiza el **orquestador como parte de la decisión** (`P-01`, `P-02`, `Decision-Model.md §2.3`); no es trabajo delegable ni de un componente externo.

2. **Dimensiones fijas.** Toda decisión que determine el proceso evalúa las seis dimensiones de `REQ-F-06`: **complejidad, alcance, incertidumbre, riesgo, necesidad de información e impacto del cambio**. Esta evaluación es conceptual (no exige cálculo numérico) y su calidad se validará con medición (`H-02`, `RNF-06`).

3. **Política de progresión.** El **proceso mínimo es el estado por defecto** (`REQ-F-07`, `P-06`): una tarea trivial se resuelve con una única unidad y sin pasos obligatorios (`REQ-F-08`, `Non-Goals §5`). El proceso se amplía —más unidades, más capacidades, más delegaciones— solo cuando el estado muestra una señal demostrada de insuficiencia: un fallo (`REQ-F-16`), información insuficiente (`REQ-F-18`), una unidad desproporcionada o una estrategia inadecuada (`REQ-F-15`). Las señales concretas de re-descomposición y la política de límites pertenecen a sus respectivos ADRs y no se adelantan aquí.

4. **Selección de capacidad.** La decisión selecciona la **capacidad como contrato** (`Capability-Model.md §3, §7`), solo cuando la operación es delegable (`Capability-Model.md §8`). El catálogo formal de capacidades se fijará cuando exista necesidad demostrada (`P-17`, `REQ-F-27`); no se crea en este ADR.

5. **Selección de trabajador y modelo.** Entre los trabajadores que proporcionan la capacidad seleccionada, según la **naturaleza del trabajo** (`REQ-F-21`, `REQ-F-22`): complejidad, necesidad de razonamiento, velocidad, coste, fiabilidad y tipo de capacidad. Por defecto existe **un único trabajador por capacidad** hasta que una necesidad demostrada justifique diversidad (`REQ-F-25`, `REQ-F-27`); cambiar de trabajador o de modelo **no cambia el proceso** (`REQ-F-26`, `RNF-14`). El modelo es un recurso del trabajador (`P-15`), no un criterio de primer nivel.

6. **Conflicto de atributos.** Ante conflicto entre velocidad, coste y calidad, el ancla es `REQ-F-07`: calidad **suficientemente** correcta y confiable primero; coste y tiempo mínimos compatibles con ella (`P-06`, `P-12`, `RNF-15`). La priorización numérica entre velocidad, calidad, coste y seguridad queda para el ADR de límites y para medición (`NFR §6.4`).

---

## Consecuencias

- Toda decisión de proceso queda **explicable**: la evaluación de las dimensiones de `REQ-F-06` y la selección resultante forman parte del motivo observable de la decisión (`Decision-Model.md §11`, `REQ-F-10`, `RNF-01`).
- El runtime puede operar **desde el día uno con un conjunto mínimo** (una capacidad/trabajador por tipo de trabajo necesario) y crecer por evidencia (`REQ-F-27`, `P-17`).
- No se fijan valores numéricos: la calibración de umbrales, presupuestos y baselines queda en medición (`NFR §6`, `H-01`…`H-06`), donde pertenece.
- Documentos afectados, actualizados en consecuencia: `Functional-Requirements.md §4` (cuestiones 1-2 resueltas), `Runtime-Model.md §9.2` (cuestión 2 resuelta), `Decision-Model.md §13.1` (cuestión 1 resuelta), `Agent-Model.md §12.3` (cuestión 3 resuelta), `Capability-Model.md §10.2` (cuestión 2 resuelta), `02-Requirements/README.md` (filas 1-2 de cuestiones abiertas).
- **Fuera del alcance de este ADR**: umbrales y presupuestos (`NFR §6`); catálogo formal de capacidades y qué trabajadores concretos existen (`P-17`); comprobación de afirmaciones de capacidad (`Capability-Model.md §10.3`, medición); política de límites e irrecuperabilidad (ADR siguiente); reglas de re-descomposición (ADR siguiente); persistencia entre sesiones (ADR posterior).

---

## Referencias

- `Functional-Requirements.md REQ-F-05…REQ-F-08, REQ-F-15…REQ-F-18, REQ-F-21…REQ-F-27, §4` — proceso adaptado; información antes que ejecución; modelos; especialización; crecimiento.
- `Principles.md P-05, P-06, P-11, P-14, P-15, P-16, P-17, P-18` — proceso proporcional; mínimo necesario; observabilidad; capacidad; modelo como recurso; sustituibilidad; crecimiento; justificación.
- `Non-Functional-Requirements.md RNF-01, RNF-06, RNF-11, RNF-14, RNF-15, §6` — claridad; proporcionalidad; reconstrucción; sustituibilidad de modelo; calidad; umbrales y priorización pendientes.
- `Runtime-Model.md §4, §9.2` — operaciones; criterios pendientes.
- `Decision-Model.md §4.2, §11, §13.1` — faceta de plan; huella observable; criterios abiertos.
- `Capability-Model.md §3-§4, §7, §8, §10.2` — descripción de capacidad; contrato estable; operaciones delegables; selección pendiente.
- `Agent-Model.md §12.3` — selección de trabajador y modelo pendiente.
- `Task-Model.md §3, §7` — relación tarea → unidades; granularidad pendiente.
