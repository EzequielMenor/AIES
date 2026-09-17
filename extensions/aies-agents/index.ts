/**
 * AIES agents extension (AIES-003).
 *
 * Registers the `aies_delegate` tool with the parent Pi session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createDelegateTool } from "./delegate.ts";

export default function aiesAgents(pi: ExtensionAPI): void {
  pi.registerTool(createDelegateTool());
}
