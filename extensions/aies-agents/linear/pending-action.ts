/**
 * EZE-503: the explicit pending final action.
 *
 * A Verify PASS proves the work unit against its own criteria; it says nothing
 * about whether the user wanted the ticket closed. In the EZE-492 and EZE-493
 * sessions the Parent read a PASS as an unconditional "complete" signal and moved
 * Linear to Done while the user had just said "no commit todavía" and the working
 * tree was still uncommitted. The rule that was missing lives here: an explicit
 * user request to keep the last step outranks the PASS.
 *
 * Pure and deliberately narrow. Nothing is inferred from the repository (no
 * "uncommitted changes therefore hold"), so a commit is never universally
 * required and a session where the user never asked to hold anything completes
 * exactly as before. A hold exists only while the user's own words asked for one.
 */

import type { LinearRemoteDirective, TrackerId } from "./types.ts";
import { type McpTrust, NON_MCP_TOOL_NAMES } from "../mcp/trust.ts";

/** Which final step the user kept for themselves. */
export type PendingActionKind = "review" | "commit" | "completion";

export interface PendingFinalAction {
  kind: PendingActionKind;
  /** The user's own words, clipped: quoted back by the refusal that holds them. */
  quote: string;
}

/** What one submitted user input says about the final step of the work unit. */
export type FinalActionDirective =
  | { kind: "hold"; pending: PendingFinalAction }
  | { kind: "release" };

/** One short label per held step; the refusal always names the user's request. */
const PENDING_ACTION_LABEL: Record<PendingActionKind, string> = {
  review: "the user asked to review it first",
  commit: "the user asked to hold the commit",
  completion: "the user asked not to close the ticket yet",
};

/** Longest slice of user text kept as evidence of the request. */
const MAX_QUOTE_CHARS = 88;

/**
 * Explicit holds on finalization. Each rule needs the held step AND a hold
 * marker inside one clause, so an ordinary mention of "commit" or "review" never
 * blocks a completion. Spanish and English are covered because the user speaks
 * Spanish and the tickets are written in English.
 */
const HOLD_RULES: ReadonlyArray<{ kind: PendingActionKind; pattern: RegExp }> = [
  // "no commit todavía", "no hagas commit", "sin commitear", "don't commit yet".
  {
    kind: "commit",
    pattern:
      /\b(?:no|don'?t|do\s+not|cannot|can'?t|won'?t|never|sin|not)\b[^?]{0,28}\b(?:commit\w*|commite\w*|comite\w*|pushear\w*|push\w*|merge\w*)\b/iu,
  },
  // The same hold with the verb first: "commit todavía no", "el commit lo dejamos".
  {
    kind: "commit",
    pattern:
      /\b(?:commit\w*|push\w*|merge\w*)\b[^?]{0,28}\b(?:todav[íi]a\s+no|a[uú]n\s+no|not\s+yet|lo\s+dejamos|queda\s+pendiente|lo\s+dejo)\b/iu,
  },
  // "déjalo pendiente de review", "queda pendiente de revisión", "pending my review".
  {
    kind: "review",
    pattern:
      /\b(?:d[ée]jalo|dejelo|dejad|pendiente|pendient\w*|pending|queda|quedan|quedar[áa]|leave\s+it|keep\s+it)\b[^?]{0,28}\b(?:review|revisi[óo]n|revisar|approv\w*|sign[ -]?off)\b/iu,
  },
  // "quiero revisarlo antes", "prefiero ver el diff", "let me review it", "espero tu revisión".
  {
    kind: "review",
    pattern:
      /\b(?:quiero|qued[ée]me|prefiero|necesito|debo|tengo\s+que|voy\s+a|me\s+gustar[íi]a|let\s+me|i\s+(?:want|need|will)|espero|espere)\b[^?]{0,28}\b(?:revis\w*|review\w*|ver\s+el\s+diff|mirar\s+el\s+diff|ver\s+primero|verlo|verla|chequear|check\s+it|aprue\w*|aprobar)\b/iu,
  },
  // The reviewer is the user: "lo reviso yo", "primero lo veo yo", "by myself".
  {
    kind: "review",
    pattern: /\b(?:lo\s+reviso\s+yo|reviso\s+yo|yo\s+lo\s+reviso|primero\s+lo\s+(?:veo|reviso)|by\s+myself|myself|my\s+review)\b/iu,
  },
  // "detente para revisión", "stop for review", "wait until I say so".
  {
    kind: "review",
    pattern:
      /\b(?:det[ée]n(?:te|ense|se)?|stop|halt|paus\w*|wait|espera|esper[ae]|qu[ée]date)\b[^?]{0,32}\b(?:revisi[óo]n|review|revisar|para\s+que\s+(?:yo\s+)?(?:lo\s+)?(?:vea|revise)|apruebe|aprobaci[óo]n|humano|human|my\s+go|mi\s+se[ñn]al)\b/iu,
  },
  // "no lo marques Done todavía", "don't close the ticket", "no completes el ticket".
  {
    kind: "completion",
    pattern:
      /\b(?:no|don'?t|do\s+not|not|never|sin)\b[^?]{0,24}\b(?:marques|marque|mark\w*|move\w*|set|pongas|pon|cierres|cierre|cerrar|close|completes|complete|completar|finalices|finalice|finalizar)\b[^?]{0,24}\b(?:done|completed|hecho|cerrad\w*|ticket|issue|card|completad\w*|listo)\b/iu,
  },
  // The bare negated closing verb is still explicit: "no lo cierres", "don't close it".
  {
    kind: "completion",
    pattern: /\b(?:no|don'?t|do\s+not)\s+(?:lo\s+|it\s+)?(?:cierres|cierre|closed?|completes|complete|finalices|marques\s+(?:como\s+)?done)\b/iu,
  },
];

/**
 * Explicit authorisations that lift a hold ("ya lo revisé, podés commitear").
 * Only finalisation wording releases; a bare "dale" or "seguí" keeps the hold, so
 * an impatient continuation turn cannot close over a pending review.
 */
const RELEASE_RULES: ReadonlyArray<RegExp> = [
  /\b(?:ya\s+(?:pod[ée]s|puedes|podes|est[áa]\s+listo|lo\s+revis[ée]|lo\s+vi)|pod[ée]s\s+(?:commit\w*|push\w*|merge\w*|cerrar|completar|marcar)|puedes\s+(?:commit\w*|push\w*|merge\w*|cerrar|completar))\b/iu,
  /\b(?:commit\w*\s+(?:y|and)\s+push\w*|you\s+can\s+(?:commit|merge|close|mark)|go\s+ahead\s+and\s+(?:commit|merge|close)|now\s+(?:commit|merge|close)\s+it|approved|lgtm)\b/iu,
  /\b(?:ya\s+est[áa]\s+aprobado|aprobado\s+por\s+m[íi]|revisado\s+por\s+m[íi]|lo\s+apruebo)\b/iu,
  // The user naming the final step themselves: "cerralo", "commitealo", "mark it done".
  /\b(?:cerr[áa]lo|cerralo|cerrarlo|complet[áa]lo|completalo|completarlo|complete\s+the\s+ticket|mark(?:ed)?\s+it\s+(?:as\s+)?done|commite[áa]|comite[áa]|commitelo|commitealo|pushe[áa]|pushelo)\b/iu,
];

/** Collapse whitespace and clip to the evidence budget. */
function clipQuote(clause: string): string {
  const flat = clause.trim().replace(/\s+/gu, " ");
  return flat.length > MAX_QUOTE_CHARS ? `${flat.slice(0, MAX_QUOTE_CHARS - 1)}…` : flat;
}

/**
 * Wording that describes repository state instead of instructing the session
 * ("no hay commits nuevos", "there are no commits"). Such a clause never creates
 * a hold: it reports, it does not ask for anything.
 */
const DESCRIPTIVE_SHAPE =
  /\b(?:no\s+hay\b(?!\s+que\b)|no\s+hubo\b|there\s+(?:are|is|was|were)\b|doesn'?t\s+(?:have|exist)\b|commits?\s+nuev\w*|nuev\w*\s+commits?)\b/iu;

/**
 * One sentence-ish chunk of user text, terminator kept so questions stay readable.
 * A dot only ends a chunk when whitespace or the end of the input follows, so a
 * path or an abbreviation (`tool.ts`) never cuts the evidence in half.
 */
const SENTENCE_CHUNK = /[\s\S]+?(?:(?:[.!?;](?=\s|$))|\n|$)/gu;

/**
 * Clause-sized slices of one user input. A clause that asks something is not an
 * instruction ("¿puedo commitear?" is a question, not an authorisation) and a
 * clause that only reports state never holds anything, so both are dropped before
 * the rules run. Colons are kept inside the clause: ticket-style text such as
 * "Nota: no commitear todavía" must still be read as one instruction.
 */
function instructionClauses(text: string): string[] {
  return (text.match(SENTENCE_CHUNK) ?? [])
    .map((chunk) => chunk.trim())
    .filter(
      (chunk) =>
        chunk.length > 0 && !chunk.endsWith("?") && !chunk.startsWith("¿") && !DESCRIPTIVE_SHAPE.test(chunk),
    );
}

/**
 * Read what one submitted user input says about the final step.
 *
 * The last decisive clause wins, which is what makes an explicit confirmation
 * ("ya lo revisé, podés commitear") lift an earlier hold inside the same message.
 * `null` means the input says nothing about finalization: the caller must leave
 * the current state untouched, since a Verify PASS or a plain "continue" is not a
 * user authorisation to close.
 */
export function readFinalActionDirective(text: string): FinalActionDirective | null {
  if (!text || !text.trim()) return null;

  let decided: FinalActionDirective | null = null;
  for (const clause of instructionClauses(text)) {
    const held = HOLD_RULES.find((rule) => rule.pattern.test(clause));
    // A hold outranks a release in the same clause: it is the safer reading.
    if (held) {
      decided = { kind: "hold", pending: { kind: held.kind, quote: clipQuote(clause) } };
      continue;
    }
    if (RELEASE_RULES.some((pattern) => pattern.test(clause))) decided = { kind: "release" };
  }
  return decided;
}

/** The refusal wording: what is held, in the user's own words. */
export function describePendingFinalAction(pending: PendingFinalAction): string {
  return `${PENDING_ACTION_LABEL[pending.kind] ?? "the user kept the final step"} ("${pending.quote}")`;
}

/** Linear state names that close a ticket: same vocabulary as `resolveTargetStatus`. */
const COMPLETED_STATE_NAME = /^(?:done|completed|closed|terminad[oa]|finalizad[oa]|listo|hecho|cerrad[ao])$/iu;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function nameOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["name", "type", "statusType", "state"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Whether a raw `mcp` call moves the active ticket itself into Linear's completed
 * state. This is the bypass the EZE-492 session used (`save_issue` with
 * `state: "Done"` straight through the proxy tool), so it is recognised by the
 * ticket it targets and by a completion *name*: an opaque status id is not
 * guessable and is never blocked here.
 */
export function isDirectLinearCompletion(
  toolName: string,
  input: Record<string, unknown> | undefined,
  activeTicket: { identifier: string; id?: string },
): boolean {
  if (toolName !== "mcp") return false;
  const server = typeof input?.server === "string" ? input.server.trim().toLowerCase() : "";
  if (server && server !== "linear") return false;
  const tool = typeof input?.tool === "string" ? input.tool.trim().toLowerCase() : "";
  if (tool !== "save_issue" && tool !== "saveissue") return false;

  const args = asRecord(input?.args);
  if (!args) return false;

  const targets = [args.id, args.identifier, args.issueId].map(nameOf).filter((v): v is string => Boolean(v));
  const wanted = [activeTicket.identifier, activeTicket.id].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase());
  if (!targets.some((target) => wanted.includes(target.toLowerCase()))) return false;

  const state = nameOf(args.state ?? args.status ?? args.statusId ?? args.stateId);
  return Boolean(state && COMPLETED_STATE_NAME.test(state));
}

/**
 * The Spanish block reason for a direct Done that outranks a pending user request
 * (D18: fail fast in the user's language, state what was NOT done, and name the
 * honest next step).
 */
export function linearCompletionBypassReason(
  toolName: string,
  input: Record<string, unknown> | undefined,
  activeTicket: { identifier: string; id?: string; title?: string },
  pending: PendingFinalAction,
): string | null {
  if (!isDirectLinearCompletion(toolName, input, activeTicket)) return null;
  return [
    `Bloqueado: no se cierra ${activeTicket.identifier} en Linear; ${describePendingFinalAction(pending)}.`,
    "No se envió ningún cambio de estado y el ticket sigue abierto; la evidencia de Verify queda intacta.",
    "Dejalo así, informá al usuario y esperá su confirmación: cuando autorice el paso pendiente, cerrá con aies_ticket action \"complete\".",
  ].join("\n");
}

/** The Plane MCP server name of the directive, and the tool whose `update` action carries a workflow state (D33). */
const PLANE_SERVER = "plane";
const PLANE_WORKITEM_TOOL = "workitem";

/** `true` only for a trusted profile: anything else (including a missing value) refuses. */
function isTrusted(trust: McpTrust | undefined): boolean {
  return trust?.trusted === true;
}

/** The `args` of an `mcp` call as an object. An encoded JSON string is decoded so it cannot hide a state. */
function mcpArgsRecord(input: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const raw = input?.args;
  if (typeof raw !== "string") return asRecord(raw);
  if (repeatsAKey(raw)) return undefined;
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * True when an encoded args object names one key twice, after decoding its escapes
 * (`"state"` and `"state"` are the same key). `JSON.parse` keeps only the last
 * copy, while the adapter may keep another, so the guard cannot know which state the
 * call writes and treats the arguments as unreadable.
 */
function repeatsAKey(raw: string): boolean {
  const seen = new Set<string>();
  for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/gu)) {
    let key: string;
    try {
      key = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return true;
    }
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Whether a raw call writes a Plane work item's workflow state: the `workitem` tool with
 * `action: update` and a `state` (D33 item 8, amends D32). Plane takes the state as a UUID on
 * writes, so a completion cannot be recognised by name. The rule therefore refuses every state
 * move while a hold stands, and reads, comments and updates without `state` stay as the write
 * guard decides. A Plane tool the guard does not know may also be a state move, so it is held too.
 * An untrusted profile is refused by the write guard, so there is nothing to read here.
 */
export function isDirectPlaneStateWrite(
  toolName: string,
  input: Record<string, unknown> | undefined,
  trust: McpTrust,
): boolean {
  if (!isTrusted(trust)) return false;
  const reading = planeReading(toolName, input, trust);
  if (reading?.kind !== "tool") return false;
  if (!PLANE_TOOLS.has(reading.tool)) return true;
  return (
    reading.tool === PLANE_WORKITEM_TOOL &&
    reading.args !== undefined &&
    normalizeToken(reading.args.action) === "update" &&
    carriesStateKey(reading.args)
  );
}

/** The Spanish refusal for a Plane state write that outranks a pending user request. */
function planeStateBypassReason(pending: PendingFinalAction): string {
  return [
    `Bloqueado: no se cambia el estado de un workitem en Plane; ${describePendingFinalAction(pending)}.`,
    "No se envió ningún cambio de estado y el ticket sigue abierto; la evidencia de Verify queda intacta.",
    "Dejalo así, informá al usuario y esperá su confirmación: cuando autorice el paso pendiente, cerrá con aies_ticket action \"complete\".",
  ].join("\n");
}

/** Trackers whose completion a hold guards. While a hold stands, both stay covered. */
const HOLD_GUARDED_TRACKERS: ReadonlyArray<TrackerId> = ["linear", "plane"];

/**
 * The refusal for one tracker's direct completion write, or null. Linear is checked
 * against the active ticket exactly as before. Plane is checked by its state write,
 * because a Plane state is a UUID and a ticket needs no active match for it.
 */
export function trackerCompletionBypassReason(
  tracker: TrackerId,
  toolName: string,
  input: Record<string, unknown> | undefined,
  activeTicket: { identifier: string; id?: string; title?: string } | null,
  pending: PendingFinalAction,
  trust: McpTrust,
): string | null {
  if (tracker === "plane") {
    return isDirectPlaneStateWrite(toolName, input, trust) ? planeStateBypassReason(pending) : null;
  }
  if (!activeTicket) return null;
  return linearCompletionBypassReason(toolName, input, activeTicket, pending);
}

/**
 * The hold guard used by the `tool_call` hook: every guarded tracker is checked, so a
 * hold stands against Linear and Plane alike, whichever tracker the profile selects.
 */
export function holdBypassReason(
  toolName: string,
  input: Record<string, unknown> | undefined,
  activeTicket: { identifier: string; id?: string; title?: string } | null,
  pending: PendingFinalAction,
  trust: McpTrust,
): string | null {
  for (const tracker of HOLD_GUARDED_TRACKERS) {
    const reason = trackerCompletionBypassReason(tracker, toolName, input, activeTicket, pending, trust);
    if (reason) return reason;
  }
  return null;
}

/*
 * D33 phase 4, part C, reduced by D38: which Plane calls may run.
 *
 * Attribution is exact and comes from the trusted profile (`mcp/trust.ts`). Under a trusted profile
 * a call reaches Plane only as the `mcp` proxy with `server: "plane"` (after trimming), or as the
 * namespace tool `mcp__plane`. Any other name is not Plane: a trusted profile has no direct tools, so
 * no such tool exists in the session. Under an untrusted profile every tool that is not a Pi base
 * tool or an AIES tool is refused before any reading, Linear included.
 *
 * Under a trusted profile the rules are deny by default, against a closed list:
 *
 * - Read actions (`PLANE_READ_ACTIONS`) pass on every Plane tool, and so does `get_pql_reference`.
 * - `workitem update` passes only when it carries a state AND it is exactly the directive `aies_ticket`
 *   has pending, for `start`, or for `complete` with the Done Gate re-evaluated at call time. An update
 *   without a state is refused. A hold is refused earlier by `holdBypassReason`, so it always wins.
 * - `workitem_comment create` passes. Every other write of every other Plane tool, and every unknown
 *   action, is refused, with the Plane UI as the honest next step.
 * - The gateway modes that run no tool stay open (discovery and OAuth), and `install` is refused with
 *   any server.
 * - A `server` the profile does not declare is refused, and so is a `server` that is not text.
 *   `"Plane"` is not `plane`: it is refused, never read as Plane.
 * - A call with no `server` and one of Linear's four workflow tools is Linear, as before.
 */

/** Plane read actions: allowed on every Plane tool. */
const PLANE_READ_ACTIONS: ReadonlySet<string> = new Set([
  "list",
  "list_archived",
  "list_workitems",
  "list_projects",
  "list_options",
  "list_definitions",
  "list_workspace",
  "list_project",
  "retrieve",
  "retrieve_by_identifier",
  "retrieve_option",
  "search",
  "count",
  "get_changelog",
  "get_features",
  "get_value",
  "worklog_summary",
]);

/** The Plane MCP tools the guard knows. Any other tool name is refused whatever its action. */
const PLANE_TOOLS: ReadonlySet<string> = new Set([
  "workitem",
  "state",
  "workitem_comment",
  "project",
  "intake",
  "cycle",
  "module",
  "workitem_relation",
  "release",
  "milestone",
  "workitem_property",
  "workitem_type",
  "template",
  "initiative",
  "collection",
  "customer",
  "customer_property",
  "customer_request",
  "label",
  "member",
  "page",
  "project_estimate",
  "release_label",
  "release_tag",
  "work_log",
  "workitem_activity",
  "workitem_attachment",
  "workitem_link",
  "workspace",
  "get_pql_reference",
]);

/** The Plane reference tool: read-only, with no action to check. */
const PLANE_READ_TOOL = "get_pql_reference";

/** Linear's four workflow tools (`linear/transport.ts`): with no server they are Linear, never Plane. */
const LINEAR_WORKFLOW_TOOLS: ReadonlySet<string> = new Set(["get_issue", "save_issue", "list_issue_statuses", "save_comment"]);

/** The only writes that pass, per tool. `workitem update` is not here on purpose: it passes only as the exact pending state directive. */
const PLANE_ALLOWED_WRITES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["workitem_comment", new Set(["create"])],
]);

/** The adapter's gateway actions that run no tool, matched exactly as the adapter matches them. */
const GATEWAY_READ_ACTIONS: ReadonlySet<string> = new Set(["ui-messages", "auth-start", "auth-complete"]);

/** The inputs the write guard needs from the manager, all read at call time. */
export interface PlaneWriteContext {
  /** The Parent's pending `mcp` call, as `TicketManager.getPendingDirective()` reports it. */
  pending: LinearRemoteDirective | null;
  /** The mediated action that emitted the pending call (`start` or `complete`), if any. */
  pendingAction: string | null;
  /** The Done Gate verdict for completing the active ticket right now. */
  doneGate: () => { allowed: boolean; reason: string };
  /** The trust in the MCP profile for this call (`currentMcpTrust`, `mcp/trust.ts`). Anything but trusted refuses. */
  trust: McpTrust;
}

/** Case- and space-insensitive token, so `" Workitem "` and `"workitem"` are one tool. */
function normalizeToken(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** What one raw call addresses under a trusted profile. */
type PlaneReading =
  | { kind: "tool"; tool: string; args: Record<string, unknown> | undefined }
  | { kind: "gateway"; action: string }
  | { kind: "undeclared" };

/**
 * The reading of one raw call under a trusted profile, or undefined when the call does not reach
 * Plane. Attribution is exact (D38): the `mcp` proxy names its server in `server`, trimmed and
 * compared exactly, and the namespace tool `mcp__plane` is Plane by its exact name. A server the
 * profile does not declare is refused, so a name that might be Plane is never passed.
 */
function planeReading(toolName: string, input: Record<string, unknown> | undefined, trust: McpTrust): PlaneReading | undefined {
  if (toolName === "mcp") return proxyReading(input, trust);
  if (toolName === "mcp__plane") return { kind: "tool", tool: normalizeToken(input?.tool), args: mcpArgsRecord(input) };
  return undefined;
}

/** The `mcp` proxy, in the adapter's own order: `install` first, then the server, then `action`, then `tool`. */
function proxyReading(input: Record<string, unknown> | undefined, trust: McpTrust): PlaneReading | undefined {
  // `install` writes a server definition under any name, so it is refused before any server check.
  if (normalizeToken(input?.action) === "install") return { kind: "gateway", action: "install" };

  const raw = input?.server;
  if (raw !== undefined && raw !== null && typeof raw !== "string") return { kind: "undeclared" };
  const server = typeof raw === "string" ? raw.trim() : "";
  if (server !== "" && server !== PLANE_SERVER) {
    // A declared server other than Plane is not Plane; an undeclared one is refused.
    return trust.servers.has(server) ? undefined : { kind: "undeclared" };
  }

  if (input?.action !== undefined) {
    if (typeof input.action === "string" && GATEWAY_READ_ACTIONS.has(input.action)) return undefined;
    return { kind: "gateway", action: String(input.action) };
  }

  if (!input?.tool) return undefined;
  let tool = normalizeToken(input.tool);
  if (server === "" && LINEAR_WORKFLOW_TOOLS.has(tool)) return undefined;
  // The adapter lists Plane's tools as `plane_<tool>` and resolves that name inside the server it is
  // given, or in all servers when it is given none (only Plane lists a `plane_` name). Only that exact
  // form is read as `<tool>`, and only when the rest is a known Plane tool: any other prefixed name
  // stays unknown and is refused. Without a server a bare Plane tool is read the same way.
  if (tool.startsWith(`${PLANE_SERVER}_`) && PLANE_TOOLS.has(tool.slice(PLANE_SERVER.length + 1))) {
    tool = tool.slice(PLANE_SERVER.length + 1);
  }
  return { kind: "tool", tool, args: mcpArgsRecord(input) };
}

/** The tools a profile the guard does not trust may not run: none, except Pi's and AIES's own. */
function untrustedProfileReason(reason: string): string {
  return planeBlockReason(
    `el perfil MCP de esta sesión no es el que AIES conoce (${reason || "motivo no disponible"}), así que no se ejecuta ninguna herramienta MCP`,
    "Restaurá $AIES_HOME/agent/mcp-adapter.json a los servidores de la plantilla del repo (o ejecutá aies para que el seed lo repare) y reiniciá la sesión.",
  );
}

/** A `server` the trusted profile does not declare. */
function undeclaredServerReason(): string {
  return planeBlockReason(
    "el server indicado no está declarado en el perfil MCP de confianza",
    'Usá el nombre exacto del servidor, "plane" o "linear", tal como están en la plantilla.',
  );
}

/** The refusal shape shared by every Plane block: what was not done, and the honest next step. */
function planeBlockReason(detail: string, next: string): string {
  return [
    `Bloqueado: ${detail}.`,
    "No se envió ningún cambio; el ticket y su estado quedan como estaban.",
    next,
  ].join("\n");
}

function unknownToolReason(tool: string): string {
  return planeBlockReason(
    `la herramienta "${tool || "(sin nombre)"}" de Plane no está en la lista que AIES analizó`,
    "Si hace falta, hacelo desde la UI de Plane.",
  );
}

function gatewayReason(action: string): string {
  if (action === "install") {
    return planeBlockReason(
      "el modo install del proxy mcp cambia la definición de un servidor MCP",
      "No se instala ni se reapunta un servidor desde el agente: configurá los servidores MCP a mano, o con el seed del perfil.",
    );
  }
  return planeBlockReason(
    `el modo "${action}" del proxy mcp no es uno que AIES conozca`,
    "Usá search, describe o connect, o auth-start y auth-complete; si hace falta otra cosa, hacelo desde la UI de Plane.",
  );
}

/** A write that the closed list does not allow: every action that is not a read and not an allowed write. */
function notAllowedActionReason(tool: string, action: string): string {
  return planeBlockReason(
    `${tool} ${action || "(sin action)"} en Plane es una escritura que AIES no ejecuta desde el agente`,
    "Hacelo desde la UI de Plane.",
  );
}

function updateWithoutStateReason(): string {
  return planeBlockReason(
    "workitem update sin state no lo ejecuta AIES: el agente solo escribe el estado pendiente de aies_ticket y los comentarios",
    "Hacelo desde la UI de Plane.",
  );
}

function stateWriteWithoutDirectiveReason(): string {
  return planeBlockReason(
    "el cambio de estado de un workitem en Plane solo lo ejecuta aies_ticket para el ticket activo, con la llamada que aies_ticket pide",
    'Para avanzar usá aies_ticket con action "start", o con action "complete" tras el Verify; no escribas el estado a mano.',
  );
}

function stateWriteGateReason(reason: string): string {
  return planeBlockReason(
    `la llamada coincide con el cambio de estado pendiente del ticket activo, pero el Done Gate ya no la permite (${reason})`,
    'Verificá el cambio con Verify y volvé a intentar con aies_ticket action "complete".',
  );
}

/** Compare two identifiers or UUIDs as the directive names them: trimmed, case-insensitive. */
function sameToken(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Whether a `workitem update` is exactly the state write the pending directive names:
 * same server, tool, action, project, work item and state, and no other key. Extra keys
 * are refused, because the directive is the whole authorisation.
 */
function matchesPendingStateDirective(args: Record<string, unknown>, directive: LinearRemoteDirective): boolean {
  if (normalizeToken(directive.server) !== PLANE_SERVER) return false;
  if (normalizeToken(directive.tool) !== PLANE_WORKITEM_TOOL) return false;
  const wanted = directive.args;
  if (normalizeToken(wanted.action) !== "update") return false;

  const wantedKeys = Object.keys(wanted);
  const keys = Object.keys(args);
  if (keys.length !== wantedKeys.length || wantedKeys.some((key) => !keys.includes(key))) return false;
  return wantedKeys.every((key) => sameToken(args[key], wanted[key]));
}

/** True when a key names a state anywhere in the arguments, so an alias or a nested key cannot hide one. */
function carriesStateKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesStateKey);
  const record = asRecord(value);
  if (!record) return false;
  return Object.entries(record).some(([key, nested]) => /state|status/iu.test(key) || carriesStateKey(nested));
}

/** The decision for a `workitem update` that carries a state: directive-only, never a hold, never a guess. */
function stateWriteReason(args: Record<string, unknown>, context: PlaneWriteContext): string | null {
  const pending = context.pending;
  if (!pending || !matchesPendingStateDirective(args, pending)) return stateWriteWithoutDirectiveReason();
  if (context.pendingAction === "start") return null;
  if (context.pendingAction === "complete") {
    const gate = context.doneGate();
    return gate.allowed ? null : stateWriteGateReason(gate.reason);
  }
  return stateWriteWithoutDirectiveReason();
}

/** The decision for one Plane tool request: its tool, then its action, against the closed list. */
function classifyPlaneTool(tool: string, args: Record<string, unknown> | undefined, context: PlaneWriteContext): string | null {
  if (tool === PLANE_READ_TOOL) return null;
  if (!PLANE_TOOLS.has(tool)) return unknownToolReason(tool);

  const action = normalizeToken(args?.action);
  if (!args) return notAllowedActionReason(tool, action);
  if (PLANE_READ_ACTIONS.has(action)) return null;

  if (tool === PLANE_WORKITEM_TOOL && action === "update") {
    return carriesStateKey(args) ? stateWriteReason(args, context) : updateWithoutStateReason();
  }
  if (PLANE_ALLOWED_WRITES.get(tool)?.has(action)) return null;
  return notAllowedActionReason(tool, action);
}

/**
 * The Plane write guard of the `tool_call` hook (D33 phase 4, part C, reduced by D38). Returns the
 * Spanish refusal for a call that may not run, or `null` when it may. An untrusted profile refuses
 * every tool that is not a Pi base tool or an AIES tool; a trusted one applies the closed list to
 * the calls that reach Plane, and passes the rest.
 */
export function planeWriteBypassReason(
  toolName: string,
  input: Record<string, unknown> | undefined,
  context: PlaneWriteContext,
): string | null {
  // A script can chain several MCP calls past this guard, so it is refused whole, whatever the trust.
  if (String(toolName).replace(/[\s._-]/gu, "").toLowerCase() === "mcpscript") {
    return planeBlockReason(
      "mcpScript encadena llamadas MCP sin pasar una por una por la guarda de Plane",
      "Usá la herramienta mcp con una sola llamada por vez.",
    );
  }

  if (!isTrusted(context.trust)) {
    return NON_MCP_TOOL_NAMES.has(toolName) ? null : untrustedProfileReason(context.trust?.reason ?? "");
  }

  const reading = planeReading(toolName, input, context.trust);
  if (!reading) return null;
  if (reading.kind === "gateway") return gatewayReason(reading.action);
  if (reading.kind === "undeclared") return undeclaredServerReason();
  return classifyPlaneTool(reading.tool, reading.args, context);
}
