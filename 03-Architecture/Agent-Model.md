# AIES — Modelo de agentes

Este documento define **qué es un agente dentro de AIES**, los dos roles que existen (orquestador y trabajador) y los límites conceptuales de su responsabilidad. Es el modelo del "quién"; el modelo del "qué" está fijado en `Capability-Model.md` y no se redefine aquí.

Deriva de `P-01`, `P-02`, `P-03`, `P-07`, `P-14`, `P-16`, `P-20`, de `REQ-F-03`, `REQ-F-24`…`REQ-F-26`, de `RNF-03`, `RNF-05`, de `Component-Model.md §2.2-2.3` y de `ADR-002`. Usa el vocabulario de `Glossary.md`.

No define qué agentes concretos existen, ni modelos, proveedores, prompts, permisos, herramientas ni implementación física.

---

## 1. Convenciones

- **[Hecho]** — Impuesto por `01-Concept/`, requisitos validados o ADRs.
- **[Propuesta]** — Modelo propuesto que requiere validación.
- **[Pendiente]** — Aspecto que requiere una decisión posterior (ADR) o un documento posterior.

---

## 2. Qué es un agente

**[Hecho, refinado]** — Un agente es una **entidad dentro de AIES con responsabilidades delimitadas, contexto propio y autonomía limitada por el harness** (`Glossary.md §3`, refinado en este documento; `P-20`, `RNF-05`).

La distinción relevante entre agentes no es si "realizan trabajo" —todos trabajan— sino **qué tipo de trabajo** realizan:

```text
trabajo de coordinación   →  orquestador (decidir, delegar, comunicar)
trabajo del proyecto      →  trabajadores (las unidades delegadas)
```

Esta distinción resuelve la tensión entre `P-01` ("el orquestador no realiza el trabajo") y la inclusión del orquestador bajo el término "agente": el orquestador no realiza trabajo del proyecto **delegable** (`P-01`, `REQ-F-03`), pero sí realiza el trabajo de coordinación, que no es delegable.

**[Hecho]** — Un agente no es un modelo ni un proveedor. El modelo es un recurso que el agente utiliza; puede cambiar sin cambiar la identidad conceptual del agente (`P-15`, `Non-Goals §2`).

---

## 3. Los dos roles

**[Propuesta]** — AIES distingue dos **roles funcionales**, no dos jerarquías ni dos tipos de identidad:

```text
                        Agente
                          │
            ┌─────────────┴─────────────┐
            ▼                           ▼
      Orquestador                  Trabajador
      (coordina)                   (ejecuta)
      · entiende el estado         · recibe una unidad + contexto
      · decide qué hacer           · la realiza con sus medios
      · selecciona la capacidad    · devuelve el resultado
      · delega y recibe
      · comunica al desarrollador
```

La distinción es de rol: **qué tipo de trabajo puede realizar cada uno**. No implica que uno sea "superior" al otro, ni que sean entidades de naturaleza distinta: ambos son agentes con responsabilidades limitadas. El orquestador es un agente atípico solo en que su responsabilidad es la coordinación, no la ejecución del proyecto.

### 3.1 Orquestador

**[Hecho]** — El único punto de contacto entre el desarrollador y los trabajadores (`Non-Goals §1`, `P-01`). Sus responsabilidades están fijadas en `P-01` y `Component-Model.md §2.2`: entender el estado, decidir qué debe hacerse, seleccionar la capacidad, delegar, recibir resultados y comunicar al desarrollador.

**[Hecho / restricción]** — No realiza el trabajo delegable: no usa herramientas de lectura, escritura o modificación del proyecto para ese trabajo (`P-01`, `REQ-F-03`). Coordinar **no es una capacidad delegable**: el orquestador no puede delegar la decisión sobre el proceso de la tarea en un trabajador (coherente con `Capability-Model.md §8`).

**[Resuelto en `ADR-007`]** — El orquestador es **único fijo en v0**: una `AgentSession` con `noTools: "all"` + system prompt de salida estructurada (`ADR-009`). El "rol intercambiable" queda habilitado como **cambio de config** (otro modelo/`thinkingLevel`/prompt), sin rediseño (`P-14`, `P-15`); varios orquestadores se difieren a medición (`P-17`).

### 3.2 Trabajador (subagente)

**[Hecho]** — Agente que acepta unidades de trabajo delegadas por el orquestador y las realiza (`Glossary.md §3`; `P-01`, `P-03`). Los términos **trabajador** y **subagente** designan el mismo concepto; "trabajador" enfatiza su sustituibilidad (`P-16`).

**[Hecho]** — Es especializado: recibe responsabilidades concretas y un contexto reducido, con el fin de limitar lo que debe manejar simultáneamente (`P-03`, `OBJ-09`). La especialización justifica su existencia; un trabajador no existe por añadir componentes (`REQ-F-25`, `Non-Goals §5`).

**[Hecho]** — Es reemplazable: otro trabajador que proporcione la misma capacidad puede sustituirlo sin cambiar el proceso de resolución de la tarea (`P-16`, `REQ-F-26`).

**[Pendiente]** — Qué trabajadores concretos existen es decisión posterior. Los nombres citados en `P-01` (explorer, planner, implementer, verifier, reviewer) son **ilustrativos**, no un catálogo de roles fijos (`Component-Model.md §2.3`). En particular, no existe un trabajador verificador obligatorio: verificar es una capacidad, no un tipo de agente (`ADR-002`).

---

## 4. Qué diferencia al orquestador de un trabajador

**[Propuesta]** — Consolidación de lo fijado en `P-01`, `P-02` y los modelos anteriores:

| Dimensión | Orquestador | Trabajador |
|---|---|---|
| Tipo de trabajo | Coordinación | Proyecto |
| Entrada | Tarea, estado explícito, resultados, intervenciones | Una unidad de trabajo + contexto intencional |
| Decide el proceso | Sí (`P-02`) | No |
| Delega | Sí | No |
| Habla con el desarrollador | Sí (`R-1`, `R-2`) | No |
| Usa herramientas del proyecto | No para trabajo delegable (`REQ-F-03`) | Sí, según su unidad (`R-6`) |
| Mantiene el estado de la tarea | Lo lee y actualiza (`R-5`, `P-09`) | No |
| Sustituible | Sí, vía config (`ADR-007`) | Sí (`P-16`) |

---

## 5. Trabajador y capacidad

**[Hecho]** — La relación está fijada en `Capability-Model.md §5-§6` y no se redefine: un trabajador proporciona una o más capacidades; una capacidad puede ser proporcionada por varios trabajadores; proporcionar una capacidad es una afirmación sobre el trabajo que el trabajador puede aceptar, no sobre su identidad, modelo o procedimiento interno.

**[Propuesta]** — Corolario desde el lado del trabajador:

```text
Capacidad  = qué debe hacerse    (el contrato)
Trabajador = quién puede hacerlo (la variable)
```

- La especialización (`P-03`) limita **cuántas** capacidades tiene sentido que un trabajador concentre: suficientes para ser útil, pocas para mantener su responsabilidad limitada.
- Lo que un trabajador declare proporcionar no cambia lo que la capacidad exige: el contrato (entrada, resultado) pertenece a la capacidad, no al trabajador.
- Dos trabajadores que proporcionan la misma capacidad pueden diferir en todo lo demás —modelo, proveedor, configuración, procedimiento interno— sin que ello afecte al proceso (`RNF-14`).

**[Pendiente]** — Cómo se comprueba que un trabajador realmente proporciona lo que declara → medición/implementación (`Capability-Model.md §10`).

---

## 6. El contrato de delegación

**[Propuesta]** — Lo que un trabajador recibe y devuelve, consolidando `P-07`, `R-3`, `R-4` y `Capability-Model.md §3`:

### Qué recibe

```text
Unidad de trabajo (objetivo, alcance, resultado esperado,
                   condición de finalización)
+
contexto intencional:
  información relevante
  + resultados de etapas anteriores
  + restricciones necesarias
```

y **no** "todo lo ocurrido anteriormente" (`P-07`). El contexto lo construye el orquestador de forma intencional; el trabajador no decide qué contexto necesita la tarea, aunque puede devolver que le falta información (§7).

### Qué devuelve

Un **resultado** (`R-4`):

- evaluable frente a la condición de finalización de la unidad (`Task-Model.md §4`);
- éxito o fallo, incluida una verificación insatisfactoria (`P-13`, `ADR-002`);
- que se incorpora al estado y alimenta la siguiente decisión del orquestador (`P-13`, `REQ-F-17`).

Un trabajador **no devuelve decisiones sobre el proceso**: no decide si la tarea continúa, termina o cambia de estrategia. Devuelve el resultado de su unidad; la decisión pertenece al orquestador.

---

## 7. Límites conceptuales de responsabilidad del trabajador

**[Propuesta]** — Un trabajador, en tanto que ejecutor de una unidad delegada:

1. **No decide el proceso de la tarea** — ni el orden, ni qué capacidad sigue, ni si la tarea termina.
2. **No descompone** — recibe unidades ya definidas; la descomposición y re-descomposición pertenecen al bucle de decisión (`Task-Model.md §3`, `Lifecycle.md §4`).
3. **No se comunica con el desarrollador** — la comunicación es responsabilidad exclusiva del orquestador (`R-1`, `R-2`).
4. **No se comunica con otros trabajadores** — no existe relación trabajador↔trabajador en el modelo de componentes; la coordinación entre unidades fluye por el orquestador y el estado.
5. **No mantiene el estado de la tarea** — el estado es del runtime (`P-09`); el trabajador recibe el contexto que el orquestador considera necesario.
6. **No ve más que su contexto** — otras unidades, otras tareas y el conjunto del proyecto solo existen para él en la medida en que su contexto intencional lo incluya (`P-07`).
7. **Su autonomía está limitada por el harness** — las capacidades concedidas y las reglas de AIES delimitan lo que puede hacer (`P-20`, `RNF-05`).

Estos límites son la cara del trabajador del principio `P-20`: la autonomía de los agentes está limitada por el diseño del harness y por las capacidades que se les conceden.

**[Pendiente]** — Los permisos concretos (herramientas, acceso, escritura) que materializan estos límites son decisión de implementación y del entorno de ejecución, no de este documento.

---

## 8. Relación con AIES

**[Hecho]** — El límite fundamental (`Non-Goals §13`):

```text
AIES organiza el trabajo; los agentes realizan el trabajo.
```

- AIES proporciona el entorno, las reglas, el estado, la coordinación y los mecanismos.
- Los agentes —orquestador incluido— operan **dentro** de ese marco; ningún agente es AIES, y AIES no es un agente (`Non-Goals §1`).
- Un trabajador concreto nunca es una dependencia fundamental del runtime: la arquitectura debe permitir sustituirlo mientras la capacidad permanezca (`P-16`).

---

## 9. Qué NO define este documento

- Qué trabajadores concretos existen y qué capacidades proporciona cada uno → ADR de subagentes.
- Si el orquestador es agente único o rol intercambiable → ADR (`Component-Model.md §5`).
- Criterios para seleccionar capacidad, trabajador y modelo → `ADR-004-criterios-de-decision.md`.
- Catálogo formal de capacidades → `Capability-Model.md §9-10`.
- Ciclo de vida operativo de los trabajadores (creación, destrucción, concurrencia) → implementación; concurrencia excluida por ahora (`Runtime-Model.md §3.2`).
- Modelos, proveedores, prompts, permisos concretos, herramientas, pi (v0), MCP → fuera del alcance conceptual (`Non-Goals §11`, `ADR-001`); el binding material concreto, en `ADR-009`.

---

## 10. Cuestiones abiertas

1. ~~**Orquestador: agente único o rol intercambiable**~~ — **Resuelto en `ADR-007-orquestador-unico-o-rol.md`** (heredada de `Component-Model.md §5`): único fijo en v0; rol intercambiable habilitado como cambio de config, sin rediseño.
2. **Qué trabajadores existen** → ADR de subagentes, cuando exista necesidad demostrada (`P-17`).
3. ~~**Criterios de selección de trabajador y modelo**~~ — Resuelto en `ADR-004-criterios-de-decision.md`.
4. **Comprobación de la afirmación de capacidad** → medición/implementación (heredada de `Capability-Model.md §10`).
