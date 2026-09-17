/**
 * AIES identity extension.
 *
 * Its only job is to make the active profile visible. AIES serves this
 * extension from the isolated Pi profile, so when it is loaded, AIES is loaded
 * and the ambient Pi profile is not. It registers no tools and changes no
 * behavior.
 */

import { CONFIG_DIR_NAME, VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(import.meta.url);

function report(cwd: string, mode: string): string {
  const row = (label: string, value: string) => `  ${label.padEnd(16)}${value}`;

  return [
    `AIES profile (pi ${VERSION})`,
    row("extension", EXTENSION_PATH),
    row("agent dir", getAgentDir()),
    row("config dir name", CONFIG_DIR_NAME),
    row("cwd", cwd),
    row("mode", mode),
  ].join("\n");
}

export default function aiesIdentity(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // The footer line belongs to the runtime observer (`aies-runtime`), which
    // starts with the same `AIES` prefix and has real numbers to show. This
    // extension reports the profile once, at start, and nothing else.
    ctx.ui.notify(`AIES profile: ${getAgentDir()}`, "info");
  });

  pi.registerCommand("aies-info", {
    description: "Show the resolved AIES profile paths",
    handler: async (_args, ctx) => {
      ctx.ui.notify(report(ctx.cwd, ctx.mode), "info");
    },
  });
}
