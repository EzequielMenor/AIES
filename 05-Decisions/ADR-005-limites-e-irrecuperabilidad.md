# ADR-005 — Límites de ejecución e irrecuperabilidad

- **Estado:** Aceptada
- **Fecha:** 2026-08-14
- **Resuelve:** cuestión nº 1 de `Lifecycle.md §7` (límite de iteraciones / criterio de irrecuperable); cuestión nº 1 de `Runtime-Model.md §9`; cuestión nº 2 de `Decision-Model.md §13`; cuestión nº 5 de `Non-Functional-Requirements.md §6` (política al alcanzar límites)

---

## Contexto

`RNF-18` exige que toda ejecución esté sujeta a límites de **duración, iteraciones, coste y consumo de contexto/tokens**, con valores por defecto y umbrales pendientes. `RNF-19` exige que al alcanzar un límite el sistema lo haga observable y evite continuar de forma silenciosa o ilimitada: el resultado vuelve al bucle de decisión o produce una terminación controlada. `RNF-20` exige límites distintos según las características de la tarea, no un límite universal.

Dónde queda la decisión abierta:

- `Lifecycle.md §5` — "Si existe un límite de iteraciones o un criterio para declarar la tarea irrecuperable, y cuál es → ADR".
- `Runtime-Model.md §9.1` — valores y política de límites (cuándo detener, intervenir, cambiar de estrategia o declarar irrecuperable) → ADR.
- `Decision-Model.md §8` — terminar por límite es una decisión de terminación posible y observable; la política concreta → ADR.
- `Non-Functional-Requirements.md §6.5` — cuándo detener, pedir intervención, cambiar de estrategia o declarar irrecuperable.

Restricciones que condicionan la decisión:

- El número de iteraciones forma parte del estado explícito (`P-09`, `Lifecycle.md §5`); los límites aplicables también (`Runtime-Model.md §3.1`).
- Un fallo no debe obligar a reiniciar todo el proceso, y la recuperación no debe producir pérdida de trabajo aceptado ni estado inconsistente (`P-13`, `RNF-10`).
- El desarrollador puede intervenir, detener o restringir el trabajo en curso (`REQ-F-11`, `RNF-04`, `P-20`).
- El fin de una sesión no cambia el estado de la tarea (`ADR-003`): los límites de ejecución son distintos de la frontera de sesión.
- No hay datos todavía para calibrar valores numéricos (umbrales, presupuestos, baselines → `NFR §6.1-6.3`, hipótesis `H-01`…`H-06`).

---

## Opciones consideradas

### Opción A — Límites fijos universales con valores definidos en este ADR

Fijar aquí duración máxima, número máximo de iteraciones, presupuesto y tope de contexto.

Ventajas: determinista desde ya; sin ambigüedad operativa.

Inconvenientes: contradice `RNF-20` (límites distintos según la tarea); no existe evidencia para elegir valores (baselines pendientes, `NFR §6`); valores arbitrarios contradicen `P-17` y `REQ-F-27`; un límite único mal calibrado dañaría tanto tareas triviales como complejas.

### Opción B — Sin límites; el desarrollador detiene cuando lo considere

Ventajas: máxima libertad; cero configuración.

Inconvenientes: contradice `RNF-18` (toda ejecución sujeta a límites) y `OBJ-02` (proceso proporcional y controlado); coste y consumo de contexto quedarían sin cota frente a tareas mal planteadas; `RNF-19` quedaría vacío; no satisface el control que persigue `P-20`.

### Opción C — Estructura de límites + política de respuesta + criterio de irrecuperable, sin valores numéricos

Fijar qué dimensiones se limitan, cómo se configuran por tarea, qué respuesta produce cada límite alcanzado y cuándo una tarea se declara irrecuperable. Los valores concretos quedan en perfiles por defecto sujetos a medición.

Ventajas: satisface `RNF-18/19/20` sin calibrar números sin evidencia; coherente con el modelo aprobado (`Runtime-Model.md §6` — el límite entra como resultado; `Decision-Model.md §8` — terminación por límite observable); deja la calibración en medición donde pertenece (`NFR §6`).

Inconvenientes: no produce valores operativos todavía; requiere perfiles por defecto posteriores a la medición.

---

## Decisión

**Opción C.**

1. **Estructura de límites.** Toda tarea tiene límites aplicables en las cuatro dimensiones de `RNF-18`: **duración, iteraciones, coste y consumo de contexto/tokens**. Los límites de la tarea forman parte del estado (`Runtime-Model.md §3.1`) y son **configurables por el desarrollador** (`RNF-20`, `REQ-F-11`): la tarea puede declarar límites propios; si no los declara, se aplica el perfil por defecto. El perfil por defecto se calibra con medición (`NFR §6.1`); no se fija numéricamente en este ADR.

2. **Respuesta al alcanzar un límite.** El límite alcanzado entra al bucle como un resultado más (`RNF-19`, `Runtime-Model.md §6`) y produce una nueva decisión. Repertorio de respuestas, en orden de preferencia:

   - **Terminar controladamente** — siempre disponible: **Completada** si las condiciones de finalización ya se cumplen (`P-12`), **Fallida** en caso contrario, con la causa documentada (`RNF-19`).
   - **Pedir intervención** — comunicar al desarrollador para ampliar el límite, ajustar restricciones o detener (`REQ-F-11`). Es la respuesta por defecto cuando ninguna otra aplica.
   - **Cambiar de estrategia** — ajuste del plan (`Decision-Model.md §4.2`) cuando el límite alcanzado revela que el plan era inadecuado, solo si la tarea lo permite y no se ha agotado el margen de la dimensión alcanzada.
   - **Continuar con ampliación preautorizada** — solo si los límites de la tarea lo prevén (p. ej. límite progresivo declarado por el desarrollador). Es la **única vía de continuación sin intervención**; nunca ilimitada ni silenciosa.

   Regla: **nunca continuación silenciosa ni automática ilimitada** (`RNF-19`).

3. **Criterio de irrecuperable.** Una tarea es declarable **irrecuperable** cuando se cumplen ambas condiciones:

   - el repertorio de respuestas al fallo —corregir, obtener información, cambiar de estrategia o re-descomponer (`REQ-F-16`, `Decision-Model.md §6`)— se ha recorrido sin que el estado redujera la incertidumbre ni produjera progreso hacia la condición de finalización;
   - la siguiente acción razonable sería pedir intervención.

   Ante una tarea irrecuperable, el orquestador **comunica al desarrollador antes de terminar**; si no hay intervención, termina como **Fallida** con la causa registrada. La terminación conserva el trabajo aceptado: los resultados parciales permanecen en el estado (`P-13`, `RNF-10`).

4. **Relación con la sesión.** Los límites de ejecución son del ciclo de la tarea, no de la sesión (`ADR-003`); la continuidad de una tarea entre sesiones es materia del ADR de persistencia y no se resuelve aquí.

5. **Priorización.** Al alcanzar un límite, la conservación del trabajo y la observabilidad prevalecen sobre el avance (`P-13`, `RNF-10`, `RNF-11`): la respuesta escogida queda registrada como decisión observable (`Decision-Model.md §11`).

---

## Consecuencias

- Los límites son parte del estado de la tarea y configurables por el desarrollador (`RNF-20`); la configuración por defecto se calibra con medición (`NFR §6`).
- Toda terminación por límite es una decisión observable con causa documentada (`RNF-19`); se puede reconstruir qué límite se aplicó, cuál se alcanzó y qué decisión posterior se tomó (criterio de medición de `RNF-19`).
- La declaración de irrecuperabilidad es explícita, pasa por intervención y no pierde trabajo aceptado (`RNF-10`).
- Documentos afectados, actualizados en consecuencia: `Lifecycle.md §5, §7.1` (resuelto), `Runtime-Model.md §6, §9.1` (resuelto), `Decision-Model.md §8, §13.2` (resuelto), `Non-Functional-Requirements.md §6.5` (política resuelta; valores y perfiles siguen en medición), `02-Requirements/README.md` (fila 3 de cuestiones abiertas).
- **Fuera del alcance de este ADR**: valores numéricos, presupuestos y perfiles por defecto (`NFR §6`, medición); reglas de re-descomposición (ADR siguiente); persistencia entre sesiones (ADR posterior); comprobación de afirmaciones de capacidad (medición).

---

## Referencias

- `Non-Functional-Requirements.md RNF-04, RNF-10, RNF-11, RNF-18…RNF-20, §6.1-6.5` — control; recuperación; observabilidad; límites; umbrales y política pendientes.
- `Principles.md P-09, P-12, P-13, P-17, P-20` — estado explícito; verificación; no reinicio total; crecimiento; control.
- `Runtime-Model.md §3.1, §6, §9.1` — límites en el estado; límite como resultado; política pendiente.
- `Decision-Model.md §4.2, §6, §8, §11, §13.2` — ajuste del plan; repertorio ante fallos; terminación por límite; observabilidad.
- `Lifecycle.md §3, §5, §7.1` — intervención; iteraciones en el estado; límite e irrecuperable pendientes.
- `Task-Model.md §4, §5` — finalización; estados.
- `ADR-003-limites-de-sesion.md` — sesión ≠ tarea; frontera de sesión.
