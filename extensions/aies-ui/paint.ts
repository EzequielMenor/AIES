/**
 * Color adapter for the AIES presentation module.
 *
 * The pure renderers never emit raw ANSI escapes: they ask a `Paint` for a
 * semantic color and receive a finished string. In tests and headless runs the
 * paint is `PLAIN_PAINT`, which returns the text unchanged; in a TUI it wraps
 * Pi's own theme so colors stay consistent with the host.
 */

/** The only colors a renderer is allowed to name. */
export type SemanticColor = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text";

/** Injected colorizer: pure by contract, never throws into a renderer. */
export interface Paint {
  fg(color: SemanticColor, text: string): string;
}

/** The identity paint: every renderer stays plain text. */
export const PLAIN_PAINT: Paint = {
  fg(_color: SemanticColor, text: string): string {
    return text;
  },
};

/**
 * Adapt a Pi theme into a `Paint`. A missing or unusable theme degrades to
 * `PLAIN_PAINT`, and a theme that throws on one color cannot break a render.
 */
export function themePaint(theme: { fg(color: string, text: string): string } | undefined): Paint {
  if (!theme || typeof theme.fg !== "function") return PLAIN_PAINT;
  return {
    fg(color: SemanticColor, text: string): string {
      try {
        const painted = theme.fg(color, text);
        return typeof painted === "string" ? painted : text;
      } catch {
        return text;
      }
    },
  };
}
