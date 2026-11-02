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
} from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { Link } from "react-router";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { StatusChip } from "../../components/ui/StatusChip";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { useFilter } from "../../prefs";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import { buildNavTree, type NavFilter, type NavProjectGroup, type NavSessionRow } from "./model";

interface NavPrefs {
  filter: NavFilter;
  query: string;
  collapsed: string[];
}

const DEFAULT_PREFS: NavPrefs = { filter: "active", query: "", collapsed: [] };

export interface NavigatorProps {
  selectedId: string | null;
  onNewSession: () => void;
  /** "pane" for the desktop navigator, "screen" for the mobile session list. */
  variant: "pane" | "screen";
  className?: string;
  style?: CSSProperties;
}

/** Project -> workspace -> sessions, with search, filters, collapse controls and New session. */
export function Navigator({ selectedId, onNewSession, variant, className, style }: NavigatorProps) {
  const screen = variant === "screen";
  const [stored, setPrefs] = useFilter<NavPrefs>(
    screen ? "sessionList" : "navigator",
    DEFAULT_PREFS,
  );
  const prefs = { ...DEFAULT_PREFS, ...stored };
  const hydrated = useSyncStore((s) => s.hydrated);
  const projects = useSyncStore((s) => s.projects);
  const workspaces = useSyncStore((s) => s.workspaces);
  const sessions = useSyncStore((s) => s.sessions);
  const hostsMap = useSyncStore((s) => s.hosts);
  const attention = useSyncStore((s) => s.attention);
  const interactions = useSyncStore((s) => s.interactions);
  const hosts = useHosts();
  const projectList = useProjects();
  const tree = useMemo(
    () =>
      buildNavTree(
        { projects, workspaces, sessions, hosts: hostsMap, attention, interactions },
        { filter: prefs.filter, query: prefs.query },
      ),
    [projects, workspaces, sessions, hostsMap, attention, interactions, prefs.filter, prefs.query],
  );
  const collapsed = new Set(prefs.collapsed);
  const toggle = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPrefs({ ...prefs, collapsed: [...next] });
  };
  const allKeys = tree.flatMap((p) => [p.key, ...p.workspaces.map((w) => w.key)]);
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
    body = (
      <EmptyState
        icon={<FolderGit2 className="size-8" />}
        title="Add a project"
        description="Point Switchyard at a Git checkout on one of your hosts to start sessions there."
        action={{ label: "Add a project", to: "/settings/projects" }}
      />
    );
  } else if (tree.length === 0 || tree.every((p) => p.workspaces.length === 0)) {
    body = prefs.query ? (
      <EmptyState
        icon={<Search className="size-8" />}
        title="No matches"
        description={`Nothing matches "${prefs.query}".`}
        action={{ label: "Clear search", onClick: () => setPrefs({ ...prefs, query: "" }) }}
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
        description="Start a session in one of your projects; a task is not required."
        action={{ label: "New session", onClick: onNewSession }}
        secondaryAction={
          prefs.filter !== "all"
            ? { label: "Show all", onClick: () => setPrefs({ ...prefs, filter: "all" }) }
            : undefined
        }
      />
    );
  } else {
    body = (
      <ul aria-label="Projects" className="flex min-w-0 flex-col gap-1 pb-4">
        {tree.map((p) => (
          <ProjectNode
            key={p.key}
            group={p}
            collapsed={collapsed}
            toggle={toggle}
            selectedId={selectedId}
            screen={screen}
          />
        ))}
      </ul>
    );
  }

  return (
    <nav
      data-testid="navigator"
      aria-label="Sessions"
      style={style}
      className={cn("flex min-h-0 min-w-0 flex-col bg-surface", className)}
    >
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-3 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <h2 className={cn("min-w-0 flex-1 font-semibold", screen ? "text-lg" : "text-sm")}>
            Sessions
          </h2>
          <Button
            data-testid="new-session"
            size="sm"
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={onNewSession}
            disabled={!hydrated || hosts.length === 0 || projectList.length === 0}
            title={
              hosts.length === 0
                ? "Connect a host first"
                : projectList.length === 0
                  ? "Add a project first"
                  : undefined
            }
          >
            New session
          </Button>
        </div>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle"
          />
          <TextInput
            type="search"
            aria-label="Search sessions"
            placeholder="Search sessions, branches"
            value={prefs.query}
            onChange={(e) => setPrefs({ ...prefs, query: e.target.value })}
            className="pl-8"
          />
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <SegmentedControl
            label="Session filter"
            options={filterOptions}
            value={prefs.filter}
            onChange={(v) => setPrefs({ ...prefs, filter: v })}
            className="min-w-0 flex-1"
            block
          />
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
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 pt-2">
        {body}
      </div>
    </nav>
  );
}

function ProjectNode({
  group,
  collapsed,
  toggle,
  selectedId,
  screen,
}: {
  group: NavProjectGroup;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  selectedId: string | null;
  screen: boolean;
}) {
  const open = !collapsed.has(group.key);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => toggle(group.key)}
        className="tap flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-sm font-semibold hover:bg-surface-2"
      >
        <Chevron aria-hidden className="size-4 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{group.label}</span>
        <span className="shrink-0 text-xs font-normal text-muted">
          {group.sessionCount}
          <span className="sr-only"> sessions</span>
        </span>
      </button>
      {open && (
        <ul className="flex min-w-0 flex-col">
          {group.workspaces.length === 0 && (
            <li className="px-7 py-1 text-xs text-muted">No workspaces discovered yet.</li>
          )}
          {group.workspaces.map((w) => {
            const wOpen = !collapsed.has(w.key);
            const WChevron = wOpen ? ChevronDown : ChevronRight;
            return (
              <li key={w.key} className="min-w-0">
                <button
                  type="button"
                  aria-expanded={wOpen}
                  onClick={() => toggle(w.key)}
                  className="tap flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 pr-1.5 pl-4 text-left hover:bg-surface-2"
                >
                  <WChevron aria-hidden className="size-3.5 shrink-0 text-muted" />
                  <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs" title={w.workspace?.path}>
                      {w.label}
                    </span>
                    {w.hostName && (
                      <span className="block truncate text-xs text-muted">{w.hostName}</span>
                    )}
                  </span>
                </button>
                {wOpen && w.sessions.length > 0 && (
                  <ul className="flex min-w-0 flex-col gap-0.5 py-0.5">
                    {w.sessions.map((row) => (
                      <SessionRow
                        key={row.session.id}
                        row={row}
                        selected={row.session.id === selectedId}
                        screen={screen}
                      />
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function SessionRow({
  row,
  selected,
  screen,
}: {
  row: NavSessionRow;
  selected: boolean;
  screen: boolean;
}) {
  const { session, attention } = row;
  return (
    <li className="min-w-0">
      <Link
        data-testid="session-row"
        to={`/code/${encodeURIComponent(session.id)}`}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "tap flex min-w-0 flex-col gap-0.5 rounded-md py-1.5 pr-2 pl-9 hover:bg-surface-2",
          screen && "py-2.5",
          selected && "bg-accent-soft hover:bg-accent-soft",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
          {attention && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-warning">
              <MessageCircleQuestion aria-hidden className="size-3.5" />
              Needs you
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <StatusChip kind="runtime" value={session.runtime} size="sm" />
          {session.provenance === "subagent" && (
            <span className="text-xs text-muted">Subagent</span>
          )}
          <span className="truncate text-xs text-muted">
            {formatRelative(session.lastActivityAt)}
          </span>
        </span>
      </Link>
    </li>
  );
}
