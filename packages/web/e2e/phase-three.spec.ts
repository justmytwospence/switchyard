import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import type { E2EState } from "./state";
import { type Api, test as base, createSession, expect, poll, uid, viewportOf } from "./support";

const REPOSITORY = "switchyard-e2e/fixture";
const ISSUE_URL = `https://github.com/${REPOSITORY}/issues/17`;
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);

type Scenario = {
  repository: string;
  branch: string;
  head: string;
  title: string;
  merged?: boolean;
};
type GhCall = { cwd: string; args: string[] };
type Isolated = {
  state: E2EState;
  path: string;
  scenario: string;
  suffix: string;
  repository: string;
};

function lines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function scenario(fixture: Isolated, patch: Partial<Scenario> = {}) {
  // Atomic replacement: gh can be polling concurrently in another real process.
  const value: Scenario = existsSync(fixture.scenario)
    ? JSON.parse(readFileSync(fixture.scenario, "utf8"))
    : {
        repository: fixture.repository,
        branch: "main",
        head: SHA,
        title: `Isolated PR ${fixture.suffix}`,
      };
  writeFileSync(`${fixture.scenario}.tmp`, JSON.stringify({ ...value, ...patch }));
  renameSync(`${fixture.scenario}.tmp`, fixture.scenario);
}

function ghCalls(fixture: Isolated): GhCall[] {
  return lines<GhCall>(join(fixture.state.root, "fake-gh", "calls.jsonl")).filter(
    (call) => call.cwd === fixture.path,
  );
}

function fences(fixture: Isolated) {
  const db = new DatabaseSync(join(fixture.state.root, "coordinator", "coordinator.db"), {
    readOnly: true,
  });
  try {
    return db
      .prepare("SELECT * FROM github_merge_fences WHERE workspace_id = ?")
      .all(fixture.state.workspaceId);
  } finally {
    db.close();
  }
}

const test = base.extend<{ isolated: Isolated }>({
  isolated: async ({ api, state }, use, info) => {
    const suffix = uid(info);
    // No shared mutable gh scenario or project slots across tests/viewports. All
    // repositories live under global setup's root and are removed after host shutdown.
    const path = realpathSync(mkdtempSync(join(state.root, "phase-three-")));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: path });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Switchyard E2E");
    git("config", "user.email", "e2e@switchyard.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(path, "README.md"), "# isolated phase three fixture\n");
    git("add", "README.md");
    git("commit", "-qm", "initial fixture");
    const repository = `${REPOSITORY}-${suffix}`;
    git("remote", "add", "origin", `https://github.com/${repository}.git`);
    const fixture: Isolated = {
      repository,
      state,
      path,
      suffix,
      scenario: join(
        state.root,
        "fake-gh",
        `${createHash("sha256").update(path).digest("hex")}.json`,
      ),
    };
    scenario(fixture);
    const project = await api("POST", "/api/projects", {
      hostId: state.hostId,
      path,
      name: `Phase three ${suffix}`,
      maxConcurrentRuns: 1,
    });
    const workspaceId = await poll("isolated main workspace", async () => {
      const projectView = await api("GET", `/api/projects/${project.id}`);
      return projectView.workspaces?.[0]?.id as string | undefined;
    });
    fixture.state = { ...state, projectId: project.id, projectName: project.name, workspaceId };
    await use(fixture);
  },
});

async function session(api: Api, fixture: Isolated) {
  return createSession(api, fixture.state, `Phase three ${fixture.suffix}`, "Phase three ready.");
}

const card = (page: Page, id: string) => page.locator(`[data-task-id="${id}"]`);
const panel = (page: Page) => page.getByRole("region", { name: "Pull request", exact: true });

async function selectInspector(page: Page, mobile: boolean, tab: "PR" | "Details") {
  if (mobile) await page.getByRole("radio", { name: tab, exact: true }).click();
  else await page.getByTestId("inspector").getByRole("tab", { name: tab, exact: true }).click();
}

async function visibility(page: Page, value: "hidden" | "visible") {
  await page.evaluate((state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}

test.describe("phase three real-stack verification (only model and gh are fake)", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("parent/child creation, independent columns, progress and navigation on every board layout", async ({
    page,
    api,
    isolated,
    isMobile,
  }) => {
    const { state, suffix } = isolated;
    const parent = await api("POST", "/api/tasks", {
      projectId: state.projectId,
      title: `Parent ${suffix}`,
      priority: 0,
    });
    await page.goto("/board");
    if (isMobile)
      await page
        .getByTestId("status-tabs")
        .getByRole("tab", { name: /^Backlog/ })
        .click();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const form = page.getByTestId("new-task-form");
    await form.getByLabel("Project", { exact: true }).selectOption(state.projectId);
    await form.getByLabel("Title", { exact: true }).fill(`Child ${suffix}`);
    await form.getByLabel("Parent task", { exact: true }).selectOption(parent.id);
    const saved = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/tasks",
    );
    await form.getByRole("button", { name: "Save to Backlog" }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const child = await response.json();
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.dependencies).toEqual([]);
    const ready = await api("POST", "/api/tasks", {
      projectId: state.projectId,
      title: `Ready child ${suffix}`,
      parentTaskId: parent.id,
      // Dependency gates dispatch without making parenthood an implicit dependency.
      dependencies: [parent.id],
      state: "ready",
      priority: 0,
    });
    const canceled = await api("POST", "/api/tasks", {
      projectId: state.projectId,
      title: `Canceled child ${suffix}`,
      parentTaskId: parent.id,
    });
    await api("POST", `/api/tasks/${canceled.id}/cancel`);
    await expect(card(page, parent.id)).toContainText("0/3 done · 1 canceled");
    await expect(card(page, child.id)).toHaveAttribute("data-depth", "1");
    await expect(card(page, child.id)).toHaveAttribute(
      "aria-label",
      `${child.title}, depth 1, under ${parent.title}`,
    );
    await expect(card(page, canceled.id)).toHaveCount(0);
    if (isMobile)
      await page
        .getByTestId("status-tabs")
        .getByRole("tab", { name: /^Ready/ })
        .click();
    await expect(card(page, ready.id)).toHaveAttribute("data-depth", "0");
    await card(page, ready.id)
      .getByRole("link", { name: `Parent: ${parent.title}` })
      .click();
    const detail = page.getByTestId("task-detail");
    await expect(detail.getByRole("link", { name: child.title, exact: true })).toBeVisible();
    await detail.getByRole("link", { name: child.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${child.id}$`));
    await expect(detail.getByRole("link", { name: parent.title, exact: true })).toBeVisible();
    expect((await api("GET", `/api/tasks/${ready.id}`)).state).toBe("ready");
    expect((await api("GET", `/api/tasks/${child.id}`)).state).toBe("backlog");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("Policies creates a scoped rule, tests without effects, denies then approves a real bash tool", async ({
    page,
    api,
    isolated,
  }) => {
    const id = await session(api, isolated);
    const name = `Approval ${isolated.suffix}`;
    const deniedPath = join(isolated.path, "denied.txt");
    const allowedPath = join(isolated.path, "approved.txt");
    const command = (path: string) => `printf phase-three-approved > '${path}'`;
    await page.goto("/settings/policies");
    await expect(
      page.getByText("Pre-provider policies are unavailable", { exact: false }),
    ).toBeVisible();
    const editor = page.getByRole("heading", { name: "New rule", exact: true }).locator("..");
    await editor.getByLabel("Name", { exact: true }).fill(name);
    await editor.getByRole("combobox", { name: "Scope", exact: true }).selectOption("session");
    await editor.getByRole("combobox", { name: "Session", exact: true }).selectOption(id);
    await editor.getByLabel("CEL expression").fill(`{"verdict":"ASK","reason":"${name}"}`);
    const saved = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/policies",
    );
    await editor.getByRole("button", { name: "Save rule" }).click();
    const savedResponse = await saved;
    expect(savedResponse.status()).toBe(201);
    const rule = await savedResponse.json();
    expect(rule).toMatchObject({ name, scope: "session", scopeId: id, revision: 1 });
    try {
      const tester = page.getByRole("heading", { name: "Test rules" }).locator("..");
      await tester.getByRole("combobox", { name: "Session", exact: true }).selectOption(id);
      await tester
        .getByLabel("Sample arguments (JSON object)")
        .fill(JSON.stringify({ command: command(deniedPath) }));
      const before = await api("GET", `/api/interactions?sessionId=${id}`);
      await tester.getByRole("button", { name: "Test", exact: true }).click();
      await expect(tester.locator("strong").first()).toHaveText("Ask");
      await expect(tester).toContainText(rule.id);
      await expect(tester).toContainText("Pre-provider: Not enforced.");
      expect(await api("GET", `/api/interactions?sessionId=${id}`)).toEqual(before);
      expect(existsSync(deniedPath)).toBe(false);

      for (const [path, allow] of [
        [deniedPath, false],
        [allowedPath, true],
      ] as const) {
        await api("POST", `/api/sessions/${id}/prompt`, {
          text: `PHASE3-WRITE:${Buffer.from(path).toString("base64url")}`,
          mode: "prompt",
        });
        const interaction = await poll("durable policy ASK", async () => {
          const interactions = await api("GET", `/api/interactions?sessionId=${id}`);
          return interactions.find(
            (i: any) => i.state === "pending" && i.permission?.ruleId === rule.id,
          );
        });
        expect(interaction.permission).toMatchObject({ kind: "policy", ruleRevision: 1 });
        expect(existsSync(path)).toBe(false);
        await page.goto(`/code/${id}`);
        await expect(
          page.getByRole("heading", { name: interaction.title, exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: allow ? "Allow matching action" : "Deny", exact: true })
          .click();
        await poll("persisted approval answer", async () =>
          (await api("GET", `/api/interactions?sessionId=${id}`)).some(
            (i: any) => i.id === interaction.id && i.state === "resolved",
          ),
        );
        await poll(
          "tool settled",
          async () => (await api("GET", `/api/sessions/${id}`)).runtime === "idle",
        );
        if (allow) expect(readFileSync(path, "utf8")).toBe("phase-three-approved");
        else expect(existsSync(path)).toBe(false);
      }
      expect(existsSync(deniedPath)).toBe(false);
    } finally {
      await api("DELETE", `/api/policies/${rule.id}?expectedRevision=${rule.revision}`);
    }
  });

  test("PR drawer/tab reads real host gh, refreshes, polls only while selected and visible", async ({
    page,
    api,
    isolated,
    isMobile,
  }, info) => {
    const id = await session(api, isolated);
    const refreshPath = `/api/workspaces/${isolated.state.workspaceId}/pr/refresh`;
    let refreshes = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === refreshPath) refreshes++;
    });
    await page.clock.install();
    await page.goto(`/code/${id}?tab=pr`);
    const pr = panel(page);
    await expect(pr).toBeVisible();
    await expect(pr).toContainText(`Isolated PR ${isolated.suffix}`);
    await expect(pr).toContainText("Isolated CI");
    await expect(pr).toContainText("Please clarify the isolated fixture.");
    expect(ghCalls(isolated).some((call) => call.args[0] === "pr" && call.args[1] === "view")).toBe(
      true,
    );
    const refresh = pr.getByRole("button", { name: "Refresh", exact: true });
    await expect(refresh).toBeEnabled();
    scenario(isolated, { title: `Refreshed ${isolated.suffix}` });
    await refresh.click();
    await expect(pr).toContainText(`Refreshed ${isolated.suffix}`);
    await expect(refresh).toBeEnabled();
    const visible = refreshes;
    await page.clock.fastForward(60_000);
    await expect.poll(() => refreshes).toBe(visible + 1);
    await expect(refresh).toBeEnabled();
    await visibility(page, "hidden");
    const hidden = refreshes;
    await page.clock.fastForward(180_000);
    expect(refreshes).toBe(hidden);
    await visibility(page, "visible");
    await expect.poll(() => refreshes).toBe(hidden + 1);
    await expect(refresh).toBeEnabled();
    await selectInspector(page, isMobile, "Details");
    const unselected = refreshes;
    await page.clock.fastForward(180_000);
    expect(refreshes).toBe(unselected);
    await selectInspector(page, isMobile, "PR");
    await expect.poll(() => refreshes).toBe(unselected + 1);
    await expect(refresh).toBeEnabled();
    if (isMobile) await page.getByRole("radio", { name: "Chat", exact: true }).click();
    else if (viewportOf(info) === "compact")
      await page
        .getByRole("dialog", { name: "Inspector", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    else await page.getByRole("button", { name: "Hide inspector", exact: true }).click();
    const closed = refreshes;
    await page.clock.fastForward(180_000);
    expect(refreshes).toBe(closed);
    expect(ghCalls(isolated).some((call) => call.args.includes("PUT"))).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("host-discovered stale head retains unknown fence until explicit refresh and reconfirmation", async ({
    page,
    api,
    isolated,
  }) => {
    const id = await session(api, isolated);
    const mutations = () => ghCalls(isolated).filter((call) => call.args.includes("PUT"));
    const accepts: string[] = [];
    page.on("request", (req) => {
      if (new URL(req.url()).pathname.endsWith("/accept")) accepts.push(req.url());
    });
    await page.goto(`/code/${id}?tab=pr`);
    const pr = panel(page);
    const merge = pr.getByRole("button", { name: "Squash merge", exact: true });
    await expect(merge).toBeEnabled();
    await merge.click();
    const dialog = page.getByRole("dialog", { name: "Squash merge pull request?" });
    await expect(dialog).toContainText(SHA);
    expect(mutations()).toEqual([]);
    // Change only the host-side fake GitHub response, not the browser/API payload.
    // The real coordinator and host must catch the race before any external PUT.
    scenario(isolated, { head: NEXT_SHA });
    const rejected = page.waitForResponse((res) =>
      new URL(res.url()).pathname.endsWith("/pr/merge"),
    );
    await dialog.getByRole("button", { name: "Squash merge", exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "outcome_unknown",
      reason: "Merge outcome unknown. Refresh before retrying.",
    });
    await expect(dialog).toHaveCount(0);
    await expect(pr).toContainText("Merge outcome unknown. Refresh before retrying.");
    await expect(merge).toBeDisabled();
    expect(fences(isolated)).toMatchObject([{ state: "unknown", expected_head_oid: SHA }]);
    expect(mutations()).toEqual([]);
    expect(JSON.parse(readFileSync(isolated.scenario, "utf8")).merged).not.toBe(true);
    const blocked = await page.request.post(
      `/api/workspaces/${isolated.state.workspaceId}/pr/merge`,
      {
        headers: { origin: isolated.state.baseURL, "x-switchyard-request": "1" },
        data: { expectedHeadOid: SHA },
      },
    );
    expect(blocked.status()).toBe(409);
    expect(fences(isolated)).toMatchObject([{ state: "unknown", expected_head_oid: SHA }]);
    expect(mutations()).toEqual([]);
    await pr.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(pr).toContainText(NEXT_SHA);
    await expect(merge).toBeEnabled();
    expect(fences(isolated)).toEqual([]);
    expect(mutations()).toEqual([]);
    await merge.click();
    await expect(dialog).toContainText(NEXT_SHA);
    const merged = page.waitForResponse((res) => new URL(res.url()).pathname.endsWith("/pr/merge"));
    await dialog.getByRole("button", { name: "Squash merge", exact: true }).click();
    const result = await merged;
    expect(result.status()).toBe(200);
    expect(await result.json()).toMatchObject({ status: "merged", expectedHeadOid: NEXT_SHA });
    expect(mutations().map((call) => call.args)).toEqual([
      [
        "api",
        "--hostname",
        "github.com",
        "--method",
        "PUT",
        `repos/${isolated.repository}/pulls/7/merge`,
        "-f",
        `sha=${NEXT_SHA}`,
        "-f",
        "merge_method=squash",
      ],
    ]);
    expect(JSON.parse(readFileSync(isolated.scenario, "utf8")).merged).toBe(true);
    expect(accepts).toEqual([]);
    await expect(merge).toBeDisabled();
  });

  test("coordinator-known stale head rejects before fencing or sending a host merge", async ({
    page,
    api,
    isolated,
  }) => {
    const id = await session(api, isolated);
    await page.goto(`/code/${id}?tab=pr`);
    const pr = panel(page);
    await expect(pr.getByRole("button", { name: "Squash merge", exact: true })).toBeEnabled();
    scenario(isolated, { head: NEXT_SHA });
    await pr.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(pr).toContainText(NEXT_SHA);
    expect(fences(isolated)).toEqual([]);
    const calls = ghCalls(isolated);
    const response = await page.request.post(
      `/api/workspaces/${isolated.state.workspaceId}/pr/merge`,
      {
        headers: { origin: isolated.state.baseURL, "x-switchyard-request": "1" },
        data: { expectedHeadOid: SHA },
      },
    );
    expect(response.status()).toBe(409);
    expect(fences(isolated)).toEqual([]);
    expect(ghCalls(isolated)).toEqual(calls);
  });

  test("issue creation persists server metadata and first real Pi prompt reads only the saved issue", async ({
    page,
    api,
    isolated,
  }) => {
    const { state } = isolated;
    const launchPrompt = `${ISSUE_URL}\n\nRead it with \`gh issue view ${ISSUE_URL}\`.`;
    await page.goto("/board");
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const form = page.getByTestId("new-task-form");
    await form.getByLabel("Project", { exact: true }).selectOption(state.projectId);
    await form.getByLabel("Objective", { exact: true }).fill("Hidden instructions must not launch");
    await form.getByLabel("GitHub issue URL", { exact: true }).fill(ISSUE_URL);
    await expect(form.getByLabel("Objective", { exact: true })).toHaveCount(0);
    const saved = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/tasks",
    );
    await form.getByRole("button", { name: "Save to Backlog" }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const task = await response.json();
    expect(task).toMatchObject({
      title: `${REPOSITORY} #17`,
      objective: ISSUE_URL,
      acceptanceCriteria: [],
      githubIssue: { repository: REPOSITORY, number: 17, url: ISSUE_URL, launchPrompt },
    });
    expect(ghCalls(isolated).some((call) => call.args[0] === "issue")).toBe(false);
    await page.goto(`/tasks/${task.id}`);
    const detail = page.getByTestId("task-detail");
    await expect(
      detail.getByRole("link", { name: `${REPOSITORY} #17`, exact: true }),
    ).toHaveAttribute("href", ISSUE_URL);
    // Use this fixture's main workspace so the real Pi process has the same isolated
    // fake-gh scenario. This is a normal supported task workspace choice, not a mock.
    await api("PATCH", `/api/tasks/${task.id}`, {
      policy: { ...task.policy, workspace: { mode: "existing", workspaceId: state.workspaceId } },
    });
    const requestsBefore = lines<{ lastRole: string; lastText: string }>(
      join(state.root, "mock-requests.jsonl"),
    ).length;
    await page.getByRole("button", { name: "Make ready", exact: true }).click();
    const completed = await poll(
      "issue task review after real Pi read",
      async () => {
        const value = await api("GET", `/api/tasks/${task.id}`);
        return value.state === "review" && value.sessionId ? value : null;
      },
      60_000,
    );
    const requests = lines<{ lastRole: string; lastText: string }>(
      join(state.root, "mock-requests.jsonl"),
    ).slice(requestsBefore);
    expect(requests.some((req) => req.lastRole === "user" && req.lastText === launchPrompt)).toBe(
      true,
    );
    const issuedSession = await api("GET", `/api/sessions/${completed.sessionId}`);
    expect(issuedSession.workspaceId).toBe(state.workspaceId);
    expect(
      ghCalls(isolated)
        .filter((call) => call.args[0] === "issue")
        .map((call) => call.args),
    ).toEqual([["issue", "view", ISSUE_URL]]);
    expect((await api("GET", `/api/tasks/${task.id}`)).githubIssue.launchPrompt).toBe(launchPrompt);
    expect(
      ghCalls(isolated).some((call) => call.args.includes("PUT") || call.args.includes("create")),
    ).toBe(false);
  });
});
