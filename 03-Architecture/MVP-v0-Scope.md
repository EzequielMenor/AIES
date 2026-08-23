# AIES — MVP-v0: alcance implementation-ready

Este documento sintetiza `ADR-007`, `ADR-008` y `ADR-009` en **una sola referencia lista para implementar** el runtime v0 sobre pi. No introduce decisiones nuevas: remite a las ADRs. Es el puente spec → implementación.

Todo lo aquí descrito trazable a: `OBJ-01`…`OBJ-10`, `P-01`/`P-07`/`P-09`/`P-13`/`P-20`, `REQ-F-03`/`REQ-F-18`/`REQ-F-26`, `RNF-01`/`RNF-07`/`RNF-11`/`RNF-19`, `ADR-002` (verificar = capability), `ADR-004` (selección por contrato), `ADR-005` (límites + repertorio), `ADR-006` (re-descomposición), `ADR-007`/`ADR-008`/`ADR-009`.

---

## 1. Catálogo v0 + contratos

Tres capacidades, **un trabajador por capacidad** (`ADR-004`: un trabajador por defecto hasta necesidad demostrada). Cada trabajador es una `AgentSession` pi con allowlist de tools por capacidad (`ADR-009`); la capacidad no concedida **no existe** en su sesión (`Agent-Model.md §7`, `RNF-05`).

| Capacidad | Propósito | Tools (allowlist) | Entrada | Resultado |
|---|---|---|---|---|
| **Explorer** | *obtener información* (read-only, `P-10`/`REQ-F-18`) | `read`, `grep`, `find`, `ls` — sin `edit`/`write`/`bash` | unidad + restricciones | información estructurada solicitada |
| **Implementer** | *implementar* | `read`, `edit`, `write`, `bash`, `grep`, `find` | unidad + contexto intencional | cambios + descripción verificable |
| **Verifier** (`ADR-002`) | *verificar* (capacidad delegada y separada) | `read`, `bash`, `grep`, `find`, `ls` — **sin** `edit`/`write` | unidad de verificación + evidencia esperada | pass/fail + evidencia (test count, typecheck, build) |

Regla clave (Verifier): si la verificación necesita **modificar** algo, eso es **otra unidad** — vuelve al bucle como trabajo de Implementer; el Verifier no edita. Los `bash` del Verifier sólo ejecutan herramientas de comprobación; los artefactos van a `tmp`/build-dir, no al árbol del proyecto.

Modelos: asignados por config v0 (uno por capacidad + uno de orquestador). Cambiar de modelo es `session.setModel(...)` (`ADR-009`, `P-15`/`RNF-14`), no rediseño. El catálogo formal de capacidades sigue deferido (`P-17`): v0 usa estas tres como máximo que demuestra necesidad (`ADR-004`).

---

## 2. Orquestador (`ADR-007`)

Una `AgentSession` con `noTools: "all"` (sin tools de proyecto → `P-01`/`REQ-F-03` por **ausencia**, reforzada en código) y un system prompt que exige **decisión JSON** — el contrato de `Decision-Model.md §2/§4/§11`:

```json
{
  "operación": "obtener información" | "ejecutar una unidad" | "comunicar al desarrollador" | "terminar",
  "ajustePlan": { "tipo": "descomponer" | "re-descomponer" | "cambiar de estrategia" | "determinar el proceso", "unidades": [...] } | null,
  "motivo": "<qué del estado la justifica>",
  "condición": "<cumplida o causa de inviabilidad>"
}
```

- `operación` es **exactamente una** (`Runtime-Model.md §4`); `ajustePlan` es **opcional** y actúa sobre el estado, no sobre el proyecto (`Decision-Model.md §4.2`).
- `motivo` siempre; `condición` sólo cuando `operación = "terminar"`.
- `thinkingLevel` del orquestador por defecto `low` en v0 (provisional, recalibrable en `06-research/`).

**Parseo robusto.** Si la salida no parsea, **no** se reinicia el bucle: se trata como *información insuficiente* (`REQ-F-18`/`P-13`) y se reentra con el estado (nueva decisión de *obtener información*). El fallo de formato es una entrada más del bucle, no un crash. La huella de la decisión (incluido el reintento) queda en `log.jsonl` (§8).

---

## 3. Persistencia (`ADR-008`)

Dos tiers separados por naturaleza:

| Tier | Qué | Dónde | Cómo se cargan |
|---|---|---|---|
| **Estado del runtime** (efímero del proyecto/máquina) | `state.json` + `log.jsonl` | `<agentDir>/aies/<hash(cwd)>/` (fuera del repo) | AIES-core los lee/escribe directamente |
| **Conocimiento del proyecto** (durable, compartido) | docs ya existentes: `AGENTS.md`, CONTEXT, ADRs, convenciones | en el repo del proyecto | `DefaultResourceLoader` de pi (recorrido de `AGENTS.md`) al arranque |

Continuidad: nueva sesión → restaura `state.json` + lee docs → una tarea `Recibida`/`En curso` se **reentra al bucle** (`Lifecycle.md §3`), sin reinicio (`P-13`/`RNF-10`). Estado corrupto/ausente → sesión nueva limpia (no fallo silencioso). No portable entre máquinas (deliberado).

---

## 4. Límites v0 (`ADR-005` + decisión de config provisional)

| Dimensión | Valor v0 | Notas |
|---|---|---|
| **Iteraciones** | máx **12** (provisional, no calibrado) | `P-09`: el contador va en `state.json` |
| **Coste** | **off** por defecto | la tarea puede declararlo; medición (`06-research/`) decide cuándo activarlo |
| **Contexto/tokens** | delegado a `autoCompaction` de pi; **observado** vía `contextUsage` | AIES no reimplementa el techo; lo observa como un límite más (`RNF-18`) |
| **Duración** | sin tope duro en v0 | |

Al alcanzar un límite → repertorio de `ADR-005`; **pedir intervención** por defecto. Nunca continuación silenciosa ni ilimitada (`RNF-19`). Valores provisionalmente conservadores a propósito: deben **fallar de forma visible** para que la medición los recalibre.

---

## 5. Integración host (`ADR-009`)

pi (**SDK embebido en proceso**, `@earendil-works/pi-coding-agent`), snapshot docs "latest" a 2026-08-14. AIES-core es el proceso dueño del bucle; pi es el motor de workers y el `ModelRuntime` multi-provider (`ModelRuntime.create()`).

```text
worker    = createAgentSession({ cwd, sessionManager: SessionManager.inMemory(cwd),
                                 model, thinkingLevel, tools:[allowlist],
                                 customTools?, resourceLoader })   // §1
orquest.  = createAgentSession({ noTools: "all", model, thinkingLevel: "low",
                                 systemPromptOverride: <decision-schema> })   // §2
```

- `session.prompt(workUnit)` → suscripción a eventos (`session.subscribe`) → resultado = último texto + `usage` (`RNF-07`/`RNF-17`); `session.abort()` cancela.
- `autoCompaction` nativo de pi gestiona el contexto; AIES observa `get_session_stats` (`contextUsage`) para límites.
- **Sin `HostAdapter`** en v0 (`P-17`): se extrae al aparecer un 2.º host.

---

## 6. Ciclo de vida del worker

- **Efímero** (`SessionManager.inMemory`): la sesión pi de worker no persiste por defecto; su trazabilidad vive en `log.jsonl` (`ADR-008`). Replay fino (`SessionManager.create`) = flag opcional futuro.
- `session.abort()` cancela una vuelta; el abort es **un resultado más** que entra al estado (`Runtime-Model.md §5`, `P-13`), no un reinicio.
- Resultado de worker → estado → siguiente decisión (`P-13`/`REQ-F-17`).
- **Re-descomposición** (`ADR-006`): sus cuatro señales actúan **sobre el estado** (no requieren delegación); la unidad re-descompuesta se sustituye por unidades **Pendiente** y el trabajo aceptado se conserva.

---

## 7. Intervención (`P-20`/`RNF-04`)

La intervención es una **entrada externa al ciclo** (`Runtime-Model.md §7`): se incorpora al `state.json` como un resultado más y se procesa en la siguiente decisión. Si ajusta → la tarea sigue `En curso`; si la detiene (ESC/Ctrl+C) → queda pausada `En curso`, reanudable con `/resume` (`ADR-012`). `Fallida` se reserva para inviabilidad y terminación controlada por límite.

En v0 el canal es el **canal de proceso de AIES-core** (stdin / flag), no pi. La UX concreta del canal (REPL, flag, TUI) es de implementación y queda fuera de este Scope salvo esta declaración.

---

## 8. Observabilidad (`RNF-01`/`RNF-11`)

`log.jsonl` es la fuente de reconstrucción. Cada vuelta deja la huella mínima de `Decision-Model.md §11`:

```text
{ iter, operación, ajustePlan?, motivo, condición? }     // decisión del orquestador
+ { resultado, usage, límite_alcanzado? }                // resultado de la operación
```

Con eso debe poder responderse `P-11`: qué entendió, por qué exploró/ejecutó/verificó, por qué terminó y por qué continuó tras un fallo — sin reejecutar la tarea.

---

## 9. Smoke de arranque

Invocación mínima:

```bash
aies run "<tarea>"        # sobre un repo con AGENTS.md presente
```

Traza mínima esperada en `<agentDir>/aies/<hash(cwd)>/log.jsonl` (una entrada por vuelta):

```text
1. checkpoint: AIES-core carga DefaultResourceLoader (AGENTS.md) + state.json (si existe)
2. decisión { operación: "determinar el proceso", ajustePlan: { descomponer: [u0] }, motivo: "tarea Recibida" }
3. decisión { operación: "ejecutar una unidad", unidad: u0→Explorer, motivo: "info insuficiente" }
   resultado { resultado: "<info>", usage: {...} }
4. decisión { operación: "ejecutar una unidad", unidad: u1→Implementer, motivo: "info suficiente" }
   resultado { resultado: "<cambios>", usage: {...} }
5. decisión { operación: "ejecutar una unidad", unidad: u2→Verifier, motivo: "verificar antes de terminar" }
   resultado { resultado: "pass", evidencia: {...}, usage: {...} }
6. decisión { operación: "terminar", condición: "finalización cumplida y verificada", motivo: "..." } → Completada
```

Con `aies run "<tarea>"` y un `state.json` previo de una tarea `En curso`, el smoke esperado es **reanudar** la tarea desde su "siguiente paso" en lugar de crearla nueva (§3).

---

## Deferred (fuera de MVP-v0, salvo petición explícita)

Listado para que no se olviden (`P-17`; calibrar desde `06-research/`):

- **Tier 2**: permisos/sandbox por worker; taxonomía de errores; modelo de permisos; perfil de límites por *forma de tarea* (`RNF-20` más allá del por-defecto).
- **Tier 3**: observabilidad UX *viva* (no sólo `log.jsonl` en diferido); afirmación de capability comprobada (`Capability-Model.md §10.3`); replay fino de sesión de worker.
- **Tier 4**: README raíz del árbol; `Vision.md` en limpio; portabilidad de `state.json` entre máquinas; `HostAdapter` para un 2.º host.

Los descubiertos de calibración — iteraciones (12), `thinkingLevel` del orquestador (`low`), activación del coste, granularidad óptima de unidad (`Task-Model.md §7.1`) — quedan en `06-research/`, sin asumirse verdaderos (`P-19`).