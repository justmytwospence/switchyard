import { DEFAULT_TASK_POLICY, githubIssueFromUrl } from "@switchyard/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MoveProvider } from "../src/features/board/MoveProvider";
import { buildPolicy, NewTaskForm } from "../src/features/board/NewTaskForm";
import { TaskDetailBody } from "../src/features/board/TaskDetail";
import type { SyncStore } from "../src/sync/store";
import { task } from "./fixtures";

const mock = vi.hoisted(() => ({ state: {} as SyncStore }));
vi.mock("../src/sync/store", async (original) => ({
  ...(await original<typeof import("../src/sync/store")>()),
  useSyncStore: (selector: (s: SyncStore) => unknown) => selector(mock.state),
  useProjects: () => Object.values(mock.state.projects),
  useHosts: () => Object.values(mock.state.hosts),
}));
const url = "https://github.com/Owner/Repo/issues/17";
let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
    removeItem: (key: string) => saved.delete(key),
  });
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
});
afterEach(() => vi.unstubAllGlobals());

function form(draft: Record<string, unknown>) {
  saved.set("sy:new-task-draft", JSON.stringify(draft));
  return renderToStaticMarkup(
    <NewTaskForm defaultProjectId="prj_1" onCreated={() => {}} onCancel={() => {}} />,
  );
}

describe("issue task form", () => {
  it("restores older ordinary drafts with a blank issue field and all instructions available", () => {
    const html = form({
      objective: "Ordinary objective",
      criteria: "Keep acceptance",
      advanced: true,
    });
    expect(html).toContain("GitHub issue URL");
    expect(html).toContain('placeholder="https://github.com/OWNER/REPO/issues/17" value=""');
    expect(html).toContain("Ordinary objective");
    expect(html).toContain("Keep acceptance");
    expect(html).toContain("Continuation limits");
  });

  it("restores issue mode with a deterministic title suggestion, hides only initial instructions and preserves hints", () => {
    const html = form({
      githubIssueUrl: url,
      title: "",
      objective: "Hidden ordinary objective",
      criteria: "Hidden ordinary acceptance",
      advanced: true,
      continuation: true,
      contObjective: "Hidden continuation objective",
      humanReview: false,
    });
    expect(html).toContain('placeholder="Owner/Repo #17"');
    expect(html).toContain("first run sends only the issue link");
    expect(html).toContain("leave blank to use the issue reference");
    expect(html).not.toContain("Hidden ordinary");
    expect(html).not.toContain("Hidden continuation");
    expect(html).not.toContain("Continuation limits");
    expect(html).not.toContain("Require human review before Done");
    for (const label of [
      "Project",
      "Parent task",
      "Host",
      "Pi profile",
      "Branch",
      "Priority",
      "Dependencies",
    ])
      expect(html).toContain(label);
    expect(html).toContain("Issue imports require human review before Done.");
  });

  it("ignores hidden continuation errors only in import mode and does not mutate ordinary choices", () => {
    const draft: Parameters<typeof buildPolicy>[0] = {
      title: "",
      githubIssueUrl: url,
      objective: "Ordinary",
      criteria: "Criterion",
      projectId: "prj_1",
      parentTaskId: "",
      advanced: true,
      priority: 2,
      dependencies: [],
      hostId: "host",
      profileId: "profile",
      branch: "issue-17",
      continuation: true,
      contObjective: "",
      maxContinuations: "bad",
      maxMinutes: "60",
      maxTokens: "",
      maxCost: "",
      checks: "pnpm test",
      checksMode: "custom",
      humanReview: false,
    };
    const before = structuredClone(draft);
    const issue = buildPolicy(draft);
    expect(issue.errors).toEqual({});
    expect(issue.policy).toEqual({
      hostId: "host",
      profileId: "profile",
      workspace: { mode: "new_worktree", branch: "issue-17", base: null },
      continuation: DEFAULT_TASK_POLICY.continuation,
      completion: { checks: ["pnpm test"], requireHumanReview: true },
    });
    expect(draft).toEqual(before);
    const ordinary = buildPolicy({ ...draft, githubIssueUrl: "   " });
    expect(ordinary.errors).toEqual({
      contObjective: "Continuation needs an objective.",
      maxContinuations: "Use 1 to 50.",
    });
    expect(ordinary.policy.completion!.requireHumanReview).toBe(false);
  });
});

it("shows the saved issue link and immutable first-prompt explanation while leaving normal editing available", () => {
  const current = task("issue", { githubIssue: githubIssueFromUrl(url) });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <MoveProvider>
        <TaskDetailBody task={current} />
      </MoveProvider>
    </MemoryRouter>,
  );
  expect(html).toContain(`href="${url}"`);
  expect(html).toContain("Owner/Repo #17");
  expect(html).toContain("The first run reads the linked issue.");
  expect(html).toContain(
    "do not alter its saved initial prompt; later attempts use the current task details.",
  );
  expect(html).toContain(">Edit</button>");
});
