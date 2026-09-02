# ADR-013 — Fiabilidad estructural y recuperación autónoma del runtime

- **Estado:** Aceptada
- **Fecha:** 2026-08-25
- **Resuelve:** la validación práctica de la capa de fiabilidad estructural del runtime y la
  regresión de recuperación ante una implementación incorrecta del worker.

---

## Contexto

AIES debe aceptar tareas expresadas como lenguaje humano normal y mantener la intención mientras
coordina workers efímeros. La estructura interna es necesaria para que esa flexibilidad no se
convierta en supervisión manual constante: el runtime debe controlar el estado, las mutaciones del
plan, la verificación y los límites, pero no inventar requisitos ni pedir una especificación formal
para cada tarea.

La batería de dogfooding de `runtime/tests/dogfooding.test.ts` validó siete recorridos con fixtures
temporales y dobles deterministas de orquestador/worker, además de las regresiones de no-progreso y
checkpoint. Esta decisión describe las invariantes observadas en esa implementación; no promete que
un modelo concreto siempre interprete correctamente cualquier petición ambigua.

## Decisión

### 1. Ownership de la intención

La petición humana se conserva como `Task` canónica. El Orchestrator puede convertirla en contexto,
unidades y criterios, pero no puede sustituir requisitos literales ni ejecutar cambios. El runtime
es el dueño del `RuntimeState`, resuelve las referencias y decide qué mutaciones son válidas.

### 2. Contrato de `WorkUnit` y `WorkerReport`

Cada unidad contiene objetivo, alcance, resultado esperado, condición de finalización, capacidad,
requisitos literales y criterios de aceptación observables. El worker recibe el `Task` original y la
unidad canónica, y termina con un `WorkerReport` estructurado. Un reporte ausente o inválido no se
interpreta como éxito: la unidad queda insatisfecha.

Los requisitos literales y los criterios no son texto decorativo. Se conservan al corregir una
unidad y forman parte de la evidencia que decide si la unidad puede cerrar.

### 3. Mutación del plan e IDs

El ajuste de plan se aplica dentro del runtime antes de la operación del mismo turno. Las nuevas
unidades reciben IDs canónicos generados por runtime (`u<n>`); el Orchestrator sólo puede referirse a
ellas por índice planificado durante ese turno o por ID existente válido.

Una corrección o cambio de estrategia crea una unidad nueva y marca la anterior como `Sustituida`.
Una mutación de reemplazo que no apunta exclusivamente a unidades reemplazables se rechaza sin
crear unidades huérfanas. El trabajo aceptado y las unidades sustituidas siguen siendo observables,
pero no bloquean la terminación si la sustitución posterior satisface la intención.

Toda ejecución de worker tiene un checkpoint previo. La unidad no se ejecuta si ese checkpoint
falla; el estado se puede persistir también después de la ejecución para reconstruir el recorrido.

### 4. Pausa, espera humana y comunicación

`paused_by_user` representa una detención externa reanudable. `waiting_for_user` representa una
decisión humana que el runtime no puede inferir de la evidencia del proyecto. Son estados
operacionales distintos de `taskState`.

`comunicar al desarrollador` es una operación bloqueante: exige una pregunta, una razón cerrada y la
información faltante; no ejecuta ningún worker, no vuelve a invocar el Orchestrator y persiste la
petición. El loop sólo continúa cuando existe una nueva entrada humana, por ejemplo mediante
`/resume` con una guía. No se usa esta vía para delegar al usuario un error que AIES puede localizar
o corregir.

La intervención humana es apropiada para ambigüedad de producto o arquitectura con consecuencias
incompatibles, acciones destructivas/irreversibles, credenciales o información externa no
descubrible, elecciones subjetivas genuinas y ampliaciones explícitas de límites. Un worker
equivocado con intención clara no pertenece a esta lista.

### 5. Verificación proporcional

La verificación se elige según la evidencia necesaria. Un cambio trivial puede cerrarse con
comprobaciones deterministas directas; una tarea que necesita una comprobación separada puede usar
un Verifier. El runtime no exige una ronda LLM si `grep`, tests, typecheck, build o una lectura del
artefacto ya prueban los criterios.

La terminación `completed` es estricta: no se acepta mientras haya unidades activas sin satisfacer
y la verificación final no puede declarar éxito a partir de un reporte ausente.

### 6. Recuperación autónoma

Cuando la verificación o el reporte detectan un mismatch, el runtime conserva la intención original,
marca el resultado incorrecto y permite un replan dirigido con `feedbackCorrectivo`. El replan se
persiste antes de ejecutar la corrección, que recibe de nuevo los requisitos y criterios vinculantes.
La recuperación termina sólo después de verificar la nueva unidad; no requiere intervención humana
si la corrección es inferible.

### 7. No-progreso

`consecutiveNoProgress` mide repetición equivalente, no el mero hecho de que un worker haya fallado.
Cuenta como progreso la evidencia informativa nueva, un cambio material de unidad o estrategia,
una causa/reporte nuevo y la reducción de criterios incumplidos. Un reporte o hallazgo repetido no
reinicia el contador.

El contador es consecutivo y acotado por `maxConsecutiveNoProgress`. Al agotarse, el runtime produce
una terminación controlada y observable en lugar de continuar silenciosamente o preguntar lo mismo
de forma indefinida. Los valores concretos siguen siendo configurables y sujetos a medición; esta
decisión no fija presupuestos universales.

## Consecuencias

- El lenguaje humano sencillo llega al Orchestrator como `Task`; no hay formulario o especificación
  adicional obligatoria para iniciar una tarea.
- La intención está protegida por el contrato de unidad, los IDs controlados por runtime y los
  reportes estructurados, en vez de depender de convenciones textuales del worker.
- La recuperación autónoma es una transición normal del loop, no un reinicio de tarea ni una
  conversación humana automática.
- El coste puede medirse por decisiones, workers, explorers, verifiers, verificaciones
  deterministas, replans, esperas humanas, tokens y coste a través del log y del arnés de
  dogfooding.
- La proporcionalidad es una política verificable, no una garantía de un número fijo de turnos para
  todas las tareas.

## Evidencia y límites

La batería local validó A-G con dobles deterministas: tareas completadas en 2-3 turnos cuando la
intención era suficiente, recuperación C en 3 turnos y no-progreso G acotado en 4 observaciones.
También comprobó cero ejecución durante `waiting_for_user`, persistencia pre-ejecución, IDs
canónicos y ausencia de errores de schema en la regresión de recuperación.

Estos casos no sustituyen una campaña con proveedores reales. Queda fuera de este ADR medir la
calidad lingüística de cada modelo, calibrar presupuestos económicos universales y evaluar el gusto
visual de mejoras subjetivas.

## Referencias

- `runtime/src/core/loop.ts` — ownership del ciclo, checkpoints, recuperación y no-progreso.
- `runtime/src/core/state.ts` — `WorkUnit`, `WorkerReport`, `RunStatus`, IDs y mutación del plan.
- `runtime/src/orchestrator/parse.ts` — frontera Zod y parsing estricto.
- `runtime/src/workers/tools.ts` — contrato completo y normalización del reporte.
- `runtime/tests/dogfooding.test.ts` — escenarios A-G y regresión de recuperación semántica.
- ADR-005 — límites e irrecuperabilidad.
- ADR-006 — re-descomposición.
- ADR-008 — persistencia y recuperación.
- ADR-012 — pausa reanudable por intervención externa.
