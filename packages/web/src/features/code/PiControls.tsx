import type { Session, SessionModel } from "@switchyard/protocol";
import { Brain, Check, Cpu, Gauge, Shrink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Menu, type MenuItem } from "../../components/ui/Menu";
import { Dialog, Sheet } from "../../components/ui/Overlay";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ErrorState, LoadingState } from "../../components/ui/states";
import { TextInput } from "../../components/ui/TextArea";
import { toast } from "../../components/ui/Toast";
import { cn } from "../../lib/cn";
import { errorMessage } from "../../sync/api";
import { codeApi } from "./api";
import { contextMeter, groupModels, isBusy, modelLabel } from "./model";

export function ModelChip({
  session,
  enabled,
  onOpen,
}: {
  session: Session;
  enabled: boolean;
  onOpen: () => void;
}) {
  const m = session.model;
  if (!m) return null;
  const label = modelLabel(m);
  return (
    <Button
      size="sm"
      variant="ghost"
      icon={<Cpu className="size-3.5" />}
      disabled={!enabled}
      onClick={onOpen}
      aria-label={enabled ? `Model: ${label}. Change model` : `Model: ${label}`}
      title={`${m.provider}/${m.id} (profile ${session.profileSnapshot.name})`}
    >
      <span className="max-w-48 truncate">{label}</span>
    </Button>
  );
}

export function EffortMenu({ session, enabled }: { session: Session; enabled: boolean }) {
  const m = session.model;
  if (!m || m.thinkingLevels.length <= 1) return null;
  const current = session.thinking ?? "default";
  const items: MenuItem[] = m.thinkingLevels.map((level) => ({
    id: level,
    label: level,
    kind: "radio",
    checked: level === session.thinking,
    onSelect: () => {
      codeApi.setThinking(session.id, level).catch((e) => toast.error(errorMessage(e)));
    },
  }));
  return (
    <Menu
      side="top"
      align="start"
      label="Effort"
      items={items}
      trigger={(p) => (
        <Button
          {...p}
          size="sm"
          variant="ghost"
          icon={<Brain className="size-3.5" />}
          disabled={!enabled}
          aria-label={`Effort: ${current}`}
        >
          {`effort ${current}`}
        </Button>
      )}
    />
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

export function ModelPicker({
  open,
  onClose,
  session,
  mobile,
}: {
  open: boolean;
  onClose: () => void;
  session: Session;
  mobile: boolean;
}) {
  const [models, setModels] = useState<SessionModel[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [changeError, setChangeError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const search = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!open) return;
    setModels(null);
    setQuery("");
    setChangeError(null);
    return load();
  }, [open, load]);

  const choose = async (m: SessionModel) => {
    setPending(true);
    setChangeError(null);
    try {
      await codeApi.setModel(session.id, m.provider, m.id);
      toast.success(`Model: ${modelLabel(m)}`);
      onClose();
    } catch (e) {
      setChangeError(e);
    } finally {
      setPending(false);
    }
  };

  const Surface = mobile ? Sheet : Dialog;
  const levels = session.model?.thinkingLevels ?? [];
  const groups = models ? groupModels(models, query) : [];
  return (
    <Surface open={open} onClose={onClose} title="Model and effort" initialFocus={search}>
      <div className="flex min-w-0 flex-col gap-3">
        {levels.length > 1 && (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted">Effort</span>
            <SegmentedControl
              label="Effort"
              className="flex-wrap"
              value={session.thinking ?? levels[0]!}
              options={levels.map((l) => ({ value: l, label: l }))}
              onChange={(l) => {
                setChangeError(null);
                codeApi.setThinking(session.id, l).catch(setChangeError);
              }}
            />
          </div>
        )}
        <TextInput
          ref={search}
          placeholder="Search models"
          aria-label="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {changeError != null && <ErrorState compact title="Could not change" error={changeError} />}
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
                    className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-55"
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
    </Surface>
  );
}
