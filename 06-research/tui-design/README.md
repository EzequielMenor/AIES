# AIES — Prototipo visual de la TUI

- **Fecha:** 2026-08-21
- **Estado:** Exploración visual, sin decisión de implementación. No es código de producto — es
  un boceto interactivo (HTML/JS autocontenido) para discutir dirección antes de tocar
  `runtime/src/ui/stream-renderer.ts`.
- **Prototipo publicado (interactivo):**
  https://claude.ai/code/artifact/58505265-7e2b-40ea-8f6d-2b99aa9b5148

## Qué es

`prototype.dc.html` es el origen de un canvas de Claude Design (formato `.dc.html`, ver
`canvas.json`). Simula, con JS local sin dependencias, el flujo completo de una tarea en la
TUI: escribir una tarea en el prompt, ver la decisión del orquestador, unidades expandibles
(`ejecutar`/`explorar`/`test`) con razonamiento, tool calls y diffs dentro, coste/tokens en
vivo, avisos de límite de iteraciones, parse-fails, compactación de contexto, intervención en
caliente mientras corre, y `/resume` reanudando una tarea `En curso`.

No reemplaza ni implementa nada de `runtime/`; es una referencia visual para decidir qué
mostrar y cómo, antes de construirlo sobre el bucle real (`core/loop.ts`,
`core/observation.ts`).

## Dirección visual

Mezcla deliberada de dos referencias (ver `ROADMAP-TUI.md` y
`06-research/pi-opencode-comparison.md`):

- **Stream minimal** (estilo Claude Code / renderer actual de AIES): scroll único,
  monoespacio, paleta cyan/verde/ámbar, sin chrome de más.
- **Panel lateral denso** (estilo opencode.ai): árbol de unidades + sesión (iter/ctx/verify)
  en un sidebar fijo, en vez de todo en el stream principal.

Se descartó una tercera dirección más cálida/redondeada (estilo pi.dev) por no encajar con
la identidad de terminal que ya tiene AIES.

## Cómo se relaciona con el roadmap real

Cubre visualmente (no funcionalmente) varios ítems de `ROADMAP-TUI.md`:

| Roadmap | En el prototipo |
|---|---|
| T0.2 — límites/parse-fail/compaction visibles | Líneas ámbar/violeta dedicadas, simuladas |
| T1.1 — `/resume` | Comando que simula reanudar `.aies/state.json` con coste ya acumulado |
| T2.1 — intervención en caliente | Escribir mientras la tarea corre inserta una intervención, no bloquea |
| T3.1 — telemetría por iteración | Tokens/coste en cabecera, iter/ctx/verify en el sidebar, en vivo |

Nada de esto está implementado en `runtime/`; es la maqueta a la que apuntar si se decide
avanzar esas fases.

## Editar el prototipo

El origen vive en `prototype.dc.html` + `canvas.json`. Para volver a publicarlo o iterar,
usar la skill `/design` de Claude Code (re-seed sobre el payload del editor, no se edita el
HTML publicado directamente).
