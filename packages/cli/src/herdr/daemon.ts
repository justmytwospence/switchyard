import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ApiClient, ApiRequestError } from "@switchyard/terminal";
import { type HerdrCall, type HerdrSubscription, type herdrSubscribe, nextSeq } from "./client.js";
import {
  claimedSession,
  emptyMemory,
  type HerdrSnapshot,
  type MirrorMemory,
  type MirrorState,
  mirroredSessions,
  PENDING_MS,
  planMirror,
  SOURCE,
  tabLabel,
} from "./mirror.js";
import { isAtShell, launcherCommand, runInPane } from "./util.js";

export const EVENT_TYPES = [
  "workspace.created",
  "workspace.closed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "pane.closed",
];

export interface DaemonDeps {
  call: HerdrCall;
  subscribe: typeof herdrSubscribe;
  api: ApiClient;
  /** Switchyard's state, null until the first sync. */
  state: () => MirrorState | null;
  onStateChange: (fn: () => void) => () => void;
  /** `<state>/<herdr session>`: spaces.json and the fallback space directory. */
  stateDir: string;
  /** Stable launcher for typed commands and resume commands. */
  launcherPath: string;
  log: (line: string) => void;
  now?: () => number;
  exists?: (p: string) => boolean;
  /** Debounce for reconciles after events (default 250 ms; tests use 0). */
  debounceMs?: number;
  /** Safety-net reconcile interval (default 30 s; 0 disables). */
  intervalMs?: number;
}

const TRANSIENT_MS = 10_000;

/**
 * Keeps a paired herdr session a mirror of Switchyard: a space per workspace, a tab per session.
 * Reconciles on Switchyard changes, herdr events and a timer, one at a time.
 */
export class MirrorDaemon {
  private readonly mem: MirrorMemory = emptyMemory();
  private sub: HerdrSubscription | null = null;
  private unsubscribeState: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running: Promise<string[]> | null = null;
  private again = false;
  private stopped = false;
  /** Last snapshot: tab -> claimed sessions, workspace -> claimed sessions. */
  private sessionsOfTab = new Map<string, string[]>();
  private sessionsOfSpace = new Map<string, string[]>();
  private readonly closingByUs = new Map<string, number>();
  /** tab id -> the label we set and when. */
  private readonly renamingByUs = new Map<string, { label: string; at: number }>();
  private readonly overrideAt = new Map<string, number>();
  private readonly lastReport = new Map<string, string>();
  private readonly metadataSent = new Set<string>();

  constructor(private readonly deps: DaemonDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get spacesFile(): string {
    return join(this.deps.stateDir, "spaces.json");
  }

  async start(): Promise<void> {
    this.load();
    this.subscribe();
    this.unsubscribeState = this.deps.onStateChange(() => this.schedule());
    const every = this.deps.intervalMs ?? 30_000;
    if (every > 0) {
      this.interval = setInterval(() => this.schedule(), every);
      this.interval.unref?.();
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    this.sub?.close();
    this.unsubscribeState?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  /** Wait for any running or scheduled reconcile (tests). */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && (this.running || this.timer); i++) {
      await (this.running ?? new Promise<void>((r) => setTimeout(() => r(), 5)));
    }
  }

  private subscribe(): void {
    if (this.stopped) return;
    this.sub = this.deps.subscribe(
      EVENT_TYPES,
      (data) => {
        void this.onEvent(data)
          .catch((err) => this.deps.log(`event handling failed: ${(err as Error).message}`))
          .finally(() => this.schedule());
      },
      (reason) => {
        if (this.stopped) return;
        this.deps.log(`herdr subscription ended (${reason})`);
        setTimeout(() => {
          this.subscribe();
          this.schedule();
        }, 1000).unref?.();
      },
    );
  }

  schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile().catch((err) =>
        this.deps.log(`reconcile failed: ${(err as Error).message}`),
      );
    }, this.deps.debounceMs ?? 250);
  }

  /** One serialized comparison and repair. Returns what it did. */
  reconcile(): Promise<string[]> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      const done: string[] = [];
      try {
        do {
          this.again = false;
          done.push(...(await this.reconcileOnce()));
        } while (this.again && !this.stopped);
      } finally {
        this.running = null;
      }
      return done;
    })();
    return this.running;
  }

  private async snapshot(): Promise<HerdrSnapshot> {
    const r = await this.deps.call("session.snapshot", {});
    const s = r?.snapshot ?? {};
    return { workspaces: s.workspaces ?? [], tabs: s.tabs ?? [], panes: s.panes ?? [] };
  }

  private remember(h: HerdrSnapshot): void {
    this.sessionsOfTab = new Map();
    this.sessionsOfSpace = new Map();
    for (const p of h.panes) {
      const sid = claimedSession(p);
      if (!sid) continue;
      this.sessionsOfTab.set(p.tab_id, [...(this.sessionsOfTab.get(p.tab_id) ?? []), sid]);
      this.sessionsOfSpace.set(p.workspace_id, [
        ...(this.sessionsOfSpace.get(p.workspace_id) ?? []),
        sid,
      ]);
    }
  }

  private expire(map: Map<string, number>): void {
    const now = this.now();
    for (const [k, at] of map) if (now - at > TRANSIENT_MS) map.delete(k);
  }

  private async reconcileOnce(): Promise<string[]> {
    const st = this.deps.state();
    if (!st) return [];
    const { call, log } = this.deps;
    const done: string[] = [];
    const note = (line: string) => {
      done.push(line);
      log(line);
    };
    this.expire(this.closingByUs);
    for (const [k, v] of this.renamingByUs)
      if (this.now() - v.at > TRANSIENT_MS) this.renamingByUs.delete(k);
    for (const [sid, at] of this.overrideAt) {
      const s = st.sessions.find((x) => x.id === sid);
      if (this.now() - at > TRANSIENT_MS || s?.title === this.mem.titleOverrides[sid]) {
        delete this.mem.titleOverrides[sid];
        this.overrideAt.delete(sid);
      }
    }
    const h = await this.snapshot();
    this.remember(h);
    const plan = planMirror(st, h, this.mem, this.now());
    const titleOf = (sid: string) => st.sessions.find((s) => s.id === sid)?.title ?? sid;
    const launcher = this.deps.launcherPath;
    const paneCmd = (sid: string) => launcherCommand(launcher, ["pane", sid]);
    const exists = this.deps.exists ?? existsSync;
    const createdNow: Record<string, { key: string; label: string }> = {};
    const fallbackCwd = () => {
      const dir = join(this.deps.stateDir, "spaces");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return dir;
    };

    for (const c of plan.closeTabs) {
      this.closingByUs.set(c.tabId, this.now());
      await call("tab.close", { tab_id: c.tabId });
      delete this.mem.ownTabs[c.tabId];
      note(`closed the tab of ${c.sessionId} (archived)`);
    }
    for (const m of plan.moves) {
      const destination = m.toWorkspaceId
        ? { type: "new_tab", workspace_id: m.toWorkspaceId, label: m.label }
        : { type: "new_workspace", label: m.label, tab_label: titleOf(m.sessionId) };
      const r = await call("pane.move", { pane_id: m.paneId, destination, focus: false });
      if (!m.toWorkspaceId) {
        const ws =
          r?.created_workspace?.workspace_id ??
          r?.move_result?.pane?.workspace_id ??
          r?.pane?.workspace_id;
        const s = st.sessions.find((x) => x.id === m.sessionId);
        if (ws && s) {
          createdNow[ws] = { key: s.workspaceId ?? `cwd:${s.hostId}:${s.cwd}`, label: m.label };
          this.mem.spaces[ws] = createdNow[ws];
        }
      }
      note(`moved ${m.sessionId} to ${m.toWorkspaceId ?? `a new space (${m.label})`}`);
    }
    for (const c of plan.createSpaces) {
      const cwd = c.cwd && exists(c.cwd) ? c.cwd : fallbackCwd();
      const r = await call("workspace.create", { cwd, label: c.label, focus: false });
      const wsId: string | undefined = r?.workspace?.workspace_id;
      const tabId: string | undefined = r?.tab?.tab_id;
      const paneId: string | undefined = r?.root_pane?.pane_id;
      if (!wsId || !tabId || !paneId) {
        note(`workspace.create gave no ids for ${c.label}`);
        continue;
      }
      createdNow[wsId] = { key: c.key, label: c.label };
      this.mem.spaces[wsId] = createdNow[wsId];
      this.mem.ownTabs[tabId] = c.firstSessionId;
      this.mem.offered.add(tabId);
      this.mem.pending[c.firstSessionId] = { tabId, at: this.now() };
      this.renamingByUs.set(tabId, { label: c.firstTabLabel, at: this.now() });
      await call("tab.rename", { tab_id: tabId, label: c.firstTabLabel });
      await runInPane(call, paneId, paneCmd(c.firstSessionId));
      if (c.insertIndex !== null) {
        await call("workspace.move", { workspace_id: wsId, insert_index: c.insertIndex });
      }
      note(`opened space ${c.label} with ${c.firstSessionId}`);
    }
    for (const c of plan.createTabs) {
      const cwd = c.cwd && exists(c.cwd) ? c.cwd : fallbackCwd();
      const r = await call("tab.create", {
        workspace_id: c.workspaceId,
        label: c.label,
        cwd,
        focus: false,
      });
      const tabId: string | undefined = r?.tab?.tab_id;
      const paneId: string | undefined = r?.root_pane?.pane_id;
      if (!tabId || !paneId) {
        note(`tab.create gave no ids for ${c.sessionId}`);
        continue;
      }
      this.mem.ownTabs[tabId] = c.sessionId;
      this.mem.offered.add(tabId);
      this.mem.pending[c.sessionId] = { tabId, at: this.now() };
      await runInPane(call, paneId, paneCmd(c.sessionId));
      note(`opened a tab for ${c.sessionId}`);
    }
    for (const r of plan.restarts) {
      if (!(await isAtShell(call, r.paneId))) continue;
      const tabId = h.panes.find((p) => p.pane_id === r.paneId)?.tab_id ?? "";
      this.mem.pending[r.sessionId] = { tabId, at: this.now() };
      await runInPane(call, r.paneId, paneCmd(r.sessionId));
      note(`reattached ${r.sessionId} in ${r.paneId}`);
    }
    for (const r of plan.renameTabs) {
      this.renamingByUs.set(r.tabId, { label: r.label, at: this.now() });
      await call("tab.rename", { tab_id: r.tabId, label: r.label });
      note(`renamed tab ${r.tabId} to ${r.label}`);
    }
    for (const r of plan.renameSpaces) {
      await call("workspace.rename", { workspace_id: r.workspaceId, label: r.label });
      note(`renamed space ${r.workspaceId} to ${r.label}`);
    }
    for (const ws of plan.closeSpaces) {
      await call("workspace.close", { workspace_id: ws, close_group: false });
      note(`closed space ${ws}`);
    }
    for (const r of plan.reports) {
      const sig = `${r.sessionId}|${r.state}|${r.message}`;
      if (this.lastReport.get(r.paneId) !== sig) {
        await call("pane.report_agent", {
          pane_id: r.paneId,
          source: SOURCE,
          agent: SOURCE,
          state: r.state,
          message: r.message,
          agent_session_id: r.sessionId,
          resume_argv: ["sh", launcher, "pane", r.sessionId],
          seq: nextSeq(),
        }).catch((err: Error) => log(`report for ${r.paneId} failed: ${err.message}`));
        this.lastReport.set(r.paneId, sig);
      }
      if (!this.metadataSent.has(r.paneId)) {
        await call("pane.report_metadata", {
          pane_id: r.paneId,
          source: SOURCE,
          display_agent: r.displayAgent,
          seq: nextSeq(),
        }).catch(() => {});
        this.metadataSent.add(r.paneId);
      }
    }
    for (const o of plan.offers) {
      if (!(await isAtShell(call, o.paneId))) continue;
      this.mem.offered.add(o.tabId);
      const args = o.workspaceKey ? ["new", "--workspace", o.workspaceKey] : ["new"];
      await runInPane(call, o.paneId, launcherCommand(launcher, args));
      note(`offered a new session in ${o.tabId}`);
    }

    // Bookkeeping.
    const claimed = new Set(h.panes.map(claimedSession).filter(Boolean) as string[]);
    for (const [sid, p] of Object.entries(this.mem.pending)) {
      if (claimed.has(sid) || this.now() - p.at >= PENDING_MS * 4) delete this.mem.pending[sid];
    }
    const tabs = new Set(h.tabs.map((t) => t.tab_id));
    for (const t of Object.keys(this.mem.ownTabs)) {
      // Tabs created in this pass are not in the snapshot yet.
      if (!tabs.has(t) && !Object.values(this.mem.pending).some((p) => p.tabId === t)) {
        delete this.mem.ownTabs[t];
      }
    }
    this.mem.spaces = { ...plan.spaces, ...createdNow };
    this.save();
    return done;
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.spacesFile, "utf8"));
      this.mem.spaces = raw.spaces ?? {};
      this.mem.ownTabs = raw.ownTabs ?? {};
    } catch {
      // first start
    }
  }

  private save(): void {
    mkdirSync(this.deps.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      this.spacesFile,
      `${JSON.stringify({ spaces: this.mem.spaces, ownTabs: this.mem.ownTabs }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private async onEvent(data: { type: string; [k: string]: unknown }): Promise<void> {
    const st = this.deps.state();
    if (!st) return;
    const mirrored = new Map(mirroredSessions(st).map((s) => [s.id, s]));
    switch (data.type) {
      case "tab_closed": {
        const tabId = String(data.tab_id);
        if (this.closingByUs.has(tabId)) return;
        for (const sid of this.sessionsOfTab.get(tabId) ?? []) {
          const s = mirrored.get(sid);
          if (s) await this.archive(s.id, s.title);
        }
        return;
      }
      case "workspace_closed": {
        const ws = String(data.workspace_id);
        for (const sid of new Set(this.sessionsOfSpace.get(ws) ?? [])) {
          const s = mirrored.get(sid);
          if (s) await this.archive(s.id, s.title);
        }
        delete this.mem.spaces[ws];
        return;
      }
      case "tab_renamed": {
        const tabId = String(data.tab_id);
        const label = String(data.label ?? "");
        if (this.renamingByUs.get(tabId)?.label === label) return;
        const owners = this.sessionsOfTab.get(tabId) ?? [];
        if (new Set(owners).size !== 1) return;
        const s = mirrored.get(owners[0]!);
        if (!s || !label || label === tabLabel(s, this.mem.titleOverrides)) return;
        this.mem.titleOverrides[s.id] = label;
        this.overrideAt.set(s.id, this.now());
        try {
          await this.deps.api.post(`/api/sessions/${encodeURIComponent(s.id)}/rename`, {
            title: label,
          });
          this.deps.log(`renamed ${s.id} to ${label}`);
        } catch (err) {
          delete this.mem.titleOverrides[s.id];
          this.overrideAt.delete(s.id);
          this.deps.log(`rename of ${s.id} failed: ${(err as Error).message}`);
        }
        return;
      }
      default:
        return;
    }
  }

  private async archive(sessionId: string, title: string): Promise<void> {
    try {
      await this.deps.api.post(`/api/sessions/${encodeURIComponent(sessionId)}/archive`);
      this.deps.log(`archived ${sessionId} (its tab was closed)`);
    } catch (err) {
      const code = err instanceof ApiRequestError ? err.code : null;
      if (code === "conflict" || code === "host_unreachable") {
        const body =
          code === "conflict"
            ? `${title} is still running: stop it before closing its tab`
            : `${title}'s host is offline: it was not archived`;
        await this.deps
          .call("notification.show", { title: "Switchyard", body, sound: "none" })
          .catch(() => {});
        this.deps.log(`kept ${sessionId}: ${body}`);
        return;
      }
      this.deps.log(`archive of ${sessionId} failed: ${(err as Error).message}`);
    }
  }
}
