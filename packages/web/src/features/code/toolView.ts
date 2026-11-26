/**
 * What a tool call is: the one-line label of its transcript row and the detail shown when the
 * row is opened. The derivation lives in `@switchyard/protocol` (`tool-view.ts`) so the host,
 * adapters and every client agree; a host or adapter view on the item is applied on top.
 */
import {
  applyToolView,
  describeTool,
  type ToolItemData,
  type ToolView,
} from "@switchyard/protocol";

export {
  applyToolView,
  describeTool,
  editDiffFiles,
  relativePath,
  stringifyArgs,
  type ToolDetail,
  type ToolKind,
  type ToolView,
  toolLabel,
} from "@switchyard/protocol";

/** The view of a transcript tool item: derived from its arguments, then what its host said. */
export function toolViewOf(
  data: Pick<ToolItemData, "name" | "args" | "view">,
  cwd: string | null,
): ToolView {
  return applyToolView(describeTool(data, cwd), data.view);
}
