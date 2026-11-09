import { expect, test } from "./support";

test.describe("read-only policy tester", () => {
  test.beforeEach(async ({ signIn, page }) => {
    await signIn();
    await page.goto("/settings/policies");
  });

  test("destructive bash sample asks without creating an approval", async ({
    page,
    api,
    state,
  }) => {
    const tester = page.getByRole("heading", { name: "Test rules" }).locator("..");
    await expect(tester).toContainText(
      "Read-only policy test. The sample command is not executed.",
    );
    await tester.getByLabel("Session").selectOption(state.sessions.long);
    await tester
      .getByLabel("Sample arguments (JSON object)")
      .fill(JSON.stringify({ command: "rm -rf /outside" }));
    const before = await api("GET", `/api/interactions?sessionId=${state.sessions.long}`);
    await tester.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tester.locator("strong").first()).toHaveText("Ask");
    await expect(tester).toContainText("destructive-shell");
    expect(await api("GET", `/api/interactions?sessionId=${state.sessions.long}`)).toEqual(before);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("host capability errors replace a previous verdict", async ({ page, state }) => {
    const tester = page.getByRole("heading", { name: "Test rules" }).locator("..");
    await tester.getByLabel("Session").selectOption(state.sessions.long);
    await tester
      .getByLabel("Sample arguments (JSON object)")
      .fill(JSON.stringify({ command: "rm -rf /outside" }));
    let calls = 0;
    await page.route("**/api/policies/test", async (route) => {
      if (calls++ === 0) {
        await route.fulfill({
          json: {
            verdict: "ASK",
            reason: null,
            trace: [],
            proposedStateUpdates: [],
            enforcement: { phases: ["tool_call"], explanation: "Not enforced" },
          },
        });
      } else {
        await route.fulfill({
          status: 409,
          json: {
            error: { code: "unsupported_capability", message: "Host classification unavailable" },
          },
        });
      }
    });
    await tester.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tester.locator("strong").first()).toHaveText("Ask");
    await tester.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tester.getByRole("alert")).toHaveText("Host classification unavailable");
    await expect(tester.locator("strong")).toHaveCount(0);
  });
});
