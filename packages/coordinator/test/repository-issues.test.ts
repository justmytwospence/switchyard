import { describe, expect, it, vi } from "vitest";
import type { CoordinatorContext } from "../src/context.js";
import { RepositoryIssuesService } from "../src/repository-issues.js";

const issue = {
  itemId: "node",
  repository: "acme/repo",
  number: 1,
  title: "Unassigned",
  url: "https://github.com/acme/repo/issues/1",
  assignees: [],
  branches: [],
  pullRequest: null,
  board: null,
};

function fixture() {
  const project = {
    id: "project",
    repoIdentity: "https://github.com/acme/repo",
    defaultHostId: "z",
  };
  const checkouts = [
    { id: "b", hostId: "b" },
    { id: "z", hostId: "z" },
    { id: "a", hostId: "a" },
  ];
  const request = vi.fn().mockResolvedValue({ items: [issue], nextCursor: null });
  const store = {
    projects: { require: vi.fn().mockReturnValue(project) },
    checkouts: { list: vi.fn().mockReturnValue(checkouts) },
    issues: { list: vi.fn().mockReturnValue([]) },
    workspaces: { list: vi.fn().mockReturnValue([]) },
    sessions: { list: vi.fn().mockReturnValue([]), get: vi.fn() },
    getIssueWork: vi.fn(),
    putIssueWork: vi.fn(),
  };
  const hostHub = {
    isConnected: vi.fn().mockReturnValue(true),
    supportsRepositoryIssues: vi.fn().mockReturnValue(true),
    request,
  };
  return {
    service: new RepositoryIssuesService({ store, hostHub } as unknown as CoordinatorContext),
    store,
    hostHub,
    project,
    request,
  };
}

describe("repository issues", () => {
  it("uses the default capable checkout and never persists a read", async () => {
    const f = fixture();
    const page = await f.service.page("project", "cursor");
    expect(f.request).toHaveBeenCalledWith(
      "z",
      { type: "tracker.repoIssuesPage", repository: "acme/repo", after: "cursor" },
      expect.anything(),
    );
    expect(page.items[0]).toMatchObject({
      ...issue,
      projectId: "project",
      branch: null,
      workspaceId: null,
      sessionId: null,
    });
    expect(f.store.putIssueWork).not.toHaveBeenCalled();
  });
  it("chooses a stable eligible checkout and does not retry permission failures", async () => {
    const f = fixture();
    f.hostHub.supportsRepositoryIssues.mockImplementation((id: string) => id !== "z");
    f.request.mockRejectedValue(new Error("forbidden"));
    await expect(f.service.page("project")).rejects.toThrow("forbidden");
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0]![0]).toBe("a");
  });
  it("rejects repository escape in a host response", async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      items: [{ ...issue, repository: "acme/other" }],
      nextCursor: null,
    });
    await expect(f.service.page("project")).rejects.toThrow("another repository");
  });
  it("rejects a project changed during the read", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.project.repoIdentity = "https://github.com/acme/other";
      return { items: [], nextCursor: null };
    });
    await expect(f.service.page("project")).rejects.toThrow("changed");
  });
});
