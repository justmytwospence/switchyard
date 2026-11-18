import { Badge } from "../../components/ui/Badge";
import { LoadingState } from "../../components/ui/states";
import { Tabs } from "../../components/ui/Tabs";
import { useFilter } from "../../prefs";
import { ViewSelect } from "../views/ViewSelect";
import { BoardSearch } from "./BoardSearch";
import type { WorkBoard } from "./useWorkBoard";
import { BoardEmpty, ColumnsControl } from "./WorkBoardDesktop";
import { WorkCard } from "./WorkCard";

/** Mobile Board: one column at a time as tabs; cards move with their Move to… menu. */
export function WorkBoardMobile({ board }: { board: WorkBoard }) {
  const [prefs, setPrefs] = useFilter<{ tab: string }>("workboard-mobile", { tab: "working" });
  const column = board.columns.find((c) => c.id === prefs.tab) ?? board.columns[0];
  return (
    <div data-testid="workboard" className="flex min-w-0 flex-col">
      <header className="sticky top-0 z-20 flex min-w-0 flex-col gap-2 border-b border-border bg-bg px-3 pb-2 safe-pt">
        <h1 className="flex h-12 items-center text-lg font-semibold">Board</h1>
        <ViewSelect allLabel="All work" labelVisible />
        <BoardSearch board={board} />
        <ColumnsControl board={board} block />
        <Tabs
          label="Board columns"
          idPrefix="work-tab"
          scrollable
          className="border-b-0"
          value={column?.id ?? ""}
          onChange={(tab) => setPrefs({ tab })}
          tabs={board.columns.map((c) => ({
            id: c.id,
            label: c.label,
            badge: <Badge label={`${c.cards.length} cards`}>{c.cards.length}</Badge>,
          }))}
        />
      </header>
      <section aria-label="Board cards" className="flex min-w-0 flex-col gap-2 px-3 py-3">
        {!board.hydrated ? (
          <LoadingState label="Loading the board…" />
        ) : board.total === 0 ? (
          <BoardEmpty board={board} />
        ) : !column || column.cards.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted">
            Nothing in {column?.label ?? "this column"}.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {column.cards.map((card) => (
              <li key={card.key}>
                <WorkCard card={card} board={board} column={column} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
