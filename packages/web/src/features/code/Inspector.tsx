import { useId } from "react";
import { CountBadge } from "../../components/ui/Badge";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { cn } from "../../lib/cn";
import { usePanels } from "../../sync/store";
import { ChangesTab } from "./Changes";
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
      <TabPanel
        idPrefix={prefix}
        id={tab}
        className="relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain p-3"
      >
        {tab === "changes" && <ChangesTab ctx={ctx} />}
        {tab === "files" && <FilesTab ctx={ctx} openPath={openPath} />}
        {tab === "task" && <TaskSection ctx={ctx} actions={actions} />}
        {tab === "extensions" && <ExtensionsSection ctx={ctx} />}
      </TabPanel>
    </aside>
  );
}
