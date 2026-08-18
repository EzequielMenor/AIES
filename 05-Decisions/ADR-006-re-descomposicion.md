# ADR-006 — Re-descomposición de unidades de trabajo

- **Estado:** Aceptada
- **Fecha:** 2026-08-14
- **Resuelve:** cuestión nº 2 de `Task-Model.md §7` (señales de re-descomposición); cuestión nº 2 de `Lifecycle.md §7`; cuestión nº 3 de `Decision-Model.md §13`; fila 4 de `02-Requirements/README.md`

---

## Contexto

`Lifecycle.md §4` fija que, si una unidad resulta demasiado grande o mal definida, la decisión puede sustituirla por varias unidades **Pendiente** (`REQ-F-15`). Pero las señales y reglas concretas quedan abiertas:

- `Task-Model.md §7.2` — qué señales hacen necesario dividir una `Work Unit` durante la ejecución.
- `Lifecycle.md §7.2` — reglas formales de re-descomposición → ADR.
- `Decision-Model.md §4.2` — re-descomponer pertenece a la **faceta de ajuste del plan** de la decisión (actúa sobre el estado, no sobre el proyecto); `§13.3` — las reglas formales → ADR.

Restricciones que condicionan la decisión:

- Cada unidad debe tener objetivo, alcance limitado, resultado esperado y condición de finalización (`REQ-F-13`), y debe ser pequeña y verificable (`REQ-F-12`, `P-04`).
- Un fallo de unidad no implica fallo de tarea; la unidad fallida vuelve al bucle, donde puede re-delegarse, corregirse o re-descomponerse (`P-13`, `REQ-F-16`, `Lifecycle.md §4`).
- La recuperación no debe producir pérdida de trabajo aceptado (`RNF-10`): los resultados parciales se conservan.
- La granularidad óptima equilibra verificabilidad y sobrecarga de coordinación (`Task-Model.md §7.1`, hipótesis `H-01`, `H-02`); no hay datos todavía para fijar tamaños.
- No añadir agentes, pasos ni complejidad artificialmente (`REQ-F-25`, `Non-Goals §5`, `P-17`).

---

## Opciones consideradas

### Opción A — Umbral de tamaño fijo: dividir si la unidad supera X

Regla numérica (p. ej. líneas de código, pasos previstos o duración estimada) que dispara la división.

Ventajas: determinista; fácil de aplicar.

Inconvenientes: no existe evidencia para elegir X (granularidad pendiente de medición, `Task-Model.md §7.1`, `H-01`, `H-02`); un umbral arbitrario contradice `P-17`; el tamaño no es la señal correcta — el riesgo, el alcance y la definición sí lo son (`REQ-F-06`, `REQ-F-13`); ignora que unidades pequeñas pero mal definidas también deben re-descomponerse.

### Opción B — Sin reglas: el orquestador re-descompone libremente

Ventajas: máxima flexibilidad.

Inconvenientes: la re-descomposición es un ajuste del plan **observable** (`P-11`, `REQ-F-10`, `Decision-Model.md §11`); sin señales declaradas no puede explicarse ni medirse; riesgo de sobre-descomposición (sobrecarga de coordinación, `Task-Model.md §7.1`) o de sub-descomposición sin contrapeso; contradice la capacidad de justificación exigida por `P-18`.

### Opción C — Señales estructurales + reglas de conservación, sin umbrales

Declarar las señales de necesidad y las reglas que toda re-descomposición respeta, sin fijar tamaños. La calibración de granularidad queda en medición.

Ventajas: hace la re-descomposición explicable y medible sin umbrales arbitrarios; coherente con el modelo aprobado (faceta de ajuste del plan, `Decision-Model.md §4.2`; sustitución por unidades Pendiente, `Lifecycle.md §4`); respeta `P-17` y `REQ-F-25`; conserva el trabajo aceptado (`P-13`, `RNF-10`).

Inconvenientes: no produce tamaños objetivos; la decisión sigue dependiendo del criterio del orquestador, sujeto a medición posterior.

---

## Decisión

**Opción C.**

1. **Señales de necesidad.** Cualquiera de estas señales justifica re-descomponer una unidad **En curso** o **Fallida**:

   - **Multiplicidad de resultados** — la unidad exigiría más de una condición de finalización o más de una capacidad para completarse: abarca trabajo que no puede evaluarse como un solo resultado verificable (`REQ-F-13`, `ADR-002`). Es la señal más fuerte.
   - **Fallo no localizable** — tras un fallo, la causa no se reduce a un aspecto acotado de la unidad; el fallo sugiere exceso de alcance, no un error puntual ni falta de información (`REQ-F-16`).
   - **Alcance ampliado por información nueva** — información obtenida durante la ejecución (`Task-Model.md §1`, `REQ-F-18`) revela que el alcance real supera el previsto.
   - **Iteraciones sin progreso** — la unidad acumula resultados que no la acercan a su condición de finalización ni reducen su incertidumbre. Se distingue de la irrecuperabilidad (`ADR-005`): aquí el problema es el tamaño o la definición, no la viabilidad; la re-descomposición es la respuesta cuando la señal es de tamaño/definición.

2. **Reglas de la re-descomposición.**

   - Cada unidad resultante debe satisfacer `REQ-F-13` (objetivo, alcance, resultado esperado y condición de finalización), ser verificable y suficientemente limitada (`P-04`).
   - La unidad re-descompuesta se **sustituye por varias unidades Pendiente** (`Lifecycle.md §4`); el trabajo parcial aceptado se conserva como resultado en el estado (`P-13`, `RNF-10`): la unidad original no desaparece sin dejar rastro.
   - **No es la primera respuesta a un fallo.** Corregir (re-delegar la misma unidad) y obtener información la preceden (`REQ-F-16`, `Decision-Model.md §6`); se elige cuando la señal es de tamaño o definición, no de error puntual ni de conocimiento insuficiente.
   - **Coste de coordinación.** Solo se re-descompone cuando la señal es real; la sobre-descomposición (unidades triviales) también es un fallo (`REQ-F-25`, `Task-Model.md §7.1`). La granularidad óptima se calibra con medición (`H-01`, `H-02`).
   - **Sin capacidad de trabajador.** La re-descomposición actúa sobre el estado; no requiere delegación (`Decision-Model.md §9`).
   - **Observable.** Queda registrada como ajuste del plan con su motivo (`Decision-Model.md §11`, `REQ-F-10`).

3. **Relación con el resto del modelo.** Re-descomponer es la faceta de plan de una decisión (`Decision-Model.md §4.2`), no una operación nueva (`Runtime-Model.md §4` se mantiene intacto). Una decisión típica combina la re-descomposición con la delegación de la primera unidad resultante.

---

## Consecuencias

- El runtime puede re-descomponer sin umbrales, guiado por las cuatro señales; la decisión queda explicable y medible (`P-11`, `P-18`).
- El trabajo aceptado se conserva siempre (`P-13`, `RNF-10`); la re-descomposición nunca equivale a reiniciar la tarea (`RNF-09`).
- La calibración numérica de la granularidad (tamaños, sobrecarga de coordinación) queda en medición (`Task-Model.md §7.1`, `H-01`, `H-02`).
- Documentos afectados, actualizados en consecuencia: `Task-Model.md §7.2` (resuelto), `Lifecycle.md §4, §7.2` (resuelto), `Decision-Model.md §13.3` (resuelto), `02-Requirements/README.md` (fila 4 de cuestiones abiertas).
- **Fuera del alcance de este ADR**: granularidad óptima (medición, `Task-Model.md §7.1`); política de límites e irrecuperabilidad (`ADR-005`); persistencia entre sesiones (ADR posterior).

---

## Referencias

- `Task-Model.md §1, §2, §3, §4, §7` — información ampliable; definición de unidad; relación tarea → unidad; finalización; granularidad y señales pendientes.
- `Lifecycle.md §4, §5, §7.2` — sustitución por unidades Pendiente; bucle; reglas pendientes.
- `Decision-Model.md §4.2, §6, §7, §9, §11, §13.3` — ajuste del plan; repertorio ante fallos; información insuficiente; capacidades; observabilidad.
- `Functional-Requirements.md REQ-F-12, REQ-F-13, REQ-F-15, REQ-F-16, REQ-F-18, REQ-F-25` — descomposición; definición de unidad; cambio de estrategia; fallo; información antes de ejecutar; sin agentes artificiales.
- `Principles.md P-04, P-06, P-11, P-13, P-17, P-18` — unidades pequeñas; mínimo necesario; observabilidad; no reinicio total; crecimiento; justificación.
- `Non-Functional-Requirements.md RNF-09, RNF-10, RNF-11` — no reinicio total; conservación del trabajo; reconstrucción.
- `ADR-002-rol-de-verificacion.md` — verificación como segunda delegación.
- `ADR-005-limites-e-irrecuperabilidad.md` — frontera con el criterio de irrecuperable.
