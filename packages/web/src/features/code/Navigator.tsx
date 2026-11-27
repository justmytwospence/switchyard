import type { Scope, Session } from "@switchyard/protocol";
import {
  Archive,
  BellOff,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  FolderGit2,
  Layers,
  ListFilter,
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
import { formatRelative } from "../../lib/time";
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
import { branchActivity, recentSections, shortActivity } from "./mobileSessions";
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

/** The phone session list defaults to Recent; the desktop navigator to Projects. */
function defaultPrefs(screen: boolean): NavPrefs {
  return {
    filter: "active",
    query: "",
    collapsed: [],
    layout: screen ? "recent" : "projects",
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
  const filterOptionValues: NavFilter[] = screen
    ? ["active", "attention", "all"]
    : ["active", "all"];
  // The count on each filter is the branches it lists, so it always matches the rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navOpts is rebuilt each render from these
  const counts = useMemo(() => {
    const out: Partial<Record<NavFilter, number>> = {};
    for (const f of filterOptionValues) {
      out[f] = navRowCount(
        f === prefs.filter ? tree : buildNavTree(navInput, { ...navOpts, filter: f }),
      );
    }
    return out;
  }, [tree, screen]);
  const needs = useMemo(() => navNeedsInput(tree), [tree]);
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
  ];

  if (screen) {
    viewItems.push({
      id: "session-details",
      label: "Show session details",
      hint: "Run location and latest reply",
      kind: "checkbox",
      checked: prefs.showSessionDetails,
      onSelect: () => setPrefs({ ...prefs, showSessionDetails: !prefs.showSessionDetails }),
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
  const filterOptions = filterOptionValues.map((value) => ({
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
    screen,
    now: screen ? new Date() : undefined,
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
            <SessionRow row={kept} indent={0} {...rowProps} />
          </ul>
        )}
      </>
    );
  } else if (prefs.layout === "recent") {
    const sections =
      rowProps.now && sort === "activity"
        ? recentSections(
            tree.rows,
            prefs.needsInputFirst && prefs.filter !== "attention",
            rowProps.now,
          )
        : [{ label: "", rows: tree.rows }];
    body = (
      <ul
        aria-label="Recent sessions"
        className={cn("flex min-w-0 flex-col pb-4", !screen && "gap-0.5")}
      >
        {sections.flatMap(({ label, rows }) => [
          label && (
            <li
              key={`section:${label}`}
              data-testid="recent-section"
              className="bg-bg px-3 pt-3 pb-1.5"
            >
              <h3 className="text-[13px] font-semibold text-muted">{label}</h3>
            </li>
          ),
          ...rows.map((row) => (
            <SessionRow key={row.key} row={row} indent={0} expansion={expansion} {...rowProps} />
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
        className="flex min-w-0 flex-col gap-1 pb-4"
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
      onEdit={screen && scope ? () => setEditingScope(scope.id) : undefined}
      screen={screen}
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
      <div
        data-testid="navigator-header"
        className={cn(
          "@container flex shrink-0 flex-col gap-1.5 border-b border-border px-3 pt-3 pb-1.5",
          screen && "gap-2 pt-2 pb-2",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-2", screen && "gap-1.5")}>
          <h2
            className={cn(
              "font-semibold",
              screen ? "mr-auto shrink-0 text-[22px] tracking-tight" : "min-w-0 flex-1 text-sm",
            )}
          >
            Sessions
          </h2>
          {screen && ready && scopePicker}
          {screen && ready && (
            <IconButton
              data-testid="toggle-search"
              label="Search sessions"
              aria-expanded={searchShown}
              className="size-11"
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
            aria-label={screen ? "New session" : undefined}
            className={screen ? "h-11 shrink-0 rounded-lg" : undefined}
            icon={<Plus aria-hidden className="size-4" />}
            onClick={() => onNewSession()}
            disabled={!hydrated || hosts.length === 0 || projectList.length === 0}
            title={
              hydrated && hosts.length === 0
                ? "Connect a host to start sessions"
                : hydrated && projectList.length === 0
                  ? "Add a project to start sessions"
                  : undefined
            }
          >
            {screen ? "New" : "New session"}
          </Button>
        </div>
        {ready && searchShown && (
          <div className="relative">
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
        {ready && !screen && (
          <div
            data-testid="navigator-filters"
            className="flex min-w-0 flex-wrap items-center gap-x-2"
          >
            <div className="flex min-w-0 flex-1 basis-48 items-center gap-0.5">
              {scopePicker}
              <IconButton
                size="sm"
                label={scope ? "Edit scope" : "New scope"}
                icon={scope ? <Pencil className="size-3.5" /> : <Plus className="size-4" />}
                onClick={() => setEditingScope(scope?.id ?? "new")}
              />
              {!where && clearButton}
            </div>
            {where && whereName && (
              <div className="flex min-w-0 flex-1 basis-48 items-center gap-0.5">
                <WhereFilter value={whereName} onClear={() => setWhere(null)} />
                {clearButton}
              </div>
            )}
          </div>
        )}
        <ScopeDialog
          editing={editingScope}
          onClose={() => setEditingScope(null)}
          onSaved={(id) => setSelectedScopeId(id)}
        />
        {ready && (
          <div
            data-testid={screen ? "phone-session-filters" : undefined}
            className="flex min-w-0 items-center gap-1"
          >
            {screen ? (
              <SegmentedControl
                label="Session filter"
                block
                className="min-w-0 flex-1 [&>button]:min-h-11 [&>button]:px-1.5 [&>button]:text-[13px]"
                options={filterOptions.map(({ count, ...option }) => ({
                  ...option,
                  badge: <FilterCount value={option.value} count={count} />,
                }))}
                value={prefs.filter}
                onChange={(v) => setPrefs({ ...prefs, filter: v })}
              />
            ) : (
              <QuietRadio
                label="Session filter"
                options={filterOptions}
                value={prefs.filter}
                onChange={(v) => setPrefs({ ...prefs, filter: v })}
              />
            )}
            {!screen && needs.count > 0 && needs.first && (
              <button
                type="button"
                data-testid="needs-input-jump"
                title="Open the latest session that needs your input"
                aria-label={`${needs.count} need${needs.count === 1 ? "s" : ""} input: open the latest`}
                onClick={() =>
                  navigate(`/code/${encodeURIComponent(needs.first!)}`, { state: BACK_STATE })
                }
                // Only where it fits beside the counts; rows still mark what needs input.
                className="tap hidden h-8 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-xs font-medium text-warning hover:bg-surface-2 @min-[14rem]:inline-flex"
              >
                <MessageCircleQuestion aria-hidden className="size-3.5" />
                {needs.count}
              </button>
            )}
            <div className="ml-auto shrink-0">
              <Menu
                label="View options"
                items={viewItems}
                trigger={(p) => (
                  <IconButton
                    {...p}
                    size="sm"
                    label="View options"
                    className={screen ? "size-11" : undefined}
                    icon={<SlidersHorizontal aria-hidden className="size-[18px]" />}
                  />
                )}
              />
            </div>
          </div>
        )}
        {ready && screen && (whereName || anyFilter) && (
          <div data-testid="navigator-filters" className="flex min-w-0 items-center gap-2">
            {whereName && <WhereFilter value={whereName} onClear={() => setWhere(null)} />}
            {clearButton}
          </div>
        )}
      </div>
      <AdapterSlot sessionId={selectedId} placement="sidebar.header" />
      <div
        data-scroll-root
        className={cn(
          "relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain",
          screen ? "bg-bg" : "px-2 pt-2",
        )}
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

/** Quiet text radios (no box): the chosen one is highlighted; each shows a plain count. */
function QuietRadio<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string; title?: string; count: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const idx = options.findIndex((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex min-w-0 items-center gap-0.5"
      onKeyDown={(e) => {
        let next = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % options.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
          next = (idx - 1 + options.length) % options.length;
        if (next < 0) return;
        e.preventDefault();
        onChange(options[next]!.value);
        e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
      }}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: button-based radio group (WAI-ARIA radio pattern)
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            title={o.title}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              "tap inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-sm whitespace-nowrap",
              on ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text",
            )}
          >
            {o.label}
            <FilterCount value={o.value} count={o.count} />
          </button>
        );
      })}
    </div>
  );
}

function FilterCount({ value, count }: { value: string; count: number }) {
  return (
    <span data-testid={`filter-count-${value}`} className="text-xs tabular-nums text-muted">
      {count}
    </span>
  );
}

/** The scope filter: a compact chip on the phone, a labelled select in the pane. */
function ViewFilter({
  scopes,
  scope,
  title,
  onChange,
  onNew,
  onEdit,
  screen,
}: {
  scopes: Record<string, Scope>;
  scope: Scope | null;
  title?: string;
  onChange: (id: string | null) => void;
  onNew: () => void;
  onEdit?: () => void;
  screen: boolean;
}) {
  const id = useId();
  return (
    <div
      data-testid="scope-chip"
      data-active={scope ? "true" : undefined}
      className={cn("flex min-w-0 items-center text-sm", screen ? "h-11 max-w-40" : "h-8 gap-1.5")}
    >
      {!screen && (
        <label htmlFor={id} className="shrink-0 text-xs text-muted">
          Scope
        </label>
      )}
      <span
        className={cn("relative flex min-w-0 items-center", screen && "rounded-lg bg-surface-2")}
      >
        {screen && (
          <span
            aria-hidden
            className={cn(
              "pointer-events-none flex min-h-11 min-w-0 items-center gap-1 px-2 text-[13px] font-medium",
              scope ? "text-accent" : "text-muted",
            )}
          >
            <ListFilter className="size-3.5 shrink-0" />
            <span className="truncate">{scope?.name ?? "Scope"}</span>
            <ChevronDown className="size-3 shrink-0" />
          </span>
        )}
        <select
          id={id}
          aria-label={screen ? "Scope" : undefined}
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
          className={
            screen
              ? "tap absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-lg bg-transparent text-transparent [&>option]:text-text"
              : cn(
                  "tap h-8 min-w-0 max-w-full cursor-pointer appearance-none truncate rounded-md bg-transparent pr-5 pl-1 font-medium outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent",
                  scope ? "text-accent" : "text-text",
                )
          }
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
        {!screen && (
          <ChevronDown
            aria-hidden
            className="pointer-events-none absolute right-1 size-3.5 shrink-0 text-muted"
          />
        )}
      </span>
      {scope && !screen && (
        <IconButton
          size="sm"
          label="Clear scope"
          icon={<X className="size-3.5" />}
          onClick={() => onChange(null)}
        />
      )}
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
      className="flex h-8 min-w-0 items-center gap-1.5 text-sm"
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
        {group.kind === "host" && <GroupIcon group={group} />}
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
      <span className="min-w-0 flex-1 truncate text-sm">
        {group.label}
        {group.detail && <span className="ml-1.5 text-xs text-muted">{group.detail}</span>}
      </span>
    </>
  );
}

/** Which rows show their other sessions (stored, or forced open). */
interface RowExpansion {
  expanded: Set<string>;
  toggleRow: (key: string) => void;
}

interface RowProps {
  selectedId: string | null;
  screen: boolean;
  now?: Date;
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
          ? cn("size-7 justify-center rounded-lg", TONE_CLASSES[status.tone])
          : cn("size-3.5", TONE_TEXT[status.tone]),
      )}
    >
      {status.spin ? (
        <Spinner className={tile ? "size-4" : "size-3.5"} />
      ) : (
        <Icon
          aria-hidden
          className={cn(tile ? "size-4" : "size-3.5", status.pulse && "motion-safe:animate-pulse")}
        />
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
    <li className="min-w-0">
      <div
        className={cn(
          "group/row flex min-w-0 items-center",
          rowProps.screen && depth === 0 && "bg-bg px-1.5 pt-2",
        )}
      >
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
        {only && (
          <button
            type="button"
            data-testid="group-only"
            aria-label={`Only ${group.label}`}
            title={`Show only what runs ${only.kind === "host" ? "on" : "in"} ${group.label}`}
            onClick={() => setWhere(only)}
            className="tap shrink-0 rounded px-1.5 py-0.5 text-xs text-muted opacity-0 hover:bg-surface-2 hover:text-text focus-visible:opacity-100 group-hover/row:opacity-100 max-md:opacity-100"
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
            className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 max-md:opacity-100"
          />
        )}
      </div>
      {open && (
        <ul className={cn("flex min-w-0 flex-col", depth > 0 && "gap-0.5 py-0.5")}>
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
            <SessionRow
              key={row.key}
              row={row}
              indent={depth === 0 ? 1 : 2}
              expansion={expansion}
              {...rowProps}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

const INDENT = ["pl-2", "pl-7", "pl-9", "pl-11"] as const;

function PhoneRowContent({
  row,
  nested,
  now,
  showDetails,
  pending,
  badges,
  scopeName,
  outsideLabel,
}: {
  row: NavRow;
  nested: boolean;
  now: Date;
  showDetails: boolean;
  pending: string | null;
  badges: typeof NO_BADGES;
  scopeName: string | null;
  outsideLabel: RowProps["outsideLabel"];
}) {
  const { session, where, issue } = row;
  const status = row.attention ? RUNTIME_STATUS.waiting_input : rowStatusFor(row);
  const branch = row.branch !== session.title && row.branch !== row.project ? row.branch : null;
  const identity = [
    nested ? (row.role === "subagent" ? "Subagent" : "Session") : null,
    row.project,
    branch,
  ]
    .filter(Boolean)
    .join(" · ");
  const preview =
    showDetails || pending?.trim() || session.runtime === "failed"
      ? rowPreview(session, pending)
      : null;
  const at = nested ? session.lastActivityAt : branchActivity(row);
  const activity = new Date(at);
  const valid = Number.isFinite(activity.getTime());
  const activityLabel = `${nested ? "Last activity" : "Last branch activity"}: ${valid ? activity.toLocaleString() : "unknown"}`;
  return (
    <>
      <StatusMark status={status} tile />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          data-testid="mobile-session-title"
          className="line-clamp-2 break-words text-base leading-5 font-semibold"
          title={session.title}
        >
          {session.title}
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-4 text-muted">
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
            <span aria-hidden className="shrink-0 text-subtle">
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
      <time
        data-testid="row-activity"
        dateTime={valid ? activity.toISOString() : undefined}
        title={activityLabel}
        className={cn(
          "max-w-16 shrink-0 truncate text-right text-xs leading-5 text-muted tabular-nums",
          row.others.length > 0 && "w-16",
        )}
      >
        <span aria-hidden>{shortActivity(at, now)}</span>
        <span className="sr-only">{activityLabel}</span>
      </time>
    </>
  );
}

function SessionRow({
  row,
  indent,
  expansion,
  nested = false,
  ...rowProps
}: RowProps & {
  row: NavRow;
  indent: 0 | 1 | 2 | 3;
  expansion?: RowExpansion;
  nested?: boolean;
}) {
  const { selectedId, screen, now, showSessionDetails, scopeName, outsideLabel, onRowActions } =
    rowProps;
  const { session, attention } = row;
  const press = useLongPress(() => onRowActions?.(session.id, "sheet"), {
    enabled: !!onRowActions,
  });
  const selected = session.id === selectedId;
  const context = [row.project, row.branch].filter(Boolean).join(" · ");
  const status = rowStatusFor(row);
  const pending = rowProps.pendingTitles.get(session.id) ?? null;
  const preview = screen ? null : rowPreview(session, pending);
  const badges = rowProps.badges[session.id] ?? NO_BADGES;
  const count = row.others.length;
  const open =
    count > 0 &&
    (!!expansion?.expanded.has(row.key) ||
      row.othersNeedInput ||
      row.others.some((o) => o.session.id === selectedId));
  const needsInput = attention || (!nested && row.othersNeedInput);
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
    <div className={cn("flex min-w-0", screen ? "relative" : "items-center")}>
      <Link
        {...(swipeable ? press : {})}
        data-testid={nested ? "session-subrow" : "session-row"}
        data-keyboard-item
        to={`/code/${encodeURIComponent(session.id)}`}
        state={BACK_STATE}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "tap flex min-w-0 flex-1 hover:bg-surface-2",
          screen
            ? cn(
                "min-h-16 items-start gap-2.5 bg-surface px-3 py-2.5 outline-offset-[-2px]",
                count > 0 && "min-h-[68px]",
              )
            : cn("flex-col gap-0.5 rounded-md py-1.5 pr-2", INDENT[indent]),
          swipeable && cn(LONG_PRESS_CLASS, "sy-press-row active:bg-surface-2"),
          selected && "bg-accent-soft hover:bg-accent-soft",
        )}
      >
        {screen && now ? (
          <PhoneRowContent
            row={row}
            nested={nested}
            now={now}
            showDetails={showSessionDetails}
            pending={pending}
            badges={badges}
            scopeName={scopeName}
            outsideLabel={outsideLabel}
          />
        ) : (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <StatusMark status={status} />
              <span className="min-w-0 flex-1 truncate text-sm">{session.title}</span>
              {needsInput && session.runtime !== "waiting_input" && (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-medium text-warning">
                  <MessageCircleQuestion aria-hidden className="size-3.5" />
                  Needs input
                </span>
              )}
              <span className="shrink-0 text-xs text-subtle tabular-nums">
                {formatRelative(session.lastActivityAt)}
              </span>
            </span>
            {/* Always one line tall, so a preview or badge arriving never moves the list. */}
            <span className="flex min-h-4 min-w-0 items-center gap-x-1.5 pl-5">
              {nested && (
                <span className="shrink-0 text-xs text-muted">
                  {row.role === "subagent" ? "Subagent" : "Extra"}
                </span>
              )}
              {row.issue && (
                <span className="shrink-0 text-xs text-muted" title={row.issue.title}>
                  #{row.issue.number}
                </span>
              )}
              {row.leaves && (
                <span
                  data-testid="row-no-issue"
                  className="shrink-0 text-xs text-subtle"
                  title={`In ${scopeName ?? "this scope"} only while it is live. Pin it or link an issue to keep it.`}
                >
                  No issue
                </span>
              )}
              {row.outside && (
                <span
                  data-testid="row-outside"
                  data-reason={row.outside}
                  className="shrink-0 text-xs text-subtle"
                  title="Listed because it is open"
                >
                  {outsideLabel(row.outside)}
                </span>
              )}
              {row.where && (
                <span
                  data-testid="row-where"
                  title={
                    row.where.kind === "terminal"
                      ? `Runs in ${row.where.label}`
                      : `Runs on ${row.where.label}`
                  }
                  className="inline-flex min-w-0 items-center gap-0.5 text-xs text-muted"
                >
                  {row.where.kind === "terminal" ? (
                    <SquareTerminal aria-hidden className="size-3 shrink-0" />
                  ) : (
                    <Server aria-hidden className="size-3 shrink-0" />
                  )}
                  <span className="truncate">{row.where.label}</span>
                </span>
              )}
              {badges.map((b) => (
                <span
                  key={`${b.adapterId}:${b.id}`}
                  data-testid="row-badge"
                  className={cn(
                    "max-w-24 shrink-0 truncate text-xs",
                    BADGE_TONE[b.tone ?? "muted"],
                  )}
                  title={b.text}
                >
                  {b.text}
                </span>
              ))}
              {context && (
                <span className="max-w-[45%] min-w-0 shrink-0 truncate text-xs text-muted">
                  {context}
                </span>
              )}
              {/* The preview gives way first, so where it runs stays readable. */}
              <span
                data-testid="row-preview"
                className="min-w-0 flex-1 basis-0 truncate text-xs text-subtle"
              >
                {preview}
              </span>
            </span>
          </>
        )}
      </Link>
      {swipeable && (
        <button
          type="button"
          className="sr-only focus:not-sr-only focus:absolute focus:inset-y-1 focus:left-1 focus:z-10 focus:rounded-md focus:bg-surface-2 focus:px-2"
          onClick={() => onRowActions?.(session.id, "sheet")}
        >
          Actions for {session.title}
        </button>
      )}
      {count > 0 && (
        <button
          type="button"
          data-testid="row-others"
          aria-expanded={open}
          aria-label={`${count} more ${count === 1 ? "session" : "sessions"} in this branch`}
          onClick={() => expansion?.toggleRow(row.key)}
          className={cn(
            "tap shrink-0 rounded text-xs text-muted hover:bg-surface-2",
            screen
              ? "absolute top-6 right-1 flex h-11 min-w-11 items-center justify-end gap-0.5 px-2 tabular-nums outline-offset-[-2px]"
              : "px-1.5 py-0.5",
            screen && row.othersNeedInput && !attention && "font-semibold text-warning",
          )}
        >
          {screen && row.othersNeedInput && !attention && (
            <MessageCircleQuestion
              className="size-3"
              aria-label="One of these sessions needs input"
            />
          )}
          +{count}
          {screen &&
            (open ? (
              <ChevronDown aria-hidden className="size-3.5 rotate-180" />
            ) : (
              <ChevronDown aria-hidden className="size-3.5" />
            ))}
        </button>
      )}
    </div>
  );
  return (
    <li
      className={cn(
        "min-w-0",
        screen &&
          "relative after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:border-b after:border-border",
      )}
    >
      {swipeable ? (
        <SwipeRow leading={leading} trailing={trailing}>
          {line}
        </SwipeRow>
      ) : (
        line
      )}
      {open && (
        <ul
          className={cn(
            "flex min-w-0 flex-col",
            screen ? "ml-6 border-l border-border-strong" : "gap-0.5",
          )}
        >
          {row.others.map((o) => (
            <SessionRow
              key={o.session.id}
              row={o}
              indent={Math.min(indent + 1, 3) as 0 | 1 | 2 | 3}
              nested
              {...rowProps}
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
