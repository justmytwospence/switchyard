import type { Session, SessionModel, ThinkingLevel } from "@switchyard/protocol";
import { Brain, Check, ChevronDown, Cpu, Gauge, Shrink } from "lucide-react";
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { Sheet } from "../../components/ui/Overlay";
import { Popover } from "../../components/ui/Popover";
import { ErrorState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../sync/api";
import { codeApi } from "./api";
import { contextMeter, effortIndex, groupModels, isBusy, modelLabel } from "./model";

interface PillProps {
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  disabled?: boolean;
  mobile: boolean;
  ref?: Ref<HTMLButtonElement>;
  onClick: () => void;
  [aria: `aria-${string}`]: unknown;
}

function ControlPill({ icon, label, ariaLabel, disabled, mobile, ...trigger }: PillProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        "tap inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm hover:bg-surface-2 disabled:opacity-55",
        mobile ? "h-11 flex-1 justify-center" : "h-8",
      )}
      {...trigger}
    >
      <span aria-hidden className="shrink-0">
        {icon}
      </span>
      <span className="min-w-0 truncate">{label}</span>
      <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" />
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

  const groups = models ? groupModels(models, query) : [];
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
      {changeError != null && <ErrorState compact title="Could not change" error={changeError} />}
      <div className="flex max-h-[60vh] min-w-0 flex-col gap-3 overflow-y-auto">
        {error != null ? (
          <ErrorState title="Could not load models" error={error} onRetry={load} />
        ) : !models ? (
          <LoadingState label="Loading models…" />
        ) : groups.length === 0 ? (
          <p className="text-sm text-muted">No models match</p>
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
                    {m.reasoning && <Badge>reasoning</Badge>}
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
  const label = modelLabel(m);
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
          mobile
          icon={<Cpu className="size-4" />}
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
          mobile={false}
          icon={<Cpu className="size-4" />}
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
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-muted">Effort</span>
        <span className="text-sm font-medium capitalize">{level}</span>
      </div>
      <input
        type="range"
        min={0}
        max={levels.length - 1}
        step={1}
        value={effortIndex(levels, level)}
        onChange={(e) => onChange(levels[Number(e.target.value)]!)}
        aria-label="Effort"
        aria-valuetext={level}
        className={cn("w-full accent-accent", large ? "h-11" : "h-6")}
      />
      <div className="flex justify-between text-xs text-muted">
        {levels.map((l) => (
          <span key={l} className={cn(l === level && "font-medium text-text")}>
            {l}
          </span>
        ))}
      </div>
      <p className="text-xs text-muted">Applies from the next turn.</p>
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
    icon: <Brain className="size-4" />,
    label: draft.level,
    ariaLabel: `Effort: ${draft.level}`,
    disabled: !enabled,
  };
  if (mobile) {
    return (
      <>
        <ControlPill mobile {...pill} onClick={() => change(true)} />
        <Sheet open={open} onClose={() => change(false)} title="Effort">
          <EffortSlider levels={levels} level={draft.level} onChange={draft.setLevel} large />
        </Sheet>
      </>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={change}
      side="top"
      align="start"
      label="Effort"
      className="w-72"
      trigger={(p) => <ControlPill {...p} mobile={false} {...pill} />}
    >
      <EffortSlider levels={levels} level={draft.level} onChange={draft.setLevel} large={false} />
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
  const fill = { danger: "bg-danger", warning: "bg-warning", muted: "bg-muted" }[meter.tone];
  return (
    <Menu
      side="top"
      align="start"
      label="Context"
      items={items}
      trigger={(p) => (
        <Button
          {...p}
          size="sm"
          variant="ghost"
          icon={<Gauge className="size-3.5" />}
          aria-label={session.compacting ? "Context compacting" : `Context ${meter.label} used`}
        >
          <span className="h-1 w-8 overflow-hidden rounded bg-surface-2">
            <span
              className={cn("block h-full", fill)}
              style={{ width: `${Math.min(100, meter.percent ?? 0)}%` }}
            />
          </span>
          {meter.label}
        </Button>
      )}
    />
  );
}
