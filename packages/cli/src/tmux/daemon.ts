import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { View } from "@switchyard/protocol";
import type { ApiClient } from "@switchyard/terminal";
import { launcherCommand } from "../herdr/util.js";
import { archiveSession, renameSession } from "../mirror/actions.js";
import { type MirrorState, PENDING_MS, viewedSessions } from "../mirror/state.js";
import type { TmuxControl, TmuxEvent, TmuxRun } from "./client.js";
import {
  emptyTmuxMemory,
  planTmux,
  type TmuxMemory,
  type TmuxWindow,
  titleFromWindowName,
  WINDOW_OPTION,
  windowName,
} from "./mirror.js";

export interface TmuxDaemonDeps {
  run: TmuxRun;
  control: (
    session: string,
    onEvent: (e: TmuxEvent) => void,
    onEnd: (reason: string) => void,
  ) => TmuxControl;
  api: ApiClient;
  session: string;
  state: () => MirrorState | null;
  onStateChange: (fn: () => void) => () => void;
  view?: () => View | null | "missing";
  stateDir: string;
  launcherPath: string;
  log: (line: string) => void;
  now?: () => number;
  exists?: (p: string) => boolean;
  debounceMs?: number;
  intervalMs?: number;
}

const TRANSIENT_MS = 10_000;

/** Keeps a paired tmux session a mirror of Switchyard: a window per session. */
export class TmuxDaemon {
  private readonly mem: TmuxMemory = emptyTmuxMemory();
  private ctl: TmuxControl | null = null;
  private unsubscribeState: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private interval: NodeJS.Timeout | null = null;
  private running: Promise<string[]> | null = null;
  private again = false;
  private stopped = false;
  private sessionOfWindow = new Map<string, string>();
  private readonly closingByUs = new Map<string, number>();
  private readonly renamingByUs = new Map<string, { name: string; at: number }>();
  private readonly overrideAt = new Map<string, number>();
  private viewMissingLogged = false;

  constructor(private readonly deps: TmuxDaemonDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get file(): string {
    return join(this.deps.stateDir, "windows.json");
  }

  private get target(): string {
    return `=${this.deps.session}`;
  }

  async start(): Promise<void> {
    this.load();
    this.connect();
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
    this.ctl?.close();
    this.unsubscribeState?.();
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
  }

  async idle(): Promise<void> {
    for (let i = 0; i < 50 && (this.running || this.timer); i++) {
      await (this.running ?? new Promise<void>((r) => setTimeout(() => r(), 5)));
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.ctl = this.deps.control(
      this.deps.session,
      (e) => {
        void this.onEvent(e)
          .catch((err) => this.deps.log(`event handling failed: ${(err as Error).message}`))
          .finally(() => this.schedule());
      },
      (reason) => {
        if (this.stopped) return;
        this.deps.log(`tmux control client ended (${reason})`);
        setTimeout(() => {
          this.connect();
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

  private async snapshot(): Promise<TmuxWindow[]> {
    const fmt = [
      "#{window_id}",
      "#{window_name}",
      `#{${WINDOW_OPTION}}`,
      "#{pane_id}",
      "#{pane_dead}",
      "#{pane_current_command}",
    ].join("\t");
    const out = await this.deps.run(["list-windows", "-t", this.target, "-F", fmt]);
    const seen = new Set<string>();
    const windows: TmuxWindow[] = [];
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [windowId, name, sid, paneId, dead, cmd] = line.split("\t");
      if (!windowId || seen.has(windowId)) continue; // first pane only
      seen.add(windowId);
      windows.push({
        windowId,
        name: name ?? "",
        sessionId: sid ? sid : null,
        paneId: paneId ?? "",
        paneDead: dead === "1",
        paneCommand: cmd ?? "",
      });
    }
    return windows;
  }

  private async reconcileOnce(): Promise<string[]> {
    const st = this.deps.state();
    if (!st) return [];
    const { run, log } = this.deps;
    const bound = this.deps.view?.() ?? null;
    if (bound === "missing") {
      if (!this.viewMissingLogged) log("bound view not found; not mirroring");
      this.viewMissingLogged = true;
      return [];
    }
    this.viewMissingLogged = false;
    const done: string[] = [];
    const note = (line: string) => {
      done.push(line);
      log(line);
    };
    const now = this.now();
    for (const [k, at] of this.closingByUs) if (now - at > TRANSIENT_MS) this.closingByUs.delete(k);
    for (const [k, v] of this.renamingByUs)
      if (now - v.at > TRANSIENT_MS) this.renamingByUs.delete(k);
    for (const [sid, at] of this.overrideAt) {
      const s = st.sessions.find((x) => x.id === sid);
      if (now - at > TRANSIENT_MS || s?.title === this.mem.titleOverrides[sid]) {
        delete this.mem.titleOverrides[sid];
        this.overrideAt.delete(sid);
      }
    }
    const windows = await this.snapshot();
    this.sessionOfWindow = new Map(
      windows.filter((w) => w.sessionId).map((w) => [w.windowId, w.sessionId as string]),
    );
    const plan = planTmux(st, bound, windows, this.mem, now);
    const launcher = this.deps.launcherPath;
    const exists = this.deps.exists ?? existsSync;
    const q = (args: string[]) => launcherCommand(launcher, args);

    for (const c of plan.closeWindows) {
      this.closingByUs.set(c.windowId, now);
      await run(["kill-window", "-t", c.windowId]).catch(() => {});
      delete this.mem.ownWindows[c.windowId];
      note(`closed the window of ${c.sessionId}`);
    }
    for (const c of plan.createWindows) {
      let cwd = c.cwd && exists(c.cwd) ? c.cwd : null;
      if (!cwd) {
        cwd = join(this.deps.stateDir, "spaces");
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
      }
      const wid = (
        await run([
          "new-window",
          "-d",
          "-t",
          `${this.target}:`,
          "-n",
          c.name,
          "-c",
          cwd,
          "-P",
          "-F",
          "#{window_id}",
          q(["pane", c.sessionId]),
        ])
      ).trim();
      if (!wid) {
        note(`new-window gave no id for ${c.sessionId}`);
        continue;
      }
      await run(["set-option", "-w", "-t", wid, "remain-on-exit", "on"]);
      await run(["set-option", "-w", "-t", wid, "automatic-rename", "off"]);
      await run(["set-option", "-w", "-t", wid, WINDOW_OPTION, c.sessionId]);
      this.mem.ownWindows[wid] = c.sessionId;
      this.mem.pending[c.sessionId] = { windowId: wid, at: now };
      this.renamingByUs.set(wid, { name: c.name, at: now });
      note(`opened a window for ${c.sessionId}`);
    }
    for (const r of plan.respawns) {
      this.mem.pending[r.sessionId] = { windowId: "", at: now };
      await run(["respawn-pane", "-k", "-t", r.paneId, q(["pane", r.sessionId])]);
      note(`reattached ${r.sessionId} in ${r.paneId}`);
    }
    for (const r of plan.renames) {
      this.renamingByUs.set(r.windowId, { name: r.name, at: now });
      await run(["rename-window", "-t", r.windowId, r.name]);
      note(`renamed window ${r.windowId} to ${r.name}`);
    }
    for (const o of plan.offers) {
      this.mem.offered.add(o.windowId);
      await run(["respawn-pane", "-k", "-t", o.paneId, q(["new"])]);
      note(`offered a new session in ${o.windowId}`);
    }
    const claimed = new Set(windows.map((w) => w.sessionId).filter(Boolean) as string[]);
    for (const [sid, p] of Object.entries(this.mem.pending)) {
      if (claimed.has(sid) || now - p.at >= PENDING_MS * 4) delete this.mem.pending[sid];
    }
    const present = new Set(windows.map((w) => w.windowId));
    for (const w of Object.keys(this.mem.ownWindows)) {
      if (!present.has(w) && !Object.values(this.mem.pending).some((p) => p.windowId === w)) {
        delete this.mem.ownWindows[w];
      }
    }
    this.save();
    return done;
  }

  private load(): void {
    try {
      this.mem.ownWindows = JSON.parse(readFileSync(this.file, "utf8")).ownWindows ?? {};
    } catch {
      // first start
    }
  }

  private save(): void {
    mkdirSync(this.deps.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file, `${JSON.stringify({ ownWindows: this.mem.ownWindows }, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  private async onEvent(e: TmuxEvent): Promise<void> {
    if (e.type === "window-add") {
      this.mem.added.add(e.windowId);
      return;
    }
    const st = this.deps.state();
    if (!st) return;
    const bound = this.deps.view?.() ?? null;
    if (bound === "missing") return;
    const mirrored = new Map(viewedSessions(st, bound).map((s) => [s.id, s]));
    if (e.type === "window-close") {
      if (this.closingByUs.has(e.windowId)) return;
      const sid = this.sessionOfWindow.get(e.windowId);
      if (!sid) return;
      const s = mirrored.get(sid);
      const elsewhere = [...this.sessionOfWindow].some(
        ([w, other]) => w !== e.windowId && other === sid,
      );
      if (!s || elsewhere) return;
      try {
        const r = await archiveSession(this.deps.api, s.id, s.title);
        if (r.ok) this.deps.log(`archived ${s.id} (its window was closed)`);
        else if (r.notice) {
          await this.deps
            .run(["display-message", "-t", this.target, `Switchyard: ${r.notice}`])
            .catch(() => {});
          this.deps.log(`kept ${s.id}: ${r.notice}`);
        }
      } catch (err) {
        this.deps.log(`archive of ${s.id} failed: ${(err as Error).message}`);
      }
      return;
    }
    // window-renamed
    if (this.renamingByUs.get(e.windowId)?.name === e.name) return;
    const sid = this.sessionOfWindow.get(e.windowId);
    const s = sid ? mirrored.get(sid) : undefined;
    if (!s) return;
    const title = titleFromWindowName(e.name, s, st);
    if (!title || title === s.title || e.name === windowName(s, st, this.mem.titleOverrides))
      return;
    this.mem.titleOverrides[s.id] = title;
    this.overrideAt.set(s.id, this.now());
    try {
      await renameSession(this.deps.api, s.id, title);
      this.deps.log(`renamed ${s.id} to ${title}`);
    } catch (err) {
      delete this.mem.titleOverrides[s.id];
      this.overrideAt.delete(s.id);
      this.deps.log(`rename of ${s.id} failed: ${(err as Error).message}`);
    }
  }
}
