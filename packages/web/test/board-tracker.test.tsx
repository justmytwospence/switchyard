import { githubIssueFromUrl, type TaskTracker } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTrackerStatus, startTrackerWork } from "../src/features/board/api";
import { TrackerSection } from "../src/features/board/TaskDetail";
import { task } from "./fixtures";

const api = vi.hoisted(() => ({ post: vi.fn(async (_path: string, _body: unknown) => null) }));
vi.mock("../src/sync/api", async (original) => ({
  ...(await original<typeof import("../src/sync/api")>()),
  apiPost: (path: string, body: unknown) => api.post(path, body),
}));

const url = "https://github.com/acme/app/issues/4";
const tracker = (patch: Partial<TaskTracker> = {}): TaskTracker => ({
  trackerId: "trk_1",
  itemId: "I_4",
  repository: "acme/app",
  number: 4,
  assignees: ["me", "you"],
  branch: null,
  workspaceId: null,
  pullRequest: null,
  board: null,
  ...patch,
});

function render(t: TaskTracker) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TrackerSection task={task("t1", { githubIssue: githubIssueFromUrl(url), tracker: t })} />
    </MemoryRouter>,
  );
}

beforeEach(() => api.post.mockClear());

describe("tracker section", () => {
  it("shows the issue, branch, pull request and assignees, and offers Start work", () => {
    const html = render(tracker());
    expect(html).toContain("Tracker");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("acme/app #4");
    expect(html).toContain("None yet");
    expect(html).toContain("me, you");
    expect(html).toContain("Start work");
    expect(html).not.toContain("Board column");
  });

  it("hides Start work once there is a branch and shows the board column", () => {
    const html = render(
      tracker({
        branch: "4-fix",
        pullRequest: {
          number: 9,
          state: "OPEN",
          url: "https://github.com/acme/app/pull/9",
          headRefName: "4-fix",
        },
        board: {
          projectId: "P",
          projectItemId: "PI",
          fieldId: "F",
          status: "Todo",
          statusOptionId: "o1",
          options: [
            { id: "o1", name: "Todo" },
            { id: "o2", name: "Done" },
          ],
        },
      }),
    );
    expect(html).not.toContain("Start work");
    expect(html).toContain("4-fix");
    expect(html).toContain("#9 open");
    expect(html).toContain("Board column");
    expect(html).toContain("Done");
  });

  it("posts to the tracker endpoints", async () => {
    await startTrackerWork("t1");
    await setTrackerStatus("t1", "Done");
    expect(api.post.mock.calls).toEqual([
      ["/api/tasks/t1/tracker/start", {}],
      ["/api/tasks/t1/tracker/status", { status: "Done" }],
    ]);
  });
});
