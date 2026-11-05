import { type ReactNode, useEffect, useId, useState } from "react";
import { CountBadge } from "../../components/ui/Badge";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { cn } from "../../lib/cn";
import { usePanels } from "../../sync/store";
import { ChangesTab, useWorkspaceDiff } from "./Changes";
import type { InspectorTab } from "./context";
import { ExtensionsSection, TaskSection } from "./Details";
import { FilesTab } from "./Files";
import type { SessionContext } from "./hooks";
import type { SessionActions } from "./SessionActions";

export interface InspectorProps {
  ctx: SessionContext;
  actions: SessionActions;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  openPath: { path: string; nonce: number } | null;
  className?: string;
  /** Hide the visible heading (the drawer has its own). */
  hideTitle?: boolean;
}

/** Inspector: Changes, Files (read-only), Task, Extensions. */
export function Inspector({
  ctx,
  actions,
  tab,
  onTab,
  openPath,
  className,
  hideTitle,
}: InspectorProps) {
  const prefix = useId();
  const panels = usePanels(ctx.session.id);
  const changed = ctx.workspace?.git.changedFiles ?? 0;
  const diff = useWorkspaceDiff(ctx);
  const [visited, setVisited] = useState<Set<InspectorTab>>(() => new Set([tab]));
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))), [tab]);
  const panes: { id: InspectorTab; body: ReactNode; flush?: boolean }[] = [
    { id: "changes", body: <ChangesTab ctx={ctx} diff={diff} /> },
    { id: "files", body: <FilesTab ctx={ctx} diff={diff} openPath={openPath} />, flush: true },
    { id: "task", body: <TaskSection ctx={ctx} actions={actions} /> },
    { id: "extensions", body: <ExtensionsSection ctx={ctx} /> },
  ];
  return (
    <aside
      data-testid="inspector"
      aria-label="Inspector"
      className={cn("flex min-h-0 min-w-0 flex-col bg-surface", className)}
    >
      {!hideTitle && <h2 className="sr-only">Inspector</h2>}
      <Tabs
        idPrefix={prefix}
        label="Inspector"
        value={tab}
        onChange={(t) => onTab(t as InspectorTab)}
        className="shrink-0 px-2"
        scrollable
        tabs={[
          {
            id: "changes",
            label: "Changes",
            badge: <CountBadge count={changed} label="changed files" tone="neutral" />,
          },
          { id: "files", label: "Files" },
          { id: "task", label: "Task" },
          {
            id: "extensions",
            label: "Extensions",
            badge: <CountBadge count={panels.length} label="panels" tone="neutral" />,
          },
        ]}
      />
      {panes.map((p) => (
        <TabPanel
          key={p.id}
          idPrefix={prefix}
          id={p.id}
          hidden={tab !== p.id}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
            p.flush ? "p-0" : "p-3",
          )}
        >
          {(tab === p.id || visited.has(p.id)) && p.body}
        </TabPanel>
      ))}
    </aside>
  );
}
