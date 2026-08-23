// src/model-runtime.test.ts — tests de parseModelRef + isRole.

import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { isRole, parseModelRef, ROLES } from "./model-runtime.js";

describe("parseModelRef", () => {
	it("sin slash → provider por defecto", () => {
		const r = parseModelRef("MiniMax-M2.7", "minimax");
		assert.deepEqual(r, { provider: "minimax", modelId: "MiniMax-M2.7" });
	});

	it("con slash → split por el primer slash", () => {
		const r = parseModelRef("anthropic/claude-opus-4-5", "minimax");
		assert.deepEqual(r, { provider: "anthropic", modelId: "claude-opus-4-5" });
	});

	it("múltiples slashes → sólo el primero separa (model-id conserva el resto)", () => {
		const r = parseModelRef("openrouter/foo/bar", "minimax");
		assert.deepEqual(r, { provider: "openrouter", modelId: "foo/bar" });
	});

	it("provider vacío tras split → error", () => {
		assert.throws(() => parseModelRef("/claude", "minimax"), /provider vacío/);
	});

	it("model-id vacío tras split → error", () => {
		assert.throws(() => parseModelRef("anthropic/", "minimax"), /model-id vacío/);
	});

	it("ref vacío → error", () => {
		assert.throws(() => parseModelRef("   ", "minimax"), /vacía/);
	});

	it("trim de espacios y lowercase del provider", () => {
		const r = parseModelRef("  Anthropic/Claude-3 ", "minimax");
		assert.deepEqual(r, { provider: "anthropic", modelId: "Claude-3" });
	});
});

describe("isRole + ROLES", () => {
	it("lista canónica", () => {
		assert.deepEqual([...ROLES], ["orchestrator", "explorer", "implementer", "verifier"]);
	});

	it("acepta roles conocidos", () => {
		assert.ok(isRole("orchestrator"));
		assert.ok(isRole("verifier"));
	});

	it("rechaza desconocidos", () => {
		assert.equal(isRole("narrator"), false);
		assert.equal(isRole(""), false);
	});
});