import { Search, SlidersHorizontal, X } from "lucide-react";
import { useId, useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Sheet } from "../../components/ui/Overlay";
import { LoadingState } from "../../components/ui/states";
import { Tabs } from "../../components/ui/Tabs";
import { useSwipeTabs } from "../../lib/useSwipeTabs";
import { useFilter } from "../../prefs";
import { ScopeSelect } from "../scopes/ScopeSelect";
import { BoardSearch } from "./BoardSearch";
import type { WorkBoard } from "./useWorkBoard";
import { BoardEmpty, ColumnsControl, EmptyWorktreesToggle } from "./WorkBoardDesktop";
import { WorkCard } from "./WorkCard";

/** Mobile Board: one column at a time (tabs or a sideways swipe); cards move from their actions menu. */
export function WorkBoardMobile({ board }: { board: WorkBoard }) {
  const [prefs, setPrefs] = useFilter<{ tab: string }>("workboard-mobile", { tab: "working" });
  const column = board.columns.find((c) => c.id === prefs.tab) ?? board.columns[0];
  const [viewOpen, setViewOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(() => board.prefs.query !== "");
  const searchId = useId();
  const searchShown = searchOpen || board.prefs.query !== "";
  const swipe = useSwipeTabs(
    board.columns.map((c) => c.id),
    column?.id ?? "",
    (tab) => setPrefs({ tab }),
  );
  const n =
    (board.scope ? 1 : 0) +
    (board.githubBoard && board.mode !== "stage" ? 1 : 0) +
    (board.prefs.empty ? 1 : 0);
  return (
    <div data-testid="workboard" className="flex min-h-full min-w-0 flex-col">
      <header className="sticky top-0 z-20 flex min-w-0 flex-col border-b border-border bg-bg safe-pt">
        <div className="flex h-14 min-w-0 items-center gap-1 px-3">
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">Board</h1>
          <IconButton
            label={searchShown ? "Hide search" : "Show search"}
            aria-expanded={searchShown}
            aria-controls={searchId}
            icon={<Search className="size-5" />}
            onClick={() => {
              if (searchShown) {
                board.setPrefs({ ...board.prefs, query: "" });
                setSearchOpen(false);
              } else setSearchOpen(true);
            }}
          />
          <Button
            size="sm"
            icon={<SlidersHorizontal className="size-4" />}
            aria-label={n ? `View options, ${n} set` : "View options"}
            onClick={() => setViewOpen(true)}
          >
            View
            {n > 0 && <Badge tone="accent">{n}</Badge>}
          </Button>
        </div>
        {searchShown && (
          <div id={searchId} className="px-3 pb-2">
            <BoardSearch board={board} />
          </div>
        )}
        {board.scope && (
          <div className="px-3 pb-2">
            <button
              type="button"
              aria-label={`Clear scope ${board.scope.name}`}
              onClick={board.clearScope}
              className="inline-flex h-8 items-center gap-1 rounded-full border border-border px-3 text-xs"
            >
              {board.scope.name}
              <X aria-hidden className="size-3.5" />
            </button>
          </div>
        )}
        <Tabs
          label="Board columns"
          idPrefix="work-tab"
          progress={swipe.progress}
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
      <section
        aria-label="Board cards"
        {...swipe.bind}
        className="flex min-w-0 flex-1 touch-pan-y flex-col overflow-x-clip px-3 py-3"
      >
        <div ref={swipe.innerRef} className="min-h-full flex-1">
          {!board.hydrated ? (
            <LoadingState label="Loading the board…" />
          ) : board.total === 0 ? (
            <BoardEmpty board={board} />
          ) : !column || column.cards.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-6 pt-16 text-center">
              <p className="text-sm font-medium">Nothing in {column?.label ?? "this column"}</p>
              <p className="text-xs text-muted">Swipe sideways for the other columns.</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {column.cards.map((card) => (
                <li key={card.key}>
                  <WorkCard card={card} board={board} column={column} phone />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
      <Sheet
        open={viewOpen}
        onClose={() => setViewOpen(false)}
        title="Board view"
        footer={
          <Button variant="primary" onClick={() => setViewOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <ScopeSelect allLabel="All work" labelVisible />
          {board.githubBoard && (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Columns</span>
              <ColumnsControl board={board} block />
            </div>
          )}
          <EmptyWorktreesToggle board={board} />
        </div>
      </Sheet>
    </div>
  );
}
