import { Search } from "lucide-react";
import { useId } from "react";
import { TextInput } from "../../components/ui/TextArea";
import { cn } from "../../lib/cn";
import type { WorkBoard } from "./useWorkBoard";

export function BoardSearch({ board, className }: { board: WorkBoard; className?: string }) {
  const id = useId();
  const label =
    board.prefs.layout !== "issues"
      ? "Search branches, issues"
      : board.inventory.kind === "repository"
        ? "Search repository issues"
        : "Search tracked issues";
  return (
    <div className={cn("relative min-w-0", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle"
      />
      <TextInput
        id={id}
        type="search"
        data-keyboard-search
        placeholder={label}
        className="pl-8"
        value={board.prefs.query}
        onChange={(e) => board.setPrefs({ ...board.prefs, query: e.target.value })}
      />
    </div>
  );
}
