import { createTask, expect, test, uid } from "./support";

const issueUrl = "https://github.com/Owner/Repo/issues/17";
const launchPrompt = `${issueUrl}\n\nRead it with \`gh issue view ${issueUrl}\`.`;
const draftKey = "sy:new-task-draft";

test.describe("issue task creation", () => {
  test.beforeEach(async ({ signIn, page }) => {
    await signIn();
    await page.goto("/board");
  });

  test("switches modes without losing ordinary instructions, limits or review choices, including draft restoration", async ({
    page,
    state,
  }) => {
    await page.getByRole("button", { name: "New task", exact: true }).click();
    let form = page.getByTestId("new-task-form");
    await form.getByLabel("Project", { exact: true }).selectOption(state.projectId);
    await form.getByLabel("Title", { exact: true }).fill("Ordinary draft title");
    await form.getByLabel("Objective", { exact: true }).fill("Keep this ordinary objective");
    await form.getByRole("button", { name: "Advanced options" }).click();
    await form.getByLabel("Acceptance criteria (one per line)").fill("Keep this acceptance");
    await form.getByLabel("Continue automatically until done (off by default)").check();
    await form.getByLabel("Continuation objective", { exact: true }).fill("Keep this objective");
    await form.getByLabel("Max continuations", { exact: true }).fill("7");
    await form.getByLabel("Require human review before Done").uncheck();
    await form.getByLabel("GitHub issue URL", { exact: true }).fill(issueUrl);
    await expect(form.getByLabel("Objective", { exact: true })).toHaveCount(0);
    await expect(form.getByLabel("Acceptance criteria (one per line)")).toHaveCount(0);
    await expect(form.getByText("Continuation limits", { exact: true })).toHaveCount(0);
    await expect(form.getByLabel("Require human review before Done")).toHaveCount(0);
    await expect(form.getByLabel("Project", { exact: true })).toBeVisible();
    await expect(form.getByLabel("Parent task", { exact: true })).toBeVisible();
    await expect(form.getByLabel("Host", { exact: true })).toBeVisible();
    await expect(form.getByLabel("Pi profile", { exact: true })).toBeVisible();
    await expect(form).toContainText("first run sends only the issue link");
    await expect(form.getByLabel("Title", { exact: true })).toHaveValue("Ordinary draft title");

    await page.reload();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    form = page.getByTestId("new-task-form");
    await expect(form.getByLabel("GitHub issue URL", { exact: true })).toHaveValue(issueUrl);
    await expect(form.getByLabel("Objective", { exact: true })).toHaveCount(0);
    await form.getByLabel("GitHub issue URL", { exact: true }).fill("");
    await expect(form.getByLabel("Objective", { exact: true })).toHaveValue(
      "Keep this ordinary objective",
    );
    await expect(form.getByLabel("Acceptance criteria (one per line)")).toHaveValue(
      "Keep this acceptance",
    );
    await expect(
      form.getByLabel("Continue automatically until done (off by default)"),
    ).toBeChecked();
    await expect(form.getByLabel("Continuation objective", { exact: true })).toHaveValue(
      "Keep this objective",
    );
    await expect(form.getByLabel("Max continuations", { exact: true })).toHaveValue("7");
    await expect(form.getByLabel("Require human review before Done")).not.toBeChecked();
    await form.getByLabel("Title", { exact: true }).fill("");
    await form.getByRole("button", { name: "Save to Backlog" }).click();
    await expect(form).toContainText("Give the task a title.");
  });

  test("imports only the URL with server-derived title, suppresses hidden draft conflicts and retains project/parent/hints", async ({
    page,
    api,
    state,
  }, info) => {
    const parent = await createTask(api, state, { title: `Issue parent ${uid(info)}` });
    // An older ordinary draft can have invalid continuation fields and review disabled.
    // Import mode must not validate or send those hidden instructions, nor erase them.
    await page.evaluate(
      ({ key, projectId, parentId }) => {
        sessionStorage.setItem(
          key,
          JSON.stringify({
            projectId,
            parentTaskId: parentId,
            advanced: true,
            title: "",
            objective: "Must not enter first prompt",
            criteria: "Must not enter acceptance",
            continuation: true,
            contObjective: "",
            maxContinuations: "invalid",
            humanReview: false,
            branch: "issue-draft-branch",
            checksMode: "custom",
            checks: "printf checked",
          }),
        );
      },
      { key: draftKey, projectId: state.projectId, parentId: parent.id },
    );
    await page.reload();
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const form = page.getByTestId("new-task-form");
    await expect(form.getByLabel("GitHub issue URL", { exact: true })).toHaveValue("");
    await form.getByLabel("GitHub issue URL", { exact: true }).fill(`${issueUrl}?unsafe=1`);
    await form.getByRole("button", { name: "Save to Backlog" }).click();
    await expect(form).toContainText("with no query or fragment");
    await form
      .getByLabel("GitHub issue URL", { exact: true })
      .fill("  HTTPS://GITHUB.COM/Owner/Repo/issues/17  ");
    await expect(form.getByLabel("Title", { exact: true })).toHaveAttribute(
      "placeholder",
      "Owner/Repo #17",
    );
    const saved = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/tasks",
    );
    await form.getByRole("button", { name: "Save to Backlog" }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const input = response.request().postDataJSON();
    expect(input).toMatchObject({
      projectId: state.projectId,
      parentTaskId: parent.id,
      objective: "",
      acceptanceCriteria: [],
      policy: {
        continuation: { enabled: false },
        completion: { requireHumanReview: true, checks: ["printf checked"] },
        workspace: { mode: "new_worktree", branch: "issue-draft-branch" },
      },
    });
    expect(input.githubIssueUrl).toBe("  HTTPS://GITHUB.COM/Owner/Repo/issues/17  ");
    expect(input).not.toHaveProperty("githubIssue");
    expect(input).not.toHaveProperty("launchPrompt");
    const created = await response.json();
    expect(created).toMatchObject({
      title: "Owner/Repo #17",
      objective: issueUrl,
      acceptanceCriteria: [],
      githubIssue: { repository: "Owner/Repo", number: 17, url: issueUrl, launchPrompt },
    });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBeNull();
    await page.goto(`/tasks/${created.id}`);
    const detail = page.getByTestId("task-detail");
    await expect(detail.getByRole("link", { name: "Owner/Repo #17", exact: true })).toHaveAttribute(
      "href",
      issueUrl,
    );
    await expect(detail).toContainText(
      "Changes to the objective or acceptance text do not alter its saved initial prompt; later attempts use the current task details.",
    );
    await detail.getByRole("button", { name: "Edit", exact: true }).click();
    await detail.getByLabel("Objective", { exact: true }).fill("A later objective");
    await detail.getByLabel("Acceptance criteria (one per line)").fill("A later criterion");
    await detail.getByRole("button", { name: "Save", exact: true }).click();
    await expect(detail).toContainText("A later objective");
    const stored = await api("GET", `/api/tasks/${created.id}`);
    expect(stored.githubIssue.launchPrompt).toBe(launchPrompt);
    expect(stored.acceptanceCriteria).toEqual(["A later criterion"]);
  });

  test("keeps explicit titles and omits blank issue inputs on ordinary creation", async ({
    page,
    state,
  }, info) => {
    for (const issue of [true, false]) {
      await page.getByRole("button", { name: "New task", exact: true }).click();
      const form = page.getByTestId("new-task-form");
      const title = `Explicit ${issue ? "issue" : "ordinary"} ${uid(info)}`;
      await form.getByLabel("Project", { exact: true }).selectOption(state.projectId);
      await form.getByLabel("Title", { exact: true }).fill(title);
      await form.getByLabel("GitHub issue URL", { exact: true }).fill(issue ? issueUrl : "  ");
      if (!issue) await form.getByLabel("Objective", { exact: true }).fill(issueUrl);
      const saved = page.waitForResponse(
        (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/tasks",
      );
      await form.getByRole("button", { name: "Save to Backlog" }).click();
      const response = await saved;
      expect(response.status()).toBe(201);
      const created = await response.json();
      expect(created.title).toBe(title);
      if (issue) expect(created.githubIssue.launchPrompt).toBe(launchPrompt);
      else {
        expect(response.request().postDataJSON()).not.toHaveProperty("githubIssueUrl");
        expect(created).not.toHaveProperty("githubIssue");
        expect(created.objective).toBe(issueUrl);
      }
      await page.goto("/board");
    }
  });
});
