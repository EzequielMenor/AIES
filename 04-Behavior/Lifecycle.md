# AIES — Ciclo de vida de una tarea

Este documento define **cómo evoluciona una tarea dentro de AIES**: estados, transiciones y el bucle de decisión que los gobierna. No define implementación, mecanismos concretos, tecnologías ni agentes concretos.

Deriva de `P-01`, `P-09`, `P-10`, `P-12`, `P-13`, `REQ-F-14`…`REQ-F-18` y del `Task-Model.md`.

---

## 1. Convenciones

- **[Hecho]** — Impuesto por `01-Concept/` o por requisitos validados.
- **[Propuesta]** — Modelo propuesto que requiere validación.
- **[Pendiente]** — Aspecto que requiere decisión posterior (ADR).

---

## 2. El bucle de decisión (núcleo del ciclo de vida)

**[Hecho]** — El corazón del runtime es un bucle, fijado por `P-10` y `P-13`:

```text
            ┌──────────────────────────────┐
            │                              │
            ▼                              │
      ┌───────────┐                        │
      │  Pensar   │  (observar el estado,  │
      └───────────┘   evaluar qué se sabe) │
            │                              │
            ▼                              │
      ┌───────────┐                        │
      │  Decidir  │                        │
      └───────────┘                        │
            │                              │
   ┌────────┴────────────────┐             │
   │                         │             │
   ▼                         ▼             │
┌─────────────┐        ┌─────────────┐     │
│  Obtener    │        │  Ejecutar   │     │
│ información │        │ (delegar una│     │
│             │        │  unidad)    │     │
└─────────────┘        └─────────────┘     │
   │                         │             │
   └───────────┬─────────────┘             │
               ▼                           │
        ┌────────────┐                     │
        │ Observar   │─────────────────────┘
        │ resultado  │
        └────────────┘
               │
   ┌───────────┴───────────┐
   ▼                       ▼
Completada              Fallida
```

Reglas del bucle:

- **Pensar** — evaluar el estado explícito de la tarea (`P-09`): qué se sabe, qué se ha hecho, qué resultados hay. El estado, no la conversación, es la entrada de cada decisión (`REQ-F-14`).
- **Decidir** — una de estas salidas (`P-01`, `P-02`, `P-10`, `P-13`):
  - información insuficiente → **obtener información** antes de ejecutar (`REQ-F-18`);
  - trabajo pendiente → **ejecutar**: seleccionar la capacidad necesaria y delegar una unidad de trabajo (`P-01`, `P-14`);
  - condiciones de finalización cumplidas y verificadas → **completar** (`P-12`, `REQ-F-13`);
  - no hay forma viable de completar → **fallar** (`P-13`).
- **Observar resultado** — cada resultado (éxito, fallo, información obtenida) alimenta el estado y conduce a un nuevo "pensar" (`P-13`, `REQ-F-17`). Un fallo de unidad **no** implica fallo de tarea: es una entrada más del bucle (`REQ-F-16`).

---

## 3. Estados de la tarea

**[Propuesta]** — Cuatro estados, definidos conceptualmente en `Task-Model.md §5`, el mínimo que satisface `P-09` y `P-13`:

| Estado | Significado |
|---|---|
| **Recibida** | El desarrollador ha solicitado la tarea; el bucle aún no ha comenzado |
| **En curso** | El bucle de decisión está operando |
| **Completada** | Condiciones de finalización cumplidas y verificadas (`P-12`) |
| **Fallida** | Se decidió que no hay forma viable de completarla, o el desarrollador la detuvo |

**[Propuesta]** — Intervención del desarrollador (`REQ-F-11`, `RNF-04`): si ajusta la tarea, esta continúa **En curso** con la nueva información; si la detiene, pasa a **Fallida** con ese motivo.

> Un estado "pausada" se descarta por ahora: no hay requisito que exija suspensión y reanudación como estado propio (`P-06`, `P-17`). Se reintroducirá si aparece necesidad.

---

## 4. Estados de la unidad de trabajo

**[Propuesta]** — Concreta los estados definidos en `Task-Model.md §5`:

| Estado | Significado | Transición causada por |
|---|---|---|
| **Pendiente** | Creada por descomposición; aún no delegada | — |
| **En curso** | Delegada a un subagente | Decisión de ejecutar (P-01) |
| **Terminada** | Resultado obtenido y condición de finalización verificada | Verificación satisfactoria (`P-12`) |
| **Fallida** | El subagente no pudo completarla o el resultado no verifica | Fallo o verificación insatisfactoria (`P-13`) |

Reglas:

- **Fallida** no elimina la unidad: vuelve al bucle de decisión, donde puede re-delegarse, corregirse o re-descomponerse (`P-13`, `REQ-F-16`).
- **Re-descomposición**: si una unidad resulta demasiado grande o mal definida, la decisión puede sustituirla por varias unidades **Pendiente** (`REQ-F-15`; señales y reglas en `ADR-006-re-descomposicion.md`).
- El paso de una unidad a **Terminada** requiere su condición de finalización, que es parte de la unidad (`REQ-F-13`).

---

## 5. Transiciones de la tarea

| De | A | Disparador | Fuente |
|---|---|---|---|
| Recibida | En curso | El orquestador toma la tarea y arranca el bucle | P-01 |
| En curso | Completada | Condiciones de finalización cumplidas y verificadas | P-12, REQ-F-13 |
| En curso | Fallida | Decisión de imposibilidad, o detención del desarrollador | P-13, RNF-04 |
| En curso | En curso | Cada iteración del bucle (obtener info / ejecutar / observar) | P-10, P-13 |

**[Hecho]** — El número de iteraciones forma parte del estado explícito (`P-09`: "cuántas iteraciones se han realizado").

**[Hecho — ADR-005]** — El límite de iteraciones y el criterio de tarea irrecuperable se definen en `ADR-005-limites-e-irrecuperabilidad.md` (estructura y política; valores en medición).

---

## 6. Qué NO define este documento

- El rol de verificación queda definido en `ADR-002`: el orquestador coordina y un trabajador proporciona la capacidad de verificar. Qué trabajador concreto la proporciona sigue pendiente.
- Quién ejecuta las demás capacidades (explorar, implementar…) → ADR de subagentes.
- Las reglas formales de re-descomposición → `ADR-006-re-descomposicion.md`.
- La relación entre tarea y sesión queda definida en `ADR-003`; el mecanismo de continuidad entre sesiones se resuelve en `ADR-008` (no se decide aquí).
- La representación física del estado → implementación.

---

## 7. Cuestiones abiertas

1. ~~Límite de iteraciones / criterio de "irrecuperable"~~ — Resuelto en `ADR-005`.
2. ~~Reglas de re-descomposición de unidades~~ — Resuelto en `ADR-006`.
3. Qué trabajador concreto proporciona la capacidad de verificación → ADR de subagentes.
4. ~~El mecanismo de continuidad de una tarea entre sesiones~~ — **Resuelto en `ADR-008-persistencia-entre-sesiones.md`** (`state.json` + `log.jsonl` bajo `agentDir` keyed-by-cwd; reentrada al bucle desde el estado restaurado, `§3`).
