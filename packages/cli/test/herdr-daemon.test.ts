import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@switchyard/protocol";
import { ApiClient } from "@switchyard/terminal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonEnv } from "../src/commands/herdr.js";
import { writeClientConfig } from "../src/config.js";
import { MirrorDaemon } from "../src/herdr/daemon.js";
import type { MirrorState } from "../src/herdr/mirror.js";
import { stubFetch, testCtx } from "./helpers.js";
import { session } from "./herdr-fixtures.js";

/** An in-memory herdr: workspaces, tabs and panes, recording every request. */
class FakeHerdr {
  workspaces: { workspace_id: string; label: string; number: number }[] = [];
  tabs: { tab_id: string; workspace_id: string; label: string }[] = [];
  panes: {
    pane_id: string;
    tab_id: string;
    workspace_id: string;
    agent_session?: any;
    tokens?: Record<string, string>;
    agent?: string;
  }[] = [];
  requests: { method: string; params: any }[] = [];
  busy = new Set<string>();
  private n = 0;
  onEvent: ((d: any) => void) | null = null;

  call = async (method: string, params: any): Promise<any> => {
    this.requests.push({ method, params });
    switch (method) {
      case "session.snapshot":
        return {
          snapshot: structuredClone({
            workspaces: this.workspaces,
            tabs: this.tabs,
            panes: this.panes,
          }),
        };
      case "workspace.create": {
        const ws = `w${++this.n}`;
        this.workspaces.push({
          workspace_id: ws,
          label: params.label,
          number: this.workspaces.length + 1,
        });
        const { tab, pane } = this.addTab(ws, "1");
        return {
          workspace: { workspace_id: ws },
          tab: { tab_id: tab },
          root_pane: { pane_id: pane },
        };
      }
      case "tab.create": {
        const { tab, pane } = this.addTab(params.workspace_id, params.label);
        return { tab: { tab_id: tab }, root_pane: { pane_id: pane } };
      }
      case "tab.rename": {
        const t = this.tabs.find((x) => x.tab_id === params.tab_id);
        if (t) t.label = params.label;
        return {};
      }
      case "tab.close":
        this.tabs = this.tabs.filter((t) => t.tab_id !== params.tab_id);
        this.panes = this.panes.filter((p) => p.tab_id !== params.tab_id);
        return {};
      case "pane.report_agent": {
        const p = this.panes.find((x) => x.pane_id === params.pane_id);
        if (p)
          p.agent_session = {
            source: params.source,
            agent: params.agent,
            kind: "id",
            value: params.agent_session_id,
          };
        return {};
      }
      case "pane.report_metadata": {
        const p = this.panes.find((x) => x.pane_id === params.pane_id);
        if (p && params.tokens) p.tokens = { ...(p.tokens ?? {}), ...params.tokens };
        return {};
      }
      case "pane.process_info":
        return {
          process_info: {
            shell_pid: 1,
            foreground_processes: this.busy.has(params.pane_id) ? [{ pid: 2 }] : [],
          },
        };
      default:
        return {};
    }
  };

  private addTab(ws: string, label: string) {
    const tab = `${ws}:t${++this.n}`;
    const pane = `${ws}:p${this.n}`;
    this.tabs.push({ tab_id: tab, workspace_id: ws, label });
    this.panes.push({ pane_id: pane, tab_id: tab, workspace_id: ws });
    return { tab, pane };
  }

  /** Simulate the typed pane command starting: it claims its pane. */
  claimTyped(): void {
    for (const r of this.requests) {
      if (r.method !== "pane.send_text") continue;
      const m = /'pane' '([^']+)'/.exec(r.params.text);
      const p = this.panes.find((x) => x.pane_id === r.params.pane_id);
      if (m && p && !p.tokens?.switchyard_session) {
        p.tokens = { switchyard_session: m[1]! };
        p.agent = "switchyard";
        this.busy.add(p.pane_id);
      }
    }
  }

  of(method: string) {
    return this.requests.filter((r) => r.method === method).map((r) => r.params);
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sy-mirror-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(sessions: Session[]) {
  const herdr = new FakeHerdr();
  const st: MirrorState = {
    sessions,
    workspaces: [
      {
        id: "wsp_main",
        checkoutId: "chk",
        projectId: "prj_sy",
        hostId: "hst_mac",
        path: "/repo",
        branch: "main",
        baseBranch: null,
        provenance: "main",
        git: {} as any,
        setup: { state: "none", log: "" },
        archivedAt: null,
        updatedAt: "2026-11-02T00:00:00Z",
      },
    ],
    projects: [{ id: "prj_sy", name: "switchyard" }] as any,
    hosts: [{ id: "hst_mac", name: "mac", capabilities: { terminal: true } }] as any,
    checkouts: [],
  };
  const api: { path: string; body: unknown }[] = [];
  const responses = new Map<string, { status: number; body: unknown }>();
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
  const daemon = new MirrorDaemon({
    call: herdr.call,
    subscribe: (_types, onEvent) => {
      herdr.onEvent = onEvent;
      return { close() {} };
    },
    api: client,
    state: () => st,
    onStateChange: () => () => {},
    stateDir: dir,
    launcherPath: "/state/switchyard-herdr",
    log: () => {},
    exists: () => true,
    debounceMs: 0,
    intervalMs: 0,
  });
  return { herdr, st, api, responses, daemon };
}

describe("MirrorDaemon", () => {
  it("opens a space and tabs, types pane commands, and reports claimed panes", async () => {
    const { herdr, daemon } = setup([session("ses_1"), session("ses_2")]);
    await daemon.reconcile();
    expect(herdr.of("workspace.create")).toEqual([
      { cwd: "/repo", label: "switchyard", focus: false },
    ]);
    expect(herdr.of("tab.rename")[0]).toMatchObject({ label: "Title ses_1" });
    expect(herdr.of("pane.send_text").map((p) => p.text)).toEqual([
      "sh '/state/switchyard-herdr' 'pane' 'ses_1'",
    ]);
    // ses_2 waits for the space's first pass; the next pass adds its tab.
    await daemon.reconcile();
    expect(herdr.of("tab.create")).toEqual([
      { workspace_id: "w1", label: "Title ses_2", cwd: "/repo", focus: false },
    ]);
    herdr.claimTyped();
    await daemon.reconcile();
    const reports = herdr.of("pane.report_agent");
    expect(reports.map((r) => [r.agent_session_id, r.state, r.resume_argv])).toEqual(
      expect.arrayContaining([
        ["ses_1", "idle", ["sh", "/state/switchyard-herdr", "pane", "ses_1"]],
        ["ses_2", "idle", ["sh", "/state/switchyard-herdr", "pane", "ses_2"]],
      ]),
    );
    // Nothing new to do: no duplicate tabs or reports.
    const before = herdr.requests.length;
    await daemon.reconcile();
    expect(herdr.requests.slice(before).map((r) => r.method)).toEqual(["session.snapshot"]);
  });

  it("archives a session whose tab was closed, and keeps a running one", async () => {
    const { herdr, st, api, responses, daemon } = setup([
      session("ses_1"),
      session("ses_2", { runtime: "running" }),
    ]);
    await daemon.start();
    await daemon.reconcile();
    await daemon.reconcile();
    herdr.claimTyped();
    await daemon.reconcile();
    const tabOf = (sid: string) =>
      herdr.panes.find((p) => p.tokens?.switchyard_session === sid)!.tab_id;

    responses.set("/api/sessions/ses_2/archive", {
      status: 409,
      body: { error: { code: "conflict", message: "Stop the session before archiving it" } },
    });
    const t1 = tabOf("ses_1");
    const t2 = tabOf("ses_2");
    await herdr.call("tab.close", { tab_id: t1 });
    herdr.onEvent!({ type: "tab_closed", tab_id: t1, workspace_id: "w1" });
    await herdr.call("tab.close", { tab_id: t2 });
    herdr.onEvent!({ type: "tab_closed", tab_id: t2, workspace_id: "w1" });
    await new Promise((r) => setTimeout(r, 20));
    await daemon.idle();
    expect(api.map((a) => a.path)).toEqual([
      "/api/sessions/ses_1/archive",
      "/api/sessions/ses_2/archive",
    ]);
    expect(herdr.of("notification.show")[0].body).toBe(
      "Title ses_2 is still running: stop it before closing its tab",
    );
    // The archived one is gone from Switchyard; the running one gets its tab back.
    st.sessions = st.sessions.map((s) =>
      s.id === "ses_1" ? { ...s, archivedAt: "2026-11-02T02:00:00Z" } : s,
    );
    await daemon.reconcile();
    expect(herdr.of("tab.create").at(-1)).toMatchObject({ label: "Title ses_2" });
    daemon.stop();
  });

  it("renames the session when its tab is renamed, once", async () => {
    const { herdr, api, daemon } = setup([session("ses_1")]);
    await daemon.start();
    await daemon.reconcile();
    herdr.claimTyped();
    await daemon.reconcile();
    const tab = herdr.tabs[0]!;
    tab.label = "Better name";
    herdr.onEvent!({
      type: "tab_renamed",
      tab_id: tab.tab_id,
      workspace_id: "w1",
      label: "Better name",
    });
    await new Promise((r) => setTimeout(r, 20));
    await daemon.idle();
    expect(api).toEqual([{ path: "/api/sessions/ses_1/rename", body: { title: "Better name" } }]);
    // Until the store shows the new title, the tab is not renamed back.
    expect(herdr.of("tab.rename").filter((r) => r.label === "Title ses_1")).toHaveLength(1);
    daemon.stop();
  });

  it("offers the picker once in a tab someone opened", async () => {
    const { herdr, daemon } = setup([session("ses_1")]);
    await daemon.reconcile();
    herdr.claimTyped();
    await daemon.reconcile();
    await herdr.call("tab.create", { workspace_id: "w1", label: "2" });
    await daemon.reconcile();
    await daemon.reconcile();
    const offers = herdr.of("pane.send_text").filter((p) => p.text.includes("'new'"));
    expect(offers.map((o) => o.text)).toEqual([
      "sh '/state/switchyard-herdr' 'new' '--workspace' 'wsp_main'",
    ]);
  });
});

describe("daemonEnv", () => {
  it("adds the resolved connection and launcher to the caller's environment", () => {
    const ctx = testCtx(stubFetch({}).fetch, { PATH: "/bin" });
    expect(daemonEnv(ctx, { coordinator: "https://sy", credential: "cred" }, "/s/l")).toMatchObject(
      {
        PATH: "/bin",
        SWITCHYARD_URL: "https://sy",
        SWITCHYARD_TOKEN: "cred",
        SWITCHYARD_HERDR_LAUNCHER: "/s/l",
      },
    );
  });

  it("falls back to client.json and never reads process.env", () => {
    const ctx = testCtx(stubFetch({}).fetch, {});
    writeClientConfig(ctx.paths!.clientConfig!, {
      coordinatorUrl: "https://c",
      credential: "devcred",
    });
    const env = daemonEnv(ctx, {}, "/s/l");
    expect(env).toMatchObject({ SWITCHYARD_URL: "https://c", SWITCHYARD_TOKEN: "devcred" });
    expect(env).not.toHaveProperty("HOME");
  });

  it("throws when not signed in", () => {
    const ctx = testCtx(stubFetch({}).fetch, {});
    expect(() => daemonEnv(ctx, {}, "/s/l")).toThrow(/Not signed in/);
  });
});
