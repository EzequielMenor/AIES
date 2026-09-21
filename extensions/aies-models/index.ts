/**
 * `/aies-models` — registry-backed model and thinking-level picker
 * (AIES-010D / T12).
 *
 * The command is a presentation and preference surface only:
 * - Choices come exclusively from `ctx.modelRegistry.getAvailable()` at command
 *   time; nothing is hardcoded and no unavailable model is ever shown.
 * - Thinking levels are capability-valid from each model's metadata, so an
 *   unsupported level is never offered or persisted.
 * - The TUI gets a keyboard-first overlay (arrows or j/k, Enter, Esc); headless
 *   hosts get bounded readable text and never reach a custom component.
 * - The Parent role switches the current session through Pi's public model and
 *   thinking setters and persists its default through Pi's `SettingsManager`.
 * - Child roles persist only into the isolated `$PI_CODING_AGENT_DIR/aies.json`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  availableModelOptions,
  type AiesThinkingLevel,
  type ModelLike,
  type ModelOption,
} from "./capabilities.ts";
import {
  persistParentDefaults,
  readChildPreferences,
  writeChildPreference,
  type AiesChildRole,
  type AiesRole,
} from "./config.ts";
import { renderHeadlessModels } from "./headless.ts";
import {
  MODAL_FRAME_CHROME,
  MODAL_MAX_WIDTH,
  MODAL_MIN_WIDTH,
  renderModalFrame,
  type ModalLine,
} from "../aies-ui/modal.ts";
import { themePaint } from "../aies-ui/paint.ts";
import {
  ROLE_LABELS,
  createOverlayState,
  decodeOverlayKey,
  reduceOverlayKey,
  renderOverlayState,
  type OverlayAction,
  type OverlayContext,
  type OverlayState,
} from "./overlay.ts";

/** The resolved picker choice. */
export interface ModelsSelection {
  role: AiesRole;
  option: ModelOption;
  thinkingLevel?: AiesThinkingLevel;
}

/** The isolated agent dir, or `undefined` so the caller fails safely. */
export function isolatedAgentDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.PI_CODING_AGENT_DIR;
  return typeof dir === "string" && dir.trim() ? dir.trim() : undefined;
}

function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    const notifyFn = (ctx as { ui?: { notify?: unknown } })?.ui?.notify;
    if (typeof notifyFn === "function") {
      (notifyFn as (message: string, type?: string) => void).call(ctx.ui, message, type);
    }
  } catch {
    // A host without notifications keeps the command silent rather than noisy.
  }
}

/**
 * Switch the current session model. Prefers a context-level setter when the
 * host exposes one and falls back to Pi's documented `pi.setModel`.
 */
function sessionModelSetter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): (model: unknown) => Promise<boolean> | boolean {
  const ctxSetter = (ctx as { setModel?: unknown }).setModel;
  if (typeof ctxSetter === "function") {
    return (model) => (ctxSetter as (model: unknown) => Promise<boolean>).call(ctx, model);
  }
  const piSetter = (pi as { setModel?: unknown }).setModel;
  if (typeof piSetter === "function") {
    return (model) => (piSetter as (model: unknown) => Promise<boolean>).call(pi, model);
  }
  return () => false;
}

/** Switch the current session thinking level through the same public surface. */
function sessionThinkingSetter(pi: ExtensionAPI, ctx: ExtensionContext): (level: AiesThinkingLevel) => void {
  const ctxSetter = (ctx as { setThinkingLevel?: unknown }).setThinkingLevel;
  if (typeof ctxSetter === "function") {
    return (level) => (ctxSetter as (level: AiesThinkingLevel) => void).call(ctx, level);
  }
  const piSetter = (pi as { setThinkingLevel?: unknown }).setThinkingLevel;
  if (typeof piSetter === "function") {
    return (level) => (piSetter as (level: AiesThinkingLevel) => void).call(pi, level);
  }
  return () => {};
}

/** The slice of the injected keybinding manager `/aies-models` uses, when present. */
interface KeybindingsLike {
  matches?(data: string, action: string): boolean;
}

/**
 * Bind the overlay keys to the injected keybinding manager when the host
 * provides one, with raw fallbacks so a partial host still works. The manager
 * is authoritative because Pi may deliver arrows and Esc as CSI-u sequences
 * under the Kitty keyboard protocol; the raw decoder is the safety net.
 */
function overlayKeys(keybindings: unknown): { decode(data: string): OverlayAction | undefined } {
  const manager = keybindings as KeybindingsLike | undefined;
  const matches = (data: string, action: string): boolean => {
    if (manager && typeof manager.matches === "function") {
      try {
        if (manager.matches(data, action) === true) return true;
      } catch {
        // An unusable manager falls back to the raw decoder below.
      }
    }
    return false;
  };

  return {
    decode: (data) => {
      if (matches(data, "tui.select.up")) return "up";
      if (matches(data, "tui.select.down")) return "down";
      if (matches(data, "tui.editor.cursorLeft")) return "left";
      if (matches(data, "tui.editor.cursorRight")) return "right";
      if (matches(data, "tui.select.confirm")) return "confirm";
      if (matches(data, "app.models.save")) return "confirm";
      if (matches(data, "tui.select.cancel")) return "escape";
      return decodeOverlayKey(data);
    },
  };
}

/** A theme surface read structurally so a partial host still renders text. */
interface OverlayTheme {
  fg?(color: string, text: string): string;
}

/** Narrow the host theme to the shape the shared paint adapter accepts. */
function paintableTheme(
  theme: OverlayTheme | undefined,
): { fg(color: string, text: string): string } | undefined {
  return theme && typeof theme.fg === "function"
    ? (theme as { fg(color: string, text: string): string })
    : undefined;
}

/**
 * The widest content the picker can show across its three steps. Sizing the
 * overlay from real content keeps the frame tight on a wide terminal and lets
 * Pi clamp it safely when the terminal is narrow.
 */
export function overlayPreferredWidth(context: OverlayContext): number {
  const roleState = createOverlayState();
  const modelState: OverlayState = { ...roleState, step: "model", role: "parent" };
  const states: OverlayState[] = [roleState, modelState];
  const model = context.models.find((option) => option.levels.length > 1) ?? context.models[0];
  if (model) states.push({ ...modelState, step: "thinking", model });

  let widest = 0;
  for (const state of states) {
    const view = renderOverlayState(state, context);
    widest = Math.max(widest, view.title.length, ...view.lines.map((line) => line.length), view.help.length);
  }
  return Math.min(MODAL_MAX_WIDTH, Math.max(MODAL_MIN_WIDTH, widest + MODAL_FRAME_CHROME));
}

/** Map the pure overlay view into the shared frame's content shape. */
function overlayModalLines(view: ReturnType<typeof renderOverlayState>): ModalLine[] {
  return view.lines.map((line) => ({
    text: line,
    color: line.startsWith("›") ? "accent" : "text",
  }));
}

/** Render the pure overlay view into the shared AIES modal frame. */
export function renderOverlayLines(
  state: Parameters<typeof renderOverlayState>[0],
  context: OverlayContext,
  theme: OverlayTheme | undefined,
  width: number,
): string[] {
  const view = renderOverlayState(state, context);
  return renderModalFrame({
    title: view.title,
    lines: overlayModalLines(view),
    help: view.help,
    width,
    preferredWidth: overlayPreferredWidth(context),
    paint: themePaint(paintableTheme(theme)),
  });
}

/** Open the TUI overlay and resolve the confirmed selection, or `null` on cancel. */
async function openOverlay(ctx: ExtensionContext, models: ModelOption[]): Promise<ModelsSelection | null> {
  const context: OverlayContext = { models };
  let state = createOverlayState();

  const custom = ctx.ui?.custom;
  if (typeof custom !== "function") return null;

  const result = await custom(
    (tui, theme, keybindings, done) => {
      const keys = overlayKeys(keybindings);
      let settled = false;
      return {
        render: (width: number) => renderOverlayLines(state, context, theme as OverlayTheme | undefined, width),
        handleInput: (data: string): void => {
          if (settled) return;
          const action = keys.decode(data);
          if (!action) return;
          state = reduceOverlayKey(state, action, context);
          if (state.cancelled) {
            settled = true;
            done(null);
            return;
          }
          if (state.step === "done" && state.model) {
            settled = true;
            done({
              role: state.role ?? "parent",
              option: state.model,
              ...(state.thinking ? { thinkingLevel: state.thinking } : {}),
            } satisfies ModelsSelection);
            return;
          }
          try {
            (tui as { requestRender?: () => void })?.requestRender?.();
          } catch {
            // A host without an explicit render request repaints on the next tick.
          }
        },
        invalidate(): void {},
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: overlayPreferredWidth(context),
        minWidth: MODAL_MIN_WIDTH,
        maxHeight: "80%",
      },
    },
  );

  return (result as ModelsSelection | null | undefined) ?? null;
}

/** Apply a confirmed selection: session switch and/or isolated persistence. */
async function applySelection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection: ModelsSelection,
  agentDir: string | undefined,
): Promise<void> {
  const label = ROLE_LABELS[selection.role];
  const suffix = selection.thinkingLevel ? ` · ${selection.thinkingLevel}` : "";

  if (selection.role === "parent") {
    const accepted = await sessionModelSetter(pi, ctx)(selection.option.model);
    if (accepted !== true) {
      notify(
        ctx,
        `No se pudo cambiar el modelo Parent a ${selection.option.value}: Pi rechazó la selección (autenticación no configurada). No se guardó ningún default.`,
        "error",
      );
      return;
    }
    if (selection.thinkingLevel) sessionThinkingSetter(pi, ctx)(selection.thinkingLevel);

    const persisted = await persistParentDefaults({
      cwd: ctx.cwd,
      agentDir,
      provider: selection.option.provider,
      modelId: selection.option.id,
      thinkingLevel: selection.thinkingLevel,
      model: selection.option.model as ModelLike,
    });
    if (!persisted.ok) {
      notify(ctx, `Modelo Parent ${selection.option.value}${suffix} activo, pero no se guardó el default: ${persisted.error}`, "error");
      return;
    }
    notify(ctx, `${label}: ${selection.option.value}${suffix}`, "info");
    return;
  }

  const written = writeChildPreference(agentDir, selection.role as AiesChildRole, {
    model: selection.option.value,
    ...(selection.thinkingLevel ? { thinkingLevel: selection.thinkingLevel } : {}),
  });
  if (!written.ok) {
    notify(ctx, `No se pudo guardar ${label}: ${written.error}`, "error");
    return;
  }
  notify(ctx, `${label}: ${selection.option.value}${suffix}`, "info");
}

/** The `/aies-models` handler, exported so tests can drive it with a fake host. */
export async function handleModelsCommand(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const models = availableModelOptions(ctx.modelRegistry);
  const agentDir = isolatedAgentDir();

  const isTui = ctx.mode === "tui" && typeof ctx.ui?.custom === "function";
  if (!isTui) {
    notify(ctx, renderHeadlessModels({ models, preferences: readChildPreferences(agentDir) }), "info");
    return;
  }

  const selection = await openOverlay(ctx, models);
  if (!selection) return;
  await applySelection(pi, ctx, selection, agentDir);
}

/** Register the AIES model picker. Presentation and preference only. */
export default function aiesModels(pi: ExtensionAPI): void {
  pi.registerCommand("aies-models", {
    description:
      "Elegí el modelo y el nivel de pensamiento de Parent, Explore, Worker y Verify a partir de los modelos disponibles",
    handler: async (_args, ctx) => {
      try {
        await handleModelsCommand(pi, ctx);
      } catch (error) {
        notify(ctx, `No se pudo abrir /aies-models: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
