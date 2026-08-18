# AIES — Modelo de capacidades

Este documento define **qué es una capacidad**, cómo se describe conceptualmente y cómo se relaciona con las tareas y con los trabajadores.

Deriva de `P-03`, `P-14`, `P-15`, `P-16`, `REQ-F-21`, `REQ-F-22`, `REQ-F-24`…`REQ-F-26`, de `Component-Model.md §2.4` y de `ADR-002`. Usa el vocabulario de `Glossary.md`.

No define el catálogo de capacidades de AIES, ni qué trabajadores existen, ni qué modelos las implementan, ni los criterios para seleccionarlas.

---

## 1. Convenciones

- **[Hecho]** — Impuesto por `01-Concept/`, requisitos validados o ADRs.
- **[Propuesta]** — Modelo propuesto que requiere validación.
- **[Pendiente]** — Aspecto que requiere una decisión posterior (ADR) o un documento posterior.

---

## 2. Qué es una capacidad

**[Hecho]** — Una capacidad es **lo que puede hacerse, independientemente de quién lo haga** (`Glossary.md §3`, `P-14`). Separa explícitamente:

```text
qué debe hacerse   ≠   quién lo hace
```

**[Hecho]** — Una capacidad **no es** un agente, ni un modelo, ni un componente del sistema. Es la dimensión por la que el orquestador selecciona a quién delegar (`Component-Model.md §2.4`).

**[Hecho]** — Ejemplos citados en `01-Concept/`: explorar, planificar, implementar, verificar, revisar, depurar, investigar (`P-03`, `P-14`). Forman un conjunto abierto, no un catálogo cerrado.

---

## 3. Descripción conceptual de una capacidad

**[Propuesta]** — Una capacidad se describe, como mínimo, por:

| Elemento | Significado |
|---|---|
| **Propósito** | Qué tipo de trabajo realiza |
| **Entrada** | Qué recibe: una unidad de trabajo y el contexto intencional necesario (`P-07`, `Component-Model.md R-3`) |
| **Resultado** | Qué debe producir, evaluable frente a la condición de finalización de la unidad (`Task-Model.md §4`) |

Una capacidad se describe por el trabajo que puede aceptar y el resultado que debe devolver, **no por cómo lo consigue**. El procedimiento interno pertenece al trabajador que la proporciona.

---

## 4. Relación tarea → capacidad

**[Propuesta]** — La relación está mediada por las unidades de trabajo:

```text
Task
  │  se descompone en (Task-Model.md §3)
  ▼
Work Unit ──── requiere ────▶ Capacidad
```

Reglas:

- **Cada delegación selecciona una capacidad** (`Runtime-Model.md §4`: "se selecciona la capacidad necesaria y se delega una unidad de trabajo").
- Una unidad puede requerir **más de una delegación** a lo largo de su ciclo: por ejemplo, una delegación con la capacidad de implementar y otra con la capacidad de verificar (`ADR-002`).
- Qué capacidades necesita una tarea depende del proceso que la tarea justifique (`P-05`, `P-06`): una tarea trivial puede necesitar muy pocas; una compleja, más.

**[Hecho — ADR-004]** — Los criterios para determinar qué capacidades requiere una tarea concreta se definen en `ADR-004-criterios-de-decision.md` (proceso mínimo por defecto; selección por contrato).

---

## 5. Relación capacidad → trabajador

**[Hecho]** — La relación es muchos a muchos (`P-14`, `P-16`, `Component-Model.md §2.4`):

```text
              Capacidad (qué debe hacerse)
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
  Trabajador A  Trabajador B  Trabajador C
        (quién lo hace — sustituibles)
```

- Un trabajador **proporciona una o más capacidades**.
- Una capacidad puede ser **proporcionada por varios trabajadores**.

**[Hecho]** — Ejemplo ya fijado: la verificación es una capacidad que puede proporcionar el mismo trabajador que implementó una unidad o uno diferente, según el proceso que la tarea justifique (`ADR-002`).

**[Hecho]** — El modelo es un recurso del trabajador, no de la capacidad (`P-15`, `Non-Goals §2`): la descripción de una capacidad no determina qué modelo la ejecuta.

---

## 6. Qué significa proporcionar una capacidad

**[Propuesta]** — Un trabajador proporciona una capacidad cuando puede:

1. recibir una unidad de trabajo que la requiera, con su contexto intencional;
2. realizar el trabajo usando sus propios medios;
3. devolver un resultado evaluable frente a la condición de finalización de la unidad.

Proporcionar una capacidad es una afirmación sobre **el trabajo que un trabajador puede aceptar**, no sobre su identidad, su modelo, su proveedor ni su configuración. Esos detalles son internos al trabajador y pueden cambiar sin afectar a la relación.

---

## 7. Sustituibilidad

**[Hecho]** — Un trabajador puede ser sustituido por otro que proporcione la misma capacidad, sin que cambie el proceso de resolución de la tarea (`P-16`, `REQ-F-26`).

**[Propuesta]** — La condición de sustituibilidad es la descripción de §3: dos trabajadores son intercambiables respecto a una capacidad cuando ambos pueden aceptar su entrada y producir su resultado. Lo que difiera entre ellos (modelo, proveedor, configuración, procedimiento interno) es ajeno a la capacidad.

La consecuencia estructural:

```text
la capacidad es el contrato estable
el trabajador es la variable
```

Esto permite cambiar de trabajador —incluido cambiar de modelo— sin modificar el proceso conceptual (`RNF-14`).

---

## 8. Relación con las operaciones del runtime

**[Propuesta]** — Conexión con `Runtime-Model.md §4`, sin redefinirlo:

| Operación del runtime | ¿Requiere capacidad de un trabajador? |
|---|---|
| Obtener información | Sí — se delega en un trabajador con la capacidad adecuada |
| Ejecutar una unidad | Sí — la capacidad seleccionada en la decisión |
| Comunicar al desarrollador | No — la realiza el orquestador |
| Terminar | No — es una decisión del orquestador |

Las capacidades son el medio por el que el runtime realiza las operaciones delegables; el orquestador no necesita capacidades de trabajador para coordinar (`P-01`).

---

## 9. Qué NO define este documento

- El catálogo concreto de capacidades de AIES → pendiente, cuando exista necesidad (`P-17`, `Component-Model.md §5`).
- Los criterios para seleccionar capacidad, trabajador y modelo en cada decisión → `ADR-004-criterios-de-decision.md`.
- Qué trabajadores concretos existen y qué capacidades proporciona cada uno → ADR de subagentes.
- Cómo se implementa una capacidad (prompts, herramientas, configuración) → implementación.

---

## 10. Cuestiones abiertas

1. **Catálogo formal de capacidades** — qué capacidades concretas existen en AIES y con qué límites → cuando exista necesidad demostrada (`P-17`).
2. ~~**Criterios de selección**~~ — Resuelto en `ADR-004-criterios-de-decision.md`: proceso mínimo por defecto; selección por contrato de capacidad; sin umbrales.
3. **Comprobación de la afirmación** — cómo se valida que un trabajador realmente proporciona una capacidad que declara → medición/implementación.
