import type { Terminal, View } from "@switchyard/protocol";
import { ApiClient } from "@switchyard/terminal";
import { describe, expect, it } from "vitest";
import {
  legacyBinding,
  pickerBinding,
  recordedBinding,
  seedBinding,
  syncTerminal,
} from "../src/mirror/binding.js";
import { stubFetch } from "./helpers.js";

const at = "2026-01-01T00:00:00.000Z";
const view = (id: string, name: string): View => ({
  id,
  name,
  mode: "all",
  projectIds: null,
  hostIds: null,
  sessionIds: [],
  clients: [],
  createdAt: at,
  updatedAt: at,
});
const WORK = view("viw_work", "work");
const PERSONAL = view("viw_personal", "personal");
const ID = "herdr:personal@mac";
const terminal = (over: Partial<Terminal> = {}): Terminal => ({
  id: ID,
  kind: "herdr",
  name: "personal",
  machine: "mac",
  deviceId: "dev_1",
  hostId: null,
  mirror: "none",
  viewId: null,
  bindingSetAt: at,
  shows: [],
  lastSeenAt: at,
  createdAt: at,
  ...over,
});
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("recordedBinding", () => {
  const views = [WORK, PERSONAL];
  it("reads the recorded binding, never the name", () => {
    expect(recordedBinding({ views, terminals: [] }, ID)).toBe("off");
    expect(recordedBinding({ views, terminals: [terminal()] }, ID)).toBe("off");
    expect(recordedBinding({ views, terminals: [terminal({ mirror: "all" })] }, ID)).toBeNull();
    expect(
      recordedBinding({ views, terminals: [terminal({ mirror: "view", viewId: WORK.id })] }, ID),
    ).toBe(WORK);
    expect(
      recordedBinding({ views, terminals: [terminal({ mirror: "view", viewId: "viw_gone" })] }, ID),
    ).toBe("off");
  });

  it("reads a record from before mirror existed by its view", () => {
    const old = terminal({ viewId: WORK.id });
    delete (old as Partial<Terminal>).mirror;
    expect(recordedBinding({ views, terminals: [old] }, ID)).toBe(WORK);
  });
});

describe("seedBinding", () => {
  const st = { views: [WORK, PERSONAL] };
  it("takes SWITCHYARD_VIEW, by name or id", () => {
    expect(seedBinding({ SWITCHYARD_VIEW: "work" }, "personal", st, false)).toEqual({
      mirror: "view",
      viewId: WORK.id,
    });
    expect(seedBinding({ SWITCHYARD_VIEW: WORK.id }, "x", st, true)).toEqual({
      mirror: "view",
      viewId: WORK.id,
    });
  });

  it("waits while SWITCHYARD_VIEW names no view", () => {
    expect(seedBinding({ SWITCHYARD_VIEW: "later" }, "personal", st, true)).toBeUndefined();
  });

  it("takes the view named after the session only if it was mirroring", () => {
    expect(seedBinding({}, "personal", st, true)).toEqual({
      mirror: "view",
      viewId: PERSONAL.id,
    });
    expect(seedBinding({}, "personal", st, false)).toEqual({ mirror: "none" });
    expect(seedBinding({}, "default", st, true)).toEqual({ mirror: "none" });
  });
});

describe("pickerBinding and legacyBinding", () => {
  it("uses the recorded binding when there is one, else SWITCHYARD_VIEW, never the name", () => {
    const views = [WORK, PERSONAL];
    expect(pickerBinding({ views, terminals: [terminal({ mirror: "all" })] }, {}, ID)).toBeNull();
    expect(pickerBinding({ views, terminals: [] }, { SWITCHYARD_VIEW: "work" }, ID)).toBe(WORK);
    expect(pickerBinding({ views, terminals: [] }, {}, ID)).toBe("off");
  });

  it("legacy: SWITCHYARD_VIEW, else the session's name", () => {
    expect(legacyBinding({ views: [WORK, PERSONAL] }, {}, "personal")).toBe(PERSONAL);
    expect(legacyBinding({ views: [WORK] }, { SWITCHYARD_VIEW: "work" }, "x")).toBe(WORK);
    expect(legacyBinding({ views: [WORK] }, {}, "x")).toBe("off");
  });
});

describe("syncTerminal", () => {
  const info = { id: ID, kind: "herdr" as const, name: "personal", machine: "mac", hostId: null };
  const path = "PUT /api/terminals/herdr%3Apersonal%40mac";

  it("reports with a seed until a binding is recorded, then without", async () => {
    let st: { views: View[]; terminals: Terminal[] } = { views: [WORK], terminals: [] };
    const listeners: (() => void)[] = [];
    const { fetch, calls } = stubFetch({
      [path]: (c) => terminal({ mirror: (c.body as any).seed?.mirror, viewId: WORK.id }),
    });
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    const sync = syncTerminal({
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
      seed: { mirror: "view", viewId: WORK.id },
    });
    expect(sync.binding()).toBe("off");
    st = { views: [WORK], terminals: [terminal({ mirror: "view", viewId: WORK.id })] };
    for (const l of listeners) l();
    expect(sync.binding()).toBe(WORK);
    sync.report();
    await tick();
    expect(calls).toHaveLength(1); // shows unchanged
    await sync.stop();
  });

  it("falls back to 0.19 surfaces and name binding on a coordinator without terminals", async () => {
    const { fetch, calls } = stubFetch({
      "PUT /api/surfaces/herdr%3Apersonal%40mac": () => ({}),
      "DELETE /api/surfaces/herdr%3Apersonal%40mac": () => ({ ok: true }),
    });
    const api = new ApiClient({ coordinatorUrl: "http://coord", credential: "c", fetch });
    const sync = syncTerminal({
      api,
      info,
      state: () => ({ views: [PERSONAL] }),
      subscribe: () => () => {},
      env: {},
      wasMirroring: false,
      log: () => {},
    });
    await tick();
    expect(sync.binding()).toBe(PERSONAL);
    expect(calls.map((c) => `${c.method} ${c.path.split("/")[2]}`)).toEqual([
      "PUT terminals",
      "PUT surfaces",
    ]);
    expect(calls[1]!.body).toMatchObject({ viewId: PERSONAL.id });
    await sync.stop();
    expect(calls.at(-1)!.method).toBe("DELETE");
  });
});
