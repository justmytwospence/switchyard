import type { Scope } from "@switchyard/protocol";
import { useId } from "react";
import { Select } from "../../components/ui/Select";
import { cn } from "../../lib/cn";
import { useSyncStore } from "../../sync/store";
import { describeScope, scopeOptionLabel } from "./describe";
import { useSelectedScope } from "./selection";

/** The scopes and the one-line description of a scope. */
export function useScopeDescriber(): {
  scopes: Record<string, Scope>;
  describe: (v: Scope, subject?: "sessions" | "tasks") => string;
} {
  const scopes = useSyncStore((s) => s.scopes);
  const projects = useSyncStore((s) => s.projects);
  const hosts = useSyncStore((s) => s.hosts);
  return {
    scopes,
    describe: (v, subject) => describeScope(v, { projects, hosts }, subject),
  };
}

/** Selects the scope shared by Sessions and Board; "" is everything (`allLabel`). */
export function ScopeSelect({
  allLabel,
  className,
  labelVisible,
  subject = "sessions",
}: {
  allLabel: string;
  className?: string;
  labelVisible?: boolean;
  /** What the page lists, for the description. */
  subject?: "sessions" | "tasks";
}) {
  const id = useId();
  const { scopes, describe } = useScopeDescriber();
  const [selectedId, setSelectedId] = useSelectedScope();
  const scope = (selectedId ? scopes[selectedId] : null) ?? null;
  return (
    <div
      className={cn(
        labelVisible ? "flex min-w-0 flex-col gap-1" : "flex min-w-0 items-center gap-2",
        className,
      )}
    >
      <label htmlFor={id} className={labelVisible ? "text-sm font-medium" : "sr-only"}>
        Scope
      </label>
      <Select
        id={id}
        className={labelVisible ? "w-full" : "max-w-56"}
        value={scope?.id ?? ""}
        title={scope ? describe(scope, subject) : undefined}
        onChange={(e) => setSelectedId(e.target.value || null)}
      >
        <option value="">{allLabel}</option>
        {Object.values(scopes).map((v) => (
          <option key={v.id} value={v.id}>
            {scopeOptionLabel(v)}
          </option>
        ))}
      </Select>
      {labelVisible && scope && <p className="text-xs text-muted">{describe(scope, subject)}</p>}
    </div>
  );
}
