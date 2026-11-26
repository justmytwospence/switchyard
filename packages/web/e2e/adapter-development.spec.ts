import type { SessionAdaptersResult, TranscriptItem } from "@switchyard/protocol";
import {
  backToChat,
  createSession,
  expect,
  openExtensions,
  openSessionPanel,
  poll,
  test,
  viewportOf,
} from "./support";

const staleMessage = "This extension view changed. Reopen it before trying again.";

// Runs in all four configured viewport projects, against the fixture-adapter host.
test("session inspection, readiness reason and safe reload preserve the draft", async ({
  page,
  api,
  state,
  signIn,
}, info) => {
  await signIn();
  const id = await createSession(api, state, "Adapter development", "Ready for adapters");
  await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-slots" });
  const before = await api<SessionAdaptersResult>("GET", `/api/sessions/${id}/adapters`);
  await page.goto(`/code/${id}`);
  const draft = page.getByTestId("composer").getByRole("textbox", { name: "Message to Pi" });
  await draft.fill("A draft that must survive adapter reload");
  if (viewportOf(info) === "mobile") {
    await openSessionPanel(page, "Details");
  } else {
    if (viewportOf(info) === "compact")
      await page.getByRole("button", { name: "Show inspector" }).click();
    await page.getByTestId("inspector").getByRole("tab", { name: "Details", exact: true }).click();
  }
  await openExtensions(page);
  const inspection = page.getByRole("region", { name: "Session adapters", exact: true });
  await expect(inspection).toContainText("Catalog: active");
  await expect(inspection).toContainText("Runtime: active");
  await expect(
    inspection.getByRole("button", { name: "Reload adapters", exact: true }),
  ).toBeEnabled();

  // An authoritative blocked reason is shown next to, not merely in a tooltip on, the control.
  const blocked = "Wait for Pi to finish and answer pending questions before reloading adapters.";
  await page.route(`**/api/sessions/${id}/adapters`, (route) =>
    route.fulfill({ json: { ...before, reloadable: false, blockedReason: blocked } }),
  );
  await inspection.getByRole("button", { name: "Refresh diagnostics" }).click();
  await expect(inspection).toContainText(blocked);
  await expect(
    inspection.getByRole("button", { name: "Reload adapters", exact: true }),
  ).toBeDisabled();
  await page.unroute(`**/api/sessions/${id}/adapters`);
  await inspection.getByRole("button", { name: "Refresh diagnostics" }).click();
  await expect(
    inspection.getByRole("button", { name: "Reload adapters", exact: true }),
  ).toBeEnabled();
  // An explicit fixture tombstone must not be resurrected by a subsequent reload.
  await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-slots-clear" });
  const response = page.waitForResponse((r) =>
    r.url().endsWith(`/api/sessions/${id}/adapters/reload`),
  );
  await inspection.getByRole("button", { name: "Reload adapters", exact: true }).click();
  expect((await response).ok()).toBe(true);
  await expect(page.getByText("Adapters reloaded.", { exact: true }).first()).toBeVisible();
  const after = await api<SessionAdaptersResult>("GET", `/api/sessions/${id}/adapters`);
  expect(after.generation).not.toBe(before.generation);
  // Cleared fixture contributions stay removed after replacement.
  if (viewportOf(info) === "mobile") {
    await expect(page.getByRole("region", { name: "Session panels" })).toHaveCount(0);
    await backToChat(page);
  } else {
    await expect(
      page.getByTestId("inspector").getByRole("tab", { name: "Slots details" }),
    ).toHaveCount(0);
    if (viewportOf(info) === "compact")
      await page
        .getByRole("dialog", { name: "Inspector" })
        .getByRole("button", { name: "Close" })
        .click();
  }
  await expect(draft).toHaveValue("A draft that must survive adapter reload");
});

test("generation changes close command previews without resubmission or draft loss", async ({
  page,
  api,
  state,
  signIn,
}) => {
  await signIn();
  const id = await createSession(api, state, "Adapter commands", "Ready for commands");
  await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-slots" });
  let commandFetches = 0;
  const actions: unknown[] = [];
  await page.route(`**/api/sessions/${id}/commands`, async (route) => {
    commandFetches++;
    await route.continue();
  });
  await page.route(`**/api/sessions/${id}/adapter-action`, async (route) => {
    actions.push(route.request().postDataJSON());
    await route.continue();
  });
  await page.goto(`/code/${id}`);
  const composer = page.getByTestId("composer");
  const draft = composer.getByRole("textbox", { name: "Message to Pi" });
  await draft.fill("/adapter:slots:note");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  const command = page.getByRole("dialog", { name: "Slots command" });
  await expect(command).toBeVisible();
  await command.getByRole("textbox", { name: "Fixture note" }).fill("Unsubmitted form");
  const previousFetches = commandFetches;
  await api("POST", `/api/sessions/${id}/adapters/reload`);
  await expect(command).not.toBeVisible();
  await expect(draft).toHaveValue("/adapter:slots:note");
  expect(actions).toEqual([]);
  await expect.poll(() => commandFetches).toBeGreaterThan(previousFetches);
});

test("historical actions send rendered generations, keep errors and become stale evidence", async ({
  page,
  api,
  state,
  signIn,
}) => {
  await signIn();
  const id = await createSession(api, state, "Adapter evidence", "Ready for evidence");
  // Initial old-compatible sessions may have no generation until the first replacement.
  await api("POST", `/api/sessions/${id}/adapters/reload`);
  await api("POST", `/api/sessions/${id}/prompt`, { text: "/fixture-slots" });
  const before = await api<SessionAdaptersResult>("GET", `/api/sessions/${id}/adapters`);
  await poll("custom fixture card", async () => {
    const body = await api("GET", `/api/sessions/${id}/transcript`);
    const items: TranscriptItem[] = Array.isArray(body) ? body : body.items;
    return items.some(
      (item) => item.kind === "notice" && item.data.adapterId === "slots" && item.data.card,
    );
  });
  // Add an explicit action to the fixture's custom-message evidence, without editing the adapter.
  await page.route(`**/api/sessions/${id}/transcript*`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const items: TranscriptItem[] = Array.isArray(body) ? body : body.items;
    for (const item of items) {
      if (item.kind === "notice" && item.data.adapterId === "slots" && item.data.card) {
        item.data.adapterGeneration = before.generation!;
        item.data.card = {
          t: "section",
          children: [
            { t: "text", text: "Historical fixture evidence" },
            { t: "actions", actions: [{ id: "run", label: "Historical fixture action" }] },
          ],
        };
      }
    }
    await route.fulfill({ response, json: body });
  });
  const sent: { generation?: string }[] = [];
  await page.route(`**/api/sessions/${id}/adapter-action`, async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      json: { error: { code: "conflict", message: staleMessage } },
    });
  });
  await page.goto(`/code/${id}`);
  const card = page.getByTestId("notice-card").filter({ hasText: "Historical fixture evidence" });
  await card.getByRole("button", { name: "Historical fixture action" }).click();
  expect(sent).toEqual([expect.objectContaining({ generation: before.generation })]);
  await expect(card.getByRole("alert")).toContainText(staleMessage);
  await card.getByText("Original message", { exact: true }).click();
  await expect(card.getByRole("alert")).toContainText(staleMessage);
  await api("POST", `/api/sessions/${id}/adapters/reload`);
  await expect(card.getByRole("button", { name: "Historical fixture action" })).toHaveCount(0);
  await expect(card).toContainText("Historical fixture evidence");
  await expect(card.getByRole("alert")).toContainText(staleMessage);
  expect(sent).toHaveLength(1);
});

test("old hosts have no session reload control or speculative inspection requests", async ({
  page,
  api,
  state,
  signIn,
}, info) => {
  await signIn();
  const id = await createSession(api, state, "Legacy adapters", "Ready for legacy host");
  await page.routeWebSocket("**/ws/client", (client) => {
    const server = client.connectToServer();
    server.onMessage((message) =>
      client.send(
        JSON.stringify(
          JSON.parse(String(message), (key, value) =>
            key === "adapterDevelopment" ? undefined : value,
          ),
        ),
      ),
    );
  });
  let inspected = false;
  await page.route(`**/api/sessions/${id}/adapters`, (route) => {
    inspected = true;
    return route.abort();
  });
  await page.goto(`/code/${id}?tab=extensions`);
  if (viewportOf(info) === "mobile") {
    await openSessionPanel(page, "Details");
    await openExtensions(page);
  }
  await expect(
    page.getByText("This host does not support adapter development.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload adapters", exact: true })).toHaveCount(0);
  expect(inspected).toBe(false);
});

test("full reload waits for confirmation, refreshes cached commands and keeps drafts on failure", async ({
  page,
  api,
  state,
  signIn,
}) => {
  await signIn();
  const id = await createSession(api, state, "Full reload", "Ready for full reload");
  let fetches = 0;
  await page.route(`**/api/sessions/${id}/commands`, async (route) => {
    fetches++;
    await route.continue();
  });
  let confirm: (() => void) | undefined;
  await page.route(`**/api/sessions/${id}/reload`, async (route) => {
    await new Promise<void>((resolve) => {
      confirm = resolve;
    });
    await route.fulfill({ json: { ok: true, generation: "11111111-1111-4111-8111-111111111111" } });
  });
  await page.goto(`/code/${id}`);
  const composer = page.getByTestId("composer");
  const draft = composer.getByRole("textbox", { name: "Message to Pi" });
  await expect.poll(() => fetches).toBeGreaterThan(0);
  const before = fetches;
  await draft.fill("/reload");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await poll("full reload request", async () => !!confirm);
  await expect(page.getByText("Pi and adapters reloaded.", { exact: true })).toHaveCount(0);
  await expect(draft).toHaveValue("/reload");
  confirm!();
  await expect(page.getByText("Pi and adapters reloaded.", { exact: true })).toBeVisible();
  await expect.poll(() => fetches).toBeGreaterThan(before);
  await page.unroute(`**/api/sessions/${id}/reload`);
  await page.route(`**/api/sessions/${id}/reload`, (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: { code: "conflict", message: "Native reload completion could not be confirmed." },
      },
    }),
  );
  await draft.fill("/reload");
  await composer.getByRole("button", { name: "Send", exact: true }).click();
  await expect(composer).toContainText("Native reload completion could not be confirmed.");
  await expect(draft).toHaveValue("/reload");
});

test("portable preview actions stay local in desktop and phone frames", async ({
  page,
  signIn,
}) => {
  await signIn();
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && /adapter-action|\/prompt|\/respond/.test(request.url()))
      posts.push(request.url());
  });
  await page.goto("/settings/adapters");
  await page.getByText("Portable UI preview", { exact: true }).click();
  await page.getByLabel("Preview JSON (up to 1 MiB)").fill(
    JSON.stringify({
      version: 1,
      name: "Isolated fixture",
      adapter: { id: "fixture", version: "1.0.0" },
      steps: [],
      panels: [],
      interactions: [],
      diagnostics: [],
      cards: [{ t: "actions", actions: [{ id: "local", label: "Simulated action" }] }],
    }),
  );
  await page.getByRole("button", { name: "Render preview" }).click();
  for (const name of ["Desktop preview", "Phone preview 390px"]) {
    await page
      .getByRole("region", { name, exact: true })
      .getByRole("button", { name: "Simulated action" })
      .click();
  }
  await expect(page.getByRole("region", { name: "Preview action log" })).toContainText(
    "Preview action — not sent to Pi",
  );
  expect(posts).toEqual([]);
});
