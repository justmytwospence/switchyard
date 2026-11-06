import type { Host, ProjectSuggestionsResponse } from "@switchyard/protocol";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Checkbox } from "../../components/ui/Checkbox";
import { InlineError } from "../../components/ui/states";
import { toast } from "../../components/ui/Toast";
import { formatRelative } from "../../lib/time";
import { apiGet, apiPost, errorMessage, isApiError } from "../../sync/api";

/** Repositories used with Pi recently on a host, to add as projects in one step. */
export function ProjectSuggestions({ host, compact }: { host: Host; compact?: boolean }) {
  const [items, setItems] = useState<ProjectSuggestionsResponse["suggestions"] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const connected = host.connectivity === "connected";

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per host and connection
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    apiGet<ProjectSuggestionsResponse>(
      `/api/hosts/${encodeURIComponent(host.id)}/project-suggestions`,
    ).then(
      (r) => {
        if (!alive) return;
        setItems(r.suggestions);
        setChecked(new Set(r.suggestions.filter((s) => s.preselected).map((s) => s.rootPath)));
      },
      (e) => {
        if (alive && !isApiError(e, "unsupported_capability")) setError(e);
      },
    );
    return () => {
      alive = false;
    };
  }, [host.id, connected]);

  if (!items || items.length === 0) {
    return error ? <InlineError error={error} /> : null;
  }

  const add = async () => {
    setBusy(true);
    let added = 0;
    const failed: string[] = [];
    for (const s of items.filter((i) => checked.has(i.rootPath))) {
      try {
        await apiPost("/api/projects", { name: s.name, hostId: host.id, path: s.rootPath });
        added += 1;
      } catch (e) {
        if (isApiError(e, "conflict")) added += 1;
        else failed.push(`${s.name}: ${errorMessage(e)}`);
      }
    }
    setBusy(false);
    if (added > 0) toast.success(`Added ${added} project${added === 1 ? "" : "s"}`);
    for (const f of failed) toast.error(f);
    setItems((prev) => prev?.filter((i) => !checked.has(i.rootPath)) ?? null);
    setChecked(new Set());
  };

  return (
    <Card
      testId="project-suggestions"
      title="Suggested from your Pi history"
      description={`Repositories you used with Pi in the last 30 days on ${host.name}.`}
      className={compact ? "mb-3" : undefined}
      actions={
        <Button
          variant="primary"
          size="sm"
          busy={busy}
          disabled={checked.size === 0}
          onClick={() => void add()}
        >
          Add selected
        </Button>
      }
    >
      <ul className="flex flex-col gap-1">
        {items.map((s) => (
          <li key={s.rootPath}>
            <Checkbox
              label={s.name}
              description={
                <span className="font-mono text-xs text-muted">
                  {s.rootPath} · {s.sessionCount} session{s.sessionCount === 1 ? "" : "s"} · last{" "}
                  {formatRelative(s.lastActivityAt)}
                </span>
              }
              checked={checked.has(s.rootPath)}
              onChange={(on) =>
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (on) next.add(s.rootPath);
                  else next.delete(s.rootPath);
                  return next;
                })
              }
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
