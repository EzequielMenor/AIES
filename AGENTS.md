## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:
- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

## Tooling local (codegraph + projectmem)

Este repo se trabaja con dos herramientas locales (gitignored en `.gitignore`; nada sale del Mac):

- **codegraph** — grafo de código (SQLite local). Antes de `grep`/`find`/`Read` para entender estructura, usar `codegraph explore "<pregunta>"` o el tool MCP `codegraph_explore` cuando esté disponible. Cubre call paths, dynamic dispatch, referencias.
- **projectmem** — memoria de proceso entre sesiones de IA. Al iniciar sesión llamar `get_instructions()` / `get_summary()` (MCP) o `pjm brief` (CLI). Durante el trabajo loguear `issue`/`attempt`/`fix`/`decision`/`note`; planes largos van en `.projectmem/plan.md`, **nunca** como eventos. Antes de commit se ejecuta `pjm precheck` (hook `pre-commit`); ruido temporal se silencia con `pjm precheck --snooze 2h`.

### Frontera de memoria (importante)

- Decisiones arquitecturales canónicas → ADRs en `05-Decisions/` y `openwiki/`. AIES no es un sistema de memoria (Non-Goal §7).
- Decisiones operativas, lecciones, gotchas entre sesiones → `.projectmem/` (memoria de proceso, local, gitignored).
- Las ideas que maduren en `.projectmem/` se **promocionan manualmente** a ADR / openwiki. No duplicar.
