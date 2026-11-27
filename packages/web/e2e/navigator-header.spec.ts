import type { Page } from "@playwright/test";
import { expect, poll, test, uid, viewportOf } from "./support";

/** Rewrite what the client socket receives with a JSON reviver, then `after` on the message. */
async function rewriteSync(
  page: Page,
  reviver: (key: string, value: any) => any,
  after: (message: any) => any = (m) => m,
) {
  await page.routeWebSocket("**/ws/client", (ws) => {
    const server = ws.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== "string") return ws.send(message);
      try {
        ws.send(JSON.stringify(after(JSON.parse(message, reviver))));
      } catch {
        ws.send(message);
      }
    });
  });
}

/**
 * Pretend Pi of session `id` runs in a herdr session the user started by hand: the browser test
 * stack has no hand-started Pi, so the client socket marks the session as one.
 */
async function startedByHand(page: Page, id: string, client: string) {
  await rewriteSync(page, (_key, value) =>
    value && typeof value === "object" && value.id === id && "runtime" in value
      ? { ...value, external: { client } }
      : value,
  );
}

/**
 * Header controls that overlap one another, leave the header, or clip their own text. Nested
 * elements (a count inside its radio) are not compared.
 */
async function headerProblems(page: Page): Promise<string[]> {
  return page.getByTestId("navigator-header").evaluate((root) => {
    const box = root.getBoundingClientRect();
    const name = (e: Element) =>
      `${e.tagName.toLowerCase()}[${(e.getAttribute("aria-label") ?? e.textContent ?? "").trim().slice(0, 30)}]`;
    const els = [
      ...root.querySelectorAll(
        "h2, button, select, label, input, [data-testid^='filter-count'], [data-testid='where-chip'] > span",
      ),
    ].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const out: string[] = [];
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5)
        out.push(`${name(e)} leaves the header`);
      const truncates = getComputedStyle(e).textOverflow === "ellipsis" || e.tagName === "SELECT";
      if (!truncates && e.scrollWidth > e.clientWidth + 1) out.push(`${name(e)} clips its text`);
    }
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i]!;
        const b = els[j]!;
        if (a.contains(b) || b.contains(a)) continue;
        const p = a.getBoundingClientRect();
        const q = b.getBoundingClientRect();
        const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (w > 0.5 && h > 0.5) out.push(`${name(a)} overlaps ${name(b)}`);
      }
    }
    return out;
  });
}

async function chooseLayout(page: Page, name: RegExp) {
  await page.getByTestId("navigator").getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitemradio", { name }).click();
}

test.describe("Sessions navigator header", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("quiet filter rows above the first session; one action clears every filter", async ({
    page,
    api,
  }, info) => {
    const phone = viewportOf(info) === "mobile";
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    const row = nav.getByTestId("session-row").first();
    await expect(row).toBeVisible();

    // Height above the first session row: 255 px at 1440x900 and 281 px at 390x844 before.
    const top = (await nav.boundingBox())!.y;
    const offset = Math.round((await row.boundingBox())!.y - top);
    info.annotations.push({ type: "header-height", description: `${offset}px` });
    expect(offset).toBeLessThan(phone ? 175 : 255);

    const header = nav.getByTestId("navigator-header");
    await expect(header.getByLabel("Scope", { exact: true })).toHaveValue("");
    await expect(nav.getByTestId("scope-chip")).not.toHaveAttribute("data-active", "true");
    await expect(nav.getByTestId("where-chip")).toHaveCount(0);
    await expect(nav.getByTestId("clear-filters")).toHaveCount(0);
    // The status summary is folded into the filter: each option counts the rows it lists.
    await expect(nav.getByTestId("status-summary")).toHaveCount(0);
    await expect(nav.getByTestId("filter-count-active")).toHaveText(/^\d+$/);
    // The seeded question needs input: the phone has a Needs input filter, the desktop a jump.
    if (phone) {
      await expect(nav.getByTestId("filter-count-attention")).not.toHaveText("0");
      await expect(nav.getByTestId("needs-input-jump")).toHaveCount(0);
      await expect(nav.getByTestId("filter-count-all")).toHaveText(/^\d+$/);
      await expect(nav.getByTestId("phone-session-filters")).toBeVisible();
      await expect(header.getByRole("heading", { name: "Sessions" })).toBeVisible();
      await expect(header.getByRole("button", { name: "New session" })).toBeVisible();
      const headingBox = (await header.getByRole("heading", { name: "Sessions" }).boundingBox())!;
      const filtersBox = (await nav.getByTestId("phone-session-filters").boundingBox())!;
      expect(filtersBox.y).toBeGreaterThan(headingBox.y);
      await expect(nav.getByTestId("recent-section").first()).toBeVisible();
      await expect(nav.getByTestId("filter-count-active")).toHaveText(
        String(await nav.getByTestId("session-row").count()),
      );
    } else {
      await expect(nav.getByTestId("needs-input-jump")).toBeVisible();
    }

    const search = header.getByLabel("Search sessions", { exact: true });
    if (phone) {
      // Search collapses to an icon on the phone.
      await expect(header.getByRole("searchbox")).toHaveCount(0);
      await nav.getByTestId("toggle-search").tap();
    }
    await header.getByRole("searchbox", { name: "Search sessions" }).fill("Long transcript");
    await expect(nav.getByTestId("session-row")).toHaveCount(1);
    await expect(nav.getByTestId("filter-count-active")).toHaveText("1");
    // One filter clears on its own; Clear appears once two are set.
    await expect(nav.getByTestId("clear-filters")).toHaveCount(0);

    // A selected view is highlighted with its own clear.
    const v = await api("POST", "/api/scopes", { name: `chip-${uid(info)}`, mode: "pinned" });
    await header.getByLabel("Scope", { exact: true }).selectOption(v.id);
    await expect(nav.getByTestId("scope-chip")).toHaveAttribute("data-active", "true");
    if (phone) {
      await expect(nav.getByRole("button", { name: "Clear scope" })).toHaveCount(0);
      await expect(nav.getByRole("button", { name: "Edit scope" })).toHaveCount(0);
      await header.getByLabel("Scope", { exact: true }).selectOption("__edit");
      await expect(page.getByRole("dialog", { name: "Edit scope" })).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      await expect(nav.getByRole("button", { name: "Clear scope" })).toBeVisible();
      await expect(nav.getByRole("button", { name: "Edit scope" })).toBeVisible();
    }
    await nav.getByTestId("clear-filters").click();
    await expect(nav.getByTestId("clear-filters")).toHaveCount(0);
    await expect(header.getByLabel("Scope", { exact: true })).toHaveValue("");
    await expect(nav.getByTestId("scope-chip")).not.toHaveAttribute("data-active", "true");
    if (phone) await expect(header.getByRole("searchbox")).toHaveCount(0);
    else await expect(search).toHaveValue("");
    await header.getByLabel("Scope", { exact: true }).selectOption(v.id);
    if (phone) {
      await header.getByLabel("Scope", { exact: true }).selectOption("");
      await header.getByLabel("Scope", { exact: true }).selectOption("__new");
      await expect(page.getByRole("dialog", { name: "New scope" })).toBeVisible();
      await page.keyboard.press("Escape");
    } else {
      await nav.getByRole("button", { name: "Clear scope" }).click();
    }
    await expect(header.getByLabel("Scope", { exact: true })).toHaveValue("");
    await api("DELETE", `/api/scopes/${v.id}`);
  });

  test("rows say which terminal a hand-started Pi runs in; Where groups and filters by it", async ({
    page,
    state,
  }, info) => {
    const phone = viewportOf(info) === "mobile";
    await startedByHand(page, state.sessions.long, "herdr:default@mac-pro");
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    const long = nav.getByTestId("session-row").filter({ hasText: "Long transcript session" });
    // Labelled through the host's Switchyard name, not the machine's.
    if (phone) {
      await expect(long.getByTestId("row-where")).toHaveCount(0);
      await nav.getByRole("button", { name: "View options" }).click();
      await page.getByRole("menuitemcheckbox", { name: "Show session details" }).click();
    }
    await expect(long.getByTestId("row-where")).toHaveText(`herdr default on ${state.hostName}`);

    await chooseLayout(page, /^Where/);
    if (phone) await expect(long.getByTestId("row-where")).toHaveCount(0);
    await expect(nav.getByRole("list", { name: "Where" })).toBeVisible();
    await expect(nav.getByRole("button", { name: new RegExp(`^${state.hostName}`) })).toBeVisible();
    await expect(nav.getByRole("button", { name: /^herdr default/ })).toBeVisible();
    await expect(nav.getByRole("button", { name: /^Switchyard/ })).toBeVisible();

    await nav.getByRole("button", { name: "Only herdr default" }).click();
    await expect(nav.getByTestId("clear-filters")).toHaveCount(0);
    await expect(nav.getByTestId("where-chip")).toContainText(`herdr default on ${state.hostName}`);
    await expect(nav.getByTestId("session-row")).toHaveCount(1);
    await expect(nav.getByTestId("filter-count-active")).toHaveText("1");

    // A new session is held by Switchyard, so it is not listed under that terminal.
    await nav.getByTestId("new-session").click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await expect(dialog.getByTestId("new-session-where")).toContainText("Switchyard holds");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    if (!phone) {
      // The open session outside Where keeps its row, marked with the reason.
      await page.goto(`/code/${state.sessions.question}`);
      await expect(nav.getByTestId("row-outside")).toHaveText(
        `Not in herdr default on ${state.hostName}`,
      );
      await expect(nav.getByTestId("row-outside")).toHaveAttribute("data-reason", "where");
    }

    await nav.getByRole("button", { name: "Clear Where" }).click();
    await expect(nav.getByTestId("where-chip")).toHaveCount(0);
    await chooseLayout(page, phone ? /^Recent(?! activity)/ : /^Projects/);
  });

  test("nothing overlaps or clips at narrow widths, with a view and Where set", async ({
    page,
    api,
    state,
  }, info) => {
    const phone = viewportOf(info) === "mobile";
    const v = await api("POST", "/api/scopes", {
      name: `A rather long view name ${uid(info)}`,
      mode: "all",
    });
    await startedByHand(page, state.sessions.long, "herdr:a-long-terminal-name@mac-pro");
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    await expect(nav.getByTestId("session-row").first()).toBeVisible();
    const sep = page.getByRole("separator", { name: "Resize navigator" });
    // The navigator's minimum, and its default.
    const widths = phone ? [360, 390] : ["Home", "Enter"];
    for (const key of widths) {
      if (typeof key === "number") {
        await page.setViewportSize({ width: key, height: 844 });
      } else {
        await sep.focus();
        await page.keyboard.press(key);
      }
      expect(await headerProblems(page)).toEqual([]);
      await nav.getByLabel("Scope", { exact: true }).selectOption(v.id);
      expect(await headerProblems(page)).toEqual([]);
      await chooseLayout(page, /^Where/);
      await nav.getByRole("button", { name: "Only herdr a-long-terminal-name" }).click();
      await expect(nav.getByTestId("where-chip")).toBeVisible();
      expect(await headerProblems(page)).toEqual([]);
      await nav.getByTestId("clear-filters").click();
      await expect(nav.getByTestId("where-chip")).toHaveCount(0);
      await chooseLayout(page, phone ? /^Recent(?! activity)/ : /^Projects/);
    }
    await api("DELETE", `/api/scopes/${v.id}`);
  });

  test("phone rows expose branch details without crowding the title", async ({
    page,
    api,
    state,
  }, info) => {
    test.skip(viewportOf(info) !== "mobile", "Phone list only");
    const branch = `phone-${uid(info)}`;
    const title = `A long primary session title that wraps onto two lines ${branch}`;
    const first = await api("POST", "/api/branches/open", {
      projectId: state.projectId,
      branch,
      title,
    });
    await poll("the phone branch worktree", async () => {
      const session = await api("GET", `/api/sessions/${first.session.id}`);
      return session.workspaceId && session.runtime === "idle";
    });
    await api("POST", "/api/branches/open", {
      projectId: state.projectId,
      branch,
      title: `Extra ${branch}`,
      another: true,
    });
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    const row = nav.getByTestId("session-row").filter({ hasText: title });
    const disclosure = row.locator("xpath=..").getByTestId("row-others");
    await expect(row).toBeVisible();
    await expect(row.getByTestId("row-annotations")).toHaveCount(0);
    await expect(disclosure).toHaveAccessibleName("1 more session in this branch");
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        const titleBox = (await row.getByTestId("mobile-session-title").boundingBox())!;
        const timeBox = (await row.locator("xpath=..").getByTestId("row-activity").boundingBox())!;
        const disclosureBox = (await disclosure.boundingBox())!;
        const lineHeight = await row
          .getByTestId("mobile-session-title")
          .evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
        expect(titleBox.height).toBeGreaterThan(lineHeight * 1.5);
        expect(titleBox.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
        expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(timeBox.x + 1);
        expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(disclosureBox.x + 1);
      }
    }
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(
      nav.getByTestId("session-subrow").filter({ hasText: `Extra ${branch}` }),
    ).toBeVisible();
    await disclosure.click();
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/code/${first.session.id}$`));
  });

  test("phone keeps an urgent preview without session details", async ({ page, state }, info) => {
    test.skip(viewportOf(info) !== "mobile", "Phone list only");
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    const question = nav
      .locator(`[data-testid="session-row"], [data-testid="session-subrow"]`)
      .filter({ hasText: "Question session" });
    await expect(question).toBeVisible();
    await expect(question.getByTestId("row-preview")).not.toBeEmpty();
    await expect(question.getByTestId("row-where")).toHaveCount(0);
    await expect(question).toHaveAttribute("href", `/code/${state.sessions.question}`);
  });

  test("with no projects, Pi history suggestions are one line linking to Settings", async ({
    page,
  }, info) => {
    const phone = viewportOf(info) === "mobile";
    // No projects, even when other tests add some meanwhile: their updates become deletions.
    const noProject = (e: any) =>
      e?.type === "project.updated"
        ? { ...e, type: "project.deleted", data: { id: e.data.id } }
        : e;
    await rewriteSync(
      page,
      (key, value) => (key === "projects" && Array.isArray(value) ? [] : value),
      (m) =>
        m.type === "event"
          ? { ...m, event: noProject(m.event) }
          : m.type === "replay"
            ? { ...m, events: m.events.map(noProject) }
            : m,
    );
    await page.route("**/api/hosts/*/project-suggestions", (route) =>
      route.fulfill({
        json: {
          suggestions: Array.from({ length: 7 }, (_, i) => ({
            rootPath: `/Users/someone/Projects/a-repository-with-a-long-name-${i}`,
            name: `repo-${i}`,
            sessionCount: 10 + i,
            lastActivityAt: new Date().toISOString(),
            preselected: true,
          })),
        },
      }),
    );
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    await expect(nav.getByText("Add a project", { exact: true }).first()).toBeVisible();
    const line = nav.getByTestId("project-suggestions-line");
    await expect(line).toContainText("7 repositories found in your Pi history");
    await expect(nav.getByTestId("project-suggestions")).toHaveCount(0);
    await expect(nav.getByTestId("new-session")).toBeDisabled();
    // Nothing to filter yet: no search, filters or status.
    await expect(nav.getByTestId("navigator-filters")).toHaveCount(0);
    await expect(nav.getByRole("radiogroup", { name: "Session filter" })).toHaveCount(0);
    if (!phone) {
      const sep = page.getByRole("separator", { name: "Resize navigator" });
      await sep.focus();
      await page.keyboard.press("Home");
    }
    expect(await headerProblems(page)).toEqual([]);
    const lineBox = (await line.boundingBox())!;
    const navBox = (await nav.boundingBox())!;
    expect(lineBox.x + lineBox.width).toBeLessThanOrEqual(navBox.x + navBox.width);
    await line.getByRole("link", { name: "Review" }).click();
    await expect(page).toHaveURL(/\/settings\/projects/);
    // The full list is in Settings, its paths wrapping inside the card.
    const card = page.getByTestId("project-suggestions");
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });
});
