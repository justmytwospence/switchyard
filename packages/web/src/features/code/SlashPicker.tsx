import { useEffect, useRef } from "react";
import { Badge } from "../../components/ui/Badge";
import { cn } from "../../lib/cn";
import type { CommandEntry, CommandSource } from "./model";

const SOURCE_LABEL: Record<CommandSource, string> = {
  switchyard: "Switchyard",
  extension: "Extension",
  prompt: "Prompt",
  skill: "Skill",
  terminal: "Terminal only",
};

export interface SlashPickerProps {
  id: string;
  entries: CommandEntry[];
  active: number;
  onPick: (entry: CommandEntry) => void;
  onHover?: (index: number) => void;
  status?: string | null;
  className?: string;
}

/** Listbox of slash commands; the textarea keeps focus and drives `active`. */
export function SlashPicker({
  id,
  entries,
  active,
  onPick,
  onHover,
  status,
  className,
}: SlashPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current
      ?.querySelector<HTMLElement>(`[id="${id}-${active}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, id]);
  return (
    <div className={className}>
      <div
        ref={ref}
        role="listbox"
        id={id}
        aria-label="Commands"
        className="max-h-72 overflow-y-auto"
      >
        {entries.map((e, i) => (
          <div
            key={`${e.source}:${e.name}`}
            role="option"
            id={`${id}-${i}`}
            aria-selected={i === active}
            aria-disabled={e.source === "terminal" ? true : undefined}
            tabIndex={-1}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1.5 text-sm",
              i === active && "bg-surface-2",
              e.source === "terminal" && "opacity-60",
            )}
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(e)}
            onKeyDown={() => undefined}
            onMouseEnter={() => onHover?.(i)}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="font-mono">/{e.name}</span>
              {e.argumentHint && <span className="text-muted">{e.argumentHint}</span>}
              <Badge className="ml-auto">{SOURCE_LABEL[e.source]}</Badge>
            </div>
            {e.description && <div className="truncate text-xs text-muted">{e.description}</div>}
          </div>
        ))}
      </div>
      {status && <p className="px-2 py-1 text-xs text-muted">{status}</p>}
    </div>
  );
}
