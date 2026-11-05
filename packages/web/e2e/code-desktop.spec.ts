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
    const max = viewportOf(info) === "compact" ? 300 : 360;
    await page.goto(`/code/${state.sessions.long}`);
    await expect(page.getByTestId("conversation")).toBeVisible();
    const sep = page.getByRole("separator", { name: "Resize navigator" });
    expect(await width(page, "navigator")).toBe(264);
    await expect(sep).toHaveAttribute("aria-valuenow", "264");

    await dragBy(page, "Resize navigator", 500);
    expect(await width(page, "navigator")).toBe(max);
    await expect(sep).toHaveAttribute("aria-valuenow", String(max));

    await dragBy(page, "Resize navigator", -500);
    expect(await width(page, "navigator")).toBe(220);

    // Keyboard equivalents: End/Home clamp, Enter resets.
    await sep.focus();
    await page.keyboard.press("End");
    await expect(sep).toHaveAttribute("aria-valuenow", String(max));
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

  test("the status bar's Answer opens the first question", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.question}`);
    const strip = page.locator('[data-testid="session-status"][data-kind="answer"]');
    await expect(strip).toContainText("Needs input: Pick a fruit");
    // While waiting for input, Stop is the secondary action.
    const stop = page.getByTestId("conversation").getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    await expect(stop).not.toHaveClass(/bg-danger/);
    // Scroll the question away, then use the status bar.
    await page.getByTestId("transcript").evaluate((el) => {
      el.scrollTop = 0;
    });
    await strip.getByRole("button", { name: "Answer" }).click();
    const card = page.getByTestId("interaction-card").first();
    await expect(card).toBeInViewport();
    const focusedIn = await page.evaluate(
      () => document.activeElement?.closest('[data-testid="interaction-card"]') !== null,
    );
    expect(focusedIn).toBe(true);
    await expect(card.getByRole("radio", { name: "Apple" })).toBeVisible();
  });

  test("archived session: one status bar, Unarchive, then Resume", async ({
    page,
    state,
    api,
  }, info) => {
    const id = await createSession(api, state, `Archived ${uid(info)}`, "hello");
    await page.goto(`/code/${id}`);
    const conversation = page.getByTestId("conversation");
    await expect(page.getByTestId("transcript")).toBeVisible();
    // An archived session is not in the snapshot, so archive it while it is open.
    await api("POST", `/api/sessions/${id}/archive`);
    const bar = page.getByTestId("session-status");
    await expect(bar).toHaveAttribute("data-kind", "archived");
    await expect(bar).toContainText("This session is archived. Unarchive it to send messages.");
    await expect(conversation.getByRole("button", { name: "Resume" })).toHaveCount(0);
    await bar.getByRole("button", { name: "Unarchive" }).click();
    await expect(page.getByText("Session unarchived.")).toBeVisible();
    await expect(bar).toHaveAttribute("data-kind", "stopped");
    await expect(conversation.getByRole("button", { name: "Resume" })).toHaveCount(1);
    await expect(conversation.getByRole("button", { name: "Stop" })).toHaveCount(0);
    await page.getByRole("button", { name: "Session menu" }).click();
    await expect(page.getByRole("menuitem", { name: /Session info/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^Archive/ })).toBeVisible();
  });

  test("notices are compact rows", async ({ page, state, api }, info) => {
    const id = await createSession(api, state, `Notice ${uid(info)}`, "hello");
    await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-hello" });
    await page.goto(`/code/${id}`);
    const notice = page
      .getByTestId("transcript")
      .getByTestId("notice")
      .filter({ hasText: "fixture hello" });
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute("data-level", "info");
    const box = (await notice.boundingBox())!;
    expect(box.height).toBeLessThan(28);
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

  test("model popover and slash picker list every command", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const composer = page.getByTestId("composer");
    const modelButton = composer.getByRole("button", { name: /^Model: Mock 1/ });
    await expect(modelButton).toBeVisible();
    await modelButton.click();
    const dialog = page.getByRole("dialog", { name: "Model" });
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("Search models")).toBeFocused();
    await page.keyboard.type("2");
    await expect(dialog.getByRole("button", { name: /Mock 2/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Mock 1/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(modelButton).toBeFocused();

    const box = page.getByLabel("Message to Pi");
    await box.click();
    await page.keyboard.type("/fix");
    const list = page.getByRole("listbox", { name: "Commands" });
    await expect(list.getByRole("option", { name: /fixture-hello/ })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(box).toHaveValue("/fixture-hello ");
    await box.fill("/sett");
    const settings = list.getByRole("option", { name: /^\/settings/ });
    await expect(settings).toBeVisible();
    await expect(settings).toContainText("Terminal only");
    await box.fill("/tr");
    await expect(list.getByRole("option", { name: /^\/tree/ })).toContainText("Switchyard");
    await box.fill("");
    await expect(composer.getByRole("button", { name: /^Context/ })).toBeVisible();
    await expect(box).toHaveAttribute("placeholder", "Message Pi… (/ for commands)");
  });

  test("Commands button starts a command only in an empty draft", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const composer = page.getByTestId("composer");
    const box = page.getByLabel("Message to Pi");
    await box.fill("");
    await composer.getByRole("button", { name: "Commands" }).click();
    await expect(box).toHaveValue("/");
    await expect(page.getByRole("listbox", { name: "Commands" })).toBeVisible();
    await box.fill("keep this text");
    await composer.getByRole("button", { name: "Commands" }).click();
    await expect(box).toHaveValue("keep this text");
    await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
    await page
      .getByRole("dialog", { name: "Commands" })
      .getByRole("button", { name: "Close" })
      .click();
    await expect(page.getByRole("dialog", { name: "Commands" })).toHaveCount(0);
    await box.fill("");
  });

  test("effort slider on a reasoning model", async ({ page, state, api }, info) => {
    const id = await createSession(api, state, `Effort ${uid(info)}`, "hello there");
    await page.goto(`/code/${id}`);
    const composer = page.getByTestId("composer");
    await composer.getByRole("button", { name: /^Model: / }).click();
    await page
      .getByRole("dialog", { name: "Model" })
      .getByRole("button", { name: /Mock 2/ })
      .click();
    const effort = composer.getByRole("button", { name: /^Effort: / });
    await expect(effort).toBeVisible();
    await effort.click();
    const slider = page
      .getByRole("dialog", { name: "Effort" })
      .getByRole("slider", { name: "Effort" });
    await expect(slider).toBeVisible();
    const sent = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith(`/api/sessions/${id}/thinking`),
    );
    await slider.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowRight");
    const outline = await page
      .locator('[data-effort-dot="selected"]')
      .evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");
    await page.keyboard.press("End");
    expect((await sent).postDataJSON().level).toBe("high");
    await expect(composer.getByRole("button", { name: "Effort: high" })).toBeVisible();
  });

  test("Files: tree, highlighted preview and markdown", async ({ page, state }, info) => {
    test.skip(viewportOf(info) !== "desktop", "Desktop only");
    await page.goto(`/code/${state.sessions.long}`);
    const inspector = page.getByTestId("inspector");
    await inspector.getByRole("tab", { name: /Files/ }).click();
    const tree = inspector.getByRole("tree", { name: "Workspace files" });
    const src = tree.getByRole("treeitem", { name: /^src/ });
    await expect(src.getByTitle("Contains changes")).toBeVisible();
    await src.click();
    const wide = tree.getByRole("treeitem", { name: /wide\.ts/ });
    await expect(wide.getByTitle(/Added|Modified|Untracked/)).toBeVisible();
    await wide.click();
    await expect(inspector.getByRole("heading", { name: "wide.ts" })).toBeVisible();
    const code = inspector.getByRole("region", { name: "File contents" });
    await expect(code).toBeVisible();
    await expect(code).toContainText("export const short = 1;");
    await expect
      .poll(() => code.locator(".sy-code span[style], span[style]").count())
      .toBeGreaterThan(0);
    await inspector.getByRole("button", { name: "Wrap lines" }).click();
    await expect(inspector.getByRole("button", { name: "Don't wrap lines" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await inspector.getByRole("button", { name: "Back to files" }).click();
    await tree.getByRole("treeitem", { name: /^docs/ }).click();
    await tree.getByRole("treeitem", { name: /guide\.md/ }).click();
    await expect(inspector.getByRole("heading", { name: "Guide" })).toBeVisible();
    await inspector.getByRole("radio", { name: "Source" }).click();
    await expect(inspector.getByRole("region", { name: "File contents" })).toBeVisible();
  });

  test("inspector tabs keep their state and share one diff", async ({ page, state }, info) => {
    test.skip(viewportOf(info) !== "desktop", "Desktop only");
    const diffs: string[] = [];
    page.on("request", (r) => {
      const u = new URL(r.url());
      if (r.method() === "GET" && u.pathname.endsWith("/diff") && !u.searchParams.has("file")) {
        diffs.push(r.url());
      }
    });
    await page.goto(`/code/${state.sessions.long}`);
    const inspector = page.getByTestId("inspector");
    await inspector.getByRole("tab", { name: /Files/ }).click();
    const tree = inspector.getByRole("tree", { name: "Workspace files" });
    await tree.getByRole("treeitem", { name: /^src/ }).click();
    await tree.getByRole("treeitem", { name: /wide\.ts/ }).click();
    await expect(inspector.getByRole("heading", { name: "wide.ts" })).toBeVisible();
    await inspector.getByRole("tab", { name: /Changes/ }).click();
    await inspector.getByRole("tab", { name: /Files/ }).click();
    await expect(inspector.getByRole("heading", { name: "wide.ts" })).toBeVisible();
    expect(diffs).toHaveLength(1);
  });

  test("review comments are batched into one follow-up", async ({ page, state, api }, info) => {
    const id = await createSession(api, state, `Review ${uid(info)}`, "hello review");
    const prompts = promptRequests(page, id);
    await page.goto(`/code/${id}`);
    await openInspector(page, viewportOf(info) === "compact");
    const inspector = page.getByTestId("inspector");
    await inspector.getByRole("button", { name: /docs\/guide\.md/ }).click();
    await expect(inspector.getByRole("button", { name: "Send as one follow-up" })).toHaveCount(0);

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
    await expect(inspector.getByRole("region", { name: "Review" })).toHaveCount(0);
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
    const project = nav.getByRole("button", { name: /^Demo project/ });
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
    const projectBtn = nav.getByRole("button", { name: /^Demo project/ });
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

  test("New session starts from a prompt in the main checkout", async ({ page, state }, info) => {
    await page.goto("/code");
    await page.getByTestId("new-session").click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    const prompt = dialog.getByLabel("What should Pi do?");
    await expect(prompt).toBeFocused();
    await expect(dialog.getByLabel("Workspace")).toHaveValue(state.workspaceId);
    await expect(dialog.getByTestId("new-session-summary")).toContainText("e2e-host");
    const text = `Say hello ${uid(info)}`;
    await prompt.fill(text);
    const req = page.waitForRequest(
      (r) => r.method() === "POST" && r.url().endsWith("/api/sessions"),
    );
    await page.keyboard.press("ControlOrMeta+Enter");
    const body = (await req).postDataJSON();
    expect(body.workspace).toEqual({ existingId: state.workspaceId });
    expect(body.prompt).toBe(text);
    await expect(page).toHaveURL(/\/code\/ses_/);
    await expect(page.getByTestId("transcript").getByText(`Received: ${text}`)).toBeVisible({
      timeout: 30_000,
    });
  });

  test("New worktree suggests a branch from the prompt", async ({ page }) => {
    await page.goto("/code");
    await page.getByTestId("new-session").click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await dialog.getByLabel("What should Pi do?").fill("Fix the login retry bug now please");
    await dialog.getByLabel("Workspace").selectOption({ label: "New worktree…" });
    const branch = dialog.getByLabel("Branch", { exact: true });
    await expect(branch).toHaveValue(/^fix-the-login-retry-bug(-\d+)?$/);
    await expect(dialog.getByTestId("new-session-summary")).toContainText(
      "New worktree fix-the-login-retry-bug",
    );
    await branch.fill("bad branch");
    await expect(dialog.getByRole("status")).toContainText("Branch names cannot contain spaces.");
    await expect(dialog.getByRole("button", { name: "Create session" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Use suggested name" }).click();
    await expect(dialog.getByRole("button", { name: "Create session" })).toBeEnabled();
    await page.keyboard.press("Escape");
  });

  test("New session from a project group preselects the project", async ({ page, state }) => {
    await page.goto(`/code/${state.sessions.long}`);
    const nav = page.getByTestId("navigator");
    await nav.getByRole("button", { name: /^Demo project/ }).hover();
    await nav.getByRole("button", { name: "New session in Demo project" }).click();
    await expect(
      page.getByRole("dialog", { name: "New session" }).getByLabel("Project"),
    ).toHaveValue(state.projectId);
  });
});
