import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { CountBadge } from "../../components/ui/Badge";
import { TabPanel, Tabs } from "../../components/ui/Tabs";
import { cn } from "../../lib/cn";
import { useContributions } from "../../sync/store";
import { AdapterPanel } from "./AdapterPanel";
import { adapterTabId } from "./adapterIdentity";
import { ChangesTab, useWorkspaceDiff } from "./Changes";
import type { InspectorTab } from "./context";
import { ExtensionsDisclosure, SessionIssueDetails, TaskSection } from "./Details";
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

/** Inspector: Changes, Files (read-only), Details (with the extensions) and PR. */
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
  // `?tab=extensions` (older links) is Details with its Extensions line open.
  const shown: InspectorTab = tab === "extensions" ? "task" : tab;
  const allContributions = useContributions(ctx.session.id);
  const contributions = useMemo(
    () => allContributions.filter((p) => p.contribution?.placement === "session.panel"),
    [allContributions],
  );
  const changed = ctx.workspace?.git.changedFiles ?? 0;
  const diff = useWorkspaceDiff(ctx);
  const [visited, setVisited] = useState<Set<InspectorTab>>(() => new Set([shown]));
  useEffect(() => setVisited((v) => (v.has(shown) ? v : new Set(v).add(shown))), [shown]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: discard previously mounted panes when changing sessions
  useEffect(() => setVisited(new Set(["changes"])), [ctx.session.id]);
  useEffect(() => {
    if (tab.startsWith("adapter:") && !contributions.some((p) => adapterTabId(p) === tab))
      onTab("changes");
  }, [contributions, tab, onTab]);
  const panes: { id: InspectorTab; body: ReactNode; flush?: boolean }[] = [
    { id: "changes", body: <ChangesTab ctx={ctx} diff={diff} /> },
    { id: "files", body: <FilesTab ctx={ctx} diff={diff} openPath={openPath} />, flush: true },
    {
      id: "task",
      body: (
        <div className="flex flex-col gap-4">
          <SessionIssueDetails ctx={ctx} />
          <GitHubStatus ctx={ctx} state={github} onOpen={() => onTab("pr")} />
          <TaskSection ctx={ctx} actions={actions} />
          <ExtensionsDisclosure ctx={ctx} open={tab === "extensions"} />
        </div>
      ),
    },
    { id: "pr", body: <PullRequest ctx={ctx} state={github} active={visible && tab === "pr"} /> },
    ...contributions.map((panel) => ({
      id: adapterTabId(panel),
      body: <AdapterPanel ctx={ctx} panel={panel} allowFrame />,
    })),
  ];
  return (
    <aside
      data-testid="inspector"
      data-keyboard-pane
      tabIndex={-1}
      aria-label="Inspector"
      className={cn("flex min-h-0 min-w-0 flex-col bg-surface", className)}
    >
      {!hideTitle && <h2 className="sr-only">Inspector</h2>}
      <Tabs
        idPrefix={prefix}
        label="Inspector"
        value={shown}
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
          ...contributions.map((p) => ({ id: adapterTabId(p), label: p.title })),
        ]}
      />
      {panes.map((p) => (
        <TabPanel
          key={`${ctx.session.id}:${p.id}`}
          idPrefix={prefix}
          id={p.id}
          hidden={shown !== p.id}
          className={cn(
            "relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
            p.flush ? "p-0" : "p-3",
          )}
        >
          {(shown === p.id || visited.has(p.id)) && p.body}
        </TabPanel>
      ))}
    </aside>
  );
}
