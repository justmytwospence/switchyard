import { DEFAULT_TASK_POLICY, type Project, type Task } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { Store } from "../src/store.js";
import {
  createTask,
  MAX_PARENT_DEPTH,
  validateDependencies,
  validateParent,
} from "../src/tasks/service.js";
import { startCoordinator } from "./helpers.js";

const now = "2026-01-01T00:00:00.000Z";
function project(id = "project"): Project {
  return {
    id,
    name: id,
    repoIdentity: "https://github.com/me/app",
    defaultHostId: null,
    defaultProfileId: null,
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: now,
    updatedAt: now,
  };
}

let store: Store;
let ctx: { store: Store };
beforeEach(() => {
  const db = openDb(":memory:");
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
  ctx = { store };
  store.putProject(project());
});
afterEach(() => store.db.close());

function task(over: Partial<Parameters<typeof createTask>[1]> = {}): Task {
  return createTask(ctx, { projectId: "project", title: "Work", ...over }, { kind: "manual" });
}

function subscribe(child: Task, parent: Task | null = null): void {
  store.st
    .get("INSERT INTO task_subscriptions VALUES (?, 'creator', ?, ?)")
    .run(child.id, parent?.id ?? null, now);
}

function seedHints(checkout = true): void {
  store.hosts.upsert(
    {
      id: "host",
      name: "Host",
      platform: "darwin",
      agentVersion: "0.11.0",
      piVersion: null,
      piCompatible: true,
      capabilities: null,
      connectivity: "unreachable",
      lastSeenAt: null,
      revokedAt: null,
      createdAt: now,
    },
    { credential_hash: "host-credential-hash" },
  );
  store.putProfile({
    id: "profile",
    name: "Profile",
    provider: null,
    model: null,
    thinking: null,
    projectTrust: "ask",
    extraArgs: [],
  });
  if (checkout)
    store.putCheckout({
      id: "checkout",
      projectId: "project",
      hostId: "host",
      path: "/app",
      commonDir: "/app/.git",
      defaultBranch: "main",
      createdAt: now,
    });
}

const agentOrigin = { sessionId: "creator", toolCallId: "tool" };

describe("shared task construction", () => {
  it("keeps manual defaults and creates Ready agent tasks without launching work", () => {
    const root = task();
    expect(root).toMatchObject({
      parentTaskId: null,
      state: "backlog",
      position: 1024,
      policy: DEFAULT_TASK_POLICY,
    });
    const child = createTask(
      ctx,
      {
        projectId: "project",
        title: "Child",
        state: "ready",
        parentTaskId: root.id,
      },
      { kind: "manual" },
      agentOrigin,
    );
    expect(child).toMatchObject({
      parentTaskId: root.id,
      state: "ready",
      position: 2048,
      dependencies: [],
      origin: { kind: "manual" },
      agentOrigin,
      policy: DEFAULT_TASK_POLICY,
      currentRunId: null,
    });
    expect(store.tasks.list("parent_task_id = ?", [root.id]).map((t) => t.id)).toEqual([child.id]);
    expect(store.runs.count()).toBe(0);
    expect(store.sessions.count()).toBe(0);
  });

  it("preserves automation policy, grouping and origin through the shared constructor", () => {
    const origin = {
      kind: "automation" as const,
      automationId: "automation",
      occurrenceId: "occurrence",
      routine: true,
    };
    const created = createTask(
      ctx,
      {
        projectId: "project",
        title: "Routine",
        state: "ready",
        groupingKey: "daily",
        policy: {
          continuation: {
            enabled: true,
            objective: "Keep checking",
            maxContinuations: 3,
            maxElapsedMinutes: 10,
            maxTokens: null,
            maxCostUsd: null,
          },
          completion: { requireHumanReview: false },
        },
      },
      origin,
    );
    expect(created).toMatchObject({
      parentTaskId: null,
      groupingKey: "daily",
      origin,
      policy: {
        continuation: { enabled: true, maxContinuations: 3 },
        completion: { requireHumanReview: false },
      },
    });
    expect(created.agentOrigin).toBeUndefined();
  });

  it("validates agent hints, leaving omitted hints to normal project defaults", () => {
    seedHints(false);
    const input = {
      projectId: "project",
      title: "Agent",
      policy: { hostId: "host", profileId: "profile" },
    };
    expect(() => createTask(ctx, input, { kind: "manual" }, agentOrigin)).toThrow(/checkout/);
    seedHints();
    expect(createTask(ctx, input, { kind: "manual" }, agentOrigin).policy).toMatchObject({
      hostId: "host",
      profileId: "profile",
    });
    store.putHost({ ...store.hosts.require("host"), revokedAt: now });
    expect(() => createTask(ctx, input, { kind: "manual" }, agentOrigin)).toThrow(/revoked/);
    expect(() =>
      createTask(ctx, { ...input, policy: { hostId: "missing" } }, { kind: "manual" }, agentOrigin),
    ).toThrow(/not found/);
    expect(() =>
      createTask(
        ctx,
        { ...input, policy: { profileId: "missing" } },
        { kind: "manual" },
        agentOrigin,
      ),
    ).toThrow(/not found/);
    store.putProject({ ...project(), defaultHostId: "host", defaultProfileId: "profile" });
    expect(
      createTask(ctx, { projectId: "project", title: "Default" }, { kind: "manual" }, agentOrigin)
        .policy,
    ).toEqual(DEFAULT_TASK_POLICY);
  });

  it("rolls constructor writes and events back with an outer receipt transaction", () => {
    const seq = store.currentSeq();
    expect(() =>
      store.tx(() => {
        const child = task();
        subscribe(child);
        throw new Error("receipt failed");
      }),
    ).toThrow("receipt failed");
    expect(store.tasks.count()).toBe(0);
    expect(store.st.get("SELECT * FROM task_subscriptions").all()).toEqual([]);
    expect(store.currentSeq()).toBe(seq);
  });
});

describe("task relationships", () => {
  it("rejects missing, cross-project, self and cyclic parents", () => {
    const root = task();
    const child = task({ parentTaskId: root.id });
    store.putProject(project("other"));
    const other = task({ projectId: "other" });
    expect(() => task({ parentTaskId: "missing" })).toThrow(/not found/);
    expect(() => task({ parentTaskId: other.id })).toThrow(/same project/);
    expect(() => validateParent(ctx, root.id, root.projectId, root.id)).toThrow(/cycle/);
    expect(() => validateParent(ctx, root.id, root.projectId, child.id)).toThrow(/cycle/);
    expect(() => validateParent(ctx, child.id, child.projectId, null)).not.toThrow();
  });

  it("caps ancestry and checks the full subtree's depth on reparenting", () => {
    const root = task();
    let leaf = root;
    for (let i = 0; i < MAX_PARENT_DEPTH; i++) leaf = task({ parentTaskId: leaf.id });
    expect(() => task({ parentTaskId: leaf.id })).toThrow(/depth/);
    const newRoot = task();
    expect(() => validateParent(ctx, root.id, root.projectId, newRoot.id)).toThrow(/depth/);
  });

  it("reuses dependency DFS while grandfathering only existing cross-project edges", () => {
    store.putProject(project("other"));
    const foreign = task({ projectId: "other" });
    expect(() => task({ dependencies: [foreign.id] })).toThrow(/project/);
    const legacy = store.putTask({ ...task(), dependencies: [foreign.id] });
    expect(() =>
      validateDependencies(
        ctx,
        legacy.id,
        legacy.projectId,
        legacy.title,
        [foreign.id],
        legacy.dependencies,
      ),
    ).not.toThrow();
    const another = task({ projectId: "other" });
    expect(() =>
      validateDependencies(
        ctx,
        legacy.id,
        legacy.projectId,
        legacy.title,
        [foreign.id, another.id],
        legacy.dependencies,
      ),
    ).toThrow(/project/);
    const dependent = task({ dependencies: [legacy.id] });
    expect(() =>
      validateDependencies(ctx, legacy.id, legacy.projectId, legacy.title, [dependent.id]),
    ).toThrow(/cycle/);
  });

  it("atomically unlinks only direct children, dependencies and deleted-task subscriptions", () => {
    const root = task();
    const child = task({ parentTaskId: root.id, dependencies: [root.id] });
    const grandchild = task({ parentTaskId: child.id });
    subscribe(root);
    subscribe(child, root);
    const seq = store.currentSeq();
    expect(() =>
      store.tx(() => {
        store.deleteTask(root);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.tasks.require(child.id).parentTaskId).toBe(root.id);
    expect(store.tasks.get(root.id)).toBeDefined();
    expect(store.currentSeq()).toBe(seq);
    expect(store.st.get("SELECT * FROM task_subscriptions").all()).toHaveLength(2);
    store.deleteTask(root);
    expect(store.tasks.get(root.id)).toBeUndefined();
    expect(store.tasks.require(child.id)).toMatchObject({ parentTaskId: null, dependencies: [] });
    expect(store.tasks.require(grandchild.id).parentTaskId).toBe(child.id);
    expect(store.tasks.list("parent_task_id = ?", [root.id])).toEqual([]);
    expect(
      store.st
        .get("SELECT child_task_id, subscriber_session_id, parent_task_id FROM task_subscriptions")
        .all(),
    ).toEqual([
      { child_task_id: child.id, subscriber_session_id: "creator", parent_task_id: null },
    ]);
  });
});

describe("task routes", () => {
  it("distinguishes omitted/null parents and retains legacy dependency edges on PATCH", async () => {
    const t = await startCoordinator({ dispatcher: { tickMs: 0 }, schedulerTickMs: 0 });
    try {
      t.c.store.putProject(project());
      t.c.store.putProject(project("other"));
      const create = (body: Record<string, unknown> = {}) =>
        t.admin("POST", "/api/tasks", { projectId: "project", title: "Work", ...body });
      const root = await create();
      const child = await create({ parentTaskId: root.body.id });
      expect(child.status).toBe(201);
      expect(child.body.parentTaskId).toBe(root.body.id);
      t.c.store.st
        .get("INSERT INTO task_subscriptions VALUES (?, 'creator', ?, ?)")
        .run(child.body.id, root.body.id, now);
      const patch = (body: Record<string, unknown>) =>
        t.admin("PATCH", `/api/tasks/${child.body.id}`, body);
      expect((await patch({ title: "Renamed" })).body.parentTaskId).toBe(root.body.id);
      expect(
        (await t.admin("PATCH", `/api/tasks/${root.body.id}`, { parentTaskId: child.body.id }))
          .status,
      ).toBe(400);
      expect((await patch({ parentTaskId: null })).body.parentTaskId).toBeNull();
      const newParent = await create();
      const reparented = await patch({ parentTaskId: newParent.body.id });
      expect(reparented.body).toMatchObject({ parentTaskId: newParent.body.id, state: "backlog" });
      const foreign = await create({ projectId: "other" });
      expect((await patch({ parentTaskId: foreign.body.id })).status).toBe(400);
      t.c.store.putTask({
        ...t.c.store.tasks.require(child.body.id),
        dependencies: [foreign.body.id],
      });
      expect((await patch({ dependencies: [foreign.body.id], title: "Legacy" })).status).toBe(200);
      expect((await create({ dependencies: [foreign.body.id] })).status).toBe(400);
      expect(
        t.c.store.st
          .get("SELECT parent_task_id FROM task_subscriptions WHERE child_task_id = ?")
          .get(child.body.id),
      ).toEqual({ parent_task_id: root.body.id });
      expect((await t.admin("DELETE", `/api/tasks/${newParent.body.id}`)).status).toBe(200);
      expect(t.c.store.tasks.require(child.body.id)).toMatchObject({
        parentTaskId: null,
        state: "backlog",
        dependencies: [foreign.body.id],
      });
    } finally {
      await t.cleanup();
    }
  });
});
