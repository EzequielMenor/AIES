# AIES — Requisitos funcionales (núcleo)

Este documento define **qué debe hacer** AIES, sin especificar **cómo**. Se deriva de `01-Concept/` y usa el vocabulario de `02-Requirements/Glossary.md`.

No introduce arquitectura, tecnologías, modelos, agentes concretos ni mecanismos. Todo ítem debe poder trazarse a un objetivo (`OBJ-xx`) y, cuando corresponda, a un principio (`P-xx`) o un problema (`Problem.md §x`).

---

## 1. Cómo leer este documento

Cada ítem se etiqueta según su naturaleza:

- **[Requisito]** — Capacidad observable que AIES debe proporcionar. Es la categoría por defecto.
- **[Restricción]** — Límite que AIES debe respetar (normalmente derivado de `Non-Goals.md` o de un principio).
- **[Hipótesis]** — Afirmación que AIES debe permitir *probar* o *medir*, pero que aún no está validada. No se trata como requisito duro de comportamiento.

Las cuestiones que aún no tienen respuesta se recogen en la sección final, no se resuelven aquí.

---

## 2. Requisitos funcionales

### Contexto controlado (OBJ-01)

- **REQ-F-01** [Requisito] — AIES debe poder dividir el trabajo entre agentes especializados de forma que cada agente reciba únicamente la información necesaria para su función. *(OBJ-01, P-07)*

- **REQ-F-02** [Requisito] — AIES debe construir el contexto de cada agente de forma intencional (tarea + información relevante + resultados de etapas anteriores + restricciones necesarias), y no como el historial completo de lo ocurrido. *(OBJ-01, P-07)*

### Separación entre coordinación y ejecución (base de OBJ-01, OBJ-09)

- **REQ-F-03** [Restricción] — El orquestador no debe realizar directamente el trabajo que puede delegar; no debe usar herramientas de lectura, escritura o modificación del proyecto para ese trabajo. *(P-01, P-02)*

- **REQ-F-04** [Requisito] — AIES debe distinguir entre "decidir qué hacer" y "hacerlo", de modo que un agente responsable de decisiones no necesite ejecutar todas las operaciones. *(P-02)*

### Proceso adaptado a la tarea (OBJ-02)

- **REQ-F-05** [Requisito] — AIES debe poder resolver tareas con procesos de distinta cantidad de pasos, desde un proceso mínimo hasta uno elaborado, según la tarea. *(OBJ-02, P-05)*

- **REQ-F-06** [Requisito] — AIES debe poder determinar el proceso necesario a partir de características de la tarea (complejidad, alcance, incertidumbre, riesgo, necesidad de información, impacto del cambio). *(OBJ-02, P-05)*

- **REQ-F-07** [Requisito] — AIES debe intentar resolver cada tarea con el mínimo proceso que permita un resultado suficientemente correcto y confiable. *(OBJ-02, P-06)*

- **REQ-F-08** [Requisito] — AIES debe permitir completar tareas de baja complejidad sin pasos innecesarios. *(OBJ-03, P-06)*

> Nota: la *reducción de tiempo* que persigue OBJ-03 es un resultado medible, no una capacidad en sí. Los criterios para medirla se definirán en requisitos no funcionales / validación.

### Visibilidad y control (OBJ-04)

- **REQ-F-09** [Requisito] — AIES debe proporcionar al desarrollador una visión clara de: qué se entendió de la tarea, qué se está haciendo, qué decisiones importantes se tomaron, qué cambios se realizaron y qué resultado se obtuvo. *(OBJ-04, P-20)*

- **REQ-F-10** [Requisito] — Las decisiones relevantes de una ejecución deben ser comprensibles y observables, sin necesidad de exponer el razonamiento completo del modelo. *(P-11)*

- **REQ-F-11** [Requisito] — AIES debe permitir al desarrollador intervenir y establecer límites o restricciones durante el trabajo. *(Non-Goals §6, P-20)*

### Descomposición en tareas pequeñas (OBJ-05)

- **REQ-F-12** [Requisito] — AIES debe poder descomponer un trabajo grande en unidades de trabajo pequeñas y bien definidas, con objetivo concreto y resultado verificable. *(OBJ-05, P-04, Problem §7)*

- **REQ-F-13** [Requisito] — Cada unidad de trabajo debe poder disponer de: objetivo claro, alcance limitado, resultado esperado y condiciones de finalización. *(OBJ-05, P-04)*

### Estado explícito y adaptación durante la ejecución (OBJ-10, P-09)

- **REQ-F-14** [Requisito] — AIES debe representar de forma explícita el estado de la tarea en curso (qué se resuelve, qué se sabe, qué se ha hecho, qué resultados se han obtenido, cuántas iteraciones hay y qué sigue). *(P-09)*

- **REQ-F-15** [Requisito] — AIES debe poder cambiar de estrategia durante la resolución de una tarea a partir del resultado de una operación. *(OBJ-10)*

- **REQ-F-16** [Requisito] — Ante un fallo, AIES debe poder decidir una acción (corregir, obtener información o cambiar de estrategia) en lugar de reiniciar necesariamente toda la tarea. *(P-13)*

- **REQ-F-17** [Requisito] — AIES debe tratar los resultados intermedios como información para la siguiente decisión. *(P-13)*

### Información antes que ejecución (P-10)

- **REQ-F-18** [Requisito] — Cuando el estado no contenga información suficiente para continuar, AIES debe poder solicitar esa información antes de ejecutar un cambio, en lugar de actuar sobre suposiciones. *(P-10)*

### Continuidad entre sesiones (OBJ-06)

- **REQ-F-19** [Requisito] — AIES debe poder recuperar, al comenzar una nueva sesión, el conocimiento esencial del proyecto sin que el desarrollador tenga que reconstruirlo manualmente. *(OBJ-06, P-08)*

- **REQ-F-20** [Requisito] — La información que persiste entre sesiones debe ser selectiva: arquitectura, decisiones, convenciones, estado relevante del proyecto, aprendizajes y problemas conocidos. *(OBJ-06, P-08, Non-Goals §7)*

### Uso eficiente de modelos (OBJ-07)

- **REQ-F-21** [Requisito] — AIES debe poder asignar distintos tipos de trabajo a distintos modelos según la naturaleza del trabajo. *(OBJ-07, P-15)*

- **REQ-F-22** [Requisito] — El modelo a utilizar debe poder depender del trabajo (complejidad, necesidad de razonamiento, velocidad, coste, fiabilidad, tipo de capacidad), sin asumir un único modelo óptimo. *(P-15)*

- **REQ-F-23** [Hipótesis] — AIES debe poder dividir el trabajo de modo que un modelo no necesite resolver por sí solo investigación + razonamiento + planificación + implementación + verificación. Esta separación es una estrategia de eficiencia, no una obligación de usar múltiples agentes siempre. *(OBJ-08, Non-Goals §5)*

### Especialización y sustituibilidad de agentes (OBJ-09)

- **REQ-F-24** [Requisito] — AIES debe poder utilizar agentes con propósito claro y responsabilidades limitadas. *(OBJ-09, P-03)*

- **REQ-F-25** [Restricción] — Un agente debe existir solo cuando su separación aporte una ventaja real; AIES no debe añadir agentes artificialmente. *(OBJ-09, P-03, Non-Goals §5)*

- **REQ-F-26** [Requisito] — AIES debe poder sustituir un agente por otro que proporcione la misma capacidad, sin que ello cambie el proceso de resolución de la tarea. *(P-14, P-16)*

### Crecimiento progresivo (P-17)

- **REQ-F-27** [Requisito] — AIES debe poder empezar con un conjunto pequeño de capacidades y agentes, y crecer progresivamente sin introducir complejidad antes de que exista una necesidad demostrada. *(P-17)*

---

## 3. Tabla de trazabilidad

| Objetivo | Requisitos |
|---|---|
| OBJ-01 | REQ-F-01, REQ-F-02, REQ-F-03, REQ-F-04 |
| OBJ-02 | REQ-F-05, REQ-F-06, REQ-F-07 |
| OBJ-03 | REQ-F-08 (resultado medible: ver no funcionales) |
| OBJ-04 | REQ-F-09, REQ-F-10, REQ-F-11 |
| OBJ-05 | REQ-F-12, REQ-F-13 |
| OBJ-06 | REQ-F-19, REQ-F-20 |
| OBJ-07 | REQ-F-21, REQ-F-22 |
| OBJ-08 | REQ-F-23 (hipótesis) |
| OBJ-09 | REQ-F-24, REQ-F-25, REQ-F-26 |
| OBJ-10 | REQ-F-14, REQ-F-15, REQ-F-16, REQ-F-17 |
| (P-10, P-17) | REQ-F-18, REQ-F-27 |

---

## 4. Cuestiones abiertas

1. ~~**Evaluación de complejidad**~~ — Resuelto en `ADR-004-criterios-de-decision.md`: la evalúa el orquestador con las seis dimensiones de `REQ-F-06`; la calibración numérica queda en medición (`NFR §6`).
2. ~~**Selección de modelo/agente**~~ — Resuelto en `ADR-004-criterios-de-decision.md`: selección por contrato de capacidad; un trabajador por defecto por capacidad hasta necesidad demostrada (`REQ-F-27`).
3. ~~**Modelo formal de unidad de trabajo**~~ — Resuelto en `Task-Model.md`, que define sus campos, relación, criterios de finalización y estados.
4. **Hipótesis OBJ-08** — La eficacia de aprovechar modelos económicos mediante división del trabajo (REQ-F-23) debe validarse con evidencia, no asumirse.

Las cuestiones pendientes se resolverán en documentos posteriores (no funcionales, arquitectura y comportamiento), documentando cada decisión como tal.
