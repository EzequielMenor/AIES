# AIES — Glosario

Este documento fija el vocabulario del dominio de AIES. Su función es dar un significado preciso y no ambiguo a los términos que se usan en `01-Concept/` y que se usarán en los requisitos, la arquitectura y las decisiones posteriores.

No introduce arquitectura, tecnología, modelos ni agentes concretos. Solo fija lenguaje.

---

## 1. Convenciones de lectura

Cada término se marca con una de estas etiquetas, según su grado de fijación en la documentación existente:

- **[Hecho]** — Quedó fijado explícitamente en `01-Concept/`. Un documento posterior no debería contradecirlo sin motivo.
- **[Abierto]** — El término se usa en `01-Concept/`, pero su significado no está delimitado con precisión. Requiere una decisión posterior (que se documentará como tal, no como hecho).
- **[Propuesta]** — Definición que se propone aquí como punto de partida, pero que aún no está validada en `01-Concept/`.

Entre paréntesis se cita la fuente en `01-Concept/` (documento, sección o principio).

---

## 2. El sistema

### AIES

**[Hecho]** — El harness que organiza y controla el trabajo de los agentes de IA durante tareas de desarrollo. No es un agente, ni un modelo, ni un workflow fijo.

Fuente: `Vision.md`; `Non-Goals.md §1, §2, §3, §13`.

Principio rector: **AIES organiza el trabajo; los agentes realizan el trabajo.**

---

### Harness

**[Hecho]** — El conjunto de reglas, entorno, estado, coordinación y mecanismos que permiten que el trabajo se divida, ejecute, verifique y continúe de forma controlada.

Fuente: `Vision.md`; `Non-Goals.md §13`; `Principles.md P-20`.

---

### Runtime

**[Hecho]** — El mismo sistema que el harness, **en operación**: ejecutando, observando resultados y tomando decisiones. No es un componente separado.

Convención de uso: **harness** para identidad y diseño; **runtime** para el sistema operando.

Fuente: `Non-Goals.md §11`; `Principles.md P-09, P-13, P-16, P-17`; `Goals.md §3`. Decidido en `ADR-001`.

---

### Entorno de ejecución concreto

**[Hecho]** — El sistema externo que hospeda a los agentes (herramientas, permisos, acceso a modelos), p. ej. **pi (v0)** en la implementación v0. Es intercambiable y está separado conceptualmente de AIES.

Fuente: `Non-Goals.md §11`. Decidido en `ADR-001`; ubicación física y host concreto resueltos en `ADR-009`.

> Resuelto en `ADR-009`: el host v0 es **pi**, integrado vía SDK embebido en proceso; AIES-core es el entrypoint dueño del bucle y pi es el motor de workers / `ModelRuntime`.

---

### pi (host v0)

**[Propuesta — `ADR-009`]** — El entorno de ejecución concreto elegido para la implementación v0: un *minimal terminal coding harness* extensible en TypeScript, con SDK / RPC / JSON-mode, sesiones, multi-provider y `autoCompaction` nativa de contexto. Es el **motor de ejecución de workers** y el proveedor del `ModelRuntime`; **no** decide el proceso de la tarea (eso corresponde a AIES-core).

Fuente: `ADR-009-integracion-con-pi.md`; `MVP-v0-Scope.md §5`. pi **no** forma parte de la identidad conceptual de AIES (`Non-Goals §11`).

---

## 3. Actores

### Desarrollador

**[Hecho]** — El usuario humano que delega trabajo a AIES. No desaparece del proceso: debe poder comprender el resultado, conocer las decisiones, revisar cambios, intervenir y establecer límites.

Fuente: `Non-Goals.md §6`; `Goals.md OBJ-04`; `Principles.md P-20`.

Relación conceptual: `Desarrollador → Orquestador → Subagentes` (`Non-Goals.md §1`).

---

### Orquestador

**[Hecho]** — El agente coordinador. Es el único punto de contacto entre el desarrollador y los subagentes. Entiende el estado de la tarea, decide qué hacer, selecciona la capacidad necesaria, delega, recibe resultados y comunica el progreso. **No realiza el trabajo** directamente.

Fuente: `Principles.md P-01`; `Vision.md`; `Non-Goals.md §1`.

Restricción fijada: no debería usar herramientas de lectura, escritura o modificación del proyecto para hacer el trabajo que puede delegar (`P-01`).

---

### Agente

**[Hecho, refinado]** — Entidad dentro de AIES con responsabilidades delimitadas, contexto propio y autonomía limitada por el harness. Se usa como término genérico que incluye al orquestador y a los subagentes.

La distinción relevante no es si un agente "realiza trabajo" —todos trabajan— sino **qué tipo de trabajo**: el orquestador realiza trabajo de *coordinación* (decidir, delegar, comunicar); los subagentes realizan trabajo del *proyecto* (las unidades delegadas). El orquestador no realiza trabajo del proyecto delegable (`P-01`).

Fuente: `Principles.md P-01, P-03, P-14`; `Non-Goals.md §5`. Refinado en `03-Architecture/Agent-Model.md`.

---

### Subagente

**[Hecho]** — Agente especializado que ejecuta el trabajo concreto que le delega el orquestador. Su responsabilidad es limitada y su contexto reducido.

Fuente: `Principles.md P-01, P-03`; `Goals.md OBJ-09`; `Vision.md`.

---

### Trabajador

**[Hecho / sinónimo]** — Término alternativo de "subagente" usado en `P-16` para enfatizar que un subagente concreto es reemplazable mientras la capacidad permanezca.

Fuente: `Principles.md P-16`.

---

### Capacidad

**[Hecho]** — Lo que puede hacerse, independientemente de quién lo haga. Ejemplos citados: explorar, planificar, implementar, verificar, revisar, depurar, investigar.

Se separa explícitamente del agente concreto: distintos agentes pueden proporcionar la misma capacidad.

Fuente: `Principles.md P-14, P-16`; `Goals.md OBJ-09`.

---

## 4. Organización del trabajo

### Tarea

**[Hecho]** — Lo que el desarrollador solicita a AIES y que AIES resuelve. Puede descomponerse en una o más unidades de trabajo. Distinción formal con "unidad de trabajo" en `Task-Model.md`.

Fuente: `Vision.md`; `Goals.md OBJ-02, OBJ-05`; `Principles.md P-04, P-05`; `Task-Model.md`.

---

### Unidad de trabajo

**[Hecho]** — La porción pequeña y bien definida en la que se descompone una tarea, con objetivo, alcance, información necesaria, resultado esperado y condición de finalización. Modelo formal en `Task-Model.md`.

Fuente: `OBJ-05`; `P-04`; `REQ-F-13`; `Task-Model.md`.

---

### Descomposición

**[Hecho]** — Conversión de una tarea grande en unidades de trabajo con objetivo concreto y resultado verificable. No es dividir arbitrariamente; es convertir el trabajo en piezas comprensibles y verificables.

Fuente: `Problem.md §7`; `Principles.md P-04`.

---

### Sesión

**[Hecho]** — Periodo delimitado de trabajo del desarrollador con AIES para un proyecto. Puede contener varias tareas; una tarea incompleta puede continuar en una sesión posterior. No es equivalente a una tarea ni al entorno de ejecución concreto.

Fuente: `Problem.md §5`; `Goals.md OBJ-06`; `ADR-003`.

---

## 5. Estado y contexto

### Contexto

**[Hecho]** — La información que cada agente maneja durante su trabajo. Debe construirse de forma intencional (tarea + información relevante + resultados anteriores + restricciones necesarias), no como "todo lo ocurrido anteriormente".

Fuente: `Principles.md P-07`; `Problem.md §2`; `Goals.md OBJ-01`.

---

### Estado (de la tarea / del runtime)

**[Hecho, parcialmente delimitado]** — Representación explícita de lo que se sabe de la tarea en un momento dado: qué se está resolviendo, qué información se conoce, qué se ha hecho, qué resultados se han obtenido, cuántas iteraciones hay y qué sigue. No debe depender solo de la información implícita de una conversación.

Fuente: `Principles.md P-09`.

> Nota: `P-09` lo describe "al menos conceptualmente". Los campos concretos del estado se definirán en arquitectura, no aquí.

---

## 6. Recursos

### Modelo

**[Hecho]** — Un modelo de IA que AIES puede utilizar como recurso. No es parte de la identidad de AIES; debe poder cambiarse sin alterar los principios del runtime. El modelo a usar depende del trabajo (complejidad, razonamiento, velocidad, coste, fiabilidad, capacidad).

Fuente: `Non-Goals.md §2`; `Principles.md P-15`; `Goals.md OBJ-07`.

---

### Proveedor

**[Hecho]** — La fuente que ofrece modelos. AIES no compite con proveedores ni determina qué modelo es universalmente mejor.

Fuente: `Non-Goals.md §2`; `Principles.md P-14`.

---

## 7. Ejecución

### Decisión

**[Propuesta]** — La resolución que el orquestador toma en cada iteración del ciclo, a partir del estado explícito de la tarea, y que determina qué operación se pone en marcha y, cuando corresponde, qué ajuste recibe el plan de trabajo. La toma el orquestador, no ejecuta, no es delegable y debe ser observable.

Fuente: `Principles.md P-01, P-02, P-09, P-10, P-11, P-13`; `REQ-F-04, REQ-F-14…REQ-F-18`. Definida en `03-Architecture/Decision-Model.md`.

---

### Operación

**[Propuesta]** — Lo que una decisión pone en marcha. Una decisión produce exactamente una operación: obtener información, ejecutar una unidad, comunicar al desarrollador o terminar. Las operaciones delegables las ejecutan trabajadores; las no delegables, el orquestador. Toda operación produce un resultado que se incorpora al estado y alimenta la siguiente decisión.

Fuente: `Principles.md P-10, P-13`; `REQ-F-17, REQ-F-18`. Definida en `03-Architecture/Runtime-Model.md §4` y `03-Architecture/Decision-Model.md §4-§5`.

---

### Verificación

**[Hecho]** — Comprobación de que el resultado de una tarea es correcto, mediante mecanismos adecuados (tests, typecheck, build, análisis, revisión, comprobaciones específicas). Forma parte del trabajo; una tarea no termina solo por haber producido código. Debe ser proporcional al riesgo y complejidad.

Fuente: `Principles.md P-12`; `Goals.md OBJ-02`.

---

### AgentSession worker

**[Propuesta — `ADR-009`]** — Realización material de un **trabajador** en pi: una sesión efímera (`SessionManager.inMemory(cwd)`) con un allowlist de `tools` por capacidad. Recibe la unidad de trabajo vía `session.prompt`, emite eventos observables y devuelve el resultado (último texto + `usage`). El orquestador es también una `AgentSession`, pero con `noTools: "all"` y salida estructurada (`ADR-007`).

Fuente: `ADR-009-integracion-con-pi.md`; `MVP-v0-Scope.md §1, §2`.

---

### Host binding

**[Propuesta — `ADR-009`]** — El acoplamiento concreto entre AIES-core y el host (pi en v0): el módulo de código que crea las `AgentSession` por capacidad y orquestador, captura `usage`/`contextUsage` y delega el techo de contexto al `autoCompaction`. En v0 **no** se abstrae (`HostAgent`/`HostAdapter` se extrae al aparecer un 2.º host, `P-17`); cambiar de host exige refactor de este módulo.

Fuente: `ADR-009-integracion-con-pi.md`; `MVP-v0-Scope.md §5`.

---

## 8. Relación con la trazabilidad

Este glosario es el eslabón de lenguaje que permite conectar la cadena de trazabilidad:

```text
problema → objetivo → requisito → arquitectura → decisión → implementación → validación
```

Los requisitos que se redacten a continuación podrán referirse a estos términos sin ambigüedad. Los términos marcados **[Abierto]** son exactamente los puntos donde hará falta una decisión explícita (y trazable) más adelante, en lugar de una definición silenciosa.

---

## 9. Cuestiones abiertas pendientes de decisión

No quedan cuestiones abiertas de vocabulario de las identificadas inicialmente.

Resueltas en documentos posteriores: relación `harness`/`runtime` y papel del entorno de ejecución (`ADR-001`); ubicación física del harness y host concreto v0 (`ADR-009`); modelo formal de tarea/unidad de trabajo (`Task-Model.md`); definición y límites de sesión (`ADR-003`); mecanismo de continuidad/persistencia entre sesiones (`ADR-008`); orquestador único-vs-rol (`ADR-007`).

Incorporados como **[Propuesta]** en documentos posteriores: `decisión` (`03-Architecture/Decision-Model.md`) y `operación` (`03-Architecture/Runtime-Model.md §4`), pendientes de validación. Incorporados por MVP-v0 (`ADR-009`/`MVP-v0-Scope.md`): `pi (host v0)`, `AgentSession worker` y `host binding` — términos de realización material, no de identidad conceptual de AIES.
