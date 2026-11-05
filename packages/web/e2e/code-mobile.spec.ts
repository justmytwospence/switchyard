import type { Page } from "@playwright/test";
import { createSession, expect, poll, test, uid } from "./support";

test.skip(({ isMobile }) => !isMobile, "Mobile coding view only");

const bottomNav = (page: Page) => page.getByRole("navigation", { name: "Primary" });

/** Simulate the on-screen keyboard by shrinking (or restoring) `visualViewport.height`. */
async function setKeyboard(page: Page, open: boolean) {
  await page.evaluate((open) => {
    const vv = window.visualViewport!;
    if (open) {
      const h = Math.round(window.innerHeight * 0.55);
      Object.defineProperty(vv, "height", { configurable: true, get: () => h });
    } else {
      delete (vv as unknown as { height?: number }).height;
    }
    vv.dispatchEvent(new Event("resize"));
  }, open);
}

test.describe("mobile coding view", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("one surface at a time: Chat, Changes and Details", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const tabs = page.getByTestId("mobile-tabs");
    await expect(tabs).toBeVisible();
    // No miniature desktop sidebars.
    await expect(page.getByTestId("navigator")).toHaveCount(0);
    await expect(page.getByTestId("inspector")).toHaveCount(0);
    await expect(page.getByTestId("transcript")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Long transcript session" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to sessions" })).toBeVisible();
    await expect(bottomNav(page)).toHaveCount(0);

    // Tapping the title shows the session facts.
    await page.getByRole("heading", { name: "Long transcript session" }).getByRole("button").tap();
    const info = page.getByRole("dialog", { name: "Session details" });
    await expect(info).toContainText("Demo project");
    await expect(info).toContainText("Manual session");
    await info.getByRole("button", { name: "Close" }).tap();
    await expect(info).toHaveCount(0);

    await tabs.getByRole("radio", { name: "Changes" }).click();
    await expect(tabs.getByRole("radio", { name: "Changes" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByRole("list", { name: "Changed files" })).toBeVisible();
    await expect(page.getByTestId("transcript")).toBeHidden();
    await expect(page.getByTestId("composer")).toBeHidden();

    await tabs.getByRole("radio", { name: "Details" }).click();
    const details = page.getByRole("region", { name: "Details" });
    await expect(details).toBeVisible();
    await expect(page.getByRole("list", { name: "Changed files" })).toBeHidden();
    for (const name of ["Take over", "Return to automation", "Stop"]) {
      await expect(details.getByRole("button", { name })).toHaveCount(0);
    }
    await expect(
      details.getByText("No linked task: this session was started directly."),
    ).toBeVisible();
    await expect(details.getByRole("link", { name: "Open Board" })).toHaveCount(0);

    await tabs.getByRole("radio", { name: "Chat" }).click();
    await expect(page.getByTestId("transcript")).toBeVisible();
    await expect(page.getByTestId("composer")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("Return inserts a newline and Send sends", async ({ page, state, api }, info) => {
    const id = await createSession(api, state, `Mobile send ${uid(info)}`, "hello mobile");
    let prompts = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().endsWith(`/api/sessions/${id}/prompt`)) prompts++;
    });
    await page.goto(`/code/${id}`);
    const box = page.getByLabel("Message to Pi");
    await box.tap();
    await page.keyboard.type("first line");
    await page.keyboard.press("Enter");
    await page.keyboard.type("second line");
    await expect(box).toHaveValue("first line\nsecond line");
    expect(prompts).toBe(0);

    await setKeyboard(page, true);
    const sent = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith(`/api/sessions/${id}/prompt`),
    );
    await page.getByTestId("composer").getByRole("button", { name: "Send" }).tap();
    expect((await sent).postDataJSON().text).toBe("first line\nsecond line");
    await expect(box).toHaveValue("");
    await expect(box).not.toBeFocused();
    await expect(page.getByTestId("transcript").getByText("Received: first line")).toBeVisible();
    expect(prompts).toBe(1);
  });

  test("composer grows to at most 33vh, then scrolls", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const box = page.getByLabel("Message to Pi");
    await box.fill(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
    const m = await box.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      limit: window.innerHeight * 0.33,
    }));
    expect(m.height).toBeLessThanOrEqual(m.limit + 1);
    expect(m.height).toBeGreaterThan(m.limit * 0.8);
    expect(m.scrollHeight).toBeGreaterThan(m.clientHeight);
    // The composer stays on screen.
    await expect(
      page.getByTestId("composer").getByRole("button", { name: "Send" }),
    ).toBeInViewport();
    await box.fill("");
  });

  test("full-screen diff with previous and next", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    await page.getByTestId("mobile-tabs").getByRole("radio", { name: "Changes" }).click();
    const list = page.getByRole("list", { name: "Changed files" });
    await expect(list.getByRole("button")).toHaveCount(state.changedFiles.length);
    await list.getByRole("button").first().tap();

    const total = state.changedFiles.length;
    const diff = page.locator("section[aria-label^='Diff of ']").first();
    await expect(diff).toBeVisible();
    await expect(diff).toContainText(`File 1 of ${total}`);
    const box = (await diff.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(Math.round(box.width)).toBe(vp.width);
    await expect(bottomNav(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Previous file" })).toBeDisabled();

    const seen = new Set<string>();
    for (let i = 1; i <= total; i++) {
      await expect(diff).toContainText(`File ${i} of ${total}`);
      seen.add((await diff.getAttribute("aria-label"))!.replace("Diff of ", ""));
      if (i < total) await page.getByRole("button", { name: "Next file" }).tap();
    }
    expect([...seen].sort()).toEqual([...state.changedFiles].sort());
    await expect(page.getByRole("button", { name: "Next file" })).toBeDisabled();
    await page.getByRole("button", { name: "Previous file" }).tap();
    await expect(diff).toContainText(`File ${total - 1} of ${total}`);

    await page.getByRole("button", { name: "Back to changed files" }).tap();
    await expect(list).toBeVisible();
    await expect(bottomNav(page)).toHaveCount(0);

    // Horizontal scrolling stays inside the code block, and a long line keeps its line numbers.
    await list.getByRole("button", { name: /src\/wide\.ts/ }).tap();
    await expect(diff).toHaveAttribute("aria-label", "Diff of src/wide.ts");
    const scroller = diff.locator(".overflow-x-auto");
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await diff.getByRole("button", { name: "Comment on line 2" }).tap();
    const sheet = page.getByRole("dialog", { name: "Add review comment" });
    await expect(sheet).toBeVisible();
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0);
    await sheet.getByRole("button", { name: "Cancel" }).tap();

    await page.getByRole("button", { name: "Back to changed files" }).tap();
    await expect(list).toBeVisible();
    await expect(bottomNav(page)).toHaveCount(0);
  });

  test("a multiselect question is answered by tapping", async ({ page, state, api }, info) => {
    const id = await createSession(
      api,
      state,
      `Toppings ${uid(info)}`,
      "ASK-TOPPINGS please",
      (s) => s.runtime === "waiting_input",
    );
    await poll("pending toppings question", async () => {
      const list: any[] = await api("GET", `/api/interactions?sessionId=${id}&state=pending`);
      return list.length > 0;
    });
    await page.goto(`/code/${id}`);
    const card = page.getByTestId("interaction-card").first();
    await expect(card).toContainText("Which toppings do you want?");
    // Structured options, not "1,3".
    await expect(card.getByRole("checkbox")).toHaveCount(3);
    await expect(card.getByRole("textbox")).toHaveCount(0);
    await card.getByText("Cheese", { exact: true }).tap();
    await card.getByText("Basil", { exact: true }).tap();
    await expect(card.getByRole("checkbox", { name: /Cheese/ })).toBeChecked();
    await expect(card.getByRole("checkbox", { name: /Olives/ })).not.toBeChecked();
    await card.getByRole("button", { name: "Submit answers" }).tap();
    await expect(
      page.getByTestId("transcript").getByText(/Got your toppings\. Toppings: Cheese, Basil/),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="session-status"][data-kind="answer"]')).toHaveCount(0);
  });

  test("bottom nav hides while composing with the keyboard", async ({ page, state }) => {
    // Any text field: the visual viewport shrinking under focus hides the nav.
    await page.goto("/board");
    await expect(bottomNav(page)).toBeVisible();
    await page.getByRole("button", { name: "Show search" }).tap();
    const search = page.getByPlaceholder("Search tasks");
    await search.focus();
    await expect(bottomNav(page)).toBeVisible();
    await setKeyboard(page, true);
    await expect(bottomNav(page)).toHaveCount(0);
    await setKeyboard(page, false);
    await expect(bottomNav(page)).toBeVisible();
    await setKeyboard(page, true);
    await expect(bottomNav(page)).toHaveCount(0);
    await search.blur();
    await setKeyboard(page, false);
    await expect(bottomNav(page)).toBeVisible();

    // The composer: hidden while composing; the header Back link keeps navigation reachable.
    await page.goto(`/code/${state.sessions.long}`);
    await expect(bottomNav(page)).toHaveCount(0);
    await page.getByLabel("Message to Pi").focus();
    await setKeyboard(page, true);
    await expect(bottomNav(page)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Back to sessions" })).toBeVisible();
    await expect(
      page.getByTestId("composer").getByRole("button", { name: "Send" }),
    ).toBeInViewport();
    await page.getByLabel("Message to Pi").blur();
    await setKeyboard(page, false);
    await expect(bottomNav(page)).toHaveCount(0);
    await page.getByRole("link", { name: "Back to sessions" }).tap();
    await expect(bottomNav(page)).toBeVisible();
  });

  test("archived session can be unarchived from the menu", async ({ page, state, api }, info) => {
    const id = await createSession(api, state, `Mobile archived ${uid(info)}`, "hello");
    await page.goto(`/code/${id}`);
    await expect(page.getByTestId("transcript")).toBeVisible();
    await api("POST", `/api/sessions/${id}/archive`);
    await expect(page.getByTestId("session-status")).toHaveAttribute("data-kind", "archived");
    // An archived session is not in the snapshot, but its URL still opens after a reload.
    await page.reload();
    await expect(page.getByTestId("transcript")).toBeVisible();
    await expect(page.getByTestId("session-status")).toHaveAttribute("data-kind", "archived");
    await page.getByRole("button", { name: "More actions" }).tap();
    await page.getByRole("menuitem", { name: "Unarchive" }).tap();
    await expect(page.getByText("Session unarchived.")).toBeVisible();
  });

  test("Review changes on the task opens the Changes segment", async ({ page, state }) => {
    await page.goto(`/tasks/${state.tasks.review}`);
    await expect(page.getByTestId("task-page")).toBeVisible();
    await page.getByRole("link", { name: "Review changes" }).first().tap();
    await expect(page).toHaveURL(new RegExp(`/code/${state.reviewSessionId}\\?tab=changes`));
    await expect(
      page.getByTestId("mobile-tabs").getByRole("radio", { name: "Changes" }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("region", { name: "Changes" })).toBeVisible();
  });

  test("model and effort controls are thumb-sized and stay on screen", async ({
    page,
    state,
    api,
  }, info) => {
    const id = await createSession(api, state, `Mobile effort ${uid(info)}`, "hello there");
    await page.goto(`/code/${id}`);
    const controls = page.getByTestId("session-controls");
    const noOverflow = async () =>
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    const model = controls.getByRole("button", { name: /^Model: Mock 1/ });
    expect((await model.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noOverflow();
    await model.tap();
    const dialog = page.getByRole("dialog", { name: "Model" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Mock 2/ }).tap();
    await expect(dialog).toHaveCount(0);
    const effort = controls.getByRole("button", { name: /^Effort: / });
    expect((await effort.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await noOverflow();
    await effort.tap();
    const sheet = page.getByRole("dialog", { name: "Effort" });
    await expect(sheet).toBeVisible();
    const box = (await sheet.boundingBox())!;
    const vw = await page.evaluate(() => window.innerWidth);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vw);
    await noOverflow();
    const sent = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith(`/api/sessions/${id}/thinking`),
    );
    await sheet.getByRole("slider", { name: "Effort" }).evaluate((el: HTMLInputElement) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(el, "4");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.getByTestId("transcript").tap({ position: { x: 5, y: 5 } });
    await expect(sheet).toHaveCount(0);
    expect((await sent).postDataJSON().level).toBe("high");
    await noOverflow();

    // The slim context bar has a touch-sized hit area.
    const context = page.getByTestId("composer").getByRole("button", { name: /^Context/ });
    const cb = (await context.boundingBox())!;
    await page.touchscreen.tap(cb.x + cb.width / 2, cb.y - 10);
    await expect(page.getByRole("menu", { name: "Context" })).toBeVisible();
  });

  test("Back from a deep-linked session replaces history instead of looping", async ({
    page,
    state,
  }) => {
    await page.goto("/attention");
    await expect(page.locator("#main")).toBeVisible();
    await page.goto(`/code/${state.sessions.long}`);
    await page.getByRole("link", { name: "Back to sessions" }).tap();
    await expect(page).toHaveURL(/\/code$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/attention$/);
  });

  test("Back from a session opened from the navigator pops history", async ({ page }) => {
    await page.goto("/code");
    await page.getByTestId("session-row").first().tap();
    await expect(page).toHaveURL(/\/code\/[^/]+$/);
    await page.getByRole("link", { name: "Back to sessions" }).tap();
    await expect(page).toHaveURL(/\/code$/);
    await page.goForward();
    await expect(page).toHaveURL(/\/code\//);
  });

  test("the session header adds the top safe-area inset", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const top = page.locator("header").first().locator("..");
    await expect(top).toBeVisible();
    await page.evaluate(() => document.documentElement.style.setProperty("--safe-top", "20px"));
    // The inset sits on a wrapper with no padding utility, so it is not lost to the header's py-1.
    await expect(top).toHaveCSS("padding-top", "20px");
  });

  test("New session is one full-height sheet", async ({ page }, info) => {
    await page.goto("/code");
    await page.getByTestId("new-session").tap();
    const sheet = page.getByRole("dialog", { name: "New session" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText(/Step \d of/)).toHaveCount(0);
    expect(Math.round((await sheet.boundingBox())!.height)).toBe(page.viewportSize()!.height);
    const text = `Mobile hello ${uid(info)}`;
    await sheet.getByLabel("What should Pi do?").fill(text);
    await sheet.getByRole("button", { name: "Create session" }).tap();
    await expect(page).toHaveURL(/\/code\/ses_/);
  });
});
