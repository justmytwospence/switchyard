import { expect, test, uid } from "./support";

test.describe("settings trackers", () => {
  test("creates, edits and deletes a tracker", async ({ page, signIn, api }, info) => {
    await signIn();
    const name = `trk-${uid(info)}`.slice(0, 50);
    await page.goto("/settings/trackers");
    const section = page.getByTestId("trackers-section");
    await expect(section.getByRole("heading", { name: "Trackers" }).first()).toBeVisible();
    await section.getByRole("button", { name: "New tracker" }).first().click();
    const form = page.getByTestId("tracker-form");
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

    await renamed.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete tracker" }).click();
    await expect(renamed).toHaveCount(0);
    const left = await api<{ name: string }[]>("GET", "/api/trackers");
    expect(left.some((t) => t.name.startsWith(name))).toBe(false);
  });
});
