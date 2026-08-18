# ADR-008 — Persistencia y recuperación entre sesiones

- **Estado:** Aceptada
- **Fecha:** 2026-08-14
- **Resuelve:** "Fuera del alcance: sistema de memoria/persistencia; qué información se conserva entre sesiones; cómo se recupera una tarea pendiente" de `ADR-003-limites-de-sesion.md`; cuestión nº 4 de `Runtime-Model.md §9` y de `Lifecycle.md §7`; cuestión nº 4 de `Component-Model.md §5` (conocimiento persistente); gap Tier-1 nº 1. Realiza `ADR-009` (ubicación física de la persistencia en el host).

---

## Contexto

`OBJ-06` y `P-08` exigen continuidad del trabajo entre sesiones; `REQ-F-19`/`REQ-F-20` exigen recuperar conocimiento selectivo del proyecto al iniciar una sesión sin reconstruirlo a mano; `RNF-16` exige que esa recuperación sea de bajo coste de tiempo y contexto. `ADR-003` definió qué es una sesión y dejó **explícitamente fuera** el mecanismo: *qué* se conserva, *cómo* se recupera y *dónde*. Esa es la mayor laguna funcional de la spec: sin ella, una tarea `En curso` no puede continuar en una sesión posterior (`Lifecycle.md §3`).

Restricciones que condicionan la decisión:

- `P-08`/`REQ-F-20` — la persistencia es **selectiva** (arquitectura, decisiones, convenciones, estado relevante, aprendizajes, problemas conocidos), no "todo lo producido".
- `Non-Goals §7` — AIES no es una base de conocimiento ni un segundo cerebro; la memoria está al servicio de la continuidad, no es un fin.
- `Non-Goals §10` — AIES usa el VCS del proyecto, no lo reemplaza ni compite con el historial del código.
- `P-13`/`RNF-10` — una recuperación no debe perder trabajo aceptado ni producir estado inconsistente; debe permitir **continuar o terminar de forma explícita**.
- `RNF-11` — debe poder reconstruirse qué ocurrió durante la tarea sin reejecutarla.
- `ADR-009` — el host es pi, embebido en proceso; el conocimiento del proyecto ya se carga por `DefaultResourceLoader` (recorrido de `AGENTS.md`).

---

## Opciones consideradas

### Opción A — Estado AIES bajo `agentDir` de pi, keyed-by-cwd; conocimiento del repo, leído al arranque

Dos tiers de persistencia, **separados por su naturaleza**:

1. **Estado del runtime AIES** (efímero del *proyecto en esta máquina*): tareas, unidades, iteraciones, perfil de límites/presupuesto, "siguiente paso" y la traza de decisiones/observabilidad. Vive **fuera del repo**, bajo `agentDir` de pi, indexado por `cwd`.
2. **Conocimiento persistente del proyecto** (durable, compartido): arquitectura, decisiones, convenciones, aprendizajes, problemas conocidos. **Ya existe** como docs en el repo (`AGENTS.md`, CONTEXT, ADRs, convenciones). AIES lo **lee al arranque** vía `DefaultResourceLoader` (`ADR-009`).

Ventajas: separa lo efímero-privado de lo durable-compartido sin redundancia (`Non-Goals §7`); el conocimiento no se duplica ni compite con el VCS (`Non-Goals §10`); satisface `RNF-16`/`REQ-F-19` sin código de persistencia aparte — el cargador de pi ya está; `P-08`/`REQ-F-20` se cumplen: lo selectivo ya vive como docs curadas; no contamina el repo del usuario con estado volátil.

Inconvenientes: el estado AIES **no es portable entre máquinas** ni versionable vía git. Es deliberado (ver Consecuencias): la continuidad es *de este proyecto en esta máquina* (`OBJ-06`). Si se requiriera portabilidad, sería una exportación/importación futura de `state.json`.

### Opción B — Toda la persistencia (estado + conocimiento) dentro del repo del proyecto

Guardar `state.json` y `log.jsonl` en el repo, junto con conocimiento.

Inconvenientes: contamina el repo del usuario con estado volátil que cambia por sesión/máquina; mezcla dos naturalezas —estado de ejecución vs conocimiento de larga duración que **ya** vive como docs curadas (duplicación, riesgo de divergencia); el estado no es legítimamente versionable (un `state.json` para el mismo `cwd` diverge entre desarrolladores/máquinas); contradice la intención de `P-08` (selectivo) al introducir un contenedor donde cabe "todo".

### Opción C — Estado y conocimiento en un servicio externo de memoria / base de datos

Un componente persistente dedicado (DB local o servicio) que guarda estado y conocimiento.

Inconvenientes: contradice `Non-Goals §7` — AIES no es un sistema de memoria; instala una dependencia y una frontera que ningún requisito exige (`P-17`); el conocimiento **ya está** en el repo, así que el servicio duplicaría una fuente de verdad existente; añade operación y modos de fallo (¿dónde vive ese servicio? ¿se sincroniza?) sin valor (`P-06`).

---

## Decisión

**Opción A.** Dos tiers separados.

### 1. Qué se persiste

| Artefacto | Contenido (conceptual, `Runtime-Model.md §3.1`) | Fuente del requisito |
|---|---|---|
| `state.json` | Tareas, unidades de trabajo y sus estados; información conocida; resultados obtenidos; iteraciones; perfil de límites/presupuesto aplicable; "siguiente paso" | `P-09`, `REQ-F-14`, `ADR-005` |
| `log.jsonl` | Traza de decisiones (operación + ajustePlan + motivo + condición) y resultados/observabilidad de cada vuelta | `RNF-01`, `RNF-11`, `Decision-Model.md §11` |

**No** se persisten las sesiones pi de worker por defecto (`ADR-009`: efímeras en `SessionManager.inMemory`); la observabilidad de worker vive en `log.jsonl`. Si `RNF-11` exigiera replay fino de una sesión de worker, se permite `SessionManager.create` opcional (flag de replay) — fuera del recorrido por defecto.

### 2. Dónde

Bajo `agentDir` de pi, indexado por el `cwd` del proyecto:

```text
<agentDir>/aies/<hash(cwd)>/
   ├── state.json      (estado del runtime para este proyecto/máquina)
   └── log.jsonl        (traza de decisiones y resultados)
```

**Fuera del repo** del proyecto. La representación exacta de `state.json` (campos, serialización) es del implementador; este ADR fija los **conceptos** que debe contener (`Runtime-Model.md §3.1` + perfil de límites de `ADR-005`).

### 3. Conocimiento del proyecto (tier durable)

Lo define `REQ-F-20`: arquitectura, decisiones, convenciones, estado relevante del proyecto, aprendizajes y problemas conocidos. **No** se replica: son los **docs ya existentes en el repo**. AIES los lee al arranque de cada sesión vía `DefaultResourceLoader` de pi (`ADR-009`), que recorre `AGENTS.md` desde `cwd` hacia arriba. Esto satisface `RNF-16`/`OBJ-06` (recuperación de bajo coste, sin reconstrucción manual) sin código de memoria propio.

### 4. Continuidad (`ADR-003`)

Al iniciar una nueva sesión para un `cwd`:

1. AIES-core carga `state.json` (si existe) y los docs del proyecto (vía `DefaultResourceLoader`).
2. Una tarea en estado `Recibida` o `En curso` se **reentra al bucle** desde su estado restaurado (`Lifecycle.md §3`): no se reinicia, se continúa (`P-13`, `RNF-10`). El trabajo aceptado se conserva: los resultados parciales están en el estado.
3. El "siguiente paso" del estado es la entrada de la primera decisión de la nueva sesión (`P-09`).

### 5. Recuperación segura

Ante `state.json` ausente o ilegible/corrupto, el comportamiento es **seguro y explícito** (`RNF-10`): arrancar una sesión nueva (estado limpio), no un fallo silencioso ni una continuación con estado inconsistente. Si hay `log.jsonl` legible, se conserva a modo de evento para que el desarrollador pueda reconstruir lo ocurrido (`RNF-11`); nunca se sobrescribe con estado corrupto.

### 6. Fin de sesión

El fin de una sesión **no** cambia el estado de la tarea (`ADR-003`): `state.json` persiste *tal cual* para la siguiente sesión. La persistencia aquí es de **continuidad del estado**, no de un evento de fin.

---

## Consecuencias

- El hueco Tier-1 nº 1 se cierra: una tarea `En curso` puede continuar en una sesión posterior restaurando estado + leyendo docs.
- `REQ-F-19`/`REQ-F-20`/`RNF-16` quedan satisfechos: el conocimiento esencial del proyecto es recuperable al arranque con coste bajo, porque **ya vive en el repo** y lo carga el `DefaultResourceLoader` de pi.
- `RNF-01`/`RNF-11` quedan servidos por `log.jsonl`: la ejecución puede reconstruirse sin reejecutarla.
- **Trade-off deliberado**: el estado AIES **no es portable entre máquinas** ni compartible vía git. Ventaja que lo compensa: el repo del usuario no se contamina con estado volátil, y la continuidad es coherente con `OBJ-06` (continuidad *de este proyecto, en esta máquina*). Si surgiera portabilidad, sería exportar/importar `state.json` (futuro).
- Documentos afectados, actualizados en consecuencia: `ADR-003` (fuera del alcance resuelto en sus tres puntos), `Runtime-Model.md §9.4` (resuelto), `Lifecycle.md §7.4` (resuelto), `Component-Model.md §5.4` (resuelto), `02-Requirements/README.md` (fila de cuestiones abiertas resuelta).
- **Fuera del alcance de este ADR**: portabilidad de `state.json` entre máquinas y formato de exportación/importación (futuro); replay fino de sesión de worker (`ADR-009`, flag opcional); la representación física concreta de `state.json` (implementador, dentro de los conceptos aquí fijados); la política de retención/purga del `log.jsonl` (medición/operación, `06-research/`); el catálogo exacto de docs de proyecto que `DefaultResourceLoader` consume (definido por el proyecto vía `AGENTS.md`).

---

## Referencias

- `Goals.md OBJ-06`; `Principles.md P-08, P-09, P-13, P-17` — continuidad; estado explícito; no reinicio total; crecimiento.
- `Functional-Requirements.md REQ-F-19, REQ-F-20` — recuperar conocimiento esencial; persistencia selectiva.
- `Non-Functional-Requirements.md RNF-01, RNF-10, RNF-11, RNF-16` — claridad; no pérdida de trabajo; reconstrucción; recuperación de bajo coste.
- `01-Concept/Non-Goals.md §7, §10` — no es un sistema de memoria; usa el VCS, no lo reemplaza.
- `03-Architecture/Runtime-Model.md §3.1, §9.4` — campos conceptuales del estado; mecanismo de persistencia pendiente.
- `04-Behavior/Lifecycle.md §3, §7.4` — reentrada de tarea; mecanismo de continuidad pendiente.
- `03-Architecture/Component-Model.md §5.4` — alcance/mecanismo del conocimiento persistente.
- `ADR-003-limites-de-sesion.md` — definición de sesión y "fuera del alcance" que este ADR cierra.
- `ADR-005-limites-e-irrecuperabilidad.md` — perfil de límites que entra en `state.json`.
- `ADR-009-integracion-con-pi.md` — `agentDir` como ubicación y `DefaultResourceLoader` para el conocimiento del repo.