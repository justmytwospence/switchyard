import type { Priority } from "@switchyard/protocol";
import { PRIORITY_LABELS } from "@switchyard/protocol";
import { CirclePause, CirclePlay, Filter, Search, X } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { ROUTES } from "../../app/routes";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Checkbox } from "../../components/ui/Checkbox";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { Select } from "../../components/ui/Select";
import {
  ErrorState,
  HostUnavailable,
  InteractionPending,
  UnsupportedCapability,
} from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { TextLink } from "../../components/ui/TextLink";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { errorMessage, isApiError } from "../../sync/api";
import { pendingInteractionsForSessions } from "../../sync/selectors";
import { useHosts, useProjects, useSyncStore } from "../../sync/store";
import { setDispatchPaused } from "./api";
import { activeFilterChips, type BoardFilters, type BoardSort, DEFAULT_FILTERS } from "./logic";
import type { BoardState } from "./useBoard";

export function ProjectSelect({ board, className }: { board: BoardState; className?: string }) {
  const projects = useProjects();
  const id = useId();
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className="sr-only">
        Project
      </label>
      <Select
        id={id}
        className="max-w-56"
        value={board.projectId ?? ""}
        onChange={(e) => board.setProjectId(e.target.value || null)}
      >
        <option value="">All projects</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

export function SearchBox({ board, className }: { board: BoardState; className?: string }) {
  const id = useId();
  return (
    <div className={cn("relative min-w-0", className)}>
      <label htmlFor={id} className="sr-only">
        Search tasks
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle"
      />
      <TextInput
        id={id}
        type="search"
        placeholder="Search tasks"
        className="pl-8"
        value={board.filters.search}
        onChange={(e) => board.setFilters({ ...board.filters, search: e.target.value })}
      />
    </div>
  );
}

export function SortSelect({ board }: { board: BoardState }) {
  const id = useId();
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <label htmlFor={id} className="text-muted">
        Sort
      </label>
      <Select
        id={id}
        width="auto"
        value={board.filters.sort}
        onChange={(e) => board.setFilters({ ...board.filters, sort: e.target.value as BoardSort })}
      >
        <option value="priority">Priority</option>
        <option value="updated">Recently updated</option>
        <option value="created">Newest</option>
      </Select>
    </div>
  );
}

export function CompletedToggle({ board }: { board: BoardState }) {
  return (
    <Checkbox
      label="Show completed"
      checked={board.filters.showCompleted}
      onChange={(on) => board.setFilters({ ...board.filters, showCompleted: on })}
    />
  );
}

/** Automation enabled/paused status and the pause/resume toggle (never terminates active runs). */
export function DispatchToggle({ compact }: { compact?: boolean }) {
  const paused = useSyncStore((s) => s.dispatchPaused);
  const [busy, setBusy] = useState(false);
  const Icon = paused ? CirclePause : CirclePlay;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
      <span
        role="status"
        className={cn(
          "inline-flex items-center gap-1.5 font-medium",
          paused ? "text-warning" : "text-success",
        )}
      >
        <Icon aria-hidden className="size-4" />
        <span className="text-text">{paused ? "Automation paused" : "Automation enabled"}</span>
      </span>
      <Button
        size="sm"
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await setDispatchPaused(!paused);
            toast.success(
              paused
                ? "Dispatch resumed. Ready tasks start when eligible."
                : "Dispatch paused. Running work continues; nothing new starts.",
            );
          } catch (e) {
            toast.error(`Could not ${paused ? "resume" : "pause"} dispatch: ${errorMessage(e)}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        {paused ? "Resume dispatch" : compact ? "Pause" : "Pause dispatch"}
      </Button>
    </div>
  );
}

function FilterFields({
  value,
  onChange,
  withSort,
}: {
  value: BoardFilters;
  onChange: (f: BoardFilters) => void;
  withSort?: boolean;
}) {
  const hosts = useHosts();
  const id = useId();
  const togglePriority = (p: Priority, on: boolean) =>
    onChange({
      ...value,
      priorities: on ? [...value.priorities, p] : value.priorities.filter((x) => x !== p),
    });
  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Priority</legend>
        <div className="flex flex-wrap gap-x-4">
          {PRIORITY_LABELS.map((l, i) => (
            <Checkbox
              key={l}
              label={l}
              checked={value.priorities.includes(i as Priority)}
              onChange={(on) => togglePriority(i as Priority, on)}
            />
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-host`} className="text-sm font-medium">
          Host
        </label>
        <Select
          id={`${id}-host`}
          value={value.hostId ?? ""}
          onChange={(e) => onChange({ ...value, hostId: e.target.value || null })}
        >
          <option value="">Any host</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Show</legend>
        <Checkbox
          label="Only tasks that need attention"
          checked={value.attentionOnly}
          onChange={(on) => onChange({ ...value, attentionOnly: on })}
        />
        <Checkbox
          label="Only blocked tasks"
          checked={value.blockedOnly}
          onChange={(on) => onChange({ ...value, blockedOnly: on })}
        />
        <Checkbox
          label="Canceled tasks"
          checked={value.showCanceled}
          onChange={(on) => onChange({ ...value, showCanceled: on })}
        />
        <Checkbox
          label="Completed tasks"
          checked={value.showCompleted}
          onChange={(on) => onChange({ ...value, showCompleted: on })}
        />
      </fieldset>
      {withSort && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-sort`} className="text-sm font-medium">
            Sort
          </label>
          <Select
            id={`${id}-sort`}
            value={value.sort}
            onChange={(e) => onChange({ ...value, sort: e.target.value as BoardSort })}
          >
            <option value="priority">Priority</option>
            <option value="updated">Recently updated</option>
            <option value="created">Newest</option>
          </Select>
        </div>
      )}
    </div>
  );
}

/** Filters button: a dialog on desktop, a sheet on mobile. Applies on "Show results". */
export function FilterButton({ board, mobile }: { board: BoardState; mobile?: boolean }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(board.filters);
  const hosts = useSyncStore((s) => s.hosts);
  const count = activeFilterChips(board.filters, (id) => hosts[id]?.name ?? "host").filter(
    (c) => c.key !== "search",
  ).length;
  const Surface = mobile ? Sheet : Dialog;
  return (
    <>
      <Button
        icon={<Filter className="size-4" />}
        onClick={() => {
          setDraft(board.filters);
          setOpen(true);
        }}
        aria-label={count ? `Filters, ${count} active` : "Filters"}
      >
        Filters
        {count > 0 && <Badge tone="accent">{count}</Badge>}
      </Button>
      <Surface
        open={open}
        onClose={() => setOpen(false)}
        title="Filter tasks"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setDraft({ ...DEFAULT_FILTERS, search: draft.search })}
            >
              Reset
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                board.setFilters(draft);
                setOpen(false);
              }}
            >
              Show results
            </Button>
          </>
        }
      >
        <FilterFields value={draft} onChange={setDraft} withSort={mobile} />
      </Surface>
    </>
  );
}

/** Active filters as removable chips. */
export function FilterChips({
  board,
  includeSearch,
}: {
  board: BoardState;
  includeSearch?: boolean;
}) {
  const hosts = useSyncStore((s) => s.hosts);
  const chips = activeFilterChips(board.filters, (id) => hosts[id]?.name ?? "Unknown host").filter(
    (c) => includeSearch || c.key !== "search",
  );
  if (chips.length === 0) return null;
  return (
    <ul
      data-testid="filter-chips"
      aria-label="Active filters"
      className="flex min-w-0 flex-wrap gap-1.5"
    >
      {chips.map((c) => (
        <li key={c.key} className="min-w-0">
          <button
            type="button"
            onClick={() => board.setFilters(c.clear(board.filters))}
            aria-label={`Remove filter ${c.label}`}
            className="tap inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-0.5 text-xs font-medium"
          >
            <span className="truncate">{c.label}</span>
            <X aria-hidden className="size-3.5 shrink-0" />
          </button>
        </li>
      ))}
      {chips.length > 1 && (
        <li>
          <TextLink
            size="xs"
            onClick={() => board.setFilters({ ...DEFAULT_FILTERS, sort: board.filters.sort })}
          >
            Clear all
          </TextLink>
        </li>
      )}
    </ul>
  );
}

/** Host unavailable, pending interactions and queue-detail problems above the board (spec 18). */
export function BoardNotices({ board }: { board: BoardState }) {
  const tasks = useSyncStore((s) => s.tasks);
  const runs = useSyncStore((s) => s.runs);
  const hosts = useSyncStore((s) => s.hosts);
  const interactions = useSyncStore((s) => s.interactions);
  const { offline, pending } = useMemo(() => {
    const offlineIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const t of Object.values(tasks)) {
      if (board.projectId && t.projectId !== board.projectId) continue;
      if (t.sessionId) sessionIds.add(t.sessionId);
      const run = t.currentRunId ? runs[t.currentRunId] : undefined;
      if (t.state === "in_progress" && run?.hostId) {
        const h = hosts[run.hostId];
        if (h && h.connectivity !== "connected") offlineIds.add(h.id);
      }
    }
    const pend = pendingInteractionsForSessions(interactions, sessionIds);
    return { offline: [...offlineIds].map((id) => hosts[id]!), pending: pend };
  }, [tasks, runs, hosts, interactions, board.projectId]);

  const nowErr = board.now.error;
  const notices: ReactNode[] = [];
  for (const h of offline)
    notices.push(
      <HostUnavailable
        key={`host-${h.id}`}
        compact
        hostName={h.name}
        connectivity={h.connectivity === "reconnecting" ? "reconnecting" : "unreachable"}
        lastSeenAt={h.lastSeenAt}
        detail="Its In progress tasks keep their last known state; nothing is restarted elsewhere."
      />,
    );
  if (pending.length > 0)
    notices.push(
      <InteractionPending
        key="pending"
        count={pending.length}
        to={ROUTES.interaction(pending[0]!.sessionId, pending[0]!.id)}
        label={
          pending.length === 1
            ? "A task needs your answer"
            : `${pending.length} questions need your answer`
        }
      />,
    );
  if (nowErr !== null && nowErr !== undefined) {
    if (isApiError(nowErr) && nowErr.status === 404)
      notices.push(
        <UnsupportedCapability
          key="now"
          capability="Queue details"
          reason="This coordinator does not report why Ready tasks are waiting."
        />,
      );
    else
      notices.push(
        <ErrorState
          key="now"
          compact
          title="Could not load the dispatch queue"
          error={errorMessage(nowErr)}
          onRetry={board.now.reload}
        />,
      );
  }
  if (notices.length === 0) return null;
  return <div className="flex flex-col gap-2 px-4 pt-2">{notices}</div>;
}
