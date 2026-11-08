import type { Task } from "@switchyard/protocol";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FILTERS } from "../src/features/board/logic";
import { MoveProvider } from "../src/features/board/MoveProvider";
import { NewTaskForm } from "../src/features/board/NewTaskForm";
import { type DragBindings, TaskCard } from "../src/features/board/TaskCard";
import { ParentPicker, TaskDetailBody } from "../src/features/board/TaskDetail";
import { type BoardState, useBoard } from "../src/features/board/useBoard";
import type { PrefsStore } from "../src/prefs";
import type { SyncStore } from "../src/sync/store";
import { session, task } from "./fixtures";

const mock = vi.hoisted(() => ({
  state: {} as SyncStore,
  prefs: {} as PrefsStore,
}));

vi.mock("../src/sync/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/sync/store")>()),
  useSyncStore: (selector: (state: SyncStore) => unknown) => selector(mock.state),
  useProjects: () => Object.values(mock.state.projects),
  useHosts: () => Object.values(mock.state.hosts),
}));
vi.mock("../src/prefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/prefs")>()),
  usePrefs: (selector: (state: PrefsStore) => unknown) => selector(mock.prefs),
}));

function render(children: ReactNode) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MoveProvider>{children}</MoveProvider>
    </MemoryRouter>,
  );
}

function BoardProbe({ capture }: { capture: (board: BoardState) => void }) {
  capture(useBoard());
  return null;
}

beforeEach(() => {
  mock.state = {
    tasks: {},
    runs: {},
    hosts: {},
    projects: {},
    profiles: {},
    workspaces: {},
    sessions: {},
    interactions: {},
    attention: {},
    dispatchPaused: false,
  } as SyncStore;
  mock.prefs = { filters: { board: DEFAULT_FILTERS }, selectedProjectId: null } as PrefsStore;
});

describe("hierarchy board rendering", () => {
  it("caps indentation while labeling full ancestry on the card and keyboard drag handle", () => {
    const ancestors = Array.from({ length: 5 }, (_, i) => task(`p${i}`));
    const leaf = task("leaf", { parentTaskId: "p4" });
    mock.state.tasks = Object.fromEntries([...ancestors, leaf].map((t) => [t.id, t]));
    const drag: DragBindings = {
      setNodeRef: null,
      setHandleRef: null,
      cardProps: {},
      handleProps: {},
      dragging: false,
    };
    const html = render(
      <TaskCard
        task={leaf}
        showProject={false}
        onOpen={() => {}}
        depth={5}
        ancestors={ancestors}
        progress={{ done: 2, total: 3, canceled: 1 }}
        drag={drag}
      />,
    );
    const ancestry = "depth 5, under Task p0 / Task p1 / Task p2 / Task p3 / Task p4";
    expect(html).toContain(`aria-label="Task leaf, ${ancestry}"`);
    expect(html).toContain(`aria-label="Drag Task leaf, ${ancestry}"`);
    expect(html).toContain("margin-inline-start:36px");
    expect(html).toContain('data-depth="5"');
    expect(html).toContain('href="/tasks/p4"');
    expect(html).toContain("Parent: Task p4");
    expect(html).toContain("2/3 done · 1 canceled");
    expect(html).toContain("Move to… and other actions for Task leaf");
  });

  it("keeps old root tasks unchanged and omits empty child progress", () => {
    const html = render(
      <TaskCard
        task={task("old")}
        showProject={false}
        onOpen={() => {}}
        progress={{ done: 0, total: 0, canceled: 0 }}
      />,
    );
    expect(html).toContain('aria-label="Task old"');
    expect(html).not.toContain("Parent:");
    expect(html).not.toContain("0/0 done");
  });

  it("retains an explicit link for an unavailable parent", () => {
    const html = render(
      <TaskCard
        task={task("orphan", { parentTaskId: "missing" })}
        showProject={false}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain('href="/tasks/missing"');
    expect(html).toContain("Parent: Unavailable task");
  });

  it("shows parent, all direct children and immutable agent attribution in details", () => {
    const parent = task("parent");
    const current = task("current", {
      parentTaskId: parent.id,
      agentOrigin: { sessionId: "creator", toolCallId: "call-123" },
    });
    const children = [
      task("done-child", { parentTaskId: current.id, state: "done", hiddenFromBoard: true }),
      task("canceled-child", { parentTaskId: current.id, state: "canceled" }),
    ];
    const grandchild = task("grandchild", { parentTaskId: children[0]!.id });
    const foreign = task("foreign", { parentTaskId: current.id, projectId: "other" });
    mock.state.tasks = Object.fromEntries(
      [parent, current, ...children, grandchild, foreign].map((t) => [t.id, t]),
    );
    mock.state.sessions = { creator: session("creator", { title: "Creator session" }) };
    const html = render(<TaskDetailBody task={current} />);
    expect(html).toContain('href="/tasks/parent"');
    for (const child of children) expect(html).toContain(`href="/tasks/${child.id}"`);
    expect(html).not.toContain('href="/tasks/grandchild"');
    expect(html).not.toContain('href="/tasks/foreign"');
    expect(html).toContain("Agent in");
    expect(html).toContain("Creator session");
    expect(html).toContain("call-123");
    expect(html).toContain('href="/code/creator"');
    expect(html).toContain("Parent relationships do not add dependencies");
  });

  it("provides a labeled None option and preserves unavailable selections explicitly", () => {
    const html = render(
      <ParentPicker candidates={[task("candidate")]} value="missing" onChange={() => {}} />,
    );
    expect(html).toContain("Parent task");
    expect(html).toContain('<option value="">None</option>');
    expect(html).toContain('value="candidate"');
    expect(html).toContain('value="missing" disabled="" selected=""');
    expect(html).toContain("dependencies are selected separately");
  });

  it("defaults human creation to None, with only same-project parents", () => {
    mock.state.tasks = {
      same: task("same"),
      foreign: task("foreign", { projectId: "other" }),
    };
    const html = render(
      <NewTaskForm defaultProjectId="prj_1" onCreated={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain('<option value="" selected="">None</option>');
    expect(html).toContain('value="same"');
    expect(html).not.toContain('value="foreign"');
  });

  it("derives trees and progress from all project tasks, never the search-filtered subset", () => {
    const parent = task("parent", { title: "Find me" });
    const child = task("child", { parentTaskId: parent.id, state: "done", hiddenFromBoard: true });
    const canceled = task("canceled", { parentTaskId: parent.id, state: "canceled" });
    const foreign = task("foreign", { projectId: "other", parentTaskId: parent.id });
    mock.state.tasks = { parent, child, canceled, foreign };
    // Only the project ID is needed for useBoard to recognize the selection.
    mock.state.projects = { prj_1: { id: "prj_1" } } as SyncStore["projects"];
    mock.prefs.selectedProjectId = "prj_1";
    mock.prefs.filters.board = { ...DEFAULT_FILTERS, search: "Find me" };
    let board: BoardState | undefined;
    render(
      <BoardProbe
        capture={(value) => {
          board = value;
        }}
      />,
    );
    expect(board!.columns.backlog.map((t: Task) => t.id)).toEqual([parent.id]);
    expect(board!.trees.backlog.map((n) => n.task.id)).toEqual([parent.id]);
    expect(board!.childProgress.get(parent.id)).toEqual({ done: 1, total: 2, canceled: 1 });
    expect(board!.visibleCount).toBe(1);
  });
});
