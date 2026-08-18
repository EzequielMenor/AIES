# AIES — Modelo de decisión

Este documento define el **contrato conceptual de la decisión** dentro de AIES: qué es, qué información utiliza, qué produce y cómo se relaciona con las operaciones, las capacidades, los fallos y la terminación de una tarea.

La decisión es la pieza que conecta el estado con la operación: `estado → decisión → operación → resultado → nuevo estado → nueva decisión` (`Runtime-Model.md §2`).

Deriva de `P-01`, `P-02`, `P-09`…`P-14`, `P-16`, de `REQ-F-04`, `REQ-F-10`, `REQ-F-14`…`REQ-F-18`, de `RNF-01`, `RNF-11`, `RNF-15`, `RNF-18`…`RNF-20` y de `ADR-002`, `ADR-003`. Usa el vocabulario de `Glossary.md`.

No redefine el ciclo del runtime ni el catálogo de operaciones, definidos en `Runtime-Model.md §2 y §4`: los referencia. No define la máquina de estados de la tarea ni de la unidad de trabajo (`Lifecycle.md`), ni mecanismos, modelos, prompts, algoritmos de decisión, criterios concretos de selección ni implementación.

---

## 1. Convenciones

- **[Hecho]** — Impuesto por `01-Concept/`, requisitos validados o ADRs.
- **[Propuesta]** — Modelo propuesto que requiere validación.
- **[Pendiente]** — Aspecto que requiere una decisión posterior (ADR) o un documento posterior.

---

## 2. Qué es una decisión

**[Propuesta]** — Una **decisión del runtime** es la resolución que el orquestador toma en cada iteración del ciclo, a partir del estado explícito de la tarea, y que determina qué ocurre a continuación:

- qué **operación** se pone en marcha (exactamente una, del catálogo de `Runtime-Model.md §4`);
- y, cuando corresponde, qué **ajuste del plan** recibe el trabajo pendiente (§4.2).

### 2.1 Propiedades

| Propiedad | Qué significa | Fuente |
|---|---|---|
| Quién la toma | El orquestador; nunca un trabajador | [Hecho] `P-01`, `P-02`, `Runtime-Model.md §2` |
| Su entrada | El estado explícito de la tarea, no la conversación | [Hecho] `P-09`, `REQ-F-14` |
| Su salida | Una operación y, opcionalmente, un ajuste del plan | [Propuesta] `Runtime-Model.md §4` + §4 de este documento |
| No ejecuta | Decidir y ejecutar son trabajos distintos (§10) | [Hecho] `P-02`, `REQ-F-04` |
| Es observable | Deja huella suficiente para comprenderla (§11) | [Hecho] `P-11`, `REQ-F-10` |
| Una por iteración | Cada pasada del ciclo contiene una decisión | Consecuencia de `Runtime-Model.md §2, §6` |

### 2.2 Qué NO es una decisión del runtime

- **No es la ejecución de la operación.** La decisión pone la operación en marcha; la ejecutan los trabajadores, no la decisión ni el orquestador (`P-01`, `Runtime-Model.md §2`).
- **No son las decisiones internas del trabajador.** El trabajador decide cómo realiza su unidad dentro de su autonomía limitada; esas decisiones no pertenecen al modelo de decisión del runtime (`Agent-Model.md §6, §7`).
- **No es delegable.** Coordinar no es una capacidad delegable: la decisión sobre el proceso de la tarea no puede entregarse a un trabajador (`Agent-Model.md §3.1`).
- **No es un mecanismo concreto.** Este documento no asume cómo toma el orquestador sus decisiones (modelo de lenguaje, reglas o cualquier otro mecanismo). El modelo es un recurso del agente, no parte del contrato (`P-15`, `Non-Goals §2`, `Agent-Model.md §2`).

### 2.3 La decisión dentro del ciclo

**[Propuesta — armonización]** — `Lifecycle.md §2` dibuja el bucle con dos nodos, *Pensar* y *Decidir*; `Runtime-Model.md §2` lo dibuja con una sola pieza, *Decisión*. Son la misma cosa: toda decisión **comienza evaluando el estado** ("pensar": qué se sabe, qué se ha hecho, qué resultados hay) y **concluye escogiendo una salida** ("decidir"). `Lifecycle.md` los separa para exponer que la decisión empieza por observar el estado (`P-09`), no para introducir dos mecanismos.

---

## 3. Entrada de la decisión

**[Hecho]** — La única entrada de una decisión es el **estado explícito de la tarea** (`P-09`, `REQ-F-14`); la decisión no se toma desde información implícita contenida en una conversación.

**[Propuesta]** — Concretando `Runtime-Model.md §3.1`, una decisión puede utilizar:

| Información del estado | Qué aporta a la decisión | Fuente |
|---|---|---|
| La tarea | Objetivo, resultado esperado, condición de finalización y **restricciones** que delimitan lo que puede escogerse | `Task-Model.md §1` |
| Información conocida | Qué se sabe; si es suficiente o falta (§7) | `Runtime-Model.md §3.1`, `REQ-F-18` |
| Unidades de trabajo | Qué trabajo existe y en qué estado está | `Task-Model.md §2, §5` |
| Resultados | Qué produjeron las operaciones anteriores, incluidos fallos y límites alcanzados | `P-13`, `REQ-F-17`, `RNF-19` |
| Iteraciones | Cuántas pasadas del ciclo se han realizado | `P-09`, `Lifecycle.md §5` |
| Límites aplicables | Duración, iteraciones, coste y contexto permitidos para esta tarea | `RNF-18`, `RNF-20` |
| Intervenciones | Ajustes, restricciones o detenciones del desarrollador, incorporadas al estado como un resultado más | `Runtime-Model.md §7` |
| Siguiente paso | Qué debe hacerse a continuación, registrado en el estado | `P-09` |

Dos reglas:

- La decisión solo puede apoyarse en lo que el estado contiene; si el estado no contiene información suficiente, la rama correcta es *obtener información* (§7), no suponer (`REQ-F-18`).
- Nada entra en la decisión sin pasar por el estado: los resultados, las intervenciones y los límites alcanzados se incorporan primero al estado y se procesan en la siguiente decisión (`P-13`, `Runtime-Model.md §5-§7`).

---

## 4. Salida de la decisión

### 4.1 Operación (referencia)

**[Propuesta, fijada en `Runtime-Model.md §4`]** — Una decisión produce **exactamente una operación**: *obtener información*, *ejecutar una unidad*, *comunicar al desarrollador* o *terminar*. Este documento no redefine ese catálogo ni sus reglas: la verificación no es una operación propia (`ADR-002`); *obtener información* no modifica el proyecto (`P-10`); *comunicar* no sustituye al término de la tarea.

### 4.2 Ajuste del plan

**[Propuesta]** — Las cuatro operaciones actúan sobre **el proyecto o el desarrollador**. Pero algunas decisiones cambian **qué trabajo existe**, sin tocar el proyecto:

- **descomponer** la tarea en unidades de trabajo (`Task-Model.md §3`);
- **re-descomponer** una unidad que resultó demasiado grande o mal definida (`Lifecycle.md §4`);
- **cambiar de estrategia** cuando el resultado de una operación revela que el plan inicial no es adecuado (`REQ-F-15`, `OBJ-10`);
- **determinar el proceso** que la tarea justifica —cuántas y qué unidades, con qué capacidades— según las características de la tarea (`REQ-F-05`, `REQ-F-06`).

Ninguna de ellas encaja en las cuatro operaciones: no ejecutan una unidad, no obtienen información del proyecto, no comunican ni terminan. Actúan sobre **el estado**, no sobre el proyecto.

Para darles un lugar sin modificar el catálogo, la salida de una decisión tiene **dos facetas**:

```text
                      Decisión
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
   Ajuste del plan (opcional)      Operación (exactamente una)
   actúa sobre el estado:          actúa sobre el proyecto
   · descomponer                   o el desarrollador:
   · re-descomponer                · obtener información
   · cambiar de estrategia         · ejecutar una unidad
   · determinar el proceso         · comunicar al desarrollador
                                   · terminar
```

Reglas:

- El ajuste del plan **nunca modifica el proyecto**: crea, sustituye o replantea unidades **Pendiente** en el estado (coherente con `Lifecycle.md §4`: "la decisión puede sustituirla por varias unidades Pendiente").
- La operación **pone trabajo en marcha**; el ajuste del plan **define sobre qué trabajo se opera**. Una decisión típica de ejecución combina ambas facetas: ajusta el plan si hace falta y delega la unidad correspondiente.
- *Cambiar de estrategia* es un ajuste del plan, **no una quinta operación**: la estrategia es la descomposición y las capacidades previstas; cambiarla es cambiar el plan a partir del resultado de una operación (`REQ-F-15`).
- La descomposición inicial de la tarea también es un ajuste del plan: ocurre **dentro** del bucle, en las primeras decisiones sobre una tarea **En curso** (`Lifecycle.md §5`), no fuera de él.
- Compatibilidad con `Runtime-Model.md §4`: "una decisión produce exactamente una operación" se mantiene intacta; este documento añade que la misma decisión puede además ajustar el plan. Si esta propuesta se valida, corresponderá anotar la referencia cruzada en `Runtime-Model.md §4` (§13, cuestión 4).

Esto cierra la laguna entre `Lifecycle.md §4` (la re-descomposición como efecto de una decisión) y `Runtime-Model.md §4` (un catálogo de operaciones que no la contiene): la re-descomposición pertenece a la faceta de plan de la decisión.

---

## 5. Tipos conceptuales de decisión

**[Propuesta]** — Los tipos de decisión se derivan de su salida, sin introducir operaciones nuevas:

| Tipo de decisión | Operación que produce | Cuándo es la decisión correcta | Fuente |
|---|---|---|---|
| **De obtener información** | Obtener información | El estado no contiene información suficiente (§7) | `P-10`, `REQ-F-18` |
| **De ejecutar trabajo** | Ejecutar una unidad | Hay trabajo pendiente e información suficiente; incluye seleccionar la capacidad necesaria | `P-01`, `P-14`, `Lifecycle.md §2` |
| **De comunicar** | Comunicar al desarrollador | Hay progreso, una decisión relevante o un resultado que hacer visible | `OBJ-04`, `P-11` |
| **De terminación** | Terminar | Condiciones de finalización cumplidas y verificadas, o no hay continuación viable (§8) | `P-12`, `P-13`, `Task-Model.md §4` |

Dimensiones transversales:

- **Continuar o terminar el ciclo**: los tres primeros tipos devuelven el control al bucle; la terminación lo cierra (`Runtime-Model.md §4`, `Lifecycle.md §2`).
- **Con o sin ajuste del plan**: cualquiera de los tipos puede ir acompañado de un ajuste del plan (§4.2); la decisión de ejecutar es la que más habitualmente lo lleva.

Notas:

- La decisión de ejecutar incluye seleccionar la **capacidad** (`P-01`); la selección del trabajador y del modelo concretos también pertenece a la decisión, pero sus criterios están abiertos (§13).
- Este conjunto es el mínimo derivable de `P-10`, `P-12`, `P-13` y `OBJ-04` (`P-17`). Añadir una operación nueva sería un cambio de `Runtime-Model.md`, no de este documento.

---

## 6. Decisiones ante resultados y fallos

**[Hecho]** — Toda operación produce un resultado que se incorpora al estado y alimenta la siguiente decisión (`P-13`, `REQ-F-17`, `Runtime-Model.md §5`). Los tipos de resultado son: información obtenida, unidad terminada, fallo, verificación insatisfactoria — y también un límite alcanzado (`RNF-19`, `Runtime-Model.md §6`).

**[Hecho]** — Un fallo de unidad **no** implica fallo de tarea (`REQ-F-16`, `Lifecycle.md §4`): es una entrada más del bucle.

**[Propuesta]** — Tras observar un resultado, la siguiente decisión dispone conceptualmente de este repertorio:

| Resultado observado | Decisiones posibles |
|---|---|
| Información obtenida | Continuar: ejecutar, obtener más información, ajustar el plan |
| Unidad terminada | Ejecutar la siguiente unidad, ejecutar la verificación pendiente (delegación con capacidad de verificación, `ADR-002`), ajustar el plan, o terminar si se cumplen las condiciones (§8) |
| Fallo de unidad | Corregir y re-delegar (mismo u otro trabajador, `P-16`), obtener información, re-descomponer o cambiar de estrategia (ajuste del plan), o terminar como **Fallida** si no hay continuación viable (`P-13`) |
| Verificación insatisfactoria | Como el fallo: vuelve al bucle; no implica fallo de tarea (`ADR-002`) |
| Límite alcanzado | Nueva decisión o terminación controlada; nunca continuación silenciosa (`RNF-19`) |

**[Pendiente]** — Qué opción elegir en cada caso son los criterios de decisión: quedan abiertos (§13). Este documento fija el repertorio, no la elección.

---

## 7. Decisión ante información insuficiente

**[Hecho]** — Cuando el estado no contiene información suficiente para continuar, la decisión correcta es **obtener información antes de ejecutar** cualquier cambio, en lugar de actuar sobre suposiciones (`P-10`, `REQ-F-18`).

Reglas:

- Es una **rama de primer orden** del contrato, no una excepción: la pregunta "¿se sabe suficiente?" forma parte de toda decisión (§2.3).
- *Obtener información* **no modifica el proyecto**, aunque también se delegue en un trabajador (`Runtime-Model.md §4`, `P-10`).
- La información relevante de la tarea **puede ampliarse** durante la ejecución precisamente por esta vía (`Task-Model.md §1`).
- También aplica tras un fallo: si el fallo revela falta de conocimiento, obtener información precede a reintentar (§6).

---

## 8. Decisión de terminación

**[Hecho]** — Terminar es una decisión del orquestador que cierra el ciclo declarando la tarea **Completada** o **Fallida** (`Runtime-Model.md §4`, `Lifecycle.md §3`). No requiere capacidad de trabajador (`Capability-Model.md §8`).

**[Hecho]** — Condiciones, consolidadas desde `Task-Model.md §4` y `Lifecycle.md §5`:

- **Completada**: se ha obtenido el resultado esperado de la tarea, se han terminado las unidades necesarias, se cumple la condición de finalización y el resultado se ha verificado de forma proporcional al riesgo y la complejidad (`P-12`, `RNF-15`, `ADR-002`). Nunca por haber producido una respuesta o código sin más (`P-12`).
- **Fallida**: se decidió que no existe una continuación viable, o el desarrollador detuvo la tarea (`P-13`, `RNF-04`, `Lifecycle.md §3`).
- **Terminación controlada por límite**: alcanzar un límite de ejecución puede producir una terminación controlada; nunca una continuación silenciosa (`RNF-19`). **[Hecho — ADR-005]** — La política concreta (terminar controladamente, pedir intervención, cambiar de estrategia, ampliación preautorizada) se define en `ADR-005-limites-e-irrecuperabilidad.md`; los valores numéricos quedan en medición. Aquí solo queda fijado que terminar por límite es una decisión de terminación posible y observable.

**[Hecho]** — El fin de una sesión **no** es una decisión de terminación: no cambia por sí solo el estado de la tarea (`ADR-003`).

---

## 9. Relación con capacidades y trabajadores

**[Propuesta]** — Consolidación, sin redefinir `Capability-Model.md §8` ni `Agent-Model.md`:

- La decisión **selecciona una capacidad** solo cuando la operación es delegable (*obtener información*, *ejecutar una unidad*). *Comunicar* y *terminar* las realiza el propio orquestador y no necesitan capacidad de trabajador (`Capability-Model.md §8`).
- Los **ajustes del plan tampoco requieren capacidad de trabajador**: actúan sobre el estado, que es responsabilidad del orquestador (`P-09`, `Agent-Model.md §4`).
- La decisión se apoya en la **capacidad como contrato estable**; el trabajador concreto es la variable sustituible (`P-14`, `P-16`, `REQ-F-26`, `Capability-Model.md §7`).
- La decisión sobre el proceso **no puede delegarse**: coordinar no es una capacidad delegable (`Agent-Model.md §3.1`).

**[Pendiente]** — Los criterios para seleccionar capacidad, trabajador y modelo en cada decisión (`Functional-Requirements.md §4`, `Capability-Model.md §10`) quedan abiertos (§13).

---

## 10. Decidir y ejecutar

**[Hecho]** — Decidir qué hacer y hacerlo son trabajos distintos (`P-02`, `REQ-F-04`): la decisión pertenece al trabajo de coordinación; la ejecución, al trabajo del proyecto (`Agent-Model.md §2`).

**[Propuesta]** — La frontera del contrato:

```text
La decisión determina QUÉ:              La ejecución determina CÓMO:
operación, unidad, capacidad,           procedimiento interno
contexto intencional                    del trabajador
        │                                       │
        └─────────── contrato de delegación ────┘
               (`Agent-Model.md §6`)
```

- Las **decisiones internas del trabajador** (cómo realiza su unidad) no son decisiones del runtime: pertenecen a su autonomía limitada y quedan fuera de este modelo (`Agent-Model.md §7`).
- El trabajador **no devuelve decisiones de proceso**: devuelve resultados, que entran en la siguiente decisión (`Agent-Model.md §6`, `REQ-F-17`).
- El contrato de la decisión termina donde empieza la autonomía limitada del trabajador (`P-20`, `RNF-05`).

---

## 11. Observabilidad de la decisión

**[Hecho]** — Las decisiones relevantes deben ser comprensibles y observables, sin necesidad de exponer el razonamiento completo del modelo (`P-11`, `REQ-F-10`); debe ser posible reconstruir qué ocurrió, incluidas las decisiones, sin reejecutar la tarea (`RNF-01`, `RNF-11`).

**[Propuesta]** — La huella observable mínima de una decisión contiene:

- la **operación escogida** y, si lo hubo, el **ajuste del plan** realizado;
- el **motivo**: qué del estado la justifica (qué se sabe, qué falta, qué resultado la provocó);
- en una terminación, **la condición** que se cumplió o la causa de la inviabilidad.

Con ello deben poder responderse las preguntas de `P-11`: qué entendió AIES, por qué decidió explorar, por qué utilizó ese agente, por qué consideró necesaria una revisión, por qué terminó la tarea y por qué continuó después de un fallo.

**[Pendiente]** — La representación física de esta huella (formato, almacenamiento) es materia de implementación.

---

## 12. Qué NO define este documento

- Los **criterios de decisión**: evaluación de complejidad (`REQ-F-06`) y selección de capacidad, trabajador y modelo → `ADR-004-criterios-de-decision.md`.
- El **mecanismo** de la decisión (modelo de lenguaje, reglas, híbrido), prompts, clasificadores, scoring o algoritmos → fuera del alcance conceptual; el modelo es un recurso (`Non-Goals §2`, `P-15`).
- El ciclo del runtime y el catálogo de operaciones → `Runtime-Model.md §2, §4` (referenciados, no redefinidos).
- Los estados y transiciones de la tarea y de la unidad → `Lifecycle.md`.
- La política de límites y el criterio de tarea irrecuperable → `ADR-005-limites-e-irrecuperabilidad.md`.
- Las reglas formales de re-descomposición → `ADR-006-re-descomposicion.md`.
- Qué trabajadores concretos existen y el catálogo formal de capacidades → ADR y `Capability-Model.md §9`.
- La representación física de las decisiones y de su huella observable → implementación.
- pi (v0), MCP, modelos concretos y configuración → fuera del alcance conceptual (`Non-Goals §11`, `ADR-001`); el binding material del orquestador, en `ADR-009`.

---

## 13. Cuestiones abiertas

1. ~~**Criterios de decisión**~~ — **Resuelta** en `ADR-004-criterios-de-decision.md` (evaluación por el orquestador; selección por contrato; sin umbrales).
2. ~~**Política al alcanzar límites y criterio de tarea irrecuperable**~~ — **Resuelta** en `ADR-005-limites-e-irrecuperabilidad.md` (repertorio de respuestas; criterio de irrecuperable; valores en medición).
3. ~~**Reglas formales de re-descomposición**~~ — **Resuelta** en `ADR-006-re-descomposicion.md` (cuatro señales de necesidad; reglas de conservación).
4. **Anotación cruzada en `Runtime-Model.md §4`** — **Resuelta**: la propuesta del ajuste del plan (§4.2) se validó y `Runtime-Model.md §4` ya referencia esta faceta (regla adicional) para evitar lecturas del catálogo como salida completa de la decisión.
