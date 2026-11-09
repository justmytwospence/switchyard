import type { Page } from "@playwright/test";
import { createTask, expect, poll, test, uid } from "./support";

test.skip(({ isMobile }) => !isMobile, "Mobile board only");

const mainScrollTop = (page: Page) =>
  page.locator("#main").evaluate((el) => Math.round(el.scrollTop));

test.describe("mobile board", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("status tabs with counts and a List toggle", async ({ page }) => {
    await page.goto("/board");
    const setLayout = async (name: "List" | "Columns") => {
      await page.getByRole("button", { name: /^Filters/ }).tap();
      const sheet = page.getByRole("dialog", { name: "Filter tasks" });
      await sheet
        .getByRole("radiogroup", { name: "Board layout" })
        .getByRole("radio", { name })
        .tap();
      await sheet.getByRole("button", { name: "Show results" }).tap();
      await expect(sheet).toHaveCount(0);
    };
    const tabs = page.getByTestId("status-tabs");
    await expect(tabs).toBeVisible();
    const names = ["Backlog", "Ready", "In progress", "Review", "Done"];
    for (const n of names) {
      await expect(tabs.getByRole("tab", { name: new RegExp(`^${n}.*\\d+ tasks`) })).toBeVisible();
    }
    // One status at a time, full-width cards.
    await tabs.getByRole("tab", { name: /^In progress/ }).tap();
    await expect(tabs.getByRole("tab", { name: /^In progress/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const running = page.getByRole("article", { name: "Long running migration" });
    await expect(running).toBeVisible();
    await expect(page.getByRole("article", { name: "Plan the onboarding flow" })).toHaveCount(0);
    const vw = page.viewportSize()!.width;
    expect((await running.boundingBox())!.width).toBeGreaterThan(vw - 40);

    // The grouped List shows several statuses together.
    await setLayout("List");
    await expect(tabs).toHaveCount(0);
    for (const s of ["backlog", "ready", "in_progress", "review"]) {
      await expect(page.getByTestId(`column-${s}`)).toBeVisible();
    }
    await expect(page.getByRole("article", { name: "Plan the onboarding flow" })).toBeVisible();
    await expect(running).toBeVisible();
    // The layout choice is remembered.
    await page.reload();
    await expect(page.getByTestId("column-backlog")).toBeVisible();
    await setLayout("Columns");
    await expect(page.getByTestId("status-tabs")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("card opens a full-screen detail; Back preserves the board position", async ({
    page,
    api,
    state,
  }, info) => {
    const suffix = uid(info);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createTask(api, state, { title: `Scroll card ${i} ${suffix}` }),
      ),
    );
    await page.goto("/board");
    // Other specs mutate the shared board. Only this test's cards may affect its scroll geometry.
    await page.getByRole("button", { name: "Show search" }).tap();
    await page.getByPlaceholder("Search tasks").fill(suffix);
    await page
      .getByTestId("status-tabs")
      .getByRole("tab", { name: /^Backlog/ })
      .tap();
    const cards = page.getByTestId("task-card");
    await expect(cards).toHaveCount(10);
    await expect(cards.first()).toBeVisible();
    const main = page.locator("#main");
    expect(await main.evaluate((el) => el.scrollHeight > el.clientHeight + 200)).toBe(true);

    const target = cards.last();
    const label = (await target.getAttribute("aria-label"))!;
    const title = (await target.locator("[data-card-open]").textContent())!;
    await target.scrollIntoViewIfNeeded();
    const before = await mainScrollTop(page);
    expect(before).toBeGreaterThan(100);

    await target.locator("[data-card-open]").tap();
    const detail = page.getByTestId("task-page");
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("heading", { name: title })).toBeVisible();
    expect((await detail.boundingBox())!.width).toBe(page.viewportSize()!.width);
    // Full screen: the bottom nav is hidden.
    await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(0);

    await page.getByRole("button", { name: "Back to board" }).tap();
    await expect(page.getByTestId("status-tabs")).toBeVisible();
    await expect(page).toHaveURL(/\/board$/);
    await expect.poll(() => mainScrollTop(page)).toBe(before);
    await expect(
      page.getByRole("article", { name: label, exact: true }).locator("[data-card-open]"),
    ).toBeFocused();
  });

  test("Move task sheet", async ({ page, api, state }, info) => {
    const t = await createTask(api, state, { title: `Sheet move ${uid(info)}` });
    await page.goto(`/tasks/${t.id}`);
    const trigger = page.getByRole("button", { name: "Move task" });
    await trigger.tap();
    const sheet = page.getByTestId("move-sheet");
    await expect(sheet).toBeVisible();
    // Invalid targets explain why.
    const inProgress = sheet.getByRole("button", { name: /In progress/ });
    await expect(inProgress).toBeDisabled();
    await expect(inProgress).toContainText("Backlog task cannot start directly");
    await sheet.getByRole("button", { name: /Make ready/ }).tap();
    await expect(sheet).toHaveCount(0);
    await poll(
      "moved to ready",
      async () => (await api("GET", `/api/tasks/${t.id}`)).state === "ready",
    );
    await expect(page.getByText(/Moved to Ready/)).toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("compact new-task form previews whether work starts", async ({ page, api }, info) => {
    await page.goto("/board");
    await page.getByRole("button", { name: "New task" }).tap();
    const form = page.getByTestId("new-task-form");
    await expect(form).toBeVisible();
    const title = `Mobile new ${uid(info)}`;
    await form.getByLabel("Title").fill(title);
    await form.getByLabel("Objective").fill("Created from the phone.");
    // Advanced options inherit project defaults and stay collapsed.
    await expect(form.getByRole("button", { name: /Advanced options/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await expect(form.getByRole("status").filter({ hasText: "Make ready:" })).toHaveText(
      /Make ready: Will (start automatically on e2e-host|wait: .+)/,
    );
    await form.getByRole("button", { name: "Make ready" }).tap();
    await expect(form).toHaveCount(0);
    await expect(
      page.getByTestId("status-tabs").getByRole("tab", { name: /^Ready/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("article", { name: title })).toBeVisible();
    const tasks: any[] = await api("GET", "/api/tasks");
    expect(tasks.find((t) => t.title === title)?.state).toBe("ready");
  });

  test("filters open a sheet and show removable chips", async ({ page }) => {
    await page.goto("/board");
    await page
      .getByTestId("status-tabs")
      .getByRole("tab", { name: /^In progress/ })
      .tap();
    await expect(page.getByRole("article", { name: "Long running migration" })).toBeVisible();
    const trigger = page.getByRole("button", { name: "Filters" });
    await trigger.tap();
    const sheet = page.getByRole("dialog", { name: "Filter tasks" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("checkbox", { name: "Low" }).check();
    await sheet.getByRole("button", { name: "Show results" }).tap();
    await expect(sheet).toHaveCount(0);

    const chips = page.getByTestId("filter-chips");
    await expect(chips).toBeVisible();
    const chip = chips.getByRole("button", { name: /^Remove filter .*Low/ });
    await expect(chip).toBeVisible();
    await expect(page.getByRole("button", { name: "Filters, 1 active" })).toBeVisible();
    // The High-priority running task is filtered out.
    await expect(page.getByRole("article", { name: "Long running migration" })).toHaveCount(0);

    await chip.tap();
    await expect(chips).toHaveCount(0);
    await expect(page.getByRole("article", { name: "Long running migration" })).toBeVisible();
  });

  test("compact sticky header", async ({ page }) => {
    await page.goto("/board");
    const header = page.getByTestId("board-header");
    expect((await header.boundingBox())!.height).toBeLessThan(190);
    await expect(page.getByPlaceholder("Search tasks")).toHaveCount(0);
    await page.getByRole("button", { name: "Show search" }).tap();
    await expect(page.getByPlaceholder("Search tasks")).toBeFocused();
    await page.locator("#main").evaluate((el) => {
      el.scrollTop = 400;
    });
    expect(Math.round((await header.boundingBox())!.y)).toBeLessThanOrEqual(1);
    await page.getByRole("button", { name: /^Dispatch (on|paused)/ }).tap();
    const sheet = page.getByRole("dialog", { name: "Dispatch" });
    await expect(sheet.getByRole("button", { name: /^(Pause|Resume) dispatch$/ })).toBeVisible();
    await sheet.getByRole("button", { name: "Close" }).tap(); // never toggle: global state
  });
});
