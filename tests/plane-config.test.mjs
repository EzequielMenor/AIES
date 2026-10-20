/**
 * D33 phase 3: the Plane MCP declaration and the diagnostic wording.
 *
 * (a) The profile declares Plane over OAuth beside Linear, with no credential,
 *     header or PAT endpoint. The PAT path is not declared yet (D33 item 4).
 * (b) The diagnostic names the server of the active tracker. Linear wording stays
 *     byte for byte what it was; Plane uses the same sentences with its label and
 *     `/mcp-auth plane`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyMcpStatusEvent,
  createMcpIntegrationState,
  describeMcpDiagnostic,
  diagnoseMcpServer,
} from "../extensions/aies-agents/mcp/integration.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PLANE_OAUTH = { url: "https://mcp.plane.so/http/mcp", auth: "oauth", lifecycle: "lazy" };
const LINEAR_OAUTH = { url: "https://mcp.linear.app/mcp", auth: "oauth", lifecycle: "lazy" };
const SECRET_MARKERS = [
  "Bearer",
  "api-key",
  "PLANE_API_KEY",
  "LINEAR_API_KEY",
  "bearerTokenEnv",
  "bearerToken",
  "x-workspace-slug",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "authorization_code",
];

function readConfig(relativePath) {
  const raw = readFileSync(`${REPO}/${relativePath}`, "utf8");
  return { raw, json: JSON.parse(raw) };
}

describe("D33 phase 3: the profile declares Plane beside Linear, over OAuth only", () => {
  for (const path of ["profile/mcp-adapter.json", "profile/mcp.json"]) {
    it(`${path} declares exactly linear and plane, both as OAuth lazy servers`, () => {
      const { json } = readConfig(path);
      assert.deepEqual(Object.keys(json.mcpServers), ["linear", "plane"]);
      assert.deepEqual(json.mcpServers.linear, LINEAR_OAUTH);
      assert.deepEqual(json.mcpServers.plane, PLANE_OAUTH);
    });

    it(`${path} carries no credential, header or PAT endpoint`, () => {
      const { raw } = readConfig(path);
      for (const marker of SECRET_MARKERS) {
        assert.equal(raw.includes(marker), false, `${path} must not contain ${marker}`);
      }
      assert.equal(raw.includes("api-key"), false, "the PAT endpoint is not declared yet");
    });

    it(`${path} keeps the proxy-only settings unchanged`, () => {
      const { json } = readConfig(path);
      assert.equal(json.settings.scriptMode, false);
      assert.equal(json.settings.directTools, undefined);
    });
  }
});

describe("D33 phase 3: the diagnostic wording", () => {
  it("Linear messages are the same bytes they were before Plane existed", () => {
    const linear = (code, mode) => describeMcpDiagnostic({ code, usable: false, server: "linear" }, { mode });
    assert.equal(
      linear("adapter_missing", "tui"),
      "pi-mcp-adapter is not loaded in this AIES profile, so MCP servers such as Linear cannot be reached.\nThe profile declares npm:pi-mcp-adapter. Run any aies command once with network access so Pi installs it, or run:\n  aies install npm:pi-mcp-adapter",
    );
    assert.equal(
      linear("server_missing", "tui"),
      'No "linear" MCP server is configured in this AIES profile.\nExpected in $AIES_HOME/agent/mcp-adapter.json, pointing at https://mcp.linear.app/mcp with auth "oauth".',
    );
    assert.equal(linear("needs_auth", "tui"), "Linear needs authentication.\n\nRun:\n  /mcp-auth linear");
    assert.equal(
      linear("needs_auth", "print"),
      "Linear needs authentication, and this session is not interactive (mode: print).\nAuthenticate from an interactive AIES session with /mcp-auth linear, then retry.",
    );
    assert.equal(
      linear("needs_auth", undefined),
      "Linear needs authentication, and this session is not interactive (mode: unknown).\nAuthenticate from an interactive AIES session with /mcp-auth linear, then retry.",
    );
    assert.equal(
      linear("disabled", "tui"),
      'The "linear" MCP server is disabled in this AIES profile.\nEnable it with /mcp enable linear and reload, or remove the disabled flag from $AIES_HOME/agent/mcp-adapter.json.',
    );
    assert.equal(
      linear("server_failed", "tui"),
      'The "linear" MCP server failed to connect.\nReconnect with /mcp reconnect linear, then retry.',
    );
    assert.equal(describeMcpDiagnostic({ code: "ready", usable: true, server: "linear" }), "");
  });

  it("Plane messages use the Plane label, its endpoint and /mcp-auth plane", () => {
    const plane = (code, mode) => describeMcpDiagnostic({ code, usable: false, server: "plane" }, { mode });
    assert.equal(
      plane("adapter_missing", "tui"),
      "pi-mcp-adapter is not loaded in this AIES profile, so MCP servers such as Plane cannot be reached.\nThe profile declares npm:pi-mcp-adapter. Run any aies command once with network access so Pi installs it, or run:\n  aies install npm:pi-mcp-adapter",
    );
    assert.equal(
      plane("server_missing", "tui"),
      'No "plane" MCP server is configured in this AIES profile.\nExpected in $AIES_HOME/agent/mcp-adapter.json, pointing at https://mcp.plane.so/http/mcp with auth "oauth".',
    );
    assert.equal(plane("needs_auth", "tui"), "Plane needs authentication.\n\nRun:\n  /mcp-auth plane");
    assert.equal(
      plane("needs_auth", "print"),
      "Plane needs authentication, and this session is not interactive (mode: print).\nAuthenticate from an interactive AIES session with /mcp-auth plane, then retry.",
    );
    assert.equal(
      plane("disabled", "tui"),
      'The "plane" MCP server is disabled in this AIES profile.\nEnable it with /mcp enable plane and reload, or remove the disabled flag from $AIES_HOME/agent/mcp-adapter.json.',
    );
    assert.equal(
      plane("server_failed", "tui"),
      'The "plane" MCP server failed to connect.\nReconnect with /mcp reconnect plane, then retry.',
    );
  });

  it("the probe reads the server it is asked about, not Linear's", () => {
    const state = applyMcpStatusEvent(createMcpIntegrationState(), {
      servers: [
        { name: "linear", status: "connected", toolCount: 66 },
        { name: "plane", status: "needs-auth", toolCount: 0 },
      ],
    });
    assert.equal(diagnoseMcpServer(state).code, "ready", "the default server is still Linear");
    const plane = diagnoseMcpServer(state, { server: "plane" });
    assert.equal(plane.code, "needs_auth");
    assert.equal(plane.server, "plane");
    assert.match(describeMcpDiagnostic(plane, { mode: "tui" }), /Plane needs authentication\.\n\nRun:\n {2}\/mcp-auth plane/);
  });
});
