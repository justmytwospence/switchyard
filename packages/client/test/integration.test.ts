// @module-tag slow
import { afterEach, expect, it } from "vitest";
import {
  enrollDevice,
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
  until,
} from "../../coordinator/test/helpers.js";
import { project } from "../../terminal/test/fixtures.js";
import { type EventNotice, SwitchyardClient } from "../src/index.js";

let coordinator: TestCoordinator | undefined;
let client: SwitchyardClient | undefined;
let host: FakeHost | undefined;
afterEach(async () => {
  client?.close();
  await host?.close();
  host = undefined;
  await coordinator?.cleanup();
  client = undefined;
  coordinator = undefined;
});

it("uses the real local coordinator for REST tasks and projected WebSocket events", async () => {
  coordinator = await startCoordinator({ dispatcher: { tickMs: 0 }, schedulerTickMs: 0 });
  coordinator.c.store.putProject(project());
  const device = await enrollDevice(coordinator);
  client = new SwitchyardClient({
    coordinatorUrl: coordinator.c.localUrl,
    credential: device.credential,
  });
  const notices: EventNotice[] = [];
  const stop = client.events.subscribe((notice) => notices.push(notice));
  await until(() => notices.some((n) => n.type === "reset"));
  const task = await client.tasks.create({ projectId: "prj_1", title: "Integration" });
  expect(task.state).toBe("backlog");
  expect(
    (await client.tasks.list({ projectId: "prj_1", state: ["backlog"] })).map((t) => t.id),
  ).toContain(task.id);
  await expect(
    client.tasks.waitForState(task.id, "backlog", { timeoutMs: 5000 }),
  ).resolves.toMatchObject({ id: task.id });
  await until(() => notices.some((n) => n.type === "event" && n.event.type === "task.updated"));
  stop();
});

it("uses actual session creation, prompts, transcript pages, deltas and epoch resets", async () => {
  coordinator = await startCoordinator();
  const creds = await enrollHost(coordinator);
  host = await FakeHost.connect(coordinator, creds, (command) => {
    if (command.type === "checkout.inspect")
      return {
        root: "/repos/demo",
        commonDir: "/repos/demo/.git",
        repoIdentity: "https://example.test/demo",
        defaultBranch: "main",
      };
    if (command.type === "workspace.discover")
      return [
        {
          path: "/repos/demo",
          head: "abc",
          branch: "refs/heads/main",
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
          provenance: "main",
          git: null,
        },
      ];
    if (command.type === "session.start")
      return {
        nativeHandle: {
          sessionId: `n-${command.sessionId}`,
          sessionFile: `/tmp/${command.sessionId}.jsonl`,
        },
      };
    return null;
  });
  const result = await coordinator.admin("POST", "/api/projects", {
    name: "Demo",
    hostId: creds.hostId,
    path: "/repos/demo",
  });
  expect(result.status).toBe(201);
  const device = await enrollDevice(coordinator);
  client = new SwitchyardClient({
    coordinatorUrl: coordinator.c.localUrl,
    credential: device.credential,
  });
  const created = await client.sessions.create({
    projectId: result.body.id,
    workspace: { existingId: result.body.workspaces[0].id },
  });
  expect(created.id).toBeTruthy();
  await host.event("session.updated", hostSession(created.id, { runtime: "idle" }));
  await expect(
    client.sessions.send(created.id, { text: "Hello", clientMessageId: "message-1" }),
  ).resolves.toMatchObject({ ok: true, clientMessageId: "message-1" });
  await host.event("transcript.item", {
    id: "itm_1",
    sessionId: created.id,
    order: 1,
    at: new Date().toISOString(),
    kind: "user",
    data: { text: "first" },
  });
  await host.event("transcript.item", {
    id: "itm_2",
    sessionId: created.id,
    order: 2,
    at: new Date().toISOString(),
    kind: "user",
    data: { text: "second" },
  });
  const page = await client.sessions.transcript(created.id, { limit: 1 });
  expect(page.items.map((i) => i.id)).toEqual(["itm_2"]);
  expect(page.hasMore).toBe(true);
  const previous = await client.sessions.transcript(created.id, { limit: 1, before: 2 });
  expect(previous.items.map((i) => i.id)).toEqual(["itm_1"]);
  const delta = await client.sessions.transcript(created.id, {
    afterRev: page.rev!,
    epoch: page.epoch!,
  });
  expect(delta).toMatchObject({ delta: true, items: [] });
  const reset = await client.sessions.transcript(created.id, {
    afterRev: page.rev!,
    epoch: page.epoch! + 1,
    limit: 1,
  });
  expect(reset).toMatchObject({ reset: true });
});
