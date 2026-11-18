import { expect, isMobile, test } from "./support";

test.describe("keyboard layers", () => {
  test("Escape follows the top layer after focus drift and restores its opener", async ({
    page,
    signIn,
  }) => {
    await signIn();
    await page.goto("/code");
    const opener = page.getByRole("navigation", { name: "Primary" }).getByRole("link", {
      name: "Board",
    });
    await opener.focus();
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    const search = palette.getByRole("combobox", { name: "Search" });
    await search.fill("Board");
    await search.press("Control+j");
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(opener).toBeFocused();

    await page.keyboard.press("ControlOrMeta+k");
    await expect(palette).toBeVisible();
    // Deliberate focus drift outside the portal must not bypass Escape arbitration.
    await opener.focus();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("a menu above a drawer dismisses first; its Tab boundary stays in the drawer", async ({
    page,
    signIn,
    state,
  }, info) => {
    test.skip(isMobile(info), "Board task drawer is desktop-only");
    await signIn();
    await page.goto("/tasks");
    const opener = page.locator(`[data-card-open="${state.tasks.backlog}"]`);
    await opener.click();
    const drawer = page.getByRole("dialog", { name: "Plan the onboarding flow" });
    await expect(drawer).toBeVisible();
    const trigger = drawer.getByRole("button", { name: "Move to…" });
    const menu = page.getByRole("menu", { name: "Move Plan the onboarding flow" });
    await trigger.click();
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem").last().focus();
    // Hidden/inert descendants must not become the last tabbable item.
    await drawer.evaluate((root) => {
      const hidden = document.createElement("div");
      hidden.hidden = true;
      hidden.innerHTML = "<button>Hidden control</button>";
      const inert = document.createElement("div");
      inert.setAttribute("inert", "");
      inert.innerHTML = "<button>Inert control</button>";
      root.append(hidden, inert);
    });
    await page.keyboard.press("Tab");
    await expect(menu).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Close" })).toBeFocused();

    await trigger.click();
    await menu.getByRole("menuitem").first().press("Shift+Tab");
    await expect(menu).toHaveCount(0);
    await expect(drawer.locator(":focus")).toHaveCount(1);

    await trigger.click();
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem").first().press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(menu).toBeVisible();
    await opener.focus(); // External drift: the menu, not the drawer, owns Escape.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(opener).toBeFocused();
  });

  test("a busy nested confirmation consumes Escape and keeps body scroll locked", async ({
    page,
    signIn,
    state,
  }, info) => {
    test.skip(isMobile(info), "Board task drawer is desktop-only");
    await signIn();
    await page.goto("/tasks");
    await page.locator(`[data-card-open="${state.tasks.backlog}"]`).click();
    const drawer = page.getByRole("dialog", { name: "Plan the onboarding flow" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("button", { name: "Delete task" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete this task?" });
    await expect(confirm).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");

    await drawer.getByRole("button", { name: "Delete task" }).click();
    await expect(confirm).toBeVisible();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(new RegExp(`/api/tasks/${state.tasks.backlog}$`), async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await held;
      await route.fulfill({ status: 503, body: "Temporarily unavailable" });
    });
    await confirm.getByRole("button", { name: "Delete task" }).click();
    try {
      await expect(confirm.getByRole("button", { name: "Delete task" })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(confirm).toBeVisible();
      await expect(drawer).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    } finally {
      release();
    }
    await expect(confirm.getByRole("button", { name: "Delete task" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
  });
});
