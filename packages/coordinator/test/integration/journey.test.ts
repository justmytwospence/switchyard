import type { AttentionItem, Interaction, Session, Task } from "@switchyard/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Integration, steps, uiResponses, WsClient, waitFor } from "./harness.js";

/**
 * The spec §1 acceptance journey through the API: create a task on the phone; the coordinator
 * dispatches it to the host, creates a repo-local worktree and starts Pi; a plugin asks a
 * question, answered on desktop and reflected everywhere; the terminal takes over and returns
 * the session to automation; the coordinator restarts mid-run without duplicating it; the task
 * finishes into Review and the notification opens the result.
 */
describe("acceptance journey", { timeout: 180_000 }, () => {
  let env: Integration;
  beforeAll(async () => {
    env = await Integration.create();
  });
  afterAll(async () => {
    await env?.dispose();
  });

  it("phone task -> host worktree -> desktop answer -> terminal takeover -> restart -> Review", async () => {
    const { terminal, desktop, mobile } = env.devices!;
    // The phone receives pushes; nobody is at a desk.
    await env.ok("POST", "/api/push/subscriptions", {
      as: mobile,
      body: {
        endpoint: "https://push.example.test/phone",
        keys: { p256dh: "p256dh-key", auth: "auth-key" },
      },
    });
    await env.ok("PATCH", `/api/devices/${mobile.id}`, { body: { preferredMobile: true } });
    const clients = {
      terminal: await env.connect(terminal),
      desktop: await env.connect(desktop),
      mobile: await env.connect(mobile),
    };

    // 1. Create the task as the mobile device, then make it Ready.
    const created = (await env.ok("POST", "/api/tasks", {
      as: mobile,
      body: {
        projectId: env.project.id,
        title: "Fix the flaky login",
        objective: `Make login reliable. ${steps("select", "slow:5000", "done")}`,
        acceptanceCriteria: ["Login works twice in a row"],
      },
    })) as Task;
    expect(created.state).toBe("backlog");
    const moved = await env.api("POST", `/api/tasks/${created.id}/move`, {
      as: mobile,
      body: { to: "ready" },
    });
    expect(moved.status).toBe(200);
    const taskId = created.id;

    // 2. Dispatched to the host into a repo-local worktree, Pi started with extensions.
    const run = await env.waitRun(
      taskId,
      (r) => r.state === "running" || r.state === "waiting_input",
      "dispatched",
    );
    const sid = run.sessionId!;
    const session = await env.waitSession(sid, (s) => s.nativeHandle !== null, "native handle");
    expect(session.cwd.startsWith(`${env.repo!.path}/.worktrees/`)).toBe(true);
    const ws = env.c.store.workspaces.require(session.workspaceId!);
    expect(ws).toMatchObject({ provenance: "managed", path: session.cwd });
    const pid = await env.livePi(sid);
    expect(env.commandsOf("dispatch.start")).toHaveLength(1);

    // 3. The plugin asks; the phone is notified with a deep link to the question.
    const q = await env.pendingInteraction(sid);
    expect(q.title).toBe("Pick a fruit");
    await waitFor(
      () => env.pushes.some((p) => p.payload.type === "show" && p.payload.url.includes(q.id)),
      "question push",
    );
    const qPush = env.pushes.find((p) => p.payload.type === "show")!;
    expect(qPush.endpoint).toBe("https://push.example.test/phone");
    expect(qPush.payload).toMatchObject({
      tag: `session-${sid}`,
      url: `/code/${sid}?interaction=${q.id}`,
    });
    // Answered on desktop; every client sees `resolved`.
    const ans = await env.api("POST", `/api/interactions/${q.id}/answer`, {
      as: desktop,
      body: { revision: q.revision, response: { kind: "form", values: { value: "Banana" } } },
    });
    expect(ans.status).toBe(200);
    for (const cl of Object.values(clients)) {
      const e = await cl.waitEvent(
        (x) =>
          x.type === "interaction.updated" &&
          (x.data as Interaction).id === q.id &&
          (x.data as Interaction).state === "resolved",
        "resolved on every client",
      );
      expect((e.data as Interaction).resolution!.by).toBe(desktop.id);
    }
    expect(uiResponses.filter((r) => r.pid === pid).map((r) => r.body)).toEqual([
      { value: "Banana" },
    ]);
    await waitFor(
      () =>
        env.pushes.some((p) => p.payload.type === "clear" && p.payload.tag === `session-${sid}`),
      "question notification cleared",
    );

    // 4. The terminal attaches (sees the live session) and takes over, then hands it back.
    await waitFor(
      () =>
        env.c.store
          .listItems(sid, { limit: 1000 })
          .items.some(
            (i) => i.kind === "tool" && (i.data as { name: string }).name === "fixture_slow",
          ),
      "slow tool running",
    );
    const attached = (await env.ok("GET", `/api/sessions/${sid}`, { as: terminal })) as Session;
    expect(attached.runtime).toBe("running");
    const took = await env.ok("POST", `/api/sessions/${sid}/takeover`, { as: terminal });
    expect(took.run.controlMode).toBe("human");
    const back = await env.ok("POST", `/api/sessions/${sid}/return-to-automation`, {
      as: terminal,
    });
    expect(back.run.controlMode).toBe("automation");
    expect(back.run.controlRevision).toBe(took.run.controlRevision + 1);

    // 7. The coordinator restarts mid-run; the host keeps going and replays its outbox.
    expect(env.hostSettles(sid)).toBe(0);
    const cursor = clients.mobile.lastSeq;
    await env.stopCoordinator();
    await waitFor(() => env.hostSettles(sid) > 0, "settled while the coordinator was down");
    await env.restartCoordinator();
    await env.waitHostConnected();

    // 5. The task reaches Review, once, from the single run.
    const reviewed = await env.waitTaskState(taskId, "review");
    expect(reviewed.currentRunId).toBe(run.id);
    expect(env.c.store.runs.list("task_id = ?", [taskId])).toHaveLength(1);
    expect(env.run(taskId)!.state).toBe("succeeded");
    expect(env.commandsOf("dispatch.start")).toHaveLength(1);
    expect(env.agent!.spawnedPiProcesses).toBe(1);

    // 6. The notification opens the result: attention deep link -> /tasks/<id>.
    const attention = (await env.ok("GET", `/api/attention?taskId=${taskId}`, {
      as: mobile,
    })) as AttentionItem[];
    const review = attention.find((a) => a.reason === "ready_for_review")!;
    expect(review.deepLink).toBe(`/tasks/${taskId}`);
    await waitFor(
      () =>
        env.pushes.some((p) => p.payload.type === "show" && p.payload.url === `/tasks/${taskId}`),
      "review push",
    );
    const rPush = env.pushes.filter((p) => p.payload.type === "show").at(-1)!;
    expect(rPush.endpoint).toBe("https://push.example.test/phone");
    const opened = (await env.ok("GET", `/api/tasks/${taskId}`, { as: mobile })) as Task;
    expect(opened.state).toBe("review");
    expect(opened.sessionId).toBe(sid);

    // The phone reconnects with its cursor and catches up by replay.
    const phone = await WsClient.open(env.url, { ...env.headersFor(mobile), origin: env.url });
    env.clients.push(phone);
    await phone.hello(cursor);
    expect(phone.messages.find((m) => m.type === "replay" || m.type === "snapshot")!.type).toBe(
      "replay",
    );
    await phone.waitEvent(
      (e) =>
        e.type === "task.updated" &&
        (e.data as Task).id === taskId &&
        (e.data as Task).state === "review",
      "review replayed",
    );
  });
});
