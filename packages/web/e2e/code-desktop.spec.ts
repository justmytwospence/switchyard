import type { Page, Request } from "@playwright/test";
import { createSession, expect, test, uid, viewportOf } from "./support";

test.skip(({ isMobile }) => isMobile, "Desktop and compact coding view only");

/** Collect POST /api/sessions/:id/prompt requests made by the page. */
function promptRequests(page: Page, sessionId: string): Request[] {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith(`/api/sessions/${sessionId}/prompt`)) {
      seen.push(r);
    }
  });
  return seen;
}

async function width(page: Page, testId: string): Promise<number> {
  // The inspector pane's width includes its 1 px border (the wrapper around the testid).
  const el = page.getByTestId(testId);
  const box = await (testId === "inspector" ? el.locator("..") : el).boundingBox();
  if (!box) throw new Error(`${testId} is not visible`);
  return Math.round(box.width);
}

async function dragBy(page: Page, name: string, dx: number) {
  const sep = page.getByRole("separator", { name });
  const box = (await sep.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

/** Open the inspector: a pane on desktop (default open), a drawer on compact. */
async function openInspector(page: Page, compact: boolean) {
  if (compact) await page.getByRole("button", { name: "Show inspector" }).click();
  await expect(page.getByTestId("inspector")).toBeVisible();
}

test.describe("desktop coding view", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("navigator is 264 px by default and clamps to 220-360", async ({ page, state }, info) => {
    await page.goto(`/code/${state.sessions.long}`);
    await expect(page.getByTestId("conversation")).toBeVisible();
    const sep = page.getByRole("separator", { name: "Resize navigator" });
    expect(await width(page, "navigator")).toBe(264);
    await expect(sep).toHaveAttribute("aria-valuenow", "264");

    await dragBy(page, "Resize navigator", 500);
    expect(await width(page, "navigator")).toBe(360);
    await expect(sep).toHaveAttribute("aria-valuenow", "360");

    await dragBy(page, "Resize navigator", -500);
    expect(await width(page, "navigator")).toBe(220);

    // Keyboard equivalents: End/Home clamp, Enter resets.
    await sep.focus();
    await page.keyboard.press("End");
    await expect(sep).toHaveAttribute("aria-valuenow", "360");
    await page.keyboard.press("Home");
    await expect(sep).toHaveAttribute("aria-valuenow", "220");
    await page.keyboard.press("Enter");
    await expect(sep).toHaveAttribute("aria-valuenow", "264");
    expect(await width(page, "navigator")).toBe(264);

    // The size is remembered per device.
    await dragBy(page, "Resize navigator", 40);
    const remembered = await width(page, "navigator");
    await page.reload();
    await expect(page.getByTestId("navigator")).toBeVisible();
    expect(await width(page, "navigator")).toBe(remembered);

    // The conversation keeps at least 420 px.
    expect(await width(page, "conversation")).toBeGreaterThanOrEqual(420);

    if (viewportOf(info) === "desktop") {
      const insp = page.getByRole("separator", { name: "Resize inspector" });
      expect(await width(page, "inspector")).toBe(380);
      await insp.focus();
      await page.keyboard.press("End");
      await expect(insp).toHaveAttribute("aria-valuenow", "600");
      expect(await width(page, "inspector")).toBe(600);
      await page.keyboard.press("Home");
      expect(await width(page, "inspector")).toBe(320);
      expect(await width(page, "conversation")).toBeGreaterThanOrEqual(420);
    } else {
      // Compact: no three-pane squeeze; the inspector is not a pane.
      await expect(page.getByRole("separator", { name: "Resize inspector" })).toHaveCount(0);
    }
  });

  test("the inspector collapses", async ({ page, state }, info) => {
    await page.goto(`/code/${state.sessions.long}`);
    await expect(page.getByTestId("conversation")).toBeVisible();
    if (viewportOf(info) === "desktop") {
      await expect(page.getByTestId("inspector")).toBeVisible();
      const before = await width(page, "conversation");
      await page.getByRole("button", { name: "Hide inspector" }).click();
      await expect(page.getByTestId("inspector")).toHaveCount(0);
      expect(await width(page, "conversation")).toBeGreaterThan(before);
      // Remembered across reloads.
      await page.reload();
      await expect(page.getByTestId("conversation")).toBeVisible();
      await expect(page.getByTestId("inspector")).toHaveCount(0);
      await page.getByRole("button", { name: "Show inspector" }).click();
      await expect(page.getByTestId("inspector")).toBeVisible();
    } else {
      // Compact: the inspector is a temporary drawer over the conversation.
      await expect(page.getByTestId("inspector")).toHaveCount(0);
      const toggle = page.getByRole("button", { name: "Show inspector" });
      await toggle.click();
      const drawer = page.getByRole("dialog", { name: "Inspector" });
      await expect(drawer.getByTestId("inspector")).toBeVisible();
      await expect(drawer.locator(":focus")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(drawer).toHaveCount(0);
      await expect(toggle).toBeFocused();
    }
  });

  test("Jump to latest does not autoscroll while reading", async ({ page, state, api }, info) => {
    const id = await createSession(
      api,
      state,
      `Reading ${uid(info)}`,
      "LONG-TRANSCRIPT for reading",
      (s) => s.runtime === "idle" && !!s.lastAssistantText,
    );
    await page.goto(`/code/${id}`);
    const transcript = page.getByTestId("transcript");
    await expect(transcript.getByText("Paragraph 40 of the long answer.")).toBeInViewport();
    await expect(page.getByTestId("jump-to-latest")).toHaveCount(0);
    await expect(transcript.getByTestId("tool-card").first()).toBeVisible();

    // Scroll up to read; the button appears without a count.
    await transcript.evaluate((el) => {
      el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
    });
    const jump = page.getByTestId("jump-to-latest");
    await expect(jump).toBeVisible();
    const reading = await transcript.evaluate((el) => el.scrollTop);

    // New events arrive: the viewport stays put and the button counts them.
    await api("POST", `/api/sessions/${id}/prompt`, { text: "Another message while reading" });
    await expect(jump).toHaveText(/Jump to latest \(\d+\)/);
    await expect(transcript.getByText("Received: Another message while reading")).toBeAttached();
    expect(Math.abs((await transcript.evaluate((el) => el.scrollTop)) - reading)).toBeLessThan(3);
    await expect(
      transcript.getByText("Received: Another message while reading"),
    ).not.toBeInViewport();

    await jump.click();
    await expect(jump).toHaveCount(0);
    await expect(transcript.getByText("Received: Another message while reading")).toBeInViewport();
  });

  test("Needs-your-answer strip opens the first question", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.question}`);
    const strip = page.getByTestId("needs-answer-strip");
    await expect(strip).toContainText("Needs your answer");
    await expect(strip).toContainText("Pick a fruit");
    // Scroll the question away, then use the strip.
    await page.getByTestId("transcript").evaluate((el) => {
      el.scrollTop = 0;
    });
    await strip.getByRole("button").click();
    const card = page.getByTestId("interaction-card").first();
    await expect(card).toBeInViewport();
    const focusedIn = await page.evaluate(
      () => document.activeElement?.closest('[data-testid="interaction-card"]') !== null,
    );
    expect(focusedIn).toBe(true);
    await expect(card.getByRole("radio", { name: "Apple" })).toBeVisible();
  });

  test("Enter sends, Shift+Enter adds a newline", async ({ page, state, api }, info) => {
    const id = await createSession(api, state, `Enter ${uid(info)}`, "hello there");
    const prompts = promptRequests(page, id);
    await page.goto(`/code/${id}`);
    const box = page.getByLabel("Message to Pi");
    await box.click();
    await page.keyboard.type("first line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await expect(box).toHaveValue("first line\nsecond line");
    expect(prompts).toHaveLength(0);

    const sent = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith(`/api/sessions/${id}/prompt`),
    );
    await page.keyboard.press("Enter");
    const req = await sent;
    expect(req.postDataJSON().text).toBe("first line\nsecond line");
    await expect(box).toHaveValue("");
    await expect(page.getByTestId("transcript").getByText("Received: first line")).toBeVisible();
    expect(prompts).toHaveLength(1);
  });

  test("model chip, effort and slash picker", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const composer = page.getByTestId("composer");
    await expect(composer.getByRole("button", { name: /^Model: Mock 1/ })).toBeVisible();
    const box = page.getByLabel("Message to Pi");
    await box.click();
    await page.keyboard.type("/fix");
    await expect(
      page
        .getByRole("listbox", { name: "Commands" })
        .getByRole("option", { name: /fixture-hello/ }),
    ).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(box).toHaveValue("/fixture-hello ");
    await box.fill("");
    await page.keyboard.type("/mo");
    await expect(
      page.getByRole("listbox", { name: "Commands" }).getByRole("option", { name: /^\/model/ }),
    ).toBeVisible();
    await expect(composer.getByRole("button", { name: /^Context/ })).toBeVisible();
  });

  test("review comments are batched into one follow-up", async ({ page, state, api }, info) => {
    const id = await createSession(api, state, `Review ${uid(info)}`, "hello review");
    const prompts = promptRequests(page, id);
    await page.goto(`/code/${id}`);
    await openInspector(page, viewportOf(info) === "compact");
    const inspector = page.getByTestId("inspector");
    await inspector.getByRole("button", { name: /docs\/guide\.md/ }).click();

    const addComment = async (line: number, text: string) => {
      await inspector.getByRole("button", { name: `Comment on line ${line}` }).click();
      const dialog = page.getByRole("dialog", { name: "Add review comment" });
      await dialog.getByRole("textbox").fill(text);
      await dialog.getByRole("button", { name: "Add comment" }).click();
      await expect(dialog).toHaveCount(0);
    };
    await addComment(3, "Say more on the first line");
    await addComment(4, "Drop the second line");
    await expect(inspector.getByRole("heading", { name: "Review comments (2)" })).toBeVisible();
    expect(prompts).toHaveLength(0);

    await inspector.getByRole("button", { name: "Send as one follow-up" }).click();
    await expect(page.getByText("Review comments sent as one follow-up.")).toBeVisible();
    await expect(
      inspector.getByRole("heading", { name: "Review comments", exact: true }),
    ).toBeVisible();
    expect(prompts).toHaveLength(1);
    const text: string = prompts[0]!.postDataJSON().text;
    expect(text).toContain("docs/guide.md:3");
    expect(text).toContain("Say more on the first line");
    expect(text).toContain("docs/guide.md:4");
    expect(text).toContain("Drop the second line");
    await page.waitForTimeout(500);
    expect(prompts).toHaveLength(1);
  });

  test("long diff lines keep the line numbers visible", async ({ page, state }, info) => {
    await page.goto(`/code/${state.sessions.long}`);
    await openInspector(page, viewportOf(info) === "compact");
    const inspector = page.getByTestId("inspector");
    await inspector.getByRole("button", { name: /src\/wide\.ts/ }).click();
    const diff = inspector.getByRole("region", { name: "Diff of src/wide.ts" });
    const scroller = diff.locator(".overflow-x-auto");
    await expect(scroller).toBeVisible();
    expect(await scroller.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    // Clicking the long line opens the comment form without scrolling sideways.
    await diff.getByRole("button", { name: "Comment on line 2" }).click();
    const dialog = page.getByRole("dialog", { name: "Add review comment" });
    await expect(dialog).toBeVisible();
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(0);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    // Scrolled sideways, the gutter stays pinned inside the scroller.
    await scroller.evaluate((el) => {
      el.scrollLeft = 300;
    });
    const row = diff.locator("tr", {
      has: page.getByRole("button", { name: "Comment on line 2" }),
    });
    const gutter = row.locator("td").first();
    const sBox = (await scroller.boundingBox())!;
    const gBox = (await gutter.boundingBox())!;
    expect(gBox.x).toBeGreaterThanOrEqual(sBox.x - 1);
    await expect(gutter).toContainText("2");
  });

  test("keyboard-only navigation through the navigator", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const nav = page.getByTestId("navigator");
    await expect(nav.getByRole("link", { name: /Question session/ })).toBeVisible();
    await nav.getByLabel("Search sessions").focus();

    const tabTo = async (pred: string, max = 80) => {
      for (let i = 0; i < max; i++) {
        await page.keyboard.press("Tab");
        const hit = await page.evaluate(
          (p) => (document.activeElement?.textContent ?? "").includes(p),
          pred,
        );
        if (hit) return;
      }
      throw new Error(`Tab never reached "${pred}"`);
    };

    // A project group toggles with the keyboard.
    await tabTo("Demo project");
    const project = nav.getByRole("button", { name: /Demo project/ });
    await expect(project).toBeFocused();
    await expect(project).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Enter");
    await expect(project).toHaveAttribute("aria-expanded", "false");
    await expect(nav.getByRole("link", { name: /Question session/ })).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(project).toHaveAttribute("aria-expanded", "true");

    // Tab to a session row and open it with Enter.
    await tabTo("Question session");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/code/${state.sessions.question}$`));
    await expect(
      page.getByTestId("conversation").getByRole("heading", { name: "Question session" }),
    ).toBeVisible();
    await expect(nav.getByRole("link", { name: /Question session/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  test("navigator layouts switch and persist", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const nav = page.getByTestId("navigator");
    const projectBtn = nav.getByRole("button", { name: /Demo project/ });
    await expect(projectBtn).toBeVisible();

    await nav.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemradio", { name: /Recent/ }).click();
    await expect(projectBtn).toHaveCount(0);
    await expect(nav.getByRole("list", { name: "Recent sessions" })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Question session/ })).toBeVisible();

    await page.reload();
    await expect(nav.getByRole("list", { name: "Recent sessions" })).toBeVisible();

    await nav.getByRole("button", { name: "View options" }).click();
    await expect(page.getByRole("menuitemradio", { name: /Recent/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("menuitemradio", { name: /Projects/ }).click();
    await expect(projectBtn).toBeVisible();
  });

  test("Review changes on the board opens the Changes tab", async ({ page, state }, info) => {
    const compact = viewportOf(info) === "compact";
    await page.goto(`/code/${state.sessions.long}`);
    if (!compact) {
      await page.getByTestId("inspector").getByRole("tab", { name: /Files/ }).click();
      await page.getByRole("button", { name: "Hide inspector" }).click();
      await expect(page.getByTestId("inspector")).toHaveCount(0);
    }
    await page.goto(`/tasks/${state.tasks.review}`);
    const drawer = page.getByRole("dialog", { name: "Review the greeting copy" });
    await drawer.getByRole("link", { name: "Review changes" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/code/${state.reviewSessionId}\\?tab=changes`));
    const inspector = page.getByTestId("inspector");
    await expect(inspector).toBeVisible();
    await expect(inspector.getByRole("tab", { name: /Changes/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
