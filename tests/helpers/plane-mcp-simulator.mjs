/**
 * Offline stand-in for the Parent's `mcp` proxy call to the Plane server (D33).
 *
 * It answers each `remote_required` directive the way the adapter does: a JSON
 * text part inside `content`, which `unwrapMcpAnswer` must reduce to the payload.
 * No socket, no OAuth, no credential: the store lives in memory and is per test.
 */

import { PLANE_PROJECT, PLANE_STATES, planeWorkItem } from "./plane-fixtures.mjs";

function envelope(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function createPlaneMcpSimulator(workItems = [planeWorkItem()]) {
  const byUuid = new Map(workItems.map((item) => [item.id, structuredClone(item)]));
  const comments = [];
  const calls = [];

  function findByIdentifier(identifier) {
    return [...byUuid.values()].find((item) => `${item.project.identifier}-${item.sequence_id}` === identifier);
  }

  return {
    calls,
    comments,
    workItem(uuid) {
      return structuredClone(byUuid.get(uuid));
    },
    /** Move a work item from outside AIES, as another person would in Plane. */
    moveExternally(identifier, stateName) {
      const item = findByIdentifier(identifier);
      const state = PLANE_STATES.find((candidate) => candidate.name === stateName);
      item.state = { ...state };
    },
    answer(directive) {
      calls.push({ server: directive.server, tool: directive.tool, args: structuredClone(directive.args) });
      if (directive.server !== "plane") throw new Error(`unexpected MCP server ${directive.server}`);
      const { action } = directive.args;

      if (directive.tool === "workitem" && action === "retrieve_by_identifier") {
        const item = findByIdentifier(directive.args.workitem_identifier);
        if (!item) throw new Error(`work item ${directive.args.workitem_identifier} not found`);
        return envelope(structuredClone(item));
      }
      if (directive.tool === "workitem" && action === "update") {
        const item = byUuid.get(directive.args.workitem_id);
        const state = PLANE_STATES.find((candidate) => candidate.id === directive.args.state);
        if (!item || !state) throw new Error("update refers to an unknown work item or state");
        if (item.project.id !== directive.args.project_id) throw new Error("update carries the wrong project");
        item.state = { ...state };
        return envelope(structuredClone(item));
      }
      if (directive.tool === "state" && action === "list") {
        if (directive.args.project_id !== PLANE_PROJECT.id) throw new Error("state list for an unknown project");
        return envelope({
          results: PLANE_STATES.map((state, index) => ({ ...state, project: PLANE_PROJECT.id, sequence: (index + 1) * 10000 })),
        });
      }
      if (directive.tool === "workitem_comment" && action === "create") {
        const comment = {
          id: `comment-${comments.length + 1}`,
          workitem_id: directive.args.workitem_id,
          comment_html: directive.args.comment_html,
        };
        comments.push(comment);
        return envelope(comment);
      }
      throw new Error(`simulator does not model ${directive.tool} ${action}`);
    },
  };
}
