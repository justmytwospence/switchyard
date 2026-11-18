import type { Session } from "@switchyard/protocol";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderGit2,
  GitBranch,
  MessageCircleQuestion,
  Plus,
  Search,
  Server,
  SlidersHorizontal,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu, type MenuHeading, type MenuItem } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import {
  REVIEW_STATUS,
  RUNTIME_STATUS,
  StatusChip,
  type StatusInfo,
} from "../../components/ui/StatusChip";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { useFilter } from "../../prefs";
import { errorMessage } from "../../sync/api";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import { isMac } from "../palette/CommandPalette";
import { usePalette } from "../palette/registry";
import { ProjectSuggestions } from "../settings/ProjectSuggestions";
import { emptyViewState, shownIn } from "../views/describe";
import { useViewDescriber, ViewSelect } from "../views/ViewSelect";
import { AdapterSlot } from "./AdapterSlots";
import { codeApi } from "./api";
import {
  buildNavTree,
  DEFAULT_SORT,
  NAV_LAYOUTS,
  NAV_SORTS,
  type NavEmptyBranch,
  type NavFilter,
  type NavGroup,
  type NavLayout,
  type NavRow,
  type NavSort,
  navGroupKeys,
  navTreeIsEmpty,
  normalizeLayout,
  projectIdOfGroup,
  STATUS_BUCKETS,
  sessionsNeedingAttention,
  statusBucket,
  statusSummary,
} from "./model";
import { ViewsDialog } from "./ViewsDialog";
import { useSelectedView } from "./views";

interface NavPrefs {
  filter: NavFilter;
  query: string;
  collapsed: string[];
  layout: NavLayout;
  showSubagents: boolean;
  sorts: Partial<Record<NavLayout, NavSort>>;
  needsInputFirst: boolean;
  /** Branch rows showing their other sessions. */
  expanded: string[];
}

/** The phone session list defaults to Recent; the desktop navigator to Projects. */
function defaultPrefs(screen: boolean): NavPrefs {
  return {
    filter: "active",
    query: "",
    collapsed: [],
    layout: screen ? "recent" : "projects",
    showSubagents: false,
    sorts: {},
    needsInputFirst: true,
    expanded: [],
  };
}

export interface NavigatorProps {
  selectedId: string | null;
  onNewSession: (projectId?: string) => void;
  /** "pane" for the desktop navigator, "screen" for the mobile session list. */
  variant: "pane" | "screen";
  className?: string;
  style?: CSSProperties;
}

/** Sessions in a chosen layout, with search, filters, view options, collapse controls and New session. */
export function Navigator({ selectedId, onNewSession, variant, className, style }: NavigatorProps) {
  const screen = variant === "screen";
  const defaults = defaultPrefs(screen);
  const [stored, setPrefs] = useFilter<NavPrefs>(screen ? "sessionList" : "navigator", defaults);
  const prefs = {
    ...defaults,
    ...stored,
    layout: normalizeLayout(stored?.layout, defaults.layout),
    expanded: stored?.expanded ?? [],
  };
  const hydrated = useSyncStore((s) => s.hydrated);
  const projects = useSyncStore((s) => s.projects);
  const workspaces = useSyncStore((s) => s.workspaces);
  const sessions = useSyncStore((s) => s.sessions);
  const sort = prefs.sorts?.[prefs.layout] ?? DEFAULT_SORT[prefs.layout];
  const hostsMap = useSyncStore((s) => s.hosts);
  const { views, describe: describeView } = useViewDescriber();
  const [selectedViewId, setSelectedViewId] = useSelectedView();
  const [editingView, setEditingView] = useState<string | "new" | null>(null);
  const view = (selectedViewId ? views[selectedViewId] : null) ?? null;
  const surfaces = useSyncStore((s) => s.surfaces);
  const shownText = view ? shownIn(view, Object.values(surfaces), hostsMap) : null;
  const attention = useSyncStore((s) => s.attention);
  const interactions = useSyncStore((s) => s.interactions);
  const hosts = useHosts();
  const projectList = useProjects();
  const tree = useMemo(
    () =>
      buildNavTree(
        { projects, workspaces, sessions, hosts: hostsMap, attention, interactions },
        {
          filter: prefs.filter,
          query: prefs.query,
          layout: prefs.layout,
          showSubagents: prefs.showSubagents,
          sort,
          needsInputFirst: prefs.needsInputFirst,
          view,
        },
      ),
    [
      projects,
      workspaces,
      sessions,
      hostsMap,
      attention,
      interactions,
      prefs.filter,
      prefs.query,
      prefs.layout,
      prefs.showSubagents,
      sort,
      prefs.needsInputFirst,
      view,
    ],
  );
  const navigate = useNavigate();
  const summary = useMemo(() => {
    const attn = sessionsNeedingAttention(attention, interactions);
    const rows = Object.values(sessions)
      .filter((s) => s.archivedAt === null && s.provenance !== "subagent")
      .map((session) => ({ session, bucket: statusBucket(session, attn.has(session.id)) }));
    return statusSummary(rows);
  }, [sessions, attention, interactions]);
  const collapsed = new Set(prefs.collapsed);
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPrefs({ ...prefs, collapsed: [...next] });
  };
  const expansion: RowExpansion = {
    expanded: new Set(prefs.expanded),
    toggleRow: (key) => {
      const next = new Set(prefs.expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setPrefs({ ...prefs, expanded: [...next] });
    },
  };
  const allKeys = navGroupKeys(tree);
  const viewItems: (MenuItem | MenuHeading | "separator")[] = [
    { id: "layout-heading", heading: "Group branches" },
    ...NAV_LAYOUTS.map(
      (l): MenuItem => ({
        id: `layout-${l.value}`,
        label: l.label,
        hint: l.hint,
        kind: "radio",
        checked: prefs.layout === l.value,
        onSelect: () => setPrefs({ ...prefs, layout: l.value }),
      }),
    ),
    "separator",
    { id: "sort-heading", heading: "Sort sessions" },
    ...NAV_SORTS.map(
      (s): MenuItem => ({
        id: `sort-${s.value}`,
        label: s.label,
        hint: s.value === DEFAULT_SORT[prefs.layout] ? `${s.hint} (default)` : s.hint,
        kind: "radio",
        checked: sort === s.value,
        onSelect: () => setPrefs({ ...prefs, sorts: { ...prefs.sorts, [prefs.layout]: s.value } }),
      }),
    ),
    {
      id: "needs-first",
      label: "Needs input first",
      kind: "checkbox",
      checked: prefs.needsInputFirst,
      onSelect: () => setPrefs({ ...prefs, needsInputFirst: !prefs.needsInputFirst }),
    },
    "separator",
    {
      id: "subagents",
      label: "Show subagents",
      hint: "Nested under the session that started them",
      kind: "checkbox",
      checked: prefs.showSubagents,
      onSelect: () => setPrefs({ ...prefs, showSubagents: !prefs.showSubagents }),
    },
  ];
  const anyExpanded = allKeys.some((k) => !collapsed.has(k));

  const filterOptions: { value: NavFilter; label: string }[] = screen
    ? [
        { value: "active", label: "Active" },
        { value: "attention", label: "Needs input" },
        { value: "all", label: "All" },
      ]
    : [
        { value: "active", label: "Active" },
        { value: "all", label: "All" },
      ];

  let body: ReactNode;
  if (!hydrated) {
    body = <LoadingState label="Loading sessions…" />;
  } else if (hosts.length === 0) {
    body = (
      <EmptyState
        icon={<Server className="size-8" />}
        title="Connect a host"
        description="Sessions run on a host: a computer with Pi and the Switchyard host agent."
        action={{ label: "Connect a host", to: "/settings/hosts" }}
        secondaryAction={
          projectList.length === 0
            ? { label: "Add a project", to: "/settings/projects" }
            : undefined
        }
      />
    );
  } else if (projectList.length === 0) {
    const first = hosts.find((h) => !h.revokedAt && h.connectivity === "connected");
    body = (
      <>
        {first && <ProjectSuggestions host={first} compact />}
        <EmptyState
          icon={<FolderGit2 className="size-8" />}
          title="Add a project"
          description="Point Switchyard at a Git checkout on one of your hosts to start sessions there."
          action={{ label: "Add a project", to: "/settings/projects" }}
        />
      </>
    );
  } else if (navTreeIsEmpty(tree)) {
    body = prefs.query ? (
      <EmptyState
        icon={<Search className="size-8" />}
        title="No matches"
        description={`Nothing matches "${prefs.query}".`}
        action={{ label: "Clear search", onClick: () => setPrefs({ ...prefs, query: "" }) }}
      />
    ) : view ? (
      <EmptyState
        {...emptyViewState(view, {
          filter: prefs.filter,
          source: describeView(view),
          origin: window.location.host,
        })}
        action={{ label: "New session", onClick: () => onNewSession() }}
        secondaryAction={
          prefs.filter !== "all"
            ? { label: "Show all", onClick: () => setPrefs({ ...prefs, filter: "all" }) }
            : { label: "All sessions", onClick: () => setSelectedViewId(null) }
        }
      />
    ) : (
      <EmptyState
        title={
          prefs.filter === "attention"
            ? "Nothing needs your input"
            : prefs.filter === "active"
              ? "No active sessions"
              : "No sessions yet"
        }
        description="Start a session in one of your projects."
        action={{ label: "New session", onClick: () => onNewSession() }}
        secondaryAction={
          prefs.filter !== "all"
            ? { label: "Show all", onClick: () => setPrefs({ ...prefs, filter: "all" }) }
            : undefined
        }
      />
    );
  } else if (prefs.layout === "recent") {
    body = (
      <ul aria-label="Recent sessions" className="flex min-w-0 flex-col gap-0.5 pb-4">
        {tree.rows.map((row) => (
          <SessionRow
            key={row.key}
            row={row}
            indent={0}
            selectedId={selectedId}
            screen={screen}
            expansion={expansion}
          />
        ))}
      </ul>
    );
  } else {
    body = (
      <ul
        aria-label={
          prefs.layout === "hosts" ? "Hosts" : prefs.layout === "status" ? "Status" : "Projects"
        }
        className="flex min-w-0 flex-col gap-1 pb-4"
      >
        {tree.groups.map((g) => (
          <GroupNode
            key={g.key}
            group={g}
            depth={0}
            collapsed={collapsed}
            toggle={toggle}
            selectedId={selectedId}
            screen={screen}
            onNewSession={onNewSession}
            expansion={expansion}
          />
        ))}
      </ul>
    );
  }

  return (
    <nav
      data-testid="navigator"
      data-keyboard-scope
      data-keyboard-default
      data-keyboard-pane
      tabIndex={-1}
      aria-label="Sessions"
      style={style}
      className={cn("flex min-h-0 min-w-0 flex-col bg-surface", className)}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <h2 className={cn("min-w-0 flex-1 font-semibold", screen ? "text-lg" : "text-sm")}>
            Sessions
          </h2>
          <IconButton
            data-testid="open-palette"
            label={`Search (${isMac() ? "⌘K" : "Ctrl+K"})`}
            icon={<Search className="size-4" />}
            onClick={() => usePalette.getState().setOpen(true)}
          />
          <Button
            data-testid="new-session"
            size="sm"
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => onNewSession()}
            disabled={!hydrated || hosts.length === 0 || projectList.length === 0}
          >
            New session
          </Button>
        </div>
        {summary.length > 0 && (
          <p
            data-testid="status-summary"
            className="flex flex-wrap items-center gap-x-1 text-xs text-muted"
          >
            {summary.map((b, i) => (
              <span key={b.bucket} className="inline-flex items-center gap-1">
                {i > 0 && <span aria-hidden>·</span>}
                <button
                  type="button"
                  className="tap rounded underline-offset-2 hover:underline"
                  onClick={() =>
                    navigate(`/code/${encodeURIComponent(b.first)}`, { state: BACK_STATE })
                  }
                >
                  {b.count} {STATUS_BUCKETS.find((x) => x.value === b.bucket)?.short}
                </button>
              </span>
            ))}
          </p>
        )}
        {hydrated && (hosts.length === 0 || projectList.length === 0) && (
          <p className="text-xs text-muted">
            {hosts.length === 0
              ? "Connect a host to start sessions."
              : "Add a project to start sessions."}
          </p>
        )}
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle"
          />
          <TextInput
            type="search"
            aria-label="Search sessions"
            data-keyboard-search
            placeholder="Search sessions, branches"
            value={prefs.query}
            onChange={(e) => setPrefs({ ...prefs, query: e.target.value })}
            className="pl-8"
          />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1">
            <ViewSelect allLabel="All sessions" className="min-w-0 flex-1" />
            <Button onClick={() => setEditingView(view?.id ?? "new")}>
              {view ? "Edit" : "New view"}
            </Button>
          </div>
          {view && <p className="truncate text-subtle text-xs">{describeView(view)}</p>}
          {shownText && <p className="truncate text-subtle text-xs">Shown in: {shownText}</p>}
        </div>
        <ViewsDialog
          editing={editingView}
          onClose={() => setEditingView(null)}
          onSaved={(id) => setSelectedViewId(id)}
        />
        <div className="flex min-w-0 items-center gap-1">
          <SegmentedControl
            label="Session filter"
            options={filterOptions}
            value={prefs.filter}
            onChange={(v) => setPrefs({ ...prefs, filter: v })}
            className="min-w-0 flex-1"
            block
          />
          <Menu
            label="View options"
            items={viewItems}
            trigger={(p) => (
              <IconButton
                {...p}
                label="View options"
                icon={<SlidersHorizontal className="size-4" />}
              />
            )}
          />
          {tree.groups.length > 0 && (
            <IconButton
              label={anyExpanded ? "Collapse all" : "Expand all"}
              icon={
                anyExpanded ? (
                  <ChevronsDownUp className="size-4" />
                ) : (
                  <ChevronsUpDown className="size-4" />
                )
              }
              onClick={() => setPrefs({ ...prefs, collapsed: anyExpanded ? allKeys : [] })}
            />
          )}
        </div>
      </div>
      <AdapterSlot sessionId={selectedId} placement="sidebar.header" />
      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pt-2">
        {body}
      </div>
      <AdapterSlot sessionId={selectedId} placement="sidebar.footer" />
    </nav>
  );
}

function GroupHeader({ group, depth, open }: { group: NavGroup; depth: number; open: boolean }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  if (depth === 0) {
    return (
      <>
        <Chevron aria-hidden className="size-4 shrink-0 text-muted" />
        {group.kind === "host" && <Server aria-hidden className="size-3.5 shrink-0 text-muted" />}
        <span className="min-w-0 flex-1 truncate">
          {group.label}
          {group.detail && (
            <span className="ml-1.5 text-xs font-normal text-muted">{group.detail}</span>
          )}
        </span>
        {group.hostState && group.hostState !== "connected" && (
          <StatusChip kind="host" value={group.hostState} size="sm" />
        )}
        <span className="shrink-0 text-xs font-normal text-muted">
          {group.sessionCount}
          <span className="sr-only"> branches</span>
        </span>
      </>
    );
  }
  return (
    <>
      <Chevron aria-hidden className="size-3.5 shrink-0 text-muted" />
      <FolderGit2 aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-sm">{group.label}</span>
    </>
  );
}

/** Which rows show their other sessions (stored, or forced open). */
interface RowExpansion {
  expanded: Set<string>;
  toggleRow: (key: string) => void;
}

function GroupNode({
  group,
  depth,
  collapsed,
  toggle,
  selectedId,
  screen,
  onNewSession,
  expansion,
}: {
  group: NavGroup;
  depth: number;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  selectedId: string | null;
  screen: boolean;
  onNewSession: (projectId?: string) => void;
  expansion: RowExpansion;
}) {
  const open = !collapsed.has(group.key);
  const pid = group.kind === "project" ? projectIdOfGroup(group.key) : null;
  return (
    <li className="min-w-0">
      <div className="group/row flex min-w-0 items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggle(group.key)}
          className={cn(
            "tap flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left hover:bg-surface-2",
            depth === 0 ? "px-1.5 py-1.5 text-sm font-semibold" : "py-1 pr-1.5 pl-4",
          )}
        >
          <GroupHeader group={group} depth={depth} open={open} />
        </button>
        {pid && (
          <IconButton
            size="sm"
            label={`New session in ${group.label}`}
            icon={<Plus className="size-4" />}
            onClick={() => onNewSession(pid)}
            className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 max-md:opacity-100"
          />
        )}
      </div>
      {open && (
        <ul className={cn("flex min-w-0 flex-col", depth > 0 && "gap-0.5 py-0.5")}>
          {group.rows.length === 0 && group.groups.length === 0 && group.empty.length === 0 && (
            <li className="px-7 py-1 text-xs text-muted">No branches yet.</li>
          )}
          {group.groups.map((g) => (
            <GroupNode
              key={g.key}
              group={g}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              selectedId={selectedId}
              screen={screen}
              onNewSession={onNewSession}
              expansion={expansion}
            />
          ))}
          {group.rows.map((row) => (
            <SessionRow
              key={row.key}
              row={row}
              indent={depth === 0 ? 1 : 2}
              selectedId={selectedId}
              screen={screen}
              expansion={expansion}
            />
          ))}
          {pid &&
            group.empty.map((b) => (
              <EmptyBranchRow key={b.workspaceId} projectId={pid} branch={b} screen={screen} />
            ))}
        </ul>
      )}
    </li>
  );
}

/** A worktree with no session: one click opens a session in it. */
function EmptyBranchRow({
  projectId,
  branch,
  screen,
}: {
  projectId: string;
  branch: NavEmptyBranch;
  screen: boolean;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const workspace = useSyncStore((s) => s.workspaces[branch.workspaceId]);
  const open = async () => {
    if (!workspace?.branch) return;
    setBusy(true);
    try {
      const r = await codeApi.openBranch({
        projectId,
        branch: workspace.branch,
        hostId: workspace.hostId,
      });
      useSyncStore.getState().upsertSessionIfMissing(r.session);
      navigate(`/code/${encodeURIComponent(r.session.id)}`, { state: BACK_STATE });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      data-testid="empty-branch"
      className={cn("flex min-w-0 items-center gap-1.5 py-1 pr-2 pl-7", screen && "py-2")}
    >
      <GitBranch aria-hidden className="size-3.5 shrink-0 text-subtle" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-mono text-xs text-muted">{branch.label}</span>
        <span className="ml-1.5 text-xs text-subtle">
          No session{branch.host ? ` · ${branch.host}` : ""}
        </span>
      </span>
      {workspace?.branch && (
        <Button size="sm" variant="ghost" busy={busy} onClick={() => void open()}>
          Open
        </Button>
      )}
    </li>
  );
}

const INDENT = ["pl-2", "pl-7", "pl-9", "pl-11"] as const;

function SessionRow({
  row,
  indent,
  selectedId,
  screen,
  expansion,
  nested = false,
}: {
  row: NavRow;
  indent: 0 | 1 | 2 | 3;
  selectedId: string | null;
  screen: boolean;
  expansion?: RowExpansion;
  nested?: boolean;
}) {
  const { session, attention } = row;
  const selected = session.id === selectedId;
  const context = [formatRelative(session.lastActivityAt), row.project, row.host, row.branch]
    .filter(Boolean)
    .join(" · ");
  const count = row.others.length;
  const open =
    count > 0 &&
    (!!expansion?.expanded.has(row.key) ||
      row.othersNeedInput ||
      row.others.some((o) => o.session.id === selectedId));
  const needsInput = attention || (!nested && row.othersNeedInput);
  return (
    <li className="min-w-0">
      <div className="flex min-w-0 items-center">
        <Link
          data-testid={nested ? "session-subrow" : "session-row"}
          data-keyboard-item
          to={`/code/${encodeURIComponent(session.id)}`}
          state={BACK_STATE}
          aria-current={selected ? "page" : undefined}
          className={cn(
            "tap flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-1.5 pr-2 hover:bg-surface-2",
            INDENT[indent],
            screen && "py-2.5",
            selected && "bg-accent-soft hover:bg-accent-soft",
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
            {needsInput && session.runtime !== "waiting_input" && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-warning">
                <MessageCircleQuestion aria-hidden className="size-3.5" />
                Needs input
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-x-1.5">
            <StatusChip kind="custom" status={rowStatusFor(row)} size="sm" />
            {nested && (
              <span className="shrink-0 text-xs text-muted">
                {row.role === "subagent" ? "Subagent" : "Extra"}
              </span>
            )}
            <span className="min-w-0 truncate text-xs text-muted">{context}</span>
          </span>
        </Link>
        {count > 0 && (
          <button
            type="button"
            data-testid="row-others"
            aria-expanded={open}
            aria-label={`${count} more ${count === 1 ? "session" : "sessions"} in this branch`}
            onClick={() => expansion?.toggleRow(row.key)}
            className="tap shrink-0 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2"
          >
            +{count}
          </button>
        )}
      </div>
      {open && (
        <ul className="flex min-w-0 flex-col gap-0.5">
          {row.others.map((o) => (
            <SessionRow
              key={o.session.id}
              row={o}
              indent={Math.min(indent + 1, 3) as 0 | 1 | 2 | 3}
              selectedId={selectedId}
              screen={screen}
              nested
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function rowStatusFor(row: NavRow): StatusInfo {
  if (row.bucket === "review") return REVIEW_STATUS;
  if (row.bucket === "failed") return RUNTIME_STATUS.failed;
  return rowStatus(row.session.runtime);
}

/** List rows stay calm: only failed and needs input stand out; interrupted reads like stopped. */
function rowStatus(runtime: Session["runtime"]): StatusInfo {
  const s = RUNTIME_STATUS[runtime];
  return runtime === "interrupted" ? { ...s, tone: "neutral" } : s;
}
