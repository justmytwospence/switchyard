import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@switchyard/protocol";
import { ApiClient } from "@switchyard/terminal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MirrorState } from "../src/mirror/state.js";
import type { TmuxEvent } from "../src/tmux/client.js";
import { TmuxDaemon } from "../src/tmux/daemon.js";
import { session } from "./herdr-fixtures.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sy-tmux-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(sessions: Session[], windows: string[]) {
  const runs: string[][] = [];
  const api: { path: string; body: unknown }[] = [];
  const responses = new Map<string, { status: number; body: unknown }>();
  let emit: (e: TmuxEvent) => void = () => {};
  const st: MirrorState = {
    sessions,
    workspaces: [],
    projects: [{ id: "prj_sy", name: "switchyard" }] as any,
    hosts: [{ id: "hst_mac", name: "mac", capabilities: { terminal: true } }] as any,
    checkouts: [],
    views: [],
  };
  const client = new ApiClient({
    coordinatorUrl: "http://coord",
    credential: "tok",
    fetch: async (url, init) => {
      const path = String(url).replace("http://coord", "");
      api.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      const r = responses.get(path) ?? { status: 200, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status });
    },
  });
  const daemon = new TmuxDaemon({
    run: async (args) => {
      runs.push(args);
      if (args[0] === "list-windows") return windows.join("\n");
      if (args[0] === "new-window") return "@9\n";
      return "";
    },
    control: (_s, onEvent) => {
      emit = onEvent;
      return { close() {} };
    },
    api: client,
    session: "work",
    state: () => st,
    onStateChange: () => () => {},
    stateDir: dir,
    launcherPath: "/state/switchyard-tmux",
    log: () => {},
    exists: () => true,
    debounceMs: 0,
    intervalMs: 0,
  });
  return { daemon, runs, api, responses, emit: (e: TmuxEvent) => emit(e) };
}

const line = (wid: string, name: string, sid: string, dead = "0") =>
  [wid, name, sid, `%${wid.slice(1)}`, dead, "node"].join("\t");

describe("TmuxDaemon", () => {
  it("opens a window with the session's pane command", async () => {
    const { daemon, runs } = setup([session("ses_1")], []);
    await daemon.reconcile();
    const nw = runs.find((r) => r[0] === "new-window")!;
    expect(nw).toContain("switchyard · Title ses_1");
    expect(nw.at(-1)).toBe("sh '/state/switchyard-tmux' 'pane' 'ses_1'");
    expect(runs).toContainEqual(["set-option", "-w", "-t", "@9", "@switchyard_session", "ses_1"]);
  });

  it("archives on a close it did not cause, but not one it did", async () => {
    const name = "switchyard · Title ses_1";
    const { daemon, runs, api, emit } = setup([session("ses_1")], [line("@1", name, "ses_1")]);
    await daemon.start();
    await daemon.idle();
    emit({ type: "window-close", windowId: "@1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.map((a) => a.path)).toContain("/api/sessions/ses_1/archive");

    const second = setup([session("ses_2")], [line("@2", "x", "ses_gone")]);
    await second.daemon.reconcile(); // closes a window of a session that is not in the set
    expect(second.runs).toContainEqual(["kill-window", "-t", "@2"]);
    second.emit({ type: "window-close", windowId: "@2" });
    await new Promise((r) => setTimeout(r, 20));
    expect(second.api).toEqual([]);
    expect(runs.length).toBeGreaterThan(0);
  });

  it("respawns a dead pane instead of archiving", async () => {
    const name = "switchyard · Title ses_1";
    const { daemon, runs, api } = setup([session("ses_1")], [line("@1", name, "ses_1", "1")]);
    await daemon.reconcile();
    expect(runs.some((r) => r[0] === "respawn-pane" && r.includes("%1"))).toBe(true);
    expect(api).toEqual([]);
  });

  it("renames the session when the window is renamed, stripping the prefix", async () => {
    const name = "switchyard · Title ses_1";
    const { daemon, api, emit } = setup([session("ses_1")], [line("@1", name, "ses_1")]);
    await daemon.start();
    await daemon.idle();
    emit({ type: "window-renamed", windowId: "@1", name: "switchyard · New name" });
    await new Promise((r) => setTimeout(r, 20));
    expect(api).toContainEqual({ path: "/api/sessions/ses_1/rename", body: { title: "New name" } });
  });

  it("shows a message when archiving conflicts", async () => {
    const name = "switchyard · Title ses_1";
    const { daemon, runs, responses, emit } = setup(
      [session("ses_1")],
      [line("@1", name, "ses_1")],
    );
    responses.set("/api/sessions/ses_1/archive", {
      status: 409,
      body: { error: { code: "conflict", message: "running" } },
    });
    await daemon.start();
    await daemon.idle();
    emit({ type: "window-close", windowId: "@1" });
    await new Promise((r) => setTimeout(r, 20));
    const msg = runs.find((r) => r[0] === "display-message");
    expect(msg?.at(-1)).toContain("is still running");
  });
});
