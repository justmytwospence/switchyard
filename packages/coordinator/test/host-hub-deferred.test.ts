import { type Session, SwitchyardError } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../src/services.js";
import {
  enrollHost,
  FakeHost,
  hostSession,
  NO_REPLY,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

const prompt = {
  type: "session.prompt" as const,
  sessionId: "session",
  text: "continue with the original text",
  images: [],
  mode: "prompt" as const,
  origin: "automation" as const,
  controlRevision: 1,
};
const commandId = "cont_run_1";
const deferred = () => ({
  defer: true as const,
  reason: "Waiting for policy enforcement to reconnect.",
});
const features = ["agentRequests.v1", "policies.v1"];
const bridge: NonNullable<Session["bridge"]> = {
  version: 1,
  runtimeId: "runtime",
  nativeSessionId: "native-session",
  controllerEpoch: "controller",
  agentTools: true,
  messageDelivery: true,
  policyState: "lost",
  policyPhases: [],
};

let t: TestCoordinator;
const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  if (t) await t.cleanup();
});

async function setup() {
  t = await startCoordinator({ projectScanIntervalMs: 0, cacheAlertTickMs: 0 });
  const creds = await enrollHost(t);
  async function connect(negotiated: string[] | undefined = features) {
    const host = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
    hosts.push(host);
    await host.open({ features: negotiated });
    return host;
  }
  const host = await connect();
  return { host, connect, hostId: creds.hostId, hub: t.c.hostHub, store: t.c.store };
}

async function publishSession(host: FakeHost, hostId: string) {
  await host.event("session.updated", hostSession("session", { bridge }));
  requireService(t.c.ctx, "policies").bindBoundary(
    {
      authenticatedHostId: hostId,
      sessionId: "session",
      nativeSessionId: bridge.nativeSessionId,
      runtimeId: bridge.runtimeId,
    },
    {
      cwd: "/tmp/repo",
      cwdReal: "/tmp/repo",
      workspaceRoot: "/tmp/repo",
      workspaceRootReal: "/tmp/repo",
    },
  );
}

const active = { ...bridge, policyState: "active" as const, policyPhases: ["request" as const] };

describe("HostHub deferred beforeSend over real host connections", () => {
  it("holds the promise/frame without writing, then sends once with the original command and guard", async () => {
    const { host, hub, hostId } = await setup();
    let ready = false;
    let mayHaveSent = 0;
    const guard = vi.fn(() => {
      if (!ready) return deferred();
      mayHaveSent++;
    });
    host.handler = () => NO_REPLY;
    const settled = vi.fn();
    const pending = hub.request(hostId, prompt, { commandId, beforeSend: guard });
    void pending.then(settled);
    hub.retryDeferred("another-host");
    expect(guard).toHaveBeenCalledTimes(1);
    hub.retryDeferred(hostId);
    await host.event("session.updated", hostSession("unrelated"));
    expect(guard).toHaveBeenCalledTimes(2);
    expect(host.commands).toEqual([]);
    expect(mayHaveSent).toBe(0);
    expect(settled).not.toHaveBeenCalled();

    ready = true;
    hub.retryDeferred(hostId);
    await until(() => host.commands.length === 1);
    expect(host.commands).toEqual([{ commandId, command: prompt }]);
    expect(mayHaveSent).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    hub.retryDeferred(hostId);
    await host.event("session.updated", hostSession("unrelated", { title: "updated" }));
    expect(host.commands).toHaveLength(1);
    expect(guard).toHaveBeenCalledTimes(3);
    host.sendRaw({ type: "receipt", receipt: { commandId, ok: true, result: "accepted" } });
    await expect(pending).resolves.toBe("accepted");
    hub.retryDeferred(hostId);
    expect(guard).toHaveBeenCalledTimes(3);
  });

  it("pumps on welcome but waits for a committed active bridge, not lost/empty phases", async () => {
    const { host, connect, hub, store, hostId } = await setup();
    await publishSession(host, hostId);
    let mayHaveSent = 0;
    const guard = vi.fn(() => {
      expect(store.inTransaction).toBe(false);
      if (store.sessions.require("session").bridge?.policyState !== "active") return deferred();
      mayHaveSent++;
    });
    const pending = hub.request(hostId, prompt, { commandId, beforeSend: guard });
    await host.close();
    await until(() => !hub.isConnected(hostId));
    hub.retryDeferred(hostId);
    expect(guard).toHaveBeenCalledTimes(1);
    const next = await connect();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(next.commands).toHaveLength(0);
    await next.event("session.updated", {
      id: "session",
      bridge: { ...bridge, policyState: "initializing" },
    });
    expect(guard).toHaveBeenCalledTimes(3);
    expect(next.commands).toHaveLength(0);
    expect(mayHaveSent).toBe(0);
    await next.event("session.updated", { id: "session", bridge: active });
    await expect(pending).resolves.toBeNull();
    expect(guard).toHaveBeenCalledTimes(4);
    expect(mayHaveSent).toBe(1);
    expect(next.commands).toEqual([{ commandId, command: prompt }]);
    hub.retryDeferred(hostId);
    expect(guard).toHaveBeenCalledTimes(4);
  });

  it("defers a previously written frame on reconnect until its full current guard is ready again", async () => {
    const { host, connect, hub, hostId } = await setup();
    await publishSession(host, hostId);
    await host.event("session.updated", { id: "session", bridge: active });
    host.handler = () => NO_REPLY;
    let mayHaveSent = 0;
    const guard = vi.fn(() => {
      if (t.c.store.sessions.require("session").bridge?.policyState !== "active") return deferred();
      mayHaveSent++;
    });
    const pending = hub.request(hostId, prompt, { commandId, beforeSend: guard });
    await until(() => host.commands.length === 1);
    await host.event("session.updated", { id: "session", bridge });
    expect(guard).toHaveBeenCalledTimes(1);
    await host.close();
    const next = await connect();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(next.commands).toHaveLength(0);
    expect(mayHaveSent).toBe(1);
    await next.event("session.updated", { id: "session", bridge: active });
    await expect(pending).resolves.toBeNull();
    expect(guard).toHaveBeenCalledTimes(3);
    expect(mayHaveSent).toBe(2);
    expect(next.commands).toEqual(host.commands);
  });

  it("does not pump an uncommitted or rolled-back bridge projection", async () => {
    const { host, hub, store, hostId } = await setup();
    await publishSession(host, hostId);
    const guard = vi.fn(() => {
      expect(store.inTransaction).toBe(false);
      return store.sessions.require("session").bridge?.policyState === "active"
        ? undefined
        : deferred();
    });
    const pending = hub.request(hostId, prompt, { commandId, beforeSend: guard });
    expect(() =>
      store.tx(() => {
        hub.applyHostEvent(hostId, 100, {
          eventId: "rolled-back",
          type: "session.updated",
          sessionId: "session",
          at: store.nowIso(),
          data: { id: "session", bridge: active },
        });
        expect(guard).toHaveBeenCalledTimes(1);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(store.sessions.require("session").bridge?.policyState).toBe("lost");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(host.commands).toHaveLength(0);
    await host.event("session.updated", { id: "session", bridge: active });
    await expect(pending).resolves.toBeNull();
    expect(guard).toHaveBeenCalledTimes(2);
    expect(host.commands).toEqual([{ commandId, command: prompt }]);
  });

  it.each([
    { negotiated: ["agentRequests.v1"] },
    { negotiated: ["policies.v1"] },
    { negotiated: [] },
  ])(
    "rechecks current negotiated features on replacement ($negotiated), rejecting/removing incompatible frames",
    async ({ negotiated }) => {
      const { host, connect, hub, hostId } = await setup();
      let calls = 0;
      const guard = () => {
        calls++;
        const current = hub.negotiatedFeatures(hostId);
        if (!features.every((feature) => current.has(feature)))
          throw new SwitchyardError("unsupported_capability", "Replacement lacks policy support");
        return deferred();
      };
      const pending = hub.request(hostId, prompt, { commandId, beforeSend: guard });
      const failure = expect(pending).rejects.toMatchObject({ code: "unsupported_capability" });
      await host.close();
      const next = await connect(negotiated);
      await failure;
      expect(next.commands).toHaveLength(0);
      expect(calls).toBe(2);
      hub.retryDeferred(hostId);
      await next.close();
      const supported = await connect();
      expect(supported.commands).toHaveLength(0);
      expect(calls).toBe(2);
    },
  );

  it("removes permanent guard failures and rejects every joined waiter without later replay", async () => {
    const { host, connect, hub, hostId } = await setup();
    let stale = false;
    const error = new SwitchyardError("stale_control", "Root changed while waiting");
    const guard = vi.fn(() => {
      if (stale) throw error;
      return deferred();
    });
    const pending = hub.send(hostId, prompt, { commandId, beforeSend: guard });
    const joined = hub.send(hostId, prompt, { commandId, beforeSend: guard });
    stale = true;
    hub.retryDeferred(hostId);
    await expect(pending).rejects.toBe(error);
    await expect(joined).rejects.toBe(error);
    expect(host.commands).toHaveLength(0);
    hub.retryDeferred(hostId);
    await host.close();
    expect((await connect()).commands).toHaveLength(0);
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it("keeps the original timeout across deferrals and never writes after the promise expires", async () => {
    const { host, connect, hub, hostId } = await setup();
    await publishSession(host, hostId);
    let ready = false;
    const guard = vi.fn(() => (ready ? undefined : deferred()));
    const pending = hub.request(hostId, prompt, { commandId, timeoutMs: 40, beforeSend: guard });
    hub.retryDeferred(hostId);
    await expect(pending).rejects.toMatchObject({ code: "timeout" });
    expect(guard).toHaveBeenCalledTimes(2);
    ready = true;
    hub.retryDeferred(hostId);
    await host.event("session.updated", { id: "session", bridge: active });
    expect(host.commands).toHaveLength(0);
    await host.close();
    const next = await connect();
    await next.event("session.updated", { id: "session", bridge });
    expect(next.commands).toHaveLength(0);
    expect(guard).toHaveBeenCalledTimes(2);
  });
});
