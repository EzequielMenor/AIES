// src/self-check/compaction.ts — verificación del mapeo pi → log de compactación sin pi (RNF-18/19).
// Simula los eventos `compaction_start`/`compaction_end` (formato de pi, dist/core/agent-session.d.ts)
// y comprueba el mapeo a dominio + la serialización de la entrada de log. C2: el import de tipos de
// pi es de tipos SOLAMENTE (el runtime ya depende del paquete); no se inicializa ningún host.

import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { compactionEntry } from "../observability.js";
import { mapCompaction } from "../pi-binding/events.js";

type StartEvent = Extract<AgentSessionEvent, { type: "compaction_start" }>;
type EndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;

function startEvent(): StartEvent {
	return { type: "compaction_start", reason: "threshold" };
}

function endEvent(): EndEvent {
	return {
		type: "compaction_end",
		reason: "overflow",
		result: {
			summary: "progreso: u0 terminada; siguiente: verificar",
			firstKeptEntryId: "ent-42",
			tokensBefore: 150000,
			estimatedTokensAfter: 21000,
		},
		aborted: false,
		willRetry: true,
	};
}

function endWithoutResult(): EndEvent {
	return { type: "compaction_end", reason: "manual", result: undefined, aborted: true, willRetry: false };
}

function main(): void {
	// start → dominio (solo razón; resto null)
	const s = mapCompaction(startEvent());
	assert.equal(s.fase, "start");
	assert.equal(s.reason, "threshold");
	assert.equal(s.tokensBefore, null);
	assert.equal(s.summary, null);

	// end → dominio completo
	const e = mapCompaction(endEvent());
	assert.equal(e.fase, "end");
	assert.equal(e.reason, "overflow");
	assert.equal(e.summary, "progreso: u0 terminada; siguiente: verificar");
	assert.equal(e.firstKeptEntryId, "ent-42");
	assert.equal(e.tokensBefore, 150000);
	assert.equal(e.estimatedTokensAfter, 21000);
	assert.equal(e.aborted, false);
	assert.equal(e.willRetry, true);

	// end sin result (defensivo) → nulls, no crash
	const e2 = mapCompaction(endWithoutResult());
	assert.equal(e2.fase, "end");
	assert.equal(e2.summary, null);
	assert.equal(e2.tokensBefore, null);
	assert.equal(e2.aborted, true);

	// serialización a log.jsonl (append-only): round-trip conserva campos
	const entry = compactionEntry(e);
	assert.equal(entry.type, "compaction");
	assert.deepEqual(JSON.parse(JSON.stringify(entry)), entry);

	console.log("OK compaction: start/end mapeados, end-sin-result defensivo, entrada serializable (RNF-18/19).");
}

main();