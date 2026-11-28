import { useEffect, useId, useRef } from "react";
import { useNavigationType } from "react-router";
import { Button } from "../../components/ui/Button";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { Select } from "../../components/ui/Select";
import { InventoryEmpty, InventoryMore, InventoryStatus } from "../discovery/InventoryStatus";
import { IssueList } from "../discovery/IssueList";
import { IssuePreview } from "../discovery/IssuePreview";
import { discoveryContext } from "../discovery/model";
import { ScopeRepository } from "../discovery/ScopeRepository";
import { KNOWN_WORK_COVERAGE } from "../scopes/describe";
import type { WorkBoard } from "./useWorkBoard";

export function LayoutControl({ board, block }: { board: WorkBoard; block?: boolean }) {
  return (
    <SegmentedControl
      label="Layout"
      block={block}
      value={board.prefs.layout ?? "columns"}
      onChange={(layout) => board.setPrefs({ ...board.prefs, layout })}
      options={[
        { value: "columns", label: "Columns" },
        { value: "issues", label: "Issue list" },
      ]}
    />
  );
}

export function RepositoryControl({ board }: { board: WorkBoard }) {
  return (
    <ScopeRepository
      scope={board.scope}
      projects={Object.values(board.projects)}
      projectId={board.projectId}
      onProjectChange={board.setProjectId}
      scopeLabelVisible
    />
  );
}

export function IssueFilters({ board }: { board: WorkBoard }) {
  const sortId = useId();
  const repo = board.inventory.kind === "repository";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SegmentedControl
        label="Issues"
        value={board.subset}
        onChange={board.setSubset}
        options={[
          { value: "notStarted", label: "Not started" },
          { value: "all", label: repo ? "All open issues" : "All tracked issues" },
        ]}
      />
      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={sortId}>Sort</label>
        <Select
          id={sortId}
          value={repo ? "number" : board.sort}
          onChange={(e) => board.setSort(e.target.value as "number" | "priority")}
        >
          <option value="number">Repository and number</option>
          {!repo && <option value="priority">Source priority</option>}
        </Select>
      </div>
    </div>
  );
}

interface Anchor {
  key: string;
  id: string | null;
  index: number;
  top: number;
  outer: boolean;
}
let anchor: Anchor | null = null;
function anchorKey(board: WorkBoard) {
  return JSON.stringify([
    board.scope?.id ?? null,
    board.prefs.layout,
    board.inventory.key,
    board.mode,
    board.projectId,
    board.subset,
    board.sort,
    board.prefs.query,
  ]);
}
function scrollContainer(list: HTMLElement | null): HTMLElement | null {
  for (let node = list; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight)
      return node;
  }
  return list?.closest<HTMLElement>("main") ?? list;
}

interface ColumnAnchor {
  key: string;
  id: string;
  index: number;
  column: string | undefined;
  top: number;
  left: number;
  outer: boolean;
}
let columnAnchor: ColumnAnchor | null = null;

function columnCards(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-board-card-id]"));
}

/** Capture before navigating to a session; return never reopens the preview. */
export function saveBoardAnchor(board: WorkBoard, id: string) {
  if (board.prefs.layout !== "issues") {
    const root = document.querySelector<HTMLElement>("[data-board-column-root]");
    if (!root) return;
    const card = columnCards(root).find((element) => element.dataset.boardCardId === id);
    const lane = card?.closest<HTMLElement>("[data-board-lane]");
    const cards = columnCards(lane ?? root);
    const scroller = scrollContainer(card ?? root);
    columnAnchor = {
      key: anchorKey(board),
      id,
      index: card ? cards.indexOf(card) : -1,
      column: lane?.dataset.boardLane,
      top: scroller?.scrollTop ?? 0,
      left: root.scrollLeft,
      outer: scroller === root.closest("main"),
    };
    return;
  }
  const list = document.querySelector<HTMLElement>("[data-board-issue-scroll]");
  const scroller = scrollContainer(list);
  anchor = {
    key: anchorKey(board),
    id,
    index: board.inventory.items.findIndex((item) => item.id === id),
    top: scroller?.scrollTop ?? 0,
    outer: !!scroller && scroller !== list,
  };
}

export function useRestoreColumnAnchor(board: WorkBoard) {
  const navigation = useNavigationType();
  const key = anchorKey(board);
  const columns = board.prefs.layout !== "issues";
  useEffect(() => {
    if (!columns || navigation !== "POP" || !board.hydrated || columnAnchor?.key !== key) return;
    const root = document.querySelector<HTMLElement>("[data-board-column-root]");
    if (!root) return;
    const saved = columnAnchor;
    columnAnchor = null;
    const lane = Array.from(root.querySelectorAll<HTMLElement>("[data-board-lane]")).find(
      (element) => element.dataset.boardLane === saved.column,
    );
    const cards = columnCards(lane ?? root);
    const card =
      cards.find((element) => element.dataset.boardCardId === saved.id) ?? cards[saved.index];
    const scroller = saved.outer ? root.closest<HTMLElement>("main") : (lane ?? root);
    if (scroller) scroller.scrollTop = saved.top;
    root.scrollLeft = saved.left;
    (card?.querySelector<HTMLElement>("[data-board-card-focus]") ?? lane ?? root).focus({
      preventScroll: true,
    });
  }, [columns, navigation, board.hydrated, key]);
}

export function BoardColumnCoverage({ board }: { board: WorkBoard }) {
  const context = discoveryContext(board.scope, Object.values(board.projects));
  const project = board.projects[board.projectId ?? context.fixedProjectId ?? ""];
  return (
    <section
      aria-label="Column coverage"
      className="border-b border-border px-4 py-2 text-xs text-muted"
    >
      {board.inventory.coverage === "source" || board.inventory.coverage === "pins" ? (
        <InventoryStatus inventory={board.inventory} />
      ) : project ? (
        <p>Known work in {project.name} · switch to Issue list to browse issues.</p>
      ) : (
        <p>{KNOWN_WORK_COVERAGE}</p>
      )}
    </section>
  );
}

export function BoardIssueList({ board }: { board: WorkBoard }) {
  const { inventory } = board;
  const ref = useRef<HTMLDivElement>(null);
  const navigation = useNavigationType();
  const key = anchorKey(board);
  useEffect(() => {
    if (
      navigation !== "POP" ||
      !board.hydrated ||
      inventory.loading ||
      anchor?.key !== key ||
      !ref.current
    )
      return;
    const saved = anchor;
    anchor = null;
    const container = ref.current;
    const scroller = saved.outer ? container.closest<HTMLElement>("main") : container;
    if (scroller) scroller.scrollTop = saved.top;
    const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-issue-id]"));
    const row =
      rows.find((el) => el.dataset.issueId === saved.id) ??
      (saved.index >= 0 ? rows[saved.index] : undefined);
    (
      row?.querySelector<HTMLElement>("[data-issue-title]") ??
      container.querySelector<HTMLElement>("[data-issue-heading]")
    )?.focus({ preventScroll: true });
  }, [navigation, board.hydrated, key, inventory.loading]);
  const context = discoveryContext(board.scope, Object.values(board.projects));
  const label = inventory.kind === "repository" ? "Repository issues" : "Tracked issues";
  return (
    <div ref={ref} data-board-issue-scroll className="min-h-0 flex-1 overflow-y-auto p-4">
      <h2 data-issue-heading tabIndex={-1} className="mb-2 text-sm font-semibold">
        {label}
      </h2>
      <IssueFilters board={board} />
      <div className="my-3">
        <InventoryStatus inventory={inventory} />
      </div>
      {board.actionError && (
        <p role="alert" className="my-2 text-sm text-danger">
          {board.actionError}
        </p>
      )}
      {inventory.items.length ? (
        <IssueList
          label={label}
          items={inventory.items}
          selectedId={board.selectedId}
          onInspect={board.inspect}
          onAction={(id) => {
            saveBoardAnchor(board, id);
            void board.action(id);
          }}
          pending={board.pending}
          showRepo={!context.fixedProjectId && inventory.kind !== "repository"}
          actionLabel={board.actionLabel}
          actionDetail={board.actionDetail}
          actionProblem={board.actionProblem}
        />
      ) : (
        <div className="py-8">
          <InventoryEmpty
            inventory={inventory}
            filtered={
              !!board.prefs.query.trim() ||
              (board.subset !== "all" && inventory.allItems.length > 0)
            }
          />
        </div>
      )}
      <InventoryMore inventory={inventory} />
    </div>
  );
}

export function BoardIssueDetail({ board }: { board: WorkBoard }) {
  const item = board.selectedItem;
  if (!item) return <p className="text-sm text-muted">Select an issue to read it.</p>;
  const problem = board.actionProblem(item);
  return (
    <IssuePreview
      locator={item.locator}
      issue={item.issue}
      branchName={item.branchName}
      sessionId={item.sessionId}
    >
      {board.actionError && (
        <p role="alert" className="text-sm text-danger">
          {board.actionError}
        </p>
      )}
      {(item.sessionId || !item.merged) && (
        <div className="space-y-1">
          <Button
            type="button"
            variant="primary"
            disabled={board.pending || !!problem}
            onClick={() => {
              saveBoardAnchor(board, item.id);
              void board.action(item.id);
            }}
          >
            {board.actionLabel(item)}
          </Button>
          {!item.sessionId && (
            <p className="text-xs text-muted">{problem ?? board.actionDetail(item)}</p>
          )}
        </div>
      )}
    </IssuePreview>
  );
}
