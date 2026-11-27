import { expect, isMobile, test } from "./support";

test.describe("Vim-style app navigation", () => {
  test("? opens help; disabling plain keys retains Escape and palette modifiers", async ({
    page,
    signIn,
  }) => {
    await signIn();
    await page.goto("/tasks");
    await expect(page.locator("[data-keyboard-default]:visible").first()).toBeVisible();
    await page.locator("main").focus();
    await page.keyboard.press("?");
    const guide = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole("checkbox", { name: "Vim-style navigation" })).toBeChecked();
    await guide.getByRole("checkbox", { name: "Vim-style navigation" }).uncheck();
    await page.keyboard.press("Escape");
    await expect(guide).toHaveCount(0);
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await expect(page).toHaveURL(/\/tasks$/);
    await page.keyboard.press("ControlOrMeta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await palette.getByRole("combobox", { name: "Search" }).fill("jk?/g");
    await expect(palette.getByRole("combobox", { name: "Search" })).toHaveValue("jk?/g");
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  });

  test("route sequences, search and Code focus do not type into fields", async ({
    page,
    signIn,
    state,
  }, info) => {
    await signIn();
    await page.goto("/tasks");
    await expect(page.locator("[data-keyboard-default]:visible").first()).toBeVisible();
    await page.locator("main").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await expect(page).toHaveURL(/\/code$/);
    await page.goto(`/code/${state.sessions.long}`);
    await expect(page.locator("[data-keyboard-composer]:visible").first()).toBeVisible();
    await page.locator("main").focus();
    await page.keyboard.press("i");
    const composer = page.locator("[data-keyboard-composer]:visible").first();
    await expect(composer).toBeFocused();
    await composer.fill("jk?/g");
    await expect(composer).toHaveValue("jk?/g");
    await page.keyboard.press("Escape");
    await expect(composer).toHaveValue("jk?/g");
    await page.locator("main").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("b");
    await expect(page).toHaveURL(/\/board$/);
    await expect(
      page.getByRole("main").getByRole("heading", { name: "Board", exact: true }),
    ).toBeVisible();
    await page.locator("main").focus();
    await page.keyboard.press("g");
    await page.keyboard.press("t");
    await expect(page).toHaveURL(/\/tasks$/);
    await page.goto("/tasks");
    if (!isMobile(info))
      await expect(page.locator("[data-keyboard-search]:visible").first()).toBeVisible();
    await page.locator("main").focus();
    await page.keyboard.press("/");
    if (isMobile(info)) {
      await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    } else {
      await expect(page.locator("[data-keyboard-search]:visible").first()).toBeFocused();
    }
  });

  test("Board item navigation focuses primary controls without activating them", async ({
    page,
    signIn,
    state,
  }, info) => {
    test.skip(isMobile(info), "Desktop Board has column scope markers");
    await signIn();
    await page.goto("/tasks");
    const primary = page.locator(`[data-card-open="${state.tasks.backlog}"]`);
    await expect(primary).toBeVisible();
    await page.locator("main").focus();
    await page.keyboard.press("j");
    const focused = page.locator("[data-keyboard-column] [data-keyboard-item]:focus");
    await expect(focused).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
