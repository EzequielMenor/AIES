/**
 * AIES-002 runtime checks.
 *
 * These run the real launcher and the real Pi process (RPC mode) against a
 * temporary `AIES_HOME`, so they prove what a pure unit test cannot: the
 * extension loads through Pi's own loader, registers `/aies-status` from the
 * isolated profile, answers it, and never reports a hook error.
 *
 * No credentials and no model calls are involved: an extension command executes
 * immediately, without a turn.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const AIES = join(REPO, "bin", "aies");
const PI_PROFILE = join(homedir(), ".pi", "agent");

const WATCHED = ["settings.json", "auth.json", "models.json"].map((name) => join(PI_PROFILE, name));

function digest(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fingerprintProfile() {
  return {
    files: Object.fromEntries(WATCHED.map((path) => [path, digest(path)])),
    sessions: existsSync(join(PI_PROFILE, "sessions")) ? readdirSync(join(PI_PROFILE, "sessions")).sort() : [],
  };
}

function isolatedEnv(home) {
  return {
    ...process.env,
    AIES_HOME: home,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    PI_CODING_AGENT_DIR: PI_PROFILE,
    PI_CODING_AGENT_SESSION_DIR: join(PI_PROFILE, "sessions"),
  };
}

/** Drives one Pi process through several RPC commands and returns everything it said. */
function rpc(env, commands, extraArgs = []) {
  const input = `${commands.map((command) => JSON.stringify(command)).join("\n")}\n`;
  const result = spawnSync(AIES, ["--mode", "rpc", ...extraArgs], { env, input, encoding: "utf8", timeout: 60_000 });

  const records = [];
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // Diagnostics outside the JSONL protocol.
    }
  }

  return { status: result.status, records, stderr: result.stderr };
}

function responseFor(records, command) {
  const record = records.find((entry) => entry.type === "response" && entry.command === command);
  assert.ok(record, `no "${command}" response in RPC output`);
  assert.equal(record.success, true, `${command} failed: ${JSON.stringify(record.error ?? {})}`);
  return record.data;
}

describe("AIES observability runtime", () => {
  let home;
  let agentDir;
  let env;
  let baseline;

  before(() => {
    baseline = fingerprintProfile();
    home = mkdtempSync(join(tmpdir(), "aies-observability-"));
    agentDir = join(home, "agent");
    env = isolatedEnv(home);
    mkdirSync(agentDir, { recursive: true });
  });

  after(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("registers /aies-status from the isolated profile, without a hook error", () => {
    const { records } = rpc(env, [
      { id: "1", type: "get_state" },
      { id: "2", type: "get_commands" },
    ]);

    const commands = responseFor(records, "get_commands").commands;
    const status = commands.find((command) => command.name === "aies-status");
    assert.ok(status, "the observer extension did not register /aies-status");
    assert.equal(status.source, "extension");
    assert.equal(status.sourceInfo.baseDir, agentDir, "/aies-status came from somewhere else");
    assert.match(status.sourceInfo.path, /extensions\/aies-runtime\/index\.ts$/u);

    const identity = commands.find((command) => command.name === "aies-info");
    assert.ok(identity, "the identity extension stopped working");

    assert.ok(responseFor(records, "get_state").sessionId, "the session did not start");
    assert.deepEqual(records.filter((record) => record.type === "extension_error"), []);
  });

  it("answers /aies-status from a real Pi session", () => {
    const { records } = rpc(env, [
      { id: "1", type: "prompt", message: "/aies-status" },
      { id: "2", type: "get_state" },
    ]);

    const sessionFile = responseFor(records, "get_state").sessionFile;
    assert.ok(sessionFile?.startsWith(`${join(agentDir, "sessions")}/`), `session escaped the profile: ${sessionFile}`);

    const notifications = records.filter(
      (record) => record.type === "extension_ui_request" && record.method === "notify",
    );
    assert.ok(notifications.length >= 1, "the command produced no notification");

    const report = notifications.at(-1).message;
    assert.match(report, /^AIES — estado de la sesión$/mu);
    assert.match(report, /^Contexto:$/mu);
    assert.match(report, /^Padre:$/mu);
    assert.match(report, /^Resultados de tools:$/mu);
    assert.match(report, /^Runtime:$/mu);
    assert.match(report, /Mide, no gobierna/u);
    // Compact on purpose: one section per group, no runaway growth.
    assert.equal(report.split("\n").length, 29, `unexpected report shape:\n${report}`);

    assert.deepEqual(records.filter((record) => record.type === "extension_error"), []);
  });

  it("keeps the ambient Pi profile untouched", () => {
    assert.deepEqual(fingerprintProfile(), baseline);
  });
});
