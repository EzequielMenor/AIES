# ADR-007 — Orquestador: agente único o rol intercambiable

- **Estado:** Aceptada
- **Fecha:** 2026-08-14
- **Resuelve:** cuestión nº 1 de `Component-Model.md §5` y de `Agent-Model.md §10`; `[Pendiente]` de `Component-Model.md §2.2` y `Agent-Model.md §3.1`. Realiza `ADR-009` para el caso del orquestador.

---

## Contexto

`P-01` fija al orquestador como coordinador, y `P-14`/`P-15` apuntan a que todo agente —incluido el de coordinación— es, en principio, sustituible. De ahí quedó abierta la pregunta: ¿el orquestador es **un único agente** o un **rol** que pueden ocupar distintos agentes/modelos? (`Component-Model.md §5.1`, `Agent-Model.md §10.1`).

La pregunta no es ociosa: la respuesta condiciona cómo se cambia el modelo del orquestador, si se puede tener más de uno, y a qué se parece la "sustituibilidad" de un agente cuyo trabajo es **coordinar, no ejecutar** (`P-02`, `REQ-F-04`).

Restricciones que condicionan la decisión:

- `P-01`/`REQ-F-03` — el orquestador no usa herramientas de proyecto para el trabajo delegable; `ADR-009` ya fija que esto se **hace valer en código** (`noTools: "all"`), no por prompt.
- `ADR-004` — ya decidió que la evaluación del proceso la realiza el orquestador como parte de la decisión, y que la selección de modelo es por la naturaleza del trabajo. Este ADR **no reabre** los criterios de selección; fija la *realización* del rol orquestador.
- `Decision-Model.md §2/§4` — la decisión produce exactamente una operación y, opcionalmente, un ajuste del plan, con un motivo observable. El orquestador debe emitir esa salida de forma **estructurada**.
- `P-17`/`REQ-F-27` — no introducir complejidad antes de una necesidad demostrada; no hay evidencia aún de que haga falta más de un orquestador.
- `Non-Goals §5` — no debe añadirse un agente sin ventaja real.

---

## Opciones consideradas

### Opción A — Orquestador único fijo en v0; realizado como `AgentSession` sin tools + salida estructurada

Una sola configuración de orquestador: una `AgentSession` con `noTools: "all"` y un system prompt que exige decisión JSON `{ operación, ajustePlan?, motivo }` (la faceta `condición` se añade al terminar, `Decision-Model.md §11`).

Ventajas: satisface `P-01` por **ausencia** de herramientas en su sesión (reforzado en código, no por disciplina); `ADR-009` ya lo materializa sin código extra; `P-17` — un único orquestador es lo mínimo; al ser una mera `AgentSession` configurada, cambiar de modelo es un cambio de config (`setModel`), sin rediseño; deja el "rol intercambiable" **habilitado** sin construirlo todavía.

Inconvenientes: no permite, hoy, varios orquestadores con especialización (p. ej. uno de planificación y otro de terminación). No hay necesidad demostrada que lo justifique (`P-17`).

### Opción B — Rol intercambiable desde v0: interfaz `Orchestrator` con varias implementaciones

Definir una interfaz de orquestador y al menos dos implementaciones (p. ej. por tipo de decisión) desde el primer momento.

Ventajas: máxima flexibilidad formal; simetría con la sustituibilidad de los trabajadores (`P-16`).

Inconvenientes: contradice `P-17`/`REQ-F-27`/`Non-Goals §5` — sin necesidad demostrada, se diseña una interfaz y dos implementaciones a ciegas; la coordinación es **una** responsabilidad no delegable (`Agent-Model.md §3.1`), así que la especialización "por tipo de decisión" no aporta ventaja real mientras la evalúe el mismo modelo; añade complejidad sin requisito que la exija.

### Opción C — Orquestador no-agente: código determinista, sin LLM

Realizar el orquestador con reglas fijas que mapeen estado a operación, sin modelo.

Ventajas: determinismo total; coste cero del orquestador.

Inconvenientes: contradice `ADR-004` — la evaluación de las seis dimensiones de `REQ-F-06` y la selección del proceso por contrato son **juicio**, no un mapeo determinista; un orquestador de reglas o reescalona trabajo que un LLM haría mejor, o endurece el proceso y contradice `P-05`/`P-06` (proceso mínimo adaptado a la tarea). El orquestador no ejecuta, pero sí **razona** sobre el estado.

---

## Decisión

**Opción A.**

1. **Único fijo en v0.** Existe una sola configuración de orquestador. No se introduce más de un orquestador hasta que la medición (`06-research/`) demuestre necesidad (`P-17`).

2. **Realización** (sobre `ADR-009`): el orquestador es una `AgentSession` con:
   - `noTools: "all"` — **sin herramientas de proyecto**; `P-01`/`REQ-F-03` se garantizan por ausencia, reforzada en código.
   - un model asignado por config (p. ej. thinking-capaz para decidir proceso); `thinkingLevel` por defecto `low` en v0 (provisional, recalibrable en `06-research/`).
   - un **system prompt de salida estructurada** que produce el contrato de `Decision-Model.md §2/§4`:
     ```json
     {
       "operación": "obtener información" | "ejecutar una unidad" | "comunicar al desarrollador" | "terminar",
       "ajustePlan": { "tipo": "...", "unidades": [...] } | null,   // faceta de plan (§4.2)
       "motivo": "<qué del estado la justifica>",
       "condición": "<cumplida o causa de inviabilidad>"            // sólo cuando operación = terminar
     }
     ```
   El parseo de esta salida es robusto: si falla, **no** se reinicia el bucle — se trata como *información insuficiente* (`REQ-F-18`/`P-13`) y se reentra con el estado (`MVP-v0-Scope.md §2`).

3. **Futuro: rol intercambiable habilitado, no construido.** Como el orquestador es una `AgentSession` configurada, "rol intercambiable" queda habilitado como **cambio de config** (otro modelo, otro `thinkingLevel`, otro system prompt) sin rediseño del runtime. La necesidad de **varios** orquestadores se difiere a medición (`P-17`); el modelo del orquestador es un recurso intercambiable (`P-15`, `Non-Goals §2`), no parte de su identidad.

4. **No ejecuta, y no puede.** La ausencia de `tools` de proyecto en su sesión significa que el orquestador **no dispone** de protección para hacer el trabajo delegable: la frontera `P-01` es estructural, no una promesa del prompt.

---

## Consecuencias

- El orquestador de v0 está completo y *implementation-ready*: una `AgentSession` sin herramientas + un system prompt que emite decisión JSON. Cantidad mínima de sistema (`P-17`).
- `P-01`/`REQ-F-03` se hacen valer en código (`noTools`), no en el prompt — coherente con `ADR-009`.
- "Rol intercambiable" deja de ser una pregunta abierta y pasa a ser una **posibilidad de config**; `RNF-14` (cambiar modelo sin cambiar el proceso) aplica al orquestador sin más.
- No se reabren los criterios de `ADR-004` (evaluación y selección): el orquestador ya definido se limita a **ejecutar** esa evaluación como parte de su decisión.
- Documentos afectados, actualizados en consecuencia: `Component-Model.md §2.2, §5` (cuestión nº 1 resuelta), `Agent-Model.md §3.1, §4, §10` (cuestión nº 1 resuelta), `Glossary.md §3` (orquestador).
- **Fuera del alcance de este ADR**: los criterios de decisión (`ADR-004`); el binding material con pi (`ADR-009`); el contract JSON detallado y el parseo robusto (`MVP-v0-Scope.md §2`); la calibración de `thinkingLevel` y la necesidad de varios orquestadores (medición, `06-research/`).

---

## Referencias

- `Principles.md P-01, P-02, P-05, P-06, P-14, P-15, P-16, P-17, P-20` — orquestador no ejecuta; separación decidir/hacer; proceso adaptado; mínimo necesario; capacidad/modelo; sustituibilidad; crecimiento; control.
- `Functional-Requirements.md REQ-F-03, REQ-F-04, REQ-F-18, REQ-F-26, REQ-F-27` — sin tools delegables; decidir≠hacer; información insuficiente; sustituir agente; crecimiento.
- `03-Architecture/Agent-Model.md §3.1, §4, §10` — orquestador pendiente de único-vs-rol; tabla comparativa; cuestión abierta.
- `03-Architecture/Component-Model.md §2.2, §5` — elemento orquestador y cuestión nº 1.
- `03-Architecture/Decision-Model.md §2, §4, §11` — contrato de decisión (operación + ajustePlan + motivo + condición).
- `ADR-004-criterios-de-decision.md` — la evaluación del proceso la hace el orquestador como parte de la decisión (no se reabre).
- `ADR-009-integracion-con-pi.md` — realización material del orquestador como `AgentSession` con `noTools: "all"`.