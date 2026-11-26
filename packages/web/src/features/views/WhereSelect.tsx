import { useId, useMemo } from "react";
import { Select } from "../../components/ui/Select";
import { cn } from "../../lib/cn";
import { useSyncStore } from "../../sync/store";
import { parseWhere, useSelectedWhere, whereKey, whereLabel, whereOptions } from "./where";

/** Narrows Sessions to what runs in a terminal or on a host; combines with the selected view. */
export function WhereSelect({ className }: { className?: string }) {
  const id = useId();
  const sessions = useSyncStore((s) => s.sessions);
  const hosts = useSyncStore((s) => s.hosts);
  const [selected, setSelected] = useSelectedWhere();
  const options = useMemo(
    () => whereOptions(Object.values(sessions), hosts, selected),
    [sessions, hosts, selected],
  );
  if (!options.terminals.length && !options.hosts.length && !selected) return null;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <label htmlFor={id} className="sr-only">
        Where
      </label>
      <Select
        id={id}
        value={whereKey(selected)}
        onChange={(e) => setSelected(parseWhere(e.target.value))}
      >
        <option value="">Anywhere</option>
        {options.terminals.length > 0 && (
          <optgroup label="Terminals">
            {options.terminals.map((w) => (
              <option key={whereKey(w)} value={whereKey(w)}>
                {whereLabel(w, hosts)}
              </option>
            ))}
          </optgroup>
        )}
        {options.hosts.length > 0 && (
          <optgroup label="Hosts">
            {options.hosts.map((w) => (
              <option key={whereKey(w)} value={whereKey(w)}>
                {whereLabel(w, hosts)}
              </option>
            ))}
          </optgroup>
        )}
      </Select>
    </div>
  );
}
