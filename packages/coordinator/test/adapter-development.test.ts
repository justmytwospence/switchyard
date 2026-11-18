// @module-tag slow
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrollHost,
  FakeHost,
  hostSession,
  NO_REPLY,
  startCoordinator,
  type TestCoordinator,
  until,
} from "./helpers.js";

let t: TestCoordinator | undefined;
const hosts: FakeHost[] = [];
const generation = randomUUID();
const inspection = {
  generation,
  runtimeId: "runtime",
  reloadable: true,
  blockedReason: null,
  adapters: [],
  diagnostics: [],
};
const capabilities = {
  prompt: true,
  steer: true,
  followUp: true,
  abort: true,
  resume: true,
  rename: true,
  importInactive: true,
  extensionDialogs: true,
  customUi: false,
  widgetsText: true,
  widgetsComponent: false,
  tokenAccounting: false,
  costAccounting: false,
  unsupported: [],
  sessionControls: true,
  adapterDevelopment: true,
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const host of hosts.splice(0)) await host.close();
  await t?.cleanup();
  t = undefined;
});

async function setup(enabled = true) {
  t = await startCoordinator();
  const creds = await enrollHost(t);
  const host = new FakeHost(t.c.localUrl.replace("http", "ws"), creds.hostId, creds.credential);
  hosts.push(host);
  host.handler = (command) => {
    if (command.type === "session.adapters") return inspection;
    if (command.type === "session.reloadAdapters") return { generation };
    return null;
  };
  await host.open({
    capabilities: enabled ? capabilities : { ...capabilities, adapterDevelopment: undefined },
  });
  await host.event("session.updated", hostSession("session", { adapterGeneration: generation }));
  return { tc: t, host, creds };
}

const action = { adapterId: "adapter", actionId: "click", payload: { value: 1 }, generation };
const base = "/api/sessions/session";

describe("session adapter development", () => {
  it("inspects, reloads and forwards generation; old actions remain accepted", async () => {
    const { tc, host } = await setup();
    expect(tc.c.store.sessions.require("session").adapterGeneration).toBe(generation);
    expect((await tc.admin("GET", `${base}/adapters`)).body).toEqual(inspection);
    expect((await tc.admin("POST", `${base}/adapters/reload`)).body).toEqual({
      ok: true,
      generation,
    });
    expect((await tc.admin("POST", `${base}/adapter-action`, action)).status).toBe(200);
    expect(host.commands.at(-1)?.command).toEqual({
      type: "session.adapterAction",
      sessionId: "session",
      ...action,
    });
    const { generation: _, ...legacy } = action;
    expect((await tc.admin("POST", `${base}/adapter-action`, legacy)).status).toBe(200);
    expect(host.commands.at(-1)?.command).not.toHaveProperty("generation");
  });

  it("refuses old hosts without disabling legacy actions", async () => {
    const { tc, host } = await setup(false);
    for (const [method, path] of [
      ["GET", "/adapters"],
      ["POST", "/adapters/reload"],
    ]) {
      const response = await tc.admin(method!, base + path);
      expect(response.body).toMatchObject({ error: { code: "unsupported_capability" } });
    }
    expect(host.commands).toHaveLength(0);
    expect((await tc.admin("POST", `${base}/adapter-action`, action)).status).toBe(200);
  });

  it("requires authentication before any dispatch", async () => {
    const { tc, host } = await setup();
    for (const [method, path] of [
      ["GET", "/adapters"],
      ["POST", "/adapters/reload"],
      ["POST", "/adapter-action"],
    ]) {
      expect(
        (await tc.api(method!, base + path, method === "GET" ? {} : { body: action })).status,
      ).toBe(401);
    }
    expect(host.commands).toHaveLength(0);
  });

  it("refuses an offline host", async () => {
    const { tc, host, creds } = await setup();
    await host.close();
    await until(() => !tc.c.hostHub.isConnected(creds.hostId));
    for (const [method, path] of [
      ["GET", "/adapters"],
      ["POST", "/adapters/reload"],
      ["POST", "/adapter-action"],
    ]) {
      const response = await tc.admin(method!, base + path, method === "GET" ? undefined : action);
      expect(response.body).toMatchObject({ error: { code: "host_unreachable" } });
    }
  });

  it.each(["readOnly", "archivedAt"])(
    "permits inspection but blocks mutations for %s",
    async (field) => {
      const { tc, host } = await setup();
      const s = tc.c.store.sessions.require("session");
      tc.c.store.putSession({
        ...s,
        [field]: field === "readOnly" ? true : new Date().toISOString(),
      });
      expect((await tc.admin("GET", `${base}/adapters`)).status).toBe(200);
      expect((await tc.admin("POST", `${base}/adapters/reload`)).status).toBe(
        field === "readOnly" ? 403 : 409,
      );
      expect((await tc.admin("POST", `${base}/adapter-action`, action)).status).toBe(
        field === "readOnly" ? 403 : 409,
      );
      expect(host.commands.map(({ command }) => command.type)).toEqual(["session.adapters"]);
    },
  );

  it("uses the owning host and rejects another host's projection", async () => {
    const { tc, host } = await setup();
    const otherCreds = await enrollHost(tc, "other");
    const other = await FakeHost.connect(tc, otherCreds);
    hosts.push(other);
    const replacement = randomUUID();
    await other.event(
      "session.updated",
      hostSession("session", { adapterGeneration: replacement }),
    );
    expect(tc.c.store.sessions.require("session").adapterGeneration).toBe(generation);
    await tc.admin("GET", `${base}/adapters`);
    expect(host.commands.at(-1)?.command.type).toBe("session.adapters");
    expect(other.commands).toHaveLength(0);
    await host.event("session.updated", { id: "session", adapterGeneration: replacement });
    expect(tc.c.store.sessions.require("session").adapterGeneration).toBe(replacement);
  });

  it.each(["reload", "adapters/reload"])(
    "does not replay %s after host reconnect",
    async (path) => {
      const { tc, host, creds } = await setup();
      host.handler = () => NO_REPLY;
      const pending = tc.admin("POST", `${base}/${path}`);
      await host.waitForCommand(path === "reload" ? "session.reload" : "session.reloadAdapters");
      await host.close();
      await until(() => !tc.c.hostHub.isConnected(creds.hostId));
      const replacement = new FakeHost(
        tc.c.localUrl.replace("http", "ws"),
        creds.hostId,
        creds.credential,
      );
      hosts.push(replacement);
      await replacement.open({ capabilities });
      expect((await pending).body).toMatchObject({ error: { code: "conflict" } });
      expect(replacement.commands).toHaveLength(0);
    },
  );

  it("gives full reload 45 seconds without retrying", async () => {
    const { tc, host } = await setup();
    const request = vi.spyOn(tc.c.hostHub, "request");
    expect((await tc.admin("POST", `${base}/reload`)).status).toBe(200);
    expect(request).toHaveBeenCalledWith(
      host.hostId,
      { type: "session.reload", sessionId: "session" },
      { timeoutMs: 45_000 },
    );
    expect(host.commands.filter(({ command }) => command.type === "session.reload")).toHaveLength(
      1,
    );
  });
});
