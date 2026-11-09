import { createTask, expect, poll, test, uid } from "./support";

test.beforeEach(async ({ signIn }) => {
  await signIn();
});

test("navigating from an edited parent resets the child editor", async ({
  page,
  api,
  state,
  isMobile,
}, info) => {
  test.skip(isMobile, "Desktop drawer navigation");
  const suffix = uid(info);
  const parent = await createTask(api, state, {
    title: `Editor parent ${suffix}`,
    objective: "Parent objective",
  });
  const child = await createTask(api, state, {
    title: `Editor child ${suffix}`,
    objective: "Child objective",
    parentTaskId: parent.id,
  });
  await page.goto(`/tasks/${parent.id}`);
  const detail = page.getByTestId("task-detail");
  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  await detail.getByLabel("Objective", { exact: true }).fill("Unsaved parent objective");
  await detail.getByRole("link", { name: child.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${child.id}$`));
  await expect(detail.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(detail.getByLabel("Title", { exact: true })).toHaveValue(child.title);
  await expect(detail.getByLabel("Objective", { exact: true })).toHaveValue("Child objective");
  await detail.getByLabel("Objective", { exact: true }).fill("Updated child objective");
  await detail.getByRole("button", { name: "Save", exact: true }).click();
  await poll(
    "child updated",
    async () =>
      (await api("GET", `/api/tasks/${child.id}`)).objective === "Updated child objective",
  );
  expect((await api("GET", `/api/tasks/${parent.id}`)).objective).toBe("Parent objective");
});

test("mobile parent link restores board scroll and source focus", async ({
  page,
  api,
  state,
  isMobile,
}, info) => {
  test.skip(!isMobile, "Mobile board navigation");
  const suffix = uid(info);
  await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      createTask(api, state, { title: `Link filler ${i} ${suffix}`, priority: 3 }),
    ),
  );
  const parent = await createTask(api, state, { title: `Link parent ${suffix}`, priority: 3 });
  const child = await createTask(api, state, {
    title: `Link child ${suffix}`,
    parentTaskId: parent.id,
    priority: 3,
  });
  await page.goto("/board");
  // Wait for a private, fixed-size board so parallel task creation cannot move the source link.
  await page.getByRole("button", { name: "Show search" }).click();
  await page.getByPlaceholder("Search tasks").fill(suffix);
  await page
    .getByTestId("status-tabs")
    .getByRole("tab", { name: /^Backlog/ })
    .click();
  await expect(page.getByTestId("task-card")).toHaveCount(10);
  const card = page.locator(`[data-task-id="${child.id}"]`);
  const link = card.getByRole("link", { name: `Parent: ${parent.title}` });
  await link.scrollIntoViewIfNeeded();
  const main = page.locator("#main");
  const before = await main.evaluate((el) => Math.round(el.scrollTop));
  expect(before).toBeGreaterThan(0);
  // Observe whether React prevented modified clicks, then suppress browser navigation.
  for (const options of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    const prevented = await link.evaluate((el, options) => {
      let prevented = true;
      document.addEventListener(
        "click",
        (event) => {
          prevented = event.defaultPrevented;
          event.preventDefault();
        },
        { once: true },
      );
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...options }));
      return prevented;
    }, options);
    expect(prevented).toBe(false);
  }
  await expect(page).toHaveURL(/\/board$/);
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${parent.id}$`));
  await page.getByRole("button", { name: "Back to board" }).click();
  await expect(page).toHaveURL(/\/board$/);
  await expect.poll(() => main.evaluate((el) => Math.round(el.scrollTop))).toBe(before);
  await expect(card.locator("[data-card-open]")).toBeFocused();
});
