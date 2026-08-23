# ADR-012 — Intervención del desarrollador: pausa reanudable (no terminación a Fallida)

- **Estado:** Aceptada
- **Fecha:** 2026-08-23
- **Resuelve:** ítem del test plan «Interrumpir con Ctrl+C y /resume» que la spec v0 declaraba
  imposible (Runtime-Model §7 / Lifecycle §3 / MVP-v0-Scope §7: «si la detiene → Fallida»).
  Restablece la simetría con la pausa por límite (ADR-005), que ya era reanudable.

---

## Contexto

`Lifecycle.md §3` definía la intervención del desarrollador con dos efectos:
ajustar la tarea → sigue **En curso**; detenerla → pasa a **Fallida** con ese motivo.
`Runtime-Model.md §7` y `MVP-v0-Scope.md §7` replicaban la regla.

Esa elección contradice el caso de uso real más frecuente: el desarrollador quiere **detener**
un run largo (coste/tiempo/contexto) **sin perder el trabajo aceptado**, y continuarlo más tarde
con `/resume` — exactamente el patrón que `ADR-005 §2` ya fija para la pausa por límite
de iteraciones. Tres hechos corroboraban la tensión:

1. **Test plan detectó la incoherencia.** El ítem «Interrumpir con Ctrl+C y /resume» estaba
   marcado como imposible en v0. La única vía de reanudación que el código implementaba era
   `/resume` sobre `En curso`, pero Ctrl+C llevaba a `Fallida` y `resolveResume` la rechazaba.
2. **`Fallida` se confundía con dos situaciones distintas.** Inviabilidad declarada por el
   orquestador (sin continuación viable) y detención por el desarrollador. Un mismo `taskState`
   con dos semánticas opuestas — la primera es terminal, la segunda es reanudable.
3. **El límite de iteraciones ya reutilizaba `En curso`.** `ADR-005 §2` define "pedir
   intervención" como respuesta por defecto y deja la tarea `En curso` con `nextStep` marcador.
   Mismo síntoma, misma solución: re-emit `nextStep` y salir del bucle sin transición terminal.

`Lifecycle.md §3` advertía explícitamente:

> Un estado "pausada" se descarta por ahora: no hay requisito que exija suspensión y reanudación
> como estado propio (`P-06`, `P-17`). Se reintroducirá si aparece necesidad.

Este ADR materializa esa reintroducción sin crear un estado nuevo (ponytail: el catálogo no crece).

---

## Opciones consideradas

### Opción A — Mantener `detención → Fallida`

La regla actual cumple literalmente la spec. Pero bloquea el caso de uso principal de
intervención, contradice `ADR-005` y obliga a inventar workarounds (ejecutar la tarea en un
proceso aparte y matar, perdiendo el estado) para el escenario más común de uso.

Descartada.

### Opción B — Crear un estado nuevo `"Pausada"` propio del catálogo

Añadir `"Pausada"` a `TaskState` en `state.ts`. Cumple literalmente el comentario de
`Lifecycle.md §3`, pero:

- Cambia cinco puntos de la spec (`Runtime-Model §3.1`, `Lifecycle §3/§5`, `MVP-v0-Scope §7`,
  `Decision-Model` si lo cita, todos los tests que asumen el enum actual).
- Dicotomía innecesaria con `En curso` cuando la única diferencia es haber recibido un
  stopSignal (el resto del estado — `units`, `results`, `knownInfo`, `iterations` — es idéntico).
- Más superficie para errores de transición.

Descartada por YAGNI / ponytail: el mismo efecto se logra con `En curso` + `nextStep` marcador,
como ya hace `ADR-005`.

### Opción C — Reutilizar `En curso` + `nextStep` marcador (decidida)

- La rama `stopSignal` del bucle deja `taskState` intacto (`"Recibida" | "En curso"`).
- Fija `nextStep: "pausada por el desarrollador — reanudable con /resume"`.
- Emite `phase: "intervention:paused"` en `onLoopObservation` (antes
  `intervention:stopped`) — un renaming que refleja la semántica.
- NO emite `onTaskFailed`; el estado persistido por `runCycle::saveState` queda reanudable.
- `resolveResume` acepta `"Recibida" | "En curso"` (antes sólo `"En curso"`); cubre el edge
  de pausa antes del primer `ajustePlan`. Coherente con `persistence/recover.ts::isResumable`,
  que ya lo aceptaba.
- `Fallida` queda reservada para **inviabilidad** (orquestador declara `terminar` con
  condición inviable) y **terminación controlada por límite** (acción `terminar` en
  `ADR-005`). Dos causas, una semántica: no es viable continuar.

Ventajas: cambio mínimo (un renaming + un cambio de mensaje + dos aserciones); cero nuevo
estado; simetría con `ADR-005`; el código del bucle, el render y los tests casi no crecen.

Inconvenientes: el estado `En curso` deja de significar "el bucle está girando ahora mismo"
y pasa a significar también "pausada, reanudable". El `nextStep` marcador lleva la
información. Mismo trade-off que `ADR-005` ya asumió.

---

## Decisión

**Opción C.**

1. **Pausa, no terminación.** La rama `stopSignal` de `core/loop.ts`:
   - emite un `resultEntry` con `kind: "intervención"` y texto «tarea pausada por el desarrollador»
     (antes `kind: "límite"` con «tarea detenida por intervención»);
   - fija `state.nextStep = "pausada por el desarrollador — reanudable con /resume"`;
   - emite `safeObserve({ phase: "intervention:paused", state })`;
   - `break` sin tocar `taskState`, sin `setTerminal`, sin `onTaskFailed`.

2. **UX v0 — ESC parar / Ctrl+C cerrar (REPL), SIGINT oneshot pausa:**
   - **ESC durante un run (REPL con TTY)** → aborta el worker (`AbortController.abort`); la
     tarea queda pausada; el REPL vuelve al prompt. Reanudable con `/resume`.
   - **Ctrl+C (SIGINT) durante un run (REPL)** → aborta + marca `exitAfterCycle`; tras drenar
     el turno el REPL cierra. El estado queda persistido por `runCycle::saveState` antes del
     cierre; la siguiente invocación ofrece `/resume`.
   - **2º SIGINT en cualquier momento del REPL** → `process.exit(130)` inmediato (escape de
     emergencia si el drenado del turno se cuelga).
   - **SIGINT en el prompt del REPL (sin run)** → cierra el REPL directamente.
   - **Oneshot**: 1ª SIGINT pausa; 2ª fuerza `exit(130)`. Sin ESC (no hay readline).
   - Detalles de detección (keypress API sobre `inputStream`, fallback documentado para pipe
     sin TTY) viven en `cli.ts::runTrackedReplCycle`. Tests E2E manuales en TTY real; los
     tests automatizados cubren la rama `stopSignal` del bucle y el wiring del REPL sin
     simular teclado.

3. **`resolveResume` ampliado.** Acepta `"Recibida" | "En curso"`. Mensaje de error:
   `aies: no hay una tarea reanudable ("En curso"/"Recibida").`

4. **Briefing en `knownInfo` — entrada única, reemplazada.** Para evitar el crecimiento
   monotónico en `/resume` (D3), el briefing se inyecta como una sola entrada con prefijo
   estable `briefing de arranque:`. En cada ciclo se filtra la previa y se añade la nueva.
   La forma del `StartupReport.briefing: string[]` no cambia.

5. **`Fallida` redefinida por exclusión.** Una tarea pasa a `Fallida` sólo cuando:
   - el orquestador declara `terminar` con condición inviable (sin continuación viable,
     irrecuperable), o
   - se alcanza un límite y la acción es `terminar` (`ADR-005`).
   **Nunca** por intervención del desarrollador.

---

## Consecuencias

- Cierre del ítem del test plan: Ctrl+C → pausar → `/resume` funciona. ESC → pausar →
  `/resume` funciona. Briefing no crece entre resumes.
- `taskState = "Fallida"` pasa a tener un único significado operativo: «no se puede continuar».
  Útil para `runtime/`, tests y UI — la inferencia sobre `taskState` se simplifica.
- Documentos canónicos actualizados:
  - `04-Behavior/Lifecycle.md` §3 (fila `Fallida`, propuesta intervención, nota línea 80).
  - `03-Architecture/Runtime-Model.md` §7 (bullet de detención).
  - `03-Architecture/MVP-v0-Scope.md` §7 (ídem).
- Código afectado: `core/loop.ts` (rama `stopSignal`), `core/observation.ts` (renaming),
  `core/events.ts` (docstring), `ui/stream-renderer.ts` (línea ámbar), `cli.ts` (REPL,
  oneshot, `resolveResume`, briefing, `HELP_TEXT`), `intervention.ts` (comentarios).
- **Fuera del alcance**: atajos de teclado adicionales (`q`, `Ctrl+D`), TUI Ink/Tier 3
  (ROADMAP-TUI §0), formato de export del estado pausado entre máquinas, política de timeout
  del drenado gracioso antes del `exit(130)` (documentado: el usuario tiene la última palabra).

---

## Referencias

- `Runtime-Model.md §7`, `MVP-v0-Scope.md §7` — intervención como entrada externa.
- `Lifecycle.md §3, §5` — estados, intervención, transiciones.
- `ADR-005-limites-e-irrecuperabilidad.md` §2 — patrón "pedir intervención" deja `En curso`
  con `nextStep` marcador. Esta decisión generaliza el patrón al canal del desarrollador.
- `ADR-008-persistencia-entre-sesiones.md` — `state.json` + `/resume`.
- `ADR-011-integracion-codegraph-projectmem.md` §4 — briefing al estado (origen del D3).
- `core/events.ts::onTaskFailed` — ya no cubre stop-signal.
- `persistence/recover.ts::isResumable` — ya aceptaba `"Recibida" | "En curso"` (consistencia).
