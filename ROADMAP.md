# AIES — Roadmap del proyecto

> Estado: **borrador vivo**. Trazabilidad: este documento **deriva** de la spec
> (`01-Concept/`, `02-Requirements/`, `03-Architecture/`, `04-Behavior/`,
> `05-Decisions/`, `06-research/`) y no introduce decisiones de arquitectura.
> Las decisiones viven en ADRs; este roadmap solo las **ordena en el tiempo** y
> marca criterios de salida medibles.
>
> Última revisión: 2026-08-21.

---

## 0. Radiografía del estado actual

### 0.1 Lo que funciona (el esqueleto está sano)

El runtime v0.2.0 cumple su contrato como harness. Lo concreto:

- **Bucle puro** `estado → decisión → operación → resultado` con Zod en el
  trust boundary (`ADR-007`). Parse-fail del orquestador **no** es crash: se
  trata como información insuficiente y se reentra al bucle (3 fallos seguidos
  ⇒ intervención, no terminación silenciosa).
- **Tres workers** (`ADR-004`): `explorer` (read-only), `implementer`
  (lectura + edición mínima) y `verifier` (lectura + comprobación, **sin**
  `edit`/`write`). Cada `AgentSession` es efímera y con allowlist estricta
  (`ADR-009`, `RNF-05`).
- **Persistencia** en `<cwd>/.aies/{state.json, log.jsonl}` (CLI activa)
  con recuperación ante corrupción (`ADR-008`). Reanudación por `state.json`
  + `AGENTS.md` (`RNF-10`, `RNF-16`).
- **Límites con irrecuperabilidad visible** (`ADR-005`): `maxIterations=12`
  (provisional) con intervención como respuesta por defecto; nunca
  continuación silenciosa (`RNF-19`).
- **Intervención** por SIGINT (canal de proceso) → `RuntimeState::Fallida` o
  `En curso` según intención.
- **Telemetría cerrada**: `DecisionLogEntry` lleva `usage`/`contextUsage` del
  orquestador (incluido parse-fail), `core/loop.ts` suma orquestador + workers
  en `TaskTelemetry` (`RNF-07`/`RNF-17`).
- **5 self-checks** (`parse`, `unitid`, `loop`, `cost`, `compaction`,
  `workers`) + vitest e2e sin LLM. ~4.400 líneas de TS estricto.
- **CLI standalone** oneshot (`aies "<tarea>"`) y REPL (`/help`, `/state`,
  `/state --json`, `/status`, `/resume`, `/clear`, `/exit`). Instalador `install.sh` clona a `~/.aies` y enlaza `aies`.
  Reanudación T1: `/resume` continúa un `state.json` `En curso`. `/status` enriquecido (T3.2) lee telemetría agregada del historial sin reejecutar el bucle.
- **Oleada 0 — Onboarding** ✅ (2026-08-23): `/login` `/logout` `/auth` `/models` `/model` `/pick` (REPL) y `aies auth|login|logout|models|pick` (oneshot). Credenciales vía store de pi-coding-agent (`~/.pi/agent/auth.json`). `resolveModel()` ahora resuelve provider+id desde `aies.config.json` (fix del wire gap). Modelos por rol efectivos en decide y workers (wiring del config).

### 0.2 Lo que la data dice (esto es lo importante)

Los dos primeros experimentos del lane MiniMax (17-ago-2026, N=3) arrojan
resultados que el MVP no puede ignorar:

**E-01 — H-01 (contexto): NO APOYA.** En **11/12 pares** AIES consume
**1.3–5.9× más tokens** que el agente único y un `pct_max` mayor
(3.4–4.5% vs 0.7–1.6%). La única excepción es un par r2-t04 (L4) donde la
dirección se invierte.

El desglose es la pista operativa:

| Capa          | Share de tokens          | Rol                            |
|---------------|--------------------------|--------------------------------|
| Workers       | 54–88%                   | Re-leen / re-escriben el repo  |
| Orquestador   | 12–46%                   | Coordinación pura              |

El **sobrecoste total** es **1.6–2.0× el coste del orquestador** en t01–t03
(índice `(SAIES − Sbase) / S_orq`). Es decir: **el problema no es la
coordinación, es que cada worker re-descubre lo que el Explorer ya encontró**.
El diseño de "contexto limpio por unidad" es correcto (P-09, ADR-006), pero el
"**contexto intencional**" entre unidades no está siendo transportado.

**E-02 — H-02 (coste/tiempo ∝ complejidad): NO APOYA.** Coste plano
(0.020–0.024 USD) y tiempo no monótono de L1 a L4. El proxy
`unidades/iteraciones` solo crece de L1 a L2.

**Caveat crítico**: ambos experimentos se ejecutaron sobre el corpus
`h-02-corpus/t01…t04` — tareas de **uno a pocos archivos** (L1–L4). El nicho
de H-01 son tareas **multi-archivo y largas**, donde el agente único
satura contexto o pierde el hilo. Con el corpus actual, **H-01 es
infalsable a favor**: en tareas donde el monolito basta, AIES no puede ganar;
el overhead de coordinación es pérdida pura. La pendiente de la hipótesis
solo aparece más allá de cierto tamaño.

### 0.3 Anomalías de medición registradas (afectan a E-01 y siguientes)

- **`verify_pass=0` pese a verificación externa PASS** en 3/12 corridas
  (r2-t03, r2-t04, r3-t03). Causa: el Verifier devolvió el veredicto en
  formato libre sin el prefijo `VEREDICTO:`, que el regex del log no
  tolera. Contamina la métrica de calidad de la que depende H-03.
- **`por_iter_ms` negativos en 12/12 corridas**. Causa: orden de escritura
  al reanudar turnos; el `ts` de alguna decisión es posterior al de su
  resultado. Anomalía sin impacto en las columnas usadas, pero impide
  cronometría por iteración para `RNF-03` y para Fase 3.

### 0.4 Lagunas de producto (independientes de la data)

- **Sin CI.** No existe `.github/`; nada protege `main` (un `tsc --noEmit`
  en local no es equivalente). Cualquier regresión de tipos entra
  silenciosamente hasta que alguien rompe el `build`.
- **Higiene de lockfiles.** `runtime/` contiene a la vez `package-lock.json`
  y `pnpm-lock.yaml` (con `pnpm-workspace.yaml` y `.npmrc`); el repo
  necesita un package manager único.
- **Límite de coste OFF** por defecto y sin implementación activable
  (MVP-v0-Scope §4 lo declara explícito). `maxIterations=12` es
  provisional, no calibrado.
- **Intervención mínima**: solo detiene; `Runtime-Model §7` ya define la
  intervención como *entrada que ajusta*, no solo como *detención*.
- **Observabilidad diferida**: el footer TUI por iteración y `/status`
  rico son open questions del `runtime/README`, no capacidades activas.
- **Lane de referencia anthropic sin correr.** E-01/E-02 se ejecutaron sobre
  MiniMax por oportunidad; la config v0 del MVP llama a anthropic y la
  comparación interna MiniMax **no sustituye** a la referencia del plan
  (P-19).

---

## 1. Principios de priorización

Estos principios ordenan el roadmap; no son decisiones nuevas — son
re-expresiones operativas de la spec ya cerrada.

1. **Evidencia antes que intuición (P-19).** Ningún valor se calibra sin
   datos; ningún umbral se preestablece. Cuando un experimento refute la
   intuición inicial, se sigue el dato.
2. **Cerámica mínima, evidencia máxima.** Las fases se justifican por el
   fallo que cierran, no por la mejora que prometen.
3. **Deferred solo tras evidencia.** Lo listado en `MVP-v0-Scope §Deferred`
   permanece diferido hasta que aparezca una necesidad demostrada
   (`ADR-004`: un worker por defecto hasta necesidad demostrada).
4. **No-degradación de calidad (RNF-15).** AIES debe mantener o mejorar la
   calidad frente a los baselines; ningún cambio de eficiencia puede
   sacrificar verificación.
5. **Límites visibles, nunca silenciosos (ADR-005, RNF-19).** Cualquier
   cambio que toque el repertorio de límites debe fallar de forma
   observable.
6. **Ponytail.** Nada de abstracciones anticipadas, factories ni
   HostAdapter hasta que aparezca un segundo consumidor. El código que
   nunca se escribe escala infinito.

---

## 2. Fases

```text
┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
│  Fase 0    │───▶│  Fase 1    │───▶│  Fase 2    │───▶│  Fase 3    │───▶ Fase 4
│Instrumentos│    │ Nicho de   │    │Calibración │    │  Producto  │    │Deferred
│fiables     │    │ AIES       │    │            │    │            │    │Tier 2/3/4
└────────────┘    └────────────┘    └────────────┘    └────────────┘
```

Las flechas son **dependencia dura**: cada fase consume los criterios de
salida de la anterior. Una fase puede empezar en paralelo a la anterior
solo donde se indique explícitamente.

---

### Fase 0 — Instrumentos fiables

> **Motivación.** No se puede calibrar con instrumentos que miden mal, ni
> defender la tesis con datos cuyo parser falla en 3/12 corridas.

**Items:**

0.1 **Fix del parseo de `VEREDICTO:`** en el log del Verifier.
    - Endurecer el regex (tolerar mayúsculas, espacios, prefijos tipo
      "**Veredicto:**" / "Result: VEREDICTO") **o** migrar a salida
      estructurada (JSON / tagged block) y dejar el regex como fallback.
    - Reforzar el prompt del Verifier (`workers/prompts.ts::VERIFIER_PROMPT`)
      para que la última línea no sea decorativa.
    - Re-correr E-01 con el parser arreglado y verificar que `verify_pass`
      coincide con la verificación externa en 12/12.

0.2 **Fix de timestamps** (`por_iter_ms` negativos).
    - Forzar orden de escritura al reanudar turnos (turn → decision → execute
      → result, todos con `ts` monótono o derivado de un contador por turno).
    - Validación: 1 sesión larga (≥ 10 iteraciones) sin timestamps
      desordenados.

0.3 **CI mínimo** (`.github/workflows/ci.yml`).
    - Triggers: `push` a `main`, `pull_request` a `main`.
    - Pasos: `pnpm install --frozen-lockfile` → `pnpm run typecheck` →
      `pnpm test`. Sin secrets en el repo.
    - Cache de `node_modules` con clave por `pnpm-lock.yaml`.

0.4 **Higiene de package manager**.
    - Decidir **pnpm** (el repo ya tiene `pnpm-workspace.yaml`, `.npmrc`,
      `pnpm-lock.yaml`; presumiblemente el flujo de release es pnpm).
    - Borrar `runtime/package-lock.json` y regenerar el árbol.

**Criterios de salida:**

- `verify_pass` se alinea con verificación externa en 12/12 sobre
  `h-02-corpus` (criterio **medible**, no aspiracional).
- `por_iter_ms ≥ 0` en cualquier corrida de ≥ 10 iteraciones.
- CI verde en `main` con `typecheck` + `test` corriendo contra la rama.
- Solo hay **un** lockfile en `runtime/`.

**Trazabilidad:** `06-research/experiments/E-01 §7 (anomalías)`,
`runtime/src/observability.ts`, `runtime/src/workers/prompts.ts`.

---

### Fase 1 — Encontrar el nicho donde AIES gana

> **Motivación.** E-01 no puede falsar H-01 a favor con tareas pequeñas;
> mientras tanto, la palanca #1 (re-read de workers) está identificada por
> datos. Esta fase ataca las dos cosas.

**Items:**

1.1 **Corpus duro multi-archivo (L5+)**.
    - Añadir ≥ 3 tareas nuevas en `06-research/experiments/h-02-corpus/`:
      - L5: refactor que cruza 3–5 módulos con tests existentes.
      - L6: feature nuevo que requiere leer 5–10 archivos para entender
        el dominio antes de tocar nada.
      - L7: bug de larga cola donde el síntoma está lejos de la causa
        (forzar exploración profunda antes de implementación).
    - Cada tarea con `AGENTS.md` reproducible y comando de verificación
      externo equivalente al de t01–t04.

1.2 **Contexto intencional Explorer → Implementer** (la palanca del 1.6–2.0×).
    - Diseñar el contrato: el Explorer emite un `Brief` estructurado
      (mapa de archivos relevantes, fragmentos citados con offset,
      conclusiones, suposiciones) que el bucle adjunta a la `unidad`
      Implementer como *input*, no como texto libre.
    - Forma: JSON validado por Zod, persistido en `state.results` como
      artefacto (`atribución: "explorer-brief"`).
    - Sub-experimento de control: misma tarea, con y sin `Brief`, sobre
      L5 y L6, N=3. Resultado esperado: el sobrecoste workers/baseline
      cae por debajo de 1.5× en L5 y por debajo de 1.2× en L6.

1.3 **Sesión persistente opcional para Implementer** (sub-experimento).
    - Hoy cada worker es efímero (`SessionManager.inMemory`).
      Permitir `SessionManager.create` como flag opcional para unidades
      Implementer que tocan archivos ya explorados (replay fino,
      `MVP-v0-Scope §Deferred` Tier 3).
    - Solo si 1.2 no basta para alcanzar el criterio de Fase 1.

1.4 **Lane anthropic (config v0)**.
    - Re-correr E-01 y E-02 sobre `aies.config.json` con
      `provider: anthropic` (MiniMax-M2.7 como lane secundario, no como
      referencia). Réplicas: N ≥ 3 por tarea del corpus duro.
    - Hasta que esta réplica no corra, **no** se afirma H-01 ni H-02 a
      nivel global (P-19).

**Criterios de salida:**

- En **≥ 1 tarea del corpus duro**, `tokens_total(AIES) < tokens_total(baseline)`
  con `verify_pass` equivalente, en el lane anthropic.
- Sub-experimento 1.2: sobrecoste workers/baseline por debajo del umbral
  del item, sobre L5 y L6.
- E-01/E-02 actualizados con el corpus duro y referenciados desde
  `06-research/README.md`.

**No-objetivos de esta fase:** añadir un 4.º worker, cambiar el catálogo
de capacidades, rediseñar el bucle, mover a `HostAdapter`.

**Trazabilidad:** `MVP-v0-Scope §Deferred Tier 3 (replay fino)`,
`ADR-006` (re-descomposición), `Decision-Model §11` (huella de
observabilidad), `06-research/README §Mapeo H-01/H-02`.

---

### Fase 2 — Calibración

> **Motivación.** Los valores por defecto del MVP son explícitamente
> provisionales. Esta fase los convierte en calibrados — pero solo tras
> Fase 1, para no calibrar contra un corpus que no puede validar la tesis.

**Items:**

2.1 **`thinkingLevel` del orquestador**.
    - Comparativa `low` vs `medium` (vs `high` si el modelo lo soporta)
      sobre el corpus duro, N=3 por tarea.
    - Métrica: ratio calidad/coste (verificador pasa? — coste — latencia).
    - Decisión: si `low` no degrada calidad, se queda; si degrada, sube
      el default y se documenta.

2.2 **`maxIterations=12` y señales de re-descomposición**.
    - Medir en qué iteración se cierran las tareas del corpus duro
      (mediana y percentil 90).
    - Recalibrar `maxIterations` al percentil 90 con margen — sin asumir
      que "más iteraciones = mejor"; debe haber regresión clara para
      subir.
    - Evaluar si las cuatro señales de `ADR-006` disparan en los
      momentos correctos (no por ruido, no por pereza).

2.3 **Límite de coste** (de OFF a opcional y calibrado).
    - Implementar `limits.maxCost` como campo opcional de
      `aies.config.json` (default: sin tope).
    - Acción al alcanzar el límite: intervención, igual que `ADR-005`.
    - Calibración: tomar mediana de coste por tarea del corpus duro y
      fijar el default como mediana × factor de margen (p.ej. 1.5×).

2.4 **Experimentos pendientes** (mapeo `H-01…H-06`):
    - **H-03** (calidad vs baselines) — el argumento de venta real de
      AIES. Sin esto, Fase 3 no tiene base.
    - **H-04** (eficacia de la especialización) — complementar con
      prompts A/B por worker.
    - **H-06** (modelo caro vs Implementer barato + Verifier fuerte).
      Si Fase 1 muestra que AIES no gana en tokens, **H-06** es la
      hipótesis que le da sentido económica: misma calidad a menor
      coste. **Crítico** si Fase 1 confirma el resultado de E-01.

**Criterios de salida:**

- `thinkingLevel`, `maxIterations`, `maxCost` calibrados con datos del
  corpus duro + lane anthropic, documentados en `aies.config.json` con
  comentarios (sin valores arbitrarios).
- H-03 y H-06 medidos y reportados en `06-research/experiments/`.
- El README raíz cita los resultados (con honestidad P-19: "apoya",
  "no apoya", "indeterminado").

**Trazabilidad:** `Non-Functional-Requirements §3-§4`, `ADR-004`,
`ADR-005`, `06-research/README §Mapeo H-01…H-06`.

---

### Fase 3 — Producto

> **Motivación.** Hasta aquí el runtime es correcto y la tesis calibrada.
> Esta fase lo hace usable por alguien que no sea el autor.

**Items:**

3.1 **Observabilidad viva (Tier 3)**.
    - Footer TUI por iteración: `iter`, `tokens_total`, `coste`,
      `pct_contexto`, `verify_pass` acumulado.
    - `/status` enriquecido: árbol de unidades, telemetría agregada,
      huella mínima de cada vuelta (referencia a `log.jsonl` por offset).
    - Color y contraste ya validados en `stream-renderer.ts`; este item
      solo añade los datos, no la estética.

3.2 **Intervención rica** (`Runtime-Model §7`).
    - Hoy SIGINT solo detiene. Extender el canal para inyectar:
      - **Ajuste** ("sigue pero considera X") — modifica `state.knownInfo`
        o `state.nextStep`, no la unidad en curso.
      - **Reanudación con guía** ("resume, y esta vez verifica Y primero")
        — se incorpora al estado y se procesa en la siguiente decisión.
    - Mantener la primitiva actual de detención como caso especial.

3.3 **Historial y multi-tarea por proyecto**.
    - Hoy hay una tarea por `hash(cwd)`; ampliar para historial de
      tareas con nombre (`aies run --name "<tarea>" "<objetivo>"`).
    - `/status` y `/resume` deben resolver por nombre cuando exista.

3.4 **Una sesión larga como smoke** (`runtime/README §open questions`).
    - Smoke de aceptación: una sesión ≥ 30 minutos sin intervención
      manual completada, sobre el corpus duro.
    - Métrica: tiempo total, número de iteraciones, número de
      re-descomposiciones, `verify_pass` final.

**Criterios de salida:**

- 1 sesión larga (≥ 30 min) completada sin intervención manual sobre el
  corpus duro, con footer TUI mostrando telemetría por iteración.
- `/status` lee telemetría agregada desde `log.jsonl` sin reejecución.
- Intervención rica: ≥ 1 caso de prueba (unit test del bus de eventos)
  cubriendo "ajuste" y "reanudación con guía".

**No-objetivos:** UI web, multi-tenant, colaboración.

**Trazabilidad:** `runtime/README §open questions`, `MVP-v0-Scope
§Deferred Tier 3`, `Runtime-Model §7`.

---

### Fase 4 — Deferred explícitos (Tier 2/3/4)

> Solo se abordan cuando aparezca una necesidad demostrada por la data o
> por un usuario real. Mientras tanto, permanecen en
> `MVP-v0-Scope §Deferred`.

**Tier 2:**
- Permisos y sandbox por worker (más allá del allowlist actual).
- Taxonomía de errores estructurada.
- Modelo de permisos declarativo.
- Perfiles de límites por forma de tarea (`RNF-20`).

**Tier 3:**
- Replay fino de sesión de worker (cierre del item 1.3 de Fase 1).
- Afirmación de capability comprobada (`Capability-Model §10.3`).

**Tier 4:**
- `HostAdapter` para un 2.º host (solo si aparece).
- Portabilidad de `state.json` entre máquinas.
- Limpieza de `Vision.md`.

**Mantenimiento:**
- **v2**: eliminar `runtime/src/extension/` (deprecated desde
  `ADR-010`, 2026-08-20).

**Trazabilidad:** `MVP-v0-Scope §Deferred`, `05-Decisions/ADR-010`.

---

## 3. Camino crítico

```text
Fase 0 ──▶ Fase 1 (ítems 1.1 + 1.2 + 1.4) ──▶ Fase 2
   │            │
   │            └── si 1.2 no basta → 1.3 (sesión persistente)
   ▼
  CI verde + Verifier correcto + timestamps OK
```

**Sin Fase 0 no se calibra nada.** Sin Fase 1 (corpus duro + contexto
intencional + lane anthropic) no se puede defender la tesis. **Fase 2
sin Fase 1 es calibrar contra el corpus equivocado.** Fase 3 puede
arrancar parcialmente en paralelo a Fase 2 (observabilidad viva es
ortogonal a la calibración).

---

## 4. Métricas de éxito por fase (sin umbrales preestablecidos)

Coherente con `P-19` y `ADR-004`: ningún umbral numérico se asume
verdadero. Las cifras de abajo son **criterios de salida del roadmap**,
no metas autoimpuestas — se recalibran si la data lo pide.

| Fase | Métrica                                                                                          | Cómo se mide                                              |
|------|--------------------------------------------------------------------------------------------------|------------------------------------------------------------|
| 0    | `verify_pass` ≡ verificación externa en 12/12 sobre `h-02-corpus`                                | Re-correr E-01 con parser arreglado                        |
| 0    | `por_iter_ms ≥ 0` en sesiones ≥ 10 iteraciones                                                   | Self-check / sesión larga sintética                        |
| 0    | CI verde con `typecheck` + `pnpm test` en `main`                                                | GitHub Actions status                                     |
| 1    | En ≥ 1 tarea del corpus duro: `tokens_total(AIES) < tokens_total(baseline)` con `verify_pass` ≡  | Sub-experimento sobre L5/L6/L7, lane anthropic             |
| 1    | Sub-exp 1.2: sobrecoste workers/baseline < 1.5× en L5, < 1.2× en L6                              | Sub-experimento A/B                                       |
| 2    | `thinkingLevel`, `maxIterations`, `maxCost` documentados con datos                               | Métricas extraídas de `log.jsonl` (`research/metrics`)     |
| 2    | H-03 y H-06 reportados (apoya / no apoya / indeterminado)                                       | `06-research/experiments/E-0X-*.md`                        |
| 3    | 1 sesión ≥ 30 min completada sin intervención manual                                            | Smoke de aceptación                                        |
| 3    | `/status` lee telemetría agregada de `log.jsonl` sin reejecutar                                  | ✅ `runtime/src/cli-status.ts` + `cli-status.test.ts` (10 casos, log sintético) |

---

## 5. No-objetivos del roadmap

Para evitar reabrir debates cerrados:

- **No** se rediseña el bucle (`ADR-007`). El orden por turno
  (`ajustePlan` antes de operación) y el repertorio de operaciones
  (`Decision-Model §2`) son fijos.
- **No** se añade un 4.º worker sin evidencia (Explorer / Implementer /
  Verifier son la cuota actual; `ADR-004`).
- **No** se toca `ADR-009` (binding a pi) sin motivo: la integración
  host es estable y `pi` provee `ModelRuntime` + `autoCompaction`.
- **No** se reescribe la spec (`01-Concept` → `06-research`). Cambios
  filosóficos van a nuevos ADRs, no a este roadmap.
- **No** se sincroniza nada a servicios externos. La regla absoluta del
  proyecto es local-first.
- **No** se introducen secretos en el repo. Auth siempre por env.

---

## 6. Referencias cruzadas

| Tema                              | Dónde vive                                                  |
|-----------------------------------|--------------------------------------------------------------|
| Catálogo v0 + contratos           | `03-Architecture/MVP-v0-Scope.md §1`                        |
| Límites y repertorio              | `05-Decisions/ADR-005`, `MVP-v0-Scope §4`                   |
| Re-descomposición                 | `05-Decisions/ADR-006`                                       |
| Orquestador (no-tools)            | `05-Decisions/ADR-007`                                       |
| Persistencia / log                | `05-Decisions/ADR-008`                                       |
| Integración host                  | `05-Decisions/ADR-009` (activo) y `ADR-010` (deprecated)    |
| Hipótesis H-01…H-06               | `02-Requirements/Non-Functional-Requirements.md §4`          |
| Métricas NFR §3                   | `02-Requirements/Non-Functional-Requirements.md §3`          |
| Plantilla de experimento          | `06-research/README.md`                                      |
| E-01 / E-02 (resultados)          | `06-research/experiments/E-01-H-01-*.md`, `E-02-H-02-*.md`  |
| Decision shape                    | `03-Architecture/Decision-Model.md §2/§4/§11`               |
| Lifecycle                         | `04-Behavior/Lifecycle.md §3`                                |
| Open questions del runtime        | `runtime/README.md §open questions`                          |
| Deferred del MVP-v0               | `03-Architecture/MVP-v0-Scope.md §Deferred`                  |
| Principios operativos             | `01-Concept/Principles.md`                                   |
| Roadmap de la TUI                 | `ROADMAP-TUI.md`                                             |

---

## 7. Cómo se actualiza este documento

- **Trimestral** o ante cualquier cierre de fase: el responsable actualiza
  criterios de salida con datos, recalibra si hace falta y mueve ítems
  entre fases si la realidad lo pide.
- **Cualquier propuesta** que contradiga una ADR existente **se rechaza
  aquí** y se eleva a una nueva ADR. Este documento no decide, solo
  secuencia.
- Los **criterios de salida medibles** sustituyen a las fechas. Un ítem
  sin criterio de salida no sale de su fase.
