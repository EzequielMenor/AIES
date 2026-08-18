# E-02 — hipótesis H-02: coste y tiempo proporcionales a la complejidad

| Campo | Contenido |
|---|---|
| **Hipótesis** | `H-02`: "el coste y el tiempo resultan proporcionales a la complejidad" (`Non-Functional-Requirements.md §4`, fuente `OBJ-03` / `Goals §4`) |
| **Dimensión NFR** | coste, tiempo (`NFR §3`) |
| **Corpus** | `h-02-corpus/t01…t04` — tareas de complejidad a priori creciente (L1…L4) en la familia del `smoke-repo` (ESM puro, verificación via `node -e`, sin tests) |
| **Setup** | config v0 sin tocar (lane MiniMax vía `AIES_CONFIG`, 17-ago), `cwd` = directorio de la tarea, 3 réplicas por tarea |
| **Métricas** | complejidad a priori (L), iteraciones, nº de unidades, coste.total, tiempo.total_ms, terminado (definición operacional abajo) |
| **Resultado** | 12/12 Completada; **mediana de coste casi plana y tiempo no monótono en L** (NO apoya H-02 en este lane, §7) |
| **Interpretación** | criterio a priori en §7; **no aseverar verdadero** con N=4/réplica 1 (P-19) |

---

## 1. Objetivo

Producir datos para calibrar si el coste y el tiempo de una tarea AIES crecen de forma monótona con la complejidad. No calibra umbrales: H-02 no fija cuánto debe costar cada nivel, solo la relación de proporcionalidad.

## 2. Corpus etiquetado (complejidad a priori)

Cada tarea es un micro-repo con `package.json` (ESM), `src/` con estado inicial y un `AGENTS.md` que define la tarea, las convenciones (heredadas de `runtime/fixtures/smoke-repo/AGENTS.md`) y el comando de verificación. La etiqueta complejidad es **a priori** (asignada por humano al diseñar el corpus, antes de medir).

| Tarea | Nivel | Dim. de la carga | Qué exige del agente |
|---|---|---|---|
| `t01-greet` | L1 | 1 archivo, 1 función nueva, 1 aserción | añadir `greet(name)` |
| `t02-clamp-capitalize` | L2 | 2 archivos, 2 funciones, bordes de validación, 7 aserciones | añadir `clamp` y `capitalize` preservando lo existente |
| `t03-refactor` | L3 | 3 archivos, lógica duplicada | extraer `clamp` a `src/range.js` y usarlo en dos módulos sin cambiar comportamiento público |
| `t04-count` | L4 | 1 archivo pero caso límite encubierto | diagnosticar y corregir el recuento erróneo de `countWords` sin romper los casos que ya pasan |

L es **ordinal**: no implica que L4 = 4× L1. La escala de coste/tiempo esperada es de *no decrecimiento*, no una pendiente concreta.

## 3. Setup

- Config fija v0: modelos por rol (`orchestrator`/`implementer` = `claude-sonnet-4-5`, `explorer`/`verifier` = `claude-haiku-4-5`), `thinkingLevel` del orquestador = `low`, `maxIterations` = 12. Sin tocar `aies.config.json` entre réplicas (el proveedor/modelo es variable controlada).
- Claves por env (sin secretos en el repo).
- `cwd` = directorio de la tarea. La persistencia (ADR-008) se indexa por hash del `cwd`, así que cada tarea tiene su propio `state.json`/`log.jsonl` y no se pisan entre sí.
- **Reset por réplica:** una réplica nueva del mismo `cwd` reanudaría la tarea previa (`aies run` reanuda si hay estado no terminal). Borrar antes de cada corrida el `state.json` de la tarea (la ruta la imprime el CLI al final: `<agentDir>/aies/<hash(cwd)>/state.json`). El `log.jsonl` de la réplica anterior conservarse aparte (dataset).
- No intervenir (SIGINT) durante la corrida: la intervención marca la tarea como Fallida y contamina la medición.

## 4. Ejecución por tarea

```bash
node runtime/dist/cli.js run --cwd 06-research/experiments/h-02-corpus/t01-greet "añade greet(name) a src/math.js que devuelva `hello ${name}`"
# ...repetir para t02…t04 con su enunciado del AGENTS.md...
node runtime/dist/research/metrics.js <agentDir>/aies/<hash>/log.jsonl
```

Enunciados canónicos por tarea (mismo texto que en cada `AGENTS.md` §Alcance).

## 5. Métricas (definición operacional)

Fuente única: el reporte de `runtime/src/research/metrics.ts` sobre el `log.jsonl` de cada corrida (no hay instrumentación nueva: H-02 "puede medirse ya", `06-research/README.md` mapeo `H-02`). La correlación usa las columnas:

| Columna | Definición | Origen en el reporte |
|---|---|---|
| `L` | complejidad a priori (L1…L4) | corpus (§2) |
| `iteraciones` | nº de vueltas del bucle | `dimensiones.observabilidad.decisiones` |
| `unidades` | nº de unidades distintas con resultado | nº de claves de `dimensiones.coste.por_unidad` |
| `coste` | suma de `usage.cost` de los resultados (USD) | `dimensiones.coste.total` |
| `tiempo` | `ts` de la primera → `ts` de la última entrada del log (ms) | `dimensiones.tiempo.total_ms` |
| `terminado` | hay decisión `terminar` con condición (vs intervención/límite) | `dimensiones.calidad.terminado` + `condicion` |

Notas operacionales:
- **complejidad medida** (proxy en la hipótesis): `unidades` e `iteraciones`. La correlación primaria es `L → coste/tiempo`; se registra además `unidades`/`iteraciones` para validar si el proxy medido escala con `L` (si el proxy no escala, el etiquetado a priori o la granularidad de unidad fallan — dato útil, no conclusión sobre H-02).
- **tiempo** incluye todo lo que el log abarca (vueltas y compactaciones), coherente con "tiempo de tarea". El desglose por actividad (obtener info / ejecutar / verificar / esperar) es instrumentación futura de AIES-core (README §Orquestación); no bloquea H-02.
- **coste** suma `usage` de los resultados de unidad (workers) + el de las decisiones del orquestador (telemetría del orquestador cerrada en la iteración E-01; `metrics.ts` la incluye en `coste.total` y la desglosa en `coste.orquestador`).
- Si una tarea **termina por límite o intervención**, no se excluye del dataset: se marca `terminado=false` y se reporta igual (el coste de la no-terminación también es un dato), pero se excluye de la correlación de proporcionalidad (mide fallo, no complejidad).

## 6. Resultado (datos crudos — corrida N=3 del 17-ago-2026, lane MiniMax, provider `minimax` / MiniMax-M3 + M2.7)

> **Nota de comparabilidad**: iteración ejecutada como lane exploratoria sobre `provider: minimax` (config aparte vía `AIES_CONFIG`, v0 intacta). Misma tarea/corpus/`--verify`. Columnas de metrics.js sobre `log.jsonl` real de cada corrida; `terminado` = estado real en disco (`state.json`), que además concuerda con la decisión `terminar` del log en 12/12.

### 6.1 Per-replica (r1 | r2 | r3)

| `cwd` de la tarea | L | iteraciones (r1/r2/r3) | unidades (r1/r2/r3) | coste USD (r1/r2/r3) | tiempo ms (r1/r2/r3) | terminado (state.json) |
|---|---|---|---|---|---|---|
| `t01-greet` | L1 | 5 / 5 / 5 | 2 / 2 / 2 | 0.0238 / 0.0114 / 0.0403 | 97228 / 41747 / 229608 | Completada ×3 |
| `t02-clamp-capitalize` | L2 | 6 / 5 / 6 | 3 / 2 / 3 | 0.0224 / 0.0192 / 0.0204 | 87166 / 70121 / 93642 | Completada ×3 |
| `t03-refactor` | L3 | 6 / 6 / 5 | 3 / 3 / 2 | 0.0287 / 0.0218 / 0.0214 | 212647 / 116339 / 105737 | Completada ×3 |
| `t04-count` | L4 | 5 / 5 / 6 | 2 / 2 / 3 | 0.0146 / 0.0232 / 0.0224 | 55612 / 85651 / 92598 | Completada ×3 |

- iteraciones = `observabilidad.decisiones`; unidades = nº de claves de `por_unidad` con coste > 0 (contando también las unidades de coste 0 como planificación: el conteo bruto de claves es 2–4 según réplica).
- coste incluye orquestador: share del orquestador en `coste.orquestador` por réplica — L1: 45/30/73%, L2: 31/30/31%, L3: 45/35/61%, L4: 28/19/36%. tokens totales (mediana): L1 105298, L2 121296, L3 108559, L4 111790; `pct_max` 3.4–4.4% en todas las réplicas.

### 6.2 Dispersión entre réplicas por nivel

| L | coste CV | tiempo CV | coste rango | tiempo rango |
|---|---|---|---|---|
| L1 | **47.0%** | **64.1%** | 0.0114–0.0403 | 41747–229608 ms |
| L2 | 6.5% | 11.9% | 0.0192–0.0224 | 70121–93642 ms |
| L3 | 13.9% | 33.2% | 0.0214–0.0287 | 105737–212647 ms |
| L4 | 19.2% | 20.6% | 0.0146–0.0232 | 55612–92598 ms |

- L1 (t01-greet) es la más dispersa de las tres réplicas (CV coste 47%, CV tiempo 64%): las réplicas idénticas de una tarea trivial divergen por la ruta explorada. L2 es la más estable (CV 6.5%).

### 6.3 Medianas por nivel (r1..r3)

| L | coste mediana | tiempo mediana | iteraciones mediana | unidades mediana |
|---|---|---|---|---|
| L1 | 0.0238 | 97228 ms | 5 | 2 |
| L2 | 0.0204 | 87166 ms | 6 | 3 |
| L3 | 0.0218 | 116339 ms | 6 | 3 |
| L4 | 0.0224 | 85651 ms | 5 | 2 |

- **Anomalía (no bloqueante, documentada)**: en la réplica r3 de t03-refactor (L3) el `state.json` declara `Completada` y su condición describe "extrae… a `src/range.js`… consumida desde `src/math.js` y `src/format.js`", **pero `src/range.js` no existe en disco**: el agente resolvió la duplicación copiando la lógica inline en ambos módulos (`math.js` y `format.js` quedan con `Math.min(Math.max(...))` duplicado). La verificación externa del AGENTS.md hace PASS igualmente (el resultado funcional es correcto), así que es un incumplimiento del **alcance literal** del objetivo (crear el módulo), no del comportamiento verificado.
- **Anomalía**: `verify_pass=0` en la corrida E-02 r3-t03 pese al PASS referido en su condición (veredicto en formato libre sin prefijo `VEREDICTO:`); `por_iter_ms` negativos en 12/12 corridas. Ambas anomalías heredadas de la observación 16-ago, sin impacto en las columnas usadas.
- **No reaparece** la anomalía de bookkeeping de 16-ago (t01/t04 "Fallidas" pese a PASS externo): en esta corrida las 12 tareas quedaron `Completada` tanto en `state.json` como en el log.

## 7. Interpretación (criterio a priori)

- **Apoya H-02:** coste y tiempo **no decrecientes** a lo largo de L (L2 ≥ L1, L3 ≥ L2, …) y unidades/iteraciones creciendo con L. Direccionalidad solo apunta a "proporcional" de forma débil; con N=4, réplica 1 y etiquetas ordinales no se asevera linealidad (P-19).
- **No apoya:** meseta o descenso (un agente dividiendo peor tareas fáciles que difíciles) en alguna transición.
- **Indeterminado:** poca dispersión entre réplicas (las réplicas iguales no aportan) o no-terminal en tareas altas.
- Con una sola réplica el resultado es **tendencia a reportar**, no decisión. Si las preliminares muestran dispersión relevante, subir réplicas (mínimo 3 por tarea) antes de cualquier conclusión.

### Evaluación (17-ago-2026, lane MiniMax, N=3)

- **Terminación: 12/12 Completada** (state.json real + log). A diferencia de la iteración 16-ago (que excluyó L1 y L4 por la anomalía de unidades), aquí **las 4 tareas son comparables**: ninguna midió fallo interno, todas miden ejecución completada.
- **Mediana coste**: L1 0.0238 → L2 0.0204 → L3 0.0218 → L4 0.0224. **Mediana tiempo**: 97228 → 87166 → 116339 → 85651 ms. Ambas **fallan el no-decrecimiento**: la transición L1→L2 **desciende** en coste y tiempo; la transición L3→L4 **desciende** en tiempo (85651 < 116339).
- **Proxy unidades/iteraciones**: mediana L1(5, 2) → L2(6, 3) → L3(6, 3) → L4(5, 2): crece L1→L2, se aplana en L3 y **deja de crecer en L4**. El proxy no escala con L de forma consistente.
- **Clasificación preliminar: NO APOYA H-02** — con las cuatro tareas comparables, las medianas de coste son casi planas (0.020–0.024 USD) y las de tiempo no son monótonas (descienden en L1→L2 y L3→L4); el proxy escala solo hasta L2. No hay relación de no-decrecimiento robusta entre L y coste/tiempo en este lane.
- **Caveat**: la dispersión es alta en L1 (CV 47–64%); L1 y L3 se solapan en rango de coste. Aun así, la corrección de los datos (L4 ya no excluido) y N=3 refuerzan que los números no muestran la pendiente esperada. Queda como tendencia exploratoria de un proveedor distinto; H-02 sobre anthropic (config v0) sigue sin evaluarse (P-19).

## 8. Caveats y límites conocidos

1. **Telemetría del orquestador** — cerrada en la iteración E-01: las `decision` entries llevan `usage`/`contextUsage` (y en el fallo de parseo se conserva la telemetría de la vuelta). El coste absoluto de E-02 **ya incluye orquestador**; el aviso previo del gap (análisis previo, 3.1) queda resuelto antes de concluir magnitudes.
2. N=4 tareas × 1 réplica → tamaño mínimo. No umbrales, no significancia.
3. L es ordinal a priori; la validación del proxy (`unidades`/`iteraciones`) es parte del resultado (§5).
4. `MetricsReport` cuenta `límite_alcanzado` como `!= null` incluso ausente; irrelevante para las columnas aquí (no se usan `limites`).

## 9. Referencias

- `Non-Functional-Requirements.md §3` (dimensiones coste/tiempo) y `§4` (H-02).
- `06-research/README.md` — mapeo `H-02` y plantilla de experimento; baselines (no necesarios para H-02, son instrumento de H-01/H-03).
- `runtime/src/research/metrics.ts` — runner que produce el reporte.
- `runtime/src/observability.ts` — shapes de `log.jsonl` (`DecisionLogEntry`/`ResultLogEntry`); `runtime/src/telemetry/types.ts` — `TelemetryUsage`.
- `runtime/src/persistence/file_store.ts` — claves por hash de `cwd` (reset por réplica, §3).
- `runtime/src/cli.ts` — comandos `run`/`resume` y rutas de persistencia.
- `ADR-008` (log.jsonl como dataset), `ADR-009` (acceso a `usage` por worker).