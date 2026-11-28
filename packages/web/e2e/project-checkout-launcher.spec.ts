import type { Checkout, Host, Workspace } from "@switchyard/protocol";
import { expect, test } from "./support";

for (const phone of [false, true]) {
  test.describe(phone ? "phone launcher" : "desktop launcher", () => {
    if (phone) test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("previews on a second host and preserves the draft through an uncertain result", async ({
      page,
      api,
      signIn,
      state,
    }) => {
      const host = await api<Host>("GET", `/api/hosts/${state.hostId}`);
      const projectId = state.projectId;
      const prepared = {
        ...host,
        id: "fixture-prepared",
        name: "Prepared host",
        checkoutProvision: true,
        checkoutRoot: "~/Projects",
      };
      const old = { ...prepared, id: "fixture-old", name: "Older host", checkoutProvision: false };
      const noRoot = {
        ...prepared,
        id: "fixture-no-root",
        name: "Unconfigured host",
        checkoutRoot: null,
      };
      const offline = {
        ...prepared,
        id: "fixture-offline",
        name: "Offline host",
        connectivity: "unreachable",
      };
      const path = "/home/fixture/Projects/catalog-repo";
      const endpoint = `/api/projects/${projectId}/checkouts`;
      const detail = await api<{ checkouts: Checkout[]; workspaces: Workspace[] }>(
        "GET",
        `/api/projects/${projectId}`,
      );
      const checkout = {
        ...detail.checkouts[0]!,
        id: "fixture-checkout",
        hostId: prepared.id,
        path,
        commonDir: `${path}/.git`,
      };
      const workspace = {
        ...detail.workspaces.find((w) => w.provenance === "main")!,
        id: "fixture-workspace",
        checkoutId: checkout.id,
        hostId: prepared.id,
        path,
      };
      const previews: unknown[] = [];
      const provisions: unknown[] = [];
      let launches = 0;
      await page.routeWebSocket("**/ws/client", (client) => {
        const server = client.connectToServer();
        client.onMessage((message) => {
          if (typeof message !== "string") return server.send(message);
          const frame = JSON.parse(message);
          if (frame.type === "hello") frame.cursor = null;
          server.send(JSON.stringify(frame));
        });
        server.onMessage((message) => {
          if (typeof message !== "string") return client.send(message);
          const frame = JSON.parse(message);
          if (frame.type === "snapshot") {
            frame.state.projects = frame.state.projects.filter(
              (p: { id: string }) => p.id === projectId,
            );
            frame.state.hosts.push(prepared, old, noRoot, offline);
          }
          client.send(JSON.stringify(frame));
        });
      });
      await page.route(`**${endpoint}/preview`, (route) => {
        previews.push(route.request().postDataJSON());
        return route.fulfill({
          json: provisions.length
            ? { action: "reuse", path, previewId: "reuse-preview" }
            : { action: "clone", path, previewId: "clone-preview" },
        });
      });
      await page.route(`**${endpoint}/provision`, (route) => {
        provisions.push(route.request().postDataJSON());
        return provisions.length === 1
          ? route.abort("connectionreset")
          : route.fulfill({ json: { checkout, workspaces: [workspace] } });
      });
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname === "/api/sessions")
          launches++;
      });
      await signIn();
      await page.goto("/code");
      await page.getByTestId("new-session").click();
      const launcher = page.getByRole("dialog", { name: "New session" });
      await launcher.getByRole("button", { name: "Write a prompt" }).click();
      await launcher
        .getByLabel("What should Pi do?", { exact: false })
        .fill("Keep my initial prompt");
      const hostPicker = launcher.getByLabel("Host", { exact: true });
      await hostPicker.selectOption(old.id);
      await expect(launcher.getByText(/Update this host agent/)).toBeVisible();
      await expect(
        launcher.getByRole("button", { name: "Attach existing checkout" }),
      ).toBeVisible();
      await expect(launcher.getByRole("button", { name: "Preview checkout" })).toHaveCount(0);
      await hostPicker.selectOption(noRoot.id);
      await expect(launcher.getByRole("link", { name: "checkout location" })).toBeVisible();
      await hostPicker.selectOption(offline.id);
      await expect(launcher.getByText(/Reconnect it or choose another host/).first()).toBeVisible();
      await hostPicker.selectOption(prepared.id);
      await expect(launcher.getByText("No checkout yet", { exact: true })).toBeVisible();
      await launcher.getByLabel("Branch", { exact: true }).fill("keep-my-branch");
      await expect(
        launcher.getByRole("button", { name: "Start session", exact: true }),
      ).toBeDisabled();
      expect(previews).toEqual([]);
      expect(provisions).toEqual([]);

      await launcher.getByRole("button", { name: "Preview checkout" }).click();
      await expect(launcher.getByText(path, { exact: true })).toBeVisible();
      const clone = launcher.getByRole("button", { name: "Clone to Prepared host" });
      await expect(clone).toBeVisible();
      expect(provisions).toEqual([]);
      await clone.click();
      const check = launcher.getByRole("button", { name: "Check checkout status" });
      await expect(check).toBeVisible();
      expect(provisions).toEqual([{ previewId: "clone-preview" }]);
      await check.click();
      await expect(launcher.getByText(path, { exact: true })).toBeVisible();
      await launcher.getByRole("button", { name: "Use existing checkout" }).click();

      await expect(
        launcher.getByRole("button", { name: "Start session", exact: true }),
      ).toBeEnabled();
      await expect(hostPicker).toHaveValue(prepared.id);
      await expect(launcher.getByLabel("What should Pi do?", { exact: false })).toHaveValue(
        "Keep my initial prompt",
      );
      await expect(launcher.getByLabel("Branch", { exact: true })).toHaveValue("keep-my-branch");
      expect(previews).toEqual([{ hostId: prepared.id }, { hostId: prepared.id }]);
      expect(provisions).toEqual([{ previewId: "clone-preview" }, { previewId: "reuse-preview" }]);
      expect(launches).toBe(0);
    });
  });
}

test("the Board routes an unplaced issue into preparation without starting work", async ({
  page,
  api,
  signIn,
  state,
}) => {
  const projectId = state.projectId;
  const hostId = state.hostId;
  const endpoint = `/api/projects/${projectId}/checkouts`;
  const detail = await api<{ checkouts: Checkout[]; workspaces: Workspace[] }>(
    "GET",
    `/api/projects/${projectId}`,
  );
  const checkout = detail.checkouts[0]!;
  const workspace = detail.workspaces.find((w) => w.provenance === "main")!;
  const now = new Date().toISOString();
  const issue = {
    id: "fixture-issue",
    itemId: "fixture-item",
    scopeId: "fixture-scope",
    projectId,
    repository: "switchyard-e2e/demo",
    number: 27,
    title: "Prepare the issue checkout",
    url: "https://github.com/switchyard-e2e/demo/issues/27",
    assignees: [],
    branches: [],
    branch: null,
    workspaceId: null,
    pullRequest: null,
    board: null,
    updatedAt: now,
  };
  const scope = {
    id: issue.scopeId,
    name: "Fixture issues",
    mode: "all",
    projectIds: [projectId],
    hostIds: null,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
    source: {
      kind: "github",
      hostId,
      owner: "switchyard-e2e",
      repositories: [issue.repository],
      login: "fixture",
      enabled: true,
      writeBack: false,
      moveShared: false,
      follow: "issues",
      lastSyncedAt: now,
      lastError: null,
      board: null,
    },
  };
  await page.routeWebSocket("**/ws/client", (client) => {
    const server = client.connectToServer();
    client.onMessage((message) => {
      if (typeof message !== "string") return server.send(message);
      const frame = JSON.parse(message);
      if (frame.type === "hello") frame.cursor = null;
      server.send(JSON.stringify(frame));
    });
    server.onMessage((message) => {
      if (typeof message !== "string") return client.send(message);
      const frame = JSON.parse(message);
      if (frame.type === "snapshot") {
        frame.state.checkouts = [];
        frame.state.workspaces = [];
        frame.state.sessions = [];
        frame.state.issues = [issue];
        frame.state.scopes.push(scope);
        const host: Host | undefined = frame.state.hosts.find((h: Host) => h.id === hostId);
        if (host) {
          host.checkoutProvision = true;
          host.checkoutRoot = "~/Projects";
        }
      }
      client.send(JSON.stringify(frame));
    });
  });
  await page.route("**/api/issues/fixture-issue/description", (route) =>
    route.fulfill({ json: { body: "Issue description", truncated: false } }),
  );
  await page.route(`**${endpoint}/preview`, (route) =>
    route.fulfill({ json: { action: "reuse", path: checkout.path, previewId: "fixture-preview" } }),
  );
  await page.route(`**${endpoint}/provision`, (route) =>
    route.fulfill({ json: { checkout, workspaces: [workspace] } }),
  );
  const launches: string[] = [];
  const provisions: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    const path = new URL(request.url()).pathname;
    if (path === "/api/issues/fixture-issue/open") launches.push(path);
    if (path === `${endpoint}/provision`) provisions.push(path);
  });

  await signIn();
  await page.goto("/board");
  await page.getByRole("radio", { name: "Issue list" }).click();
  await page.getByRole("button", { name: /^Prepare a checkout for #27/ }).click();
  const launcher = page.getByRole("dialog", { name: "New session" });
  await expect(launcher.getByRole("heading", { name: issue.title })).toBeVisible();
  const instruction = launcher.getByLabel("Optional instruction");
  await instruction.fill("Keep the issue instruction");
  const start = launcher.getByRole("button", { name: "Start session", exact: true });
  await expect(start).toBeDisabled();
  expect(provisions).toEqual([]);
  await launcher.getByRole("button", { name: "Preview checkout" }).click();
  await launcher.getByRole("button", { name: "Use existing checkout" }).click();
  await expect(launcher.getByRole("button", { name: "Start and send", exact: true })).toBeEnabled();
  await expect(instruction).toHaveValue("Keep the issue instruction");
  expect(provisions).toHaveLength(1);
  expect(launches).toEqual([]);
});
