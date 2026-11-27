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
    await tester.getByLabel("Command", { exact: true }).fill("rm -rf /outside");
    const sent = page.waitForRequest(
      (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/policies/test",
    );
    const before = await api("GET", `/api/interactions?sessionId=${state.sessions.long}`);
    await tester.getByRole("button", { name: "Test", exact: true }).click();
    expect((await sent).postDataJSON().tool.args).toEqual({ command: "rm -rf /outside" });
    await expect(tester.locator("strong").first()).toHaveText("Ask");
    await expect(tester).toContainText("destructive-shell");
    expect(await api("GET", `/api/interactions?sessionId=${state.sessions.long}`)).toEqual(before);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("host capability errors replace a previous verdict", async ({ page, state }) => {
    const tester = page.getByRole("heading", { name: "Test rules" }).locator("..");
    await tester.getByLabel("Session").selectOption(state.sessions.long);
    await tester.getByLabel("Command", { exact: true }).fill("rm -rf /outside");
    let calls = 0;
    await page.route("**/api/policies/test", async (route) => {
      if (calls++ === 0) {
        await route.fulfill({
          json: {
            verdict: "ASK",
            reason: null,
            trace: [],
            proposedStateUpdates: { "rule-test": { attempts: 1 } },
            enforcement: { phases: ["tool_call"], explanation: "Not enforced" },
          },
        });
      } else {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              code: "unsupported_capability",
              message: "Host classification unavailable",
              details: { capability: "policy.test" },
            },
          },
        });
      }
    });
    await tester.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tester.locator("strong").first()).toHaveText("Ask");
    await expect(tester).toContainText("rule-test");
    await expect(tester).toContainText("attempts");
    await tester.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tester.getByRole("alert")).toContainText("Host classification unavailable");
    await expect(tester.getByRole("alert")).toContainText("capability");
    await expect(tester.getByRole("alert")).toContainText("policy.test");
    await expect(tester.locator("strong")).toHaveCount(0);
  });
  for (const phase of ["tool_call", "request"] as const) {
    test(`locks tester inputs during an in-flight ${phase} test`, async ({ page, state }) => {
      const tester = page.getByRole("heading", { name: "Test rules" }).locator("..");
      const session = tester.getByLabel("Session");
      const phaseSelect = tester.getByRole("combobox", { name: "Phase", exact: true });
      await session.selectOption(state.sessions.long);
      await phaseSelect.selectOption(phase);
      const action =
        phase === "tool_call"
          ? tester.getByLabel("Tool name", { exact: true })
          : tester.getByRole("combobox", { name: "Action", exact: true });
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let received!: () => void;
      const requestReceived = new Promise<void>((resolve) => {
        received = resolve;
      });
      await page.route("**/api/policies/test", async (route) => {
        received();
        await pending;
        await route.fulfill({
          json: {
            verdict: "ALLOW",
            reason: null,
            trace: [],
            proposedStateUpdates: {},
            enforcement: { phases: [], explanation: "Not enforced" },
          },
        });
      });
      await tester.getByRole("button", { name: "Test", exact: true }).click();
      await requestReceived;
      try {
        await expect(session).toBeDisabled();
        await expect(phaseSelect).toBeDisabled();
        await expect(action).toBeDisabled();
      } finally {
        release();
      }
      await expect(tester.locator("strong").first()).toHaveText("Allow");
      await expect(session).toBeEnabled();
      await expect(phaseSelect).toBeEnabled();
      await expect(action).toBeEnabled();
      await session.selectOption("");
      await expect(tester.locator("strong")).toHaveCount(0);
      await expect(tester).not.toContainText("No proposed updates.");
    });
  }

  test("builds nested typed request arguments", async ({ page, state }) => {
    const tester = page.getByRole("heading", { name: "Test rules" }).locator("..");
    await tester.getByLabel("Session").selectOption(state.sessions.long);
    await tester.getByRole("combobox", { name: "Phase", exact: true }).selectOption("request");
    await page.route("**/api/policies/test", async (route) => {
      expect(route.request().postDataJSON().request).toEqual({
        method: "task.create",
        args: { metadata: { attempts: [0, false] } },
      });
      await route.fulfill({
        json: {
          verdict: "ALLOW",
          reason: null,
          trace: [],
          proposedStateUpdates: {},
          enforcement: { phases: [], modelRequest: false, explanation: "Not enforced" },
        },
      });
    });
    await tester.getByRole("button", { name: "Add argument" }).click();
    const argument = tester.getByRole("group", { name: "Argument 1" });
    await argument.getByLabel("Name", { exact: true }).fill("metadata");
    await argument.getByRole("combobox", { name: "Type", exact: true }).selectOption("object");
    await argument.getByRole("button", { name: "Add field" }).click();
    const field = argument.getByRole("group", { name: "Field 1" });
    await field.getByLabel("Name", { exact: true }).fill("attempts");
    await field.getByRole("combobox", { name: "Type", exact: true }).selectOption("list");
    await field.getByRole("button", { name: "Add item" }).click();
    const first = field.getByRole("group", { name: "Item 1" });
    await first.getByRole("combobox", { name: "Type", exact: true }).selectOption("number");
    await first.getByLabel("Value").fill("0");
    await field.getByRole("button", { name: "Add item" }).click();
    await field
      .getByRole("group", { name: "Item 2" })
      .getByRole("combobox", { name: "Type", exact: true })
      .selectOption("boolean");
    await tester.getByRole("button", { name: "Test", exact: true }).click();
    await expect(tester).toContainText("No proposed updates.");
  });
});
