import type { Task } from "@switchyard/protocol";
import { describe, expect, it } from "vitest";
import { session } from "../../terminal/test/fixtures.js";
import { ApiRequestError, SwitchyardClient, WaitError } from "../src/index.js";

const task = (over: Partial<Task> = {}) => ({ id: "task", state: "backlog", ...over }) as Task;
const url = "http://fixture";
function fixture(fetch: (input: string, init?: RequestInit) => Promise<Response>) {
  return new SwitchyardClient({ coordinatorUrl: url, credential: "secret", fetch });
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe("REST facade", () => {
  it("encodes IDs and filters, leaves schema-defaulted create fields optional", async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const client = fixture(async (path, init) => {
      requests.push({ path, init });
      return json([]);
    });
    try {
      await client.sessions.create({ projectId: "p", workspace: { existingId: "w" } });
      await client.sessions.send("a/b ?", { text: "hello" });
      await client.tasks.create({ projectId: "p", title: "title" });
      await client.tasks.list({
        projectId: "a&b",
        state: ["backlog", "ready"],
        includeHidden: true,
      });
      await client.sessions.transcript("a/b ?", { afterRev: 4, epoch: 2 });
      expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer secret" });
      expect(requests[0]?.init?.body).toBe(
        JSON.stringify({ projectId: "p", workspace: { existingId: "w" } }),
      );
      expect(requests[1]?.path).toContain("a%2Fb%20%3F/prompt");
      expect(requests[3]?.path).toContain(
        "projectId=a%26b&state=backlog%2Cready&includeHidden=true",
      );
      expect(requests[4]?.path).toContain("afterRev=4&epoch=2");
      expect(() => client.sessions.transcript("s", { before: 1, afterRev: 2, epoch: 0 })).toThrow();
      expect(() => client.sessions.transcript("s", { afterRev: 2 })).toThrow();
    } finally {
      client.close();
    }
  });

  it("preserves abort, invalid JSON, status and never retries a write", async () => {
    let calls = 0;
    const abort = new AbortController();
    abort.abort();
    const client = fixture(async (_path, init) => {
      calls++;
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return new Response('{"error":{"code":"conflict","message":"No","details":{"x":1}}}', {
        status: 409,
      });
    });
    try {
      await expect(
        client.tasks.create({ projectId: "p", title: "x" }, { signal: abort.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      await expect(client.tasks.create({ projectId: "p", title: "x" })).rejects.toMatchObject({
        code: "conflict",
        status: 409,
        details: { x: 1 },
      });
      expect(calls).toBe(2);
    } finally {
      client.close();
    }
    const invalid = fixture(async () => new Response("{", { status: 200 }));
    await expect(invalid.tasks.list()).rejects.toMatchObject({ code: "invalid_response" });
    invalid.close();
    expect(ApiRequestError).toBeDefined();
  });
});

describe("entity waits", () => {
  it("resolves initial idle and rejects terminal states with last entity", async () => {
    const idle = session();
    const client = fixture(async (path) =>
      json(path.includes("tasks") ? task({ state: "canceled" }) : idle),
    );
    try {
      await expect(client.sessions.waitForFinish(idle.id, { timeoutMs: 1000 })).resolves.toEqual(
        idle,
      );
      await expect(
        client.tasks.waitForState("task", "done", { timeoutMs: 1000 }),
      ).rejects.toMatchObject({ code: "task_canceled", lastEntity: { state: "canceled" } });
      await expect(
        client.tasks.waitForState("task", "canceled", { timeoutMs: 1000 }),
      ).resolves.toMatchObject({ state: "canceled" });
      expect(() => client.tasks.waitForState("task", [])).toThrow();
    } finally {
      client.close();
    }
    for (const runtime of ["failed", "interrupted", "stopped"] as const) {
      const c = fixture(async () => json(session({ runtime })));
      await expect(c.sessions.waitForFinish("ses_1", { timeoutMs: 1000 })).rejects.toMatchObject({
        code: `session_${runtime}`,
      });
      c.close();
    }
  });

  it("waits for empty queues, notices watched changes during REST and ignores unrelated updates", async () => {
    let finish!: (response: Response) => void;
    const client = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const waiting = client.sessions.waitForFinish("ses_1", { timeoutMs: 1000 });
    client.connection.store.update((state) => ({
      ...state,
      synced: true,
      sessions: { ses_1: session({ runtime: "running" }) },
    }));
    client.connection.store.update((state) => ({ ...state, projects: { ...state.projects } }));
    finish(json(session())); // stale watched-entity read, must not resolve
    client.connection.store.update((state) => ({
      ...state,
      sessions: { ses_1: session({ queue: { steering: ["queued"], followUp: [] } }) },
    }));
    client.connection.store.update((state) => ({ ...state, sessions: { ses_1: session() } }));
    await expect(waiting).resolves.toMatchObject({ runtime: "idle" });
    client.close();
  });

  it("does not misclassify a newly created task missing from an earlier snapshot", async () => {
    const client = fixture(async () => json(task({ state: "done" })));
    client.connection.store.update((state) => ({ ...state, synced: true }), true);
    await expect(
      client.tasks.waitForState("task", "done", { timeoutMs: 1000 }),
    ).resolves.toMatchObject({ state: "done" });
    client.close();
  });

  it("a snapshot reset invalidates an in-flight stale read and confirms absence by REST", async () => {
    let resolve!: (value: Response) => void;
    let calls = 0;
    const client = fixture(() => {
      calls++;
      if (calls > 1)
        return Promise.resolve(json({ error: { code: "not_found", message: "missing" } }, 404));
      return new Promise((done) => {
        resolve = done;
      });
    });
    const waiting = client.tasks.waitForState("task", "done", { timeoutMs: 1000 });
    client.connection.store.update(
      (state) => ({ ...state, synced: true, tasks: { task: task() } }),
      true,
    );
    client.connection.store.update((state) => ({ ...state, tasks: {} }), true);
    resolve(json(task({ state: "done" })));
    await expect(waiting).rejects.toMatchObject({
      code: "not_found",
      lastEntity: { state: "backlog" },
    });
    expect(calls).toBe(2);
    client.close();
  });

  it("fails on 404/auth, abort, timeout and close without retaining active fetches", async () => {
    const notFound = fixture(async () =>
      json({ error: { code: "not_found", message: "missing" } }, 404),
    );
    await expect(
      notFound.tasks.waitForState("missing", "done", { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "not_found" });
    notFound.close();
    const unauthorized = fixture(async () =>
      json({ error: { code: "unauthorized", message: "revoked" } }, 401),
    );
    await expect(
      unauthorized.sessions.waitForFinish("x", { timeoutMs: 1000 }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    unauthorized.close();
    const pending = fixture(async () => json(session({ runtime: "running" })));
    const controller = new AbortController();
    const aborted = pending.sessions.waitForFinish("ses_1", { signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });
    await expect(pending.sessions.waitForFinish("ses_1", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "timeout",
    });
    const closed = pending.sessions.waitForFinish("ses_1");
    pending.close();
    await expect(closed).rejects.toMatchObject({ code: "closed" });
    expect(WaitError).toBeDefined();
  });
});
