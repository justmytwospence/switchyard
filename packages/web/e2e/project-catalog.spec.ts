import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Host, Project } from "@switchyard/protocol";
import { fixtureRepository, makeRepo } from "../../test-fixtures/dist/index.js";
import {
  CATALOG_CODE,
  CATALOG_CONNECTIONS,
  catalogConnection,
  listedCatalogProject,
  registerFixtureCatalog,
  setCatalogInventory,
} from "./fixtures/catalog";
import { expect, test, uid } from "./support";

const projectsPath = "/settings/projects";

test(
  "the provider selects Projects before checkout, with stale inventory and durable history",
  { tag: "@smoke" },
  async ({ page, api, signIn, state }, info) => {
    const account = `catalog-${uid(info)}`;
    const repo = fixtureRepository(account, "selected");
    const unselected = fixtureRepository(account, "not-selected");
    const localOnly = makeRepo({ remote: unselected.cloneUrl });
    const selectedName = `${repo.owner}/${repo.name}`;
    let connectionId: string | undefined;
    setCatalogInventory(state.root, account, [repo]);
    try {
      await signIn();
      await page.goto(projectsPath);
      await page.getByRole("link", { name: "Connect GitHub", exact: true }).click();
      await page.getByLabel("GitHub username").fill(account);
      await page.getByRole("button", { name: "Set up connection" }).click();

      // Emulate the provider's return rather than contacting GitHub.
      const registration = page.locator('form[action="https://github.com/registration"]');
      await expect(registration.getByRole("button", { name: "Continue to GitHub" })).toBeVisible();
      const registrationState = await registration.locator('input[name="state"]').inputValue();
      const callback = `${projectsPath}/connect/return`;
      await page.goto(
        `${callback}?${new URLSearchParams({ state: registrationState, code: CATALOG_CODE })}`,
      );
      await expect(page).toHaveURL((url) => url.pathname === callback && !url.search);
      await expect(page.getByText("GitHub App registered", { exact: true })).toBeVisible();
      connectionId = (await catalogConnection(api, account)).id;
      await page.getByRole("link", { name: "Open Projects", exact: true }).click();

      const connection = page.getByText(`${account} · personal`, { exact: true }).locator("..");
      const projectLink = page.getByRole("link", { name: new RegExp(`^${selectedName} `) });
      await expect(connection.getByRole("link", { name: "Install on GitHub" })).toBeVisible();
      await expect(projectLink).toHaveCount(0);
      await connection.getByRole("button", { name: "Refresh connection", exact: true }).click();
      await expect(connection.getByRole("status")).toHaveText("Connected");
      await expect(projectLink).toContainText("0 checkouts");
      const project = await listedCatalogProject(api, repo);
      expect(project.defaultHostId).toBeNull();
      await expect(projectLink).toHaveAttribute("href", `${projectsPath}/${project.id}`);

      const oldCreate = await fetch(`${state.baseURL}/api/projects`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${state.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          hostId: state.hostId,
          path: localOnly.path,
          name: "Unlisted project",
        }),
      });
      expect(oldCreate.status).toBe(409);
      expect(
        (await api<Project[]>("GET", "/api/projects?includeHistory=true")).some(
          (p) => p.repoIdentity === unselected.webUrl,
        ),
      ).toBe(false);

      const refresh = async () => {
        const response = page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname === `${CATALOG_CONNECTIONS}/${connectionId}/refresh`,
        );
        await connection.getByRole("button", { name: "Refresh", exact: true }).click();
        expect((await response).ok()).toBe(true);
      };
      setCatalogInventory(state.root, account, null);
      await refresh();
      await expect(connection.getByRole("status")).toHaveText(
        "Sync failed. Showing the last known repositories.",
      );
      await expect(projectLink).toBeVisible();

      // A failed inventory must not count toward the two complete omissions.
      setCatalogInventory(state.root, account, []);
      await refresh();
      await expect(connection.getByRole("status")).toHaveText("Connected");
      await expect(projectLink).toBeVisible();
      await refresh();
      await expect(connection.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
      const history = page.locator("details").filter({ hasText: "Previous projects" });
      await expect(history.locator("summary")).toBeVisible();
      await expect(projectLink).not.toBeVisible();
      await history.locator("summary").click();
      await expect(projectLink).toContainText("Removed from catalog");
      await projectLink.click();
      await expect(page).toHaveURL(new RegExp(`${projectsPath}/${project.id}$`));
      await expect(page.getByRole("button", { name: "Prepare checkout", exact: true })).toHaveCount(
        0,
      );

      setCatalogInventory(state.root, account, [repo]);
      await page.goto(projectsPath);
      await refresh();
      await expect(projectLink).toHaveAttribute("href", `${projectsPath}/${project.id}`);
      await expect(projectLink).toBeVisible();
      expect((await listedCatalogProject(api, repo)).id).toBe(project.id);
    } finally {
      localOnly.cleanup();
      if (connectionId) await api("POST", `${CATALOG_CONNECTIONS}/${connectionId}/disconnect`);
    }
  },
);

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    if (phone) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("editing the checkout location does not discover Projects; preparation requires confirmation", async ({
      page,
      api,
      signIn,
      state,
    }, info) => {
      const account = `checkout-${uid(info)}`;
      const repo = fixtureRepository(account, "selected");
      const root = join(state.root, account);
      const collision = join(root, repo.name);
      const unused = join(root, "unused-checkout");
      const existing = join(root, "existing-checkout");
      const hostPath = `/api/hosts/${state.hostId}`;
      const { checkoutRoot } = await api<Host>("GET", hostPath);
      mkdirSync(collision, { recursive: true });
      const sentinel = join(collision, "leave-alone.txt");
      writeFileSync(sentinel, "keep this directory\n");
      const clone = makeRepo({ remote: repo.cloneUrl });
      renameSync(clone.path, existing);
      const dirty = join(existing, "README.md");
      writeFileSync(dirty, "keep my unstaged changes\n");
      setCatalogInventory(state.root, account, [repo]);
      const connectionId = await registerFixtureCatalog(api, account);
      try {
        await signIn();
        await page.goto(`/settings/hosts/${state.hostId}`);
        await page.getByLabel("Directory on this host").fill(root);
        await page.getByRole("button", { name: "Save location", exact: true }).click();
        await expect.poll(async () => (await api<Host>("GET", hostPath)).checkoutRoot).toBe(root);
        expect(
          (await api<Project[]>("GET", "/api/projects")).some(
            (p) => p.repoIdentity === repo.webUrl,
          ),
        ).toBe(false);

        await api("POST", `${CATALOG_CONNECTIONS}/${connectionId}/refresh`);
        const project = await listedCatalogProject(api, repo);
        const projectPath = `/api/projects/${project.id}`;
        const detail = () =>
          api<{ checkouts: { path: string }[]; workspaces: { provenance: string }[] }>(
            "GET",
            projectPath,
          );
        let provisions = 0;
        let starts = 0;
        page.on("request", (request) => {
          if (request.method() !== "POST") return;
          const path = new URL(request.url()).pathname;
          if (path === `${projectPath}/checkouts/provision`) provisions++;
          if (path === "/api/sessions" || path === "/api/branches/open") starts++;
        });
        const launcher = page.getByRole("dialog", { name: "New session", exact: true });
        const prompt = launcher.getByLabel("What should Pi do?");
        const start = launcher.getByRole("button", { name: "Start session", exact: true });
        const draft = `Keep this launch draft ${account}`;
        if (phone) {
          await page.goto(`${projectsPath}/${project.id}`);
          await expect(page.getByText("No checkout yet", { exact: true })).toBeVisible();
          await page.getByRole("button", { name: "Prepare checkout", exact: true }).click();
          await page.getByLabel("Checkout host").selectOption(state.hostId);
        } else {
          await page.goto("/code");
          await page.getByTestId("new-session").click();
          const projectSelect = launcher.getByRole("combobox", { name: "Project", exact: true });
          const projectPicker = launcher.getByRole("button", { name: /^Project:/ });
          await expect(projectSelect.or(projectPicker)).toBeVisible();
          if (await projectSelect.isVisible()) await projectSelect.selectOption(project.id);
          else {
            await projectPicker.click();
            await page.getByRole("combobox", { name: "Search projects" }).fill(project.name);
            await page.getByRole("option", { name: project.name }).click();
          }
          await launcher.getByLabel("Host", { exact: true }).selectOption(state.hostId);
          await prompt.fill(draft);
          await expect(launcher.getByText("No checkout yet", { exact: true })).toBeVisible();
          await expect(start).toBeDisabled();
        }
        const preparation = phone ? page : launcher;
        const preview = preparation.getByRole("button", { name: "Preview checkout", exact: true });
        await preview.click();
        await expect(
          preparation.getByText("Choose another folder.", { exact: false }),
        ).toBeVisible();
        await expect(preparation.getByText(collision, { exact: true })).toBeVisible();
        const alternative = preparation.getByLabel("Alternative folder name");
        const confirmFolder = preparation.getByRole("button", {
          name: "Preview this folder",
          exact: true,
        });
        await alternative.fill("unused-checkout");
        await confirmFolder.click();
        await expect(
          preparation.getByRole("button", { name: `Clone to ${state.hostName}`, exact: true }),
        ).toBeVisible();
        await expect(preparation.getByText(unused, { exact: true })).toBeVisible();
        await preparation.getByRole("button", { name: "Cancel preview", exact: true }).click();
        await expect(preview).toBeVisible();
        expect(provisions).toBe(0);
        expect(existsSync(unused)).toBe(false);
        expect((await detail()).checkouts).toEqual([]);

        await preview.click();
        await alternative.fill("existing-checkout");
        await confirmFolder.click();
        const reuse = preparation.getByRole("button", {
          name: "Use existing checkout",
          exact: true,
        });
        await expect(reuse).toBeVisible();
        expect((await detail()).checkouts).toEqual([]);
        await reuse.click();
        await expect.poll(detail).toMatchObject({
          checkouts: [{ path: existing }],
          workspaces: expect.arrayContaining([expect.objectContaining({ provenance: "main" })]),
        });
        expect(provisions).toBe(1);
        expect(starts).toBe(0);
        if (!phone) {
          await expect(prompt).toHaveValue(draft);
          await expect(launcher.getByLabel("Host", { exact: true })).toHaveValue(state.hostId);
          await expect(start).toBeEnabled();
        }
        expect(readFileSync(dirty, "utf8")).toBe("keep my unstaged changes\n");
        expect(readFileSync(sentinel, "utf8")).toBe("keep this directory\n");
      } finally {
        await api("PATCH", hostPath, { checkoutRoot });
        await api("POST", `${CATALOG_CONNECTIONS}/${connectionId}/disconnect`);
      }
    });
  });
}
