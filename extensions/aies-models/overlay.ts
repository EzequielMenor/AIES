/**
 * Pure overlay state machine for `/aies-models` (AIES-010D / T12, EZE-453 / T10).
 *
 * The TUI component in `index.ts` is only a thin adapter over this module: it
 * forwards input, calls `tui.requestRender()` and renders whatever
 * `renderOverlayState` returns. The flow is keyboard-first —
 * `role → provider → model → thinking` — because a usable catalogue can hold
 * dozens of models per vendor.
 *
 * Navigation keys are decoded by the host keybindings manager with the raw
 * fallbacks in `decodeOverlayKey` underneath. In the **model step** the decoder
 * is deliberately step-aware: every printable byte becomes a search query
 * character and only the arrows still navigate, exactly Pi's own `/model` rule.
 * The `j`/`k`/`h`/`l`/`q` aliases therefore only work in the other steps.
 *
 * Every step is a bounded, deterministic projection, so the whole flow can be
 * exercised without a terminal.
 */

import type { AiesThinkingLevel, ModelOption } from "./capabilities.ts";
import type { ModelScope, NotUsableSummary, ProviderSection } from "./providers.ts";
import { CHILD_ROLES, type AiesRole } from "./config.ts";
import { MAX_QUERY_LENGTH, fuzzyFilter, modelSearchText } from "./search.ts";

/** The preference roles in product order. Parent first: it is the session model. */
export const ROLE_ORDER: readonly AiesRole[] = ["parent", ...CHILD_ROLES];

/** Human labels for each role. */
export const ROLE_LABELS: Record<AiesRole, string> = {
  parent: "Parent",
  explore: "Explore",
  worker: "Worker",
  verify: "Verify",
};

/** The picker steps. A provider is chosen before its models. */
export type OverlayStep = "role" | "provider" | "model" | "thinking" | "done";

/** The overlay's decoded navigation alphabet. */
export type OverlayAction =
  | "up"
  | "down"
  | "left"
  | "right"
  | "confirm"
  | "escape"
  | "quit"
  | "scope"
  | "backspace";

/** One decoded key: either a navigation action or a printable character. */
export type OverlayInput = OverlayAction | { type: "char"; value: string };

const OVERLAY_ACTIONS: readonly OverlayAction[] = [
  "up",
  "down",
  "left",
  "right",
  "confirm",
  "escape",
  "quit",
  "scope",
  "backspace",
];

export interface OverlayState {
  step: OverlayStep;
  roleIndex: number;
  providerIndex: number;
  modelIndex: number;
  thinkingIndex: number;
  scope: ModelScope;
  query: string;
  role?: AiesRole;
  model?: ModelOption;
  thinking?: AiesThinkingLevel;
  cancelled: boolean;
}

/** The current model/level assigned to one role, for the role step. */
export interface RoleAssignment {
  role: AiesRole;
  /** `provider/id`, or undefined when the role has nothing assigned. */
  model?: string;
  thinkingLevel?: string;
}

/** The immutable inputs the reducer needs. */
export interface OverlayContext {
  usable: ProviderSection[];
  scopedUsable: ProviderSection[];
  hasScoped: boolean;
  notUsable: NotUsableSummary;
  assignments: RoleAssignment[];
}

/** How many list rows the overlay shows before it starts scrolling. */
export const OVERLAY_VISIBLE_ROWS = 12;

/** Every rendered content line is bounded to this width. */
const OVERLAY_LINE_LIMIT = 88;

/** Fixed role-label width so the `·` columns align on the role step. */
const ROLE_LABEL_WIDTH = 8;

const EMPTY_SUMMARY: NotUsableSummary = { count: 0, names: [], extra: 0 };

const ROLE_HELP = "↑↓ j/k elegir · Enter · Esc salir · q salir";
const PROVIDER_HELP = "↑↓ j/k elegir · Enter · Tab all/scoped · Esc atrás · q salir";
const MODEL_HELP = "↑↓ elegir · tipear filtra · Backspace borra · Enter · Tab all/scoped · Esc";
const THINKING_HELP = "←→ h/l elegir · Enter · Esc atrás";

/**
 * Create the initial state. The scope follows Pi's rule: start on `scoped` only
 * when a scoped set exists, otherwise `all`. Callable with no argument.
 */
export function createOverlayState(context?: { hasScoped?: boolean }): OverlayState {
  return {
    step: "role",
    roleIndex: 0,
    providerIndex: 0,
    modelIndex: 0,
    thinkingIndex: 0,
    scope: context?.hasScoped ? "scoped" : "all",
    query: "",
    cancelled: false,
  };
}

/** Whether a payload is printable text: non-empty, no escapes and no control bytes. */
function isTextPayload(data: string): boolean {
  if (data.length === 0) return false;
  if (data.startsWith("\x1b")) return false;
  for (const character of data) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Normalize a raw terminal key into the overlay's input alphabet. This is the
 * fallback decoder used when the host keybindings manager cannot classify the
 * payload; it is deterministic and never guesses an ANSI sequence. In the model
 * step the letter aliases are suppressed so typing filters the list.
 */
export function decodeOverlayKey(data: string, step?: OverlayStep): OverlayInput | undefined {
  if (data === "\x1b[A") return "up";
  if (data === "\x1b[B") return "down";
  if (data === "\x1b[D") return "left";
  if (data === "\x1b[C") return "right";
  if (data === "\r" || data === "\n" || data === "enter" || data === "return" || data === "\x13") {
    return "confirm";
  }
  if (data === "\x1b" || data === "escape" || data === "esc") return "escape";
  if (data === "\t") return "scope";
  if (data === "\x7f" || data === "\x08") return "backspace";
  if (step !== "model") {
    if (data === "k") return "up";
    if (data === "j") return "down";
    if (data === "h") return "left";
    if (data === "l") return "right";
    if (data === "q") return "quit";
  }
  if (step === "model" && isTextPayload(data)) return { type: "char", value: data };
  return undefined;
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function levelsOf(model: ModelOption | undefined): AiesThinkingLevel[] {
  return model?.levels ?? [];
}

/** The provider sections the current scope exposes. */
export function activeSections(state: OverlayState, context: OverlayContext): ProviderSection[] {
  if (state.scope === "scoped" && context.hasScoped) return context.scopedUsable ?? [];
  return context.usable ?? [];
}

/** The provider section the current provider index points at, if any. */
function sectionOf(state: OverlayState, context: OverlayContext): ProviderSection | undefined {
  const sections = activeSections(state, context);
  return sections[clamp(state.providerIndex, sections.length)];
}

/** The active section's models, filtered and ranked by the current query. */
export function visibleModels(state: OverlayState, context: OverlayContext): ModelOption[] {
  const models = sectionOf(state, context)?.models ?? [];
  return fuzzyFilter(models, state.query, (model) => modelSearchText(model));
}

/** Clip a rendered row so no provider input can produce an unbounded line. */
function boundLine(line: string): string {
  if (line.length <= OVERLAY_LINE_LIMIT) return line;
  return `${line.slice(0, OVERLAY_LINE_LIMIT - 1)}…`;
}

/** The reducer's text input: only the model step accepts characters. */
function applyChar(state: OverlayState, value: string): OverlayState {
  if (state.step !== "model") return state;
  if (typeof value !== "string" || value.length === 0) return state;
  return { ...state, query: (state.query + value).slice(0, MAX_QUERY_LENGTH), modelIndex: 0 };
}

/** Accept an already-decoded action string, or decode a raw payload. */
function decodeInput(state: OverlayState, input: OverlayInput | string | undefined): OverlayInput | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") return input;
  if ((OVERLAY_ACTIONS as readonly string[]).includes(input)) return input as OverlayAction;
  return decodeOverlayKey(input, state.step);
}

/**
 * Advance the picker by one key. Pure: the previous state is never mutated. A
 * model that exposes only `off` skips the thinking step entirely rather than
 * presenting a single meaningless choice.
 */
export function reduceOverlayKey(
  state: OverlayState,
  input: OverlayInput | string | undefined,
  context: OverlayContext,
): OverlayState {
  if (state.cancelled || state.step === "done") return state;

  const decoded = decodeInput(state, input);
  if (decoded === undefined) return state;

  if (typeof decoded !== "string") {
    return decoded.type === "char" ? applyChar(state, decoded.value) : state;
  }

  const action = decoded;
  if (action === "quit") return { ...state, cancelled: true };

  if (action === "scope") {
    if ((state.step === "provider" || state.step === "model") && context.hasScoped) {
      return {
        ...state,
        scope: state.scope === "all" ? "scoped" : "all",
        providerIndex: 0,
        modelIndex: 0,
      };
    }
    return state;
  }

  if (action === "backspace") {
    if (state.step !== "model") return state;
    const characters = Array.from(state.query);
    if (characters.length === 0) return state;
    characters.pop();
    return { ...state, query: characters.join(""), modelIndex: 0 };
  }

  if (action === "escape") {
    if (state.step === "thinking") return { ...state, step: "model", thinkingIndex: 0 };
    if (state.step === "model") {
      if (state.query.length > 0) return { ...state, query: "", modelIndex: 0 };
      return { ...state, step: "provider", modelIndex: 0 };
    }
    if (state.step === "provider") return { ...state, step: "role", providerIndex: 0 };
    if (state.step === "role") return { ...state, cancelled: true };
    return state;
  }

  if (action === "left" || action === "right") {
    if (state.step !== "thinking") return state;
    const delta = action === "left" ? -1 : 1;
    return { ...state, thinkingIndex: clamp(state.thinkingIndex + delta, levelsOf(state.model).length) };
  }

  if (action === "up" || action === "down") {
    const delta = action === "up" ? -1 : 1;
    if (state.step === "role") {
      return { ...state, roleIndex: clamp(state.roleIndex + delta, ROLE_ORDER.length) };
    }
    if (state.step === "provider") {
      return {
        ...state,
        providerIndex: clamp(state.providerIndex + delta, activeSections(state, context).length),
      };
    }
    if (state.step === "model") {
      return { ...state, modelIndex: clamp(state.modelIndex + delta, visibleModels(state, context).length) };
    }
    if (state.step === "thinking") {
      return { ...state, thinkingIndex: clamp(state.thinkingIndex + delta, levelsOf(state.model).length) };
    }
    return state;
  }

  // Confirm.
  if (state.step === "role") {
    return {
      ...state,
      step: "provider",
      role: ROLE_ORDER[clamp(state.roleIndex, ROLE_ORDER.length)],
      providerIndex: 0,
      modelIndex: 0,
      thinkingIndex: 0,
    };
  }

  if (state.step === "provider") {
    // No provider at the clamped index means nothing is selectable: stay put.
    if (!sectionOf(state, context)) return state;
    return { ...state, step: "model", modelIndex: 0, thinkingIndex: 0 };
  }

  if (state.step === "model") {
    const models = visibleModels(state, context);
    const model = models[clamp(state.modelIndex, models.length)];
    if (!model) return state;
    const levels = levelsOf(model);
    if (levels.length <= 1) {
      return { ...state, step: "done", model, thinking: levels[0] };
    }
    return { ...state, step: "thinking", model, thinkingIndex: 0 };
  }

  if (state.step === "thinking") {
    const levels = levelsOf(state.model);
    return { ...state, step: "done", thinking: levels[clamp(state.thinkingIndex, levels.length)] };
  }

  return state;
}

export interface OverlayView {
  title: string;
  lines: string[];
  help: string;
}

function windowOf<T>(items: readonly T[], selected: number): { rows: T[]; offset: number } {
  if (items.length <= OVERLAY_VISIBLE_ROWS) return { rows: [...items], offset: 0 };
  const half = Math.floor(OVERLAY_VISIBLE_ROWS / 2);
  let offset = Math.max(0, selected - half);
  offset = Math.min(offset, items.length - OVERLAY_VISIBLE_ROWS);
  return { rows: items.slice(offset, offset + OVERLAY_VISIBLE_ROWS), offset };
}

function marker(index: number, selected: number): string {
  return index === selected ? "› " : "  ";
}

/** The Pi-style scope indicator; brackets mark the active scope. */
function scopeLine(scope: ModelScope): string {
  return scope === "scoped" ? "  Scope: all [scoped]" : "  Scope: [all] scoped";
}

/** The assignment text for one role, or `sin preferencia` when absent. */
function assignmentText(assignments: readonly RoleAssignment[], role: AiesRole): string {
  const assignment = assignments.find((entry) => entry.role === role);
  const model = typeof assignment?.model === "string" && assignment.model ? assignment.model : undefined;
  if (!model) return "sin preferencia";
  const level = assignment?.thinkingLevel ? ` · ${assignment.thinkingLevel}` : "";
  return `${model}${level}`;
}

/** The single bounded summary line about providers that cannot be selected. */
function notUsableLine(summary: NotUsableSummary): string {
  const noun = summary.count === 1 ? "provider no utilizable" : "providers no utilizables";
  const extra = summary.extra > 0 ? ` +${summary.extra}` : "";
  return `  ${summary.count} ${noun} · ${summary.names.join(", ")}${extra}`;
}

/** Render the current step into bounded lines. */
export function renderOverlayState(state: OverlayState, context: OverlayContext): OverlayView {
  if (state.step === "role") {
    const assignments = context.assignments ?? [];
    return {
      title: "Modelo AIES · elegí el rol",
      lines: ROLE_ORDER.map((role, index) => {
        const label = (ROLE_LABELS[role] ?? role).padEnd(ROLE_LABEL_WIDTH);
        return `${marker(index, state.roleIndex)}${label} · ${assignmentText(assignments, role)}`;
      }).map(boundLine),
      help: ROLE_HELP,
    };
  }

  if (state.step === "provider") {
    const sections = activeSections(state, context);
    const lines: string[] = [];
    if (context.hasScoped) lines.push(scopeLine(state.scope));
    for (const [index, section] of sections.entries()) {
      lines.push(`${marker(index, state.providerIndex)}${section.name} (${section.models.length})`);
    }
    const summary = context.notUsable ?? EMPTY_SUMMARY;
    if (summary.count > 0) {
      lines.push("");
      lines.push(notUsableLine(summary));
    }
    if (sections.length === 0) lines.push("  sin providers utilizables");
    return {
      title: `Provider · ${ROLE_LABELS[state.role ?? "parent"]}`,
      lines: lines.map(boundLine),
      help: PROVIDER_HELP,
    };
  }

  if (state.step === "model") {
    const sections = activeSections(state, context);
    const section = sections[clamp(state.providerIndex, sections.length)];
    const models = visibleModels(state, context);
    const lines: string[] = [];
    if (context.hasScoped) lines.push(scopeLine(state.scope));
    if (state.query) lines.push(`  buscar: ${state.query}`);

    const { rows, offset } = windowOf(models, state.modelIndex);
    for (const [index, model] of rows.entries()) {
      const absolute = offset + index;
      const label = model.name && model.name !== model.id ? model.name : model.id;
      lines.push(`${marker(absolute, state.modelIndex)}${label}`);
    }
    if (models.length > OVERLAY_VISIBLE_ROWS) lines.push(`  (${state.modelIndex + 1}/${models.length})`);
    if (models.length === 0) {
      lines.push(state.query ? `  sin coincidencias para "${state.query}"` : "  sin modelos seleccionables");
    }
    return {
      title: `Modelo · ${section?.name ?? ""}`.trim(),
      lines: lines.map(boundLine),
      help: MODEL_HELP,
    };
  }

  if (state.step === "thinking") {
    const levels = levelsOf(state.model);
    return {
      title: `Pensamiento · ${state.model?.label ?? ""}`.trim(),
      lines: levels.map((level, index) => `${marker(index, state.thinkingIndex)}${level}`).map(boundLine),
      help: THINKING_HELP,
    };
  }

  return {
    title: "Modelo AIES",
    lines: [],
    help: ROLE_HELP,
  };
}
