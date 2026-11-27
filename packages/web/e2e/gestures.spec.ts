import type { Page } from "@playwright/test";
import {
  centerOf,
  createSession,
  createTask,
  expect,
  longPress,
  test,
  touchDrag,
  uid,
} from "./support";

test.skip(({ isMobile }) => !isMobile, "Phone gestures only");

async function findSessionForTouch(page: Page, title: string) {
  const nav = page.getByTestId("navigator");
  await nav.getByTestId("toggle-search").tap();
  await nav.getByRole("searchbox", { name: "Search sessions" }).fill(title);
  // Other specs share the seeded branch. Isolate the row before measuring touch coordinates.
  await expect(nav.getByTestId("session-row")).toHaveCount(1);
  const row = nav.getByRole("link", { name: new RegExp(title) });
  await row.scrollIntoViewIfNeeded();
  return row;
}

test.describe("phone gestures", () => {
  test("swipe a session row left to archive it, and Undo brings it back", async ({
    page,
    api,
    signIn,
    state,
  }, info) => {
    await signIn();
    const title = `Swipe ${uid(info)}`;
    const id = await createSession(api, state, title, "Ready");
    await page.goto("/code");
    const row = await findSessionForTouch(page, title);
    const at = await centerOf(row);
    await touchDrag(page, { x: at.x + 140, y: at.y }, { x: at.x - 150, y: at.y });
    await expect(row).toHaveCount(0);
    expect((await api("GET", `/api/sessions/${id}`)).archivedAt).not.toBeNull();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect.poll(async () => (await api("GET", `/api/sessions/${id}`)).archivedAt).toBeNull();
  });

  test("long-press a session row for its actions", async ({ page, api, signIn, state }, info) => {
    await signIn();
    const title = `Hold ${uid(info)}`;
    await createSession(api, state, title, "Ready");
    await page.goto("/code");
    const row = await findSessionForTouch(page, title);
    await longPress(page, row);
    const sheet = page.getByTestId("action-sheet");
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("menuitem", { name: "Rename" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\/code$/);
  });

  test("swiping the task list changes column", async ({ page, api, signIn, state }, info) => {
    await signIn();
    await createTask(api, state, { title: `Ready ${uid(info)}`, state: "ready" });
    await page.goto("/tasks");
    await page.getByRole("tab", { name: /Ready/ }).tap();
    const list = page.getByRole("region", { name: "Board tasks" });
    const box = await list.boundingBox();
    if (!box) throw new Error("no list");
    const y = box.y + Math.min(box.height / 2, 200);
    await touchDrag(page, { x: box.x + box.width - 30, y }, { x: box.x + 30, y });
    await expect(page.getByRole("tab", { name: /In progress/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("swipe left on a session's chat opens Changes, right goes back to the list", async ({
    page,
    api,
    signIn,
    state,
  }, info) => {
    await signIn();
    const title = `Panel ${uid(info)}`;
    await createSession(api, state, title, "Ready");
    await page.goto("/code");
    await (await findSessionForTouch(page, title)).tap();
    await expect(page.getByTestId("conversation")).toBeVisible();
    await touchDrag(page, { x: 320, y: 300 }, { x: 80, y: 300 });
    await expect(page.getByTestId("session-panel-tabs")).toBeVisible();
    await touchDrag(page, { x: 80, y: 300 }, { x: 330, y: 300 });
    await expect(page.getByTestId("conversation")).toBeVisible();
    await touchDrag(page, { x: 80, y: 300 }, { x: 330, y: 300 });
    await expect(page).toHaveURL(/\/code$/);
  });

  test("an empty Board column still swipes to the next", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/board");
    const first = page.getByRole("tab").first();
    await first.tap();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await touchDrag(page, { x: 330, y: 650 }, { x: 60, y: 650 });
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  });

  test("the board's tab underline follows the swipe", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/board");
    const first = page.getByRole("tab").first();
    await first.tap();
    const bar = page.locator('[role="tablist"] > span[aria-hidden]');
    await page.waitForTimeout(300);
    const before = (await bar.boundingBox())!.x;
    const cdp = await page.context().newCDPSession(page);
    const at = (x: number) => [{ x, y: 650, id: 0 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(330) });
    for (let x = 320; x >= 200; x -= 10) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(x) });
    }
    const during = (await bar.boundingBox())!.x;
    expect(during).toBeGreaterThan(before + 10);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
  });

  test("More > Edit moves a page into the bottom bar", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/more");
    const nav = page.getByRole("navigation", { name: "Primary" });
    await expect(nav.getByRole("link", { name: "Queue" })).toHaveCount(0);
    await page.getByRole("button", { name: "Edit" }).tap();
    const handle = page.getByRole("button", { name: "Move Queue" });
    await handle.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await page.getByRole("button", { name: "Done" }).tap();
    await expect(nav.getByRole("link", { name: "Queue" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Queue/ }).first()).toBeVisible();
    await page.goto("/settings/device");
    await page.getByRole("button", { name: "Reset to default" }).click();
    await page.goto("/more");
    await expect(nav.getByRole("link", { name: "Queue" })).toHaveCount(0);
  });

  test("a menu is a sheet that closes by dragging it down", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/code");
    await page.getByRole("button", { name: "View options" }).tap();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await page.waitForTimeout(450); // the sheet slides in
    const box = await dialog.boundingBox();
    if (!box) throw new Error("no sheet");
    const from = { x: box.x + box.width / 2, y: box.y + 10 };
    await touchDrag(page, from, { x: from.x, y: from.y + 300 });
    await expect(dialog).toHaveCount(0);
  });

  test.describe("installed iOS app", () => {
    test.use({
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    });

    test("swipe from the left edge goes back from a session", async ({
      page,
      api,
      signIn,
      state,
    }, info) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "standalone", { value: true });
      });
      await signIn();
      const title = `Edge ${uid(info)}`;
      await createSession(api, state, title, "Ready");
      await page.goto("/code");
      await (await findSessionForTouch(page, title)).tap();
      await expect(page).toHaveURL(/\/code\/ses_/);
      await expect(page.getByTestId("conversation")).toBeVisible();
      await touchDrag(page, { x: 4, y: 400 }, { x: 300, y: 405 });
      await expect(page).toHaveURL(/\/code$/);
    });
  });
});
