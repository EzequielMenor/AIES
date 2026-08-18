# AIES — Requisitos no funcionales

Este documento concreta las propiedades de calidad que AIES debe cumplir y las dimensiones que deben poder medirse. Se deriva de `Goals.md §3`, `Goals.md §4`, los requisitos funcionales y `P-19`.

No define arquitectura, mecanismos ni umbrales numéricos. Define el **qué**: qué debe poder observarse, medirse y limitarse. Los valores concretos y la metodología de validación siguen abiertos.

---

## 1. Cómo leer este documento

- **[Requisito de calidad]** — Propiedad observable que AIES debe cumplir.
- **[Criterio de medición]** — Dato o comparación necesaria para validar el requisito.
- **[Hipótesis]** — Afirmación pendiente de validación; no se considera verdadera por defecto.

---

## 2. Requisitos por atributo de calidad

### Claridad

- **RNF-01** [Requisito de calidad] — Las decisiones importantes del sistema deben poder entenderse y explicarse. *(Goals §3: Claridad, P-11)*
  - [Criterio de medición] — Ante una ejecución, una persona debe poder responder qué entendió AIES, por qué actuó, por qué delegó, por qué verificó y por qué terminó, sin inspeccionar el razonamiento completo del modelo.

- **RNF-02** [Requisito de calidad] — La relación `problema → objetivo → requisito → decisión` debe poder reconstruirse. *(P-18)*

### Control

- **RNF-03** [Requisito de calidad] — Deben existir límites claros sobre qué puede hacer cada agente. *(Goals §3: Control, P-20)*

- **RNF-04** [Requisito de calidad] — El desarrollador debe poder intervenir, detener o restringir el trabajo en curso. *(OBJ-04, Non-Goals §6, P-20)*

- **RNF-05** [Requisito de calidad] — La autonomía de los agentes debe estar limitada por las capacidades que se les conceden y por las reglas del harness. *(P-20)*

### Eficiencia y contexto

- **RNF-06** [Requisito de calidad] — El trabajo realizado debe ser proporcional al valor que aporta a la resolución de la tarea; AIES no debe imponer pasos obligatorios que no estén justificados por la tarea. *(OBJ-02, OBJ-03, Goals §3: Eficiencia, P-06)*
  - [Criterio de medición] — Número de pasos, delegaciones y verificaciones por tarea, comparado con la complejidad y el resultado obtenido.

- **RNF-07** [Requisito de calidad] — AIES debe mantener el contexto de cada agente intencional y limitado, y debe poder medir el consumo de contexto por agente, unidad y tarea. *(OBJ-01, P-07)*
  - [Criterio de medición] — Tokens de entrada, salida y total por agente y tarea; tamaño del contexto delegado; proporción de información relevante frente a información innecesaria. Si el conteo directo no está disponible, debe utilizarse una unidad equivalente documentada.

- **RNF-08** [Requisito de calidad] — El tiempo de resolución debe poder medirse desde la recepción de la tarea hasta su resultado terminal y, al menos, por las actividades principales: obtener información, ejecutar, verificar y esperar resultados. *(OBJ-03, Goals §4)*
  - [Criterio de medición] — Tiempo total y distribución del tiempo por tarea, comparados con la complejidad de la tarea y con un enfoque de referencia.

### Coste

- **RNF-17** [Requisito de calidad] — El coste de una ejecución debe poder medirse y atribuirse al menos a la tarea y a sus unidades de trabajo; cuando el desglose sea relevante, también a la capacidad o trabajador que realizó cada unidad. *(OBJ-07, Goals §4)*
  - [Criterio de medición] — Coste acumulado por tarea, distribución por unidad/capacidad y relación entre coste, tiempo y calidad. La unidad monetaria o de consumo concreta queda abierta.

### Fiabilidad y recuperación

- **RNF-09** [Requisito de calidad] — Un fallo de un agente o de una operación no debe obligar necesariamente a reiniciar todo el proceso. *(Goals §3: Robustez, P-13)*

- **RNF-10** [Requisito de calidad] — Una recuperación ante fallo no debe producir pérdida de trabajo aceptado ni estado inconsistente; el resultado de la recuperación debe permitir continuar o terminar de forma explícita. *(P-13, REQ-F-16)*
  - [Criterio de medición] — Tasa de fallos, tasa de recuperaciones exitosas, tareas reiniciadas completamente y casos de pérdida de estado o trabajo.

### Observabilidad

- **RNF-11** [Requisito de calidad] — Debe ser posible reconstruir qué ocurrió durante la resolución de una tarea sin reejecutarla. Como mínimo deben poder distinguirse la solicitud, las decisiones relevantes, las delegaciones, los resultados, la verificación, el resultado terminal y los límites alcanzados. *(Goals §3: Observabilidad, OBJ-04, P-11)*
  - [Criterio de medición] — Una persona debe poder reconstruir el proceso y sus decisiones a partir de la información observada.

- **RNF-12** [Requisito de calidad] — El estado de la tarea (qué se ha hecho, qué resultados hay, qué queda y cuántas iteraciones se han realizado) debe poder consultarse sin depender de información implícita de una conversación. *(P-09)*

### Extensibilidad

- **RNF-13** [Requisito de calidad] — Debe ser posible añadir nuevas capacidades o trabajadores sin rediseñar los principios del runtime. *(Goals §3: Extensibilidad, P-14, P-17)*

- **RNF-14** [Requisito de calidad] — Debe ser posible cambiar de modelo o proveedor sin cambiar el proceso conceptual ni los principios fundamentales del sistema. *(Non-Goals §2, P-14, P-16)*

### Calidad del resultado

- **RNF-15** [Requisito de calidad] — La calidad del resultado debe evaluarse frente al resultado esperado y la condición de finalización de la tarea, y no únicamente frente al tiempo o coste consumidos. Cuando exista una comparación, no debe degradarse respecto a un enfoque de referencia basado en un único agente o en un workflow rígido. *(Goals §4, P-12)*
  - [Criterio de medición] — Resultado de la verificación, cumplimiento de la condición de finalización y comparación de calidad con un baseline definido para la tarea.

### Continuidad entre sesiones

- **RNF-16** [Requisito de calidad] — El conocimiento esencial del proyecto debe poder recuperarse al inicio de una sesión con un coste bajo de tiempo y contexto, sin que el desarrollador tenga que reconstruirlo manualmente. *(OBJ-06, Problem §5)*
  - [Criterio de medición] — Tiempo y contexto necesarios para continuar el trabajo; utilidad de la información recuperada y cantidad de reconstrucción manual requerida.

### Límites de ejecución

- **RNF-18** [Requisito de calidad] — Toda ejecución debe estar sujeta a límites aplicables de duración, iteraciones, coste y consumo de contexto/tokens. Los valores por defecto y los umbrales concretos quedan pendientes. *(P-09, P-17, OBJ-02)*

- **RNF-19** [Requisito de calidad] — Cuando se alcance un límite de ejecución, AIES debe hacerlo observable y evitar continuar de forma silenciosa o ilimitada. El resultado debe volver al bucle de decisión o producir una terminación controlada. *(P-09, P-13, P-20)*
  - [Criterio de medición] — Límites aplicados, límites alcanzados, ejecuciones detenidas o intervenidas y casos de continuación no controlada.

- **RNF-20** [Requisito de calidad] — AIES debe poder aplicar límites distintos según las características de la tarea; no debe asumir un único límite universal para todas las tareas. *(OBJ-02, P-05, P-06)*

---

## 3. Dimensiones mínimas de medición

Estas dimensiones concretan qué debe poder medirse. No fijan todavía valores objetivo ni el mecanismo para obtenerlos.

| Dimensión | Unidad mínima de análisis | Datos necesarios |
|---|---|---|
| Tiempo/latencia | Tarea y actividad principal | Inicio, fin, duración total y duración por actividad |
| Coste | Tarea y unidad de trabajo | Coste acumulado y distribución por unidad/capacidad cuando sea relevante |
| Contexto/tokens | Agente, unidad y tarea | Entrada, salida, total y tamaño del contexto delegado |
| Calidad | Tarea y resultado | Condición de finalización, verificación y comparación con baseline |
| Observabilidad | Ejecución completa | Solicitud, decisiones, delegaciones, resultados, límites y estado terminal |
| Fiabilidad | Operación y tarea | Fallos, recuperaciones, reinicios completos, pérdida de estado y resultado final |
| Límites | Ejecución | Límite aplicado, valor alcanzado, decisión posterior y resultado |

---

## 4. Hipótesis a validar con evidencia

Según `P-19`, estas afirmaciones deben convertirse en experimentos medibles:

| Hipótesis | Fuente | Dimensión a medir |
|---|---|---|
| H-01: dividir el trabajo entre agentes reduce el contexto innecesario | OBJ-01 | consumo de contexto |
| H-02: el coste y el tiempo resultan proporcionales a la complejidad | OBJ-03, Goals §4 | coste, tiempo |
| H-03: la división del trabajo mantiene o mejora la calidad | Goals §4 | calidad, tasa de errores |
| H-04: la especialización mejora la eficacia de cada agente | OBJ-09, P-19 | eficacia de la especialización |
| H-05: la persistencia selectiva aporta valor real al inicio de sesión | OBJ-06, P-19 | utilidad de la memoria |
| H-06: dividir el trabajo permite obtener mejores resultados de modelos económicos | OBJ-08 | beneficio de distintos modelos |

La definición de baselines, tareas de referencia, métricas de calidad y experimentos queda pendiente y pertenecerá a `06-research/` o a la validación de cada decisión.

---

## 5. Tabla de trazabilidad

| Atributo | Requisitos no funcionales |
|---|---|
| Claridad | RNF-01, RNF-02 |
| Control | RNF-03, RNF-04, RNF-05 |
| Eficiencia/contexto | RNF-06, RNF-07, RNF-08 |
| Coste | RNF-17 |
| Robustez/fiabilidad | RNF-09, RNF-10 |
| Observabilidad | RNF-11, RNF-12 |
| Extensibilidad | RNF-13, RNF-14 |
| Calidad del resultado | RNF-15 |
| Continuidad | RNF-16 |
| Límites de ejecución | RNF-18, RNF-19, RNF-20 |

---

## 6. Cuestiones abiertas

1. **Umbrales y presupuestos** — Valores máximos o esperados para tiempo, coste, contexto/tokens, iteraciones y tasa de errores.
2. **Metodología de medición** — Cómo medir contexto innecesario, calidad, complejidad de tarea y utilidad de la continuidad.
3. **Baselines** — Enfoques de referencia y conjunto de tareas con los que se compararán coste, tiempo, contexto y calidad.
4. **Priorización en conflicto** — Qué atributo prevalece ante un conflicto entre velocidad, calidad, coste y seguridad.
5. ~~**Política al alcanzar límites**~~ — Resuelta en `ADR-005-limites-e-irrecuperabilidad.md` (estructura, repertorio de respuestas y criterio de irrecuperable); los valores y perfiles por defecto siguen en medición.
6. **Cobertura del coste** — Qué recursos se incluyen en el coste medido y cómo se normalizan entre entornos o proveedores.
