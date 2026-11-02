import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { type DiffFile, type DiffLine, parseUnifiedDiff } from "./diff";

export interface DiffLineRef {
  file: string;
  line: DiffLine;
}

export interface DiffViewProps {
  /** Unified diff text (one or more files). */
  patch?: string;
  /** Pre-parsed files (alternative to `patch`). */
  files?: DiffFile[];
  /** Show a header per file (default true). */
  showFileHeaders?: boolean;
  /** Enables line selection (e.g. review comments). Called for add/context/del lines. */
  onLineClick?: (ref: DiffLineRef) => void;
  /** Highlight lines (e.g. lines with comments). */
  isLineMarked?: (ref: DiffLineRef) => boolean;
  className?: string;
}

const MARKER: Record<DiffLine["kind"], string> = {
  add: "+",
  del: "-",
  context: " ",
  hunk: "",
  meta: "",
};

/**
 * Unified diff with old/new line numbers, +/- text markers (not color alone)
 * and tinted rows. Horizontal scrolling is confined to the diff block.
 */
export function DiffView({
  patch,
  files: given,
  showFileHeaders = true,
  onLineClick,
  isLineMarked,
  className,
}: DiffViewProps) {
  const files = useMemo(() => given ?? parseUnifiedDiff(patch ?? ""), [given, patch]);
  if (files.length === 0) {
    return <p className="text-sm text-muted">No changes.</p>;
  }
  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {files.map((f, fi) => (
        <section
          // biome-ignore lint/suspicious/noArrayIndexKey: files can repeat paths in odd patches
          key={`${f.path}-${fi}`}
          className="min-w-0 overflow-hidden rounded-md border border-border"
          aria-label={`Diff of ${f.path || "file"}`}
        >
          {showFileHeaders && (
            <header className="flex min-w-0 items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono" title={f.path}>
                {f.status === "renamed" && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              </span>
              <span className="shrink-0 font-mono text-xs">
                <span className="text-success">
                  +{f.additions}
                  <span className="sr-only"> added</span>
                </span>{" "}
                <span className="text-danger">
                  -{f.deletions}
                  <span className="sr-only"> deleted</span>
                </span>
              </span>
            </header>
          )}
          {f.status === "binary" ? (
            <p className="px-3 py-2 text-sm text-muted">Binary file not shown.</p>
          ) : (
            <div className="max-w-full overflow-x-auto overscroll-x-contain">
              <table className="w-full border-collapse font-mono text-xs leading-5">
                <tbody>
                  {f.lines.map((l, li) => {
                    const ref = { file: f.path, line: l };
                    const selectable =
                      !!onLineClick &&
                      (l.kind === "add" || l.kind === "del" || l.kind === "context");
                    const marked = isLineMarked?.(ref) ?? false;
                    return (
                      <tr
                        // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
                        key={li}
                        className={cn(
                          l.kind === "add" && "bg-diff-add",
                          l.kind === "del" && "bg-diff-del",
                          l.kind === "hunk" && "bg-diff-hunk text-muted",
                          l.kind === "meta" && "text-muted",
                          marked && "outline outline-1 -outline-offset-1 outline-warning",
                        )}
                      >
                        <td className="w-10 select-none border-r border-border px-1.5 text-right text-subtle tabular-nums">
                          {l.oldLine ?? ""}
                        </td>
                        <td className="w-10 select-none border-r border-border px-1.5 text-right text-subtle tabular-nums">
                          {l.newLine ?? ""}
                        </td>
                        <td
                          className={cn(
                            "w-5 select-none text-center",
                            l.kind === "add" && "text-success",
                            l.kind === "del" && "text-danger",
                          )}
                          aria-label={
                            l.kind === "add" ? "added" : l.kind === "del" ? "deleted" : undefined
                          }
                        >
                          {MARKER[l.kind]}
                        </td>
                        <td className="whitespace-pre pr-3">
                          {selectable ? (
                            <button
                              type="button"
                              className="block w-full cursor-pointer text-left whitespace-pre hover:underline focus-visible:underline"
                              onClick={() => onLineClick?.(ref)}
                              aria-label={`Comment on line ${l.newLine ?? l.oldLine}`}
                            >
                              {l.text || " "}
                            </button>
                          ) : (
                            l.text
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
