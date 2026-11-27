import type { Scope, Session } from "@switchyard/protocol";
import {
  Archive,
  BellOff,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FolderGit2,
  Layers,
  MessageCircleQuestion,
  Pencil,
  Plus,
  Search,
  Server,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate } from "react-router";
import { BACK_STATE } from "../../app/useBackTo";
import { ActionSheet } from "../../components/ui/ActionSheet";
import { TONE_CLASSES, TONE_TEXT } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Menu, type MenuHeading, type MenuItem } from "../../components/ui/Menu";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Spinner } from "../../components/ui/Spinner";
import {
  REVIEW_STATUS,
  RUNTIME_STATUS,
  StatusChip,
  type StatusInfo,
} from "../../components/ui/StatusChip";
import { type SwipeAction, SwipeRow } from "../../components/ui/SwipeRow";
import { EmptyState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { cn } from "../../lib/cn";
import { LONG_PRESS_CLASS, useLongPress } from "../../lib/useLongPress";
import { useFilter } from "../../prefs";
import {
  useHosts,
  useProjects,
  useSession,
  useSessionBadges,
  useSyncStore,
} from "../../sync/store";
import { isMac } from "../palette/CommandPalette";
import { emptyScopeState, scopeOptionLabel } from "../scopes/describe";
import { ScopeDialog } from "../scopes/ScopeDialog";
import { useScopeDescriber } from "../scopes/ScopeSelect";
import {
  effectiveWhere,
  sameWhere,
  useSelectedWhere,
  type Where,
  whereLabel,
} from "../scopes/where";
import { ProjectSuggestions } from "../settings/ProjectSuggestions";
import { AdapterSlot } from "./AdapterSlots";
import { sessionMenuItems } from "./ConversationHeader";
import { useSessionContext } from "./hooks";
import {
  buildNavTree,
  DEFAULT_SORT,
  isBusy,
  NAV_LAYOUTS,
  NAV_SORTS,
  type NavFilter,
  type NavGroup,
  type NavLayout,
  type NavOutside,
  type NavRow,
  type NavSort,
  navGroupKeys,
  navNeedsInput,
  navOutsideRow,
  navRowCount,
  navTreeIsEmpty,
  normalizeLayout,
  pendingTitles,
  projectIdOfGroup,
  rowPreview,
} from "./model";
import { archiveWithUndo, clearNeedsInput } from "./rowActions";
import { useSessionActions } from "./SessionActions";
import { useSelectedScope } from "./scopes";
import {
  branchActivity,
  branchChildren,
  recentSections,
  shortActivity,
} from "./sessionListPresentation";

interface NavPrefs {
  filter: NavFilter;
  query: string;
  collapsed: string[];
  layout: NavLayout;
  showSubagents: boolean;
  showSessionDetails: boolean;
  sorts: Partial<Record<NavLayout, NavSort>>;
  needsInputFirst: boolean;
  /** Branch rows showing their other sessions. */
  expanded: string[];
}

const FILTER_VALUES = ["active", "attention", "all"] as const;

function defaultPrefs(): NavPrefs {
  return {
    filter: "active",
    query: "",
    collapsed: [],
    layout: "recent",
    showSubagents: false,
    showSessionDetails: false,
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
  const defaults = defaultPrefs();
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
  const { scopes, describe: describeScope } = useScopeDescriber();
  const [selectedScopeId, setSelectedScopeId] = useSelectedScope();
  const [storedWhere, setWhere] = useSelectedWhere();
  const where = effectiveWhere(storedWhere, hostsMap);
  const [editingScope, setEditingScope] = useState<string | "new" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const scope = (selectedScopeId ? scopes[selectedScopeId] : null) ?? null;
  const attention = useSyncStore((s) => s.attention);
  const interactions = useSyncStore((s) => s.interactions);
  const issues = useSyncStore((s) => s.issues);
  const hosts = useHosts();
  const projectList = useProjects();
  const navInput = useMemo(
    () => ({ projects, workspaces, sessions, hosts: hostsMap, attention, interactions, issues }),
    [projects, workspaces, sessions, hostsMap, attention, interactions, issues],
  );
  const navOpts = {
    query: prefs.query,
    layout: prefs.layout,
    showSubagents: prefs.showSubagents,
    sort,
    needsInputFirst: prefs.needsInputFirst,
    scope,
    where,
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: navOpts is rebuilt each render from these
  const tree = useMemo(
    () => buildNavTree(navInput, { ...navOpts, filter: prefs.filter, keepId: selectedId }),
    [
      navInput,
      selectedId,
      prefs.filter,
      prefs.query,
      prefs.layout,
      prefs.showSubagents,
      sort,
      prefs.needsInputFirst,
      scope,
      where?.kind,
      where?.id,
    ],
  );
  // The count on each filter is the branches it lists, so it always matches the rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navOpts is rebuilt each render from these
  const counts = useMemo(() => {
    const out: Partial<Record<NavFilter, number>> = {};
    for (const f of FILTER_VALUES) {
      out[f] = navRowCount(
        f === prefs.filter ? tree : buildNavTree(navInput, { ...navOpts, filter: f }),
      );
    }
    return out;
  }, [tree]);
  const latestNeedsInput = useMemo(() => navNeedsInput(tree).first, [tree]);
  const navigate = useNavigate();
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
  const anyExpanded = allKeys.some((k) => !collapsed.has(k));
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
    ...(allKeys.length > 0
      ? [
          {
            id: "collapse-all",
            label: anyExpanded ? "Collapse all" : "Expand all",
            onSelect: () => setPrefs({ ...prefs, collapsed: anyExpanded ? allKeys : [] }),
          } satisfies MenuItem,
        ]
      : []),
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
    {
      id: "session-details",
      label: "Show session details",
      hint: "Run location and latest reply",
      kind: "checkbox",
      checked: prefs.showSessionDetails,
      onSelect: () => setPrefs({ ...prefs, showSessionDetails: !prefs.showSessionDetails }),
    },
  ];
  if (latestNeedsInput) {
    viewItems.push("separator", {
      id: "needs-input-jump",
      label: "Open latest session needing input",
      icon: <MessageCircleQuestion className="size-4" />,
      onSelect: () =>
        navigate(`/code/${encodeURIComponent(latestNeedsInput)}`, { state: BACK_STATE }),
    });
  }

  const filterInfo: Record<NavFilter, { label: string; title?: string }> = {
    active: { label: "Active", title: "Live sessions, and stopped ones that need you" },
    attention: { label: "Needs input" },
    all: {
      label: "All",
      title: scope?.source
        ? `Adds stopped sessions on ${scope.name}'s issues, and pinned ones`
        : "Adds stopped sessions",
    },
  };
  const filterOptions = FILTER_VALUES.map((value) => ({
    value,
    ...filterInfo[value],
    count: counts[value] ?? 0,
  }));
  const scopeName = scope?.name ?? null;
  const whereName = where ? whereLabel(where, hostsMap) : null;
  const searchShown = !screen || searchOpen || prefs.query !== "";
  // One Clear for all: shown once two filters are set (a single one has its own clear).
  const activeFilters =
    Number(!!scope) +
    Number(!!where) +
    Number(prefs.query !== "") +
    Number(prefs.filter === "attention");
  const anyFilter = activeFilters >= 2;
  const ready = hydrated && hosts.length > 0 && projectList.length > 0;
  const clearFilters = () => {
    setSelectedScopeId(null);
    setWhere(null);
    setSearchOpen(false);
    setPrefs({
      ...prefs,
      query: "",
      filter: prefs.filter === "attention" ? "active" : prefs.filter,
    });
  };
  const outsideLabel = (r: NavOutside): string =>
    r === "scope"
      ? `Not in ${scopeName ?? "this scope"}`
      : r === "where"
        ? `Not in ${whereName ?? "this place"}`
        : prefs.filter === "attention"
          ? "No input needed"
          : "Not active";
  const badges = useSessionBadges();
  const pending = useMemo(() => pendingTitles(interactions), [interactions]);
  const [rowActions, setRowActions] = useState<{
    id: string;
    open: boolean;
    intent: RowIntent;
    n: number;
  }>({ id: "", open: false, intent: "sheet", n: 0 });
  const rowProps = {
    selectedId,
    now: new Date(),
    showSessionDetails: prefs.showSessionDetails,
    scopeName,
    outsideLabel,
    badges,
    pendingTitles: pending,
    onRowActions: screen
      ? (id: string, intent: RowIntent) =>
          setRowActions((r) => ({ id, open: intent === "sheet", intent, n: r.n + 1 }))
      : undefined,
  };
  const groupProps = {
    collapsed,
    toggle,
    onNewSession,
    expansion,
    where,
    setWhere,
    ...rowProps,
  };

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
        <EmptyState
          icon={<FolderGit2 className="size-8" />}
          title="Add a project"
          description="Point Switchyard at a Git checkout on one of your hosts to start sessions there."
          action={{ label: "Add a project", to: "/settings/projects" }}
        />
        {first && <ProjectSuggestions host={first} compact />}
      </>
    );
  } else if (navTreeIsEmpty(tree)) {
    const kept = navOutsideRow(tree);
    const statusTitle = (what: string | null) => {
      const inWhat = what ? ` in ${what}` : "";
      return prefs.filter === "attention"
        ? `Nothing needs your input${inWhat}`
        : prefs.filter === "active"
          ? `No active sessions${inWhat}`
          : what
            ? `No sessions${inWhat}`
            : "No sessions yet";
    };
    const showAll =
      prefs.filter !== "all"
        ? { label: "Show all", onClick: () => setPrefs({ ...prefs, filter: "all" }) }
        : undefined;
    const empty = prefs.query ? (
      <EmptyState
        icon={<Search className="size-8" />}
        title="No matches"
        description={`Nothing matches "${prefs.query}".`}
        action={{ label: "Clear search", onClick: () => setPrefs({ ...prefs, query: "" }) }}
      />
    ) : where ? (
      <EmptyState
        title={statusTitle(whereName)}
        description={
          where.kind === "client"
            ? "A client lists only the Pi running in it now: a session that ended there is not in it any more."
            : scope
              ? `No session in ${scope.name} runs on this host.`
              : "No session runs on this host."
        }
        action={{ label: "Clear Where", onClick: () => setWhere(null) }}
        secondaryAction={where.kind === "host" ? showAll : undefined}
      />
    ) : scope ? (
      <EmptyState
        {...emptyScopeState(scope, {
          filter: prefs.filter,
          source: describeScope(scope),
          origin: window.location.host,
        })}
        action={{ label: "New session", onClick: () => onNewSession() }}
        secondaryAction={
          showAll ?? { label: "All sessions", onClick: () => setSelectedScopeId(null) }
        }
      />
    ) : (
      <EmptyState
        title={statusTitle(null)}
        description="Start a session in one of your projects."
        action={{ label: "New session", onClick: () => onNewSession() }}
        secondaryAction={showAll}
      />
    );
    body = (
      <>
        {empty}
        {kept && (
          <ul aria-label="Open session" className="flex min-w-0 flex-col gap-0.5 pb-2">
            <SessionRow row={kept} {...rowProps} />
          </ul>
        )}
      </>
    );
  } else if (prefs.layout === "recent") {
    const sections =
      sort === "activity"
        ? recentSections(
            tree.rows,
            prefs.needsInputFirst && prefs.filter !== "attention",
            rowProps.now,
          )
        : [{ label: "", rows: tree.rows }];
    body = (
      <ul aria-label="Recent sessions" className="flex min-w-0 flex-col gap-0.5 pb-4">
        {sections.flatMap(({ label, rows }) => [
          label && (
            <li
              key={`section:${label}`}
              data-testid="recent-section"
              className="mt-4 px-1.5 pb-1 first:mt-0"
            >
              <h3 className={SECTION_HEADING}>{label}</h3>
            </li>
          ),
          ...rows.map((row) => (
            <SessionRow key={row.key} row={row} expansion={expansion} {...rowProps} />
          )),
        ])}
      </ul>
    );
  } else {
    body = (
      <ul
        aria-label={
          prefs.layout === "where" ? "Where" : prefs.layout === "status" ? "Status" : "Projects"
        }
        className="flex min-w-0 flex-col gap-4 pb-4"
      >
        {tree.groups.map((g) => (
          <GroupNode key={g.key} group={g} depth={0} {...groupProps} />
        ))}
      </ul>
    );
  }

  const scopePicker = (
    <ViewFilter
      scopes={scopes}
      scope={scope}
      title={scope ? describeScope(scope) : undefined}
      onChange={setSelectedScopeId}
      onNew={() => setEditingScope("new")}
      onEdit={scope ? () => setEditingScope(scope.id) : undefined}
    />
  );
  const clearButton = anyFilter && (
    <button
      type="button"
      data-testid="clear-filters"
      onClick={clearFilters}
      className="tap ml-auto inline-flex h-8 shrink-0 items-center rounded-md px-1.5 text-xs font-medium text-accent hover:underline"
    >
      Clear
    </button>
  );

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
      <div data-testid="navigator-header" className="@container shrink-0 border-b border-border">
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-1.5 px-2.5 py-2">
          <h2 className="col-start-1 row-start-1 min-w-0 text-lg font-semibold tracking-tight @min-[320px]:text-[20px]">
            Sessions
          </h2>
          {ready && (
            <div className="col-span-3 col-start-1 row-start-2 min-w-0 @min-[320px]:col-span-1 @min-[320px]:col-start-2 @min-[320px]:row-start-1">
              {scopePicker}
            </div>
          )}
          {screen && ready && (
            <IconButton
              data-testid="toggle-search"
              label="Search sessions"
              aria-expanded={searchShown}
              className="col-start-3 row-start-1 size-11"
              icon={<Search aria-hidden className="size-[18px]" />}
              onClick={() => {
                if (searchShown) {
                  setSearchOpen(false);
                  if (prefs.query) setPrefs({ ...prefs, query: "" });
                } else setSearchOpen(true);
              }}
            />
          )}
          <Button
            data-testid="new-session"
            size="sm"
            variant="primary"
            aria-label="New session"
            className="col-start-4 row-start-1 rounded-lg"
            icon={<Plus aria-hidden className="size-4" />}
            onClick={() => onNewSession()}
            disabled={!ready}
            title={
              hydrated && hosts.length === 0
                ? "Connect a host to start sessions"
                : hydrated && projectList.length === 0
                  ? "Add a project to start sessions"
                  : undefined
            }
          >
            New
          </Button>
          {ready && searchShown && (
            <div className="relative col-span-full row-start-3 @min-[320px]:row-start-2">
              <Search
                aria-hidden
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle"
              />
              <TextInput
                type="search"
                aria-label="Search sessions"
                data-keyboard-search
                placeholder="Search sessions"
                title={screen ? undefined : `Search everything: ${isMac() ? "⌘K" : "Ctrl+K"}`}
                value={prefs.query}
                autoFocus={screen && searchOpen && !prefs.query}
                onChange={(e) => setPrefs({ ...prefs, query: e.target.value })}
                className="pl-8"
              />
            </div>
          )}
          {ready && (
            <>
              <div
                data-testid="session-filters"
                className={cn(
                  "col-span-full min-w-0 @min-[320px]:pr-12",
                  searchShown
                    ? "row-start-4 @min-[320px]:row-start-3"
                    : "row-start-3 @min-[320px]:row-start-2",
                )}
              >
                <SegmentedControl
                  label="Session filter"
                  block
                  className="min-w-0 [&>button]:min-h-11 [&>button]:flex-col [&>button]:gap-0 [&>button]:px-1 [&>button]:text-xs [&>button:nth-of-type(2)]:flex-[1.4] @min-[320px]:[&>button]:flex-row @min-[320px]:[&>button]:gap-1.5 @min-[320px]:[&>button]:text-[13px]"
                  options={filterOptions.map(({ count, ...option }) => ({
                    ...option,
                    badge: <FilterCount value={option.value} count={count} />,
                  }))}
                  value={prefs.filter}
                  onChange={(v) => setPrefs({ ...prefs, filter: v })}
                />
              </div>
              <div
                className={cn(
                  "col-start-4 row-start-2 justify-self-end",
                  searchShown ? "@min-[320px]:row-start-3" : "@min-[320px]:row-start-2",
                )}
              >
                <Menu
                  label="View options"
                  items={viewItems}
                  trigger={(p) => (
                    <IconButton
                      {...p}
                      size="sm"
                      label="View options"
                      className="size-11"
                      icon={<SlidersHorizontal aria-hidden className="size-[18px]" />}
                    />
                  )}
                />
              </div>
            </>
          )}
          {ready && (whereName || anyFilter) && (
            <div
              data-testid="navigator-filters"
              className="col-span-full flex min-w-0 items-center gap-2"
            >
              {whereName && <WhereFilter value={whereName} onClear={() => setWhere(null)} />}
              {clearButton}
            </div>
          )}
        </div>
        <ScopeDialog
          editing={editingScope}
          onClose={() => setEditingScope(null)}
          onSaved={(id) => setSelectedScopeId(id)}
        />
      </div>
      <AdapterSlot sessionId={selectedId} placement="sidebar.header" />
      <div
        data-scroll-root
        className="@container relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-surface px-2 pt-2"
      >
        {body}
      </div>
      <RowActionsHost
        sessionId={rowActions.id || null}
        intent={rowActions.intent}
        n={rowActions.n}
        open={rowActions.open}
        onClose={() => setRowActions((r) => ({ ...r, open: false }))}
      />
      <AdapterSlot sessionId={selectedId} placement="sidebar.footer" />
    </nav>
  );
}

const SECTION_HEADING = "text-xs font-semibold text-muted";

function FilterCount({ value, count }: { value: string; count: number }) {
  return (
    <span data-testid={`filter-count-${value}`} className="text-xs tabular-nums text-muted">
      {count}
    </span>
  );
}

/** The visible chip and its native picker share the same bounds. */
function ViewFilter({
  scopes,
  scope,
  title,
  onChange,
  onNew,
  onEdit,
}: {
  scopes: Record<string, Scope>;
  scope: Scope | null;
  title?: string;
  onChange: (id: string | null) => void;
  onNew: () => void;
  onEdit?: () => void;
}) {
  return (
    <div
      data-testid="scope-chip"
      data-active={scope ? "true" : undefined}
      className="relative flex h-11 min-w-0 max-w-40 items-center rounded-lg bg-surface-2 pointer-fine:h-9 @min-[320px]:max-w-[84px] @min-[360px]:max-w-28"
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none flex min-w-0 items-center gap-1 px-2 text-[13px] font-medium",
          scope ? "text-accent" : "text-muted",
        )}
      >
        <span className="truncate">{scope?.name ?? "Scope"}</span>
        <ChevronDown className="size-3 shrink-0" />
      </span>
      <select
        aria-label="Scope"
        value={scope?.id ?? ""}
        title={title}
        onChange={(e) => {
          const value = e.currentTarget.value;
          if (value === "__new" || value === "__edit") {
            e.currentTarget.value = scope?.id ?? "";
            if (value === "__new") onNew();
            else onEdit?.();
          } else onChange(value || null);
        }}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-lg bg-transparent text-transparent [&>option]:text-text"
      >
        <option value="">All sessions</option>
        {Object.values(scopes).map((v) => (
          <option key={v.id} value={v.id}>
            {scopeOptionLabel(v)}
          </option>
        ))}
        {onEdit && <option value="__edit">Edit scope…</option>}
        <option value="__new">New scope…</option>
      </select>
    </div>
  );
}

/** The set Where filter: label, the place in the accent colour, and a clear. */
function WhereFilter({ value, onClear }: { value: string; onClear: () => void }) {
  return (
    <div
      data-testid="where-chip"
      data-active="true"
      title={`Where: ${value}`}
      className="flex h-11 min-w-0 items-center gap-1.5 text-sm pointer-fine:h-8"
    >
      <span className="shrink-0 text-xs text-muted">Where</span>
      <span className="min-w-0 truncate pl-1 font-medium text-accent">{value}</span>
      <IconButton
        size="sm"
        label="Clear Where"
        icon={<X className="size-3.5" />}
        onClick={onClear}
      />
    </div>
  );
}

function GroupIcon({ group }: { group: NavGroup }) {
  const cls = "size-3.5 shrink-0 text-muted";
  if (group.kind === "host") return <Server aria-hidden className={cls} />;
  if (group.kind === "terminal") return <SquareTerminal aria-hidden className={cls} />;
  if (group.kind === "held") return <Layers aria-hidden className={cls} />;
  if (group.kind === "project") return <FolderGit2 aria-hidden className={cls} />;
  return null;
}

function GroupHeader({ group, depth, open }: { group: NavGroup; depth: number; open: boolean }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  if (depth === 0) {
    return (
      <>
        <Chevron aria-hidden className="size-4 shrink-0 text-muted" />
        <GroupIcon group={group} />
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
      <GroupIcon group={group} />
      <span className="min-w-0 flex-1 truncate">
        {group.label}
        {group.detail && <span className="ml-1.5 text-xs text-muted">{group.detail}</span>}
      </span>
    </>
  );
}

/** Which rows show their other sessions. */
interface RowExpansion {
  expanded: Set<string>;
  toggleRow: (key: string) => void;
}

interface RowProps {
  selectedId: string | null;
  now: Date;
  showSessionDetails: boolean;
  scopeName: string | null;
  /** The marker on the open session's row when a filter excludes it. */
  outsideLabel: (r: NavOutside) => string;
  /** `session.badge` contributions per session. */
  badges: ReturnType<typeof useSessionBadges>;
  /** The oldest pending question of each session. */
  pendingTitles: Map<string, string>;
  /** Phone: open a session's actions sheet, or run one of them (long-press and swipe actions). */
  onRowActions?: (sessionId: string, intent: RowIntent) => void;
}

const BADGE_TONE = {
  default: "text-text",
  muted: "text-muted",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

const NO_BADGES: ReturnType<typeof useSessionBadges>[string] = [];

/** A row's state as a mark: the icon's shape and a spoken label, colour only reinforcing. */
function StatusMark({ status, tile }: { status: StatusInfo; tile?: boolean }) {
  const Icon = status.icon;
  return (
    <span
      data-testid="row-status"
      title={status.label}
      className={cn(
        "inline-flex shrink-0 items-center",
        tile
          ? cn("size-5 justify-center rounded-md @min-[304px]:size-6", TONE_CLASSES[status.tone])
          : cn("size-3.5", TONE_TEXT[status.tone]),
      )}
    >
      {status.spin ? (
        <Spinner className={"size-3.5"} />
      ) : (
        <Icon aria-hidden className={cn("size-3.5", status.pulse && "motion-safe:animate-pulse")} />
      )}
      <span className="sr-only">{status.label}</span>
    </span>
  );
}

function GroupNode({
  group,
  depth,
  collapsed,
  toggle,
  onNewSession,
  expansion,
  where,
  setWhere,
  ...rowProps
}: RowProps & {
  group: NavGroup;
  depth: number;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  onNewSession: (projectId?: string) => void;
  expansion: RowExpansion;
  where: Where | null;
  setWhere: (w: Where | null) => void;
}) {
  const open = !collapsed.has(group.key);
  const pid = group.kind === "project" ? projectIdOfGroup(group.key) : null;
  const only = group.where && !sameWhere(group.where, where) ? group.where : null;
  return (
    <li className={cn("min-w-0", depth === 1 && "ml-2")}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => toggle(group.key)}
          className={cn(
            SECTION_HEADING,
            "tap flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-surface-2",
          )}
        >
          <GroupHeader group={group} depth={depth} open={open} />
        </button>
        {only && (
          <button
            type="button"
            data-testid="group-only"
            aria-label={`Only ${group.label}`}
            title={`Show only what runs ${only.kind === "host" ? "on" : "in"} ${group.label}`}
            onClick={() => setWhere(only)}
            className="tap shrink-0 rounded px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
          >
            Only this
          </button>
        )}
        {pid && (
          <IconButton
            size="sm"
            label={`New session in ${group.label}`}
            icon={<Plus className="size-4" />}
            onClick={() => onNewSession(pid)}
            className="size-7"
          />
        )}
      </div>
      {open && (
        <ul className="mt-1 flex min-w-0 flex-col gap-0.5">
          {group.rows.length === 0 && group.groups.length === 0 && (
            <li className="px-7 py-1 text-xs text-muted">No branches yet.</li>
          )}
          {group.groups.map((g) => (
            <GroupNode
              key={g.key}
              group={g}
              depth={depth + 1}
              collapsed={collapsed}
              toggle={toggle}
              onNewSession={onNewSession}
              expansion={expansion}
              where={where}
              setWhere={setWhere}
              {...rowProps}
            />
          ))}
          {group.rows.map((row) => (
            <SessionRow key={row.key} row={row} expansion={expansion} {...rowProps} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SessionRowContent({
  row,
  nested,
  showDetails,
  pending,
  badges,
  scopeName,
  outsideLabel,
}: {
  row: NavRow;
  nested: boolean;
  showDetails: boolean;
  pending: string | null;
  badges: typeof NO_BADGES;
  scopeName: string | null;
  outsideLabel: RowProps["outsideLabel"];
}) {
  const { session, where, issue } = row;
  const status = row.attention ? RUNTIME_STATUS.waiting_input : rowStatusFor(row);
  const branch = row.branch !== session.title && row.branch !== row.project ? row.branch : null;
  const identity = [nested && row.role === "subagent" ? "Subagent" : null, row.project, branch]
    .filter(Boolean)
    .join(" · ");
  const preview =
    showDetails || pending?.trim() || session.runtime === "failed"
      ? rowPreview(session, pending)
      : null;
  return (
    <>
      <StatusMark status={status} tile={!nested} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          data-testid="session-title"
          className={cn(
            "line-clamp-2 break-words text-sm leading-5 @min-[304px]:text-[15px]",
            nested ? "font-medium" : "font-semibold",
          )}
          title={session.title}
        >
          {session.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs leading-4 text-muted @min-[304px]:flex-nowrap">
          {identity && (
            <span className="min-w-0 flex-[0_1_auto] truncate" title={identity}>
              {identity}
            </span>
          )}
          {issue && (
            <span className="shrink-0 tabular-nums" title={issue.title}>
              #{issue.number}
            </span>
          )}
          {(identity || issue) && (
            <span aria-hidden className="hidden shrink-0 text-subtle @min-[304px]:inline">
              ·
            </span>
          )}
          <span aria-hidden className={cn("min-w-0 shrink-0 font-medium", TONE_TEXT[status.tone])}>
            {status.label}
          </span>
        </span>
        {showDetails && where && (
          <span
            data-testid="row-where"
            title={where.label}
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted"
          >
            {where.kind === "terminal" ? (
              <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
            ) : (
              <Server aria-hidden className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{where.label}</span>
          </span>
        )}
        {preview && preview.trim() !== session.title.trim() && (
          <span data-testid="row-preview" className="truncate text-xs text-muted" title={preview}>
            {preview}
          </span>
        )}
        {(row.leaves || row.outside || badges.length > 0) && (
          <span
            data-testid="row-annotations"
            className="flex min-w-0 flex-wrap gap-1 text-xs text-muted"
          >
            {row.leaves && (
              <span
                data-testid="row-no-issue"
                className="rounded bg-surface-2 px-1.5"
                title={`In ${scopeName ?? "this scope"} only while it is live. Pin it or link an issue to keep it.`}
              >
                No issue
              </span>
            )}
            {row.outside && (
              <span
                data-testid="row-outside"
                data-reason={row.outside}
                className="min-w-0 truncate rounded bg-surface-2 px-1.5"
                title="Listed because it is open"
              >
                {outsideLabel(row.outside)}
              </span>
            )}
            {badges.map((b) => (
              <span
                key={`${b.adapterId}:${b.id}`}
                data-testid="row-badge"
                title={b.text}
                className={cn(
                  "min-w-0 truncate rounded bg-surface-2 px-1.5",
                  BADGE_TONE[b.tone ?? "muted"],
                )}
              >
                {b.text}
              </span>
            ))}
          </span>
        )}
      </span>
    </>
  );
}

function SessionRow({
  row,
  expansion,
  nested = false,
  ...rowProps
}: RowProps & {
  row: NavRow;
  expansion?: RowExpansion;
  nested?: boolean;
}) {
  const { selectedId, now, showSessionDetails, scopeName, outsideLabel, onRowActions } = rowProps;
  const { session, attention } = row;
  const press = useLongPress(() => onRowActions?.(session.id, "sheet"), {
    enabled: !!onRowActions,
  });
  const selected = session.id === selectedId;
  const pending = rowProps.pendingTitles.get(session.id) ?? null;
  const badges = rowProps.badges[session.id] ?? NO_BADGES;
  const expanded = expansion?.expanded.has(row.key) ?? false;
  const { visible: children, optionalCount } = branchChildren(row, selectedId, expanded);
  const childrenId = useId();
  const showDisclosure = optionalCount > 0 && !!expansion;
  const at = nested ? session.lastActivityAt : branchActivity(row);
  const activity = new Date(at);
  const valid = Number.isFinite(activity.getTime());
  const activityLabel = `${nested ? "Last activity" : "Last branch activity"}: ${valid ? activity.toLocaleString() : "unknown"}`;
  const swipeable = !!onRowActions;
  const trailing: SwipeAction[] = [];
  const leading: SwipeAction[] = [];
  if (onRowActions) {
    if (isBusy(session)) {
      trailing.push({
        id: "stop",
        label: "Stop",
        icon: <Square aria-hidden className="size-5" />,
        tone: "red",
        onAction: () => onRowActions(session.id, "stop"),
      });
    } else if (!session.archivedAt && !session.readOnly) {
      trailing.push({
        id: "archive",
        label: "Archive",
        icon: <Archive aria-hidden className="size-5" />,
        tone: "red",
        removes: true,
        onAction: () => archiveWithUndo(session),
      });
    }
    trailing.push({
      id: "more",
      label: "More",
      icon: <Ellipsis aria-hidden className="size-5" />,
      tone: "gray",
      onAction: () => onRowActions(session.id, "sheet"),
    });
    if (attention && session.runtime !== "waiting_input") {
      leading.push({
        id: "clear",
        label: "Clear",
        icon: <BellOff aria-hidden className="size-5" />,
        tone: "orange",
        onAction: () => clearNeedsInput(session.id),
      });
    }
    if (!session.readOnly) {
      leading.push({
        id: "rename",
        label: "Rename",
        icon: <Pencil aria-hidden className="size-5" />,
        tone: "blue",
        onAction: () => onRowActions(session.id, "rename"),
      });
    }
  }
  const line = (
    <div
      className={cn(
        "relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start rounded-lg",
        selected ? "bg-accent-soft" : nested ? "hover:bg-surface-3" : "hover:bg-surface-2",
      )}
    >
      <Link
        {...(swipeable ? press : {})}
        data-testid={nested ? "session-subrow" : "session-row"}
        data-keyboard-item
        to={`/code/${encodeURIComponent(session.id)}`}
        state={BACK_STATE}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "tap col-start-1 row-start-1 flex min-w-0 self-stretch items-start gap-2 rounded-lg px-1.5 py-2 outline-offset-[-2px]",
          showDisclosure && "row-span-2",
          swipeable && cn(LONG_PRESS_CLASS, "sy-press-row"),
        )}
      >
        <SessionRowContent
          row={row}
          nested={nested}
          showDetails={showSessionDetails}
          pending={pending}
          badges={badges}
          scopeName={scopeName}
          outsideLabel={outsideLabel}
        />
      </Link>
      <time
        data-testid="row-activity"
        dateTime={valid ? activity.toISOString() : undefined}
        title={activityLabel}
        className="col-start-2 row-start-1 max-w-16 justify-self-end truncate px-1.5 pt-2 text-right text-xs leading-5 text-muted tabular-nums"
      >
        <span aria-hidden>{shortActivity(at, now)}</span>
        <span className="sr-only">{activityLabel}</span>
      </time>
      {swipeable && (
        <button
          type="button"
          className="sr-only focus:not-sr-only focus:absolute focus:inset-y-1 focus:left-1 focus:z-10 focus:rounded-md focus:bg-surface-2 focus:px-2"
          onClick={() => onRowActions?.(session.id, "sheet")}
        >
          Actions for {session.title}
        </button>
      )}
      {showDisclosure && (
        <button
          type="button"
          data-testid="row-others"
          aria-expanded={expanded}
          aria-controls={childrenId}
          aria-label={
            expanded
              ? "Show fewer sessions in this branch"
              : `Show ${optionalCount} more ${optionalCount === 1 ? "session" : "sessions"} in this branch`
          }
          onClick={() => expansion?.toggleRow(row.key)}
          className="tap col-start-2 row-start-2 inline-flex min-h-7 items-center justify-end gap-0.5 justify-self-end rounded-md px-1.5 text-xs text-muted tabular-nums hover:bg-surface-3 focus-visible:outline-offset-[-2px]"
        >
          <span aria-hidden className="hidden @min-[304px]:inline">
            {expanded ? "Fewer" : `${optionalCount} more`}
          </span>
          {!expanded && (
            <span aria-hidden className="@min-[304px]:hidden">
              +{optionalCount}
            </span>
          )}
          <ChevronDown aria-hidden className={cn("size-3.5", expanded && "rotate-180")} />
        </button>
      )}
    </div>
  );
  return (
    <li className="min-w-0">
      {swipeable ? (
        <SwipeRow
          leading={leading}
          trailing={trailing}
          className="rounded-lg"
          contentClassName={nested ? "bg-surface-2" : undefined}
        >
          {line}
        </SwipeRow>
      ) : (
        line
      )}
      {(children.length > 0 || showDisclosure) && (
        <ul
          data-testid="branch-children"
          id={childrenId}
          hidden={children.length === 0}
          className="mt-0.5 mb-1 ml-2 min-w-0 rounded-lg bg-surface-2 p-0.5 @min-[304px]:ml-4"
        >
          {children.map((child) => (
            <SessionRow key={child.session.id} row={child} nested {...rowProps} />
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

/** The phone's session actions sheet: the same list as the session menu, opened by a long-press. */
type RowIntent = "sheet" | "stop" | "rename";

interface RowActionsProps {
  intent: RowIntent;
  /** Changes with every request, so the same request twice runs twice. */
  n: number;
  open: boolean;
  onClose: () => void;
}

function RowActionsHost({ sessionId, ...props }: RowActionsProps & { sessionId: string | null }) {
  const session = useSession(sessionId);
  if (!sessionId || !session) return null;
  return <RowActions key={sessionId} session={session} {...props} />;
}

function RowActions({ session, ...props }: RowActionsProps & { session: Session }) {
  const ctx = useSessionContext(session);
  if (!ctx) return null;
  return <RowActionsSheet ctx={ctx} {...props} />;
}

function RowActionsSheet({
  ctx,
  intent,
  n,
  open,
  onClose,
}: RowActionsProps & { ctx: NonNullable<ReturnType<typeof useSessionContext>> }) {
  const actions = useSessionActions(ctx);
  const latest = useRef(actions);
  latest.current = actions;
  // A swipe action runs its dialog here, where the session's actions and dialogs live.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per request (n)
  useEffect(() => {
    if (intent === "stop") latest.current.requestStop();
    else if (intent === "rename") latest.current.openRename();
  }, [n]);
  const scopes = useSyncStore((st) => st.scopes);
  const { session, project, workspace } = ctx;
  const items: (MenuItem | MenuHeading | "separator")[] = [
    ...(actions.canStop
      ? [
          {
            id: "stop",
            label: "Stop",
            icon: <Square className="size-4" />,
            danger: true,
            onSelect: actions.requestStop,
          } satisfies MenuItem,
        ]
      : []),
    ...sessionMenuItems(ctx, actions, Object.values(scopes)),
  ];
  return (
    <>
      <ActionSheet
        open={open}
        onClose={onClose}
        title={session.title}
        description={[project?.name, workspace?.branch].filter(Boolean).join(" · ") || undefined}
        label={`Actions for ${session.title}`}
        items={items}
      />
      {actions.dialogs}
    </>
  );
}
