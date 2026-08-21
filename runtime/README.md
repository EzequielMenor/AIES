# AIES-core runtime (v1)

Paquete TypeScript/Node que ejecuta el runtime de AIES como **CLI standalone** construido sobre `pi-coding-agent` (`@earendil-works/pi-coding-agent@~0.84`). AIES-core es el dueño del bucle (`estado → decisión → operación → resultado`); pi provee el modelo, los providers, la sesión efímera y la compactación (ADR-009).

> La extensión de Pi (`src/extension/`) está **deprecated** desde 2026-08-20; se conserva como código legacy y se eliminará en v2. Ver `05-Decisions/ADR-010-extension-de-pi.md`.

La spec está cerrada: este paquete la hace valer en código. Trazabilidad: `MVP-v0-Scope` + `ADR-005/006/007/008/009` + `Runtime-Model` + `Decision-Model` + `Lifecycle` + `NFR`.

---

## Arquitectura (v1 — CLI standalone)

```text
aies CLI (cli.ts, bin aies)
    │
    ├── Modos: oneshot (aies "<tarea>") + REPL (aies)
    │
    ├── Bucle TS (core/loop.ts)
    │   ├── State management (persistence/file_store.ts)
    │   ├── Decide: sesión efímera con ORCHESTRATOR_SYSTEM_PROMPT → parseo Zod
    │   ├── Execute: llama a runWorker("explorer"|"implementer"|"verifier")
    │   └── Limits + intervention (SIGINT → StopController)
    │
    ├── Custom Tools (workers/tools.ts)
    │   ├── explore: AgentSession efímera con [read, grep, find, ls]
    │   ├── implement: AgentSession efímera con [read, edit, write, bash, grep, find]
    │   └── verify: AgentSession efímera con [read, bash, grep, find, ls] (sin edit/write)
    │
    └── Telemetry (telemetry/pi-events.ts) — mapeo de eventos pi → dominio AIES
```

---

## Instalación

### Modo dev (rápido)

```bash
cd runtime
pnpm install
pnpm run build
node dist/cli.js --help
```

### CLI standalone

```bash
# oneshot: ejecuta la tarea y termina
aies "lista los archivos del proyecto"
aies "añade una función greet() a src/math.ts"

# actualizar: re-ejecuta el instalador oficial
aies update

# REPL: conversación continua
aies
> /help
> /state
> /exit

# opciones
aies --version
AIES_NO_UPDATE_CHECK=1 aies
```

---

## Worker tools (internos al bucle)

| Tool | Descripción |
|---|---|
| `explore(objetivo, contexto?)` | Worker read-only — devuelve un resumen estructurado. |
| `implement(objetivo, contexto?, unidad?)` | Worker con permisos de escritura — realiza el cambio mínimo. |
| `verify(objetivo, contexto?, unidad?)` | Worker read-only (ADR-002) — termina con `VEREDICTO: PASS\|FAIL`. |

---

## Estado de la implementación

- [x] **v1 — CLI standalone**: oneshot (`aies "<tarea>"`), `aies update`, `--version` y REPL, persistencia en `<agentDir>/aies/<hash(cwd)>/{state.json,log.jsonl}`, recuperación ante corrupción, SIGINT controlado.
- [x] **Deprecated — Extensión de Pi** (`src/extension/`): se conserva como código legacy, marcado `@deprecated`, se eliminará en v2. Ver `05-Decisions/ADR-010-extension-de-pi.md`.

Verificación: `pnpm run typecheck` (tsc strict) + `pnpm test` (parse, unitid, loop, cost, e2e y update — todos sin LLM).

---

## auth y config

- `runtime/aies.config.json` — `provider` + `models.{orchestrator,explorer,implementer,verifier}` (versionado, sin claves), `orchestratorThinkingLevel: "low"`, `limits.maxIterations: 12`. Modelos provisionales.
- Claves **sólo por env**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. (leídas por el `ModelRuntime` de pi).

## scripts

- `pnpm run build` / `pnpm run typecheck` — `tsc` strict (ESM, Node ≥20).
- `pnpm test` — corre los tests de parse, unitid, loop, cost, e2e y update.
- `pnpm run test:loop` / `test:persist` / `test:orch` / `test:compaction` / `test:workers` — self-check individual.
- `pnpm run research:metrics -- <log.jsonl>` — métricas NFR §3 sobre el log AIES.
- `pnpm run research:baseline -- "<tarea>"` — corrida baseline agente-único (sin bucle) para comparar.

## Smoke de aceptación (en vivo)

```bash
cd runtime
pnpm run build
aies "lista los archivos del proyecto"
```

Sin clave, el bucle degrada con gracia (3 auth-fails → intervención). Con clave configurada en env, el bucle ejecuta las fases (decide → workers → verificar → terminar).

## open questions (no bloquean)

- `thinkingLevel` orquestador `low` — calibrar con `research:baseline`.
- Métricas en vivo en el footer de la TUI (status por iteración).
