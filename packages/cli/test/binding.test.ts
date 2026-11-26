import type { Client, Scope } from "@switchyard/protocol";
import { ApiClient } from "@switchyard/terminal";
import { describe, expect, it } from "vitest";
import { pickerBinding, recordedBinding, seedBinding, syncClient } from "../src/mirror/binding.js";
import { stubFetch } from "./helpers.js";

const at = "2026-01-01T00:00:00.000Z";
const scope = (id: string, name: string): Scope => ({
  id,
  name,
  mode: "all",
  projectIds: null,
  hostIds: null,
  sessionIds: [],
  source: null,
  createdAt: at,
  updatedAt: at,
});
const WORK = scope("viw_work", "work");
const PERSONAL = scope("viw_personal", "personal");
const ID = "herdr:personal@mac";
const client = (over: Partial<Client> = {}): Client => ({
  id: ID,
  kind: "herdr",
  name: "personal",
  machine: "mac",
  deviceId: "dev_1",
  hostId: null,
  mirror: "none",
  scopeId: null,
  bindingSetAt: at,
  shows: [],
  lastSeenAt: at,
  createdAt: at,
  ...over,
});
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("recordedBinding", () => {
  const scopes = [WORK, PERSONAL];
  it("reads the recorded binding, never the name", () => {
    expect(recordedBinding({ scopes, clients: [] }, ID)).toBe("off");
    expect(recordedBinding({ scopes, clients: [client()] }, ID)).toBe("off");
    expect(recordedBinding({ scopes, clients: [client({ mirror: "all" })] }, ID)).toBeNull();
    expect(
      recordedBinding({ scopes, clients: [client({ mirror: "scope", scopeId: WORK.id })] }, ID),
    ).toBe(WORK);
    expect(
      recordedBinding({ scopes, clients: [client({ mirror: "scope", scopeId: "viw_gone" })] }, ID),
    ).toBe("off");
  });
});

describe("seedBinding", () => {
  const st = { scopes: [WORK, PERSONAL] };
  it("takes SWITCHYARD_VIEW, by name or id", () => {
    expect(seedBinding({ SWITCHYARD_VIEW: "work" }, "personal", st, false)).toEqual({
      mirror: "scope",
      scopeId: WORK.id,
    });
    expect(seedBinding({ SWITCHYARD_VIEW: WORK.id }, "x", st, true)).toEqual({
      mirror: "scope",
      scopeId: WORK.id,
    });
  });

  it("waits while SWITCHYARD_VIEW names no scope", () => {
    expect(seedBinding({ SWITCHYARD_VIEW: "later" }, "personal", st, true)).toBeUndefined();
  });

  it("takes the scope named after the session only if it was mirroring", () => {
    expect(seedBinding({}, "personal", st, true)).toEqual({
      mirror: "scope",
      scopeId: PERSONAL.id,
    });
    expect(seedBinding({}, "personal", st, false)).toEqual({ mirror: "none" });
    expect(seedBinding({}, "default", st, true)).toEqual({ mirror: "none" });
  });
});

describe("pickerBinding", () => {
  it("uses the recorded binding when there is one, else SWITCHYARD_VIEW, never the name", () => {
    const scopes = [WORK, PERSONAL];
    expect(pickerBinding({ scopes, clients: [client({ mirror: "all" })] }, {}, ID)).toBeNull();
    expect(pickerBinding({ scopes, clients: [] }, { SWITCHYARD_VIEW: "work" }, ID)).toBe(WORK);
    expect(pickerBinding({ scopes, clients: [] }, {}, ID)).toBe("off");
  });
});

describe("syncClient", () => {
  const info = { id: ID, kind: "herdr" as const, name: "personal", machine: "mac", hostId: null };
  const path = "PUT /api/clients/herdr%3Apersonal%40mac";

  it("reports with a seed until a binding is recorded, then without", async () => {
    let st: { scopes: Scope[]; clients: Client[] } = { scopes: [WORK], clients: [] };
    const listeners: (() => void)[] = [];
    const { fetch, calls } = stubFetch({
      [path]: (c) => client({ mirror: (c.body as any).seed?.mirror, scopeId: WORK.id }),
    });
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    const sync = syncClient({
      api,
      info,
      state: () => st,
      subscribe: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      env: { SWITCHYARD_VIEW: "work" },
      wasMirroring: false,
      shows: () => ["ses_1"],
      log: () => {},
    });
    await tick();
    expect(calls[0]!.body).toEqual({
      kind: "herdr",
      name: "personal",
      machine: "mac",
      hostId: null,
      shows: ["ses_1"],
      seed: { mirror: "scope", scopeId: WORK.id },
    });
    expect(sync.binding()).toBe("off");
    st = { scopes: [WORK], clients: [client({ mirror: "scope", scopeId: WORK.id })] };
    for (const l of listeners) l();
    expect(sync.binding()).toBe(WORK);
    sync.report();
    await tick();
    expect(calls).toHaveLength(1); // shows unchanged
    await sync.stop();
  });

  it("an older coordinator logs once and mirrors nothing", async () => {
    // No /api/clients route: the stub answers 404 "No route ...", as the coordinator does.
    const { fetch, calls } = stubFetch({});
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    const lines: string[] = [];
    const listeners: (() => void)[] = [];
    const sync = syncClient({
      api,
      info,
      state: () => ({ scopes: [PERSONAL], clients: [] }),
      subscribe: (fn) => {
        listeners.push(fn);
        return () => {};
      },
      env: { SWITCHYARD_VIEW: "personal" },
      wasMirroring: true,
      log: (l) => lines.push(l),
    });
    await tick();
    expect(sync.binding()).toBe("off");
    expect(lines).toEqual([
      "this coordinator is older than this CLI (it has no clients): upgrade the coordinator",
    ]);
    for (const l of listeners) l();
    sync.report();
    await tick();
    expect(calls).toHaveLength(1);
    expect(lines).toHaveLength(1);
    await sync.stop();
  });
});
