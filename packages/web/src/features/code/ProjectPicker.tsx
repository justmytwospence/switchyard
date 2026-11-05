import type { Project } from "@switchyard/protocol";
import { Check, ChevronDown } from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { Popover } from "../../components/ui/Popover";
import { TextInput } from "../../components/ui/TextArea";
import { cn } from "../../lib/cn";
import { matchesProject, repoLabel } from "../../lib/repo";

/** More projects than this: a searchable picker instead of a native select. */
export const PROJECT_SEARCH_THRESHOLD = 8;

export const CHIP_SELECT =
  "tap h-9 min-w-0 max-w-full rounded-full border border-border bg-surface pr-7 pl-3 text-base text-text md:h-8 md:text-sm focus:border-accent focus:outline-none disabled:opacity-55";
const CHIP_BUTTON =
  "tap inline-flex h-9 min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-surface px-3 text-base text-text md:h-8 md:text-sm hover:bg-surface-2";

export function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const shown = useMemo(() => projects.filter((p) => matchesProject(p, query)), [projects, query]);
  const current = projects.find((p) => p.id === value);

  if (projects.length <= PROJECT_SEARCH_THRESHOLD) {
    return (
      <>
        <label htmlFor={id} className="sr-only">
          Project
        </label>
        <select
          id={id}
          className={CHIP_SELECT}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </>
    );
  }
  const choose = (pid: string) => {
    onChange(pid);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setQuery("");
          setActive(0);
        }
      }}
      label="Choose a project"
      initialFocus={inputRef}
      fitViewport
      className="p-2"
      trigger={(p) => (
        <button
          type="button"
          {...p}
          aria-label={`Project: ${current?.name ?? "none"}`}
          className={CHIP_BUTTON}
        >
          <span className="truncate">{current?.name ?? "Choose a project"}</span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" />
        </button>
      )}
    >
      <TextInput
        ref={inputRef}
        role="combobox"
        aria-expanded
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={shown[active] ? `${id}-opt-${shown[active].id}` : undefined}
        aria-label="Search projects"
        placeholder="Search projects"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(shown.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter") {
            // Also stops implicit form submission (the panel renders inside the New session form).
            e.preventDefault();
            e.stopPropagation();
            const p = shown[active];
            if (p) choose(p.id);
          }
        }}
      />
      <ul
        id={`${id}-list`}
        // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: combobox listbox pattern
        role="listbox"
        aria-label="Projects"
        className="mt-2 max-h-64 overflow-y-auto"
      >
        {shown.length === 0 && <li className="px-2 py-2 text-sm text-muted">No projects match.</li>}
        {shown.map((p, i) => (
          // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection goes through the combobox input
          // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the combobox input (aria-activedescendant)
          <li
            key={p.id}
            id={`${id}-opt-${p.id}`}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: combobox option pattern
            role="option"
            aria-selected={p.id === value}
            onPointerDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(i)}
            onClick={() => choose(p.id)}
            className={cn(
              "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              i === active && "bg-surface-2",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate">{p.name}</span>
              <span className="block truncate text-xs text-muted">{repoLabel(p.repoIdentity)}</span>
            </span>
            {p.id === value && <Check aria-hidden className="size-4 shrink-0 text-accent" />}
          </li>
        ))}
      </ul>
    </Popover>
  );
}
