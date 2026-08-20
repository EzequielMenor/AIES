# ADR-010 — AIES como extensión de Pi (migración del runtime standalone)

- **Estado:** Aceptada
- **Fecha:** 2026-08-20
- **Sustituye/Complementa:** ADR-009 (integración con pi) — la fachada Host desaparece; AIES pasa a ser una **extensión nativa** de `pi` cargada vía `pi -e ./src/extension/index.ts` o `~/.pi/agent/extensions/`.
- **Plan de referencia:** `.kilo/plans/1787216938981-aies-pi-extension-migration.md`

## Contexto

ADR-009 eligió **pi-coding-agent como host** del runtime de AIES y trazó la frontera Host↔dominio. La implementación v0 construyó un proceso standalone con TUI custom (Ink+React, ~736 líneas en `App.tsx` + `components/`, `hooks/`, `viewmodels/`, `wire/`), una fachada `Host`/`HostSession` para hablar con pi, una CLI propia (`aies run/resume`), persistencia en `state.json` + `log.jsonl`, y un proceso Node autocontenido (`bin: "aies"`).

v0 funcionó como prototipo: el bucle, el parser Zod, las capacidades y los límites se validaron contra el modelo real de pi 0.84.x. Pero el coste operativo era desproporcionado frente al valor: TUI custom duplica funcionalidad que `pi`'s `InteractiveMode` ya provee (streaming, input, tool rendering, session persistence, compactación, modelo, providers, settings); la fachada Host añade una capa de indirección entre el dominio y el SDK; el binario `aies` separa dos procesos que podrían ser uno; y el desacople del host (P-15) es más fuerte si AIES vive **dentro** del host que si lo envuelve.

## Decisión

AIES v1 es una **extensión nativa de pi** que usa la TUI `InteractiveMode` de pi como entorno de presentación y mantiene el bucle TS como runtime:

1. **Entry point:** `runtime/src/extension/index.ts` exporta una factoría `(pi: ExtensionAPI) => void`. Se carga vía `pi -e ./path` para dev o `~/.pi/agent/extensions/` para instalación.
2. **Comandos Pi nativos:** `/run <tarea>` arranca el bucle AIES; `/resume` continúa una tarea no terminal; `/status` muestra el estado del bucle. Sin CLI separado.
3. **Tools Pi nativos:** `explore`, `implement`, `verify` se registran vía `pi.registerTool()`. Cada tool crea internamente una `AgentSession` efímera (`SessionManager.inMemory`, `systemPromptOverride` por rol, allowlist de tools por capability de `workers/capabilities.ts`).
4. **Bucle dentro del comando:** el bucle AIES (`core/loop.ts`) corre **dentro** del handler de `/run`. Pi espera a que el handler termine — esto bloquea la TUI hasta estado terminal o intervención. `pi.ui.notify()` emite progreso; `pi.ui.confirm()` pide intervención al alcanzar `maxIterations`.
5. **Decide efímero por turno:** el `decide.ts` crea una `AgentSession` efímera con `noTools: "all"` y `systemPromptOverride: () => ORCHESTRATOR_SYSTEM_PROMPT` (metodología AIES). La sesión se cierra al terminar cada turno. Sin orquestador persistente — sin acumulación de conversación.
6. **Estado en memoria de extensión:** `extension/state-store.ts` mantiene el `RuntimeState` actual en una variable módulo. `/run` lo inicializa; `/resume` lo continúa. Sin `state.json` — la sesión de pi es ahora el contenedor de historia conversacional; el log AIES va a `<cwd>/.pi/aies-log.jsonl` para `research:metrics`.
7. **Eliminación de TUI custom, fachada Host, CLI propia:** `src/tui/`, `src/pi-binding/`, `src/host/`, `src/cli.ts`, `src/spike.ts`, `self-check/tui-test.tsx` se eliminan. Las únicas dependencias runtime son `@earendil-works/pi-coding-agent`, `typebox` y `zod`.

## Consecuencias

**Positivas**

- Una sola TUI (InteractiveMode) en lugar de dos — elimina ~700 líneas de código duplicado.
- El orquestador AIES aprovecha la compactación, sesión persistente, providers y settings de pi sin reimplementarlos.
- Workers como tools Pi nativos — el LLM principal puede invocarlos directamente cuando el desarrollador lo necesite, además de la invocación interna del bucle.
- El comando `/run` es nativo de la TUI — no requiere binario separado ni proceso extra.
- ADR-009 (DIP ante pi 0.x) sigue vigente: la única dependencia de pi está en `extension/`, `workers/session-factory.ts` y `orchestrator/decide.ts` — el dominio (`core/`, `state.ts`, `loop.ts`, `parse.ts`) sigue siendo puro.

**Negativas / Trade-offs**

- El bucle dentro del handler bloquea la TUI hasta terminar o intervención. Tareas largas sin intervención pueden ser molestas; mitigación: la intervención real en Fase 3 (`onLimit` → `pi.ui.confirm`) permite al desarrollador interrumpir ordenadamente.
- El orquestador pierde la sesión persistente con su historial — cada turno crea una sesión efímera nueva. Esto es intencional (P-09: el estado, no la conversación, es la entrada de la decisión), pero significa que el contexto del orquestador se reconstruye desde `state` cada turno.
- Pin de versión de `@earendil-works/pi-coding-agent` (~0.84.2) es necesario — la API de extensiones puede cambiar entre versiones menores (riesgo registrado en el plan §6).
- El estado AIES no sobrevive a un `/reload` de extensiones (la factoría se reinvoca y `state-store` queda vacío). Mitigación futura: `pi.appendEntry()` para persistir estado en la sesión de pi (no implementado en v1).

**Neutras**

- ADR-007 (orquestador único) cambia de "sesión separada con `noTools: 'all'`" a "sesión efímera por turno con `noTools: 'all'`" — la unicidad se mantiene; el lifecycle cambia.
- ADR-008 (persistencia entre sesiones) cambia: el estado AIES vive en memoria de extensión + log JSONL en `<cwd>/.pi/aies-log.jsonl`; la sesión de pi reemplaza `state.json` para la historia conversacional.
- ADR-009 se reemplaza en su forma (SDK embebido → extensión nativa) pero su espíritu (DIP ante pi, frontera Host↔dominio) se mantiene: la frontera ahora vive entre `extension/`+`workers/session-factory`+`orchestrator/decide` y el resto del dominio.

## Validación

- `pnpm test` (o `npm test`): todos los self-checks pasan — loop, persistence, orchestrator, compaction, workers, extension.
- `pi -e ./src/extension/index.ts` → `/run "lista los archivos del proyecto"` → el orquestador decide `obtener información` con explorer, el tool retorna, el bucle termina Completada.
- `maxIterations=2` + `/run "<tarea compleja>"` → bucle pide intervención vía `pi.ui.confirm`; "continuar" sigue, "terminar" cierra como Fallida.
