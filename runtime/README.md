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
    │   └── Limits + intervention (ADR-012: ESC parar / Ctrl+C cerrar → pausar, no Fallida)
    │
    ├── Custom Tools (workers/tools.ts)
    │   ├── explore: AgentSession efímera con [read, grep, find, ls]
    │   ├── implement: AgentSession efímera con [read, edit, write, bash, grep, find]
    │   └── verify: AgentSession efímera con [read, bash, grep, find, ls] (sin edit/write)
    │
    └── Telemetry (telemetry/pi-events.ts) — mapeo de eventos pi → dominio AIES
```

### Señales durante la ejecución (ADR-012)

| Señal | REPL | Oneshot |
|---|---|---|
| **ESC** durante un run | Pausa la tarea (queda `En curso`), vuelve al prompt. Sin cerrar sesión. | No aplica (sin readline). |
| **Ctrl+C** (1ª) durante un run | Pausa la tarea, persiste estado, cierra el REPL. La siguiente invocación ofrece `/resume`. | Pausa la tarea, persiste estado, sale con código 1. |
| **Ctrl+C** (2ª) en cualquier momento | `process.exit(130)` inmediato (escape si el drenado del turno se cuelga). | `process.exit(130)` inmediato. |
| **Ctrl+C** en el prompt del REPL (sin run) | Cierra el REPL. | No aplica. |

`Fallida` queda reservada para inviabilidad declarada por el orquestador y terminación
controlada por límite (`ADR-005`). La intervención del desarrollador nunca produce `Fallida`.

---

## Integraciones externas (ADR-011)

AIES integra dos herramientas locales como `customTools` de pi, registradas en `src/integrations/`:

- **codegraph** — grafo estructural del código (símbolos + call paths). Expone `code_explore <query>` para los workers; alivia el problema nº 1 de `Problem.md` (sobrecarga de exploración). Si la CLI está y falta `.codegraph/`, se ejecuta `codegraph init` una vez por `cwd` (idempotente).
- **projectmem** — memoria operativa entre sesiones (decisiones, gotchas, lecciones). Expone `mem_read` (lectura) para los tres workers, y `mem_log` (escritura) **sólo para el implementer**. Lee directo `.projectmem/summary.md`; no se auto-inicializa (instalaría hooks en repo ajeno — `Non-Goals §6`).

Ambas se instalan con `install.sh` (codegraph vía `npm i -g`, projectmem vía `uv → pipx → pip`). Si una falla, AIES sigue funcionando y las tools responden con mensaje de indisponibilidad. El orquestador recibe un briefing al estado en cada tarea con la disponibilidad detectada y el resumen destilado de memoria (truncado a 4k chars).

Tabla rápida:

| Tool         | explorer | implementer | verifier | Notas |
|--------------|----------|-------------|----------|-------|
| `code_explore` | ✓       | ✓          | ✓        | shell-out `codegraph explore <query>` |
| `mem_read`    | ✓       | ✓          | ✓        | lectura directa de `.projectmem/summary.md` |
| `mem_log`     | ✗       | ✓          | ✗        | shell-out `pjm log\|attempt\|fix\|decision\|note`; P-10/REQ-F-18 |

Ver `05-Decisions/ADR-011-integracion-codegraph-projectmem.md` para el detalle.


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

# onboarding (credenciales + modelos)
aies login anthropic          # api_key u oauth, guarda en ~/.config/aies/auth.json
aies models                    # lista catálogo (pipe-safe)
aies pick verifier claude-opus-4-5   # asigna modelo por rol

# actualizar: re-ejecuta el instalador oficial
aies update

# REPL: conversación continua
aies
> /help
> /state
> /state --json
> /status
> /login anthropic
> /models
> /pick verifier claude-opus-4-5
> /resume
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

- [x] **v1 — CLI standalone**: oneshot (`aies "<tarea>"`), `aies update`, `--version` y REPL (`/help`, `/state`, `/state --json`, `/status`, `/resume`, `/clear`, `/exit`), persistencia en `<cwd>/.aies/{state.json,log.jsonl}`, recuperación ante corrupción, ESC parar / Ctrl+C cerrar con pausa reanudable (ADR-012).
- [x] **Oleada 0 — Onboarding**: `/login`, `/logout`, `/models`, `/pick` (REPL) y `aies login|logout|models|pick` (oneshot). Credenciales AIES-own en `~/.config/aies/auth.json`. Modelos por rol efectivos en decide y workers.
- [x] **Deprecated — Extensión de Pi** (`src/extension/`): se conserva como código legacy, marcado `@deprecated`, se eliminará en v2. Ver `05-Decisions/ADR-010-extension-de-pi.md`.

Verificación: `pnpm run typecheck` (tsc strict) + `pnpm test` (parse, unitid, loop, cost, e2e y update — todos sin LLM).

---

## auth y config

- `runtime/aies.config.json` — `provider` + `models.{orchestrator,explorer,implementer,verifier}` (versionado, sin claves), `orchestratorThinkingLevel: "low"`, `limits.maxIterations: 12`. Cada `models.<rol>` acepta `model-id` (usa el `provider` global) o `provider/model-id` explícito.
- **Credenciales** se guardan en `~/.config/aies/auth.json` (override `AIES_AUTH` para tests). Se gestionan con `/login` (api_key u oauth) o `aies login <proveedor>` — separadas del store de pi-CLI en `~/.pi/agent/auth.json`. Las variables de entorno (`ANTHROPIC_API_KEY`, etc.) siguen funcionando como fuente ambient y son la fuente por defecto si no hay auth persistida.

## scripts

- `pnpm run build` / `pnpm run typecheck` — `tsc` strict (ESM, Node ≥22.19.0).
- `pnpm test` — corre los tests de parse, unitid, loop, cost, e2e, update, cli y stream-renderer.
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
- Métricas en vivo: T3.1 implementado (línea dim por iteración con tokens/coste/contexto/verify acumulado; telemetría nula → `n/d`) y T3.2 (`/status` con telemetría agregada del historial y huella por vuelta con ref `log#X–Y`). Ver `ROADMAP-TUI.md` §T3.1/§3.2.
