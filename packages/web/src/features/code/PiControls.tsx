import type { ProviderUsage, Session, SessionModel, ThinkingLevel } from "@switchyard/protocol";
import { Brain, Check, Cpu, Shrink } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Overlay";
import { Popover } from "../../components/ui/Popover";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Spinner } from "../../components/ui/Spinner";
import { ErrorState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/time";
import { errorMessage } from "../../sync/api";
import { codeApi } from "./api";
import {
  contextMeter,
  effortIndex,
  favoriteModels,
  groupModels,
  isBusy,
  modelLabel,
  pillModelLabel,
  usageTone,
} from "./model";

interface PillProps {
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  /** Show only the icon (a phone's narrow row); the label stays for assistive technology. */
  iconOnly?: boolean;
  title?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
  [aria: `aria-${string}`]: unknown;
}

/** Compact chip for the composer's action row (44 px tall on touch screens via `.tap`). */
function ControlPill({
  icon,
  label,
  ariaLabel,
  disabled,
  iconOnly,
  title,
  className,
  ...trigger
}: PillProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "tap inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md bg-surface-2 text-xs font-medium text-text transition-colors hover:bg-border disabled:opacity-55",
        iconOnly ? "w-8 justify-center px-0" : "px-2.5",
        className,
      )}
      {...trigger}
    >
      <span aria-hidden className="shrink-0 text-muted">
        {icon}
      </span>
      <span className={iconOnly ? "sr-only" : "min-w-0 truncate"}>{label}</span>
    </button>
  );
}

function ModelList({
  session,
  searchInFooter,
  searchRef,
  onChosen,
}: {
  session: Session;
  searchInFooter: boolean;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onChosen: () => void;
}) {
  const [models, setModels] = useState<SessionModel[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [changeError, setChangeError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [show, setShow] = useState<"favorites" | "all">("favorites");

  const load = useCallback(() => {
    const ac = new AbortController();
    setError(null);
    codeApi.models(session.id, ac.signal).then(
      (r) => setModels(r.models),
      (e) => {
        if (!ac.signal.aborted) setError(e);
      },
    );
    return () => ac.abort();
  }, [session.id]);

  useEffect(() => load(), [load]);

  const choose = async (m: SessionModel) => {
    setPending(true);
    setChangeError(null);
    try {
      await codeApi.setModel(session.id, m.provider, m.id);
      toast.success(`Model: ${modelLabel(m)}`);
      onChosen();
    } catch (e) {
      setChangeError(e);
    } finally {
      setPending(false);
    }
  };

  const hasFavorites = models?.some((m) => m.scoped === true) ?? false;
  const favoritesOnly = hasFavorites && show === "favorites";
  const pool = models && favoritesOnly ? favoriteModels(models, session.model ?? null) : models;
  const groups = pool ? groupModels(pool, query) : [];
  const search = (
    <TextInput
      ref={searchRef}
      placeholder="Search models"
      aria-label="Search models"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
    />
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {!searchInFooter && search}
      {hasFavorites && (
        <SegmentedControl
          label="Show"
          value={show}
          onChange={setShow}
          options={[
            { value: "favorites", label: "Favorites" },
            { value: "all", label: "All" },
          ]}
        />
      )}
      {changeError != null && <ErrorState compact title="Could not change" error={changeError} />}
      <div className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto">
        {error != null ? (
          <ErrorState title="Could not load models" error={error} onRetry={load} />
        ) : !models ? (
          <LoadingState label="Loading models…" />
        ) : groups.length === 0 ? (
          favoritesOnly ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm text-muted">No favorites match</p>
              <Button size="sm" variant="ghost" onClick={() => setShow("all")}>
                Search all models
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted">No models match</p>
          )
        ) : (
          groups.map((g) => (
            <section key={g.provider} className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-muted">{g.provider}</h3>
              {g.models.map((m) => {
                const current = session.model?.provider === m.provider && session.model.id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    disabled={pending}
                    aria-current={current ? "true" : undefined}
                    onClick={() => void choose(m)}
                    className="tap flex min-h-11 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-55"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{modelLabel(m)}</span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {m.provider}/{m.id}
                        {m.contextWindow !== null &&
                          ` · ${Math.round(m.contextWindow / 1000)}k context`}
                      </span>
                    </span>
                    {current && <Check aria-hidden className="size-4" />}
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>
      {searchInFooter && <div className="sticky bottom-0 bg-surface pt-2">{search}</div>}
    </div>
  );
}

export function ModelControl({
  session,
  enabled,
  mobile,
  open,
  onOpenChange,
}: {
  session: Session;
  enabled: boolean;
  mobile: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const m = session.model;
  if (!m) return null;
  const label = pillModelLabel(m);
  const ariaLabel = enabled ? `Model: ${label}. Change model` : `Model: ${label}`;
  const list = (footer: boolean) => (
    <ModelList
      session={session}
      searchInFooter={footer}
      searchRef={searchRef}
      onChosen={() => onOpenChange(false)}
    />
  );
  if (mobile) {
    return (
      <>
        <ControlPill
          className="max-w-[60vw]"
          icon={<Cpu className="size-3.5" />}
          label={label}
          ariaLabel={ariaLabel}
          disabled={!enabled}
          onClick={() => onOpenChange(true)}
        />
        <Sheet open={open} onClose={() => onOpenChange(false)} title="Model">
          {list(true)}
        </Sheet>
      </>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      side="top"
      align="start"
      label="Model"
      className="w-96"
      initialFocus={searchRef}
      trigger={(p) => (
        <ControlPill
          {...p}
          className="max-w-64"
          icon={<Cpu className="size-3.5" />}
          label={label}
          ariaLabel={ariaLabel}
          disabled={!enabled}
        />
      )}
    >
      {list(false)}
    </Popover>
  );
}

function useEffortDraft(session: Session) {
  const levels = session.model?.thinkingLevels ?? [];
  const server = session.thinking ?? levels[0] ?? "off";
  const [draft, setDraft] = useState<string>(server);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ draft, session });
  latest.current = { draft, session };

  const commit = useCallback((l: string) => {
    const s = latest.current.session;
    if (l === s.thinking) return;
    codeApi.setThinking(s.id, l as ThinkingLevel).catch((e) => {
      toast.error(errorMessage(e));
      setDraft(s.thinking ?? s.model?.thinkingLevels[0] ?? "off");
    });
  }, []);

  const flush = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    commit(latest.current.draft);
  }, [commit]);

  const setLevel = (l: string) => {
    setDraft(l);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      commit(l);
    }, 400);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the server unless a change is pending
  useEffect(() => {
    if (timer.current === null) setDraft(server);
  }, [session.thinking, session.model?.id]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush once on unmount
  useEffect(() => flush, []);

  return { level: draft, setLevel, flush };
}

function EffortSlider({
  levels,
  level,
  onChange,
  large,
}: {
  levels: readonly string[];
  level: string;
  onChange: (l: string) => void;
  large: boolean;
}) {
  const index = effortIndex(levels, level);
  const last = Math.max(levels.length - 1, 1);
  // Dots sit where the (invisible, 16 px) native thumb's centre travels: 8 px in from each edge.
  const at = (i: number) => `calc(8px + (100% - 16px) * ${i / last})`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">Effort</span>
        <span className="text-sm font-medium capitalize">{level}</span>
      </div>
      <div className={cn("group relative w-full", large ? "h-11" : "h-8")}>
        <div className="pointer-events-none absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border-strong" />
        <div
          className="pointer-events-none absolute left-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-accent transition-[width]"
          style={{ width: `calc((100% - 16px) * ${index / last})` }}
        />
        {levels.map((l, i) => (
          <span
            key={l}
            aria-hidden
            data-effort-dot={i === index ? "selected" : undefined}
            className={cn(
              "pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-all",
              i === index
                ? "size-4 bg-accent ring-4 ring-accent-soft group-has-[input:focus-visible]:outline-2 group-has-[input:focus-visible]:outline-offset-2 group-has-[input:focus-visible]:outline-accent"
                : i < index
                  ? "size-2.5 bg-accent"
                  : "size-2.5 bg-border-strong",
            )}
            style={{ left: at(i) }}
          />
        ))}
        <input
          type="range"
          min={0}
          max={levels.length - 1}
          step={1}
          value={index}
          onChange={(e) => onChange(levels[Number(e.target.value)]!)}
          aria-label="Effort"
          aria-valuetext={level}
          className="peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 [&::-moz-range-thumb]:size-4 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none"
        />
      </div>
      <div className="relative h-4 text-[11px] text-muted">
        {levels.map((l, i) => (
          <span
            key={l}
            className={cn(
              "absolute top-0 -translate-x-1/2 whitespace-nowrap",
              i === index && "font-medium text-text",
            )}
            style={{ left: at(i) }}
          >
            {l}
          </span>
        ))}
      </div>
      <p className="mt-1 text-xs text-muted">Applies from the next turn.</p>
    </div>
  );
}

export function EffortControl({
  session,
  enabled,
  mobile,
}: {
  session: Session;
  enabled: boolean;
  mobile: boolean;
}) {
  const [open, setOpen] = useState(false);
  const draft = useEffortDraft(session);
  const levels = session.model?.thinkingLevels ?? [];
  if (!session.model || levels.length <= 1) return null;
  const change = (o: boolean) => {
    if (!o) draft.flush();
    setOpen(o);
  };
  const pill = {
    icon: <Brain className="size-3.5" />,
    label: draft.level,
    ariaLabel: `Effort: ${draft.level}`,
    disabled: !enabled,
    iconOnly: mobile,
    title: `Effort: ${draft.level}`,
    className: "shrink-0 capitalize",
  };
  return (
    <Popover
      open={open}
      onOpenChange={change}
      side="top"
      align="start"
      label="Effort"
      className="w-72"
      fitViewport={mobile}
      trigger={(p) => <ControlPill {...p} {...pill} />}
    >
      <EffortSlider levels={levels} level={draft.level} onChange={draft.setLevel} large={mobile} />
    </Popover>
  );
}

const USAGE_TONE = {
  neutral: "text-muted",
  warning: "text-warning",
  danger: "text-danger",
} as const;

/**
 * How full the context is, as a ring. It opens the context tokens, the session's tokens and cost,
 * the provider's subscription limits and Compact now. A dot marks a limit that is nearly used up.
 */
export function ContextRing({
  session,
  enabled,
  usage,
  mobile,
}: {
  session: Session;
  enabled: boolean;
  usage: ProviderUsage | null;
  mobile: boolean;
}) {
  const [open, setOpen] = useState(false);
  const meter = contextMeter(session);
  if (!meter) return null;
  const busy = isBusy(session);
  const hint = !enabled
    ? "The session is not running"
    : session.compacting
      ? "Compaction is running"
      : busy
        ? "Wait for the run to finish"
        : undefined;
  const pct = Math.min(100, Math.max(0, meter.percent ?? 0));
  const circumference = 2 * Math.PI * 7;
  const tone = { danger: "text-danger", warning: "text-warning", muted: "text-muted" }[meter.tone];
  const windows = usage?.status === "available" ? usage.windows : [];
  const limitTone = usageTone(windows.reduce((m, w) => Math.max(m, w.usedPct), 0));
  const stats = session.stats;
  const spent = [
    stats?.tokens != null ? `${stats.tokens.toLocaleString("en-US")} tokens` : null,
    stats?.costUsd != null ? `$${stats.costUsd.toFixed(2)}` : null,
  ].filter((x): x is string => x !== null);
  const heading = "text-xs font-medium text-muted";
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="end"
      label="Context"
      className="w-72"
      fitViewport={mobile}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          data-testid="context-ring"
          aria-label={
            session.compacting
              ? "Context compacting"
              : meter.percent === null
                ? "Context use not known yet"
                : `Context ${meter.label} used`
          }
          title={
            session.compacting ? meter.detail : `Context ${meter.label} used · ${meter.detail}`
          }
          className="tap relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-text"
        >
          {session.compacting ? (
            <Spinner className="size-4" />
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden className={cn("size-5 -rotate-90", tone)}>
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeOpacity="0.25"
                strokeWidth="2.5"
              />
              {/* An empty context draws no arc: a round cap alone reads as a spinner. */}
              {pct > 0 && (
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - pct / 100)}
                />
              )}
            </svg>
          )}
          {limitTone !== "neutral" && (
            <span
              aria-hidden
              className={cn(
                "absolute top-1 right-1 size-1.5 rounded-full",
                limitTone === "danger" ? "bg-danger" : "bg-warning",
              )}
            />
          )}
        </button>
      )}
    >
      <div className="flex min-w-0 flex-col gap-3 text-sm">
        <section>
          <h3 className={heading}>Context</h3>
          <p className="tabular-nums">
            {session.compacting
              ? "Compacting…"
              : meter.percent === null
                ? "Not known yet"
                : `${meter.label} used`}
          </p>
          <p className="text-xs text-muted">{meter.detail}</p>
        </section>
        {spent.length > 0 && (
          <section>
            <h3 className={heading}>This session</h3>
            <p className="text-xs text-muted tabular-nums">{spent.join(" · ")}</p>
          </section>
        )}
        {usage && usage.status !== "error" && (
          <section data-testid="usage-meter">
            <h3 className={heading}>Subscription limits</h3>
            {usage.status !== "available" ? (
              <p className="text-xs text-muted">{usage.message ?? "Usage unavailable"}</p>
            ) : (
              usage.windows.map((w) => (
                <p
                  key={w.id}
                  className={cn("text-xs tabular-nums", USAGE_TONE[usageTone(w.usedPct)])}
                >
                  {w.id === "five_hour" ? "Session limit" : "Weekly limit"} {Math.round(w.usedPct)}%
                  used, resets {formatRelative(w.resetsAt)}
                </p>
              ))
            )}
          </section>
        )}
        <div>
          <Button
            size="sm"
            icon={<Shrink className="size-3.5" />}
            disabled={!!hint}
            onClick={() => {
              setOpen(false);
              codeApi.compact(session.id).then(
                () => toast.success("Compacting context"),
                (e) => toast.error(errorMessage(e)),
              );
            }}
          >
            Compact now
          </Button>
          {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
        </div>
      </div>
    </Popover>
  );
}
