import { backToChat, createSession, expect, openSessionPanel, test, viewportOf } from "./support";

test("session-scoped slots, palette and namespaced form", async ({
  page,
  api,
  state,
  signIn,
}, info) => {
  await signIn();
  const id = await createSession(api, state, "Slots fixture", "Ready for slots");
  await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-slots" });
  await page.goto(`/code/${encodeURIComponent(id)}`);
  const mobile = viewportOf(info) === "mobile";
  if (!mobile) {
    await expect(page.getByLabel("Adapter header")).toContainText("Fixture slots active");
    await expect(page.getByLabel("Adapter footer")).toContainText("No action yet");
    if (viewportOf(info) === "compact")
      await page.getByRole("button", { name: "Show inspector" }).click();
    await expect(
      page.getByTestId("inspector").getByRole("tab", { name: "Slots details" }),
    ).toBeVisible();
    await page.getByTestId("inspector").getByRole("tab", { name: "Slots details" }).click();
    await expect(page.getByTestId("inspector").getByLabel("Fixture note")).toBeVisible();
    await page.getByTestId("inspector").getByLabel("Fixture note").fill("from panel");
    await page.getByTestId("inspector").getByRole("button", { name: "Save note" }).click();
    await expect(page.getByLabel("Adapter footer")).toContainText("from panel");
    await page.getByTestId("inspector").getByRole("tab", { name: "Details", exact: true }).click();
    await expect(
      page
        .getByTestId("inspector")
        .getByRole("region", { name: "Panels" })
        .getByText("Slots details"),
    ).toHaveCount(0);
    const frameTab = page.getByTestId("inspector").getByRole("tab", { name: "Slots frame" });
    await frameTab.click();
    const frame = page.getByTestId("inspector").locator('iframe[title="Slots frame"]');
    await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
    await expect(frame.contentFrame().getByLabel("Renderer state")).toHaveText(
      "Fixture slots active",
    );
    await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-slots Changed state" });
    await expect(frame.contentFrame().getByLabel("Renderer state")).toHaveText("Changed state");
    if (viewportOf(info) === "compact")
      await page
        .getByRole("dialog", { name: "Inspector" })
        .getByRole("button", { name: "Close" })
        .click();
  } else {
    await openSessionPanel(page, "Details");
    const mobilePanels = page.getByRole("region", { name: "Session panels" });
    await expect(mobilePanels.getByText("Portable frame: Fixture slots active")).toBeVisible();
    await expect(mobilePanels.locator("iframe")).toHaveCount(0);
    await backToChat(page);
  }
  await expect(page.getByLabel("Adapter pills")).toContainText("Slots ready");
  // Contract v2: a tracker with its count and step, opening a checklist.
  const tracker = page.getByLabel("Trackers").getByRole("button", { name: /Slots tracker/ });
  await expect(tracker).toContainText("1/2");
  await expect(tracker).toContainText("Second step");
  await tracker.click();
  const detail = page.getByRole("dialog", { name: "Slots tracker" });
  await expect(detail.getByText("First step")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId("notice-card")).toContainText("Slots custom card");
  await expect(page.getByTestId("inspector").getByText("Hidden slots fixture")).toHaveCount(0);
  const composer = page.getByTestId("composer");
  const draft = composer.getByRole("textbox", { name: "Message to Pi" });
  await draft.fill("/adapter:slots:note");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  const command = page.getByRole("dialog", { name: "Slots command" });
  await expect(command).toBeVisible();
  await command.getByRole("button", { name: "Cancel" }).click();
  await expect(draft).toHaveValue("/adapter:slots:note");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await command.getByRole("textbox", { name: "Fixture note" }).fill("from slash");
  await command.getByRole("button", { name: "Save note" }).click();
  await expect(command).not.toBeVisible();
  await expect(draft).toHaveValue("");
  if (!mobile) await expect(page.getByLabel("Adapter footer")).toContainText("from slash");
  await page.keyboard.press("Meta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await palette.getByRole("combobox", { name: "Search" }).fill("Slots palette");
  await palette.getByText("Slots palette").click();
  const confirmation = page.getByRole("dialog", { name: "Slots palette" });
  await expect(confirmation).toContainText("Confirm fixture action");
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  if (!mobile) await expect(page.getByLabel("Adapter footer")).not.toContainText("run:");
  await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-slots-clear" });
  await expect(page.getByLabel("Adapter pills")).toHaveCount(0);
  await expect(
    page.getByLabel("Trackers").getByRole("button", { name: /Slots tracker/ }),
  ).toHaveCount(0);
  if (!mobile) {
    if (viewportOf(info) === "compact")
      await page.getByRole("button", { name: "Show inspector" }).click();
    await expect(
      page.getByTestId("inspector").getByRole("tab", { name: "Slots frame" }),
    ).toHaveCount(0);
  } else {
    await openSessionPanel(page, "Details");
    await expect(page.getByRole("region", { name: "Session panels" })).toHaveCount(0);
  }
});
