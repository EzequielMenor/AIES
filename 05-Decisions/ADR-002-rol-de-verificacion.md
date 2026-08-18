# ADR-002 — Rol de verificación

- **Estado:** Aceptada
- **Fecha:** 2026-08-13
- **Resuelve:** quién ejecuta la verificación dentro del ciclo de vida de una tarea

---

## Contexto

`P-12` establece que una tarea no termina solo porque un agente haya producido una respuesta o modificado código: el resultado debe verificarse cuando sea aplicable.

La documentación conceptual todavía no decide quién realiza esa verificación. La decisión debe respetar simultáneamente:

- `P-01` y `P-02`: el orquestador coordina, pero no realiza el trabajo;
- `P-03` y `P-14`: las capacidades se especializan y se separan de los agentes concretos;
- `P-06`, `P-17` y `Non-Goals.md §5`: no debe imponerse un proceso más complejo ni más agentes de los necesarios.

---

## Opciones consideradas

### Opción A — El orquestador verifica

El orquestador ejecuta directamente las comprobaciones.

Se rechaza porque mezcla coordinación y ejecución y contradice `P-01`, `P-02` y `REQ-F-03`.

### Opción B — El agente que implementa verifica siempre su propio trabajo

El trabajador que realiza una unidad también ejecuta su verificación en todos los casos.

Se rechaza como regla universal: impone el mismo proceso a tareas distintas y no permite separar la verificación cuando la tarea justifique una comprobación independiente (`P-05`, `P-06`).

### Opción C — Siempre existe un verificador dedicado

Toda tarea pasa obligatoriamente por un trabajador distinto dedicado a verificar.

Se rechaza como regla universal porque fuerza múltiples agentes y pasos incluso cuando no aportan valor (`P-06`, `P-17`, `Non-Goals.md §5`).

### Opción D — La verificación es una capacidad de un trabajador, asignada según la tarea

El orquestador decide que debe verificarse, selecciona la capacidad de verificación y la delega a un trabajador. Ese trabajador puede ser el mismo que implementó la unidad o uno diferente, según el proceso que la tarea justifique.

Ventajas:

- mantiene separadas coordinación y ejecución;
- trata verificar como una capacidad, no como un agente fijo (`P-14`);
- permite verificación mínima para tareas simples y separación para tareas de mayor riesgo (`P-05`, `P-06`);
- no obliga a introducir un agente dedicado (`P-17`).

Inconvenientes:

- la independencia de la verificación no es uniforme;
- decidir cuándo conviene un trabajador diferente queda para el proceso de la tarea, no para esta ADR.

---

## Decisión

**Opción D.** La verificación es una **capacidad que ejecuta un trabajador**.

Responsabilidades:

- **Orquestador:** decide si la tarea requiere verificación, selecciona la capacidad de verificación, la delega y observa el resultado. No ejecuta la comprobación.
- **Trabajador con capacidad de verificación:** ejecuta las comprobaciones definidas por la unidad de trabajo y devuelve el resultado.
- **Agente implementador:** puede proporcionar también la capacidad de verificación cuando el proceso de la tarea lo permita; no existe obligación de que lo haga siempre.

No existe un componente obligatorio llamado "verificador". Puede utilizarse un trabajador distinto cuando la tarea lo justifique, pero esa separación no es una regla universal.

---

## Consecuencias

- La transición a **Terminada** requiere que el resultado de la verificación satisfaga la condición de finalización de la unidad (`Task-Model.md`, `P-12`).
- Una verificación insatisfactoria vuelve al bucle de decisión; no implica necesariamente fallo de la tarea (`Lifecycle.md`, `P-13`).
- El modelo de componentes conserva la distinción entre capacidad y agente: queda fijado el rol de la capacidad de verificación, no el agente concreto que la proporciona.
- No se decide qué comprobaciones concretas se ejecutan, qué umbrales tienen ni qué modelo las realiza. Esas decisiones dependen de la tarea y de decisiones posteriores.

---

## Referencias

- `Principles.md P-01, P-02, P-03, P-05, P-06, P-12, P-14, P-17`.
- `Non-Goals.md §5`.
- `Functional-Requirements.md REQ-F-13, REQ-F-16, REQ-F-26`.
- `Task-Model.md §2, §4`.
- `Lifecycle.md §2, §4`.
