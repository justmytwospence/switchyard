import type { Page } from "@playwright/test";
import { createSession, expect, isMobile, test, uid, viewportOf } from "./support";

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
      "/queue",
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
      // Squeezed headings: a short title wrapping onto many lines means a flex sibling (header
      // actions) starved it of width instead of wrapping below it.
      const squeezed = await page.evaluate(() =>
        [...document.querySelectorAll("h1, h2, h3")]
          .filter((h) => {
            const el = h as HTMLElement;
            const text = (el.textContent ?? "").trim();
            if (!text || text.length > 40 || el.offsetParent === null) return false;
            const lh = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
            return el.getBoundingClientRect().height > lh * 2.5;
          })
          .map((h) => (h.textContent ?? "").trim()),
      );
      if (squeezed.length) failures.push(`${path}: squeezed heading ${squeezed.join(", ")}`);
    }
    expect(failures).toEqual([]);
  });

  test("the expanded rail pushes the content", async ({ page, signIn }, info) => {
    test.skip(viewportOf(info) === "mobile", "The rail is not shown on mobile");
    await signIn();
    await page.goto("/board");
    await settled(page);
    const mainX = async () => (await page.locator("#main").boundingBox())!.x;
    const before = await mainX();
    await page.getByRole("button", { name: "Expand navigation labels" }).click();
    await expect.poll(mainX).toBeGreaterThan(before + 134);
    expect(Math.abs((await mainX()) - before - 136)).toBeLessThanOrEqual(2);
    await page.locator("#main").click({ position: { x: 5, y: 5 } });
    await expect(page.getByRole("button", { name: "Collapse navigation labels" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.getByRole("button", { name: "Collapse navigation labels" }).click();
    await expect.poll(mainX).toBe(before);
  });

  test("a failed route chunk reloads the page once", async ({ page, signIn }, info) => {
    test.skip(info.project.name !== "desktop-1440x900", "desktop project only");
    await signIn();
    await page.goto("/code");
    await settled(page);
    await page.evaluate(() => {
      (window as unknown as { __m: number }).__m = 1;
    });
    let aborted = false;
    await page.route(/\/assets\/.*\.js$/, (route) => {
      if (aborted) return route.continue();
      aborted = true;
      return route.abort();
    });
    await page
      .getByRole("navigation", { name: "Primary" })
      .getByRole("link", { name: "Queue" })
      .click();
    await expect(page.getByRole("heading", { name: "Queue", exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __m?: number }).__m)).toBeUndefined();
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
    if (isMobile(info)) await page.getByRole("link", { name: "Back to sessions" }).click();
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: "Board" }).click();
    await expect(page.getByTestId("board")).toBeVisible();
    await page.goBack();
    // Back replaced the session with the list, so reopen the session from it.
    if (isMobile(info)) {
      await page.getByTestId("session-row").filter({ hasText: "Long transcript session" }).click();
    }
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

    // Not enrolled: the app redirects to /enroll (sign-in) and remembers the link.
    await page.goto(deepLink);
    await expect(page).toHaveURL(/\/sign-in\?next=/);
    await expect(page.getByText("Sign in to Switchyard")).toBeVisible();

    // Open an enrollment link (as from a QR code on another device).
    const e = await api<{ token: string }>("POST", "/api/devices/enrollments");
    await page.goto(`/sign-in#token=${e.token}`);
    await expect(page.getByTestId("signin-link")).toBeVisible();
    // The token is kept out of the address bar.
    await expect.poll(() => page.url()).not.toContain(e.token);
    await page.getByTestId("signin-link").click();
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

  test("a device can be renamed in Settings › Devices", async ({ page, signIn }, info) => {
    test.skip(info.project.name !== "desktop-1440x900", "desktop project only");
    await signIn();
    await page.goto("/settings/devices");
    await settled(page);
    await page.getByTestId("device-rename").first().click();
    await page.getByLabel("Device name").fill("Renamed browser");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Renamed browser").first()).toBeVisible();

    // Toasts sit bottom-right on desktop, clear of the content.
    const toast = page.getByRole("status").filter({ hasText: "Renamed to Renamed browser" });
    await expect(toast).toBeVisible();
    const box = (await toast.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x + box.width).toBeGreaterThan(viewport.width - 40);
    expect(box.y + box.height).toBeGreaterThan(viewport.height - 40);
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
      "/queue",
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

  test("attention: Dismiss moves an item from Open to Dismissed", async ({
    page,
    signIn,
    api,
    state,
  }, info) => {
    await signIn();
    const title = `Dismiss me ${uid(info)}`;
    await createSession(
      api,
      state,
      title,
      "ASK-FRUIT please",
      (s) => s.runtime === "waiting_input",
    );
    await page.goto("/attention");
    const show = page.getByRole("radiogroup", { name: "Show" });
    await expect(show.getByRole("radio", { name: "Open" })).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByText("Answer here; the answer goes to the same runtime question."),
    ).toHaveCount(0);
    const row = page.getByRole("article").filter({ hasText: title }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByRole("article").filter({ hasText: title })).toHaveCount(0);
    await show.getByRole("radio", { name: "Dismissed" }).click();
    await expect(page.getByRole("article").filter({ hasText: title }).first()).toContainText(
      "Dismissed",
    );
    await show.getByRole("radio", { name: "History" }).click();
    await expect(page.getByTestId("attention-history")).toBeVisible();
  });

  test("settings index: desktop opens Hosts, mobile lists grouped sections", async ({
    page,
    signIn,
  }, info) => {
    await signIn();
    await page.goto("/settings");
    const nav = page.getByTestId("settings-nav");
    if (isMobile(info)) {
      for (const g of ["Workspace", "Infrastructure", "Access", "This device"]) {
        await expect(nav.getByRole("heading", { name: g, exact: true })).toBeVisible();
      }
      await nav.getByRole("link", { name: /^Hosts/ }).click();
      await expect(page).toHaveURL(/\/settings\/hosts$/);
      await page.getByRole("link", { name: "Back to Settings" }).click();
      await expect(page).toHaveURL(/\/settings$/);
    } else {
      await expect(page).toHaveURL(/\/settings\/hosts$/);
      await expect(nav.getByRole("link", { name: "Hosts" })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await expect(nav.getByRole("link", { name: "Settings", exact: true })).toHaveCount(0);
    }
  });
});
