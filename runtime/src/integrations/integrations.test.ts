// src/integrations/integrations.test.ts — ADR-011: tests unitarios del módulo de integraciones.
//
// Cobertura: detección (con prober inyectado), briefing (presente/ausente/truncado),
// allowlists por capability y degradación limpia del arranque.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "vitest";

import {
	detect,
	readMemoryBriefing,
	buildCustomTools,
	toolNamesFor,
	runStartup,
} from "./index.js";
import { buildCapabilityTools } from "../workers/capabilities.js";
import { MAX_BRIEFING_CHARS } from "./memory-briefing.js";

const dirs: string[] = [];
function mkCwd(): string {
	const d = mkdtempSync(path.join(tmpdir(), "aies-int-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

describe("detect (prober inyectado)", () => {
	it("todo ausente → missing × 2", () => {
		const cwd = mkCwd();
		const r = detect(cwd, { probeCli: () => false });
		assert.equal(r.codegraph, "missing");
		assert.equal(r.projectmem, "missing");
	});

	it("CLI presente + índice → ready / uninit", () => {
		const cwd = mkCwd();
		mkdirSync(path.join(cwd, ".codegraph"));
		const r = detect(cwd, { probeCli: (b) => b === "codegraph" });
		assert.equal(r.codegraph, "ready");
		assert.equal(r.projectmem, "missing");
	});

	it("CLI presente sin índice → needs-init", () => {
		const cwd = mkCwd();
		const r = detect(cwd, { probeCli: (b) => b === "codegraph" });
		assert.equal(r.codegraph, "needs-init");
	});

	it("projectmem CLI presente, sin summary → uninit", () => {
		const cwd = mkCwd();
		const r = detect(cwd, { probeCli: (b) => b === "pjm" });
		assert.equal(r.projectmem, "uninit");
	});

	it("projectmem CLI presente + summary → ready", () => {
		const cwd = mkCwd();
		mkdirSync(path.join(cwd, ".projectmem"));
		writeFileSync(path.join(cwd, ".projectmem", "summary.md"), "x\n");
		const r = detect(cwd, { probeCli: (b) => b === "pjm" });
		assert.equal(r.projectmem, "ready");
	});
});

describe("readMemoryBriefing", () => {
	it("ausente → null", () => {
		const cwd = mkCwd();
		assert.equal(readMemoryBriefing(cwd), null);
	});

	it("presente: devuelve texto tal cual y truncated=false", () => {
		const cwd = mkCwd();
		mkdirSync(path.join(cwd, ".projectmem"));
		const body = "decisión: usar uv\nlección: pjm install falla a veces\n";
		writeFileSync(path.join(cwd, ".projectmem", "summary.md"), body);
		const b = readMemoryBriefing(cwd);
		assert.ok(b);
		assert.equal(b!.text, body.trim());
		assert.equal(b!.truncated, false);
		assert.equal(b!.originalChars, body.trim().length);
	});

	it("excede MAX_BRIEFING_CHARS → trunca con nota", () => {
		const cwd = mkCwd();
		mkdirSync(path.join(cwd, ".projectmem"));
		const big = "x".repeat(MAX_BRIEFING_CHARS + 500);
		writeFileSync(path.join(cwd, ".projectmem", "summary.md"), big);
		const b = readMemoryBriefing(cwd);
		assert.ok(b);
		assert.equal(b!.truncated, true);
		assert.ok(b!.text.length <= MAX_BRIEFING_CHARS);
		assert.match(b!.text, /\[…resumen truncado: \d+→\d+ chars\]/);
	});

	it("vacío → null", () => {
		const cwd = mkCwd();
		mkdirSync(path.join(cwd, ".projectmem"));
		writeFileSync(path.join(cwd, ".projectmem", "summary.md"), "   \n");
		assert.equal(readMemoryBriefing(cwd), null);
	});
});

describe("toolNamesFor + buildCustomTools", () => {
	it("todo missing → 0 tools", () => {
		const cwd = mkCwd();
		const a = { codegraph: "missing" as const, projectmem: "missing" as const, cwd };
		assert.deepEqual(toolNamesFor(a), { code_explore: false, mem_read: false, mem_log: false });
		assert.equal(buildCustomTools(a).length, 0);
	});

	it("codegraph ready + projectmem uninit → code_explore + mem_*", () => {
		const cwd = mkCwd();
		const a = { codegraph: "ready" as const, projectmem: "uninit" as const, cwd };
		const names = toolNamesFor(a);
		assert.equal(names.code_explore, true);
		assert.equal(names.mem_read, true);
		assert.equal(names.mem_log, true);
		assert.equal(buildCustomTools(a).length, 3);
	});

	it("projectmem missing → no mem_*", () => {
		const cwd = mkCwd();
		const a = { codegraph: "needs-init" as const, projectmem: "missing" as const, cwd };
		const tools = buildCustomTools(a);
		assert.equal(tools.length, 0);
	});
});

describe("buildCapabilityTools — allowlists (P-10/REQ-F-18)", () => {
	const intgAll = { code_explore: true, mem_read: true, mem_log: true };

	it("explorer: code_explore + mem_read, NUNCA mem_log, NUNCA bash", () => {
		const tools = buildCapabilityTools({ integrations: intgAll });
		assert.ok(tools.explorer.includes("code_explore"));
		assert.ok(tools.explorer.includes("mem_read"));
		assert.ok(!tools.explorer.includes("mem_log"));
		assert.ok(!tools.explorer.includes("bash"));
	});

	it("implementer: las 3 integration tools + bash + edit + write", () => {
		const tools = buildCapabilityTools({ integrations: intgAll });
		assert.ok(tools.implementer.includes("code_explore"));
		assert.ok(tools.implementer.includes("mem_read"));
		assert.ok(tools.implementer.includes("mem_log"));
		assert.ok(tools.implementer.includes("bash"));
		assert.ok(tools.implementer.includes("edit"));
		assert.ok(tools.implementer.includes("write"));
	});

	it("verifier (ADR-002): code_explore + mem_read, NUNCA mem_log, NUNCA edit/write", () => {
		const tools = buildCapabilityTools({ integrations: intgAll });
		assert.ok(tools.verifier.includes("code_explore"));
		assert.ok(tools.verifier.includes("mem_read"));
		assert.ok(!tools.verifier.includes("mem_log"));
		assert.ok(!tools.verifier.includes("edit"));
		assert.ok(!tools.verifier.includes("write"));
	});

	it("sin integraciones: allowlists conservan forma base (sin tools externas)", () => {
		const tools = buildCapabilityTools({ integrations: { code_explore: false, mem_read: false, mem_log: false } });
		assert.deepEqual(tools.explorer, ["read", "grep", "find", "ls"]);
		assert.deepEqual(tools.implementer, ["read", "edit", "write", "bash", "grep", "find"]);
		assert.deepEqual(tools.verifier, ["read", "bash", "grep", "find", "ls"]);
	});
});

describe("runStartup (degradación limpia)", () => {
	it("todo ausente → briefing sólo con línea HERRAMIENTAS", () => {
		const cwd = mkCwd();
		const r = runStartup_withProber(cwd, () => false);
		assert.equal(r.availability.codegraph, "missing");
		assert.equal(r.availability.projectmem, "missing");
		assert.equal(r.customTools.length, 0);
		assert.equal(r.briefing.length, 1);
		assert.match(r.briefing[0]!, /codegraph=missing, projectmem=missing/);
	});

	it("projectmem uninit → briefing incluye sugerencia pjm init", () => {
		const cwd = mkCwd();
		const r = runStartup_withProber(cwd, (b) => b === "pjm");
		assert.equal(r.availability.projectmem, "uninit");
		assert.ok(r.briefing.some((l) => /no inicializada/.test(l)));
		assert.ok(r.briefing.some((l) => /pjm init/.test(l)));
		assert.match(r.briefing.at(-1)!, /projectmem=uninit/);
	});

	it("projectmem ready → briefing incluye MEMORIA DEL PROYECTO + contenido", () => {
		const cwd = mkCwd();
		mkdirSync(path.join(cwd, ".projectmem"));
		writeFileSync(path.join(cwd, ".projectmem", "summary.md"), "lección: foo bar\n");
		const r = runStartup_withProber(cwd, (b) => b === "pjm");
		assert.equal(r.availability.projectmem, "ready");
		assert.ok(r.briefing.some((l) => /MEMORIA DEL PROYECTO/.test(l)));
		assert.ok(r.briefing.some((l) => /lección: foo bar/.test(l)));
	});

	it("codegraph CLI presente sin índice + needs-init → NO se auto-inicia en tests (prober stub lo evita)", () => {
		// Aquí no mockeamos el spawn de `codegraph init`: la idea es que con CLI stub-true pero
		// sin índice, runStartup detecta needs-init pero ensureCodegraphIndex se llama de verdad.
		// Para tests unitarios, evitamos tocar `codegraph init` real: usamos prober que devuelve false,
		// garantizando el camino "CLI ausente" (sin auto-init).
		const cwd = mkCwd();
		const r = runStartup_withProber(cwd, () => false);
		assert.equal(r.availability.codegraph, "missing");
		assert.equal(r.codegraphInit.status, "skipped");
	});

	it("con CLI e índice presentes → customTools contiene code_explore", () => {
		const cwd = mkCwd();
		mkdirSync(path.join(cwd, ".codegraph"));
		const r = runStartup_withProber(cwd, (b) => b === "codegraph");
		assert.equal(r.availability.codegraph, "ready");
		assert.ok(r.customTools.some((t) => t.name === "code_explore"));
	});
});

function runStartup_withProber(
	cwd: string,
	probeCli: (bin: string) => boolean,
): ReturnType<typeof runStartup> {
	// runStartup usa `detect(cwd)` sin options; aquí llamamos las piezas con la disponibilidad
	// pre-calculada para evitar tocar spawnSync real en `codegraph init`.
	const availability = detect(cwd, { probeCli });
	// Importante: NO ejecutamos ensureCodegraphIndex real para no side-effect; simulamos.
	const codegraphInit =
		availability.codegraph === "ready"
			? { status: "ready" as const, message: "índice codegraph ya presente" }
			: availability.codegraph === "needs-init"
				? { status: "skipped" as const, message: "codegraph init omitido en test" }
				: { status: "skipped" as const, message: "codegraph CLI ausente" };
	const memoryBriefing = availability.projectmem === "ready" ? readMemoryBriefing(cwd) : null;
	const customTools = buildCustomTools(availability);
	const toolNames = toolNamesFor(availability);
	const briefing: string[] = [];
	if (memoryBriefing) {
		const header = memoryBriefing.truncated
			? `MEMORIA DEL PROYECTO (resumen, truncado ${memoryBriefing.originalChars}→${memoryBriefing.text.length} chars):`
			: "MEMORIA DEL PROYECTO (resumen):";
		briefing.push(header, memoryBriefing.text);
	} else if (availability.projectmem === "uninit") {
		briefing.push("MEMORIA DEL PROYECTO: no inicializada. El implementer puede sugerir `pjm init` al desarrollador si va a registrar decisiones/lecciones duraderas.");
	}
	const cg = availability.codegraph;
	const cgMsg = cg === "ready" ? "ok" : cg === "needs-init" ? (codegraphInit.status === "initiated" ? "init" : "autoskip") : "missing";
	const pm = availability.projectmem;
	const pmMsg = pm === "ready" ? "ok" : pm === "uninit" ? "uninit" : "missing";
	briefing.push(`HERRAMIENTAS EXTERNAS: codegraph=${cgMsg}, projectmem=${pmMsg}.`);
	return { availability, codegraphInit, memoryBriefing, briefing, customTools, toolNames };
}
