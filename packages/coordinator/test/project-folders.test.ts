// @module-tag slow
import { FakeRepositoryProvider, fixtureRepository } from "@switchyard/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollHost,
  FakeHost,
  startCoordinator,
  syncFixtureProject,
  type TestCoordinator,
} from "./helpers.js";

const APP_REPO = fixtureRepository("me", "app");
let t: TestCoordinator | undefined;
let host: FakeHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
  await t?.cleanup();
  t = undefined;
});

async function setup() {
  const coordinator = await startCoordinator({
    repositoryProvider: new FakeRepositoryProvider(() => [APP_REPO]),
  });
  t = coordinator;
  const project = await syncFixtureProject(coordinator.c, APP_REPO);
  const creds = await enrollHost(coordinator);
  host = await FakeHost.connect(coordinator, creds);
  return { coordinator, project, creds, path: `/api/hosts/${creds.hostId}` };
}

describe("host checkout location", () => {
  it("defaults to ~/Projects, rejects relative roots, and accepts absolute, tilde, or cleared roots", async () => {
    const { coordinator, path } = await setup();
    const initial = await coordinator.admin("GET", path);
    expect(initial.body.checkoutRoot).toBe("~/Projects");
    const bad = await coordinator.admin("PATCH", path, { checkoutRoot: "rel/path" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");

    for (const checkoutRoot of ["/srv/repos", "~/Repositories", null]) {
      const patch = await coordinator.admin("PATCH", path, { checkoutRoot });
      expect(patch.status).toBe(200);
      expect(patch.body.checkoutRoot).toBe(checkoutRoot);
      expect((await coordinator.admin("GET", path)).body.checkoutRoot).toBe(checkoutRoot);
    }
  });

  it("does not scan, create projects, or attach checkouts on save or reconnect", async () => {
    const { coordinator, project, creds, path } = await setup();
    const patch = await coordinator.admin("PATCH", path, { checkoutRoot: "/repos" });
    expect(patch.status).toBe(200);
    expect(host!.commands).toEqual([]);
    await host!.close();
    host = await FakeHost.connect(coordinator, creds);
    const projects = await coordinator.admin("GET", "/api/projects");
    expect(projects.body.map((p: { id: string }) => p.id)).toEqual([project.id]);
    expect(coordinator.c.store.checkouts.list()).toEqual([]);
    expect(host.commands).toEqual([]);
  });

  it("retires folder writes and scans, and returns no legacy project suggestions", async () => {
    const { coordinator, path } = await setup();
    const folders = await coordinator.admin("PATCH", path, { projectFolders: ["/repos"] });
    expect(folders.body.error.code).toBe("unsupported_capability");
    const scan = await coordinator.admin("POST", `${path}/scan-projects`);
    expect(scan.body.error.code).toBe("unsupported_capability");
    const suggestions = await coordinator.admin("GET", `${path}/project-suggestions`);
    expect(suggestions.status).toBe(200);
    expect(suggestions.body.suggestions).toEqual([]);
    expect(host!.commands).toEqual([]);
  });
});
