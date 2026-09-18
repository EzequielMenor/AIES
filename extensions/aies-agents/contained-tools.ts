/**
 * Contained mutation tools for Worker child agents (AIES-006).
 *
 * Enforces Layer 1 & Layer 2 workspace containment on Worker's direct editing
 * tools (`edit` and `write`), ensuring that no tool call can write outside
 * the designated workspace root or mutate protected files.
 */

import { resolve } from "node:path";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * Check if a path is strictly inside or equal to the workspace root.
 */
export function isPathInsideWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolvedTarget = resolve(workspaceRoot, filePath);
  const resolvedRoot = resolve(workspaceRoot);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + "/");
}

const PROTECTED_FILENAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
];

export function isProtectedFile(filePath: string): boolean {
  const parts = filePath.split("/");
  const fileName = parts[parts.length - 1];
  return PROTECTED_FILENAMES.includes(fileName) || fileName.endsWith(".pem") || fileName.endsWith(".key");
}

/**
 * Create a workspace-contained `write` tool definition for Worker.
 */
export function createContainedWriteToolDefinition(
  workspaceRoot: string,
): ToolDefinition<any> {
  const nativeWrite = createWriteToolDefinition(workspaceRoot);

  return {
    ...nativeWrite,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetPath = params?.path ?? "";
      if (!isPathInsideWorkspace(targetPath, workspaceRoot)) {
        return {
          content: [
            {
              type: "text",
              text: `Write blocked by Worker permission policy: path "${targetPath}" is outside workspace root`,
            },
          ],
          isError: true,
        };
      }

      if (isProtectedFile(targetPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Write blocked by Worker permission policy: protected file "${targetPath}" cannot be modified directly`,
            },
          ],
          isError: true,
        };
      }

      return nativeWrite.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

/**
 * Create a workspace-contained `edit` tool definition for Worker.
 */
export function createContainedEditToolDefinition(
  workspaceRoot: string,
): ToolDefinition<any> {
  const nativeEdit = createEditToolDefinition(workspaceRoot);

  return {
    ...nativeEdit,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const targetPath = params?.path ?? "";
      if (!isPathInsideWorkspace(targetPath, workspaceRoot)) {
        return {
          content: [
            {
              type: "text",
              text: `Edit blocked by Worker permission policy: path "${targetPath}" is outside workspace root`,
            },
          ],
          isError: true,
        };
      }

      if (isProtectedFile(targetPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Edit blocked by Worker permission policy: protected file "${targetPath}" cannot be modified directly`,
            },
          ],
          isError: true,
        };
      }

      return nativeEdit.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}
