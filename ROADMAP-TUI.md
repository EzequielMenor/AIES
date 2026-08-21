# AIES — Roadmap de la TUI

> Estado: **borrador vivo**. Deriva de la spec (`01-Concept/`…`06-research/`), de
> `ROADMAP.md` (Fase 3) y del estado real del código. No introduce decisiones de
> arquitectura — las decisiones viven en ADRs; este documento solo ordena features
> de la superficie de terminal en el tiempo, con criterios de salida medibles.
>
> Alcance: **toda la superficie de terminal de AIES** — modo oneshot, REPL y
> renderer (`runtime/src/cli.ts`, `runtime/src/ui/stream-renderer.ts`).
>
> Última revisión: 2026-08-21 (T0+T1+T2.1+T2.2+T3.1 implementados; T2.3 aplazado).

---

## 0. Radiografía de la TUI actual

### 0.1 Lo que existe

- **Dos modos**: oneshot `aies "<tarea>"` (exit 0/1) y REPL `aies` (prompt `❯ `;
  comandos `/help`, `/state`, `/clear`, `/exit|/quit`).
- **StreamRenderer**: scroll secuencial nativo (estilo Claude Code/Cargo), spinner
  braille en una línea, paleta truecolor (cyan `#38bdf8`, verde `#3fb950`, rojo
  `#f85149`, ámbar `#d29922`), bloques de worker con ramas de árbol, tool calls
  con `✓`/`✗`, veredicto del Verifier, barra final de tarea con
  `tiempo · iteraciones · coste`.
- **Modo no-TTY seguro**: por pipe cada pintado es una línea completa.
- **SIGINT limpio**: aborta el run en curso sin matar el proceso; en REPL vuelve
  al prompt.
- **Persistencia**: `.aies/{state.json,log.jsonl}` en cwd; el REPL carga el estado
  previo (solo para `/state`).

### 0.2 Lo que falta (gaps verificados en el código)

1. **La voz del orquestador es invisible.** La operación `comunicar al
   desarrollador` no emite ningún evento de UI: `core/loop.ts` solo emite
   `onWorkerFinish` para `ejecutar una unidad`. El único canal del orquestador
   para hablar con el desarrollador no llega a la terminal.
2. **Eventos de control invisibles.** `cli.ts` no consume `onLoopObservation`:
   parse-fails (hasta 3 consecutivos), límite alcanzado (`limit:reached`), unidad
   inexistente (`error:unidad-inexistente`) y compaction ocurren sin pintar una
   sola línea. RNF-19 (límites visibles, nunca silenciosos) se cumple en el log
   pero no en la presentación.
3. **Silencio entre turnos.** `onDecideStart` no se renderiza: no hay feedback de
   "orquestador pensando" entre la entrada de la tarea y la primera decisión, ni
   entre turnos.
4. **No existe reanudación.** Cada línea del REPL ejecuta `initState` fresco
   (`cli.ts::runCycle`); el estado previo solo alimenta `/state`. Una tarea que
   quedó `En curso` tras límite o intervención no se puede reanudar.
   `MVP-v0-Scope §9` espera reanudar en ese escenario.
5. **Intervención = solo detención.** Runtime-Model §7 define intervención como
   ajuste / restricción / detención; la TUI solo implementa detención (SIGINT).
   `intervention.ts` lo declara: "UX v0 = SIGINT. REPL/TUI = Tier 3 (fuera)".
6. **Sin telemetría en vivo.** Coste/tokens/contexto por iteración existen en
   `LoopObservation` y en `log.jsonl` pero no se muestran (open question de
   `runtime/README`).
7. **Doc drift.** `runtime/README.md` y `ROADMAP.md §0.1` mencionan
   `aies run "<tarea>"`, `/run`, `/status`, `/resume` — ninguno existe en el
   código.
8. **Sin diagnóstico de arranque.** No hay `--version` ni preflight de claves:
   sin `ANTHROPIC_API_KEY`, el usuario ve tres fallos de worker y una
   intervención sin entender la causa.
9. **Cero tests de UI.** `stream-renderer.ts` y el REPL no tienen cobertura.
10. (minor) `runOneshot` devuelve `taskState === "Fallida" ? 1 : 1` — ternario
    muerto; y el banner tiene el padding desalineado en una columna.

### 0.3 Restricciones (no negociables)

- **P-02**: el bucle es 100% puro y agnóstico de la UI. Toda feature de la TUI
  entra por `AiesEventHandlers` / `LoopObservation` (eventos aditivos y
  opcionales). El bucle nunca importa nada de la presentación.
- **RNF-19**: todo límite alcanzado debe ser visible en la terminal, nunca
  silencioso.
- **Non-goals**: sin UI web/GUI; local-first; sin dependencias nuevas sin
  necesidad demostrada (ponytail).
- La salida **no-TTY debe seguir siendo pipe-safe**.

---

## 1. Principios de priorización

1. **Visibilizar lo que ya ocurre antes que añadir nada nuevo.** Las
   invisibilidades de §0.2 son violaciones del espíritu de RNF-19/RNF-01 en la
   capa de presentación y se cierran sin features nuevas.
2. **Continuidad antes que novedad.** La reanudación ya está especificada
   (MVP-v0 §9, RNF-16) y no existe; va antes que cualquier capacidad nueva.
3. **Cada fase cierra con un criterio medible**, no aspiracional.
4. **Ponytail.** Nada de Ink/React, streaming de workers ni abstracciones de UI
   hasta que aparezca un segundo consumidor o una necesidad demostrada.

---

## 2. Fases

```text
┌────────┐   ┌────────────┐   ┌─────────────┐   ┌──────────────┐   ┌───────────┐
│   T0   │──▶│     T1     │──▶│     T2      │──▶│      T3      │──▶│    T4     │
│Visible │   │Reanudación │   │Intervención │   │Observabilidad│   │ Ergonomía │
│lo que  │   │y continuidad│  │   rica      │   │    viva      │   │  REPL/CLI │
│ya pasa │   │            │   │             │   │              │   │           │
└────────┘   └────────────┘   └─────────────┘   └──────────────┘   └───────────┘
                                                  (T3 y T4 son ortogonales a T2)
```

---

### T0 — Hacer visible lo que ya pasa

> **Motivación.** Hoy el bucle produce eventos de control que nadie renderiza.
> Antes de añadir features, la TUI debe mostrar todo lo que el bucle ya decide.

**Items:**

0.1 **Renderizar `comunicar al desarrollador`.** ✅ (T0, 2026-08-21)
    - **No** se añadió `onCommunication`. Se consume `onLoopObservation`
      (`execution:resolved` + operación comunicar + result.kind comunicación).
    - Bloque `💬 Orquestador: {texto}` en cyan/bright (no ámbar).

0.2 **Consumir `onLoopObservation` en `StreamRenderer`.** ✅
    - Línea ámbar por parse-fail (con contador 1/3, 2/3, 3/3 → intervención
      requerida).
    - Línea ámbar por `limit:reached` mostrando el `nextStep` ("intervención
      requerida: límite de iteraciones").
    - Línea ámbar por `error:unidad-inexistente`.
    - Línea por compaction (evento de contexto; RNF-18/19).

0.3 **Feedback entre turnos.** ✅ Spinner "Orquestador decidiendo…" en
    `onDecideStart`; `detachSpinner()` al llegar `onDecideSuccess`.

0.4 **Preflight de arranque.** ✅ (REPL y oneshot; no bloquea si falta la clave).

0.5 **Cerrar el doc drift.** ✅ `runtime/README.md` y `ROADMAP.md §0.1`
    alineados con comandos reales. `/status` queda anotado como T3.

0.6 **Limpieza menor.** ✅ `runOneshot` sale 1 en cualquier no-Completada;
    padding del banner derivado de `bar.length + 2`.

0.7 **Tests del renderer.** ✅ `src/ui/stream-renderer.test.ts` + `src/cli.test.ts`.

**Criterios de salida:**

- Cada evento de control del bucle (parse-fail, límite, intervención,
  compaction, comunicación, unidad inexistente) produce una línea visible en
  la TUI en modo TTY.
- Tests de UI verdes junto al resto (`pnpm test`).

**Trazabilidad:** `RNF-19`, `RNF-01`, `REQ-F-10`, `Decision-Model §2`
(repertorio de operaciones), `MVP-v0-Scope §8`.

---

### T1 — Reanudación y continuidad

> **Motivación.** El bucle ya soporta reanudar (`runLoop` corre mientras
> `Recibida`/`En curso`); es la CLI la que siempre arranca de cero. Cerrar este
> gap es condición para la intervención rica (T2) y para sesiones largas.

**Items:**

1.1 **`/resume`.** ✅ Si `.aies/state.json` contiene una tarea `En curso`,
    `runCycle(..., { resumeFrom })` en lugar de `initState` fresco.

1.2 **Arranque del REPL con estado previo `En curso`.** ✅ Aviso + `/resume`.
    Oneshot: aviso pasivo antes de sobreescribir (sin flag `--resume` en T1).

1.3 **`/state` legible.** ✅ Vista humana; `/state --json` conserva el JSON.

**Criterios de salida:**

- Una tarea pausada por límite o intervención se reanuda con `/resume` sin
  perder unidades ni resultados (smoke test con decide/execute mockeados).
- Se cumple el smoke de `MVP-v0-Scope §9`: con `state.json` previo `En curso`,
  la siguiente invocación **reanuda** en lugar de crear tarea nueva.

**Trazabilidad:** `RNF-10`, `RNF-16`, `MVP-v0-Scope §9`, `ADR-008`.

---

### T2 — Intervención rica

> **Motivación.** Runtime-Model §7 define la intervención como entrada externa
> que **ajusta, restringe o detiene**; hoy solo existe detener. ROADMAP Fase 3
> (item 3.2) ya la programa — esta fase la concreta en la TUI.

**Items:**

2.1 **Ajuste en caliente.** ✅ (T2.1, 2026-08-21)
    - Nuevo handler `pollIntervention?: () => InterventionAdjustment | null` en
      `AiesEventHandlers`; el bucle lo consulta al inicio de cada turno (tras
      `stopSignal`, antes de los límites) y, si devuelve ajuste, lo incorpora
      al estado como resultado `kind: "intervención"` + `knownInfo` con prefijo
      `intervención del desarrollador:`. No aborta el worker en curso: se
      procesa en la siguiente decisión (Runtime-Model §7). Handler que lanza
      se aísla con try/catch.
    - REPL: mientras corre un run, un listener `rl.on("line", …)` encola el
      texto (drena TODAS las entradas en el próximo poll, unidas con `\n`); un
      eco violeta `⚑ tú (intervención): …` se imprime de inmediato; una línea
      que empieza por `/` muestra aviso ámbar y NO se encola. Al arrancar el
      run se imprime `(escribe para intervenir · Ctrl+C detiene)` en dim.
    - Renderer: línea violeta
      `⚑ Intervención del desarrollador incorporada — se tendrá en cuenta en la decisión.`
      (paleta `#a371f7` del prototipo).

2.2 **Reanudación con guía.** ✅ (T2.2, 2026-08-21)
    - `/resume "<guía>"` parsea comillas dobles o texto crudo (`parseResumeGuide`).
    - `runResumeCycle` acepta `resumeGuide?: string` y lo inyecta en
      `knownInfo` con prefijo `guía del desarrollador al reanudar:` antes de
      arrancar el bucle.

2.3 **Restricciones de tarea.** Aplazado. P-13/ponytail: `taskFromArg` deja
    `alcance`/`restricciones` siempre `null`; abrir esto en TUI es ortogonal a
    T2.1/T2.2 y no está pedido por un usuario real todavía.

**Criterios de salida:**

- ≥ 1 test unitario del bus de entradas cubriendo "ajuste" y "reanudación con
  guía" (criterio de ROADMAP Fase 3).
- La detención por SIGINT sigue funcionando como caso especial de intervención.
- El bucle sigue siendo puro: la entrada externa llega por el contrato de
  handlers, nunca por import de la UI (P-02).

**Trazabilidad:** `REQ-F-11`, `RNF-04`, `Runtime-Model §7`, `MVP-v0-Scope §7`,
`ROADMAP.md 3.2`.

---

### T3 — Observabilidad viva

> **Motivación.** Deferred Tier 3 de `MVP-v0-Scope` y open question de
> `runtime/README`: la telemetría ya existe en `LoopObservation` y `log.jsonl`;
> falta mostrarla. ROADMAP Fase 3 (item 3.1) la programa.

**Items:**

3.1 **Línea de estado por iteración.** ✅ (T3.1, 2026-08-21)
    - Tras cada `execution:resolved`, el renderer acumula `usage` y `contextUsage`
      en sus propios campos (independientes del acumulador del bucle; preserva
      los valores en parse-fails también, cuya vuelta de orquestador se factura).
    - Línea dim: `· iter N/max · <tok> tok · $<cost> · ctx <pct>% · verify P/Q`
      donde P/Q cuenta `results` con `kind === "unidad" && passed !== null` /
      `=== true`. RNF-07/17: telemetría nula → "n/d" explícito, nunca
      inventada. Formato `k` ≥ 1000 (como el prototipo). Pipe-safe: cada
      pintado es una línea completa en no-TTY.

3.2 **`/status` enriquecido.** Pendiente. Árbol de unidades + telemetría
    agregada leída de `log.jsonl` **sin reejecutar** (RNF-11).

3.3 **`aies log` (o `/log`).** Pendiente. Tail de `.aies/log.jsonl`
    formateado para humanos (decision/resultado/compaction).

**Criterios de salida:**

- ✅ La línea de estado muestra telemetría por iteración (test unitario sobre
  observación sintética + smoke manual en sesión real).
- `/status` responde desde `log.jsonl` sin reejecución (self-check sobre log
  sintético; criterio de ROADMAP Fase 3).

**Trazabilidad:** `RNF-11`, `REQ-F-14`, `MVP-v0-Scope §Deferred Tier 3`,
`ROADMAP.md 3.1`, `runtime/README §open questions`.

---

### T4 — Ergonomía REPL/CLI

> **Motivación.** Una vez la TUI es visible, continua e intervenible, se pule
> el uso diario. Nada de esto bloquea a las fases anteriores.

**Items:**

4.1 **Historia persistente** del REPL (`.aies/history`) + **tab-completion**
    de comandos `/`.
4.2 **Entrada multi-línea** para tareas (las descripciones largas no caben en
    una línea de readline).
4.3 **Flags**: `--verbose` (salida completa de workers), `--quiet` (mínimo),
    `--json` en oneshot (salida machine-readable para scripts), `--version`,
    verificación de `NO_COLOR` (picocolors ya lo respeta; validar truecolor).
4.4 **Truncado de salidas largas** con marca expandible vía `--verbose`
    (outputs de bash no inundan el scroll).
4.5 **Fallback de color** para terminales sin truecolor.

**Criterios de salida:**

- 1 sesión larga de REPL (≥ 30 min, smoke de aceptación de ROADMAP 3.4)
  completada sin fricción de usabilidad.

**Trazabilidad:** `ROADMAP.md 3.4`.

---

### T5 — Deferred explícitos (solo con necesidad demostrada)

- **Streaming en vivo del texto de workers** (pensamiento/edición token a
  token): requiere exponer eventos de sesión de pi; es el Tier 3 "replay fino"
  de `MVP-v0-Scope §Deferred`.
- **TUI Ink/React**: el contrato de eventos ya lo permitiría (`core/events.ts`
  lo menciona), pero no hay segundo consumidor — ponytail.
- **Tareas nombradas / multi-tarea por proyecto** (ROADMAP 3.3): hasta que
  exista un usuario real que lo pida.
- **UI web/GUI**: non-goal del proyecto.

---

## 3. Camino crítico

```text
T0 ──▶ T1 ──▶ T2
│       │
│       └── T1.1 (/resume) es prerrequisito de T2.2 (reanudación con guía)
└── T0.2 (límites/parse-fail visibles) es prerrequisito de la UX de T1/T2

T3 ⟂ T4 ⟂ T2   (ortogonales; pueden correr en paralelo)
```

- **T0** no depende de nada: es presentación pura + eventos aditivos.
- **T1** necesita T0.2 (la UX de reanudación exige ver por qué se pausó la tarea).
- **T2** necesita T1 (la reanudación con guía monta sobre `/resume`).
- **T3/T4** son independientes.

---

## 4. Referencias cruzadas

| Tema | Dónde vive |
|---|---|
| Fase 3 del roadmap general (producto) | `ROADMAP.md §Fase 3` |
| Contrato de eventos del bucle | `runtime/src/core/events.ts` |
| Hook de observación del bucle | `runtime/src/core/observation.ts` |
| Renderer actual | `runtime/src/ui/stream-renderer.ts` |
| REPL/oneshot actual | `runtime/src/cli.ts` |
| Intervención (canal de proceso) | `runtime/src/intervention.ts`, `Runtime-Model §7` |
| Persistencia (state.json / log.jsonl) | `ADR-008`, `runtime/src/cli-persistence.ts` |
| Límites visibles | `ADR-005`, `RNF-19` |
| Observabilidad reconstruible | `RNF-11`, `MVP-v0-Scope §8` |
| Reanudación esperada | `MVP-v0-Scope §9`, `RNF-16` |
| Deferred Tier 3 (observabilidad viva) | `MVP-v0-Scope §Deferred` |
| Open questions del runtime | `runtime/README §open questions` |
| Prototipo visual de la TUI (exploración, sin decisión) | `06-research/tui-design/README.md` |

---

## 5. Cómo se actualiza este documento

- Al cierre de cada fase: actualizar criterios con datos reales y mover items
  entre fases si la realidad lo pide.
- Cualquier propuesta que contradiga una ADR se rechaza aquí y se eleva a una
  nueva ADR. Este documento no decide arquitectura, solo secuencia features de
  la TUI.
- Los criterios de salida medibles sustituyen a las fechas.