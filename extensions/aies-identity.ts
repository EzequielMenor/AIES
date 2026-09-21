/**
 * AIES identity extension.
 *
 * Its job is to make the active profile visible and to give the Parent session
 * its one resident, short Spanish/quietness rule. AIES serves this extension from
 * the isolated Pi profile, so when it is loaded, AIES is loaded and the ambient
 * Pi profile is not. It registers no tools and changes no runtime behaviour.
 *
 * Child sessions are created with `noExtensions: true`, so they never load this
 * extension and never receive the Parent rule: their prompts stay technical.
 */

import { CONFIG_DIR_NAME, VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = fileURLToPath(import.meta.url);

/**
 * The single resident Parent instruction: answer in Spanish, keep technical
 * identifiers in their original language, do not narrate steps the UI already
 * shows, and do not append a second completion report after AIES has already
 * rendered DONE/BLOCKED. Appended once per agent start, never duplicated.
 */
export const RESIDENT_SYSTEM_RULE = [
  "Responde siempre al usuario en castellano.",
  "Mantén comandos, código, nombres técnicos e identificadores en su idioma original.",
  "No narres pasos internos si la UI ya los representa.",
  "No repitas ni resumas el trabajo que AIES ya mostró como DONE o BLOCKED.",
  "Responde solo las preguntas reales del usuario y señala decisiones o errores que necesiten su intervención.",
].join("\n");

/** First line of the rule, used to detect an already-amended prompt. */
const RULE_MARKER = "Responde siempre al usuario en castellano.";

function report(cwd: string, mode: string): string {
  const row = (label: string, value: string) => `  ${label.padEnd(22)}${value}`;

  return [
    `AIES · perfil (pi ${VERSION})`,
    row("extensión", EXTENSION_PATH),
    row("directorio del agente", getAgentDir()),
    row("directorio de config", CONFIG_DIR_NAME),
    row("cwd", cwd),
    row("modo", mode),
  ].join("\n");
}

export default function aiesIdentity(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const systemPrompt = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
    if (systemPrompt.includes(RULE_MARKER)) return { systemPrompt };
    return { systemPrompt: `${systemPrompt}\n\n${RESIDENT_SYSTEM_RULE}` };
  });

  pi.registerCommand("aies-info", {
    description: "Show the resolved AIES profile paths",
    handler: async (_args, ctx) => {
      ctx.ui.notify(report(ctx.cwd, ctx.mode), "info");
    },
  });
}
