# Baseline 1 — agente único

Enfoque de referencia definido en `06-research/README.md` (§Baselines, `RNF-15`): **un solo `AgentSession` con todas las tools y el mismo modelo, sin orquestador ni división del trabajo.** Mide el coste de añadir coordinación (orquestador) y sirve de comparación para `H-01` (contexto), `H-03` (calidad), `H-04` (especialización) y `H-06` (modelos).

## Definición operacional

- **Sesión**: un único `AgentSession` (pi), de la misma fábrica que un worker (`createBaselineSession`, `runtime/src/pi-binding/index.ts`), con el **set completo** de tools del catálogo: `read`, `grep`, `find`, `ls`, `edit`, `write`, `bash`.
- **Modelo**: el mismo que el orquestador de AIES (`defaultModel` de rol orquestador en `aies.config.json`; `claude-sonnet-4-5` en v0). Sin `thinkingLevel` propio (por defecto del host), igual que los workers.
- **Sin orquestador ni división**: se envía **una única prompt** con el objetivo de la tarea; el agente circula solo con sus tools hasta decidir terminar. No hay loop AIES, no hay `log.jsonl` de AIES.
- **Prompts/recurso**: `DefaultResourceLoader` normal (lee `AGENTS.md` del repo, igual que los workers).

## Cómo se mide

```bash
node runtime/dist/research/baseline.js --cwd <copia-de-tarea> --verify "<comando de AGENTS.md>" "<objetivo de la tarea>"
# (provider/modelo por defecto desde aies.config.json; --provider/--model para override puntual)
```

Salida: un **objeto JSON por corrida** (dataset de E-01) con:

| Campo | Qué mide |
|---|---|
| `cwd`, `tarea`, `provider`, `modelo`, `tools` | identidad de la corrida |
| `telemetry.usage` | tokens in/out/cache + coste (misma `WorkerTelemetry` que los workers; delta de `getSessionStats`, `pi-binding/events.ts`) |
| `telemetry.contextUsage` | tokens usados, ventana, % del techo (`RNF-07`) |
| `tiempo_ms` | tiempo de pared de la vuelta |
| `assistantText` | cola del texto final (verificación cualitativa) |
| `verificacion` | salida del comando `--verify` (exit code + output) si se pasa → paridad de *resultado* |
| `error` | solo si el host falló (p. ej. auth ausente): la corrida se marca, no se asevera nada |

## Paridad y precauciones

- **Misma tarea, repos distintos**: AIES y baseline escriben sus cambios en el repo; para comparar sin contaminación cruzada cada brazo corre en una **copia fresca** de la tarea (runbook de E-01, §3).
- **Coste/provider variables**: el modelo y proveedor default salen del mismo `aies.config.json` que AIES → misma variable controlada para los dos brazos.
- **Sin réplicas por defecto**: réplica 1, como E-02; ampliar si aparece dispersión.
- **No es el bucle**: el baseline no produce `log.jsonl` de decisión; su métrica adecuada es el JSON anterior. No comparar campos que solo existen en un brazo.

## Referencias

- `06-research/README.md` §Baselines; `Non-Functional-Requirements.md §3` (`RNF-15`, `RNF-07`).
- `runtime/src/research/baseline.ts` (runner); `runtime/src/pi-binding/index.ts` (`createBaselineSession`).