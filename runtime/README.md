# AIES-core runtime (v1)

Paquete TypeScript/Node que ejecuta el runtime de AIES como **extensión nativa de pi** (`@earendil-works/pi-coding-agent@~0.84`). AIES-core es el dueño del bucle (`estado → decisión → operación → resultado`); pi provee la TUI (`InteractiveMode`), el modelo, los providers y la compactación (ADR-010).

La spec está cerrada: este paquete la hace valer en código. Trazabilidad: `MVP-v0-Scope` + `ADR-005/006/007/008/009/010` + `Runtime-Model` + `Decision-Model` + `Lifecycle` + `NFR`.

---

## Arquitectura (v1 — extensión de pi)

```text
pi InteractiveMode (TUI, sesión, compactación, modelos)
    │
    ├── Extensión AIES (src/extension/index.ts)
    │   ├── registerCommand: /run, /resume, /status
    │   ├── registerTool: explore, implement, verify
    │   └── event hooks: tool_execution_start, session_before_compact
    │
    ├── Bucle TS (core/loop.ts) — corre dentro del handler de /run
    │   ├── State management (extension/state-store.ts — en memoria)
    │   ├── Decide: sesión efímera con ORCHESTRATOR_SYSTEM_PROMPT → parseo Zod
    │   ├── Execute: llama a runWorker("explorer"|"implementer"|"verifier")
    │   └── Limits + intervention (vía pi.ui.confirm — Fase 3)
    │
    └── Custom Tools (workers/tools.ts)
        ├── explore: AgentSession efímera con [read, grep, find, ls]
        ├── implement: AgentSession efímera con [read, edit, write, bash, grep, find]
        └── verify: AgentSession efímera con [read, bash, grep, find, ls] (sin edit/write)
```

---

## Instalación

### Modo dev (rápido)

```bash
cd runtime
pnpm install
pi -e ./src/extension/index.ts   # arranca pi con la extensión cargada
```

Una vez en la TUI de pi:

```text
> /run lista los archivos del proyecto
> /run añade una función greet() a src/math.ts
> /status
> /resume    # tras intervención o pausa
```

### Modo instalación (global)

```bash
mkdir -p ~/.pi/agent/extensions/aies
cp -r runtime/src ~/.pi/agent/extensions/aies/
cp runtime/aies.config.json ~/.pi/agent/extensions/aies/
pi   # la extensión se auto-descubre
```

`package.json` declara la entrada en `"pi.extensions": ["./src/extension/index.ts"]` para installs vía `pi install`.

---

## Comandos y tools

| Comando | Descripción |
|---|---|
| `/run <tarea>` | Ejecuta una tarea con el bucle AIES (orquestador + workers). |
| `/resume` | Continúa una tarea AIES no terminal guardada en memoria. |
| `/status` | Muestra el estado actual del bucle (tarea, iteraciones, unidades). |

| Tool (visible para el LLM principal) | Descripción |
|---|---|
| `explore(objetivo, contexto?)` | Worker read-only — devuelve un resumen estructurado. |
| `implement(objetivo, contexto?, unidad?)` | Worker con permisos de escritura — realiza el cambio mínimo. |
| `verify(objetivo, contexto?, unidad?)` | Worker read-only (ADR-002) — termina con `VEREDICTO: PASS\|FAIL`. |

---

## Estado de la implementación (post-ADR-010)

- [x] **Fase 1 — Extensión mínima viable**: entry point `/run`, tool `explore`, bucle decide→explore→done.
- [x] **Fase 2 — Workers completos**: tools `implement` y `verify`; bucle decide→explore→implement→verify→done.
- [x] **Fase 3 — Límites, intervención, observabilidad**: `/resume`, `/status`, `pi.ui.confirm` para intervención al alcanzar `maxIterations`, log JSONL en `<cwd>/.pi/aies-log.jsonl`.
- [x] **Fase 4 — Limpieza y empaquetado**: `tui/`, `pi-binding/`, `host/`, `cli.ts`, `spike.ts`, `tui-test.tsx` eliminados; package.json reducido a `pi-coding-agent` + `typebox` + `zod`; ADR-010 publicado; README actualizado.

Verificación: `npm run typecheck` (tsc strict) + `npm test` (loop, persistence, orchestrator, compaction, workers, extension — todos sin LLM) + smoke manual con `pi -e`.

---

## auth y config

- `runtime/aies.config.json` — `provider` + `models.{orchestrator,explorer,implementer,verifier}` (versionado, sin claves), `orchestratorThinkingLevel: "low"`, `limits.maxIterations: 12`. Modelos provisionales.
- Claves **sólo por env**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. (leídas por el `ModelRuntime` de pi).

## scripts

- `npm run build` / `npm run typecheck` — `tsc` strict (ESM, Node ≥20).
- `npm test` — corre los 6 self-checks secuencialmente.
- `npm run test:loop` / `test:persist` / `test:orch` / `test:compaction` / `test:workers` / `test:extension` — self-check individual.
- `npm run research:metrics -- <log.jsonl>` — métricas NFR §3 sobre el log AIES.
- `npm run research:baseline -- "<tarea>"` — corrida baseline agente-único (sin bucle) para comparar.
- `npm run pi:dev` — atajo a `pi -e ./src/extension/index.ts`.

## Smoke de aceptación (en vivo)

```bash
cd runtime
pi -e ./src/extension/index.ts
# en la TUI de pi:
> /run lista los archivos del proyecto
> /status
```

Sin clave, el bucle degrada con gracia: 3 auth-fails → intervención (`pi.ui.confirm`) → tarea `En curso` no terminal, sin crash. Con clave configurada en env, el bucle ejecuta las tres fases (decide → workers → verificar → terminar).

## open questions (no bloquean)

- `thinkingLevel` orquestador `low` — calibrar con `research:baseline`.
- Persistencia del estado AIES entre recargas de la extensión — `pi.appendEntry()` candidato.
- Métricas en vivo en el footer de la TUI (status por iteración).
