import type { Page } from "@playwright/test";

/** Browser-local tracked issues: the coordinator and the real GitHub source are untouched. */
export async function launcherFixture(page: Page, projectId: string) {
  let descriptions = 0;
  let mutations = 0;
  await page.routeWebSocket("**/ws/client", (client) => {
    const server = client.connectToServer();
    server.onMessage((message) => {
      if (typeof message !== "string") return client.send(message);
      const frame = JSON.parse(message);
      if (frame.type === "snapshot") {
        frame.state.issues = [1, 2].map((number) => ({
          id: `fixture-source:issue-${number}`,
          scopeId: "fixture-source",
          itemId: `issue-${number}`,
          projectId,
          repository: "fixture/repo",
          number,
          title: `Launcher fixture ${number}`,
          url: `https://github.com/fixture/repo/issues/${number}`,
          assignees: [],
          branches: [],
          branch: null,
          workspaceId: null,
          pullRequest: null,
          board: null,
          updatedAt: "2026-01-01T00:00:00.000Z",
        }));
      }
      client.send(JSON.stringify(frame));
    });
  });
  await page.route("**/api/issues/*/description", (route) => {
    descriptions++;
    return route.fulfill({ json: { body: "Fixture description", truncated: false } });
  });
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/api\/(issues|sessions|branches)/.test(request.url()))
      mutations++;
  });
  return { counts: () => ({ descriptions, mutations }) };
}
