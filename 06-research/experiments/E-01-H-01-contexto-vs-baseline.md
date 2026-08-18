# E-01 — hipótesis H-01: dividir el trabajo reduce el contexto innecesario

| Campo | Contenido |
|---|---|
| **Hipótesis** | `H-01`: "dividir el trabajo entre agentes reduce el contexto innecesario" (`Non-Functional-Requirements.md §4`, fuente `OBJ-01`) |
| **Dimensión NFR** | contexto (`NFR §3`) |
| **Tarea de referencia** | mismo corpus que E-02 (`h-02-corpus/t01…t04`), **una copia fresca por brazo** (AIES y agente único) |
| **Setup** | config v0 sin tocar; mismo proveedor/modelo para ambos brazos (ver baselines/agente-unico.md); réplicas 1–3 (lane MiniMax, 17-ago) |
| **Métricas** | AIES: `tokens_total` (orquestador + workers, telemetría cerrada) — baseline: `telemetry.usage.tokens.total`; % de techo (`contextUsage.percent`); coste como control |
| **Resultado** | 12/12 pares equivalentes; **tokens AIES > baseline en 11/12** (NO apoya H-01 en este lane, §7) |
| **Interpretación** | criterio a priori en §7; **no aseverar verdadero** con 1 réplica (P-19) |

---

## 1. Objetivo

Producir datos sobre si el **contexto total consumido** por AIES (todas sus sesiones: orquestador + workers) es menor que el de un **agente único** que hace el mismo trabajo con las mismas tools y el mismo modelo. Contexto "innecesario" se opera como *tokens totales usados por brazo a igualdad de tarea y de resultado* (`RNF-07`).

## 2. Por qué este experimento arranca cerrando la telemetría del orquestador

H-01 comparaba "tokens delegados" pero el `log.jsonl` solo registraba la telemetría de los **workers** (resultados); las decisiones del orquestador iban sin `usage`. Con ese gap, el lado AIES podía medir **menos contexto del real** y cualquier conclusión de H-01 (y H-06) era prematura. Cierre (iteración E-01):

- `DecisionLogEntry` lleva ahora `usage`/`contextUsage`/`telemetryUnavailable`/`telemetryReason` (opcionales; ausentes solo en entradas sintéticas sin vuelta de host — límite/intervención/sesión nueva).
- `core/loop.ts` emite la telemetría del orquestador tanto en la decisión válida como en el camino de parse-fail (la vuelta del host existió; su coste se conserva).
- `research/metrics.ts` suma el orquestador a `coste.total`, `contexto.tokens_total` y al rango `pct_min/max`, y expone `coste.orquestador`.
- Verificado por `runtime/src/self-check/loop.ts` (las decisiones llevan la telemetría del stub) y por el reporte de `metrics.ts` sobre un log sintético.

El baseline agente-único se apoya en lo mismo: su runner mide `usage`/`contextUsage` del propio host (`baselines/agente-unico.md`).

## 3. Setup

- **Copias frescas**: para cada tarea, dos copias independientes (AIES y baseline escriben el repo):
  ```bash
  mkdir -p 06-research/experiments/e01-data
  for t in t01-greet t02-clamp-capitalize t03-refactor t04-count; do
    cp -R 06-research/experiments/h-02-corpus/$t 06-research/experiments/e01-data/$t-aies
    cp -R 06-research/experiments/h-02-corpus/$t 06-research/experiments/e01-data/$t-base
  done
  ```
- Config v0 (`aies.config.json`) intacta; claves por env; cwd = copia correspondiente. E-02 §3 (reset por réplica, sin SIGINT) aplica igual.
- Mismo modelo/proveedor para ambos brazos: AIES usa `aies.config.json`; el baseline toma sus defaults de ese mismo archivo (`--provider`/`--model` solo para check puntual, no para la corrida oficial).

## 4. Ejecución

```bash
# brazo AIES — copia *-aies, mismo objetivo que E-02
node runtime/dist/cli.js run --cwd .../e01-data/t01-greet-aies "<objetivo t01>" 
node runtime/dist/research/metrics.js <agentDir>/aies/<hash>/log.jsonl > .../e01-data/t01-aies-metrics.json

# brazo baseline — copia *-base, mismo objetivo, verificación del AGENTS.md
node runtime/dist/research/baseline.js --cwd .../e01-data/t01-greet-base --verify "<comando de AGENTS.md t01>" "<objetivo t01>" > .../e01-data/t01-base.json
```

## 5. Métricas (definición operacional)

| Columna | AIES | Baseline |
|---|---|---|
| `tokens_total` | `dimensiones.contexto.tokens_total` (orquestador + workers, telemetría cerrada) | `telemetry.usage.tokens.total` |
| `orq vs workers` | `dimensiones.contexto.orquestador_tokens` / `.workers_tokens` (desglose E-01) | — |
| `pct_max` (techo alcanzado) | `dimensiones.contexto.pct_max` | `telemetry.contextUsage.percent` |
| `coste` (control) | `dimensiones.coste.total` | `telemetry.usage.cost` |
| `resultado` (paridad) | `calidad.verify_pass/terminado` + verificación externa de la copia | `verificacion.exitCode` (comando del AGENTS.md) |

Solo se comparan **pares con resultado equivalente** (ambos brazos pasan la verificación): si el baseline no termina la tarea, el par es "tarea-incumplida", se reporta aparte y no decide H-01.

## 6. Resultado (datos crudos — corrida N=3 del 17-ago-2026, lane MiniMax, provider `minimax` / MiniMax-M3 + M2.7)

> **Nota de comparabilidad**: E-01 estaba diseñado para `provider: anthropic` (config v0). Se ejecutó como **lane exploratoria** sobre `provider: minimax` (config aparte vía `AIES_CONFIG`, sin tocar v0, misma tarea/corpus/`--verify`). Los valores absolutos **no son comparables** con la referencia anthropic del plan; la comparación interna AIES-vs-baseline a igual proveedor/modelo sí es válida. Ambos brazos usaron el mismo objetivo canónico y el mismo comando de verificación del AGENTS.md. **P-19**: las conclusiones al final de §7 aplican a este lane; H-01 sobre anthropic sigue pendiente de réplicas con el proveedor de referencia.

### 6.1 Per-replica (r1 | r2 | r3)

| tarea | L | AIES tokens (r1/r2/r3) | AIES pct_max (r1/r2/r3) | AIES coste (r1/r2/r3) | AIES ok? | BASE tokens (r1/r2/r3) | BASE pct_max | BASE coste | BASE ok? |
|---|---|---|---|---|---|---|---|---|---|
| t01-greet | L1 | 108608 / 85317 / 61086 | 3.59 / 3.63 / 3.44 % | 0.0232 / 0.0181 / 0.0129 | PASS/PASS/PASS | 29097 / 29171 / 36763 | 0.74 / 0.75 / 0.76 % | 0.0039 / 0.0040 / 0.0045 | exit 0 ×3 |
| t02-clamp-capitalize | L2 | 111401 / 183633 / 135092 | 4.01 / 4.01 / 4.33 % | 0.0227 / 0.0329 / 0.0285 | PASS/PASS/PASS | 69583 / 79759 / 61751 | 0.84 / 0.89 / 0.83 % | 0.0072 / 0.0082 / 0.0066 | exit 0 ×3 |
| t03-refactor | L3 | 131766 / 129926 / 169681 | 4.24 / 1.09 / 4.45 % | 0.0289 / 0.0270 / 0.0368 | PASS/PASS/PASS | 57270 / 50236 / 71350 | 0.91 / 0.92 / 0.90 % | 0.0070 / 0.0066 / 0.0079 | exit 0 ×3 |
| t04-count | L4 | 90486 / 57679 / 212832 | 3.72 / 0.92 / 3.84 % | 0.0169 / 0.0099 / 0.0392 | PASS/PASS/PASS | 69269 / 89356 / 35602 | 1.54 / 1.64 / 0.97 % | 0.0164 / 0.0210 / 0.0072 | exit 0 ×3 |

- AIES ok? = verificación externa (`node -e` de cada AGENTS.md) sobre la copia `*-aies`; baseline ok? = `verificacion.exitCode`. **12/12 pares equivalentes**; ninguna tarea-incumplida.
- AIES `calidad.terminado=true` en las 12 corridas; `verificacion.error` ausente en los 12 baselines. Sin compactions.

### 6.2 Agregados y variabilidad por tarea (r1..r3, coste en USD)

| tarea | L | AIES tokens mediana | BASE tokens mediana | razón | BASES/A coef | AIES pct_max mediana | BASE pct | AIES coste mediana | CV coste | tiempo AIES* |
|---|---|---|---|---|---|---|---|---|---|---|
| t01-greet | L1 | 85317 | 29171 | 2.92 | 22.8% | 3.59% | 0.75% | 0.0181 | 23.3% | 98.2 s |
| t02-clamp-capitalize | L2 | 135092 | 69583 | 1.94 | 21.0% | 4.01% | 0.84% | 0.0285 | 15.0% | 115.9 s |
| t03-refactor | L3 | 131766 | 57270 | 2.30 | 12.7% | 4.24% | 0.91% | 0.0289 | 13.7% | 140.4 s |
| t04-count | L4 | 90486 | 69269 | 1.31 | **55.5%** | 3.72% | 1.54% | 0.0169 | **56.9%** | 58.8 s |

\*tiempo AIES mediana (`dimensiones.tiempo.total_ms`); baseline mediana: 6.7 / 43.7 / 28.3 / 86.9 s (t04 es el único donde el baseline supera con claridad al AIES en r1 y r2: 125.0 / 87.0 s vs 58.8 / 37.6 s; r3: 205.3 s AIES vs 39.7 s BASE).

- t01–t03: dispersión moderada (CV 13–23%). t04 es la tarea **más inestable**: CV 55% en tokens y 57% en coste (rango 57679–212832 tokens; 0.0099–0.0392 USD), y además es el único par donde una réplica (r2) da AIES con **menos** tokens y menos `pct_max` que el baseline (57679 vs 89356; 0.92% vs 1.64%).
- En 11/12 pares `tokens_total(AIES) > tokens_total(baseline)` y `pct_max(AIES) > pct_max(baseline)`; la única excepción es el par comentado (r2-t04). La dirección se mantiene en las 3 réplicas salvo ese caso aislado.

### 6.3 Desglose orquestador vs workers (variabilidad incluida)

| tarea | L | orq tokens (share % por réplica) | orq coste (share % por réplica) | workers tokens mediana | workers coste mediana |
|---|---|---|---|---|---|
| t01-greet | L1 | 46 / 32 / 28 % | 51 / 38 / 40 % | 58352 | 0.0112 |
| t02-clamp-capitalize | L2 | 35 / 30 / 27 % | 39 / 42 / 39 % | 98667 | 0.0174 |
| t03-refactor | L3 | 36 / 19 / 34 % | 43 / 40 / 47 % | 105497 | 0.0164 |
| t04-count | L4 | 15 / 12 / 21 % | 20 / 32 / 36 % | 76676 | 0.0136 |

- El orquestador supone una minoría del contexto: 12–46% de los tokens y 20–51% del coste según tarea/réplica; en todas las tareas **los workers son la mayor parte** (54–88% de los tokens). t04 es donde menos pesa el orquestador (12–21% tokens) porque es una tarea de 1 fichero con corrección acotada → pocas decisiones de coordinación.
- **Índice del brief (por par, sobrecoste vs coste del orquestador)** — `(SAIES − Sbase) / S_orquestador`:

| par | r1 | r2 | r3 |
|---|---|---|---|
| t01 (L1) | (0.0232−0.0039)/0.0120 = **1.61** | 0.0142/0.0070 = **2.03** | 0.0084/0.0051 = **1.64** |
| t02 (L2) | 0.0155/0.0089 = **1.74** | 0.0247/0.0139 = **1.78** | 0.0219/0.0111 = **1.97** |
| t03 (L3) | 0.0219/0.0125 = **1.76** | 0.0204/0.0107 = **1.90** | 0.0290/0.0172 = **1.69** |
| t04 (L4) | 0.0006/0.0033 = **0.17** | −0.0112/0.0031 = **−3.57** | 0.0320/0.0140 = **2.29** |

  En t01–t03 el sobrecoste total es **1.6–2.0× el coste del orquestador**: el coste extra de AIES frente al agente único NO se explica solo por la coordinación — los workers (resultados de unidad) duplican el trabajo que el baseline hace en una única sesión. En t04 (L4) el patrón es errático (−3.57…2.29): tareas cortas con alta sensibilidad a la ruta explorada.

## 7. Interpretación (criterio a priori)

- **Apoya H-01:** `tokens_total(AIES) < tokens_total(baseline)` en la mayoría de pares equivalentes, con el `pct_max` (presión de techo) no mayor en AIES.
- **No apoya:** tokens AIES ≥ baseline (la división añade contexto en lugar de quitarlo).
- **Indeterminado:** pocos pares equivalentes (muchos fallos en un brazo), réplicas dispersas, o diferencias pequeñas frente al coste de coordinación que no se desglosa.
- Con réplica 1 el resultado es **tendencia a reportar**, no decisión. Si las preliminares apuntan a apoyo, subir réplicas (mínimo 3) antes de aseverar.

### Evaluación (17-ago-2026, lane MiniMax, N=3)

- **Pares equivalentes: 12/12**; sin tareas-incumplidas ni no-equivalencias. La paridad es total en ambos brazos (verificación externa PASS y `exit 0`), de modo que ninguna anomalía de resultado condiciona la comparación.
- **Dato dominante**: en **11/12 pares** `tokens_total(AIES) > tokens_total(baseline)` (razones 1.3–5.9×) y `pct_max(AIES) > pct_max(baseline)` (3.4–4.5% vs 0.7–1.6%); la única excepción es el par r2-t04 (L4), donde AIES usó 57679 tokens y 0.92% de techo frente a 89356 / 1.64% del baseline. La dirección opuesta a H-01 se sostiene en las 3 réplicas de t01–t03 (CV 13–23%) y solo se enturbia en t04 (CV 55%).
- **Clasificación: NO APOYA H-01** (dirección opuesta a la hipótesis, ahora con N=3): en este lane el orquestador+workers consumen más tokens totales y más techo de contexto que el agente único a igual tarea y resultado. La replicación no cambia la conclusión de la preliminar (16-ago).
- **Desglose**: el sobrecoste no es un artefacto del orquestador. La coordinación supone 12–46% de los tokens; el resto (54–88%) lo consumen los workers re-leyendo/reescribiendo el repo, y el índice `(SAIES−Sbase)/S_orq` da 1.6–2.0× en t01–t03.
- **Caveat crítico (inalterado)**: el baseline ejecuta una prompt y MiniMax responde en 5–40 s; el AIES re-escanea y verifica en varias iteraciones (4–6 decisiones). La diferencia es proporcional al trabajo/iteraciones del AIES, no a la hipótesis de "contexto delegado". H-01 (sobre anthropic, config v0) **sigue sin evaluarse**: los números de este lane no sustituyen a la referencia del plan (P-19).
- **Anomalías observadas (registradas, no corregidas)**: (a) `verify_pass=0` en las corridas E-01 r2-t03, r2-t04 y r3-t03 pese a PASS de la verificación externa — el veredicto del log iba en formato libre sin el prefijo `VEREDICTO:` que busca el regex; (b) `por_iter_ms` negativos en 12/12 corridas (el `ts` de alguna decisión es posterior al de su resultado por reanudación/orden de escritura) — anomalía ya documentada, sin impacto en las columnas usadas.

## 8. Caveats y límites conocidos

1. **Contexto ≠ ventana completa**: `tokens_total` es tokens usados (delta de stats), no el tamaño del contexto *delegado* por unidad; `pct_max` es la presión de techo. El desglose de tokens delegados por unidad (RNF-07) es ampliación, no bloqueante.
2. N=4 tareas × 1 réplica → tamaño mínimo. Sin umbrales ni significancia.
3. El baseline ejecuta **una** prompt autónoma: no tiene el `siguiente paso`/reanudación de AIES; tareas que exijan iteración explícita con el usuario pueden terminar peor (eso es parte del dato de paridad).
4. La compactación (techo de contexto) la aplica el host en ambos brazos y deja huella en AIES (`compaction`) y en el `contextUsage.percent` observado.

## 9. Referencias

- `Non-Functional-Requirements.md §3` (contexto, `RNF-07`) y `§4` (`H-01`).
- `06-research/README.md` — mapeo `H-01`, plan de baselines; `06-research/baselines/agente-unico.md`.
- `runtime/src/research/metrics.ts` (reporte AIES con orquestador); `runtime/src/research/baseline.ts` (reporte baseline).
- `runtime/src/observability.ts` (`DecisionLogEntry` con telemetría) y `runtime/src/core/loop.ts` (emisión).
- `runtime/src/self-check/loop.ts` — verificación del cierre de telemetría.
- `ADR-008` (log.jsonl como dataset), `ADR-009` (usage/contextUsage per sesión).