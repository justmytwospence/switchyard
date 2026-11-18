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
    await card.getByRole("button", { name: `Card ${branch}` }).click();
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
    const elsewhere = await api("POST", "/api/views", {
      name: `elsewhere-${id}`,
      mode: "pinned",
    });
    await page.goto("/board");
    if (isMobile(info)) await page.getByRole("tab", { name: /Working/ }).tap();
    const card = page.getByTestId("work-card").filter({ hasText: `In view ${id}` });
    await expect(card).toBeVisible();
    await page.getByLabel("View", { exact: true }).selectOption(elsewhere.id);
    await expect(card).toHaveCount(0);
    await page.getByLabel("View", { exact: true }).selectOption("");
    await expect(card).toBeVisible();
    await api("DELETE", `/api/views/${elsewhere.id}`);
  });
});
