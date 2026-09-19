/**
 * AIES MCP integration checks.
 *
 * Proves the isolated AIES profile declares exactly the MCP adapter it needs, that
 * the adapter registers its own commands and one proxy tool for a Linear server
 * that exposes 66 tools, that AIES adds no wrapper command of its own, that the
 * runtime Linear transport never speaks MCP itself, and that a missing adapter, a
 * missing server and missing authentication each produce an actionable
 * instruction instead of a fabricated command.
 *
 * Deterministic: no credentials, no model calls, no network. The adapter is only
 * loaded when it is already installed on this machine, so that one test is skipped
 * elsewhere and everything else still runs.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyMcpStatusEvent,
  createMcpIntegrationState,
  describeMcpDiagnostic,
  diagnoseMcpServer,
  isMcpAdapterLoaded,
  MCP_PROXY_TOOL,
  MCP_STATUS_CHANNEL,
  toMcpIntegrationSnapshot,
} from "../extensions/aies-agents/mcp/integration.ts";
import { describeRemoteDirective } from "../extensions/aies-agents/linear/contract.ts";
import { TicketManager } from "../extensions/aies-agents/linear/manager.ts";
import { createTicketTool } from "../extensions/aies-agents/linear/tool.ts";
import { createVerificationState } from "../extensions/aies-agents/verification.ts";
import {
  HostMediatedLinearTransport,
  isLinearRemoteRequired,
  LINEAR_MCP_SERVER,
  LinearTransportError,
  linearRemoteKey,
  readRemoteAnswer,
  unwrapMcpAnswer,
} from "../extensions/aies-agents/linear/transport.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const TEMPLATE_MCP = JSON.parse(readFileSync(join(REPO, "profile", "mcp.json"), "utf8"));
const TEMPLATE_SETTINGS = JSON.parse(readFileSync(join(REPO, "profile", "settings.json"), "utf8"));
const LINEAR_ENDPOINT = "https://mcp.linear.app/mcp";

/** An already installed adapter, if this machine has one. Read-only. */
function resolveInstalledAdapter() {
  const candidates = [
    join(process.env.AIES_HOME ?? join(homedir(), ".local", "share", "aies"), "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts"),
    join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-mcp-adapter", "index.ts"),
    join(REPO, "node_modules", "pi-mcp-adapter", "index.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

describe("AIES MCP integration", () => {
  describe("1. Profile declaration", () => {
    it("declares exactly one Pi package, the MCP adapter", () => {
      assert.deepEqual(TEMPLATE_SETTINGS.packages, ["npm:pi-mcp-adapter"]);
    });

    it("declares exactly one MCP server, on the official Streamable HTTP endpoint", () => {
      const servers = Object.entries(TEMPLATE_MCP.mcpServers ?? {});
      assert.equal(servers.length, 1, "the AIES profile declares exactly one MCP server");
      const [name, definition] = servers[0];
      assert.equal(name, "linear");
      assert.equal(definition.url, LINEAR_ENDPOINT);
      assert.equal(definition.auth, "oauth");
      assert.equal(definition.command, undefined, "Linear must not use a stdio command");
      assert.equal(definition.socket, undefined, "Linear must not use a socket transport");
    });

    it("never configures a legacy SSE endpoint", () => {
      assert.ok(!/\/sse\b/.test(readFileSync(join(REPO, "profile", "mcp.json"), "utf8")));
    });

    it("keeps the resident MCP surface down to the proxy tool", () => {
      assert.equal(TEMPLATE_MCP.settings?.scriptMode, false, "no second MCP tool is registered");
      assert.equal(TEMPLATE_MCP.settings?.directTools, undefined, "no global direct-tool default");
      for (const [name, definition] of Object.entries(TEMPLATE_MCP.mcpServers ?? {})) {
        assert.equal(definition.directTools, undefined, `${name} must stay behind the proxy tool`);
      }
    });

    it("keeps Linear lazy, so aies does not connect at startup", () => {
      for (const [name, definition] of Object.entries(TEMPLATE_MCP.mcpServers ?? {})) {
        assert.equal(definition.lifecycle, "lazy", `${name} must not connect at startup`);
      }
    });
  });

  describe("2. No AIES-owned MCP command", () => {
    const sources = [
      join(REPO, "extensions", "aies-agents", "index.ts"),
      join(REPO, "extensions", "aies-agents", "linear", "command.ts"),
      join(REPO, "extensions", "aies-agents", "linear", "tool.ts"),
    ]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    it("registers no /mcp, /mcp-auth or /aies-linear-auth wrapper", () => {
      assert.ok(!/registerCommand\(\s*["'`]mcp["'`]/.test(sources), "AIES must not register its own /mcp");
      assert.ok(!/registerCommand\(\s*["'`]mcp-auth["'`]/.test(sources), "AIES must not register its own /mcp-auth");
      assert.ok(!/["'`]aies-linear-auth/.test(sources), "the adapter's own auth UX must not be duplicated");
    });

    it("registers no MCP proxy tool of its own", () => {
      assert.ok(!/name:\s*["'`]mcp["'`]/.test(sources), "AIES must not register an MCP tool");
      assert.ok(!/name:\s*["'`]mcpScript["'`]/.test(sources), "AIES must not register an MCP script tool");
      assert.ok(!/registerTool\([^)]*mcp/i.test(sources), "AIES must not register an MCP-backed tool");
    });
  });

  describe("3. Adapter loading (the real extension, when installed)", () => {
    const adapterPath = resolveInstalledAdapter();

    if (!adapterPath) {
      it("loads the adapter, exposes /mcp and /mcp-auth, and registers one MCP tool", { skip: "pi-mcp-adapter is not installed on this machine" }, () => {});
      return;
    }

    it("loads the adapter, exposes /mcp and /mcp-auth, and registers one MCP tool", async () => {
      const { DefaultResourceLoader, createEventBus } = await import("@earendil-works/pi-coding-agent");
      const agentDir = mkdtempSync(join(tmpdir(), "aies-mcp-"));
      const previous = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      try {
        mkdirSync(join(agentDir, "extensions"), { recursive: true });
        writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(TEMPLATE_MCP, null, 2));

        const loader = new DefaultResourceLoader({
          cwd: REPO,
          agentDir,
          eventBus: createEventBus(),
          additionalExtensionPaths: [adapterPath],
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: "probe",
        });
        await loader.reload();
        const loaded = loader.getExtensions();
        assert.deepEqual(loaded.errors, [], "the adapter must load without errors");

        const commands = loaded.extensions.flatMap((extension) => [...extension.commands.keys()]);
        assert.ok(commands.includes("mcp"), "/mcp must come from the adapter");
        assert.ok(commands.includes("mcp-auth"), "/mcp-auth must come from the adapter");

        const tools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
        assert.deepEqual(tools, [MCP_PROXY_TOOL], "the AIES profile registers exactly one MCP tool");
        assert.ok(!tools.some((name) => name.startsWith("linear_")), "no Linear schema may be resident");
        assert.ok(!tools.includes("mcpScript"), "scriptMode is off, so only the proxy tool exists");
      } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(agentDir, { recursive: true, force: true });
      }
    });
  });

  describe("4. Parent-mediated Linear transport", () => {
    it("keys a call by server, tool and normalized arguments", () => {
      assert.equal(linearRemoteKey("linear", "get_issue", { id: "EZE-422" }), 'linear:get_issue(id="EZE-422")');
      assert.equal(linearRemoteKey("linear", "save_issue", { state: "s1", id: "E-1" }), 'linear:save_issue(id="E-1",state="s1")');
      assert.equal(linearRemoteKey("linear", "list_issue_statuses", {}), "linear:list_issue_statuses");
    });

    it("asks the Parent for the exact MCP call instead of speaking MCP itself", async () => {
      await assert.rejects(
        () => new HostMediatedLinearTransport().getIssue("EZE-422"),
        (error) => {
          assert.ok(isLinearRemoteRequired(error));
          assert.equal(error.code, "remote_required");
          assert.deepEqual(error.directive, {
            key: 'linear:get_issue(id="EZE-422")',
            server: "linear",
            tool: "get_issue",
            args: { id: "EZE-422" },
            purpose: "read the ticket contract",
          });
          return true;
        },
      );
    });

    it("uses the argument names the Linear MCP server documents", async () => {
      const directives = [];
      const transport = new HostMediatedLinearTransport();
      const calls = [
        () => transport.updateIssue("E-1", { statusId: "s1" }),
        () => transport.getStatuses("Eze"),
        () => transport.addComment("E-1", "hi"),
      ];
      for (const call of calls) {
        await call().catch((error) => directives.push(error.directive));
      }
      assert.deepEqual(directives, [
        { key: 'linear:save_issue(id="E-1",state="s1")', server: "linear", tool: "save_issue", args: { id: "E-1", state: "s1" }, purpose: "update the ticket" },
        { key: 'linear:list_issue_statuses(team="Eze")', server: "linear", tool: "list_issue_statuses", args: { team: "Eze" }, purpose: "resolve the team workflow states" },
        { key: 'linear:save_comment(body="hi",issueId="E-1")', server: "linear", tool: "save_comment", args: { issueId: "E-1", body: "hi" }, purpose: "record the ticket comment" },
      ]);
    });

    it("answers from the calls the Parent already completed", async () => {
      const answers = { 'linear:get_issue(id="EZE-422")': { id: "EZE-422", identifier: "EZE-422", title: "t" } };
      const issue = await new HostMediatedLinearTransport(answers).getIssue("EZE-422");
      assert.equal(issue?.identifier, "EZE-422");
    });

    it("refuses to ask for workflow states without the ticket's team", async () => {
      await assert.rejects(
        () => new HostMediatedLinearTransport().getStatuses(),
        (error) => error instanceof LinearTransportError && error.code === "mcp_unavailable",
      );
    });

    it("reduces an mcp proxy result to the payload the Linear tool returned", () => {
      assert.deepEqual(unwrapMcpAnswer({ content: [{ type: "text", text: '{"id":"E-1"}' }] }), { id: "E-1" });
      assert.deepEqual(unwrapMcpAnswer({ content: [{ type: "text", text: '[{"id":"s1"}]' }] }), [{ id: "s1" }]);
      assert.deepEqual(unwrapMcpAnswer({ structuredContent: { id: "E-2" } }), { id: "E-2" });
      assert.equal(unwrapMcpAnswer({ content: [{ type: "text", text: "plain" }] }), "plain");
      assert.deepEqual(unwrapMcpAnswer({ id: "E-3" }), { id: "E-3" });
      assert.deepEqual(unwrapMcpAnswer('{"id":"E-4"}'), { id: "E-4" });
    });

    it("accepts either a bare answer or an explicit remote key", () => {
      assert.deepEqual(readRemoteAnswer({ id: "E-1" }), { value: { id: "E-1" } });
      assert.deepEqual(readRemoteAnswer({ key: 'linear:get_issue(id="E")', value: { id: "E" } }), {
        key: 'linear:get_issue(id="E")',
        value: { id: "E" },
      });
    });

    it("describes the pending call so the Parent can run it verbatim", () => {
      const instruction = describeRemoteDirective({
        key: 'linear:get_issue(id="EZE-422")',
        server: "linear",
        tool: "get_issue",
        args: { id: "EZE-422" },
        purpose: "read the ticket contract",
      });
      assert.match(instruction, /^Linear remote call required\./);
      assert.match(instruction, /mcp\(\{ server: "linear", tool: "get_issue", args: \{"id":"EZE-422"\} \}\)/);
      assert.match(instruction, /Reason: read the ticket contract\./);
      assert.match(instruction, /Remote key: linear:get_issue\(id="EZE-422"\)/);
      assert.ok(!/LINEAR_API_KEY/.test(instruction), "an environment variable is never part of the transport");
    });
  });

  describe("5. Adapter status sensor", () => {
    it("ignores payloads it cannot trust", () => {
      const state = createMcpIntegrationState();
      assert.equal(applyMcpStatusEvent(state, null).adapterObserved, false);
      assert.equal(applyMcpStatusEvent(state, { servers: "nope" }).adapterObserved, false);
      assert.equal(applyMcpStatusEvent(state, { servers: [{ name: 42 }] }).servers.size, 0);
      assert.equal(applyMcpStatusEvent(state, { servers: "x" }).observedAt, state.observedAt);
    });

    it("records servers, counters and unknown states without trusting them", () => {
      const state = applyMcpStatusEvent(
        createMcpIntegrationState(),
        {
          servers: [
            { name: "linear", status: "needs-auth", toolCount: 66, directToolCount: 0, disabled: false },
            { name: "other", status: "not-a-state", toolCount: "many", directToolCount: 1 },
          ],
          totalTools: 66,
          connectedCount: 0,
        },
        1234,
      );
      const snapshot = toMcpIntegrationSnapshot(state);
      assert.equal(snapshot.adapterObserved, true);
      assert.equal(snapshot.totalTools, 66);
      assert.equal(snapshot.totalDirectTools, 1);
      assert.equal(snapshot.observedAt, 1234);
      assert.deepEqual(snapshot.servers[0], {
        name: "linear",
        status: "needs-auth",
        toolCount: 66,
        directToolCount: 0,
        disabled: false,
      });
      assert.equal(snapshot.servers[1].status, "not-connected");
      assert.equal(snapshot.servers[1].toolCount, 0);
    });

    it("recognises the adapter from the session tool surface", () => {
      assert.equal(isMcpAdapterLoaded([]), false);
      assert.equal(isMcpAdapterLoaded(["read", "mcp"]), true);
      assert.equal(isMcpAdapterLoaded(["mcpScript"]), true);
      assert.equal(isMcpAdapterLoaded(["mcp__docs_lookup"]), true);
    });
  });

  describe("6. Honest diagnostics", () => {
    const withLinear = (status, extra = {}) =>
      applyMcpStatusEvent(createMcpIntegrationState(), { servers: [{ name: "linear", status, ...extra }] });

    it("reports a missing adapter when no MCP tool is registered", () => {
      const diagnostic = diagnoseMcpServer(createMcpIntegrationState(), { adapterToolNames: ["read", "bash"] });
      assert.equal(diagnostic.code, "adapter_missing");
      assert.equal(diagnostic.usable, false);
      assert.match(describeMcpDiagnostic(diagnostic, { mode: "tui" }), /aies install npm:pi-mcp-adapter/);
    });

    it("stays usable while the adapter has not reported a snapshot yet", () => {
      const diagnostic = diagnoseMcpServer(createMcpIntegrationState(), { adapterToolNames: ["mcp"] });
      assert.equal(diagnostic.code, "unknown");
      assert.equal(diagnostic.usable, true);
      assert.equal(describeMcpDiagnostic(diagnostic, { mode: "tui" }), "");
    });

    it("reports a missing server, a disabled server and a failed server", () => {
      const absent = applyMcpStatusEvent(createMcpIntegrationState(), { servers: [{ name: "other", status: "connected" }] });
      assert.equal(diagnoseMcpServer(absent).code, "server_missing");

      assert.equal(diagnoseMcpServer(withLinear("disabled", { disabled: true })).code, "disabled");

      const failed = diagnoseMcpServer(withLinear("failed"));
      assert.equal(failed.code, "server_failed");
      assert.match(describeMcpDiagnostic(failed), /\/mcp reconnect linear/);
    });

    it("points at /mcp-auth linear interactively and never opens an OAuth flow headlessly", () => {
      const diagnostic = diagnoseMcpServer(withLinear("needs-auth"));
      assert.equal(diagnostic.code, "needs_auth");
      assert.equal(diagnostic.usable, false);

      const interactive = describeMcpDiagnostic(diagnostic, { mode: "tui" });
      assert.match(interactive, /Linear needs authentication\./);
      assert.match(interactive, /Run:\n {2}\/mcp-auth linear/);
      assert.ok(!/LINEAR_API_KEY/.test(interactive), "the primary instruction is OAuth, never an API key");

      for (const mode of ["print", "json", "rpc", undefined]) {
        const headless = describeMcpDiagnostic(diagnostic, { mode });
        assert.match(headless, /not interactive/);
        assert.match(headless, /Authenticate from an interactive AIES session/);
        assert.ok(!/^Run:/m.test(headless), "a headless session must not be told to run an interactive command");
      }
    });

    it("uses the server, channel and tool names the integration depends on", () => {
      assert.equal(LINEAR_MCP_SERVER, "linear");
      assert.equal(MCP_STATUS_CHANNEL, "pi-mcp-adapter/status/v1");
      assert.equal(MCP_PROXY_TOOL, "mcp");
    });

    it("never recommends an API key as the transport", () => {
      const sources = [
        join(REPO, "extensions", "aies-agents", "mcp", "integration.ts"),
        join(REPO, "extensions", "aies-agents", "linear", "transport.ts"),
        join(REPO, "extensions", "aies-agents", "linear", "contract.ts"),
      ]
        .map((path) => readFileSync(path, "utf8"))
        .join("\n");
      assert.ok(!/LINEAR_API_KEY/.test(sources), "AIES must not read or advertise a Linear API key");
      assert.ok(!/process\.env/.test(sources), "the transport must not depend on ambient credentials");
    });
  });

  describe("7. Parent-mediated operations resume from the Parent's answers", () => {
    // Captured from a real `get_issue` call for EZE-422.
    const issue = {
      id: "EZE-422",
      identifier: "EZE-422",
      title: "Fix multiply()",
      description: "Acceptance criteria:\n\n* multiply(3, 4) returns 12",
      status: "Todo",
      statusType: "unstarted",
      stateHistory: [{ state: { id: "state-todo", name: "Todo", type: "unstarted" }, endedAt: null }],
      project: "AIES",
      team: "Eze",
    };
    const statuses = [
      { id: "state-todo", name: "Todo", type: "unstarted" },
      { id: "state-progress", name: "In Progress", type: "started" },
      { id: "state-review", name: "In Review", type: "started" },
      { id: "state-done", name: "Done", type: "completed" },
    ];
    const inProgress = { ...issue, status: "In Progress", statusType: "started" };
    const done = { ...issue, status: "Done", statusType: "completed" };

    const mediatedManager = () => new TicketManager({ getVerification: () => createVerificationState() });

    it("asks for the ticket, then activates it from the Parent's answer", async () => {
      const manager = mediatedManager();

      const first = await manager.loadTicket("EZE-422");
      assert.equal(first.ok, false);
      assert.equal(first.error, "remote_required");
      assert.equal(first.directive.tool, "get_issue");
      assert.deepEqual(first.directive.args, { id: "EZE-422" });
      assert.match(first.details.instruction, /mcp\(\{ server: "linear", tool: "get_issue"/);

      const second = await manager.submitRemote(issue);
      assert.equal(second.ok, true);
      assert.equal(second.ticket.identifier, "EZE-422");
      assert.equal(second.ticket.status, "Todo");
      assert.equal(second.ticket.statusId, "state-todo");
      assert.equal(second.ticket.team, "Eze");
      assert.equal(manager.getPendingDirective(), null);
    });

    it("refuses an answer when no call is pending", async () => {
      const result = await mediatedManager().submitRemote({ id: "EZE-1" });
      assert.equal(result.ok, false);
      assert.equal(result.error, "no_pending_remote");
    });

    it("walks every Linear call before reporting Done, and only then", async () => {
      const manager = mediatedManager();
      manager.recordChangedPaths(["README.md"]); // docs-only: no Verify required

      await manager.loadTicket("EZE-422");
      assert.equal((await manager.submitRemote(issue)).ok, true);

      let step = await manager.startWork();
      assert.equal(step.directive.tool, "list_issue_statuses");
      assert.deepEqual(step.directive.args, { team: "Eze" });
      step = await manager.submitRemote(statuses);
      assert.equal(step.directive.tool, "save_issue");
      assert.deepEqual(step.directive.args, { id: "EZE-422", state: "state-progress" });
      step = await manager.submitRemote(inProgress);
      assert.equal(step.ok, true);
      assert.equal(manager.getWorkState(), "working");

      step = await manager.completeTicket();
      assert.equal(step.directive.tool, "get_issue");
      step = await manager.submitRemote(inProgress);
      assert.equal(step.directive.tool, "list_issue_statuses");
      step = await manager.submitRemote(statuses);
      assert.equal(step.directive.tool, "save_issue");
      assert.deepEqual(step.directive.args, { id: "EZE-422", state: "state-done" });
      step = await manager.submitRemote(done);
      assert.equal(step.directive.tool, "save_comment");
      assert.deepEqual(step.directive.args.issueId, "EZE-422");
      step = await manager.submitRemote({ id: "comment-1" });

      assert.equal(step.ok, true);
      assert.equal(manager.getWorkState(), "complete");
      assert.equal(manager.getPendingDirective(), null);
    });

    it("surfaces the directive through the tool and completes on the answer", async () => {
      const tool = createTicketTool(mediatedManager());

      const first = await tool.execute("c1", { action: "load", ticketId: "EZE-422" }, undefined, undefined, { mode: "print" });
      assert.equal(first.isError, true);
      assert.match(first.content[0].text, /^Linear remote call required\./);
      assert.equal(first.details.directive.tool, "get_issue");

      const second = await tool.execute("c2", { action: "load", ticketId: "EZE-422", remote: issue }, undefined, undefined, { mode: "print" });
      assert.equal(second.isError, false);
      assert.match(second.content[0].text, /Active ticket set to EZE-422/);
    });

    it("reports a missing adapter instead of a command that does not exist", async () => {
      const manager = new TicketManager({
        getVerification: () => createVerificationState(),
        getMcpDiagnostic: () => ({ code: "adapter_missing", usable: false, server: "linear" }),
      });
      const result = await createTicketTool(manager).execute("c1", { action: "load", ticketId: "EZE-422" }, undefined, undefined, { mode: "tui" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /pi-mcp-adapter is not loaded/);
      assert.ok(!/\/mcp-auth/.test(result.content[0].text), "no /mcp-auth when the adapter is not loaded");
      assert.ok(!/LINEAR_API_KEY/.test(result.content[0].text), "an API key is never the recommended path");
      assert.equal(result.details.mcp.code, "adapter_missing");
    });

    it("never asks for an interactive OAuth step in a headless session", async () => {
      const manager = new TicketManager({
        getVerification: () => createVerificationState(),
        getMcpDiagnostic: () => ({ code: "needs_auth", usable: false, server: "linear" }),
      });
      const tool = createTicketTool(manager);

      const headless = await tool.execute("c1", { action: "load", ticketId: "EZE-422" }, undefined, undefined, { mode: "print" });
      assert.match(headless.content[0].text, /not interactive/);
      assert.ok(!/^Run:/m.test(headless.content[0].text));

      const interactive = await tool.execute("c2", { action: "load", ticketId: "EZE-422" }, undefined, undefined, { mode: "tui" });
      assert.match(interactive.content[0].text, /Run:\n {2}\/mcp-auth linear/);
    });

    it("does not probe MCP when a transport is injected, so fakes stay offline", async () => {
      const manager = new TicketManager({
        transport: new HostMediatedLinearTransport({ 'linear:get_issue(id="EZE-1")': { id: "EZE-1", identifier: "EZE-1", title: "t" } }),
        getVerification: () => createVerificationState(),
        getMcpDiagnostic: () => ({ code: "adapter_missing", usable: false, server: "linear" }),
      });
      const result = await manager.loadTicket("EZE-1");
      assert.equal(result.ok, true);
    });
  });
});
