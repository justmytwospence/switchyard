import { describe, expect, it, vi } from "vitest";
import {
  describeIssue,
  type Gh,
  issueSearch,
  setIssueStatus,
  syncIssues,
} from "../src/github-issues.js";

const REPO = "acme/app";

function issue(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `I_${n}`,
    number: n,
    title: `Issue ${n}`,
    url: `https://github.com/${REPO}/issues/${n}`,
    repository: { nameWithOwner: REPO },
    assignees: { nodes: [{ login: "me" }] },
    linkedBranches: { nodes: [] },
    closedByPullRequestsReferences: { nodes: [] },
    ...over,
  };
}

function page(nodes: unknown[], hasNextPage = false, endCursor = "c") {
  return {
    data: { viewer: { login: "me" }, search: { pageInfo: { hasNextPage, endCursor }, nodes } },
  };
}

const vars = (args: string[]) =>
  Object.fromEntries(
    args
      .map((a, i) => (args[i - 1] === "-f" || args[i - 1] === "-F" ? a : null))
      .filter((a): a is string => a !== null)
      .map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]),
  );

describe("describeIssue", () => {
  const req = { repository: REPO, number: 42 };
  it("uses variables, accepts empty body and truncates without splitting Unicode", async () => {
    const gh = vi.fn(async () => ({ data: { repository: { issue: { body: "" } } } }));
    expect(await describeIssue(gh, req)).toEqual({ body: "", truncated: false });
    const v = vars(gh.mock.calls[0]![0]);
    expect(v).toMatchObject({ owner: "acme", name: "app", number: "42" });
    expect(v.query).not.toContain("acme");
    const body = `${"x".repeat(32767)}😀tail`;
    expect(
      await describeIssue(async () => ({ data: { repository: { issue: { body } } } }), req),
    ).toEqual({ body: "x".repeat(32767), truncated: true });
  });
  it("rejects missing, malformed, and error replies", async () => {
    for (const raw of [
      { data: { repository: { issue: null } } },
      { data: {} },
      { errors: [{ message: "bad" }] },
    ])
      await expect(describeIssue(async () => raw, req)).rejects.toThrow();
    await expect(describeIssue(async () => ({}), { ...req, number: 0 })).rejects.toThrow();
  });
});

describe("issueSearch", () => {
  it("scopes to the owner or the listed repositories", () => {
    expect(issueSearch({ owner: "acme", repositories: null })).toBe(
      "user:acme is:issue is:open assignee:@me",
    );
    expect(issueSearch({ owner: "acme", repositories: ["acme/a", "acme/b"] })).toBe(
      "repo:acme/a repo:acme/b is:issue is:open assignee:@me",
    );
  });
});

describe("syncIssues", () => {
  const req = { owner: "acme", repositories: null, board: null };

  it("maps issues, preferring linked branches, then open closing PR heads in the same repo", async () => {
    const gh: Gh = vi.fn(async () =>
      page([
        issue(1, {
          linkedBranches: {
            nodes: [
              { ref: { name: "1-linked", repository: { nameWithOwner: REPO } } },
              { ref: { name: "elsewhere", repository: { nameWithOwner: "fork/app" } } },
            ],
          },
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 9,
                state: "MERGED",
                url: `https://github.com/${REPO}/pull/9`,
                headRefName: "old",
                headRepository: { nameWithOwner: REPO },
              },
              {
                number: 10,
                state: "OPEN",
                url: `https://github.com/${REPO}/pull/10`,
                headRefName: "feat/x",
                headRepository: { nameWithOwner: REPO },
              },
              {
                number: 11,
                state: "OPEN",
                url: `https://github.com/${REPO}/pull/11`,
                headRefName: "fork-branch",
                headRepository: { nameWithOwner: "fork/app" },
              },
            ],
          },
        }),
        { notAnIssue: true },
        issue(2, {
          closedByPullRequestsReferences: {
            nodes: [
              {
                number: 12,
                state: "MERGED",
                url: `https://github.com/${REPO}/pull/12`,
                headRefName: "done",
                headRepository: { nameWithOwner: REPO },
              },
            ],
          },
        }),
      ]),
    );
    const r = await syncIssues(gh, req);
    expect(r.login).toBe("me");
    expect(r.truncated).toBe(false);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({
      itemId: "I_1",
      repository: REPO,
      number: 1,
      branches: ["1-linked", "feat/x"],
      pullRequest: { number: 10, state: "OPEN", headRefName: "feat/x" },
      board: null,
      assignees: ["me"],
    });
    expect(r.items[1]).toMatchObject({
      branches: [],
      pullRequest: { number: 12, state: "MERGED" },
    });
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(args.slice(0, 4)).toEqual(["api", "--hostname", "github.com", "graphql"]);
    expect(vars(args).q).toBe("user:acme is:issue is:open assignee:@me");
    expect(vars(args).query).not.toContain("projectItems");
  });

  it("follows pages and stops after four", async () => {
    let n = 0;
    const gh: Gh = vi.fn(async () => page([issue(++n)], true, `c${n}`));
    const r = await syncIssues(gh, req);
    expect(gh).toHaveBeenCalledTimes(4);
    expect(r.items).toHaveLength(4);
    expect(r.truncated).toBe(true);
    const calls = (gh as ReturnType<typeof vi.fn>).mock.calls.map((c) => vars(c[0] as string[]));
    expect(calls[0]!.cursor).toBeUndefined();
    expect(calls[1]!.cursor).toBe("c1");
  });

  it("throws on GraphQL errors", async () => {
    const gh: Gh = async () => ({ errors: [{ message: "INSUFFICIENT_SCOPES" }] });
    await expect(syncIssues(gh, req)).rejects.toThrow("INSUFFICIENT_SCOPES");
  });

  it("reads the board column of the configured project", async () => {
    const projectItems = {
      nodes: [
        {
          id: "PVTI_other",
          project: { id: "P_other", number: 2, owner: { login: "acme" }, field: { id: "F2" } },
          fieldValueByName: { name: "Done", optionId: "o9" },
        },
        {
          id: "PVTI_1",
          project: {
            id: "P_1",
            number: 5,
            owner: { login: "ACME" },
            field: {
              id: "F1",
              options: [
                { id: "o1", name: "Todo" },
                { id: "o2", name: "In progress" },
              ],
            },
          },
          fieldValueByName: { name: "Todo", optionId: "o1" },
        },
      ],
    };
    const gh: Gh = vi.fn(async () =>
      page([
        issue(1, { projectItems }),
        issue(2, {
          projectItems: { nodes: [{ ...projectItems.nodes[1], fieldValueByName: null }] },
        }),
      ]),
    );
    const r = await syncIssues(gh, {
      ...req,
      board: { projectNumber: 5, statusField: "Status" },
    });
    expect(r.items[0]!.board).toEqual({
      projectId: "P_1",
      projectItemId: "PVTI_1",
      fieldId: "F1",
      status: "Todo",
      statusOptionId: "o1",
      options: [
        { id: "o1", name: "Todo" },
        { id: "o2", name: "In progress" },
      ],
      priority: null,
    });
    expect(r.items[1]!.board).toMatchObject({ status: null, statusOptionId: null });
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(vars(args).statusField).toBe("Status");
    expect(vars(args).query).toContain("projectItems");
  });
});

describe("syncIssues backlog columns", () => {
  it("skips backlog cards in assigned mode too", async () => {
    const node = (id: string, name: string | null) => ({
      id,
      project: {
        id: "P_1",
        number: 5,
        owner: { login: "acme" },
        field: { id: "F1", options: [{ id: "o1", name: "Todo" }] },
      },
      fieldValueByName: name ? { name, optionId: "o1" } : null,
    });
    const gh: Gh = async () =>
      page([
        issue(1, { projectItems: { nodes: [node("a", "Todo")] } }),
        issue(2, { projectItems: { nodes: [node("b", null)] } }),
        issue(3, {
          projectItems: { nodes: [node("c", "Todo")] },
          linkedBranches: {
            nodes: [{ ref: { name: "3-x", repository: { nameWithOwner: REPO } } }],
          },
        }),
      ]);
    const r = await syncIssues(gh, {
      owner: "acme",
      repositories: null,
      board: { projectNumber: 5, statusField: "Status" },
      backlog: ["todo"],
    });
    expect(r.items.map((i) => i.number)).toEqual([2, 3]);
  });
});

describe("syncIssues following a board", () => {
  const req = {
    owner: "acme",
    repositories: null,
    follow: "board" as const,
    backlog: ["Backlog"],
    board: { projectNumber: 5, statusField: "Status" },
  };
  const boardNode = (n: number, status: string, content: Record<string, unknown> = {}) => ({
    id: `PVTI_${n}`,
    fieldValueByName: { name: status, optionId: status === "Ready" ? "o2" : "o1" },
    content: issue(n, { state: "OPEN", assignees: { nodes: [] }, ...content }),
  });
  const boardPage = (nodes: unknown[], hasNextPage = false, project: unknown = undefined) => ({
    data: {
      viewer: { login: "me" },
      repositoryOwner: {
        projectV2:
          project === undefined
            ? {
                id: "P_1",
                field: {
                  id: "F1",
                  options: [
                    { id: "o1", name: "Backlog" },
                    { id: "o2", name: "Ready" },
                  ],
                },
                items: { pageInfo: { hasNextPage, endCursor: "c" }, nodes },
              }
            : project,
      },
    },
  });

  it("tracks unassigned issues outside the backlog, and backlog issues that have a branch", async () => {
    const gh: Gh = vi.fn(async () =>
      boardPage([
        boardNode(1, "Backlog"),
        boardNode(2, "Backlog", {
          linkedBranches: {
            nodes: [{ ref: { name: "2-x", repository: { nameWithOwner: REPO } } }],
          },
        }),
        boardNode(3, "Ready"),
        boardNode(4, "Ready", { state: "CLOSED" }),
        { id: "PVTI_draft", fieldValueByName: null, content: {} },
      ]),
    );
    const r = await syncIssues(gh, req);
    expect(r.items.map((i) => i.number)).toEqual([2, 3]);
    expect(r.items[1]!.assignees).toEqual([]);
    expect(r.items[1]!.board).toMatchObject({
      projectId: "P_1",
      projectItemId: "PVTI_3",
      fieldId: "F1",
      status: "Ready",
      statusOptionId: "o2",
    });
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(vars(args)).toMatchObject({
      owner: "acme",
      number: "5",
      statusField: "Status",
      q: "is:open is:issue",
    });
    expect(args[args.indexOf("number=5") - 1]).toBe("-F");
  });

  it("reads up to ten pages", async () => {
    let n = 0;
    const gh: Gh = vi.fn(async () => boardPage([boardNode(++n, "Ready")], true));
    const r = await syncIssues(gh, req);
    expect(gh).toHaveBeenCalledTimes(10);
    expect(r.truncated).toBe(true);
  });

  it("explains a missing board or status field", async () => {
    await expect(syncIssues(async () => boardPage([], false, null), req)).rejects.toThrow(
      "acme has no Projects board #5",
    );
    await expect(
      syncIssues(async () => boardPage([], false, { id: "P_1", field: {} }), req),
    ).rejects.toThrow("has no single-select field named Status");
  });
});

describe("syncIssues priority and sub-issues", () => {
  const priority = {
    name: "P1",
    optionId: "p1",
    field: {
      options: [
        { id: "p0", name: "P0" },
        { id: "p1", name: "P1" },
      ],
    },
  };
  const project = {
    id: "P_1",
    number: 5,
    owner: { login: "acme" },
    field: { id: "F1", options: [{ id: "o1", name: "Todo" }] },
  };
  const node = (value: unknown) => ({
    id: "PVTI_1",
    project,
    fieldValueByName: { name: "Todo", optionId: "o1" },
    priority: value,
  });
  const board = { projectNumber: 5, statusField: "Status", priorityField: "Priority" };

  it("reads priority from the item's field value in search mode", async () => {
    const gh: Gh = vi.fn(async () =>
      page([
        issue(1, { projectItems: { nodes: [node(priority)] } }),
        issue(2, { projectItems: { nodes: [node({})] } }),
        issue(3, { projectItems: { nodes: [node(null)] } }),
        issue(4, {
          projectItems: {
            nodes: [node({ name: "P9", optionId: "gone", field: priority.field })],
          },
        }),
      ]),
    );
    const r = await syncIssues(gh, { owner: "acme", repositories: null, board });
    expect(r.items.map((i) => i.board?.priority)).toEqual([
      { name: "P1", rank: 1 },
      null,
      null,
      { name: "P9", rank: 2 },
    ]);
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(vars(args).query).toContain("$priorityField");
    expect(vars(args).query).toContain("priority: fieldValueByName");
    expect(vars(args).priorityField).toBe("Priority");
  });

  it("asks for no priority without a priority field", async () => {
    const gh: Gh = vi.fn(async () => page([]));
    await syncIssues(gh, {
      owner: "acme",
      repositories: null,
      board: { projectNumber: 5, statusField: "Status" },
    });
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(vars(args).query).not.toContain("$priorityField");
    expect(vars(args).priorityField).toBeUndefined();
  });

  it("reads priority on a followed board too", async () => {
    const gh: Gh = vi.fn(async () => ({
      data: {
        viewer: { login: "me" },
        repositoryOwner: {
          projectV2: {
            id: "P_1",
            field: { id: "F1", options: [{ id: "o1", name: "Todo" }] },
            items: {
              pageInfo: { hasNextPage: false, endCursor: "c" },
              nodes: [
                {
                  id: "PVTI_1",
                  fieldValueByName: { name: "Todo", optionId: "o1" },
                  priority,
                  content: issue(1, { state: "OPEN" }),
                },
              ],
            },
          },
        },
      },
    }));
    const r = await syncIssues(gh, { owner: "acme", repositories: null, follow: "board", board });
    expect(r.items[0]!.board?.priority).toEqual({ name: "P1", rank: 1 });
    const args = (gh as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(vars(args).priorityField).toBe("Priority");
  });

  it("maps parent and sub-issues", async () => {
    const gh: Gh = async () =>
      page([
        issue(1, {
          parent: { number: 39, title: "Epic", url: `https://github.com/${REPO}/issues/39` },
          subIssuesSummary: { total: 3, completed: 1 },
        }),
        issue(2, { parent: null, subIssuesSummary: { total: 0, completed: 0 } }),
      ]);
    const r = await syncIssues(gh, { owner: "acme", repositories: null, board: null });
    expect(r.items[0]).toMatchObject({
      parent: { number: 39, title: "Epic", url: `https://github.com/${REPO}/issues/39` },
      subIssues: { total: 3, completed: 1 },
    });
    expect(r.items[1]).toMatchObject({ parent: null, subIssues: null });
  });
});

describe("setIssueStatus", () => {
  const req = {
    projectId: "P",
    projectItemId: "I",
    fieldId: "F",
    statusField: "Status",
    optionId: "o2",
    expectedOptionId: "o1",
    login: "me",
    allowShared: false,
  };
  const item = (assignees: string[], optionId: string | null) => ({
    data: {
      node: {
        content: { assignees: { nodes: assignees.map((login) => ({ login })) } },
        fieldValueByName: optionId ? { optionId } : null,
      },
    },
  });

  it.each([
    ["not_assigned", ["someone"], "o1", req],
    ["shared", ["me", "someone"], "o1", req],
    ["stale", ["me"], "o3", req],
  ] as const)("skips %s cards without the mutation", async (reason, assignees, optionId, r) => {
    const gh: Gh = vi.fn(async () => item([...assignees], optionId));
    expect(await setIssueStatus(gh, r)).toEqual({ status: "skipped", reason });
    expect(gh).toHaveBeenCalledTimes(1);
  });

  it("moves an unassigned card only when allowed", async () => {
    const gh = (assignees: string[]) =>
      vi.fn(async (args: string[]) =>
        vars(args).query!.startsWith("mutation") ? { data: {} } : item(assignees, "o1"),
      );
    expect(await setIssueStatus(gh([]), req)).toEqual({
      status: "skipped",
      reason: "not_assigned",
    });
    expect(await setIssueStatus(gh([]), { ...req, allowUnassigned: true })).toEqual({
      status: "moved",
    });
    expect(await setIssueStatus(gh(["someone"]), { ...req, allowUnassigned: true })).toEqual({
      status: "skipped",
      reason: "not_assigned",
    });
  });

  it("moves an assigned card that is where it was last seen", async () => {
    const gh: Gh = vi.fn(async (args: string[]) =>
      vars(args).query!.startsWith("mutation") ? { data: {} } : item(["Me", "other"], "o1"),
    );
    expect(await setIssueStatus(gh, { ...req, allowShared: true })).toEqual({ status: "moved" });
    const mutation = vars((gh as ReturnType<typeof vi.fn>).mock.calls[1]![0] as string[]);
    expect(mutation).toMatchObject({ project: "P", item: "I", field: "F", option: "o2" });
  });
});
