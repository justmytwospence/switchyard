import type { Page } from "@playwright/test";
import type { Project, RepoIssueItem, Scope, Session } from "@switchyard/protocol";

export const launcherSourceId = "fixture-source";
const cachedAt = "2026-01-01T00:00:00.000Z";

/** Browser-local repository and board snapshots: the coordinator and GitHub are untouched. */
export async function launcherFixture(
  page: Page,
  projectId: string,
  repository?: { session: Session },
) {
  let descriptions = 0;
  let mutations = 0;
  const repoReads: (string | null)[] = [];
  const repoDescriptions: number[] = [];
  const repoStarts: unknown[] = [];
  const source: Scope = {
    id: launcherSourceId,
    name: "Launcher board",
    mode: "all",
    projectIds: [projectId],
    hostIds: null,
    sessionIds: [],
    createdAt: cachedAt,
    updatedAt: cachedAt,
    source: {
      kind: "github",
      hostId: "mock-source-host",
      owner: "fixture",
      repositories: ["fixture/repo"],
      login: "fixture",
      writeBack: false,
      moveShared: false,
      enabled: true,
      lastSyncedAt: cachedAt,
      lastError: null,
      follow: "board",
      board: {
        projectNumber: 5,
        statusField: "Status",
        onStart: null,
        onReview: null,
        backlog: [],
      },
    },
  };
  const row = (number: number, sessionId: string | null = null): RepoIssueItem => ({
    itemId: `issue-${number}`,
    projectId,
    repository: "fixture/repo",
    number,
    title: number === 17 ? "Unassigned repository-only fix" : `Launcher fixture ${number}`,
    url: `https://github.com/fixture/repo/issues/${number}`,
    assignees: [],
    branches: [],
    branch: null,
    workspaceId: null,
    pullRequest: null,
    board: null,
    sessionId,
  });
  let startedIssue: RepoIssueItem | null = null;
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
        frame.state.scopes.push(source);
        frame.state.issues = [1, 2].map((number) => {
          const { sessionId: _sessionId, ...facts } = row(number);
          return {
            ...facts,
            id: `${launcherSourceId}:issue-${number}`,
            scopeId: launcherSourceId,
            updatedAt: cachedAt,
          };
        });
        if (repository)
          frame.state.projects = frame.state.projects.map((project: Project) =>
            project.id === projectId
              ? { ...project, repoIdentity: "https://github.com/fixture/repo" }
              : project,
          );
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
  if (repository) {
    await page.route(
      (url) => url.pathname === `/api/projects/${projectId}/issues`,
      (route) => {
        const after = new URL(route.request().url()).searchParams.get("after");
        repoReads.push(after);
        return route.fulfill({
          json: after
            ? { items: [row(17)], nextCursor: null }
            : {
                items: [startedIssue?.number === 1 ? startedIssue : row(1)],
                nextCursor: "second-page",
              },
        });
      },
    );
    await page.route(`**/api/projects/${projectId}/issues/*/description`, (route) => {
      const number = Number(new URL(route.request().url()).pathname.split("/").at(-2));
      repoDescriptions.push(number);
      return route.fulfill({
        json: { body: `Repository description ${number}`, truncated: false },
      });
    });
    await page.route(`**/api/projects/${projectId}/issues/*/open`, (route) => {
      repoStarts.push(route.request().postDataJSON());
      const number = Number(new URL(route.request().url()).pathname.split("/").at(-2));
      startedIssue = row(number, repository.session.id);
      return route.fulfill({ json: { created: false, session: repository.session } });
    });
    await page.route(`**/api/sessions/${repository.session.id}/issue-work`, (route) =>
      route.fulfill({ json: startedIssue }),
    );
  }
  return { counts: () => ({ descriptions, mutations }), repoReads, repoDescriptions, repoStarts };
}
