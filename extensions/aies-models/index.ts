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
  type AiesThinkingLevel,
  type ModelLike,
  type ModelOption,
} from "./capabilities.ts";
import {
  persistParentDefaults,
  readChildPreferences,
  writeChildPreference,
  CHILD_ROLES,
  type AiesChildRole,
  type AiesRole,
  type ChildPreference,
} from "./config.ts";
import { renderHeadlessModels } from "./headless.ts";
import { projectProviders, type ProviderProjection } from "./providers.ts";
import { credentialFingerprint, type ProviderHealthRecord } from "../aies-providers/health.ts";
import { readProviderHealth } from "../aies-providers/store.ts";
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
  type OverlayContext,
  type OverlayInput,
  type OverlayState,
  type OverlayStep,
  type RoleAssignment,
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
function overlayKeys(keybindings: unknown): {
  decode(data: string, step: OverlayStep): OverlayInput | undefined;
} {
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
    decode: (data, step) => {
      if (matches(data, "tui.select.up")) return "up";
      if (matches(data, "tui.select.down")) return "down";
      if (matches(data, "tui.editor.cursorLeft")) return "left";
      if (matches(data, "tui.editor.cursorRight")) return "right";
      if (matches(data, "tui.select.confirm")) return "confirm";
      if (matches(data, "app.models.save")) return "confirm";
      if (matches(data, "tui.select.cancel")) return "escape";
      if (matches(data, "tui.input.tab")) return "scope";
      // Only the actions above are consulted, so a printable byte can never be
      // swallowed by the manager in the model step: it reaches the decoder and
      // becomes search text, exactly Pi's own `/model` rule.
      return decodeOverlayKey(data, step);
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
 * The widest content the picker can show across its steps. Sizing the overlay
 * from real content keeps the frame tight on a wide terminal and lets Pi clamp
 * it safely when the terminal is narrow.
 */
export function overlayPreferredWidth(context: OverlayContext): number {
  const base = createOverlayState({ hasScoped: context.hasScoped });
  const providerState: OverlayState = { ...base, step: "provider", role: "parent" };
  const modelState: OverlayState = { ...base, step: "model", role: "parent" };
  const sections = context.hasScoped ? (context.scopedUsable ?? []) : (context.usable ?? []);
  const section = sections[0] ?? context.usable?.[0];
  const model = section?.models.find((option) => option.levels.length > 1) ?? section?.models[0];
  // A representative non-empty query keeps the `buscar:` line measured, and the
  // provider state carries the not-usable summary when the projection has one.
  const queryState: OverlayState = { ...modelState, query: section?.models[0]?.id ?? "model" };
  const states: OverlayState[] = [base, providerState, modelState, queryState];
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

/** The Parent assignment, read from the live session model. */
function parentAssignment(ctx: ExtensionContext): RoleAssignment {
  const provider = typeof ctx.model?.provider === "string" ? ctx.model.provider : undefined;
  const id = typeof ctx.model?.id === "string" ? ctx.model.id : undefined;
  if (!provider || !id) return { role: "parent" };
  const thinkingLevel = typeof ctx.thinkingLevel === "string" ? ctx.thinkingLevel : undefined;
  return { role: "parent", model: `${provider}/${id}`, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/**
 * Build the overlay context: the scoped projection plus each role's current
 * assignment. Parent comes from the live session; the child roles come from the
 * already-read isolated preferences, whose `model` is stored as `provider/id`.
 */
function overlayContextFor(
  projection: ProviderProjection,
  ctx: ExtensionContext,
  preferences: Partial<Record<AiesChildRole, ChildPreference>>,
): OverlayContext {
  const assignments: RoleAssignment[] = [parentAssignment(ctx)];
  for (const role of CHILD_ROLES) {
    const preference = preferences[role];
    const model = typeof preference?.model === "string" && preference.model ? preference.model : undefined;
    const thinkingLevel = preference?.thinkingLevel ? preference.thinkingLevel : undefined;
    assignments.push({ role, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) });
  }
  return {
    usable: projection.usable,
    scopedUsable: projection.scopedUsable,
    hasScoped: projection.hasScoped,
    notUsable: projection.notUsable,
    assignments,
  };
}

/** Open the TUI overlay and resolve the confirmed selection, or `null` on cancel. */
async function openOverlay(ctx: ExtensionContext, context: OverlayContext): Promise<ModelsSelection | null> {
  let state = createOverlayState({ hasScoped: context.hasScoped });

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
          const input = keys.decode(data, state.step);
          if (!input) return;
          state = reduceOverlayKey(state, input, context);
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

/**
 * Resolve the current credential digest for every provider that has a stored
 * health record. This is deliberately bounded: only providers with a record are
 * queried (typically zero or one), and each lookup is isolated so a rejecting or
 * command-running `getApiKeyForProvider` can never break the command.
 */
async function resolveFingerprints(
  registry: unknown,
  health: Record<string, ProviderHealthRecord>,
): Promise<Record<string, string | undefined>> {
  const fingerprints: Record<string, string | undefined> = {};
  const ids = Object.keys(health);
  if (ids.length === 0) return fingerprints;

  const getApiKey = (registry as { getApiKeyForProvider?: unknown } | undefined)?.getApiKeyForProvider;
  for (const id of ids) {
    let secret: unknown;
    if (typeof getApiKey === "function") {
      try {
        secret = await (getApiKey as (provider: string) => Promise<unknown>).call(registry, id);
      } catch {
        secret = undefined;
      }
    }
    fingerprints[id] = credentialFingerprint(secret);
  }
  return fingerprints;
}

/** The `/aies-models` handler, exported so tests can drive it with a fake host. */
export async function handleModelsCommand(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const agentDir = isolatedAgentDir();
  const health = readProviderHealth(agentDir);
  // Only look up credentials when there is a stored rejection to re-check. This
  // keeps the common path (no health records) synchronous, so the overlay opens
  // on the same tick the command was invoked.
  const fingerprints: Record<string, string | undefined> =
    Object.keys(health).length > 0 ? await resolveFingerprints(ctx.modelRegistry, health) : {};
  const preferences = readChildPreferences(agentDir);
  const projection = projectProviders({
    registry: ctx.modelRegistry,
    health,
    fingerprints,
    scopedModels: ctx.scopedModels,
  });

  const isTui = ctx.mode === "tui" && typeof ctx.ui?.custom === "function";
  if (!isTui) {
    notify(ctx, renderHeadlessModels({ projection, preferences }), "info");
    return;
  }

  const selection = await openOverlay(ctx, overlayContextFor(projection, ctx, preferences));
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
