/**
 * AIES-010C T5: the Pi boundary for the quiet tool surface.
 *
 * This is the only place in the quiet-tool feature that touches Pi. It
 * re-registers the six generic built-in tools (`read`, `bash`, `grep`, `find`,
 * `edit`, `write`) with the same name, creates one original instance per tool
 * through the public `create*Tool(cwd)` factory, delegates `execute` to that
 * instance unchanged and adds only `renderCall`/`renderResult`.
 *
 * The native shell is kept on purpose (no `renderShell: "self"`), so Pi still
 * frames a failed result with its own error background. The projections live in
 * `extensions/aies-ui/tools.ts` and are pure; here they are adapted to Pi's
 * `Theme` and `Component` shapes.
 *
 * Registration is idempotent per host: a reload or resume in the same working
 * directory registers nothing new and leaks no tool instance. Nothing here
 * changes routing, permissions, sandbox policy, verification or any other tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import {
  createQuietProjection,
  QUIET_TOOL_NAMES,
  type QuietToolName,
  type QuietResult,
} from "../aies-ui/tools.ts";
import { themePaint } from "../aies-ui/paint.ts";

/** The minimal component Pi's shell accepts: `render` plus `invalidate`. */
interface ToolRowComponent {
  render(width: number): string[];
  invalidate(): void;
}

/** A row that occupies no space, so Pi hides the slot entirely. */
const EMPTY_ROW: ToolRowComponent = { render: () => [], invalidate() {} };

function textRow(lines: string[]): ToolRowComponent {
  return {
    render: () => lines,
    invalidate() {},
  };
}

/** The slice of Pi's theme the quiet renderers need; colors always come from the host. */
interface RowTheme {
  fg(color: string, text: string): string;
}

/** The slice of a `create*Tool(cwd)` instance this boundary needs. */
interface OriginalTool {
  description: string;
  parameters: unknown;
  execute: (...args: unknown[]) => Promise<unknown>;
}

/** A public Pi factory, injectable so the delegation contract is testable. */
export type QuietToolFactory = (cwd: string) => OriginalTool;

/** The six factories, one per owned tool. */
export type QuietToolFactoryMap = Record<QuietToolName, QuietToolFactory>;

const DEFAULT_FACTORIES: QuietToolFactoryMap = {
  read: createReadTool,
  bash: createBashTool,
  grep: createGrepTool,
  find: createFindTool,
  edit: createEditTool,
  write: createWriteTool,
} as unknown as QuietToolFactoryMap;

/** The working directory each host was last registered with. */
const REGISTERED_CWD = new WeakMap<ExtensionAPI, string>();

function asArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Register (or re-register) the six quiet tools for `cwd`.
 *
 * Pi keeps tools in a name-keyed map, so re-registering replaces; the WeakMap is
 * what stops a reload/resume in the same directory from building fresh instances
 * when nothing changed, and what lets a different working directory replace them.
 */
export function registerQuietTools(
  pi: ExtensionAPI,
  cwd: string,
  factories: QuietToolFactoryMap = DEFAULT_FACTORIES,
): void {
  if (REGISTERED_CWD.get(pi) === cwd) return;
  REGISTERED_CWD.set(pi, cwd);

  for (const name of QUIET_TOOL_NAMES) {
    const original = factories[name](cwd);

    pi.registerTool({
      name,
      label: name,
      description: original.description,
      parameters: original.parameters as never,

      // Execution fidelity: the original instance runs, its result object is
      // returned untouched, and no content, details, usage or schema is edited.
      async execute(toolCallId, params, signal, onUpdate) {
        return original.execute(toolCallId, params, signal, onUpdate);
      },

      renderCall(args, theme, context) {
        // Once execution starts the result slot owns the whole row; before that
        // the call slot echoes the target so the command appears immediately.
        if (context?.executionStarted === true) return EMPTY_ROW;
        const projection = createQuietProjection(name, asArgs(args));
        return textRow(
          projection.call({ expanded: false, isPartial: true, isError: false }, themePaint(theme as unknown as RowTheme)),
        );
      },

      renderResult(result, options, theme, context) {
        const projection = createQuietProjection(name, asArgs(context?.args));
        const quietResult = result as unknown as QuietResult;
        return textRow(
          projection.result(
            quietResult,
            {
              expanded: options.expanded,
              isPartial: options.isPartial,
              isError: context?.isError === true || quietResult.isError === true,
            },
            themePaint(theme as unknown as RowTheme),
          ),
        );
      },
    });
  }
}
