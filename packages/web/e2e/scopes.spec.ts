import { expect, test, uid } from "./support";

test.describe("settings scopes", () => {
  test(
    "creates, edits, disconnects, reconnects and deletes a GitHub scope",
    { tag: "@smoke" },
    async ({ page, signIn, api }, info) => {
      await signIn();
      const name = `scp-${uid(info)}`.slice(0, 50);
      await page.goto("/settings/scopes");
      const section = page.getByTestId("scopes-section");
      await expect(section.getByRole("heading", { name: "Scopes" }).first()).toBeVisible();
      await section.getByRole("button", { name: "New scope" }).first().click();
      const dialog = page.getByRole("dialog", { name: "New scope" });
      await dialog.getByLabel("Name", { exact: true }).fill(name);
      await dialog.getByRole("radio", { name: /^GitHub issues/ }).check();
      const form = dialog.getByTestId("github-source-form");
      await form.getByLabel("GitHub owner", { exact: true }).fill("acme");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      const card = section.getByRole("region", { name });
      await expect(card).toBeVisible();
      await expect(card).toContainText("acme (all repositories)");

      await card.getByRole("button", { name: "Edit" }).click();
      const edit = page.getByRole("dialog", { name: "Edit scope" });
      await edit.getByLabel("Name", { exact: true }).fill(`${name}-x`);
      await edit
        .getByTestId("github-source-form")
        .getByLabel(/^Repositories of other owners/)
        .fill("other/lib");
      await edit.getByRole("button", { name: "Save", exact: true }).click();
      const renamed = section.getByRole("region", { name: `${name}-x` });
      await expect(renamed).toBeVisible();
      await expect(renamed).toContainText("plus other/lib");

      // Choosing another kind disconnects GitHub and keeps the scope.
      await renamed.getByRole("button", { name: "Edit" }).click();
      await edit.getByRole("radio", { name: /^Pins only/ }).check();
      await expect(edit.getByText("Saving disconnects GitHub", { exact: false })).toBeVisible();
      await edit.getByRole("button", { name: "Save and disconnect GitHub" }).click();
      await expect(renamed).not.toContainText("plus other/lib");
      const kept = await api<{ name: string; source: unknown; mode: string }[]>(
        "GET",
        "/api/scopes",
      );
      const keptScope = kept.find((s) => s.name === `${name}-x`);
      expect(keptScope?.source).toBeNull();
      expect(keptScope?.mode).toBe("pinned");

      // And choosing GitHub issues connects it again, as a scope of mode all.
      await renamed.getByRole("button", { name: "Edit" }).click();
      await edit.getByRole("radio", { name: /^GitHub issues/ }).check();
      await edit
        .getByTestId("github-source-form")
        .getByLabel("GitHub owner", { exact: true })
        .fill("acme");
      await edit.getByRole("button", { name: "Save", exact: true }).click();
      await expect(renamed).toContainText("acme (all repositories)");
      const again = await api<{ name: string; source: { owner: string } | null; mode: string }[]>(
        "GET",
        "/api/scopes",
      );
      const connected = again.find((s) => s.name === `${name}-x`);
      expect(connected?.source?.owner).toBe("acme");
      expect(connected?.mode).toBe("all");

      await renamed.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Delete scope" }).click();
      await expect(renamed).toHaveCount(0);
      const left = await api<{ name: string }[]>("GET", "/api/scopes");
      expect(left.some((s) => s.name.startsWith(name))).toBe(false);
    },
  );

  test("the Sessions scope menu ends with New scope", async ({ page, signIn }, info) => {
    test.skip(info.project.name !== "desktop-1440x900", "desktop project only");
    await signIn();
    await page.goto("/code");
    const select = page.getByTestId("navigator").getByLabel("Scope", { exact: true });
    await select.selectOption({ label: "New scope…" });
    await expect(page.getByRole("dialog", { name: "New scope" })).toBeVisible();
    await expect(select).toHaveValue("");
  });

  test("the old Settings links land on Scopes and Clients", async ({ page, signIn }) => {
    await signIn();
    await page.goto("/settings/trackers");
    await expect(page).toHaveURL(/\/settings\/scopes$/);
    await page.goto("/settings/terminals");
    await expect(page).toHaveURL(/\/settings\/clients$/);
    await page.goto("/settings/devices");
    await expect(page).toHaveURL(/\/settings\/clients$/);
    await expect(page.getByTestId("settings-clients")).toBeVisible();
  });
});
