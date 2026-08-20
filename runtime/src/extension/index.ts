// src/extension/index.ts — entry point de la extensión AIES para Pi.
//
// @deprecated 2026-08-20: AIES usa CLI standalone (`src/cli.ts`). Este código se eliminará en v2.
// Para uso activo, instala el binario `aies` y ejecuta `aies run "<tarea>"` o `aies`.

//
// Cargada por `pi -e ./src/extension/index.ts` o instalada en `~/.pi/agent/extensions/`.
//
// La extensión:
//   - Registra el comando /run (handler en run-command.ts) que ejecuta el bucle AIES.
//   - Registra tools explore/implement/verify (handlers en workers/tools.ts) que delegan a
//     sesiones efímeras con allowlist por capability.
//   - Fase 3 añade hooks de observabilidad (tool_call, agent_end, session_before_compact) y
//     intervention con pi.ui.confirm.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { register } from "./register.js";

export default function aiesExtension(pi: ExtensionAPI): void {
	register(pi);
}
