import { expect, isMobile, test, uid } from "./support";

test.describe("branch board", () => {
  test("a session's branch is a Working card that opens the session", async ({
    page,
    api,
    signIn,
    state,
  }, info) => {
    await signIn();
    const branch = `board-${uid(info)}`;
    const r = await api("POST", "/api/branches/open", {
      projectId: state.projectId,
      branch,
      title: `Card ${branch}`,
    });
    await page.goto("/board");
    await expect(page.getByTestId("workboard")).toBeVisible();
    if (isMobile(info)) await page.getByRole("tab", { name: /Working/ }).tap();
    const card = page.getByTestId("work-card").filter({ hasText: `Card ${branch}` });
    if (!isMobile(info)) {
      await expect(
        page
          .getByTestId("work-column-working")
          .getByTestId("work-card")
          .filter({
            hasText: `Card ${branch}`,
          }),
      ).toBeVisible();
    }
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: new RegExp(`^Card ${branch}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/code/${r.session.id}`));
  });

  test("browsing tracked issues compares descriptions without starting work", async ({
    page,
    signIn,
    state,
    api,
  }, info) => {
    await signIn();
    const session = await api("GET", `/api/sessions/${state.sessions.long}`);
    let posts = 0;
    let reads = 0;
    await page.routeWebSocket("**/ws/client", (client) => {
      const server = client.connectToServer();
      client.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "hello") frame.cursor = null;
        server.send(JSON.stringify(frame));
      });
      server.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "snapshot") {
          const now = new Date().toISOString();
          frame.state.scopes ??= [];
          frame.state.scopes.push({
            id: "source_fixture",
            name: "Fixture source",
            mode: "all",
            projectIds: [state.projectId],
            hostIds: null,
            sessionIds: [],
            createdAt: now,
            updatedAt: now,
            source: {
              kind: "github",
              hostId: state.hostId,
              owner: "acme",
              repositories: ["acme/repo"],
              board: null,
              enabled: true,
              worktrees: false,
              writeBack: false,
              moveShared: false,
              login: "fixture",
              lastSyncedAt: now,
              lastError: null,
            },
          });
          frame.state.issues = [1, 2].map((number) => ({
            id: `iss_board_${number}`,
            scopeId: "source_fixture",
            itemId: `item_${number}`,
            projectId: state.projectId,
            repository: "acme/repo",
            number,
            title: `Fixture issue ${number}`,
            url: `https://github.com/acme/repo/issues/${number}`,
            assignees: [],
            branches: [],
            branch: null,
            workspaceId: null,
            pullRequest: null,
            board: null,
            updatedAt: "2026-11-01T10:00:00.000Z",
          }));
        }
        client.send(JSON.stringify(frame));
      });
    });
    await page.route("**/api/issues/*/description", (route) => {
      reads++;
      const id = route.request().url().includes("iss_board_1") ? 1 : 2;
      if (id === 2 && reads === 2) {
        return route.fulfill({
          status: 422,
          json: { error: { code: "unsupported_capability", message: "Older source host" } },
        });
      }
      return route.fulfill({ json: { body: `Description ${id}`, truncated: false } });
    });
    await page.route("**/api/issues/*/open", (route) => {
      posts++;
      return route.fulfill({ json: { session, created: false } });
    });
    await page.goto("/board");
    if (isMobile(info)) await page.getByRole("button", { name: /^View options/ }).click();
    await page.getByRole("radio", { name: "Issue list" }).click();
    if (isMobile(info)) await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("button", { name: /^#1 Fixture issue 1$/ }).click();
    await expect(page.getByText("Description 1")).toBeVisible();
    if (isMobile(info))
      await page
        .getByRole("dialog", { name: "Issue details" })
        .getByRole("button", { name: "Close" })
        .click();
    await page.getByRole("button", { name: /^#2 Fixture issue 2$/ }).click();
    await expect(page.getByText(/Description unavailable.*Update the source host/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Open issue on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/acme/repo/issues/2",
    );
    await page.getByRole("button", { name: "Retry description" }).click();
    await expect(page.getByText("Description 2")).toBeVisible();
    expect(reads).toBe(3);
    expect(posts).toBe(0);
    const detail = isMobile(info)
      ? page.getByRole("dialog", { name: "Issue details" })
      : page.getByRole("complementary", { name: "Issue details" });
    await detail.getByRole("button", { name: "Start session", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/code/${state.sessions.long}`));
    expect(posts).toBe(1);
    await page.goBack();
    await expect(page).toHaveURL(/\/board$/);
    await expect(page.getByRole("button", { name: /^#2 Fixture issue 2$/ })).toBeFocused();
    await expect(page.getByText("Description 2")).toHaveCount(0);
  });

  test("repo issue browsing is broader than filtering a source scope", async ({
    page,
    api,
    signIn,
    state,
  }, info) => {
    await signIn();
    const session = await api("GET", `/api/sessions/${state.sessions.long}`);
    const repo = "acme/issues-demo";
    const sourceId = "scope_repo_browse_test";
    const makeIssue = (number: number, title: string) => ({
      itemId: `node-${number}`,
      projectId: state.projectId,
      repository: repo,
      number,
      title,
      url: `https://github.com/${repo}/issues/${number}`,
      assignees: [],
      branches: [],
      branch: null,
      workspaceId: null,
      pullRequest: null,
      board: null,
    });
    const boardIssue = makeIssue(71, "On the board");
    const onlyRepoIssue = makeIssue(72, "Unassigned repo issue");
    const now = new Date().toISOString();
    await page.routeWebSocket("**/ws/client", (client) => {
      const server = client.connectToServer();
      client.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "hello") frame.cursor = null;
        server.send(JSON.stringify(frame));
      });
      server.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "snapshot") {
          const project = frame.state.projects.find(
            (p: { id: string }) => p.id === state.projectId,
          );
          project.repoIdentity = `https://github.com/${repo}`;
          frame.state.issues ??= [];
          frame.state.issues.push({
            ...boardIssue,
            id: "tracked-71",
            scopeId: sourceId,
            updatedAt: now,
          });
          frame.state.scopes ??= [];
          frame.state.scopes.push({
            id: sourceId,
            name: "Fixture board",
            mode: "all",
            projectIds: [state.projectId],
            hostIds: null,
            sessionIds: [],
            createdAt: now,
            updatedAt: now,
            source: {
              kind: "github",
              hostId: state.hostId,
              owner: "acme",
              repositories: [repo],
              board: { projectNumber: 5, statusField: "Status", onStart: null, onReview: null },
              follow: "board",
              enabled: true,
              worktrees: false,
              writeBack: false,
              moveShared: false,
              login: "fixture",
              lastSyncedAt: now,
              lastError: null,
            },
          });
        }
        client.send(JSON.stringify(frame));
      });
    });
    let reads = 0;
    const openBodies: unknown[] = [];
    await page.route(`**/api/projects/${state.projectId}/issues*`, (route) => {
      reads++;
      const second = new URL(route.request().url()).searchParams.has("after");
      return route.fulfill({
        json: {
          items: (second ? [boardIssue] : [onlyRepoIssue]).map((i) => ({ ...i, sessionId: null })),
          nextCursor: second ? null : "two",
        },
      });
    });
    await page.route(`**/api/projects/${state.projectId}/issues/72/description`, (route) =>
      route.fulfill({ json: { body: "Repository description", truncated: false } }),
    );
    await page.route(`**/api/projects/${state.projectId}/issues/72/open`, (route) => {
      openBodies.push(route.request().postDataJSON());
      return route.fulfill({ json: { session, created: false } });
    });
    await page.goto("/board");
    expect(reads).toBe(0);
    const openView = async () => {
      if (isMobile(info)) await page.getByRole("button", { name: /^View options/ }).click();
    };
    const done = async () => {
      if (isMobile(info)) await page.getByRole("button", { name: "Done" }).click();
    };
    await openView();
    await page.getByRole("radio", { name: "Issue list" }).click();
    await page.getByLabel("Scope", { exact: true }).selectOption(sourceId);
    await done();
    await expect(page.getByRole("button", { name: /^#71 On the board$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^#72 Unassigned repo issue$/ })).toHaveCount(0);
    expect(reads).toBe(0);
    await openView();
    await page.getByLabel("Scope", { exact: true }).selectOption("");
    await page.getByLabel("Repository", { exact: true }).selectOption(state.projectId);
    await done();
    const repoRow = page.getByRole("button", { name: /^#72 Unassigned repo issue$/ });
    await expect(repoRow).toBeVisible();
    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByRole("button", { name: /^#71 On the board$/ })).toBeVisible();
    expect(reads).toBe(2);
    await repoRow.click();
    await expect(page.getByText("Repository description")).toBeVisible();
    expect(openBodies).toEqual([]);
    const detail = isMobile(info)
      ? page.getByRole("dialog", { name: "Issue details" })
      : page.getByRole("complementary", { name: "Issue details" });
    await detail.getByRole("button", { name: "Start session", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/code/${state.sessions.long}`));
    expect(openBodies).toEqual([{ expectedNodeId: "node-72" }]);
  });

  test("the view selector filters the board", async ({ page, api, signIn, state }, info) => {
    await signIn();
    const id = uid(info);
    const branch = `view-${id}`;
    await api("POST", "/api/branches/open", {
      projectId: state.projectId,
      branch,
      title: `In view ${id}`,
    });
    const elsewhere = await api("POST", "/api/scopes", {
      name: `elsewhere-${id}`,
      mode: "pinned",
    });
    await page.goto("/board");
    if (isMobile(info)) await page.getByRole("tab", { name: /Working/ }).tap();
    const card = page.getByTestId("work-card").filter({ hasText: `In view ${id}` });
    await expect(card).toBeVisible();
    const openView = async () => {
      if (!isMobile(info)) return;
      await page.getByRole("button", { name: /^View options/ }).click();
    };
    const closeView = async () => {
      if (!isMobile(info)) return;
      await page.getByRole("button", { name: "Done" }).click();
    };
    await openView();
    await page.getByLabel("Scope", { exact: true }).selectOption(elsewhere.id);
    await closeView();
    await expect(card).toHaveCount(0);
    await openView();
    await page.getByLabel("Scope", { exact: true }).selectOption("");
    await closeView();
    await expect(card).toBeVisible();
    await api("DELETE", `/api/scopes/${elsewhere.id}`);
  });

  test("a worktree without a session offers Start session", async ({
    page,
    api,
    signIn,
    state,
  }, info) => {
    test.skip(isMobile(info), "desktop board only");
    await signIn();
    const project = await api("GET", `/api/projects/${state.projectId}`);
    const branch = `empty-${uid(info)}`;
    await api("POST", "/api/workspaces", { checkoutId: project.checkouts[0].id, branch });
    await page.goto("/board");
    const card = page.getByTestId("work-card").filter({ hasText: branch });
    // A worktree nobody works in stays off the Board until asked for.
    await expect(page.getByTestId("workboard")).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: /worktrees? without a session/ }).click();
    await expect(card).toBeVisible();
    await expect(card.getByText("No session")).toBeVisible();
    await card.getByRole("button", { name: "Start session" }).click();
    await expect(page).toHaveURL(/\/code\/ses_/);
  });
});
