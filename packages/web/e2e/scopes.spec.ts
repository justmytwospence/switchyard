import { expect, test, uid } from "./support";

test.describe("settings scopes", () => {
  test(
    "creates, edits, disconnects and deletes a GitHub scope",
    { tag: "@smoke" },
    async ({ page, signIn, api }, info) => {
      await signIn();
      const name = `scp-${uid(info)}`.slice(0, 50);
      await page.goto("/settings/scopes");
      const section = page.getByTestId("scopes-section");
      await expect(section.getByRole("heading", { name: "Scopes" }).first()).toBeVisible();
      await section.getByRole("button", { name: "New GitHub scope" }).first().click();
      const form = page.getByTestId("github-source-form");
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.getByLabel("GitHub owner", { exact: true }).fill("acme");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const card = section.getByRole("region", { name });
      await expect(card).toBeVisible();
      await expect(card).toContainText("acme (all repositories)");

      await card.getByRole("button", { name: "Edit" }).click();
      await form.getByLabel("Name", { exact: true }).fill(`${name}-x`);
      await form.getByLabel(/^Repositories of other owners/).fill("other/lib");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const renamed = section.getByRole("region", { name: `${name}-x` });
      await expect(renamed).toBeVisible();
      await expect(renamed).toContainText("plus other/lib");

      // Disconnecting GitHub keeps the scope, as one of projects you choose.
      await renamed.getByRole("button", { name: "Disconnect GitHub" }).click();
      await page
        .getByRole("dialog", { name: "Disconnect GitHub from this scope?" })
        .getByRole("button", { name: "Disconnect GitHub" })
        .click();
      await expect(renamed.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
      await expect(renamed).not.toContainText("plus other/lib");
      const kept = await api<{ name: string; source: unknown }[]>("GET", "/api/scopes");
      expect(kept.find((s) => s.name === `${name}-x`)?.source).toBeNull();

      await renamed.getByRole("button", { name: "Delete" }).click();
      await page.getByRole("button", { name: "Delete scope" }).click();
      await expect(renamed).toHaveCount(0);
      const left = await api<{ name: string }[]>("GET", "/api/scopes");
      expect(left.some((s) => s.name.startsWith(name))).toBe(false);
    },
  );

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
