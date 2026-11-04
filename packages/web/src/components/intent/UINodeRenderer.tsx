import type { UINode, UIRef } from "@switchyard/protocol";
import { ChevronRight, CircleCheck, CircleX, FileCode, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Spinner";
import { TabPanel, Tabs } from "../ui/Tabs";
import { CodeBlock } from "./CodeBlock";
import { ConfirmRenderer } from "./ConfirmRenderer";
import { IntentContext, type IntentHandlers, useIntent } from "./context";
import { DiffView } from "./DiffView";
import { FormRenderer } from "./FormRenderer";
import { Markdown } from "./Markdown";

export interface UINodeRendererProps extends IntentHandlers {
  node: UINode;
  className?: string;
}

/**
 * Renders a portable UINode tree. Interactive nodes (form, confirm, actions)
 * respond through the handlers given here (or an enclosing IntentContext).
 */
export function UINodeRenderer({ node, className, ...handlers }: UINodeRendererProps) {
  const parent = useIntent();
  const hasOwn = Object.values(handlers).some((v) => v !== undefined);
  const content = (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      <NodeView node={node} />
    </div>
  );
  if (!hasOwn) return content;
  return (
    <IntentContext.Provider value={{ ...parent, ...stripUndefined(handlers) }}>
      {content}
    </IntentContext.Provider>
  );
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const TONE_TEXT = {
  default: "text-text",
  muted: "text-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export function NodeView({ node }: { node: UINode }) {
  switch (node.t) {
    case "text":
      return (
        <p
          className={cn(
            "text-sm break-words whitespace-pre-wrap",
            TONE_TEXT[node.tone ?? "default"],
          )}
        >
          {node.text}
        </p>
      );
    case "markdown":
      return <Markdown text={node.text} />;
    case "code":
      return <CodeBlock text={node.text} lang={node.lang} maxHeight="24rem" />;
    case "diff":
      return <DiffView patch={node.patch} />;
    case "list":
      return <ListView node={node} />;
    case "table":
      return (
        <div className="max-w-full overflow-x-auto overscroll-x-contain rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface-2">
              <tr>
                {node.columns.map((c, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns are positional
                    key={i}
                    scope="col"
                    className="border-b border-border px-3 py-1.5 text-left font-medium"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((r, ri) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
                <tr key={ri} className="border-b border-border last:border-b-0">
                  {r.map((cell, ci) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                    <td key={ci} className="px-3 py-1.5 align-top break-words">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "section":
      return <SectionView node={node} />;
    case "tabs":
      return <TabsView node={node} />;
    case "progress":
      return <ProgressView node={node} />;
    case "ref":
      return <RefView refValue={node.ref} label={node.label} />;
    case "form":
      return <FormRenderer node={node} />;
    case "confirm":
      return <ConfirmRenderer node={node} />;
    case "actions":
      return <ActionsView node={node} />;
    default:
      return null;
  }
}

function Children({ nodes }: { nodes: UINode[] }) {
  return (
    <>
      {nodes.map((n, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: UINode trees have no ids
        <NodeView key={i} node={n} />
      ))}
    </>
  );
}

function ListView({ node }: { node: Extract<UINode, { t: "list" }> }) {
  const Tag = node.ordered ? "ol" : "ul";
  return (
    <Tag
      className={cn(
        "flex flex-col gap-1.5 pl-5 text-sm",
        node.ordered ? "list-decimal" : "list-disc",
      )}
    >
      {node.items.map((item, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list items are positional
        <li key={i} className="min-w-0">
          <div className="flex min-w-0 flex-col gap-2">
            <NodeView node={item} />
          </div>
        </li>
      ))}
    </Tag>
  );
}

function SectionView({ node }: { node: Extract<UINode, { t: "section" }> }) {
  if (node.collapsible) {
    return (
      <details className="group min-w-0" open>
        <summary className="tap flex cursor-pointer list-none items-center gap-1.5 py-1 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="size-4 shrink-0 transition-transform group-open:rotate-90"
          />
          {node.title ?? "Details"}
        </summary>
        <div className="flex min-w-0 flex-col gap-3 border-l border-border pl-3 ml-2 mt-1">
          <Children nodes={node.children} />
        </div>
      </details>
    );
  }
  return (
    <section className="flex min-w-0 flex-col gap-2">
      {node.title && <h3 className="text-sm font-semibold">{node.title}</h3>}
      <Children nodes={node.children} />
    </section>
  );
}

function TabsView({ node }: { node: Extract<UINode, { t: "tabs" }> }) {
  const prefix = useId();
  const [active, setActive] = useState(node.tabs[0]?.id ?? "");
  const current = node.tabs.find((t) => t.id === active) ?? node.tabs[0];
  if (!current) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Tabs
        label="Sections"
        idPrefix={prefix}
        tabs={node.tabs.map((t) => ({ id: t.id, label: t.label }))}
        value={current.id}
        onChange={setActive}
        scrollable
      />
      <TabPanel idPrefix={prefix} id={current.id} className="flex min-w-0 flex-col gap-3">
        <Children nodes={current.children} />
      </TabPanel>
    </div>
  );
}

function ProgressView({ node }: { node: Extract<UINode, { t: "progress" }> }) {
  const status = node.status ?? "running";
  const Icon = status === "ok" ? CircleCheck : status === "error" ? CircleX : LoaderCircle;
  const statusText = status === "ok" ? "Done" : status === "error" ? "Failed" : "In progress";
  const pct = node.value === undefined ? null : Math.round(node.value * 100);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2 text-sm">
        {status === "running" ? (
          <Spinner className="size-4 text-info" />
        ) : (
          <Icon
            aria-hidden
            className={cn(
              "size-4 shrink-0",
              status === "ok" && "text-success",
              status === "error" && "text-danger",
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        <span className="shrink-0 text-xs text-muted">
          {statusText}
          {pct !== null ? ` · ${pct}%` : ""}
        </span>
      </div>
      {pct !== null && (
        <div
          role="progressbar"
          aria-label={node.label}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 overflow-hidden rounded-full bg-surface-3"
        >
          <div
            className={cn(
              "h-full rounded-full",
              status === "error" ? "bg-danger" : status === "ok" ? "bg-success" : "bg-accent",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

export function refHref(ref: UIRef): string | null {
  switch (ref.kind) {
    case "session":
      return `/code/${encodeURIComponent(ref.sessionId)}`;
    case "task":
      return `/tasks/${encodeURIComponent(ref.taskId)}`;
    default:
      return null;
  }
}

function RefView({ refValue, label }: { refValue: UIRef; label: string }) {
  const { onOpenFile } = useIntent();
  const href = refHref(refValue);
  if (href) {
    return (
      <Link to={href} className="text-sm text-accent underline underline-offset-2">
        {label}
      </Link>
    );
  }
  if (refValue.kind === "file") {
    if (onOpenFile) {
      return (
        <button
          type="button"
          onClick={() => onOpenFile(refValue.path)}
          className="inline-flex min-w-0 items-center gap-1 text-left text-sm text-accent underline underline-offset-2"
        >
          <FileCode aria-hidden className="size-4 shrink-0" />
          <span className="truncate">{label || refValue.path}</span>
        </button>
      );
    }
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1 font-mono text-sm"
        title={refValue.path}
      >
        <FileCode aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="truncate">{label || refValue.path}</span>
      </span>
    );
  }
  if (refValue.kind !== "native_session") return <span className="text-sm">{label}</span>;
  return (
    <span className="text-sm" title={refValue.sessionFile}>
      {label} <span className="text-muted">(native Pi session, not imported)</span>
    </span>
  );
}

function ActionsView({ node }: { node: Extract<UINode, { t: "actions" }> }) {
  const { onRespond, onAction, busy, disabled } = useIntent();
  if (disabled) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap lg:flex-col">
      {node.actions.map((a) => (
        <Button
          key={a.id}
          className="h-auto min-h-9 min-w-0 justify-start py-1.5 text-left whitespace-normal sm:justify-center sm:text-center"
          variant={a.tone === "primary" ? "primary" : a.tone === "danger" ? "danger" : "secondary"}
          disabled={busy || (!onRespond && !onAction)}
          onClick={() => {
            if (onRespond) onRespond({ kind: "action", actionId: a.id });
            else onAction?.(a.id);
          }}
        >
          {a.label}
        </Button>
      ))}
    </div>
  );
}
