import type { Session, SessionModel, ThinkingLevel } from "@switchyard/protocol";
import { Brain, Check, Cpu, Shrink } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { Sheet } from "../../components/ui/Overlay";
import { Popover } from "../../components/ui/Popover";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ErrorState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
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
} from "./model";

interface PillProps {
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
  [aria: `aria-${string}`]: unknown;
}

/** Compact chip for the composer's action row (44 px tall on touch screens via `.tap`). */
function ControlPill({ icon, label, ariaLabel, disabled, className, ...trigger }: PillProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "tap inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-xs font-medium text-text transition-colors hover:bg-border disabled:opacity-55",
        className,
      )}
      {...trigger}
    >
      <span aria-hidden className="shrink-0 text-muted">
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
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

export function ContextMeter({ session, enabled }: { session: Session; enabled: boolean }) {
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
  const items: (MenuItem | { id: string; heading: string })[] = [
    { id: "detail", heading: meter.detail },
    {
      id: "compact",
      label: "Compact now",
      icon: <Shrink className="size-4" />,
      disabled: !!hint,
      hint,
      onSelect: () => {
        codeApi.compact(session.id).then(
          () => toast.success("Compacting context"),
          (e) => toast.error(errorMessage(e)),
        );
      },
    },
  ];
  const fill = { danger: "bg-danger", warning: "bg-warning", muted: "bg-subtle" }[meter.tone];
  return (
    <Menu
      side="top"
      align="start"
      label="Context"
      items={items}
      className="w-full"
      trigger={(p) => (
        <button
          type="button"
          {...p}
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
          className="relative flex w-full items-center gap-2 py-0.5 text-[11px] leading-4 text-muted transition-colors before:absolute before:inset-x-0 before:-top-3 before:bottom-0 before:content-[''] hover:text-text [@media(pointer:coarse)]:before:-top-6"
        >
          <span className="h-[3px] flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className={cn("block h-full rounded-full transition-[width]", fill)}
              style={{ width: `${Math.min(100, meter.percent ?? 0)}%` }}
            />
          </span>
          <span className="tabular-nums">
            {session.compacting ? meter.label : `Context ${meter.label}`}
          </span>
        </button>
      )}
    />
  );
}
