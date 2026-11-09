import type { WorkspaceGitHub } from "@switchyard/protocol";
import { check, logs, SHA, snapshot } from "../test/github-fixtures";
import { expect, test, viewportOf } from "./support";

function fresh(patch: Partial<WorkspaceGitHub> = {}) {
  const s = snapshot({
    branch: "main",
    fetchedAt: new Date().toISOString(),
    attemptedAt: new Date().toISOString(),
    ...patch,
  });
  if (s.pullRequest) {
    s.pullRequest.headRefName = "main";
    s.pullRequest.nodeId = "PR_node";
  }
  return s;
}

test.describe("GitHub PR inspector", () => {
  test.beforeEach(async ({ signIn, page }) => {
    await signIn();
    // These tests replace gh with HTTP fixtures. Do not let real non-GitHub checkout
    // discovery (or another code test settling in the shared workspace) replace them.
    await page.routeWebSocket("**/ws/client", (client) => {
      const server = client.connectToServer();
      server.onMessage((message) => {
        const frame = JSON.parse(String(message), (key, value) =>
          key === "github" ? undefined : value,
        );
        client.send(JSON.stringify(frame));
      });
    });
  });

  test("discovers before a PR tab exists, keeps no-PR/error states discoverable in Details", async ({
    page,
    state,
  }, info) => {
    let value = fresh({ pullRequest: null, checks: [], threads: [] });
    await page.route("**/api/workspaces/*/pr{,/refresh}", (route) =>
      route.fulfill({ json: { github: { available: true, reason: null }, snapshot: value } }),
    );
    await page.goto(`/code/${state.sessions.long}?tab=task`);
    const details =
      viewportOf(info) === "mobile"
        ? page.getByRole("region", { name: "Details", exact: true })
        : page.getByTestId("inspector");
    await expect(details).toContainText("No pull request is associated with this branch.");
    await expect(
      page.getByRole(viewportOf(info) === "mobile" ? "radio" : "tab", { name: "PR", exact: true }),
    ).toHaveCount(0);
    value = fresh({
      status: "error",
      reason: "GitHub request timed out",
      checksComplete: false,
      threadsComplete: false,
    });
    await details.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(details).toContainText("GitHub request timed out");
    await expect(details).toContainText("Showing stale PR data");
    await details.getByRole("button", { name: "Open PR", exact: true }).click();
    const panel = page.getByRole("region", { name: "Pull request", exact: true });
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("button", { name: "Squash merge", exact: true })).toBeDisabled();
  });

  test("requires explicit SHA confirmation and never accepts the task or enables auto-merge", async ({
    page,
    state,
  }) => {
    let value = fresh();
    const merges: unknown[] = [];
    const accepts: string[] = [];
    await page.route("**/api/workspaces/*/pr{,/refresh}", (route) =>
      route.fulfill({ json: { github: { available: true, reason: null }, snapshot: value } }),
    );
    await page.route("**/api/workspaces/*/pr/merge", (route) => {
      merges.push(route.request().postDataJSON());
      value = fresh();
      value.pullRequest!.state = "MERGED";
      return route.fulfill({
        json: {
          status: "merged",
          github: { available: true, reason: null },
          repository: "owner/repo",
          number: 7,
          url: value.pullRequest!.url,
          expectedHeadOid: SHA,
          mergeCommitOid: null,
          confirmedAt: new Date().toISOString(),
        },
      });
    });
    page.on("request", (r) => {
      if (r.url().includes("/accept")) accepts.push(r.url());
    });
    await page.goto(`/code/${state.sessions.long}?tab=pr`);
    const panel = page.getByRole("region", { name: "Pull request", exact: true });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(SHA);
    await expect(panel).toContainText("src/file.ts:17 (RIGHT) · Outdated");
    await expect(panel.getByRole("button", { name: "Squash merge", exact: true })).toBeEnabled();
    expect(merges).toEqual([]);
    await panel.getByRole("button", { name: "Squash merge", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Squash merge pull request?" });
    await expect(dialog).toContainText(SHA);
    expect(merges).toEqual([]);
    await dialog.getByRole("button", { name: "Squash merge", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(merges).toEqual([{ expectedHeadOid: SHA }]);
    expect(accepts).toEqual([]);
    await expect(panel.getByRole("button", { name: "Squash merge", exact: true })).toBeDisabled();
  });

  test("invalidates a frozen confirmation on head change and refreshes after stale-head conflicts", async ({
    page,
    state,
  }) => {
    let value = fresh();
    let mutations = 0;
    await page.clock.install();
    await page.route("**/api/workspaces/*/pr{,/refresh}", (route) =>
      route.fulfill({ json: { github: { available: true, reason: null }, snapshot: value } }),
    );
    await page.route("**/api/workspaces/*/pr/merge", (route) => {
      mutations++;
      value = fresh();
      value.pullRequest!.headRefOid = "c".repeat(40);
      return route.fulfill({
        status: 409,
        json: { error: { code: "conflict", message: "PR head changed" } },
      });
    });
    await page.goto(`/code/${state.sessions.long}?tab=pr`);
    const panel = page.getByRole("region", { name: "Pull request", exact: true });
    const merge = panel.getByRole("button", { name: "Squash merge", exact: true });
    await expect(merge).toBeEnabled();
    await merge.click();
    value = fresh();
    value.pullRequest!.headRefOid = "b".repeat(40);
    value.fetchedAt = value.attemptedAt = new Date(
      (await page.evaluate(() => Date.now())) + 59_000,
    ).toISOString();
    await page.clock.fastForward(60_000);
    await expect(page.getByRole("dialog", { name: "Squash merge pull request?" })).toHaveCount(0);
    await expect(panel).toContainText("b".repeat(40));
    expect(mutations).toBe(0);
    await expect(merge).toBeEnabled();
    await merge.click();
    await page
      .getByRole("dialog", { name: "Squash merge pull request?" })
      .getByRole("button", { name: "Squash merge", exact: true })
      .click();
    await expect(panel).toContainText("c".repeat(40));
    expect(mutations).toBe(1);
    // Refresh never silently submits a replacement-SHA merge.
    await expect(page.getByRole("dialog", { name: "Squash merge pull request?" })).toHaveCount(0);
  });

  test("blocks repeated uncertain merges until an explicit Refresh, not a poll", async ({
    page,
    state,
  }) => {
    let value = fresh();
    let merges = 0;
    await page.clock.install();
    await page.route("**/api/workspaces/*/pr{,/refresh}", (route) =>
      route.fulfill({ json: { github: { available: true, reason: null }, snapshot: value } }),
    );
    await page.route("**/api/workspaces/*/pr/merge", (route) => {
      merges++;
      return route.fulfill({
        json: {
          status: "outcome_unknown",
          github: { available: true, reason: null },
          repository: "owner/repo",
          number: 7,
          url: value.pullRequest!.url,
          expectedHeadOid: SHA,
          reason: "Connection lost",
          attemptedAt: new Date().toISOString(),
        },
      });
    });
    await page.goto(`/code/${state.sessions.long}?tab=pr`);
    const panel = page.getByRole("region", { name: "Pull request", exact: true });
    const merge = panel.getByRole("button", { name: "Squash merge", exact: true });
    await expect(merge).toBeEnabled();
    await merge.click();
    await page
      .getByRole("dialog", { name: "Squash merge pull request?" })
      .getByRole("button", { name: "Squash merge", exact: true })
      .click();
    await expect(panel).toContainText("Merge outcome unknown");
    await expect(merge).toBeDisabled();
    value = fresh();
    value.fetchedAt = value.attemptedAt = new Date(
      (await page.evaluate(() => Date.now())) + 59_000,
    ).toISOString();
    await page.clock.fastForward(60_000);
    await expect(merge).toBeDisabled();
    expect(merges).toBe(1);
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(merge).toBeEnabled();
  });

  test("sends review/CI only on click, preserves the saved draft and displays policy failures", async ({
    page,
    state,
  }, info) => {
    const value = fresh({ checks: [check({ bucket: "fail", state: "FAILURE" })] });
    const prompts: { text: string; mode: string }[] = [];
    let refuse = false;
    await page.route("**/api/workspaces/*/pr{,/refresh}", (route) =>
      route.fulfill({ json: { github: { available: true, reason: null }, snapshot: value } }),
    );
    await page.route("**/api/workspaces/*/pr/failed-logs", (route) => {
      expect(route.request().postDataJSON()).toEqual({ expectedHeadOid: SHA });
      return route.fulfill({ json: logs() });
    });
    await page.route(`**/api/sessions/${state.sessions.long}/prompt`, (route) => {
      if (refuse)
        return route.fulfill({
          status: 403,
          json: { error: { code: "forbidden", message: "Policy blocks this prompt" } },
        });
      prompts.push(route.request().postDataJSON());
      return route.fulfill({
        json: { ok: true, clientMessageId: null, automationActive: false, result: null },
      });
    });
    await page.goto(`/code/${state.sessions.long}`);
    await page.getByRole("textbox", { name: "Message to Pi" }).fill("Keep my unsent draft");
    await page.goto(`/code/${state.sessions.long}?tab=pr`);
    const panel = page.getByRole("region", { name: "Pull request", exact: true });
    const review = panel.getByRole("button", { name: "Resolve review comments", exact: true });
    await expect(review).toBeEnabled();
    expect(prompts).toEqual([]);
    await review.click();
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]!.text).toMatch(/^Address these open review comments/);
    expect(prompts[0]!.mode).toBe("prompt");
    await panel.getByRole("button", { name: "Send failing CI to the agent", exact: true }).click();
    await expect.poll(() => prompts.length).toBe(2);
    expect(prompts[1]!.text).toMatch(/^Classify each failure as real, flaky, or infrastructure/);
    expect(prompts[1]!.text).toContain("failed test\nassertion error");
    refuse = true;
    await review.click();
    await expect(panel.getByRole("alert")).toContainText("Policy blocks this prompt");
    if (viewportOf(info) === "mobile")
      await page.getByRole("radio", { name: "Chat", exact: true }).click();
    else if (viewportOf(info) === "compact")
      await page
        .getByRole("dialog", { name: "Inspector", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    await expect(page.getByRole("textbox", { name: "Message to Pi" })).toHaveValue(
      "Keep my unsent draft",
    );
  });

  test("queues a single human-intent follow-up while busy and refuses another head's CI logs", async ({
    page,
    api,
    state,
  }) => {
    const running = await api("GET", `/api/sessions/${state.runningSessionId}`);
    const workspace = await api("GET", `/api/workspaces/${running.workspaceId}`);
    const value = fresh({ checks: [check({ bucket: "fail", state: "FAILURE" })] });
    value.branch = value.pullRequest!.headRefName = workspace.branch;
    const prompts: { text: string; mode: string }[] = [];
    let wrongHead = true;
    await page.route("**/api/workspaces/*/pr{,/refresh}", (route) =>
      route.fulfill({ json: { github: { available: true, reason: null }, snapshot: value } }),
    );
    await page.route("**/api/workspaces/*/pr/failed-logs", (route) =>
      route.fulfill({
        json: logs({
          headOid: wrongHead ? "b".repeat(40) : SHA,
          complete: false,
          truncated: true,
          omittedJobs: 2,
        }),
      }),
    );
    await page.route(`**/api/sessions/${state.runningSessionId}/prompt`, (route) => {
      prompts.push(route.request().postDataJSON());
      return route.fulfill({
        json: { ok: true, clientMessageId: null, automationActive: true, result: null },
      });
    });
    await page.goto(`/code/${state.runningSessionId}?tab=pr`);
    const panel = page.getByRole("region", { name: "Pull request", exact: true });
    const send = panel.getByRole("button", { name: "Send failing CI to the agent", exact: true });
    await expect(send).toBeEnabled();
    await send.click();
    await expect(panel.getByRole("alert")).toContainText("do not match the displayed PR head");
    expect(prompts).toEqual([]);
    wrongHead = false;
    await send.click();
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]!.mode).toBe("followUp");
    expect(prompts[0]!.text).toContain("Failed-job coverage is incomplete.");
    expect(prompts[0]!.text).toContain("2 job(s) omitted");
    await expect(panel.getByRole("region", { name: "Failed CI logs" })).toContainText(
      "Incomplete job coverage",
    );
  });

  test("polls only the selected visible PR pane and suppresses overlapping refreshes", async ({
    page,
    state,
  }, info) => {
    let calls = 0;
    let inFlight = 0;
    let maximum = 0;
    let hold = false;
    let release: (() => void) | null = null;
    await page.clock.install();
    await page.route("**/api/workspaces/*/pr", (route) =>
      route.fulfill({ json: { github: { available: true, reason: null }, snapshot: fresh() } }),
    );
    await page.route("**/api/workspaces/*/pr/refresh", async (route) => {
      calls++;
      inFlight++;
      maximum = Math.max(maximum, inFlight);
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      await route.fulfill({
        json: { github: { available: true, reason: null }, snapshot: fresh() },
      });
      inFlight--;
    });
    await page.goto(`/code/${state.sessions.long}?tab=pr`);
    const panel = page.getByRole("region", { name: "Pull request", exact: true });
    await expect(panel.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect.poll(() => calls).toBeGreaterThan(0);
    const before = calls;
    hold = true;
    await page.clock.fastForward(60_000);
    await expect.poll(() => calls).toBe(before + 1);
    await page.clock.fastForward(120_000);
    expect(calls).toBe(before + 1);
    hold = false;
    (release as (() => void) | null)?.();
    await expect(panel.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hidden = calls;
    await page.clock.fastForward(180_000);
    expect(calls).toBe(hidden);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => calls).toBe(hidden + 1);
    await expect(panel.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    if (viewportOf(info) === "mobile")
      await page.getByRole("radio", { name: "Details", exact: true }).click();
    else
      await page
        .getByTestId("inspector")
        .getByRole("tab", { name: "Details", exact: true })
        .click();
    const otherTab = calls;
    await page.clock.fastForward(180_000);
    expect(calls).toBe(otherTab);
    if (viewportOf(info) === "mobile")
      await page.getByRole("radio", { name: "PR", exact: true }).click();
    else await page.getByTestId("inspector").getByRole("tab", { name: "PR", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    if (viewportOf(info) === "mobile")
      await page.getByRole("radio", { name: "Chat", exact: true }).click();
    else if (viewportOf(info) === "compact")
      await page
        .getByRole("dialog", { name: "Inspector", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
    else await page.getByRole("button", { name: "Hide inspector", exact: true }).click();
    const closed = calls;
    await page.clock.fastForward(180_000);
    expect(calls).toBe(closed);
    expect(maximum).toBe(1);
  });
});
