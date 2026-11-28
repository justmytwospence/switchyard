// @vitest-environment happy-dom
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardIssueList, saveBoardAnchor } from "../src/features/workboard/BoardIssues";
import type { WorkBoard } from "../src/features/workboard/useWorkBoard";

function board(ids: string[]): WorkBoard {
  return {
    hydrated: true,
    scope: null,
    projects: {},
    scopes: {},
    projectId: null,
    prefs: { mode: "stage", query: "", layout: "issues" },
    subset: "notStarted",
    sort: "number",
    selectedId: null,
    pending: false,
    actionError: null,
    items: ids.map((id, i) => ({
      id,
      issue: {
        id,
        number: i + 1,
        title: id,
        repository: "acme/repo",
        assignees: [],
        branches: [],
        pullRequest: null,
      },
      sessionId: null,
      branchName: null,
    })),
    setPrefs: vi.fn(),
    setSubset: vi.fn(),
    setSort: vi.fn(),
    inspect: vi.fn(),
    action: vi.fn(),
    actionDetail: () => "",
  } as unknown as WorkBoard;
}

function show(value: WorkBoard) {
  return render(
    <MemoryRouter>
      <BoardIssueList board={value} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("Board return anchor", () => {
  it("restores scroll and focuses the next row when a started issue disappears", () => {
    const before = board(["one", "two", "three"]);
    const view = show(before);
    const scroll = document.querySelector<HTMLElement>("[data-board-issue-scroll]")!;
    scroll.scrollTop = 45;
    saveBoardAnchor(before, "two");
    view.unmount();
    show(board(["one", "three"]));
    expect(document.querySelector<HTMLElement>("[data-board-issue-scroll]")!.scrollTop).toBe(45);
    expect(document.activeElement).toBe(
      document.querySelector('[data-issue-id="three"] [data-issue-title]'),
    );
  });
  it("restores the outer main scroller used by the phone layout", () => {
    const before = board(["one", "two"]);
    const view = render(
      <MemoryRouter>
        <main style={{ overflowY: "auto" }}>
          <BoardIssueList board={before} />
        </main>
      </MemoryRouter>,
    );
    const main = document.querySelector("main")!;
    Object.defineProperty(main, "scrollHeight", { value: 1000 });
    Object.defineProperty(main, "clientHeight", { value: 200 });
    main.scrollTop = 123;
    saveBoardAnchor(before, "one");
    view.unmount();
    render(
      <MemoryRouter>
        <main style={{ overflowY: "auto" }}>
          <BoardIssueList board={board(["two"])} />
        </main>
      </MemoryRouter>,
    );
    expect(document.querySelector("main")!.scrollTop).toBe(123);
    expect(document.activeElement).toBe(
      document.querySelector('[data-issue-id="two"] [data-issue-title]'),
    );
  });
  it("focuses the heading when no rows remain", () => {
    const before = board(["one"]);
    const view = show(before);
    saveBoardAnchor(before, "one");
    view.unmount();
    show(board([]));
    expect(document.activeElement?.textContent).toBe("Tracked issues");
  });
});
