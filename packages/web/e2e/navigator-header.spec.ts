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

async function chooseGroup(page: Page, name: RegExp) {
  await page.getByTestId("navigator").getByRole("button", { name: "View options" }).click();
  // Group choices precede the sort choices, which also include Status.
  await page.getByRole("menuitemradio", { name }).first().click();
}

async function filterLocation(page: Page, label: string) {
  await page.getByTestId("navigator").getByRole("button", { name: "View options" }).click();
  await page.getByRole("menuitem", { name: "Filter by run location…" }).click();
  const dialog = page.getByRole("dialog", { name: "Filter by run location" });
  await dialog.getByLabel("Run location").selectOption({ label });
  await expect(dialog).toHaveCount(0);
}

test.describe("Sessions navigator header", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("quiet filter rows above the first session; one action clears every filter", async ({
    page,
    api,
    state,
  }, info) => {
    const phone = viewportOf(info) === "mobile";
    await page.goto(phone ? "/code" : `/code/${state.sessions.long}`);
    const nav = page.getByTestId("navigator");
    const row = nav.getByTestId("session-row").first();
    await expect(row).toBeVisible();

    // Height above the first session row: 255 px at 1440x900 and 281 px at 390x844 before.
    const top = (await nav.boundingBox())!.y;
    const offset = Math.round((await row.boundingBox())!.y - top);
    info.annotations.push({
      type: "header-height",
      description: `${offset}px`,
    });
    expect(offset).toBeLessThan(phone ? 175 : 255);

    const header = nav.getByTestId("navigator-header");
    await expect(header.getByLabel("Scope", { exact: true })).toHaveValue("");
    await expect(nav.getByTestId("scope-chip")).not.toHaveAttribute("data-active", "true");
    await expect(nav.getByTestId("where-chip")).toHaveCount(0);
    await expect(nav.getByTestId("clear-filters")).toHaveCount(0);
    // The status summary is folded into the filter: each option counts the rows it lists.
    await expect(nav.getByTestId("status-summary")).toHaveCount(0);
    await expect(nav.getByTestId("filter-count-active")).toHaveText(/^\d+$/);
    await expect(nav.getByTestId("filter-count-attention")).not.toHaveText("0");
    await expect(nav.getByTestId("filter-count-all")).toHaveText(/^\d+$/);
    await expect(nav.getByTestId("session-filters")).toBeVisible();
    await expect(header.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(header.getByRole("button", { name: "New session" })).toBeVisible();
    const headingBox = (await header.getByRole("heading", { name: "Sessions" }).boundingBox())!;
    const filtersBox = (await nav.getByTestId("session-filters").boundingBox())!;
    expect(filtersBox.y).toBeGreaterThan(headingBox.y);
    await expect(nav.getByRole("list", { name: "Sessions" })).toBeVisible();
    const filters = nav.getByRole("radiogroup", { name: "Session filter" });
    const active = filters.getByRole("radio", { name: /^Active/ });
    const attention = filters.getByRole("radio", { name: /^Needs input/ });
    await expect(active).toBeChecked();
    await active.focus();
    await page.keyboard.press("ArrowRight");
    await expect(attention).toBeChecked();
    await page.keyboard.press("ArrowLeft");
    await expect(active).toBeChecked();
    await nav.getByRole("button", { name: "View options" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Open latest session needing input" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const search = header.getByLabel("Search sessions", { exact: true });
    if (phone) {
      // Search collapses to an icon on the phone.
      await expect(header.getByRole("searchbox")).toHaveCount(0);
      await nav.getByTestId("toggle-search").tap();
    }
    if (!phone) {
      await page.keyboard.press("/");
      await expect(search).toBeFocused();
    }
    await header.getByRole("searchbox", { name: "Search sessions" }).fill("Long transcript");
    await expect(nav.getByTestId("session-row")).toHaveCount(1);
    await expect(nav.getByTestId("filter-count-active")).toHaveText("1");
    // One filter clears on its own; Clear appears once two are set.
    await expect(nav.getByTestId("clear-filters")).toHaveCount(0);

    // A selected view is highlighted with its own clear.
    const v = await api("POST", "/api/scopes", {
      name: `chip-${uid(info)}`,
      mode: "pinned",
    });
    await header.getByLabel("Scope", { exact: true }).selectOption(v.id);
    await expect(nav.getByTestId("scope-chip")).toHaveAttribute("data-active", "true");
    await expect(nav.getByRole("button", { name: "Edit scope" })).toHaveCount(0);
    await header.getByLabel("Scope", { exact: true }).selectOption("__edit");
    await expect(page.getByRole("dialog", { name: "Edit scope" })).toBeVisible();
    await page.keyboard.press("Escape");
    await nav.getByTestId("clear-filters").click();
    await expect(nav.getByTestId("clear-filters")).toHaveCount(0);
    await expect(header.getByLabel("Scope", { exact: true })).toHaveValue("");
    await expect(nav.getByTestId("scope-chip")).not.toHaveAttribute("data-active", "true");
    if (phone) await expect(header.getByRole("searchbox")).toHaveCount(0);
    else await expect(search).toHaveValue("");
    await header.getByLabel("Scope", { exact: true }).selectOption(v.id);
    await header.getByLabel("Scope", { exact: true }).selectOption("");
    await header.getByLabel("Scope", { exact: true }).selectOption("__new");
    await expect(page.getByRole("dialog", { name: "New scope" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(header.getByLabel("Scope", { exact: true })).toHaveValue("");
    await api("DELETE", `/api/scopes/${v.id}`);
  });

  test("run location filters independently of grouping", async ({ page, state }, info) => {
    const phone = viewportOf(info) === "mobile";
    await startedByHand(page, state.sessions.long, "herdr:default@mac-pro");
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    const long = nav.getByTestId("session-row").filter({ hasText: "Long transcript session" });
    await nav.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Show session details" }).click();
    await expect(long.getByTestId("row-where")).toHaveText(`herdr default on ${state.hostName}`);

    // The location picker works in the default ungrouped list.
    await filterLocation(page, `herdr default on ${state.hostName}`);
    await expect(nav.getByTestId("session-group")).toHaveCount(0);
    await expect(nav.getByTestId("where-chip")).toContainText(`herdr default on ${state.hostName}`);
    await expect(nav.getByTestId("session-row")).toHaveCount(1);
    await expect(nav.getByTestId("filter-count-active")).toHaveText("1");

    await nav.getByTestId("new-session").click();
    const dialog = page.getByRole("dialog", { name: "New session" });
    await expect(dialog.getByTestId("new-session-where")).toContainText(
      "Clear the run location filter",
    );
    await page.keyboard.press("Escape");
    if (!phone) {
      await page.goto(`/code/${state.sessions.question}`);
      await expect(nav.getByTestId("row-outside")).toHaveText(
        `Not in herdr default on ${state.hostName}`,
      );
      await expect(nav.getByTestId("row-outside")).toHaveAttribute("data-reason", "where");
    }
    await nav.getByRole("button", { name: "Clear run location" }).click();
    await expect(nav.getByTestId("where-chip")).toHaveCount(0);
    await chooseGroup(page, /^Host\b/);
    await expect(
      nav.getByTestId("session-group").getByRole("heading", { name: new RegExp(state.hostName) }),
    ).toBeVisible();
    await expect(
      nav.getByTestId("session-group").getByRole("heading", { name: /Switchyard|Terminal/ }),
    ).toHaveCount(0);
    await nav.getByRole("button", { name: `Only ${state.hostName}`, exact: true }).click();
    await expect(nav.getByTestId("where-chip")).toBeVisible();
    await nav.getByRole("button", { name: "Clear run location" }).click();
  });

  test("nothing overlaps or clips at narrow widths, with a scope and location set", async ({
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
      await filterLocation(page, `herdr a-long-terminal-name on ${state.hostName}`);
      await expect(nav.getByTestId("where-chip")).toBeVisible();
      expect(await headerProblems(page)).toEqual([]);
      await nav.getByTestId("clear-filters").click();
      await expect(nav.getByTestId("where-chip")).toHaveCount(0);
    }
    await api("DELETE", `/api/scopes/${v.id}`);
  });

  test("shared rows expose branch details without crowding the title", async ({
    page,
    api,
    state,
  }, info) => {
    const phone = viewportOf(info) === "mobile";
    const branch = `presentation-${uid(info)}`;
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
    const extra = await api("POST", "/api/branches/open", {
      projectId: state.projectId,
      branch,
      title: `Extra ${branch}`,
      another: true,
    });
    await rewriteSync(page, (_key, value) =>
      value && typeof value === "object" && value.id === first.session.id && "runtime" in value
        ? {
            ...value,
            runtime: "running",
            external: { client: "herdr:fixture@mac-pro" },
          }
        : value,
    );
    await page.goto(phone ? "/code" : `/code/${first.session.id}`);
    const nav = page.getByTestId("navigator");
    const row = nav.getByTestId("session-row").filter({ hasText: title });
    const sibling = nav.getByTestId("session-row").filter({ hasText: `Extra ${branch}` });
    await expect(row).toBeVisible();
    await expect(sibling).toBeVisible();
    await expect(row.getByTestId("row-annotations")).toHaveCount(0);
    expect(await row.evaluate((el) => el.querySelector("button") === null)).toBe(true);
    if (phone) await nav.getByTestId("toggle-search").tap();
    await nav.getByRole("searchbox", { name: "Search sessions" }).fill(branch.slice(-8));
    await expect(nav.getByTestId("filter-count-active")).toHaveText("2");
    await nav.getByRole("button", { name: "View options" }).click();
    await page.getByRole("menuitemradio", { name: /^Name\b/ }).click();
    for (const group of [/^None\b/, /^Project\b/, /^Host\b/, /^Status\b/]) {
      await chooseGroup(page, group);
      await expect(row).toBeVisible();
      await expect(sibling).toBeVisible();
      await expect(nav.getByTestId("filter-count-active")).toHaveText("2");
      if (group.source.startsWith("^None"))
        await expect(nav.getByTestId("session-group")).toHaveCount(0);
      else await expect(nav.getByTestId("session-group").first()).toBeVisible();
      await nav.getByRole("button", { name: "View options" }).click();
      await expect(page.getByRole("menuitemradio", { name: /^Name\b/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await page.keyboard.press("Escape");
    }
    for (const width of phone
      ? [360, 390]
      : viewportOf(info) === "desktop"
        ? [220, 264, 360]
        : [220, 264]) {
      if (phone) await page.setViewportSize({ width, height: 844 });
      else {
        const sep = page.getByRole("separator", { name: "Resize navigator" });
        await sep.focus();
        await page.keyboard.press(width === 220 ? "Home" : width === 264 ? "Enter" : "End");
        await expect(sep).toHaveAttribute("aria-valuenow", String(width));
      }
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        for (const group of ["none", "project"] as const) {
          await chooseGroup(page, group === "none" ? /^None\b/ : /^Project\b/);
          const titleBox = (await row.getByTestId("session-title").boundingBox())!;
          const timeBox = (await row.getByTestId("row-activity").boundingBox())!;
          const lineHeight = await row
            .getByTestId("session-title")
            .evaluate((el) => Number.parseFloat(getComputedStyle(el).lineHeight));
          expect(titleBox.height).toBeGreaterThan(lineHeight * 1.5);
          expect(titleBox.height).toBeLessThanOrEqual(lineHeight * 2 + 1);
          expect(titleBox.x + titleBox.width).toBeLessThanOrEqual(timeBox.x + 1);
          expect(
            Math.abs((await row.boundingBox())!.x - (await sibling.boundingBox())!.x),
          ).toBeLessThanOrEqual(1);
          expect(await headerProblems(page)).toEqual([]);
          expect(await nav.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          const name = `flat-${group}-${phone ? "phone" : "pane"}-${width}-${colorScheme}`;
          const screenshot = info.outputPath(`${name}.png`);
          await nav.screenshot({ path: screenshot });
          await info.attach(name, {
            path: screenshot,
            contentType: "image/png",
          });
        }
      }
    }
    if (!phone) {
      await page.goto(`/code/${extra.session.id}`);
      await expect(sibling).toHaveAttribute("aria-current", "page");
    }
  });

  test("rows keep an urgent preview without session details", async ({ page, state }) => {
    await page.goto("/code");
    const nav = page.getByTestId("navigator");
    const question = nav.getByTestId("session-row").filter({ hasText: "Question session" });
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
