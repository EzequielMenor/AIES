/**
 * A fake ProjectMem for the recall tests: a node script that logs every call, and reads and writes a
 * real events.jsonl like the real CLI does (search output marks superseded decisions the same way).
 * Everything lives under a temporary AIES_HOME. Nothing here touches a real profile.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PROJECTMEM_VERSION } from "../../extensions/aies-memory/store.ts";

export const FAKE_PJM = `#!${process.execPath}
const fs = require("fs");
const H = process.env.PROJECTMEM_HOME;
const args = process.argv.slice(2);
fs.appendFileSync(H + "/calls.log", JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const read = (p) => { try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; } };
const mode = read(H + "/mode") || "ok";
if (mode === "sleep") { setTimeout(() => {}, 10000); }
else if (mode === "fail") { console.error("Traceback: boom"); process.exit(1); }
else {
  const [cmd, ...rest] = args;
  const log = ".projectmem/events.jsonl";
  const events = () => (fs.existsSync(log) ? read(log).split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const last = rest[rest.length - 1];
  if (cmd === "init") { fs.mkdirSync(".projectmem", { recursive: true }); fs.writeFileSync(".projectmem/config.toml", "x"); fs.writeFileSync(log, ""); }
  else if (["note", "decision", "log", "fix", "attempt"].includes(cmd)) {
    const n = events().length + 1;
    const event = { id: "evt_" + n.toString(16).padStart(20, "0"), type: cmd === "log" ? "issue" : cmd, summary: last, timestamp: "2026-01-01T00:00:00Z" };
    const sup = rest.indexOf("--supersedes");
    if (sup >= 0) event.supersedes = rest[sup + 1];
    fs.appendFileSync(log, JSON.stringify(event) + "\\n");
  } else if (cmd === "context") {
    for (const e of events()) console.log("- " + e.summary);
  } else if (cmd === "search") {
    const all = events();
    const retired = new Set(all.map((e) => e.supersedes).filter(Boolean));
    const q = last.toLowerCase();
    for (const e of all) if (e.summary.toLowerCase().includes(q)) console.log(e.timestamp + " [" + e.id + "] " + e.type + ": " + e.summary + (retired.has(e.id) ? " (superseded)" : ""));
  }
}
`;

const FAKE_PYTHON = `#!${process.execPath}
console.log("${PROJECTMEM_VERSION}");
`;

export function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "-c", "user.email=aies@example.com", "-c", "user.name=AIES Fixture", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`.trim());
  return (result.stdout ?? "").trim();
}

export function makeRepo(parent, name) {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), `# ${name}\n`);
  runGit(root, ["init", "-q", "-b", "main"]);
  runGit(root, ["add", "-A"]);
  runGit(root, ["commit", "-q", "-m", "baseline"]);
  return realpathSync(root);
}

export function tempDir(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A temporary AIES_HOME; `withVenv: false` leaves no ProjectMem install, `withMemory: false` no memory dir at all. */
export function fakeProfile({ withVenv = true, withMemory = true } = {}) {
  const home = tempDir("aies-recall-");
  const memory = join(home, "memory");
  const pmHome = join(memory, "_home");
  if (withMemory) {
    mkdirSync(pmHome, { recursive: true });
    if (withVenv) {
      const bin = join(memory, "_venv", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "pjm"), FAKE_PJM);
      writeFileSync(join(bin, "python"), FAKE_PYTHON);
      chmodSync(join(bin, "pjm"), 0o755);
      chmodSync(join(bin, "python"), 0o755);
    }
  }
  const calls = () => {
    const file = join(pmHome, "calls.log");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  /** pjm invocations proper (the version probe runs python, not pjm). */
  const pjmCalls = () => calls().filter((call) => call.args[0] !== "-I");
  const searches = () => pjmCalls().filter((call) => call.args[0] === "search").map((call) => call.args[call.args.length - 1]);
  return { home, memory, pmHome, calls, pjmCalls, searches, setMode: (mode) => writeFileSync(join(pmHome, "mode"), mode) };
}

/** Write a store straight into events.jsonl, as an earlier process would have left it. */
export function seedEvents(profile, key, events) {
  const dir = join(profile.memory, key, ".projectmem");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), "x");
  const lines = events.map((event, index) => ({
    id: event.id ?? `evt_${(index + 1).toString(16).padStart(20, "0")}`,
    type: event.type ?? "note",
    summary: event.summary,
    timestamp: event.timestamp ?? `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    ...(event.supersedes ? { supersedes: event.supersedes } : {}),
  }));
  writeFileSync(join(dir, "events.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return lines;
}
