/**
 * Pure overlay state machine for `/aies-models` (AIES-010D / T12).
 *
 * The TUI component in `index.ts` is only a thin adapter over this module: it
 * forwards input, calls `tui.requestRender()` and renders whatever
 * `renderOverlayState` returns. The flow is keyboard-first (arrows or j/k,
 * ←→ or h/l for effort, Enter or Ctrl+S to confirm, Esc back, q quit) and
 * every step is a bounded, deterministic projection, so it can be exercised
 * without a terminal. Keys are decoded by the host keybindings manager with
 * the raw fallbacks in `decodeOverlayKey` underneath.
 */

import type { AiesThinkingLevel, ModelOption } from "./capabilities.ts";
import { CHILD_ROLES, type AiesRole } from "./config.ts";

/** The preference roles in product order. Parent first: it is the session model. */
export const ROLE_ORDER: readonly AiesRole[] = ["parent", ...CHILD_ROLES];

/** Human labels for each role. */
export const ROLE_LABELS: Record<AiesRole, string> = {
  parent: "Parent",
  explore: "Explore",
  worker: "Worker",
  verify: "Verify",
};

/** The three steps of the picker. */
export type OverlayStep = "role" | "model" | "thinking" | "done";

/** The overlay's small input alphabet after decoding. */
export type OverlayAction = "up" | "down" | "left" | "right" | "confirm" | "escape" | "quit";

const OVERLAY_ACTIONS: readonly OverlayAction[] = ["up", "down", "left", "right", "confirm", "escape", "quit"];

export interface OverlayState {
  step: OverlayStep;
  roleIndex: number;
  modelIndex: number;
  thinkingIndex: number;
  role?: AiesRole;
  model?: ModelOption;
  thinking?: AiesThinkingLevel;
  cancelled: boolean;
}

/** The immutable inputs the reducer needs. */
export interface OverlayContext {
  models: ModelOption[];
}

/** How many list rows the overlay shows before it starts scrolling. */
export const OVERLAY_VISIBLE_ROWS = 12;

export function createOverlayState(): OverlayState {
  return { step: "role", roleIndex: 0, modelIndex: 0, thinkingIndex: 0, cancelled: false };
}

/**
 * Normalize a raw terminal key into the overlay's small input alphabet. This
 * is the fallback decoder used when the host keybindings manager cannot classify
 * the payload; it is deterministic and never guesses an ANSI sequence.
 */
export function decodeOverlayKey(data: string): OverlayAction | undefined {
  if (data === "\x1b[A" || data === "k") return "up";
  if (data === "\x1b[B" || data === "j") return "down";
  if (data === "\x1b[D" || data === "h") return "left";
  if (data === "\x1b[C" || data === "l") return "right";
  if (data === "\r" || data === "\n" || data === "enter" || data === "return" || data === "\x13") {
    return "confirm";
  }
  if (data === "\x1b" || data === "escape" || data === "esc") return "escape";
  if (data === "q") return "quit";
  return undefined;
}

function clamp(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function levelsOf(model: ModelOption | undefined): AiesThinkingLevel[] {
  return model?.levels ?? [];
}

/**
 * Advance the picker by one key. Pure: the previous state is never mutated. A
 * model that exposes only `off` skips the thinking step entirely rather than
 * presenting a single meaningless choice.
 */
export function reduceOverlayKey(
  state: OverlayState,
  key: string | undefined,
  context: OverlayContext,
): OverlayState {
  const action =
    key !== undefined && (OVERLAY_ACTIONS as readonly string[]).includes(key)
      ? (key as OverlayAction)
      : decodeOverlayKey(key ?? "");
  if (!action || state.cancelled || state.step === "done") return state;

  if (action === "quit") return { ...state, cancelled: true };

  if (action === "escape") {
    if (state.step === "role") return { ...state, cancelled: true };
    if (state.step === "model") return { ...state, step: "role", modelIndex: 0 };
    if (state.step === "thinking") return { ...state, step: "model", thinkingIndex: 0 };
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
    if (state.step === "model") {
      return { ...state, modelIndex: clamp(state.modelIndex + delta, context.models.length) };
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
      step: "model",
      role: ROLE_ORDER[clamp(state.roleIndex, ROLE_ORDER.length)],
      modelIndex: 0,
      thinkingIndex: 0,
    };
  }

  if (state.step === "model") {
    const model = context.models[clamp(state.modelIndex, context.models.length)];
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

const DEFAULT_HELP = "↑↓ j/k elegir · ←→ h/l esfuerzo · Enter elegir · Esc atrás · q salir · Ctrl+S guardar";

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

/** Render the current step into bounded lines. The last row is the scroll hint. */
export function renderOverlayState(state: OverlayState, context: OverlayContext): OverlayView {
  if (state.step === "role") {
    return {
      title: "Modelo AIES · elegí el rol",
      lines: ROLE_ORDER.map((role, index) => `${marker(index, state.roleIndex)}${ROLE_LABELS[role]}`),
      help: DEFAULT_HELP,
    };
  }

  if (state.step === "model") {
    const { rows, offset } = windowOf(context.models, state.modelIndex);
    const lines = rows.map((model, index) => {
      const absolute = offset + index;
      return `${marker(absolute, state.modelIndex)}${model.label}`;
    });
    if (context.models.length === 0) lines.push("  sin modelos disponibles");
    return {
      title: `Modelo · ${ROLE_LABELS[state.role ?? "parent"]}`,
      lines,
      help: DEFAULT_HELP,
    };
  }

  if (state.step === "thinking") {
    const levels = levelsOf(state.model);
    return {
      title: `Pensamiento · ${state.model?.label ?? ""}`.trim(),
      lines: levels.map((level, index) => `${marker(index, state.thinkingIndex)}${level}`),
      help: DEFAULT_HELP,
    };
  }

  return {
    title: "Modelo AIES",
    lines: [],
    help: DEFAULT_HELP,
  };
}
