# AIES — 06-research: medición y validación

Esta carpeta es el **destino de medición e investigación** de la cadena de trazabilidad. No fija umbrales ni metodología definitiva: define **cómo** se convierten en experimentos medibles las hipótesis (`H-01`…`H-06`), las baselines de comparación y las métricas por dimensión (`Non-Functional-Requirements.md §3`).

Principio rector: **`P-19` — evidencia frente a intuición.** Ninguna hipótesis se asume verdadera; ningún umbral se calibra sin datos. Coherente con `ADR-004` (criterios sin umbrales numéricos) y `ADR-005` (valores/perfiles por defecto se calibran desde aquí).

---

## Estructura propuesta

```text
06-research/
  ├── README.md           (este documento)
  ├── experiments/        un experimento por archivo (uno o más hipótesis)
  ├── baselines/          definición de los enfoques de referencia
  └── metrics/            definición de métricas por dimensión NFR
```

Las tres subcarpetas se crean al añadir su primer contenido (`P-17`); este README no precrea archivos vacíos.

---

## Plantilla de experimento (mínima)

Cada archivo de `experiments/` responde a:

| Campo | Contenido |
|---|---|
| **Hipótesis** | `H-0x` que aborda (de `NFR §4`); enunciado |
| **Dimensión NFR** | de la tabla de `NFR §3` (tiempo/coste/contexto/calidad/observabilidad/fiabilidad/límites) |
| **Tarea de referencia** | descripción reproducible del trabajo a ejecutar (mismo input para AIES y para el baseline) |
| **Setup** | modelos, proveedores, config (`MVP-v0-Scope.md §1`/`§2`); `cwd` del repo; réplicas |
| **Métricas** | las que recoger (de `metrics/`); unidad mínima de análisis ya fijada |
| **Resultado** | datos crudos (no interpretación adelantada) |
| **Interpretación** | qué apoya / refuta / deja indeterminada la hipótesis; **nunca aseverar verdadero** sin evidencia |

---

## Baselines (`baselines/`)

Dos enfoques de referencia para comparar AIES contra ellos (`RNF-15` exige que la calidad **no degrada** frente a ellos):

1. **Agente único** — un solo `AgentSession` con **todas** las tools (`read`/`edit`/`write`/`bash`/`grep`/`find`/`ls`) y el mismo modelo, sin orquestador ni división. Mide el coste de añadir coordinación.
2. **Workflow rígido** — secuencia fija `explorar → especificar → diseñar → implementar → verificar` para toda tarea, el flujo que `Non-Goals §3` proscribe como identidad. Mide la sobrecarga de imponer proceso uniforme (`RNF-06`).

Misma tarea de referencia y, en lo posible, mismo modelo/proveedor para los tres (AIES, único, rígido), aislando la variable que es el enfoque.

---

## Métricas por dimensión (`metrics/`)

Las dimensiones y su unidad mínima de análisis ya están fijadas en `NFR §3`; aquí se concreta cómo se obtiene cada dato:

| Dimensión | Origen del dato en v0 |
|---|---|
| **Tiempo/latencia** | inicio/fin de vuelta y por actividad (obtener info / ejecutar / verificar / esperar), medidos por AIES-core |
| **Coste** | `usage` (tokens/coste) por worker y por orquestador (`ADR-009`); acumulado por tarea y desglosado por unidad/capacidad (`RNF-17`) |
| **Contexto/tokens** | `contextUsage` (tokens usados, ventana, %) vía `get_session_stats` + tamaño del contexto delegado por unidad (`RNF-07`) |
| **Calidad** | condición de finalización cumplida + resultado de verificación; comparación con los baselines (`RNF-15`) |
| **Observabilidad** | el `log.jsonl` de `ADR-008` **es** el dataset: decisiones, delegaciones, resultados, límites, estado terminal |
| **Fiabilidad** | fallos de unidad vs fallos de tarea, recuperaciones exitosas, reinicios completos, pérdida de estado (`RNF-10`) |
| **Límites** | límite aplicado, valor alcanzado, decisión posterior, resultado (`RNF-19`); legible desde `log.jsonl` |

---

## Mapeo `H-01`…`H-06`

Cada hipótesis → experimento(s) propuestos. **Sin umbrales**: el objetivo es producir datos para calibrar, no confirmar creencias.

| Hipótesis | Dimensión | Experimento propuesto (resumen) |
|---|---|---|
| `H-01` dividir el trabajo reduce el contexto innecesario | contexto | comparar tokens delegados (AIES) vs agente-único a paridad de tarea/resultado (`RNF-07`) |
| `H-02` coste y tiempo son proporcionales a la complejidad | coste, tiempo | ejecutar tareas de complejidad creciente; correlación nº de unidades/iteraciones vs coste/tiempo |
| `H-03` la división mantiene o mejora la calidad | calidad | comparar resultado (verificación, condición de finalización) AIES vs los dos baselines (`RNF-15`) |
| `H-04` la especialización mejora la eficacia de cada agente | eficacia | comparar worker especializado vs agente-único en la misma sub-tarea; ratio éxito/tokens |
| `H-05` la persistencia selectiva aporta valor real al inicio | utilidad de memoria | medir tiempo/contexto necesarios para continuar una tarea `En curso` con y sin restaurar `state.json` + docs (`RNF-16`, `ADR-008`) |
| `H-06` dividir el trabajo da mejores resultados de modelos económicos | modelos | misma tarea con modelo caro único vs Implementer con modelo económico + Verifier; paridad de calidad (`OBJ-08`, `REQ-F-23`) |

Los descubiertos de calibración de v0 — iteraciones (12), `thinkingLevel` del orquestador (`low`), activación del coste, granularidad óptima de unidad (`Task-Model.md §7.1`) — son experimentos adicionales bajo el mismo marco, no hipótesis prevalidadas.

---

## Orquestación de las mediciones

AIES-core **debe poder emitir** todas las mediciones anteriores. `ADR-009` garantiza el acceso a `usage` y `contextUsage` por worker y por orquestador; `ADR-008` garantiza que la traza (`log.jsonl`) está disponible sin reejecutar la tarea (`RNF-11`). La instrumentación adicional (cronometría por actividad) corre del lado de AIES-core — el host (pi) no se instrumenta.

**Estado (iteración E-01):** la telemetría del orquestador se emite y se suma en `metrics.ts` — `DecisionLogEntry` lleva `usage`/`contextUsage` (ausentes solo en entradas sintéticas sin vuelta del host) y `coste.total`/`contexto.tokens_total` incluyen orquestador + workers (`coste.orquestador` como desglose). El baseline agente-único mide su propio `usage`/`contextUsage` desde el host (`baselines/agente-unico.md`).

---

## Qué NO define esta carpeta

- Valores objetivo ni umbrales (se calibran aquí **a partir de** datos, no se preestablecen).
- La metodología estadística definitiva (réplicas, significancia) se fija por experimento.
- La selección de tareas de referencia canónicas (conjunto que crece con cada experimento).

---

## Referencias

- `Principles.md P-19` — evidencia frente a intuición.
- `Goals.md §4`; `Non-Functional-Requirements.md §3 (dimensiones), §4 (H-01…H-06), §6 (umbrales/baselines pendientes)` — qué medir y qué hipótesis.
- `ADR-004-criterios-de-decision.md`; `ADR-005-limites-e-irrecuperabilidad.md`; `ADR-006-re-descomposicion.md` — decisiones sin umbrales, calibrables desde aquí.
- `ADR-008-persistencia-entre-sesiones.md` — `log.jsonl` como dataset de observabilidad.
- `ADR-009-integracion-con-pi.md` — acceso a `usage`/`contextUsage`.
- `03-Architecture/MVP-v0-Scope.md §1, §2, §4, §8` — config v0, límites provisionales y huella de observabilidad.