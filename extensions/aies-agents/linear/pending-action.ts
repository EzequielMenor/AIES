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
