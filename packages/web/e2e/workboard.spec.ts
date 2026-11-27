import { expect, isMobile, test, uid } from "./support";

test.describe("branch board", () => {
  test("a session's branch is a Working card that opens the session", async ({
    page,
    api,
    signIn,
    state,
  }, info) => {
    await signIn();
    const branch = `board-${uid(info)}`;
    const r = await api("POST", "/api/branches/open", {
      projectId: state.projectId,
      branch,
      title: `Card ${branch}`,
    });
    await page.goto("/board");
    await expect(page.getByTestId("workboard")).toBeVisible();
    if (isMobile(info)) await page.getByRole("tab", { name: /Working/ }).tap();
    const card = page.getByTestId("work-card").filter({ hasText: `Card ${branch}` });
    if (!isMobile(info)) {
      await expect(
        page
          .getByTestId("work-column-working")
          .getByTestId("work-card")
          .filter({
            hasText: `Card ${branch}`,
          }),
      ).toBeVisible();
    }
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: new RegExp(`^Card ${branch}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/code/${r.session.id}`));
  });

  test("the view selector filters the board", async ({ page, api, signIn, state }, info) => {
    await signIn();
    const id = uid(info);
    const branch = `view-${id}`;
    await api("POST", "/api/branches/open", {
      projectId: state.projectId,
      branch,
      title: `In view ${id}`,
    });
    const elsewhere = await api("POST", "/api/scopes", {
      name: `elsewhere-${id}`,
      mode: "pinned",
    });
    await page.goto("/board");
    if (isMobile(info)) await page.getByRole("tab", { name: /Working/ }).tap();
    const card = page.getByTestId("work-card").filter({ hasText: `In view ${id}` });
    await expect(card).toBeVisible();
    const openView = async () => {
      if (!isMobile(info)) return;
      await page.getByRole("button", { name: /^View options/ }).click();
    };
    const closeView = async () => {
      if (!isMobile(info)) return;
      await page.getByRole("button", { name: "Done" }).click();
    };
    await openView();
    await page.getByLabel("Scope", { exact: true }).selectOption(elsewhere.id);
    await closeView();
    await expect(card).toHaveCount(0);
    await openView();
    await page.getByLabel("Scope", { exact: true }).selectOption("");
    await closeView();
    await expect(card).toBeVisible();
    await api("DELETE", `/api/scopes/${elsewhere.id}`);
  });

  test("a worktree without a session offers Start session", async ({
    page,
    api,
    signIn,
    state,
  }, info) => {
    test.skip(isMobile(info), "desktop board only");
    await signIn();
    const project = await api("GET", `/api/projects/${state.projectId}`);
    const branch = `empty-${uid(info)}`;
    await api("POST", "/api/workspaces", { checkoutId: project.checkouts[0].id, branch });
    await page.goto("/board");
    const card = page.getByTestId("work-card").filter({ hasText: branch });
    // A worktree nobody works in stays off the Board until asked for.
    await expect(page.getByTestId("workboard")).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: /worktrees? without a session/ }).click();
    await expect(card).toBeVisible();
    await expect(card.getByText("No session")).toBeVisible();
    await card.getByRole("button", { name: "Start session" }).click();
    await expect(page).toHaveURL(/\/code\/ses_/);
  });
});
