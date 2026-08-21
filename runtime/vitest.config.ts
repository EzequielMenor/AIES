// vitest.config.ts — config para vitest.
// Usa el mismo tsconfig base que el runtime, pero incluye TODO src/ para que el smoke test pueda
// importar cli.ts, ui/stream-renderer.ts, workers/tools.ts, orchestrator/decide.ts, etc.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// El smoke E2E y los tests de actualización usan Vitest; los demás self-checks
		// se ejecutan mediante sus scripts específicos.
		include: ["tests/smoke-e2e.test.ts", "tests/update.test.ts"],
		// El smoke test puede tardar (escribe archivo + spawna node); 30s es seguro.
		testTimeout: 30_000,
		// vitest por defecto es global; lo apagamos para tests más limpios.
		globals: false,
	},
});
