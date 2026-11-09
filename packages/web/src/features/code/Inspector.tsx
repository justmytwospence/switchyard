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
import { GitHubStatus, PullRequest } from "./PullRequest";
import type { SessionActions } from "./SessionActions";
import type { PullRequestState } from "./usePullRequest";

export interface InspectorProps {
  ctx: SessionContext;
  github: PullRequestState;
  visible: boolean;
  actions: SessionActions;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  openPath: { path: string; nonce: number } | null;
  className?: string;
  /** Hide the visible heading (the drawer has its own). */
  hideTitle?: boolean;
}

/** Inspector: Changes, Files (read-only), Details, PR and Extensions. */
export function Inspector({
  ctx,
  github,
  visible,
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
    {
      id: "task",
      body: (
        <div className="flex flex-col gap-4">
          <GitHubStatus ctx={ctx} state={github} onOpen={() => onTab("pr")} />
          <TaskSection ctx={ctx} actions={actions} />
        </div>
      ),
    },
    { id: "pr", body: <PullRequest ctx={ctx} state={github} active={visible && tab === "pr"} /> },
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
          { id: "task", label: "Details" },
          ...(github.snapshot?.pullRequest ? [{ id: "pr", label: "PR" }] : []),
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
