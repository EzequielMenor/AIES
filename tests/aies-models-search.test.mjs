/**
 * EZE-453 / T10: the pure fuzzy matcher behind `/aies-models` type-ahead.
 *
 * `@earendil-works/pi-tui` is not a dependency of this repository, so AIES owns
 * a small, host-free subsequence matcher. Everything here is offline and
 * deterministic: no terminal, no registry, no network. The point of the suite is
 * the ranking contract — contiguous, early, tight, word-boundary matches win —
 * plus totality over hostile input.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_QUERY_LENGTH,
  fuzzyFilter,
  fuzzyScore,
  modelSearchText,
} from "../extensions/aies-models/search.ts";

describe("modelSearchText", () => {
  it("mirrors Pi's haystack: provider, provider/id, provider, id and name", () => {
    assert.equal(
      modelSearchText({ provider: "commandcode", id: "qwen3.8-flash", name: "Qwen3.8 Flash" }),
      "commandcode commandcode/qwen3.8-flash commandcode qwen3.8-flash Qwen3.8 Flash",
    );
  });

  it("omits the trailing name when there is none", () => {
    assert.equal(modelSearchText({ provider: "faux", id: "m1" }), "faux faux/m1 faux m1");
  });

  it("leads with the provider so an exact provider/id query outranks a bare id", () => {
    const haystack = modelSearchText({ provider: "commandcode", id: "Qwen3.8-Flash", name: "Qwen3.8 Flash" });
    assert.ok(haystack.startsWith("commandcode "), haystack);
    assert.equal(haystack.split(" ")[0], "commandcode");
  });
});

describe("fuzzyScore", () => {
  it("matches everything with an empty or whitespace query", () => {
    assert.equal(fuzzyScore("", "anything at all"), 0);
    assert.equal(fuzzyScore("   ", "anything at all"), 0);
    assert.equal(fuzzyScore("\t\n", "anything at all"), 0);
  });

  it("returns undefined when the query is not a subsequence", () => {
    assert.equal(fuzzyScore("z", "abc"), undefined);
    assert.equal(fuzzyScore("abc", "acb"), undefined);
    assert.equal(fuzzyScore("abcd", "abc"), undefined);
    assert.notEqual(fuzzyScore("abc", "a-b-c"), undefined);
  });

  it("is case-insensitive in both directions", () => {
    assert.notEqual(fuzzyScore("ABC", "abc"), undefined);
    assert.notEqual(fuzzyScore("abc", "ABC"), undefined);
    assert.notEqual(fuzzyScore("Qwen", "commandcode/qwen3.8-flash"), undefined);
  });

  it("ranks a contiguous run above a scattered match", () => {
    assert.ok(fuzzyScore("abc", "abc") > fuzzyScore("abc", "a-b-c"));
  });

  it("prefers an earlier first match when the run count is equal", () => {
    assert.ok(fuzzyScore("ab", "abxxxx") > fuzzyScore("ab", "xxxxab"));
  });

  it("prefers a tighter matched span when run count and first match are equal", () => {
    const tight = fuzzyScore("abcd", "abxcd");
    const loose = fuzzyScore("abcd", "abxxcd");
    assert.ok(tight > loose, `tight=${tight} loose=${loose}`);
  });

  it("prefers matches at a word boundary when everything else is equal", () => {
    const boundary = fuzzyScore("abc", "a bxyzc");
    const plain = fuzzyScore("abc", "axxbxxc");
    assert.ok(boundary > plain, `boundary=${boundary} plain=${plain}`);
  });

  it("handles accented and astral characters as single code points", () => {
    assert.notEqual(fuzzyScore("é", "café con leche"), undefined);
    assert.notEqual(fuzzyScore("café", "café con leche"), undefined);
    assert.notEqual(fuzzyScore("👍", "a👍b"), undefined);
    assert.equal(fuzzyScore("á", "cafe"), undefined);
  });

  it("never throws over hostile input", () => {
    assert.equal(fuzzyScore(42, "abc"), 0);
    assert.equal(fuzzyScore(null, "abc"), 0);
    assert.equal(fuzzyScore("a", 42), undefined);
    assert.equal(fuzzyScore("a", null), undefined);
    assert.equal(fuzzyScore(undefined, undefined), 0);
    assert.equal(fuzzyScore("x".repeat(10_000), "short"), undefined);
  });
});

describe("fuzzyFilter", () => {
  const item = (text) => ({ text });

  it("preserves input order and drops nothing for an empty or whitespace query", () => {
    const items = [item("b"), item("a"), item("c")];
    assert.deepEqual(fuzzyFilter(items, "", (entry) => entry.text), items);
    assert.deepEqual(fuzzyFilter(items, "   ", (entry) => entry.text), items);
  });

  it("keeps only matching items, ranked by descending score", () => {
    const items = [item("axxbxxc"), item("a bxyzc"), item("zzz")];
    const filtered = fuzzyFilter(items, "abc", (entry) => entry.text);
    assert.deepEqual(filtered.map((entry) => entry.text), ["a bxyzc", "axxbxxc"]);
  });

  it("breaks score ties by the original index so the result is stable", () => {
    const items = [item("ab-1"), item("ab-2"), item("ab-3")];
    const filtered = fuzzyFilter(items, "ab", (entry) => entry.text);
    assert.deepEqual(filtered.map((entry) => entry.text), ["ab-1", "ab-2", "ab-3"]);
  });

  it("clamps the query to MAX_QUERY_LENGTH before matching", () => {
    assert.equal(MAX_QUERY_LENGTH, 48);
    const items = [item("a".repeat(48)), item("a".repeat(47))];
    const filtered = fuzzyFilter(items, "a".repeat(50), (entry) => entry.text);
    assert.deepEqual(filtered.map((entry) => entry.text), ["a".repeat(48)]);
  });

  it("survives a non-string query and non-array input without throwing", () => {
    const items = [item("b"), item("a")];
    assert.deepEqual(fuzzyFilter(items, undefined, (entry) => entry.text), items);
    assert.deepEqual(fuzzyFilter(items, 7, (entry) => entry.text), items);
    assert.deepEqual(fuzzyFilter(undefined, "a", (entry) => entry.text), []);
  });

  it("filters a realistic catalogue the way the model step will", () => {
    const models = [
      { provider: "commandcode", id: "Qwen3.8-Flash" },
      { provider: "commandcode", id: "Qwen3.8-Max" },
      { provider: "minimax", id: "MiniMax-M2" },
    ];
    const filtered = fuzzyFilter(models, "qwen", (model) => modelSearchText(model));
    assert.deepEqual(filtered.map((model) => model.id), ["Qwen3.8-Flash", "Qwen3.8-Max"]);
    const scoped = fuzzyFilter(models, "commandcode/qwen3.8-max", (model) => modelSearchText(model));
    assert.deepEqual(scoped.map((model) => model.id), ["Qwen3.8-Max"]);
  });
});
