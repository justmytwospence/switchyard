import type { Locator, Page } from "@playwright/test";
import { createTask, expect, poll, test, uid } from "./support";

const card = (page: Page, id: string) => page.locator(`[data-task-id="${id}"]`);

async function backlog(page: Page, isMobile: boolean) {
  await page.goto("/board");
  if (isMobile)
    await page
      .getByTestId("status-tabs")
      .getByRole("tab", { name: /^Backlog/ })
      .click();
}

async function drag(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const s = (await source.boundingBox())!;
  const t = (await target.boundingBox())!;
  const x = s.x + s.width / 2;
  const y = s.y + 20;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y + 8, { steps: 4 });
  await page.mouse.move(t.x + t.width / 2, t.y + 100, { steps: 15 });
  await page.mouse.up();
}

test.describe("board task hierarchy", () => {
  test.beforeEach(async ({ signIn }) => {
    await signIn();
  });

  test("both layouts nest only visible same-state parents and keep all-child progress", async ({
    page,
    api,
    state,
    isMobile,
  }, info) => {
    const suffix = uid(info);
    const parent = await createTask(api, state, { title: `Tree root ${suffix}`, priority: 0 });
    const child = await createTask(api, state, {
      title: `Tree child ${suffix}`,
      parentTaskId: parent.id,
      priority: 0,
    });
    const ready = await createTask(api, state, {
      title: `Tree ready ${suffix}`,
      parentTaskId: parent.id,
      state: "ready",
      priority: 0,
    });
    const canceled = await createTask(api, state, {
      title: `Tree canceled ${suffix}`,
      parentTaskId: parent.id,
    });
    await api("POST", `/api/tasks/${canceled.id}/cancel`);
    await backlog(page, isMobile);
    await expect(card(page, parent.id)).toContainText("0/3 done · 1 canceled");
    await expect(card(page, child.id)).toHaveAttribute("data-depth", "1");
    await expect(card(page, child.id)).toHaveAttribute(
      "aria-label",
      `${child.title}, depth 1, under ${parent.title}`,
    );
    await expect(
      card(page, child.id).getByRole("link", { name: `Parent: ${parent.title}` }),
    ).toHaveAttribute("href", `/tasks/${parent.id}`);
    await expect(card(page, canceled.id)).toHaveCount(0);

    // A filtered-out parent must never swallow its matching child.
    if (isMobile) await page.getByRole("button", { name: "Show search" }).click();
    const search = page.getByRole("searchbox", { name: "Search tasks" });
    await search.fill(child.title);
    await expect(card(page, parent.id)).toHaveCount(0);
    await expect(card(page, child.id)).toHaveAttribute("data-depth", "0");
    await expect(card(page, child.id)).toHaveAttribute(
      "aria-label",
      `${child.title}, depth 1, under ${parent.title}`,
    );
    await search.fill(parent.title);
    await expect(card(page, parent.id)).toContainText("0/3 done · 1 canceled");
    await search.fill("");

    if (isMobile)
      await page
        .getByTestId("status-tabs")
        .getByRole("tab", { name: /^Ready/ })
        .click();
    await expect(card(page, ready.id)).toHaveAttribute("data-depth", "0");
    await expect(
      card(page, ready.id).getByRole("link", { name: `Parent: ${parent.title}` }),
    ).toBeVisible();
    if (isMobile) {
      await page.getByRole("button", { name: /^Filters/ }).click();
      const sheet = page.getByRole("dialog", { name: "Filter tasks" });
      await sheet
        .getByRole("radiogroup", { name: "Board layout" })
        .getByRole("radio", { name: "List", exact: true })
        .click();
      await sheet.getByRole("button", { name: "Show results" }).click();
      await expect(card(page, child.id)).toHaveAttribute("data-depth", "1");
      await expect(card(page, ready.id)).toHaveAttribute("data-depth", "0");
      await expect(card(page, parent.id)).toContainText("0/3 done · 1 canceled");
    }
  });

  test("full ancestry stays accessible after the visual indentation cap", async ({
    page,
    api,
    state,
    isMobile,
  }, info) => {
    const suffix = uid(info);
    const chain: { id: string; title: string }[] = [];
    for (let i = 0; i < 6; i++) {
      chain.push(
        await createTask(api, state, {
          title: `Level ${i} ${suffix}`,
          parentTaskId: chain.at(-1)?.id ?? null,
          priority: 0,
        }),
      );
    }
    await backlog(page, isMobile);
    const leaf = card(page, chain[5]!.id);
    await expect(leaf).toHaveAttribute("data-depth", "5");
    await expect(leaf).toHaveAttribute(
      "aria-label",
      `${chain[5]!.title}, depth 5, under ${chain
        .slice(0, 5)
        .map((t) => t.title)
        .join(" / ")}`,
    );
    expect(await leaf.evaluate((el) => getComputedStyle(el).marginInlineStart)).toBe("36px");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });

  test("human creation defaults to None and editing can unlink without changing children or dependencies", async ({
    page,
    api,
    state,
    isMobile,
  }, info) => {
    const suffix = uid(info);
    const parent = await createTask(api, state, { title: `Picker parent ${suffix}` });
    await backlog(page, isMobile);
    await page.getByRole("button", { name: "New task", exact: true }).click();
    const form = page.getByTestId("new-task-form");
    await expect(form.getByLabel("Parent task", { exact: true })).toHaveValue("");
    await form.getByLabel("Title", { exact: true }).fill(`Picker child ${suffix}`);
    await form.getByLabel("Parent task", { exact: true }).selectOption(parent.id);
    const created = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/tasks",
    );
    await form.getByRole("button", { name: "Save to Backlog" }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const child = await response.json();
    expect(child.parentTaskId).toBe(parent.id);
    expect(child.dependencies).toEqual([]);
    const grandchild = await createTask(api, state, {
      title: `Picker grandchild ${suffix}`,
      parentTaskId: child.id,
    });
    await page.goto(`/tasks/${child.id}`);
    const detail = page.getByTestId("task-detail");
    await expect(detail.getByRole("link", { name: parent.title, exact: true })).toBeVisible();
    await expect(detail.getByRole("link", { name: grandchild.title, exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "Edit", exact: true }).click();
    const picker = detail.getByLabel("Parent task", { exact: true });
    await expect(picker).toHaveValue(parent.id);
    await expect(picker.locator(`option[value="${child.id}"]`)).toHaveCount(0);
    await expect(picker.locator(`option[value="${grandchild.id}"]`)).toHaveCount(0);
    await picker.selectOption("");
    await detail.getByRole("button", { name: "Save", exact: true }).click();
    await poll(
      "parent cleared",
      async () => (await api("GET", `/api/tasks/${child.id}`)).parentTaskId === null,
    );
    expect((await api("GET", `/api/tasks/${grandchild.id}`)).parentTaskId).toBe(child.id);
    expect((await api("GET", `/api/tasks/${child.id}`)).dependencies).toEqual([]);
  });

  test("desktop pointer and keyboard dragging move only the selected task", async ({
    page,
    api,
    state,
    isMobile,
  }, info) => {
    test.skip(isMobile, "Mobile preserves its independent move menus, not drag-and-drop");
    const suffix = uid(info);
    const parent = await createTask(api, state, { title: `Drag parent ${suffix}`, priority: 0 });
    const child = await createTask(api, state, {
      title: `Drag child ${suffix}`,
      parentTaskId: parent.id,
      priority: 0,
    });
    const grandchild = await createTask(api, state, {
      title: `Drag grandchild ${suffix}`,
      parentTaskId: child.id,
      priority: 0,
    });
    await backlog(page, false);
    const handle = card(page, parent.id).getByRole("button", {
      name: `Drag ${parent.title}`,
      exact: true,
    });
    await handle.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    await page.keyboard.press("Space");
    await poll(
      "parent moved alone",
      async () => (await api("GET", `/api/tasks/${parent.id}`)).state === "ready",
    );
    expect((await api("GET", `/api/tasks/${child.id}`)).state).toBe("backlog");
    expect((await api("GET", `/api/tasks/${grandchild.id}`)).state).toBe("backlog");
    await expect(card(page, child.id)).toHaveAttribute("data-depth", "0");
    await drag(page, card(page, child.id), page.getByTestId("column-ready"));
    await poll(
      "child moved alone",
      async () => (await api("GET", `/api/tasks/${child.id}`)).state === "ready",
    );
    const remaining = await api("GET", `/api/tasks/${grandchild.id}`);
    expect(remaining.state).toBe("backlog");
    expect(remaining.parentTaskId).toBe(child.id);
    await expect(card(page, child.id)).toHaveAttribute("data-depth", "1");
    await expect(card(page, grandchild.id)).toHaveAttribute("data-depth", "0");
  });

  test("mobile move menus move a parent independently", async ({
    page,
    api,
    state,
    isMobile,
  }, info) => {
    test.skip(!isMobile, "Mobile move menu");
    const suffix = uid(info);
    const parent = await createTask(api, state, { title: `Menu parent ${suffix}`, priority: 0 });
    const child = await createTask(api, state, {
      title: `Menu child ${suffix}`,
      parentTaskId: parent.id,
      priority: 0,
    });
    await backlog(page, true);
    await card(page, parent.id)
      .getByRole("button", { name: `Move to… and other actions for ${parent.title}` })
      .click();
    await page.getByRole("menuitem", { name: "Make ready", exact: true }).click();
    await poll(
      "parent moved independently",
      async () => (await api("GET", `/api/tasks/${parent.id}`)).state === "ready",
    );
    expect((await api("GET", `/api/tasks/${child.id}`)).state).toBe("backlog");
    await expect(card(page, child.id)).toHaveAttribute("data-depth", "0");
    await expect(
      card(page, child.id).getByRole("link", { name: `Parent: ${parent.title}` }),
    ).toBeVisible();
  });
});
