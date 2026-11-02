import type { Locator, Page } from "@playwright/test";
import { type Api, createTask, expect, poll, test, uid } from "./support";

test.skip(({ isMobile }) => isMobile, "Desktop and compact board only");

const STATES = ["backlog", "ready", "in_progress", "review", "done"] as const;

const column = (page: Page, state: string) => page.getByTestId(`column-${state}`);
const card = (page: Page, title: string) => page.getByRole("article", { name: title, exact: true });

async function scrollBoard(page: Page, to: "start" | "end") {
  await page.getByRole("region", { name: "Board columns" }).evaluate((el, to) => {
    el.scrollLeft = to === "start" ? 0 : el.scrollWidth;
  }, to);
}

/** Pointer drag with dnd-kit's 6 px activation distance. */
async function drag(page: Page, source: Locator, target: Locator) {
  const s = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  const sx = s.x + s.width / 2;
  const sy = s.y + Math.min(40, s.height / 2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 8, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + Math.min(120, t.height / 2), { steps: 15 });
  await page.mouse.move(t.x + t.width / 2 + 2, t.y + Math.min(122, t.height / 2), { steps: 2 });
  await page.mouse.up();
  // dnd-kit swallows clicks for 50 ms after a drop (so the dropped card does not open).
  await page.waitForTimeout(100);
}

const taskState = async (api: Api, id: string) => (await api("GET", `/api/tasks/${id}`)).state;

test.describe("desktop board", () => {
  test.beforeEach(async ({ signIn, page }) => {
    await signIn();
    await page.goto("/board");
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(column(page, "in_progress").getByRole("article").first()).toBeVisible();
  });

  test("five columns, 288-360 px wide", async ({ page }) => {
    for (const s of STATES) {
      const box = (await column(page, s).boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(288);
      expect(box.width).toBeLessThanOrEqual(360);
    }
    await expect(page.locator("[data-testid^='column-']")).toHaveCount(5);
    await expect(column(page, "backlog").getByRole("heading")).toContainText("Backlog");
    await expect(column(page, "in_progress").getByRole("heading")).toContainText("In progress");
    // Horizontal scrolling happens inside the board, never the page.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("dragging Backlog to Ready authorizes dispatch", async ({ page, api, state }, info) => {
    // Urgent sorts first, so the card is at the top of a long Backlog column.
    const t = await createTask(api, state, { title: `Drag me ${uid(info)}`, priority: 0 });
    await expect(column(page, "backlog").getByRole("article", { name: t.title })).toBeVisible();
    await card(page, t.title).scrollIntoViewIfNeeded();
    await drag(page, card(page, t.title), column(page, "ready"));
    await expect(column(page, "ready").getByRole("article", { name: t.title })).toBeVisible();
    expect(await taskState(api, t.id)).toBe("ready");
    // Authorized, and waiting for the project's single slot (the running task holds it).
    const e = await api("GET", `/api/tasks/${t.id}/eligibility`);
    expect(e.eligible).toBe(false);
    expect(e.wait).toBe("project_limit");
  });

  test("dragging a running card backward asks to pause or stop", async ({ page, api, state }) => {
    const running = card(page, "Long running migration");
    await expect(
      column(page, "in_progress").getByRole("article", { name: "Long running migration" }),
    ).toBeVisible();
    await drag(page, running, column(page, "ready"));
    const dialog = page.getByRole("dialog", { name: "This task is running" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Pause automation" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Stop execution" })).toBeVisible();
    await dialog.getByRole("button", { name: "Keep running" }).click();
    await expect(dialog).toHaveCount(0);
    // Nothing was killed or moved.
    expect(await taskState(api, state.tasks.running)).toBe("in_progress");
    const s = await api("GET", `/api/sessions/${state.runningSessionId}`);
    expect(s.runtime).toBe("running");
    await expect(
      column(page, "in_progress").getByRole("article", { name: "Long running migration" }),
    ).toBeVisible();
  });

  test("moving to Done requires confirmation", async ({ page, api, state }) => {
    await scrollBoard(page, "end");
    const review = card(page, "Review the greeting copy");
    await expect(review).toBeInViewport();
    await drag(page, review, column(page, "done"));
    const dialog = page.getByRole("dialog", { name: "Accept and mark Done?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("The greeting is friendly");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await taskState(api, state.tasks.review)).toBe("review");

    // Same through the menu.
    await page
      .getByRole("button", { name: "Move to… and other actions for Review the greeting copy" })
      .click();
    await page.getByRole("menuitem", { name: "Accept (Done)" }).click();
    await expect(dialog).toBeVisible();
    // Focus moves into the dialog (next frame), then Escape closes it.
    await expect(dialog.locator(":focus")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await taskState(api, state.tasks.review)).toBe("review");
  });

  test("menu and keyboard move equivalents", async ({ page, api, state }, info) => {
    const a = await createTask(api, state, { title: `Menu move ${uid(info)}` });
    const b = await createTask(api, state, { title: `Keyboard move ${uid(info)}` });
    await expect(card(page, a.title)).toBeVisible();
    await expect(card(page, b.title)).toBeVisible();

    // Menu: Move to… > Make ready, keyboard-operated.
    const menuButton = page.getByRole("button", {
      name: `Move to… and other actions for ${a.title}`,
    });
    await menuButton.focus();
    await page.keyboard.press("Enter");
    const item = page.getByRole("menuitem", { name: "Make ready" });
    await expect(item).toBeVisible();
    for (let i = 0; i < 6 && !(await item.evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press("ArrowDown");
    }
    await expect(item).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(column(page, "ready").getByRole("article", { name: a.title })).toBeVisible();
    await poll("menu move", async () => (await taskState(api, a.id)) === "ready");

    // Keyboard drag: Space picks up, ArrowRight moves a column, Space drops.
    await page.getByRole("button", { name: `Drag ${b.title}` }).focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    await page.keyboard.press("Space");
    await expect(column(page, "ready").getByRole("article", { name: b.title })).toBeVisible();
    await poll("keyboard move", async () => (await taskState(api, b.id)) === "ready");

    // Invalid transitions are not offered: Backlog cannot start directly.
    const c = await createTask(api, state, { title: `No skip ${uid(info)}` });
    await page.getByRole("button", { name: `Move to… and other actions for ${c.title}` }).click();
    await expect(page.getByRole("menuitem", { name: "Make ready" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /In progress/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("the task drawer is 520 px and keeps the board mounted", async ({ page, state }) => {
    await page.evaluate(() => {
      (window as unknown as { __board: Element | null }).__board =
        document.querySelector("[data-testid='board']");
    });
    const open = page.locator(`[data-card-open="${state.tasks.backlog}"]`);
    await open.click();
    await expect(page).toHaveURL(new RegExp(`/tasks/${state.tasks.backlog}$`));
    const drawer = page.getByRole("dialog", { name: "Plan the onboarding flow" });
    await expect(drawer).toBeVisible();
    expect(Math.round((await drawer.boundingBox())!.width)).toBe(520);
    await expect(drawer.getByTestId("task-drawer")).toContainText("Sketch the steps.");
    const sameBoard = () =>
      page.evaluate(() => {
        const prev = (window as unknown as { __board: Element | null }).__board;
        return !!prev?.isConnected && prev === document.querySelector("[data-testid='board']");
      });
    expect(await sameBoard()).toBe(true);

    // Close returns to /board with the same board and focus on the card.
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(page).toHaveURL(/\/board$/);
    await expect(open).toBeFocused();
    expect(await sameBoard()).toBe(true);

    // Browser Back/Forward drive the drawer too.
    await open.click();
    await expect(drawer).toBeVisible();
    await page.goBack();
    await expect(drawer).toHaveCount(0);
    await page.goForward();
    await expect(drawer).toBeVisible();
    expect(await sameBoard()).toBe(true);
  });
});
