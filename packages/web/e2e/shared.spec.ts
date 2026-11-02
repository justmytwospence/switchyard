import type { Page } from "@playwright/test";
import { expect, isMobile, test, uid } from "./support";

async function noHorizontalOverflow(
  page: Page,
): Promise<{ scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    innerWidth: window.innerWidth,
  }));
}

/** Wait until the app has rendered its view (live sync connected, no loading spinner). */
async function settled(page: Page) {
  await expect(page.locator("#main")).toBeVisible();
  await expect(page.getByText(/^Loading/)).toHaveCount(0);
  await page.waitForTimeout(300);
}

test.describe("shared behavior", () => {
  test("no page scrolls horizontally", async ({ page, signIn, state }, info) => {
    await signIn();
    const paths = [
      "/code",
      `/code/${state.sessions.long}`,
      `/code/${state.sessions.question}`,
      `/code/${state.runningSessionId}`,
      "/board",
      `/tasks/${state.tasks.review}`,
      `/tasks/${state.tasks.running}`,
      "/attention",
      "/now",
      "/automations",
      `/automations/${state.automationId}`,
      "/automations/new",
      "/settings",
      "/settings/hosts",
      `/settings/hosts/${state.hostId}`,
      "/settings/devices",
      "/settings/projects",
      `/settings/projects/${state.projectId}`,
      "/settings/profiles",
      "/settings/adapters",
      "/settings/notifications",
      "/settings/diagnostics",
      ...(isMobile(info) ? ["/more"] : []),
    ];
    const failures: string[] = [];
    for (const path of paths) {
      await page.goto(path);
      await settled(page);
      const m = await noHorizontalOverflow(page);
      if (m.scrollWidth > m.innerWidth)
        failures.push(`${path}: ${m.scrollWidth} > ${m.innerWidth}`);
    }
    expect(failures).toEqual([]);
  });

  test("drafts survive navigation and reload", async ({ page, signIn, state }, info) => {
    await signIn();
    await page.goto(`/code/${state.sessions.long}`);
    const box = page.getByLabel("Message to Pi");
    const draft = `Unsent draft ${uid(info)}\nwith two lines`;
    await box.fill(draft);

    // Navigate away through the app's navigation, then come back (on mobile the bottom nav
    // is hidden while composing, so leave the composer first).
    await box.blur();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: "Board" }).click();
    await expect(page.getByTestId("board")).toBeVisible();
    await page.goBack();
    await expect(page.getByLabel("Message to Pi")).toHaveValue(draft);

    await page.reload();
    await expect(page.getByLabel("Message to Pi")).toHaveValue(draft);

    // Another session has its own (empty) draft.
    await page.goto(`/code/${state.sessions.question}`);
    await expect(page.getByLabel("Message to Pi")).toHaveValue("");
    await page.goto(`/code/${state.sessions.long}`);
    await expect(page.getByLabel("Message to Pi")).toHaveValue(draft);
    await page.getByLabel("Message to Pi").fill("");
  });

  test("deep links survive the enrollment redirect and reconnect", async ({
    page,
    context,
    api,
    state,
  }) => {
    const pending: any[] = await api(
      "GET",
      `/api/interactions?sessionId=${state.sessions.question}&state=pending`,
    );
    const interactionId = pending[0].id as string;
    const deepLink = `/code/${state.sessions.question}?interaction=${interactionId}`;

    // Not enrolled: the app redirects to /enroll and remembers the link.
    await page.goto(deepLink);
    await expect(page).toHaveURL(/\/enroll\?next=/);
    await expect(page.getByText("This device is not enrolled.")).toBeVisible();

    // Open an enrollment link (as from a QR code on another device).
    const e = await api<{ token: string }>("POST", "/api/devices/enrollments");
    await page.goto(`/enroll#token=${e.token}`);
    await expect(page.getByLabel("Device name")).toBeVisible();
    // The token is kept out of the address bar.
    await expect.poll(() => page.url()).not.toContain(e.token);
    await page.getByRole("button", { name: "Enroll device" }).click();
    await expect(page).toHaveURL(new RegExp(`${deepLink.replace("?", "\\?")}$`));
    const card = page.locator(`[id$="${interactionId}"]`).first();
    await expect(page.getByTestId("interaction-card").first()).toBeVisible();
    await expect(card).toBeVisible();
    expect((await context.cookies()).some((c) => c.name === "sy_device" && c.httpOnly)).toBe(true);

    // Lose the connection: last known data stays, then live sync resumes on the same link.
    await context.setOffline(true);
    await expect(
      page.getByRole("status").filter({ hasText: /Offline|Reconnecting/ }),
    ).toBeVisible();
    await expect(page.getByTestId("interaction-card").first()).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByRole("status").filter({ hasText: /Offline|Reconnecting/ })).toHaveCount(
      0,
      {
        timeout: 20_000,
      },
    );
    await expect(page).toHaveURL(new RegExp(`${deepLink.replace("?", "\\?")}$`));
    await expect(page.getByTestId("interaction-card").first()).toBeVisible();

    // A reload reconnects with the cookie and keeps the deep link.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${deepLink.replace("?", "\\?")}$`));
    await expect(page.getByTestId("interaction-card").first()).toBeVisible();
  });

  test("focus returns to the trigger after a drawer or sheet closes", async ({
    page,
    signIn,
    state,
  }, info) => {
    await signIn();
    await page.goto("/board");
    await expect(page.getByTestId("board")).toBeVisible();

    // Filters: a dialog on desktop, a bottom sheet on mobile.
    const filters = page.getByRole("button", { name: "Filters" });
    await filters.click();
    const sheet = page.getByRole("dialog", { name: "Filter tasks" });
    await expect(sheet).toBeVisible();
    await expect(sheet.locator(":focus")).toHaveCount(1);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(sheet).toHaveCount(0);
    await expect(filters).toBeFocused();

    // New task, closed with Escape.
    const newTask = page.getByRole("button", { name: "New task" }).first();
    await newTask.click();
    const form = page.getByTestId("new-task-form");
    await expect(form).toBeVisible();
    await expect(form.getByLabel("Title")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(form).toHaveCount(0);
    await expect(newTask).toBeFocused();

    if (!isMobile(info)) {
      // The task drawer returns focus to the card that opened it.
      const open = page.locator(`[data-card-open="${state.tasks.backlog}"]`);
      await open.focus();
      await page.keyboard.press("Enter");
      const drawer = page.getByRole("dialog", { name: "Plan the onboarding flow" });
      await expect(drawer).toBeVisible();
      await expect(drawer.locator(":focus")).toHaveCount(1);
      await drawer.getByRole("button", { name: "Close" }).click();
      await expect(drawer).toHaveCount(0);
      await expect(open).toBeFocused();
    } else {
      // The Move task sheet returns focus to its button.
      await page.goto(`/tasks/${state.tasks.backlog}`);
      const move = page.getByRole("button", { name: "Move task" });
      await move.click();
      const moveSheet = page.getByRole("dialog", { name: "Move task" });
      await expect(moveSheet).toBeVisible();
      await expect(moveSheet.locator(":focus")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(moveSheet).toHaveCount(0);
      await expect(move).toBeFocused();
    }
  });

  test("status chips have text", async ({ page, signIn, state }) => {
    await signIn();
    let total = 0;
    for (const path of [
      `/code/${state.sessions.question}`,
      `/code/${state.runningSessionId}`,
      `/tasks/${state.tasks.running}`,
      "/now",
      "/attention",
      "/settings/hosts",
      `/automations/${state.automationId}`,
    ]) {
      await page.goto(path);
      await settled(page);
      const chips = await page.locator("[data-status-chip]").evaluateAll((els) =>
        els.map((el) => ({
          text: (el.textContent ?? "").trim(),
          icon: !!el.querySelector("svg"),
          visible: (el as HTMLElement).getClientRects().length > 0,
        })),
      );
      const visible = chips.filter((c) => c.visible);
      total += visible.length;
      for (const c of visible) {
        expect(c.text, `status chip on ${path}`).not.toBe("");
        expect(c.icon, `status chip icon on ${path}`).toBe(true);
      }
    }
    expect(total).toBeGreaterThan(3);
  });

  test("automation preview uses the saved or the draft endpoint", async ({
    page,
    signIn,
    state,
  }) => {
    await signIn();
    await page.goto(`/automations/${state.automationId}`);
    const preview = page.getByTestId("automation-preview");
    await expect(preview).toBeVisible();

    const saved = page.waitForRequest((r) =>
      r.url().includes(`/api/automations/${state.automationId}/preview`),
    );
    await preview.getByRole("button", { name: "Preview resulting task" }).click();
    expect((await saved).method()).toBe("GET");
    await expect(preview.getByRole("heading", { name: "Check dependencies" })).toBeVisible();
    await expect(preview.getByText("Could not preview")).toHaveCount(0);

    // An unsaved edit previews the draft.
    await page.getByLabel("Task title").fill("Check dependencies (draft)");
    await expect(
      preview.getByText("The form changed since this preview.", { exact: false }),
    ).toBeVisible();
    const draft = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/api/automations/preview"),
    );
    await preview.getByRole("button", { name: "Preview resulting task" }).click();
    await draft;
    await expect(
      preview.getByRole("heading", { name: "Check dependencies (draft)" }),
    ).toBeVisible();
  });
});
