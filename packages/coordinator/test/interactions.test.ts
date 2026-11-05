import type { HostCommand, Interaction } from "@switchyard/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  enrollDevice,
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

let t: TestCoordinator | undefined;
let host: FakeHost | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
  await t?.cleanup();
  t = undefined;
});

function pending(id: string, sessionId: string): Interaction {
  return {
    id,
    sessionId,
    revision: 1,
    source: { kind: "extension_ui", method: "select", piRequestIds: ["pi-1"] },
    adapterId: null,
    title: "Pick a fruit",
    presentation: {
      t: "form",
      formId: "f",
      fields: [
        {
          kind: "select",
          name: "value",
          label: "Pick a fruit",
          options: [
            { value: "Apple", label: "Apple" },
            { value: "Banana", label: "Banana" },
          ],
        },
      ],
      submitLabel: "Submit",
    },
    state: "pending",
    resolution: null,
    createdAt: new Date().toISOString(),
  };
}

describe("interaction answers", () => {
  it("answers through the host: one 200, the concurrent loser 409 already_answered", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    const desktop = await enrollDevice(t, "terminal", "desktop");
    const phone = await enrollDevice(t, "terminal", "phone");
    host = await FakeHost.connect(t, creds);
    await host.event("session.updated", hostSession("ses_q", { runtime: "waiting_input" }));
    const interaction = pending("int_q", "ses_q");
    await host.event("interaction.updated", interaction);

    const att = t.c.store.attention.list("resolved_at IS NULL");
    expect(att).toHaveLength(1);
    expect(att[0]).toMatchObject({
      reason: "needs_input",
      interactionId: "int_q",
      deepLink: "/code/ses_q?interaction=int_q",
    });

    // Host-side authority: the first answer wins, later ones get already_answered.
    let resolved: Interaction | null = null;
    const answers: HostCommand[] = [];
    const h = host;
    h.handler = async (cmd) => {
      if (cmd.type !== "session.answer") return null;
      answers.push(cmd);
      if (!resolved) {
        resolved = {
          ...interaction,
          state: "resolved",
          resolution: { by: cmd.deviceId, summary: "Banana", at: new Date().toISOString() },
        };
        await h.event("interaction.updated", resolved);
        return { status: "answered", interaction: resolved };
      }
      return { status: "already_answered", interaction: resolved };
    };
    const body = { revision: 1, response: { kind: "form", values: { value: "Banana" } } };
    const [a, b] = await Promise.all([
      t.api("POST", "/api/interactions/int_q/answer", { token: desktop.credential, body }),
      t.api("POST", "/api/interactions/int_q/answer", { token: phone.credential, body }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const ok = a.status === 200 ? a : b;
    const lost = a.status === 200 ? b : a;
    expect(ok.body).toMatchObject({ status: "answered", interaction: { state: "resolved" } });
    expect(lost.body.error.code).toBe("already_answered");
    expect(lost.body.error.details.interaction.state).toBe("resolved");
    expect(answers.length).toBeGreaterThanOrEqual(1);

    expect(t.c.store.interactions.require("int_q").state).toBe("resolved");
    await until(() => t!.c.store.attention.list("resolved_at IS NULL").length === 0);

    // Once resolved, the coordinator answers 409 without asking the host.
    const before = answers.length;
    const late = await t.api("POST", "/api/interactions/int_q/answer", {
      token: desktop.credential,
      body,
    });
    expect(late.status).toBe(409);
    expect(late.body.error.details.interaction.resolution.summary).toBe("Banana");
    expect(answers.length).toBe(before);
  });

  it("a late answer receipt never regresses a newer interaction", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    host = await FakeHost.connect(t, creds);
    await host.event("session.updated", hostSession("ses_l", { runtime: "waiting_input" }));
    const interaction = pending("int_l", "ses_l");
    await host.event("interaction.updated", interaction);
    const h = host;
    h.handler = async (cmd) => {
      if (cmd.type !== "session.answer") return null;
      const resolved: Interaction = {
        ...interaction,
        state: "resolved",
        resolution: { by: cmd.deviceId, summary: "Banana", at: new Date().toISOString() },
      };
      await h.event("interaction.updated", {
        ...resolved,
        revision: 3,
        resolution: { ...resolved.resolution!, summary: "Banana (confirmed)" },
      });
      return { status: "answered", interaction: { ...resolved, revision: 2 } };
    };
    const r = await t.admin("POST", "/api/interactions/int_l/answer", {
      revision: 1,
      response: { kind: "form", values: { value: "Banana" } },
    });
    expect(r.status).toBe(200);
    expect(r.body.interaction.revision).toBe(3);
    const stored = t.c.store.interactions.require("int_l");
    expect(stored.revision).toBe(3);
    expect(stored.resolution?.summary).toBe("Banana (confirmed)");
  });

  it("returns host_unreachable instead of resolving optimistically", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    host = await FakeHost.connect(t, creds);
    await host.event("session.updated", hostSession("ses_r", { runtime: "waiting_input" }));
    await host.event("interaction.updated", pending("int_r", "ses_r"));
    await host.close();
    await until(() => !t!.c.hostHub.isConnected(creds.hostId));
    const r = await t.admin("POST", "/api/interactions/int_r/answer", {
      revision: 1,
      response: { kind: "cancel" },
    });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("host_unreachable");
    expect(t.c.store.interactions.require("int_r").state).toBe("pending");
  });

  it("raises unsupported_interaction attention for terminal-only dialogs", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    host = await FakeHost.connect(t, creds);
    await host.event("session.updated", hostSession("ses_u", { runtime: "running" }));
    await host.event("interaction.updated", {
      ...pending("int_u", "ses_u"),
      source: { kind: "unsupported_custom", title: null },
      title: "Terminal-only interface requested",
      presentation: { t: "text", text: "unsupported" },
      state: "unsupported",
    });
    const att = t.c.store.attention.list("resolved_at IS NULL");
    expect(att.map((a) => a.reason)).toEqual(["unsupported_interaction"]);
    const ack = await t.admin("POST", `/api/attention/${att[0]!.id}/acknowledge`);
    expect(ack.body.acknowledgedAt).not.toBeNull();
    const list = await t.admin("GET", "/api/attention");
    expect(list.body).toHaveLength(1);
  });

  it("forwards an alternative for an unsupported dialog once and resolves its attention", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    host = await FakeHost.connect(t, creds);
    await host.event("session.updated", hostSession("ses_v", { runtime: "running" }));
    const unsupported: Interaction = {
      ...pending("int_v", "ses_v"),
      source: { kind: "unsupported_custom", title: null },
      title: "Terminal-only interface requested",
      presentation: {
        t: "actions",
        actions: [
          { id: "abort", label: "Stop the run", tone: "danger" },
          { id: "message", label: "Send a message to Pi", tone: "primary" },
        ],
      },
      state: "unsupported",
    };
    await host.event("interaction.updated", unsupported);
    expect(
      t.c.attention.open({ sessionId: "ses_v", reason: "unsupported_interaction" }),
    ).toHaveLength(1);
    const answers: HostCommand[] = [];
    host.handler = async (cmd) => {
      if (cmd.type !== "session.answer") return null;
      answers.push(cmd);
      return {
        status: "answered",
        interaction: {
          ...unsupported,
          resolution: { by: cmd.deviceId, summary: "Stop the run", at: new Date().toISOString() },
        },
      };
    };
    const body = { revision: 1, response: { kind: "action", actionId: "abort" } };
    const r = await t.admin("POST", "/api/interactions/int_v/answer", body);
    expect(r.status).toBe(200);
    expect(r.body.interaction).toMatchObject({
      state: "unsupported",
      resolution: { summary: "Stop the run" },
    });
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ response: { kind: "action", actionId: "abort" } });
    expect(t.c.attention.open({ sessionId: "ses_v", reason: "unsupported_interaction" })).toEqual(
      [],
    );
    // Once an alternative was chosen, later answers are refused without asking the host.
    const again = await t.admin("POST", "/api/interactions/int_v/answer", body);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_answered");
    expect(answers).toHaveLength(1);
  });

  it("resolves unsupported_interaction attention when the host reports the resolution", async () => {
    t = await startCoordinator();
    const creds = await enrollHost(t);
    host = await FakeHost.connect(t, creds);
    await host.event("session.updated", hostSession("ses_w", { runtime: "running" }));
    const base = {
      ...pending("int_w", "ses_w"),
      source: { kind: "unsupported_custom" as const, title: null },
      presentation: { t: "text" as const, text: "unsupported" },
      state: "unsupported" as const,
    };
    await host.event("interaction.updated", base);
    expect(t.c.attention.open({ sessionId: "ses_w" })).toHaveLength(1);
    await host.event("interaction.updated", {
      ...base,
      resolution: { by: "dev_x", summary: "Send a message to Pi", at: base.createdAt },
    });
    expect(t.c.attention.open({ sessionId: "ses_w" })).toEqual([]);
  });
});
